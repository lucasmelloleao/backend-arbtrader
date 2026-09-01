import { Response } from 'express';
import mongoose from 'mongoose';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import PredictionArbStrategy from '../models/PredictionArbStrategy';
import PredictionArbTrade from '../models/PredictionArbTrade';
import { findMarket } from '../strategy/prediction-arb/prediction-scanner';
import { completenessSpreadPct } from '../strategy/prediction-arb/helpers/pricing';

const isDashboard = (req: AuthenticatedRequest) => req.path.includes('/auth/');

function formatStrategy(s: any) {
  return {
    id: s._id.toString(),
    nome: s.question || s.slug,
    slug: s.slug,
    marketId: s.marketId,
    conditionId: s.conditionId,
    yesPrice: s.yesPrice,
    noPrice: s.noPrice,
    spreadPct: s.spreadPct,
    tradeSize: s.tradeSize,
    ativo: s.active,
    autoExecute: s.autoExecute,
    positionOpen: s.positionOpen,
    positionSize: s.positionSize,
    yesShares: s.yesShares,
    noShares: s.noShares,
    avgYesPrice: s.avgYesPrice,
    avgNoPrice: s.avgNoPrice,
    targetProfitPct: s.targetProfitPct,
    endDate: s.endDate,
    isAutoCreated: s.isAutoCreated,
    createdAt: s.createdAt,
  };
}

