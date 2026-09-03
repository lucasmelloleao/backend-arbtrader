// Controller de operações Polymarket: salvar credenciais, sync de saldo e
// transferência de pUSD da wallet EOA para a deposit wallet.
import { Response } from 'express';
import mongoose from 'mongoose';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import ExchangeKey from '../models/ExchangeKey';
import { encryptSecretKey, decryptSecretKey } from '../utils/encryption';
import { syncPredictionHistory } from '../strategy/prediction-arb/sync-history';
import { ethers } from 'ethers';
import { withRpcFailover } from '../strategy/prediction-arb/helpers/rpc-failover';
import { getRelayerBaseUrl } from '../config/prediction-arb';

const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

const isDashboard = (req: AuthenticatedRequest) => req.path.includes('/auth/');

function err(res: Response, status: number, msg: string, dashboard: boolean) {
  return res.status(status).json(dashboard ? { success: false, reason: msg } : { success: false, message: msg });
}

/** Busca a ExchangeKey polymarket do usuário. */
async function findPolyKey(userId: any): Promise<any> {
  const key = await ExchangeKey.findOne({ userId, exchangeId: 'polymarket' });
  if (!key) throw new Error('Nenhuma ExchangeKey polymarket cadastrada.');
  return key;
}

/** Descriptografa a private key da wallet EOA. */
function getPrivateKey(doc: any): string {
  try {
    const aad = doc.userId ? `${doc.userId}-polymarket` : '';
    return decryptSecretKey(String(doc.apiSecret || ''), aad);
  } catch {
    return String(doc.apiSecret || '');
  }
}

/** Salva/atualiza as credenciais Polymarket (relayer key, deposit wallet, clob creds). */
export async function savePolymarketCredentials(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return err(res, 401, 'Não autorizado.', isDashboard(req));

    const body = req.body || {};
    const key = await findPolyKey(userId);

    const update: any = {};
    if (body.relayerApiKey) update.relayerApiKey = String(body.relayerApiKey).trim();
    if (body.relayerApiKeyAddress) update.relayerApiKeyAddress = String(body.relayerApiKeyAddress).trim();
    if (body.depositWallet) update.depositWallet = String(body.depositWallet).trim();
    if (body.clobApiKey) update.clobApiKey = String(body.clobApiKey).trim();
    if (body.clobSecret) update.clobSecret = encryptSecretKey(String(body.clobSecret).trim(), `${userId}-polymarket-clob`);
    if (body.clobPassphrase) update.clobPassphrase = encryptSecretKey(String(body.clobPassphrase).trim(), `${userId}-polymarket-clob`);

    if (Object.keys(update).length === 0) {
      return err(res, 400, 'Nenhum campo para salvar.', isDashboard(req));
    }

    await ExchangeKey.findByIdAndUpdate(key._id, { $set: update });
    return res.json({ success: true, message: 'Credenciais Polymarket salvas.' });
  } catch (e: any) {
    return err(res, 500, e.message, isDashboard(req));
  }
}

/** Busca o saldo pUSD da wallet EOA e da deposit wallet (on-chain). */
export async function syncPolymarketBalance(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return err(res, 401, 'Não autorizado.', isDashboard(req));

    const key = await findPolyKey(userId);
    const eoa = String(key.apiKey || '').toLowerCase();
    const dw = String(key.depositWallet || '').toLowerCase();

    const [balEoa, balDw] = await Promise.all([
      eoa ? withRpcFailover(async (provider) => {
        const pusd = new ethers.Contract(PUSD, ERC20_ABI, provider);
        const bal = await pusd.balanceOf(eoa);
        return Number(ethers.formatUnits(bal, 6));
      }) : Promise.resolve(0),
      dw ? withRpcFailover(async (provider) => {
        const pusd = new ethers.Contract(PUSD, ERC20_ABI, provider);
        const bal = await pusd.balanceOf(dw);
        return Number(ethers.formatUnits(bal, 6));
      }) : Promise.resolve(0),
    ]);

    await ExchangeKey.findByIdAndUpdate(key._id, {
      $set: { pusdBalance: balDw, lastSyncAt: new Date() },
    });

    return res.json({
      success: true,
      data: { eoaBalance: balEoa, depositWalletBalance: balDw, depositWallet: dw || null },
    });
  } catch (e: any) {
    return err(res, 500, e.message, isDashboard(req));
  }
}

