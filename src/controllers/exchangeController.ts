import { Response } from 'express';
import ExchangeKey from '../models/ExchangeKey';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { encryptSecretKey } from '../utils/encryption';

const CTRADER_IDS = ['ctrader', 'pepperstone'];
const FIX_IDS = ['fix', 'pepperstone-fix', 'ctrader-fix'];
const DUKASCOPY_IDS = ['dukascopy'];
const HYPERLIQUID_IDS = ['hyperliquid'];
const SECRET_FIELDS = ['apiSecret', 'clientSecret', 'accessToken', 'refreshToken', 'password', 'clobSecret', 'clobPassphrase'];
const HIDDEN_FIELDS = '-' + SECRET_FIELDS.join(' -');

function isCtrader(exchangeId: string): boolean {
  return CTRADER_IDS.includes(exchangeId);
}

function isFix(exchangeId: string): boolean {
  return FIX_IDS.includes(exchangeId);
}

function isDukascopy(exchangeId: string): boolean {
  return DUKASCOPY_IDS.includes(exchangeId);
}

function isHyperliquid(exchangeId: string): boolean {
  return HYPERLIQUID_IDS.includes(exchangeId);
}

async function validateHyperliquidKey(apiKey: string, apiSecret: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const { Wallet } = await import('ethers');
    let agentAddress: string;
    try {
      const wallet = new Wallet(apiSecret.startsWith('0x') ? apiSecret : `0x${apiSecret}`);
      agentAddress = wallet.address;
    } catch {
      return { ok: false, reason: 'Private key do AGENT inválida' };
    }

    const master = apiKey.toLowerCase();
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: master }),
    });
    const data = await res.json() as any;
    if (!res.ok || !data || typeof data !== 'object' || data.error) {
      return { ok: false, reason: 'Endereço MASTER inválido ou conta não encontrada na Hyperliquid' };
    }

    try {
      const agentsRes = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'extraAgents', user: master }),
      });
      const agents = await agentsRes.json().catch(() => null) as any;
      if (Array.isArray(agents)) {
        const agentList = agents.map((a: any) => String(a?.agentAddress || a?.agent || a?.address || '').toLowerCase());
        const authorized = agentList.includes(agentAddress.toLowerCase());
        if (agentList.length > 0 && !authorized) {
          return { ok: false, reason: 'AGENT não autorizado: gere o API Wallet em app.hyperliquid.xyz (More → API → Authorize) usando a carteira MASTER' };
        }
      }
    } catch { /* não bloqueia */ }

    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: `Falha ao validar chave Hyperliquid: ${e?.message || 'erro'}` };
  }
}

function encryptFields(body: any, userId: string, exchangeId: string): Record<string, string> {
  const authContext = `${userId}-${exchangeId}`;
  const out: Record<string, string> = {};
  for (const f of SECRET_FIELDS) {
    const v = body[f];
    if (v && typeof v === 'string' && v.trim() !== '') {
      out[f] = encryptSecretKey(v.trim(), authContext);
    }
  }
  return out;
}

export async function getExchanges(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const exchanges = await ExchangeKey.find({ userId }).select(HIDDEN_FIELDS).sort({ createdAt: -1 });

    if (isDashboardPath) {
      return res.json({ success: true, exchanges });
    } else {
      const formatted = exchanges.map((ex: any) => ({
        id: ex._id.toString(),
        exchangeId: ex.exchangeId,
        nome: ex.name,
        apiKey: ex.apiKey,
        ativa: ex.active
      }));
      return res.json({ success: true, message: 'ok', data: formatted });
    }
  } catch (e: any) {
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { success: false, reason: e.message } : { success: false, message: e.message });
  }
}

