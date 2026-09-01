import { Response } from 'express';
import mongoose from 'mongoose';
import PerpArbStrategy from '../models/PerpArbStrategy';
import PerpArbTrade from '../models/PerpArbTrade';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import redis from '../utils/redis';


const Strategy = PerpArbStrategy as any;
const Trade = PerpArbTrade as any;

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

function validateStrategyBody(body: any, userId: string): { valid: boolean; error?: string } {
  if (!userId) return { valid: false, error: 'User ID is required' };
  
  const nameVal = body.name || body.nome;
  if (!nameVal || typeof nameVal !== 'string' || nameVal.length > 100) {
    return { valid: false, error: 'name (or nome) is required (max 100 chars)' };
  }
  if (!body.perpSymbol || typeof body.perpSymbol !== 'string') {
    return { valid: false, error: 'perpSymbol is required' };
  }
  if (!body.spotSymbol || typeof body.spotSymbol !== 'string') {
    return { valid: false, error: 'spotSymbol is required' };
  }
  if (body.tradeSize === undefined || isNaN(Number(body.tradeSize)) || Number(body.tradeSize) <= 0) {
    return { valid: false, error: 'tradeSize must be a positive number' };
  }
  if (body.minFundingRatePct !== undefined && isNaN(Number(body.minFundingRatePct))) {
    return { valid: false, error: 'minFundingRatePct must be a number' };
  }
  if (body.maxSlippagePct !== undefined && isNaN(Number(body.maxSlippagePct))) {
    return { valid: false, error: 'maxSlippagePct must be a number' };
  }
  if (body.maxDailyLoss !== undefined && isNaN(Number(body.maxDailyLoss))) {
    return { valid: false, error: 'maxDailyLoss must be a number' };
  }
  if (body.cooldownAfterLossMs !== undefined && isNaN(Number(body.cooldownAfterLossMs))) {
    return { valid: false, error: 'cooldownAfterLossMs must be a number' };
  }
  if (body.perpExchangeKeyId && !isValidObjectId(body.perpExchangeKeyId)) {
    return { valid: false, error: 'perpExchangeKeyId must be a valid ObjectId' };
  }
  if (body.spotExchangeKeyId && !isValidObjectId(body.spotExchangeKeyId)) {
    return { valid: false, error: 'spotExchangeKeyId must be a valid ObjectId' };
  }
  if (body.exchangeKeyId && !isValidObjectId(body.exchangeKeyId)) {
    return { valid: false, error: 'exchangeKeyId must be a valid ObjectId' };
  }
  return { valid: true };
}

function formatStrategy(strat: any) {
  const lastSpotBid = strat.lastSpotBid || strat.lastSpotPrice || 0;
  const lastSpotAsk = strat.lastSpotAsk || strat.lastSpotPrice || 0;
  const lastPerpBid = strat.lastPerpBid || strat.lastPerpPrice || 0;
  const lastPerpAsk = strat.lastPerpAsk || strat.lastPerpPrice || 0;

  // Calculo do Spread de Saida: Vender Spot (spotBid) e Comprar Perp (perpAsk)
  let exitSpreadPct = 0;
  let exitSpreadUsd = 0;
  if (lastSpotBid > 0 && lastPerpAsk > 0) {
    exitSpreadPct = Number((((lastSpotBid - lastPerpAsk) / lastPerpAsk) * 100).toFixed(4));
    const size = Number(strat.positionSize || strat.tradeSize || 0);
    exitSpreadUsd = Number(((exitSpreadPct / 100) * size).toFixed(4));
  }

  // Preco de Liquidacao Estimado para a perna Short 1x no Perpétuo: EntryPrice * 2
  let estimatedLiquidationPrice = null;
  const entryPerp = strat.lastPerpPrice || lastPerpAsk;
  if (entryPerp > 0) {
    estimatedLiquidationPrice = Number((entryPerp * 2).toFixed(4));
  }

  return {
    id: strat._id.toString(),
    nome: strat.name,
    perpSymbol: strat.perpSymbol,
    spotSymbol: strat.spotSymbol,
    tradeSize: strat.tradeSize,
    minFundingRatePct: strat.minFundingRatePct,
    maxSlippagePct: strat.maxSlippagePct,
    maxDailyLoss: strat.maxDailyLoss,
    cooldownAfterLossMs: strat.cooldownAfterLossMs,
    perpExchangeKeyId: strat.perpExchangeKeyId ? strat.perpExchangeKeyId.toString() : null,
    spotExchangeKeyId: strat.spotExchangeKeyId ? strat.spotExchangeKeyId.toString() : null,
    exchangeKeyId: strat.exchangeKeyId ? strat.exchangeKeyId.toString() : null,
    ativo: strat.active,
    autoExecute: strat.autoExecute,
    dailyLossAccum: strat.dailyLossAccum,
    lastLossAt: strat.lastLossAt,
    currentFundingRate: strat.currentFundingRate,
    positionOpen: strat.positionOpen,
    positionSize: strat.positionSize,
    fundingCollected: strat.fundingCollected,
    autoClose: strat.autoClose,
    fundingTargetPct: strat.fundingTargetPct,
    maxHoldHours: strat.maxHoldHours,
    exitSpreadPct,
    exitSpreadUsd,
    estimatedLiquidationPrice,
    lastSpotBid: strat.lastSpotBid || null,
    lastSpotAsk: strat.lastSpotAsk || null,
    lastPerpBid: strat.lastPerpBid || null,
    lastPerpAsk: strat.lastPerpAsk || null,
  };
}