/**
 * Transfere pUSD da wallet EOA para a deposit wallet (on-chain, gas pago em MATIC
 * da própria EOA). Pré-requisitos: EOA com pUSD + MATIC; deposit wallet deployada.
 */
export async function transferPusdToDepositWallet(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return err(res, 401, 'Não autorizado.', isDashboard(req));

    const key = await findPolyKey(userId);
    const dw = String(key.depositWallet || '').trim();
    if (!dw) {
      return err(res, 400, 'Deposit wallet não configurada. Salve o endereço da deposit wallet primeiro.', isDashboard(req));
    }

    const privateKey = getPrivateKey(key);

    // Tenta a transferência com failover de RPC
    const result = await withRpcFailover(async (provider) => {
      const wallet = new ethers.Wallet(privateKey, provider);
      const pusd = new ethers.Contract(PUSD, ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'], wallet);

      const bal = await pusd.balanceOf(wallet.address);
      if (bal <= 0n) {
        throw new Error('Nenhum pUSD na wallet EOA para transferir.');
      }

      const matic = await provider.getBalance(wallet.address);
      if (matic < ethers.parseEther('0.01')) {
        throw new Error('MATIC insuficiente na EOA para pagar o gas da transferência.');
      }

      const amount = Number(req.body?.amount);
      const value = amount && amount > 0
        ? ethers.parseUnits(Math.min(amount, Number(ethers.formatUnits(bal, 6))).toFixed(6), 6)
        : bal;

      const tx = await pusd.transfer(dw, value, { gasLimit: 100000 });
      const receipt = await tx.wait();

      const balDw = Number(ethers.formatUnits(await pusd.balanceOf(dw), 6));
      await ExchangeKey.findByIdAndUpdate(key._id, {
        $set: { pusdBalance: balDw, lastSyncAt: new Date() },
      });

      return {
        success: true,
        message: `Transferidos ${ethers.formatUnits(value, 6)} pUSD para a deposit wallet.`,
        data: { txHash: receipt.hash, amount: Number(ethers.formatUnits(value, 6)), depositWalletBalance: balDw },
      };
    });

    return res.json(result);
  } catch (e: any) {
    return err(res, 500, e.message, isDashboard(req));
  }
}

/** Deploy da deposit wallet via relayer (WALLET-CREATE) — usa a relayer key salva. */
export async function deployDepositWallet(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return err(res, 401, 'Não autorizado.', isDashboard(req));

    const key = await findPolyKey(userId);
    const relayerKey = String(key.relayerApiKey || '').trim();
    if (!relayerKey) {
      return err(res, 400, 'Relayer API key não configurada. Salve no painel primeiro.', isDashboard(req));
    }

    const eoa = String(key.apiKey || '').trim();
    const FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';
    const RELAYER = getRelayerBaseUrl();
    if (!RELAYER) return err(res, 500, 'POLYMARKET_RELAYER_BASE não configurada.', isDashboard(req));

    // 1. Verifica se já existe (params retorna nonce; se wallet existe, o create falha)
    // 2. Envia WALLET-CREATE
    const body = { type: 'WALLET-CREATE', from: eoa, to: FACTORY, metadata: 'Deploy Deposit Wallet' };
    const res2 = await fetch(`${RELAYER}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'RELAYER_API_KEY': relayerKey,
        'RELAYER_API_KEY_ADDRESS': eoa,
      },
      body: JSON.stringify(body),
    });
    const data: any = await res2.json().catch(() => ({}));

    if (res2.status === 400 && String(data.error || '').includes('already exists')) {
      return res.json({ success: true, message: 'Deposit wallet já existe.', data });
    }
    if (!res2.ok) {
      return err(res, 400, `Relayer falhou: ${JSON.stringify(data).slice(0, 200)}`, isDashboard(req));
    }

    return res.json({ success: true, message: 'Deploy da deposit wallet enviado.', data });
  } catch (e: any) {
    return err(res, 500, e.message, isDashboard(req));
  }
}

/** Sincroniza o histórico de operações da Polymarket para o banco (aparece no front). */
export async function syncPredictionHistoryController(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return err(res, 401, 'Não autorizado.', isDashboard(req));

    const result = await syncPredictionHistory(userId);
    return res.json({
      success: true,
      message: `Histórico sincronizado: ${result.criados} criados, ${result.atualizados} já existiam.`,
      data: result,
    });
  } catch (e: any) {
    return err(res, 500, e.message, isDashboard(req));
  }
}
