import DerivTrade from '../../models/DerivTrade';
import DerivStrategy from '../../models/DerivStrategy';
import FxProTrade from '../../models/FxProTrade';
import FxProStrategy from '../../models/FxProStrategy';
import IcMarketsTrade from '../../models/IcMarketsTrade';
import IcMarketsStrategy from '../../models/IcMarketsStrategy';

export interface AssetRegimeMetrics {
  symbol: string;
  totalTrades: number;
  recentTradesCount: number;
  recentPnl: number;
  winRatePct: number;
  peakCumulativePnl: number;
  currentCumulativePnl: number;
  drawdownFromPeak: number;
  slope: number;
  status: 'ASCENT' | 'STABLE' | 'DECLINE';
  shouldPause: boolean;
  reason: string;
}

/**
 * Avalia o regime de tendência e drawdown recente da curva de P/L de um ativo específico.
 */
export function evaluateAssetCurveRegime(
  symbol: string,
  trades: Array<{ pnl: number; timestamp: number }>,
  options: {
    minTradesToEvaluate?: number;
    maxDrawdownFromPeak?: number; // Ex: $10 de perda a partir do pico
    negativeSlopeThreshold?: number; // Ex: declínio constante
    recentWindowHours?: number;
  } = {}
): AssetRegimeMetrics {
  const minTrades = options.minTradesToEvaluate ?? 4;
  const maxDd = options.maxDrawdownFromPeak ?? 8.0;
  const windowHours = options.recentWindowHours ?? 12;

  const now = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;

  // Filtra e ordena
  const validTrades = trades
    .filter((t) => !isNaN(t.timestamp) && t.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  const totalTrades = validTrades.length;
  const recentTrades = validTrades.filter((t) => now - t.timestamp <= windowMs);
  const tradesToUse = recentTrades.length >= minTrades ? recentTrades : validTrades.slice(-10);

  if (tradesToUse.length < minTrades) {
    return {
      symbol,
      totalTrades,
      recentTradesCount: tradesToUse.length,
      recentPnl: tradesToUse.reduce((acc, t) => acc + t.pnl, 0),
      winRatePct: 50,
      peakCumulativePnl: 0,
      currentCumulativePnl: 0,
      drawdownFromPeak: 0,
      slope: 0,
      status: 'STABLE',
      shouldPause: false,
      reason: 'Amostra insuficiente de trades recentes para avaliar declínio',
    };
  }

  // Traça curva cumulativa
  let cum = 0;
  let peak = -Infinity;
  const cumCurve: number[] = [];
  let wins = 0;

  for (const t of tradesToUse) {
    cum += t.pnl;
    if (t.pnl > 0) wins++;
    if (cum > peak) peak = cum;
    cumCurve.push(cum);
  }

  const currentCum = cum;
  const drawdown = peak > -Infinity ? peak - currentCum : 0;
  const winRate = (wins / tradesToUse.length) * 100;
  const recentPnl = tradesToUse.reduce((acc, t) => acc + t.pnl, 0);

  // Regressão Linear simples da curva de P/L acumulada para obter o Slope (tendência)
  const n = cumCurve.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += cumCurve[i];
    sumXY += i * cumCurve[i];
    sumXX += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX || 1);

  let status: 'ASCENT' | 'STABLE' | 'DECLINE' = 'STABLE';
  let shouldPause = false;
  let reason = 'Desempenho estável dentro dos parâmetros.';

  // 1. Gatilho de declínio por Drawdown severo a partir do pico acumulado
  if (drawdown >= maxDd && recentPnl < 0) {
    status = 'DECLINE';
    shouldPause = true;
    reason = `Curva em declínio: Devolveu $${drawdown.toFixed(2)} do pico recente ($${peak.toFixed(2)} -> $${currentCum.toFixed(2)})`;
  }
  // 2. Gatilho de declínio por Slope negativo persistente e taxa de acerto baixa
  else if (slope < -0.35 && winRate < 35 && recentPnl < -maxDd * 0.6) {
    status = 'DECLINE';
    shouldPause = true;
    reason = `Tendência descendente acentuada (Slope: ${slope.toFixed(2)}, WinRate: ${winRate.toFixed(0)}%, PnL: $${recentPnl.toFixed(2)})`;
  }
  // 3. Ascensão clara
  else if (slope > 0.3 && winRate >= 55 && recentPnl > 0) {
    status = 'ASCENT';
    shouldPause = false;
    reason = `Em ascensão consistente (Slope: +${slope.toFixed(2)}, WinRate: ${winRate.toFixed(0)}%, PnL: +$${recentPnl.toFixed(2)})`;
  }

  return {
    symbol,
    totalTrades,
    recentTradesCount: tradesToUse.length,
    recentPnl,
    winRatePct: winRate,
    peakCumulativePnl: peak,
    currentCumulativePnl: currentCum,
    drawdownFromPeak: drawdown,
    slope,
    status,
    shouldPause,
    reason,
  };
}

