import mongoose from 'mongoose';
import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import IcMarketsSettings from '../models/IcMarketsSettings';
import IcMarketsStrategy from '../models/IcMarketsStrategy';
import IcMarketsTrade from '../models/IcMarketsTrade';
import ExchangeKey from '../models/ExchangeKey';
import { getSharedCtraderAdapter } from '../strategy/forex/ctrader/ctrader-factory';
import { IcMarketsBot, getIcMarketsLogBuffer } from '../strategy/icmarkets/icmarkets-bot';
import { IcMarketsMetaLabeler } from '../strategy/icmarkets/helpers/icmarkets-meta-labeler';

/**
 * @swagger
 * tags:
 *   name: IcMarkets
 *   description: Endpoints para gerenciamento do Robô IC Markets cTrader (ic.com) e IA Meta-Labeling
 */

/**
 * Obter configurações globais do robô IC Markets.
 */
export async function getIcMarketsSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    let settings = await IcMarketsSettings.findOne({ userId });
    if (!settings) {
      settings = await IcMarketsSettings.create({ userId, accountId: '10102182', accountType: 'demo' });
    }
    res.json({ ok: true, settings });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Atualizar configurações globais do robô IC Markets.
 */
export async function updateIcMarketsSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const body = req.body;

    const settings = await IcMarketsSettings.findOneAndUpdate(
      { userId },
      { $set: body },
      { new: true, upsert: true }
    );

    // Sincroniza ExchangeKey se especificado
    if (body.accountType !== undefined || body.accountId !== undefined) {
      const exKeyUpdate: any = {};
      if (body.accountId) exKeyUpdate.accountId = String(body.accountId).trim();
      if (body.accountType) exKeyUpdate.environment = (body.accountType === 'live' || body.accountType === 'real') ? 'live' : 'demo';
      if (Object.keys(exKeyUpdate).length > 0) {
        await ExchangeKey.updateMany(
          { userId, exchangeId: { $in: ['icmarkets', 'icmarkets-ctrader', 'ic', 'ctrader'] } },
          { $set: exKeyUpdate }
        );
      }
    }

    if (body.isScanningEnabled !== undefined) {
      if (body.isScanningEnabled) {
        await IcMarketsBot.start();
      } else {
        await IcMarketsBot.stop();
      }
    }

    res.json({ ok: true, settings });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

function formatStrategy(s: any): any {
  if (!s) return s;
  const obj = typeof s.toObject === 'function' ? s.toObject() : { ...s };
  return {
    ...obj,
    id: obj._id?.toString() || obj.id,
    _id: obj._id?.toString() || obj.id,
  };
}

/**
 * Listar estratégias IC Markets do usuário.
 */