export async function getStrategies(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const list = await Strategy.find({ userId }).lean();

    if (isDashboardPath) {
      return res.json(list);
    } else {
      const formatted = list.map(formatStrategy);
      return res.json({ success: true, message: 'ok', data: formatted });
    }
  } catch (e: any) {
    console.error('❌ [GET Strategies] Error:', e.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? [] : { success: false, message: e.message });
  }
}

export async function createStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const body = req.body;
    const validation = validateStrategyBody(body, userId);
    if (!validation.valid) {
      return res.status(400).json(isDashboardPath ? { error: validation.error } : { success: false, message: validation.error });
    }

    const ALLOWED_FIELDS = ['perpSymbol', 'spotSymbol', 'tradeSize', 'minFundingRatePct', 'maxSlippagePct', 'maxDailyLoss', 'cooldownAfterLossMs', 'perpExchangeKeyId', 'spotExchangeKeyId', 'exchangeKeyId'];
    const strategyData: any = { 
      userId,
      name: (body.name || body.nome || '').trim(),
      active: body.active !== undefined ? (body.active === true || body.active === 'true') : (body.ativo !== undefined ? (body.ativo === true || body.ativo === 'true') : true)
    };

    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined) strategyData[field] = body[field];
    }

    const s = await Strategy.create(strategyData);

    if (redis) {
      redis.publish('perp-arb-control', JSON.stringify({ action: 'STRATEGY_CREATED', strategyId: String(s._id) }));
    }

    if (isDashboardPath) {
      return res.json(s);
    } else {
      return res.json({ success: true, message: 'Estratégia criada com sucesso.', data: formatStrategy(s) });
    }
  } catch (e: any) {
    console.error('❌ [POST Strategy] Error:', e.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function updateStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const body = req.body;
    const { id } = body;
    if (!id) {
      return res.status(400).json(isDashboardPath ? { error: 'strategy id required' } : { success: false, message: 'ID da estratégia é obrigatório.' });
    }
    if (!isValidObjectId(id)) {
      return res.status(400).json(isDashboardPath ? { error: 'invalid strategy id' } : { success: false, message: 'ID da estratégia inválido.' });
    }

    const existing = await Strategy.findOne({ _id: id, userId });
    if (!existing) {
      return res.status(404).json(isDashboardPath ? { error: 'strategy not found' } : { success: false, message: 'Estratégia não encontrada.' });
    }

    const update: any = {};
    const nameVal = body.name || body.nome;
    if (nameVal) update.name = nameVal.trim();
    if (typeof body.perpSymbol === 'string') update.perpSymbol = body.perpSymbol;
    if (typeof body.spotSymbol === 'string') update.spotSymbol = body.spotSymbol;
    if (body.tradeSize !== undefined) update.tradeSize = Number(body.tradeSize);
    if (body.minFundingRatePct !== undefined) update.minFundingRatePct = Number(body.minFundingRatePct);
    if (body.maxSlippagePct !== undefined) update.maxSlippagePct = Number(body.maxSlippagePct);
    if (body.maxDailyLoss !== undefined) update.maxDailyLoss = Number(body.maxDailyLoss);
    if (body.cooldownAfterLossMs !== undefined) update.cooldownAfterLossMs = Number(body.cooldownAfterLossMs);
    if (body.autoExecute !== undefined) update.autoExecute = body.autoExecute === true || body.autoExecute === 'true';
    
    // Suporta 'active' ou 'ativo'
    const activeVal = body.active !== undefined ? body.active : body.ativo;
    if (activeVal !== undefined) update.active = activeVal === true || activeVal === 'true';

    if (body.perpExchangeKeyId) update.perpExchangeKeyId = body.perpExchangeKeyId;
    if (body.spotExchangeKeyId) update.spotExchangeKeyId = body.spotExchangeKeyId;
    if (body.autoClose !== undefined) update.autoClose = body.autoClose === true || body.autoClose === 'true';
    if (body.fundingTargetPct !== undefined) update.fundingTargetPct = Number(body.fundingTargetPct);
    if (body.maxHoldHours !== undefined) update.maxHoldHours = Number(body.maxHoldHours);
    if (body.resetCooldown === true || body.resetCooldown === 'true') {
      update.lastLossAt = null;
      update.dailyLossAccum = 0;
    }

    const strategy = await Strategy.findByIdAndUpdate(id, update, { new: true }).lean();
    if (!strategy) {
      return res.status(404).json(isDashboardPath ? { error: 'strategy not found' } : { success: false, message: 'Estratégia não encontrada.' });
    }

    if (redis) {
      redis.publish('perp-arb-control', JSON.stringify({ action: 'STRATEGY_UPDATED', strategyId: String(strategy._id) }));
    }

    if (isDashboardPath) {
      return res.json(strategy);
    } else {
      return res.json({ success: true, message: 'Estratégia atualizada com sucesso.', data: formatStrategy(strategy) });
    }
  } catch (e: any) {
    console.error('❌ [PUT Strategy] Error:', e.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function deleteStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    // Suporta params ou query
    const id = req.params.id || req.query.id as string || req.body.id as string;
    if (!id) {
      return res.status(400).json(isDashboardPath ? { error: 'strategy id required' } : { success: false, message: 'ID da estratégia é obrigatório.' });
    }
    if (!isValidObjectId(id)) {
      return res.status(400).json(isDashboardPath ? { error: 'invalid strategy id' } : { success: false, message: 'ID da estratégia inválido.' });
    }

    const result = await Strategy.deleteOne({ _id: id, userId });
    if (result.deletedCount === 0) {
      return res.status(404).json(isDashboardPath ? { error: 'strategy not found' } : { success: false, message: 'Estratégia não encontrada.' });
    }

    if (redis) {
      redis.publish('perp-arb-control', JSON.stringify({ action: 'STRATEGY_DELETED', strategyId: id }));
    }

    if (isDashboardPath) {
      return res.json({ success: true });
    } else {
      return res.json({ success: true, message: 'Estratégia removida.' });
    }
  } catch (e: any) {
    console.error('❌ [DELETE Strategy] Error:', e.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: e.message } : { success: false, message: e.message });
  }
}