export async function createExchange(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const body = req.body;
    const { exchangeId, apiKey, apiSecret } = body;
    const nameVal = body.name || body.nome;
    const isCtraderKey = isCtrader(exchangeId);
    const isFixKey = isFix(exchangeId);
    const isDukascopyKey = isDukascopy(exchangeId);
    const isCredentialKey = isFixKey || isDukascopyKey;

    const missingCtrader = isCtraderKey && (!body.clientId || !body.clientSecret);
    const missingCred = isCredentialKey && (!body.username || !body.password);
    if (!exchangeId || !nameVal || (!isCtraderKey && !isCredentialKey && (!apiKey || !apiSecret)) || (isCtraderKey && missingCtrader) || (isCredentialKey && missingCred)) {
      const errorMsg = 'Campos obrigatórios ausentes.';
      return res.status(400).json(isDashboardPath ? { success: false, reason: 'Missing required fields' } : { success: false, message: errorMsg });
    }

    if (isHyperliquid(exchangeId) && apiSecret) {
      const validation = await validateHyperliquidKey(apiKey, apiSecret);
      if (!validation.ok) {
        return res.status(400).json(isDashboardPath ? { success: false, reason: validation.reason } : { success: false, message: validation.reason });
      }
    }

    const encrypted = encryptFields(body, userId, exchangeId);

    const exchangeKey = new ExchangeKey({
      userId,
      exchangeId,
      name: nameVal.trim(),
      apiKey: isCtraderKey ? (body.clientId || '').trim() : isCredentialKey ? (body.username || '').trim() : apiKey.trim(),
      apiSecret: encrypted.apiSecret || (isCtraderKey ? 'ctrader' : isCredentialKey ? (encrypted.password || 'fix') : encryptSecretKey(apiSecret.trim(), `${userId}-${exchangeId}`)),
      active: true,
      ...(isCtraderKey ? {
        clientId: (body.clientId || '').trim(),
        clientSecret: encrypted.clientSecret || '',
        accessToken: encrypted.accessToken || '',
        refreshToken: encrypted.refreshToken || '',
        accountId: body.accountId ? String(body.accountId).trim() : '',
        environment: body.environment === 'demo' ? 'demo' : 'live',
      } : {}),
      ...(isCredentialKey ? {
        host: isFixKey ? (body.host || '').trim() : undefined,
        quotePort: isFixKey ? (body.quotePort ? Number(body.quotePort) : 5211) : undefined,
        tradePort: isFixKey ? (body.tradePort ? Number(body.tradePort) : 5212) : undefined,
        senderCompId: isFixKey ? (body.senderCompId || '').trim() : undefined,
        targetCompId: isFixKey ? (body.targetCompId || 'CSERVER').trim() : undefined,
        username: String(body.username || '').trim(),
        password: encrypted.password || '',
        heartBtInt: isFixKey ? (body.heartBtInt ? Number(body.heartBtInt) : 30) : undefined,
        jnlpUrl: isDukascopyKey ? (body.jnlpUrl || 'http://platform.dukascopy.com/demo_3/jforex_3.jnlp').trim() : undefined,
      } : {}),
    });

    await exchangeKey.save();

    const responseData = exchangeKey.toObject();
    for (const f of SECRET_FIELDS) delete responseData[f];

    if (isDashboardPath) {
      return res.status(201).json({ success: true, exchange: responseData });
    } else {
      return res.status(201).json({
        success: true,
        message: 'Exchange registrada com sucesso.',
        data: {
          id: responseData._id.toString(),
          exchangeId: responseData.exchangeId,
          nome: responseData.name,
          apiKey: responseData.apiKey,
          ativa: responseData.active
        }
      });
    }
  } catch (e: any) {
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { success: false, reason: e.message } : { success: false, message: e.message });
  }
}

export async function deleteExchange(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    // Aceita query params ou body params
    const id = req.query.id as string || req.body.id as string;
    if (!id) {
      return res.status(400).json(isDashboardPath ? { success: false, reason: 'ID is required' } : { success: false, message: 'ID é obrigatório.' });
    }

    const deleted = await ExchangeKey.findOneAndDelete({ _id: id, userId });
    if (!deleted) {
      return res.status(404).json(isDashboardPath ? { success: false, reason: 'Exchange not found' } : { success: false, message: 'Conexão não encontrada.' });
    }

    if (isDashboardPath) {
      return res.json({ success: true });
    } else {
      return res.json({ success: true, message: 'Conexão removida.' });
    }
  } catch (e: any) {
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { success: false, reason: e.message } : { success: false, message: e.message });
  }
}

