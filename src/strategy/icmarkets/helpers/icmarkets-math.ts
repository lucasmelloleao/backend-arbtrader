// Módulo Matemático e Estatístico para o Robô IC Markets cTrader (ic.com)
// Implementa: Kaufman ER, Lo-MacKinlay Variance Ratio, ATR Pips, Expected Value e Fractional Kelly

export interface IcMarketsQuantGatesResult {
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
export function calculateIcMarketsKaufmanER(prices: number[]): number {
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
export function calculateIcMarketsVarianceRatio(prices: number[], k = 4): number {
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
export function calculateIcMarketsATR(candles: { high: number; low: number; close: number }[], period = 14, pipSize = 0.0001): number {
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
export function evaluateIcMarketsQuantGates(
  prices: number[],
  spreadPips: number,
  maxSpread = 2.5,
  minEr = 0.35,
  minVr = 1.08,
  atrPips = 15.0
): IcMarketsQuantGatesResult {
  const er = calculateIcMarketsKaufmanER(prices);
  const varianceRatio = calculateIcMarketsVarianceRatio(prices);

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
      reason: `Gate 1 Rejeitado: Mercado em Random Walk (VR: ${varianceRatio.toFixed(3)} < ${minVr}). Sem momentum direcional suficiente.`,
    };
  }

  if (er < minEr) {
    return {
      gatesPassed: false,
      er,
      varianceRatio,
      atrPips,
      spreadPips,
      reason: `Gate 2 Rejeitado: Eficiência de tendência insuficiente (ER: ${er.toFixed(3)} < ${minEr}). Alto ruído intraminuto.`,
    };
  }

  return {
    gatesPassed: true,
    er,
    varianceRatio,
    atrPips,
    spreadPips,
    reason: `Gates 1, 2 e 3 Aprovados: VR=${varianceRatio.toFixed(3)}, ER=${er.toFixed(3)}, Spread=${spreadPips.toFixed(1)} pips.`,
  };
}

/**
 * Dimensionamento de Lote via Critério de Kelly Fracionário (Half Kelly)
 */
export function calculateIcMarketsKellyLot(
  balanceUsd: number,
  winProb: number,
  rewardRiskRatio = 1.33,
  fraction = 0.5,
  maxRiskPct = 0.02
): number {
  if (winProb <= 0.5) return 0.01;
  const p = winProb;
  const q = 1 - p;
  const b = rewardRiskRatio;
  const kellyPct = (p * b - q) / b;
  const effectiveRisk = Math.min(Math.max(0, kellyPct * fraction), maxRiskPct);
  const riskUsd = balanceUsd * effectiveRisk;
  const lot = Math.max(0.01, Number(((riskUsd / 200) * 0.01).toFixed(2)));
  return Math.min(lot, 5.0);
}