const CLOSE_DUP_WINDOW_MS = 2 * 60 * 1000;

interface TradeDoc {
  type: string;
  status?: string;
  createdAt: Date | string;
  strategyId?: any;
  perpSymbol?: string;
  spotOrderId?: string | null;
  perpOrderId?: string | null;
}

function tradeStratId(t: TradeDoc): string {
  if (typeof t.strategyId === 'object' && t.strategyId !== null) {
    return String((t.strategyId as { _id?: any })._id || '');
  }
  return String(t.strategyId || '');
}

function dedupeCloseHedges(trades: TradeDoc[]): TradeDoc[] {
  const closes = trades.filter((t) => t.type === 'close_hedge');
  if (closes.length <= 1) return trades;

  const others = trades.filter((t) => t.type !== 'close_hedge');

  const groups = new Map<string, TradeDoc[]>();
  for (const c of closes) {
    const key = `${tradeStratId(c)}::${String(c.perpSymbol || '')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  const kept: TradeDoc[] = [];
  for (const group of groups.values()) {
    if (group.length <= 1) {
      kept.push(...group);
      continue;
    }

    group.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const newest = new Date(group[0].createdAt).getTime();
    const farAway = group.filter((c) => newest - new Date(c.createdAt).getTime() > CLOSE_DUP_WINDOW_MS);
    const near = group.filter((c) => newest - new Date(c.createdAt).getTime() <= CLOSE_DUP_WINDOW_MS);

    kept.push(...farAway);

    if (near.length <= 1) {
      kept.push(...near);
      continue;
    }

    const withOrders = near.filter((c) => c.spotOrderId || c.perpOrderId);
    const best = withOrders.length > 0 ? withOrders[0] : near[0];
    kept.push(best);
  }

  return [...others, ...kept];
}

export async function getTrades(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const hedgeTrades = (await Trade.find({
      userId,
      type: { $in: ['open_hedge', 'close_hedge', 'funding_fee_accumulated'] }
    })
      .sort({ createdAt: -1 })
      .limit(300)
      .populate({ path: 'strategyId', model: 'PerpArbStrategy', select: 'name perpSymbol spotSymbol' })
      .lean()) as any[];

    const logTrades = (await Trade.find({
      userId,
      type: { $nin: ['open_hedge', 'close_hedge', 'funding_fee_accumulated'] }
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate({ path: 'strategyId', model: 'PerpArbStrategy', select: 'name perpSymbol spotSymbol' })
      .lean()) as any[];

    const deduped = dedupeCloseHedges(hedgeTrades);
    const trades = [...deduped, ...logTrades].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (isDashboardPath) {
      return res.json(trades);
    } else {
      return res.json({ success: true, message: 'ok', data: trades });
    }
  } catch (e: any) {
    console.error('❌ [GET Trades] Error:', e.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? [] : { success: false, message: e.message });
  }
}

export async function deleteTrades(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    await Trade.deleteMany({
      userId,
      status: { $nin: ['executed'] },
    });

    if (isDashboardPath) {
      return res.json({ success: true });
    } else {
      return res.json({ success: true, message: 'Histórico de transações limpo.' });
    }
  } catch (e: any) {
    console.error('❌ [DELETE Trades] Error:', e.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function getTradesSummary(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;

    const closeTrades = await Trade.find({
      userId: userObjId,
      type: 'close_hedge',
      status: { $in: ['executed', 'simulated'] }
    }).lean();

    const openTrades = await Trade.find({
      userId: userObjId,
      type: 'open_hedge',
      status: { $in: ['executed', 'simulated'] }
    }).lean();

    const totalClosed = closeTrades.length;
    const totalPnl = closeTrades.reduce((acc: number, t: any) => acc + Number(t.pnl || 0), 0);
    const totalEntradaUsd = openTrades.reduce((acc: number, t: any) => acc + Number(t.amount || 0), 0);
    const totalSaidaUsd = totalEntradaUsd + totalPnl;

    let aprPct = 0;
    let monthlyPct = 0;
    if (totalEntradaUsd > 0) {
      const returnPct = (totalPnl / totalEntradaUsd) * 100;
      monthlyPct = Number((returnPct).toFixed(2));
      aprPct = Number((returnPct * 12).toFixed(2));
    }

    const summaryData = {
      operacoesEncerradas: totalClosed,
      totalPnl: Number(totalPnl.toFixed(2)),
      aprPct,
      monthlyPct,
      totalEntradaUsd: Number(totalEntradaUsd.toFixed(2)),
      totalSaidaUsd: Number(totalSaidaUsd.toFixed(2))
    };

    if (isDashboardPath) {
      return res.json(summaryData);
    } else {
      return res.json({ success: true, message: 'ok', data: summaryData });
    }
  } catch (e: any) {
    console.error('❌ [GET Trades Summary] Error:', e.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: e.message } : { success: false, message: e.message });
  }
}