export async function updateExchange(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const body = req.body;
    const { id, exchangeId, apiKey, apiSecret } = body;
    const nameVal = body.name || body.nome;
    const isCtraderKey = isCtrader(exchangeId);
    const isFixKey = isFix(exchangeId);
    const isDukascopyKey = isDukascopy(exchangeId);
    const isCredentialKey = isFixKey || isDukascopyKey;

    if (!id || !exchangeId || !nameVal || (!isCtraderKey && !isCredentialKey && !apiKey)) {
      return res.status(400).json(isDashboardPath ? { success: false, reason: 'Missing required fields' } : { success: false, message: 'Campos obrigatórios ausentes.' });
    }
    if (isFixKey && (!body.host || !body.senderCompId || !body.username)) {
      return res.status(400).json(isDashboardPath ? { success: false, reason: 'FIX: host, senderCompId e username são obrigatórios' } : { success: false, message: 'Dados do FIX ausentes.' });
    }
    if (isDukascopyKey && !body.username) {
      return res.status(400).json(isDashboardPath ? { success: false, reason: 'Dukascopy: username é obrigatório' } : { success: false, message: 'Dados do Dukascopy ausentes.' });
    }

    if (isHyperliquid(exchangeId) && apiSecret && apiSecret.trim() !== '') {
      const validation = await validateHyperliquidKey(apiKey, apiSecret);
      if (!validation.ok) {
        return res.status(400).json(isDashboardPath ? { success: false, reason: validation.reason } : { success: false, message: validation.reason });
      }
    }

    const updateData: any = {
      exchangeId,
      name: nameVal.trim(),
      ...(!isCtraderKey && !isCredentialKey ? { apiKey: apiKey.trim() } : {}),
    };

    if (isCtraderKey) {
      if (body.clientId) updateData.clientId = String(body.clientId).trim();
      if (body.accountId) updateData.accountId = String(body.accountId).trim();
      if (body.username) updateData.username = String(body.username).trim();
      if (body.environment) updateData.environment = body.environment === 'demo' ? 'demo' : 'live';
      const encrypted = encryptFields(body, userId, exchangeId);
      for (const [k, v] of Object.entries(encrypted)) {
        updateData[k] = v;
      }
    } else if (isCredentialKey) {
      if (isFixKey) {
        if (body.host) updateData.host = String(body.host).trim();
        if (body.quotePort) updateData.quotePort = Number(body.quotePort);
        if (body.tradePort) updateData.tradePort = Number(body.tradePort);
        if (body.senderCompId) updateData.senderCompId = String(body.senderCompId).trim();
        if (body.targetCompId) updateData.targetCompId = String(body.targetCompId).trim();
        if (body.heartBtInt) updateData.heartBtInt = Number(body.heartBtInt);
      }
      if (isDukascopyKey && body.jnlpUrl) updateData.jnlpUrl = String(body.jnlpUrl).trim();
      if (body.username) updateData.username = String(body.username).trim();
      const encrypted = encryptFields(body, userId, exchangeId);
      for (const [k, v] of Object.entries(encrypted)) {
        updateData[k] = v;
      }
    } else if (apiSecret && apiSecret.trim() !== '') {
      updateData.apiSecret = encryptSecretKey(apiSecret.trim(), `${userId}-${exchangeId}`);
    }

    const updatedExchange = await ExchangeKey.findOneAndUpdate(
      { _id: id, userId },
      { $set: updateData },
      { new: true }
    );

    if (!updatedExchange) {
      return res.status(404).json(isDashboardPath ? { success: false, reason: 'Exchange not found' } : { success: false, message: 'Exchange não encontrada.' });
    }

    const responseData = updatedExchange.toObject();
    for (const f of SECRET_FIELDS) delete responseData[f];

    if (isDashboardPath) {
      return res.json({ success: true, exchange: responseData });
    } else {
      return res.json({
        success: true,
        message: 'Exchange atualizada com sucesso.',
        data: {
          id: responseData._id.toString(),
          exchangeId: responseData.exchangeId,
          nome: responseData.name,
          apiKey: responseData.apiKey,
          ativa: responseData.active
        }
      });
    }
  } catch (e: any) {
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { success: false, reason: e.message } : { success: false, message: e.message });
  }
}