export async function getPredictionStrategies(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const list = await (PredictionArbStrategy as any).find({ userId }).lean();
    if (isDashboard(req)) return res.json(list);
    return res.json({ success: true, message: 'ok', data: list.map(formatStrategy) });
  } catch (e: any) {
    console.error('❌ [GET PredictionStrategies] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function createPredictionStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const { slug, tradeSize, autoExecute, exchangeKeyId } = req.body;
    if (!slug) return res.status(400).json(isDashboard(req) ? { error: 'slug é obrigatório' } : { success: false, message: 'slug é obrigatório.' });

    const market = await findMarket(String(slug));
    if (!market) return res.status(404).json(isDashboard(req) ? { error: 'Mercado não encontrado na Gamma API' } : { success: false, message: 'Mercado não encontrado na Gamma API.' });

    const yes = Number(market.outcomePrices?.[0]);
    const no = Number(market.outcomePrices?.[1]);
    const spreadPct = completenessSpreadPct({ yes, no });

    const strat = await (PredictionArbStrategy as any).create({
      userId,
      exchangeKeyId: exchangeKeyId || null,
      marketId: market.id,
      slug: market.slug,
      question: market.question,
      conditionId: market.conditionId,
      tokenIdYes: market.clobTokenIds?.[0],
      tokenIdNo: market.clobTokenIds?.[1],
      yesPrice: yes,
      noPrice: no,
      spreadPct,
      endDate: market.endDate ? new Date(market.endDate) : null,
      tradeSize: Number(tradeSize || 100),
      active: true,
      autoExecute: autoExecute === true,
      isAutoCreated: false,
    });

    if (isDashboard(req)) return res.status(201).json(strat);
    return res.status(201).json({ success: true, message: 'Estratégia criada.', data: formatStrategy(strat.toObject()) });
  } catch (e: any) {
    console.error('❌ [POST PredictionStrategy] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function updatePredictionStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const { id, strategyId } = req.body;
    const targetId = id || strategyId;
    if (!targetId) return res.status(400).json(isDashboard(req) ? { error: 'id é obrigatório' } : { success: false, message: 'id é obrigatório.' });

    const ALLOWED = ['tradeSize', 'active', 'autoExecute', 'targetProfitPct'];
    const updateData: any = {};
    for (const field of ALLOWED) {
      if (req.body[field] !== undefined) updateData[field] = req.body[field];
    }
    if (!Object.keys(updateData).length) return res.status(400).json(isDashboard(req) ? { error: 'Nenhum campo para atualizar' } : { success: false, message: 'Nenhum campo para atualizar.' });

    const strat = await (PredictionArbStrategy as any).findOneAndUpdate(
      { _id: targetId, userId },
      { $set: updateData },
      { new: true }
    ).lean();

    if (!strat) return res.status(404).json(isDashboard(req) ? { error: 'Estratégia não encontrada' } : { success: false, message: 'Estratégia não encontrada.' });

    if (isDashboard(req)) return res.json(strat);
    return res.json({ success: true, message: 'Estratégia atualizada.', data: formatStrategy(strat) });
  } catch (e: any) {
    console.error('❌ [PUT PredictionStrategy] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function deletePredictionStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const id = req.params.id || req.body.id || req.body.strategyId;
    if (!id) return res.status(400).json(isDashboard(req) ? { error: 'id é obrigatório' } : { success: false, message: 'id é obrigatório.' });

    const strat = await (PredictionArbStrategy as any).findOne({ _id: id, userId }).lean();
    if (!strat) return res.status(404).json(isDashboard(req) ? { error: 'Estratégia não encontrada' } : { success: false, message: 'Estratégia não encontrada.' });
    if (strat.positionOpen) return res.status(400).json(isDashboard(req) ? { error: 'Não é possível excluir com posição aberta' } : { success: false, message: 'Não é possível excluir com posição aberta.' });

    await (PredictionArbStrategy as any).deleteOne({ _id: id });
    if (isDashboard(req)) return res.json({ success: true });
    return res.json({ success: true, message: 'Estratégia removida.' });
  } catch (e: any) {
    console.error('❌ [DELETE PredictionStrategy] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function getPredictionTrades(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const trades = await (PredictionArbTrade as any).find({ userId })
      .sort({ createdAt: -1 })
      .limit(300)
      .populate({ path: 'strategyId', model: 'PredictionArbStrategy', select: 'slug question' })
      .lean();

    // Formata: expõe _id como id (o front usa id) e mantém os campos úteis
    const formatted = trades.map((t: any) => ({
      id: t._id.toString(),
      strategyId: t.strategyId?._id ? t.strategyId._id.toString() : (t.strategyId ? String(t.strategyId) : null),
      openTradeId: t.openTradeId ? String(t.openTradeId) : null,
      marketId: t.marketId ? String(t.marketId) : null,
      slug: t.slug || '',
      question: t.question || t.slug || '',
      type: t.type,
      status: t.status,
      side: t.side || 'YES',
      yesPrice: t.yesPrice ?? 0,
      noPrice: t.noPrice ?? 0,
      yesExitPrice: t.yesExitPrice ?? 0,
      noExitPrice: t.noExitPrice ?? 0,
      amount: t.amount ?? 0,
      yesShares: t.yesShares ?? 0,
      noShares: t.noShares ?? 0,
      pnl: t.pnl ?? 0,
      investedUsd: t.investedUsd ?? 0,
      realizedUsd: t.realizedUsd ?? 0,
      spreadPct: t.spreadPct ?? 0,
      reason: t.reason || '',
      orderIds: t.orderIds || [],
      createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : '',
    }));

    if (isDashboard(req)) return res.json(formatted);
    return res.json({ success: true, message: 'ok', data: formatted });
  } catch (e: any) {
    console.error('❌ [GET PredictionTrades] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function getPredictionTradesSummary(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const closes = await (PredictionArbTrade as any).find({ userId, type: 'close_pair', status: 'executed' }).lean();
    const opens = await (PredictionArbTrade as any).find({ userId, type: 'open_pair', status: { $in: ['executed', 'simulated'] } }).lean();

    const totalClosed = closes.length;
    const totalPnl = closes.reduce((acc: number, t: any) => acc + Number(t.pnl || 0), 0);
    const totalEntradaUsd = opens.reduce((acc: number, t: any) => acc + Number(t.amount || 0), 0);
    const monthlyPct = totalEntradaUsd > 0 ? Number(((totalPnl / totalEntradaUsd) * 100).toFixed(2)) : 0;
    const aprPct = Number((monthlyPct * 12).toFixed(2));

    const data = {
      operacoesEncerradas: totalClosed,
      totalPnl: Number(totalPnl.toFixed(2)),
      aprPct,
      monthlyPct,
      totalEntradaUsd: Number(totalEntradaUsd.toFixed(2)),
      totalSaidaUsd: Number((totalEntradaUsd + totalPnl).toFixed(2)),
    };

    if (isDashboard(req)) return res.json(data);
    return res.json({ success: true, message: 'ok', data });
  } catch (e: any) {
    console.error('❌ [GET PredictionTradesSummary] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export function isValidObjectId(id: any): boolean {
  return mongoose.Types.ObjectId.isValid(String(id || ''));
}
