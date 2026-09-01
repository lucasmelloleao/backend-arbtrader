import { Response } from 'express';
import Redis from 'ioredis';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import PredictionArbStrategy from '../models/PredictionArbStrategy';
import PredictionArbTrade from '../models/PredictionArbTrade';
import { closeStrategy } from '../strategy/prediction-arb/prediction-close';
import { executeStrategy } from '../strategy/prediction-arb/prediction-executor';
import { runScan } from '../strategy/prediction-arb/prediction-scanner';
import { isPredictionLiveAllowed } from '../strategy/prediction-arb/prediction-live';
import PredictionArbSettings from '../models/PredictionArbSettings';
import { isValidObjectId } from './predictionArbController';

const isDashboard = (req: AuthenticatedRequest) => req.path.includes('/auth/');

function getRedis(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const r = new Redis(url);
    r.on('error', () => {});
    return r;
  } catch {
    return null;
  }
}

export async function closePredictionStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const { strategyId, id } = req.body;
    const targetId = strategyId || id;
    if (!targetId) return res.status(400).json(isDashboard(req) ? { error: 'strategyId é obrigatório' } : { success: false, message: 'strategyId é obrigatório.' });

    const strat = await (PredictionArbStrategy as any).findOne({ _id: targetId, userId }).lean();
    if (!strat) return res.status(404).json(isDashboard(req) ? { error: 'Estratégia não encontrada' } : { success: false, message: 'Estratégia não encontrada.' });

    let redisPublished = false;
    const redis = getRedis();
    if (redis) {
      try {
        await redis.publish('prediction-arb-control', JSON.stringify({ action: 'CLOSE_STRATEGY', strategyId: String(strat._id) }));
        redisPublished = true;
      } catch {
        redisPublished = false;
      }
    }

    const msg = redisPublished
      ? `Fechamento de [${strat.slug}] acionado — o robô está executando as ordens.`
      : 'Atenção: Redis indisponível. Executando fechamento direto.';

    if (!redisPublished) {
      const result = await closeStrategy(String(strat._id), { dryRun: !(await isPredictionLiveAllowed()), reason: 'Comando Manual' });
      if (isDashboard(req)) return res.json({ success: true, message: msg, data: result });
      return res.json({ success: true, message: msg, data: result });
    }

    if (isDashboard(req)) return res.json({ success: true, message: msg });
    return res.json({ success: true, message: msg });
  } catch (e: any) {
    console.error('❌ [closePredictionStrategy] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function increasePredictionStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const { strategyId, id, amount } = req.body;
    const targetId = strategyId || id;
    const increaseAmount = Number(amount);
    if (!targetId || isNaN(increaseAmount) || increaseAmount <= 0) {
      return res.status(400).json(isDashboard(req) ? { error: 'strategyId e amount (> 0) são obrigatórios' } : { success: false, message: 'strategyId e amount (> 0) são obrigatórios.' });
    }

    const strat = await (PredictionArbStrategy as any).findOne({ _id: targetId, userId }).lean();
    if (!strat) return res.status(404).json(isDashboard(req) ? { error: 'Estratégia não encontrada' } : { success: false, message: 'Estratégia não encontrada.' });

    await (PredictionArbStrategy as any).findByIdAndUpdate(strat._id, {
      tradeSize: Number(strat.tradeSize || 0) + increaseAmount,
    });

    if (isDashboard(req)) return res.json({ success: true, message: 'Aporte aumentado.' });
    return res.json({ success: true, message: 'Aporte aumentado.', data: { tradeSize: Number(strat.tradeSize || 0) + increaseAmount } });
  } catch (e: any) {
    console.error('❌ [increasePredictionStrategy] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function voidClosePredictionStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const { strategyId, id } = req.body;
    const targetId = strategyId || id;
    if (!targetId) return res.status(400).json(isDashboard(req) ? { error: 'strategyId é obrigatório' } : { success: false, message: 'strategyId é obrigatório.' });

    const strat = await (PredictionArbStrategy as any).findOne({ _id: targetId, userId }).lean();
    if (!strat) return res.status(404).json(isDashboard(req) ? { error: 'Estratégia não encontrada' } : { success: false, message: 'Estratégia não encontrada.' });

    await PredictionArbTrade.create({
      userId,
      strategyId: strat._id,
      slug: strat.slug,
      question: strat.question,
      type: 'voided',
      status: 'voided',
      amount: strat.positionSize,
      pnl: 0,
      reason: 'Posição encerrada pela corretora (sem PnL)',
    });

    await (PredictionArbStrategy as any).findByIdAndUpdate(strat._id, {
      positionOpen: false,
      positionSize: 0,
      yesShares: 0,
      noShares: 0,
      avgYesPrice: 0,
      avgNoPrice: 0,
      active: false,
    });

    const msg = `Posição [${strat.slug}] marcada como encerrada pela corretora (sem PnL).`;
    if (isDashboard(req)) return res.json({ success: true, message: msg });
    return res.json({ success: true, message: msg });
  } catch (e: any) {
    console.error('❌ [voidClosePredictionStrategy] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function manualScanPrediction(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const settings = await (PredictionArbSettings as any).findOne({ userId }).lean()
      || await (PredictionArbSettings as any).findOne().lean();

    const config = {
      minSpreadPct: Number(settings?.minSpreadPct ?? 0.5),
      minVolume24hUSD: Number(settings?.minVolume24hUSD ?? 10000),
      maxStrategiesPerScan: Number(settings?.maxStrategiesPerScan ?? 5),
      tradeSize: Number(settings?.tradeSize ?? 100),
      allowedMarkets: settings?.allowedMarkets || [],
      marketFilter: settings?.marketFilter || '',
      marketCoins: settings?.marketCoins || [],
    };

    const result = await runScan(userId, config, await isPredictionLiveAllowed());
    const data = { scanned: result.scanned, created: result.created, updated: result.updated };

    if (isDashboard(req)) return res.json(data);
    return res.json({ success: true, message: 'Scan manual concluído.', data });
  } catch (e: any) {
    console.error('❌ [manualScanPrediction] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export { isValidObjectId };