export async function getIcMarketsStrategies(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    await IcMarketsBot.syncAllPositions(userId).catch(() => {});
    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    const rawStrategies = await IcMarketsStrategy.find({
      $or: [{ userId }, { userId: userObjId }, { userId: { $exists: false } }],
    }).sort({ createdAt: -1 }).lean();

    const formatted = rawStrategies.map(formatStrategy);
    res.json({ ok: true, strategies: formatted });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Criar nova estratégia IC Markets.
 */
export async function createIcMarketsStrategy(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const body = req.body;
    const strategy = await IcMarketsStrategy.create({
      ...body,
      userId,
      symbol: (body.symbol || 'EURUSD').toUpperCase(),
    });
    res.json({ ok: true, strategy: formatStrategy(strategy) });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Atualizar estratégia existente.
 */
export async function updateIcMarketsStrategy(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const id = req.params.id || req.body.id || req.body._id;
    const body = req.body;

    if (!id) {
      res.status(400).json({ ok: false, error: 'ID da estratégia não informado.' });
      return;
    }

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;

    const strategy = await IcMarketsStrategy.findOneAndUpdate(
      {
        _id: id,
        $or: [{ userId }, { userId: userObjId }, { userId: { $exists: false } }],
      },
      { $set: body },
      { new: true }
    );
    if (!strategy) {
      res.status(404).json({ ok: false, error: 'Estratégia não encontrada.' });
      return;
    }
    res.json({ ok: true, strategy: formatStrategy(strategy) });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Deletar estratégia.
 */
export async function deleteIcMarketsStrategy(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const { id } = req.params;
    await IcMarketsStrategy.deleteOne({ _id: id, userId });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Alternar status (Play / Pause).
 */
export async function toggleIcMarketsStrategy(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const { id } = req.params;
    const strategy = await IcMarketsStrategy.findOne({ _id: id, userId });
    if (!strategy) {
      res.status(404).json({ ok: false, error: 'Estratégia não encontrada.' });
      return;
    }
    strategy.active = !strategy.active;
    strategy.status = strategy.active ? 'running' : 'paused';
    await strategy.save();
    res.json({ ok: true, strategy: formatStrategy(strategy) });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Listar histórico de trades com filtros.
 */
export async function getIcMarketsTrades(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const { limit = '100', symbol, status, periodo } = req.query as Record<string, string>;

    const query: any = { userId };
    if (symbol) query.symbol = symbol.toUpperCase();
    if (status) query.status = status;

    if (periodo) {
      const now = Date.now();
      if (periodo === '1h') query.createdAt = { $gte: new Date(now - 3600 * 1000) };
      else if (periodo === '24h' || periodo === 'today') {
        const startOfDay = new Date();
        startOfDay.setUTCHours(0, 0, 0, 0);
        query.createdAt = { $gte: startOfDay };
      } else if (periodo === '7d') query.createdAt = { $gte: new Date(now - 7 * 86400 * 1000) };
      else if (periodo === '30d') query.createdAt = { $gte: new Date(now - 30 * 86400 * 1000) };
    }

    const trades = await IcMarketsTrade.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit, 10))
      .lean();

    const formatted = trades.map((t: any) => ({
      ...t,
      id: t._id?.toString() || t.id,
      _id: t._id?.toString() || t.id,
    }));

    res.json({ ok: true, trades: formatted });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Status do robô.
 */
export async function getIcMarketsBotStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const status = IcMarketsBot.getStatus();
    res.json({ ok: true, status });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

export async function startIcMarketsBot(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    await IcMarketsSettings.updateOne({ userId }, { $set: { isScanningEnabled: true } }, { upsert: true });
    await IcMarketsBot.start();
    res.json({ ok: true, message: 'Robô IC Markets iniciado com sucesso.' });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

export async function stopIcMarketsBot(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    await IcMarketsSettings.updateOne({ userId }, { $set: { isScanningEnabled: false } }, { upsert: true });
    await IcMarketsBot.stop();
    res.json({ ok: true, message: 'Robô IC Markets pausado com sucesso.' });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * IA Status e Treinamento
 */
export async function getIcMarketsMetaModelStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const metadata = IcMarketsMetaLabeler.getMetadata();
    res.json({ ok: true, metadata: metadata || null });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

export async function trainIcMarketsMetaModel(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const metadata = await IcMarketsMetaLabeler.trainModel();
    res.json({ ok: true, message: 'Modelo de IA IC Markets cTrader treinado com sucesso!', metadata });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Logs em memória
 */
export async function getIcMarketsLogs(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const logs = getIcMarketsLogBuffer();
    res.json({ ok: true, logs });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Saldo da Conta cTrader IC Markets
 */
export async function getIcMarketsBalance(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const settings = await IcMarketsSettings.findOne({ userId });
    const key =
      (await ExchangeKey.findOne({
        userId,
        exchangeId: { $in: ['icmarkets', 'icmarkets-ctrader', 'ic', 'ctrader'] },
        active: true,
      }).lean()) ||
      (await ExchangeKey.findOne({
        exchangeId: { $in: ['icmarkets', 'icmarkets-ctrader', 'ic', 'ctrader'] },
        active: true,
      }).lean());

    if (!key) {
      res.json({ ok: true, balance: { balance: 300, equity: 300, currency: 'USD', accountType: 'demo', accountId: '10102182' } });
      return;
    }

    const env = settings?.accountType === 'real' ? 'live' : 'demo';
    const targetAccountId = settings?.accountId || key.accountId || '10102182';

    let balanceUsd = 300;

    try {
      const adapter = await getSharedCtraderAdapter(key, {
        accountId: targetAccountId,
        environment: env,
      });

      const accountIdNum = Number((adapter as any).creds.accountId || targetAccountId);

      // Consulta dados do Trader via ProtoOATraderReq
      const traderRes = await (adapter as any).client.sendRequest(
        2121,
        'ProtoOATraderReq',
        { ctidTraderAccountId: accountIdNum },
        8000
      ).catch(() => null);

      if (traderRes?.trader?.balance != null) {
        balanceUsd = Number(traderRes.trader.balance) / 100;
      } else {
        // Fallback para Reconcile
        const rec = await (adapter as any).client.sendRequest(
          2124,
          'ProtoOAReconcileReq',
          { ctidTraderAccountId: accountIdNum },
          8000
        ).catch(() => null);

        if (rec?.trader?.balance != null) {
          balanceUsd = Number(rec.trader.balance) / 100;
        }
      }
    } catch (adapterErr: any) {
      console.warn('[ICMARKETS-BALANCE] Erro ao consultar saldo na cTrader:', adapterErr.message);
    }

    res.json({
      ok: true,
      balance: {
        balance: balanceUsd,
        equity: balanceUsd,
        currency: 'USD',
        accountType: settings?.accountType || 'demo',
        accountId: targetAccountId,
      },
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Fechar Posição
 */
export async function closeIcMarketsPosition(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const { strategyId, positionId } = req.body;

    const strategy = await IcMarketsStrategy.findOne({ _id: strategyId, userId });
    if (!strategy) {
      res.status(404).json({ ok: false, error: 'Estratégia não encontrada.' });
      return;
    }

    const posToClose = positionId || strategy.currentPositionId;
    if (posToClose) {
      const key = await ExchangeKey.findOne({
        userId,
        exchangeId: { $in: ['icmarkets', 'icmarkets-ctrader', 'ic', 'ctrader'] },
        active: true,
      }).lean();

      if (key) {
        const settings = await IcMarketsSettings.findOne({ userId });
        const adapter = await getSharedCtraderAdapter(key, {
          accountId: settings?.accountId || key.accountId || '10102182',
          environment: settings?.accountType === 'real' ? 'live' : 'demo',
        });
        const units = Math.round((strategy.lotSize || 0.01) * 100);
        await adapter.closePosition(posToClose, units).catch(() => {});
      }
    }

    await IcMarketsTrade.updateOne(
      { positionId: posToClose, status: 'open' },
      { $set: { status: 'closed', closedAt: new Date(), closeReason: 'manual' } }
    );

    await IcMarketsStrategy.findByIdAndUpdate(strategy._id, {
      $unset: { currentPositionId: 1, currentSide: 1 },
      $set: { currentPnlUsd: 0, entryPrice: 0 },
    });

    res.json({ ok: true, message: 'Posição encerrada com sucesso.' });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
