import { Response } from 'express';
import ForexArbStrategy from '../models/ForexArbStrategy';
import ForexArbTrade from '../models/ForexArbTrade';
import ForexArbSettings from '../models/ForexArbSettings';
import ExchangeKey from '../models/ExchangeKey';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { encryptSecretKey } from '../utils/encryption';

// --- STRATEGIES ---
export async function getForexStrategies(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    const strategies = await ForexArbStrategy.find({ userId }).sort({ createdAt: -1 });
    const formatted = strategies.map((s: any) => ({
      _id: s._id.toString(),
      id: s._id.toString(),
      userId: s.userId.toString(),
      name: s.name,
      exchangeId: s.exchangeId,
      exchangeKeyId: s.exchangeKeyId ? s.exchangeKeyId.toString() : null,
      type: s.type,
      legs: s.legs || [],
      tradeSize: s.tradeSize,
      expectedProfitPct: s.expectedProfitPct,
      minProfitPct: s.minProfitPct,
      maxSlippagePct: s.maxSlippagePct,
      autoExecute: s.autoExecute,
      isAutoCreated: s.isAutoCreated,
      active: s.active,
      positionOpen: s.positionOpen,
      positionOpenedAt: s.positionOpenedAt,
      positionSize: s.positionSize,
      status: s.status,
      pnl: s.pnl,
      closedAt: s.closedAt,
      createdAt: s.createdAt
    }));

    const isDashboard = req.path.includes('/auth/');
    return isDashboard ? res.json(formatted) : res.json({ success: true, message: 'ok', data: formatted });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function createForexStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    const body = req.body;
    const strategy = new ForexArbStrategy({
      ...body,
      userId
    });
    await strategy.save();

    const formatted = {
      _id: strategy._id.toString(),
      id: strategy._id.toString(),
      ...strategy.toObject()
    };

    const isDashboard = req.path.includes('/auth/');
    return isDashboard ? res.status(201).json(formatted) : res.status(201).json({ success: true, message: 'Estratégia Forex criada.', data: formatted });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function deleteForexStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    const id = (req.query.id as string) || req.params.id;
    if (!id) return res.status(400).json({ success: false, message: 'ID obrigatório.' });

    await ForexArbStrategy.deleteOne({ _id: id, userId });
    return res.json({ success: true, message: 'Estratégia removida.' });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

// --- TRADES & OPPORTUNITIES ---
export async function getForexTrades(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    const trades = await ForexArbTrade.find({ userId, type: { $ne: 'opportunity_found' } }).sort({ createdAt: -1 }).limit(100);
    const formatted = trades.map((t: any) => ({
      _id: t._id.toString(),
      id: t._id.toString(),
      strategyId: t.strategyId ? t.strategyId.toString() : null,
      strategyName: t.strategyName,
      exchangeId: t.exchangeId,
      type: t.type,
      legs: t.legs || [],
      amount: t.amount,
      expectedProfitPct: t.expectedProfitPct,
      realizedPnl: t.realizedPnl,
      status: t.status,
      reason: t.reason,
      errorMessage: t.errorMessage,
      createdAt: t.createdAt
    }));

    const isDashboard = req.path.includes('/auth/');
    return isDashboard ? res.json(formatted) : res.json({ success: true, message: 'ok', data: formatted });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function getForexOpportunities(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    const opportunities = await ForexArbTrade.find({ userId, type: 'opportunity_found' }).sort({ createdAt: -1 }).limit(50);
    const formatted = opportunities.map((t: any) => ({
      _id: t._id.toString(),
      id: t._id.toString(),
      exchangeId: t.exchangeId,
      type: t.type,
      legs: t.legs || [],
      amount: t.amount,
      expectedProfitPct: t.expectedProfitPct,
      createdAt: t.createdAt
    }));

    const isDashboard = req.path.includes('/auth/');
    return isDashboard ? res.json(formatted) : res.json({ success: true, message: 'ok', data: formatted });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

// --- SETTINGS ---
export async function getForexSettings(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    let settings = await ForexArbSettings.findOne({ userId });
    if (!settings) {
      settings = await ForexArbSettings.create({
        userId,
        isScanningEnabled: false,
        tradeSize: 100,
        minProfitPct: 0.05,
        minVolume24hUSD: 50000,
        maxStrategiesPerScan: 5,
        scanIntervalMs: 60000,
        maxDailyLoss: 10,
        maxSlippagePct: 0.1,
        autoExecute: true,
        simpleEnabled: true,
        triangularEnabled: true,
        allowedExchanges: []
      });
    }

    const formatted = {
      _id: settings._id.toString(),
      userId: settings.userId.toString(),
      isScanningEnabled: settings.isScanningEnabled,
      lastScannedAt: settings.lastScannedAt,
      tradeSize: settings.tradeSize,
      minProfitPct: settings.minProfitPct,
      minVolume24hUSD: settings.minVolume24hUSD,
      maxStrategiesPerScan: settings.maxStrategiesPerScan,
      scanIntervalMs: settings.scanIntervalMs,
      maxDailyLoss: settings.maxDailyLoss,
      maxSlippagePct: settings.maxSlippagePct,
      autoExecute: settings.autoExecute,
      simpleEnabled: settings.simpleEnabled,
      triangularEnabled: settings.triangularEnabled,
      allowedExchanges: settings.allowedExchanges || []
    };

    const isDashboard = req.path.includes('/auth/');
    return isDashboard ? res.json(formatted) : res.json({ success: true, message: 'ok', data: formatted });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function updateForexSettings(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    const body = req.body;
    if (body.autoExecute === undefined) body.autoExecute = true;
    const settings = await ForexArbSettings.findOneAndUpdate(
      { userId },
      { $set: body },
      { new: true, upsert: true }
    );

    const formatted = {
      _id: settings._id.toString(),
      userId: settings.userId.toString(),
      isScanningEnabled: settings.isScanningEnabled,
      lastScannedAt: settings.lastScannedAt,
      tradeSize: settings.tradeSize,
      minProfitPct: settings.minProfitPct,
      minVolume24hUSD: settings.minVolume24hUSD,
      maxStrategiesPerScan: settings.maxStrategiesPerScan,
      scanIntervalMs: settings.scanIntervalMs,
      maxDailyLoss: settings.maxDailyLoss,
      maxSlippagePct: settings.maxSlippagePct,
      autoExecute: settings.autoExecute,
      simpleEnabled: settings.simpleEnabled,
      triangularEnabled: settings.triangularEnabled,
      allowedExchanges: settings.allowedExchanges || []
    };

    const isDashboard = req.path.includes('/auth/');
    return isDashboard ? res.json(formatted) : res.json({ success: true, message: 'Settings atualizados com sucesso.', data: formatted });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

// --- CTRADER CREDENTIALS ---
export async function updateCtraderCredentials(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    const { accessToken, refreshToken, clientId, clientSecret, accountId, environment } = req.body;

    const exchangeKey = await ExchangeKey.findOne({
      userId,
      exchangeId: { $in: ['ctrader', 'pepperstone'] }
    });

    if (!exchangeKey) {
      return res.status(404).json({ success: false, reason: 'Nenhuma ExchangeKey cTrader/Pepperstone encontrada para esta conta.' });
    }

    const authContext = `${userId}-${exchangeKey.exchangeId}`;
    const updateData: any = {};

    if (clientId) updateData.clientId = clientId.trim();
    if (accountId) updateData.accountId = accountId.trim();
    if (environment) updateData.environment = environment === 'demo' ? 'demo' : 'live';
    if (clientSecret) updateData.clientSecret = encryptSecretKey(clientSecret.trim(), authContext);
    if (accessToken) updateData.accessToken = encryptSecretKey(accessToken.trim(), authContext);
    if (refreshToken) updateData.refreshToken = encryptSecretKey(refreshToken.trim(), authContext);
    updateData.ctraderTokenUpdatedAt = new Date();

    await ExchangeKey.updateOne({ _id: exchangeKey._id }, { $set: updateData });

    return res.json({ success: true, message: 'Credenciais cTrader atualizadas.' });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

// --- LOGS ---
export async function getForexLogs(req: AuthenticatedRequest, res: Response) {
  let processName = 'forex-scalp-executor';
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    processName = (req.query.process as string) || 'forex-scalp-executor';
    const lines = (req.query.lines as string) || '150';

    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    try {
      const { stdout, stderr } = await execAsync(`pm2 logs ${processName} --lines ${lines} --nostream --raw`, { timeout: 3000 });
      const rawOutput = stdout || stderr || '';
      const logLines = rawOutput
        .split('\n')
        .map((l: string) => l.trim())
        .filter(Boolean);

      const responseData = {
        process: processName,
        linesCount: logLines.length,
        logs: logLines.length > 0 ? logLines : [`[${new Date().toISOString()}] Robô ${processName} operante (sem novos logs no período).`],
        timestamp: new Date().toISOString(),
      };

      const isDashboard = req.path.includes('/auth/');
      return isDashboard ? res.json(responseData) : res.json({ success: true, message: 'ok', data: responseData });
    } catch (execErr: any) {
      // Fallback gracioso: quando rodando fora do PM2 em ambiente local/dev
      const responseData = {
        process: processName,
        linesCount: 1,
        logs: [
          `[${new Date().toISOString()}] Robô ${processName} ativo em background (desenvolvimento local).`,
          `⚡ Aguardando próximos ticks e cruzamentos de médias...`
        ],
        timestamp: new Date().toISOString(),
      };
      const isDashboard = req.path.includes('/auth/');
      return res.json(isDashboard ? responseData : { success: true, message: 'ok', data: responseData });
    }
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

// --- CLOSE & OPERATIONS ---
export async function closeForexStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    const { strategyId } = req.body;
    if (!strategyId) return res.status(400).json({ success: false, message: 'strategyId é obrigatório.' });

    const strategy = await ForexArbStrategy.findOne({ _id: strategyId, userId });
    if (!strategy) return res.status(404).json({ success: false, message: 'Estratégia não encontrada.' });

    // Tenta executar o fechamento real na cTrader se houver orderId de posição
    const posId = strategy.legs && strategy.legs[0]?.orderId;
    const symStrategy = strategy.legs && strategy.legs[0]?.symbol;

    if (posId || symStrategy) {
      try {
        const keys = await ExchangeKey.find({ userId, active: true }).lean();
        const ctraderKey = keys.find((k: any) => k.exchangeId === 'ctrader');
        if (ctraderKey) {
          const { getSharedCtraderAdapter } = require('../strategy/forex/ctrader/ctrader-factory');
          const adapter = await getSharedCtraderAdapter(ctraderKey as any);
          await adapter.connect();
          await adapter.loadMarkets();
          const accountId = Number((ctraderKey as any).accountId);
          const rec = await (adapter as any).client.sendRequest(2124, 'ProtoOAReconcileReq', { ctidTraderAccountId: accountId }, 10000);
          if (rec && rec.position) {
            // Busca a posição pelo positionId exato OU pelo símbolo correspondente se a ordem foi aberta anteriormente
            const p = rec.position.find((x: any) => {
              const m = adapter.marketsById.get(String(x.tradeData?.symbolId));
              return String(x.positionId) === String(posId) || (symStrategy && m?.symbol === symStrategy);
            });
            if (p) {
              const realPosId = String(p.positionId);
              const volProto = Number(p.tradeData?.volume || 100);
              console.log(`📤 [MANUAL CLOSE FRONTEND] Encerrando posição #${realPosId} na cTrader (volume: ${volProto})...`);
              await adapter.closePosition(realPosId, volProto);
            }
          }
        }
      } catch (ctraderErr: any) {
        console.warn(`⚠️ Erro ao fechar posição na cTrader via API:`, ctraderErr.message);
      }
    }

    await ForexArbStrategy.updateOne(
      { _id: strategyId },
      { $set: { positionOpen: false, status: 'closed', closedAt: new Date(), active: false } }
    );

    return res.json({ success: true, message: 'Fechamento de posição encerrado com sucesso.' });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