/**
 * Dynamic Asset Allocator para DERIV: verifica todos os ativos e pausa/despausa estratégias
 */
export async function evaluateAndAllocateDerivAssets(userId: string): Promise<AssetRegimeMetrics[]> {
  const results: AssetRegimeMetrics[] = [];
  try {
    const executedTrades = await DerivTrade.find({
      userId,
      status: 'executed',
    })
      .sort({ closedAt: -1 })
      .limit(200)
      .lean();

    if (!executedTrades || executedTrades.length === 0) return results;

    // Agrupa por ativo
    const symbolMap = new Map<string, Array<{ pnl: number; timestamp: number }>>();
    for (const t of executedTrades) {
      const sym = t.symbol || 'OTHER';
      const arr = symbolMap.get(sym) || [];
      const ts = t.closedAt ? new Date(t.closedAt).getTime() : new Date(t.createdAt || 0).getTime();
      arr.push({ pnl: Number(t.pnl || 0), timestamp: ts });
      symbolMap.set(sym, arr);
    }

    for (const [sym, trades] of symbolMap.entries()) {
      const metrics = evaluateAssetCurveRegime(sym, trades, {
        minTradesToEvaluate: 4,
        maxDrawdownFromPeak: 8.0,
      });
      results.push(metrics);

      // Aplica ação na estratégia do usuário se existir
      if (metrics.shouldPause) {
        await DerivStrategy.updateOne(
          { userId, symbol: sym, active: true },
          {
            $set: {
              active: false,
              deactivationReason: metrics.reason,
            },
          }
        );
      }
    }
  } catch (err: any) {
    console.error(`[ALLOCATOR-DERIV] Erro na avaliação de ativos:`, err.message);
  }
  return results;
}

/**
 * Dynamic Asset Allocator para FXPRO cTrader
 */
export async function evaluateAndAllocateFxProAssets(userId: string): Promise<AssetRegimeMetrics[]> {
  const results: AssetRegimeMetrics[] = [];
  try {
    const executedTrades = await FxProTrade.find({
      userId,
      status: 'closed',
    })
      .sort({ closeTime: -1 })
      .limit(200)
      .lean();

    if (!executedTrades || executedTrades.length === 0) return results;

    const symbolMap = new Map<string, Array<{ pnl: number; timestamp: number }>>();
    for (const t of executedTrades) {
      const sym = t.symbol || 'OTHER';
      const arr = symbolMap.get(sym) || [];
      const ts = t.closeTime ? new Date(t.closeTime).getTime() : new Date(t.createdAt || 0).getTime();
      arr.push({ pnl: Number(t.pnlUsd || 0), timestamp: ts });
      symbolMap.set(sym, arr);
    }

    for (const [sym, trades] of symbolMap.entries()) {
      const metrics = evaluateAssetCurveRegime(sym, trades, {
        minTradesToEvaluate: 3,
        maxDrawdownFromPeak: 15.0,
      });
      results.push(metrics);

      if (metrics.shouldPause) {
        await FxProStrategy.updateOne(
          { userId, symbol: sym, active: true },
          {
            $set: {
              active: false,
              status: 'paused',
              deactivationReason: metrics.reason,
            },
          }
        );
      }
    }
  } catch (err: any) {
    console.error(`[ALLOCATOR-FXPRO] Erro na avaliação de ativos:`, err.message);
  }
  return results;
}

/**
 * Dynamic Asset Allocator para IC MARKETS cTrader
 */
export async function evaluateAndAllocateIcMarketsAssets(userId: string): Promise<AssetRegimeMetrics[]> {
  const results: AssetRegimeMetrics[] = [];
  try {
    const executedTrades = await IcMarketsTrade.find({
      userId,
      status: 'closed',
    })
      .sort({ closeTime: -1 })
      .limit(200)
      .lean();

    if (!executedTrades || executedTrades.length === 0) return results;

    const symbolMap = new Map<string, Array<{ pnl: number; timestamp: number }>>();
    for (const t of executedTrades) {
      const sym = t.symbol || 'OTHER';
      const arr = symbolMap.get(sym) || [];
      const ts = t.closeTime ? new Date(t.closeTime).getTime() : new Date(t.createdAt || 0).getTime();
      arr.push({ pnl: Number(t.pnlUsd || 0), timestamp: ts });
      symbolMap.set(sym, arr);
    }

    for (const [sym, trades] of symbolMap.entries()) {
      const metrics = evaluateAssetCurveRegime(sym, trades, {
        minTradesToEvaluate: 3,
        maxDrawdownFromPeak: 15.0,
      });
      results.push(metrics);

      if (metrics.shouldPause) {
        await IcMarketsStrategy.updateOne(
          { userId, symbol: sym, active: true },
          {
            $set: {
              active: false,
              status: 'paused',
              deactivationReason: metrics.reason,
            },
          }
        );
      }
    }
  } catch (err: any) {
    console.error(`[ALLOCATOR-ICMARKETS] Erro na avaliação de ativos:`, err.message);
  }
  return results;
}
