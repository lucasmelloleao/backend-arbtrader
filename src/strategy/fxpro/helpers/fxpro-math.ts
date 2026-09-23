// Módulo Matemático e Estatístico para o Robô FxPro cTrader
// Implementa: Kaufman ER, Lo-MacKinlay Variance Ratio, ATR Pips, Expected Value e Fractional Kelly

export interface FxProQuantGatesResult {
  gatesPassed: boolean;
  er: number;
  varianceRatio: number;
  atrPips: number;
  spreadPips: number;
  reason: string;
}

/**
 * Kaufman Efficiency Ratio (ER): Mede o ruído do preço vs tendência direcional.
 * ER = |Preço_Atual - Preço_N_atrás| / Soma(|Preço_t - Preço_t-1|)
 * Retorna valor entre 0 (puro ruído) e 1.0 (tendência perfeita sem oscilação).
 */
export function calculateFxProKaufmanER(prices: number[]): number {
  if (!prices || prices.length < 10) return 0;
  const n = prices.length - 1;
  const direction = Math.abs(prices[n] - prices[0]);
  let volatility = 0;
  for (let i = 1; i < prices.length; i++) {
    volatility += Math.abs(prices[i] - prices[i - 1]);
  }
  if (volatility === 0) return 0;
  return Number((direction / volatility).toFixed(3));
}

/**
 * Lo-MacKinlay Variance Ratio Test: Detecta se o par Forex está em Random Walk (passeio aleatório).
 * VR = Var(retornos k-períodos) / (k × Var(retornos 1-período))
 * Se VR ~ 1.0 -> Random Walk (Sem inércia)
 * Se VR > 1.08 -> Momentum/Persistência Direcional
 * Se VR < 0.90 -> Reversão à Média
 */
export function calculateFxProVarianceRatio(prices: number[], k = 4): number {
  if (!prices || prices.length < k * 4) return 1.0;
  const returns1: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns1.push(Math.log(prices[i] / prices[i - 1]));
  }
  const mean1 = returns1.reduce((a, b) => a + b, 0) / returns1.length;
  const var1 = returns1.reduce((a, b) => a + Math.pow(b - mean1, 2), 0) / (returns1.length - 1);

  const returnsK: number[] = [];
  for (let i = k; i < prices.length; i += k) {
    returnsK.push(Math.log(prices[i] / prices[i - k]));
  }
  if (returnsK.length < 2 || var1 === 0) return 1.0;
  const meanK = returnsK.reduce((a, b) => a + b, 0) / returnsK.length;
  const varK = returnsK.reduce((a, b) => a + Math.pow(b - meanK, 2), 0) / (returnsK.length - 1);

  const vr = varK / (k * var1);
  return Number(vr.toFixed(3));
}

/**
 * Calcula ATR em Pips para Forex/Metais.
 */
export function calculateFxProATR(candles: { high: number; low: number; close: number }[], period = 14, pipSize = 0.0001): number {
  if (!candles || candles.length < period) return 10.0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    trs.push(Math.max(hl, hc, lc));
  }
  const recent = trs.slice(-period);
  const avgTr = recent.reduce((a, b) => a + b, 0) / recent.length;
  return Number((avgTr / pipSize).toFixed(1));
}

/**
 * Avalia se o par Forex atende aos Gates 1, 2 e 3 de Entrada.
 */
export function evaluateFxProQuantGates(
  prices: number[],
  spreadPips: number,
  maxSpread = 2.5,
  minEr = 0.35,
  minVr = 1.08,
  atrPips = 15.0
): FxProQuantGatesResult {
  const er = calculateFxProKaufmanER(prices);
  const varianceRatio = calculateFxProVarianceRatio(prices);

  if (spreadPips > maxSpread) {
    return {
      gatesPassed: false,
      er,
      varianceRatio,
      atrPips,
      spreadPips,
      reason: `Gate 3 Rejeitado: Spread alargado (${spreadPips.toFixed(1)} pips > máx ${maxSpread.toFixed(1)} pips).`,
    };
  }

  if (varianceRatio < minVr) {
    return {
      gatesPassed: false,
      er,
      varianceRatio,
      atrPips,
      spreadPips,
      reason: `Gate 1 Rejeitado: Random Walk detectado (VR: ${varianceRatio} < ${minVr}). Sem persistência estatística.`,
    };
  }

  if (er < minEr) {
    return {
      gatesPassed: false,
      er,
      varianceRatio,
      atrPips,
      spreadPips,
      reason: `Gate 2 Rejeitado: Kaufman ER fraco (${er} < ${minEr}). Mercado em consolidação ruidosa.`,
    };
  }

  return {
    gatesPassed: true,
    er,
    varianceRatio,
    atrPips,
    spreadPips,
    reason: `Gates 1, 2 e 3 Aprovados: Tendência direcional consistente (ER: ${er} | VR: ${varianceRatio} | Spread: ${spreadPips.toFixed(1)} pips).`,
  };
}

/**
 * Dimensionamento de Lote por Fractional Kelly para Forex / CFD.
 */
export function calculateFxProKellyLot(
  balanceUsd: number,
  leverage: number,
  winProb: number,
  riskRewardRatio = 1.5,
  fraction = 0.25,
  minLot = 0.01,
  maxLot = 5.0
): number {
  const b = Math.max(0.5, riskRewardRatio);
  const p = Math.min(0.95, Math.max(0.05, winProb));
  const q = 1 - p;
  const kellyPct = Math.max(0, (b * p - q) / b);
  const adjustedPct = kellyPct * fraction; // Fractional Kelly

  // Cada 0.01 lote padrão Forex (1.000 unidades) requer margem = 1000 / leverage
  const riskAmount = balanceUsd * Math.max(0.01, Math.min(0.05, adjustedPct));
  const rawLot = (riskAmount * leverage) / 100000;
  const finalLot = Math.min(maxLot, Math.max(minLot, Number(rawLot.toFixed(2))));
  return finalLot;
}
