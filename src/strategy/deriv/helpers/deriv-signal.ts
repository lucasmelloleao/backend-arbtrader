// Lógica pura de sinal da estratégia Deriv — separada do bot para ser testável.
// Sem dependência de banco/WebSocket: recebe ticks e devolve direção + confiança.

export type Direction = 'CALL' | 'PUT';

export interface IndicatorSnapshot {
  emaFast: number;
  emaSlow: number;
  emaTrend: number;
  donchianHigh: number;
  donchianLow: number;
  donchianMid: number;
  rsi: number;
  stochK: number;
  tickMomentumUp: number;
  tickMomentumDown: number;
  latestPrice: number;
  avgAbsReturn: number;
}

export interface SignalDecision {
  direction: Direction | null;
  confidence: number; // 0..1 — força da confluência
  indicators: IndicatorSnapshot;
}

// Filtro de volatilidade: retorno absoluto médio por tick abaixo disso indica mercado morto/sem liquidez.
export const MIN_AVG_ABS_RETURN = 0.00003;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

export function calcEma(data: number[], period: number): number {
  if (data.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

// RSI com suavização de Wilder (mais estável que a média simples anterior).
export function calcRsi(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function computeIndicators(ticks: number[]): IndicatorSnapshot {
  const latestPrice = ticks[ticks.length - 1];

  const emaFast = calcEma(ticks, 9);
  const emaSlow = calcEma(ticks, 21);
  const emaTrend = calcEma(ticks, 34);

  const donchianSlice = ticks.slice(-20, -1);
  const donchianHigh = Math.max(...donchianSlice);
  const donchianLow = Math.min(...donchianSlice);
  const donchianMid = (donchianHigh + donchianLow) / 2;

  const rsi = calcRsi(ticks, 14);

  const stochPeriod = 14;
  const stochSlice = ticks.slice(-stochPeriod);
  const highestHigh = Math.max(...stochSlice);
  const lowestLow = Math.min(...stochSlice);
  const range = highestHigh - lowestLow || 0.0001;
  const stochK = ((latestPrice - lowestLow) / range) * 100;

  const last15 = ticks.slice(-15);
  let upTicks = 0;
  let downTicks = 0;
  for (let i = 1; i < last15.length; i++) {
    if (last15[i] > last15[i - 1]) upTicks++;
    else if (last15[i] < last15[i - 1]) downTicks++;
  }
  const denom = last15.length - 1 || 1;
  const tickMomentumUp = upTicks / denom;
  const tickMomentumDown = downTicks / denom;

  let absReturnSum = 0;
  for (let i = 1; i < ticks.length; i++) {
    absReturnSum += Math.abs(ticks[i] / ticks[i - 1] - 1);
  }
  const avgAbsReturn = ticks.length > 1 ? absReturnSum / (ticks.length - 1) : 0;

  return {
    emaFast,
    emaSlow,
    emaTrend,
    donchianHigh,
    donchianLow,
    donchianMid,
    rsi,
    stochK,
    tickMomentumUp,
    tickMomentumDown,
    latestPrice,
    avgAbsReturn,
  };
}

function callConfidence(ind: IndicatorSnapshot): number {
  const volNorm = Math.max(ind.avgAbsReturn * 10, 0.0005);
  const trendScore = clamp((ind.emaFast - ind.emaSlow) / (Math.abs(ind.emaSlow) || 1) / volNorm, 0, 1);
  const rsiScore = clamp((ind.rsi - 50) / 25, 0, 1);
  const stochScore = clamp((ind.stochK - 50) / 40, 0, 1);
  const momentumScore = clamp((ind.tickMomentumUp - 0.5) / 0.4, 0, 1);
  // Base de 0.70 para sinal válido + até 0.29 de bônus por confluência forte
  const rawConfidence = 0.70 + (0.09 * trendScore + 0.07 * rsiScore + 0.06 * stochScore + 0.07 * momentumScore);
  return round3(clamp(rawConfidence, 0.70, 0.99));
}

function putConfidence(ind: IndicatorSnapshot): number {
  const volNorm = Math.max(ind.avgAbsReturn * 10, 0.0005);
  const trendScore = clamp((ind.emaSlow - ind.emaFast) / (Math.abs(ind.emaSlow) || 1) / volNorm, 0, 1);
  const rsiScore = clamp((50 - ind.rsi) / 25, 0, 1);
  const stochScore = clamp((50 - ind.stochK) / 40, 0, 1);
  const momentumScore = clamp((ind.tickMomentumDown - 0.5) / 0.4, 0, 1);
  // Base de 0.70 para sinal válido + até 0.29 de bônus por confluência forte
  const rawConfidence = 0.70 + (0.09 * trendScore + 0.07 * rsiScore + 0.06 * stochScore + 0.07 * momentumScore);
  return round3(clamp(rawConfidence, 0.70, 0.99));
}

// Decide a direção por confluência de EMA 9/21/34, canal de Donchian, RSI, Estocástico e momentum.
export function evaluateSignal(ticks: number[]): SignalDecision {
  const ind = computeIndicators(ticks);
  const latest = ind.latestPrice;
  const last15First = ticks[Math.max(0, ticks.length - 15)];
  const priceSlopeUp = latest >= last15First;
  const priceSlopeDown = latest <= last15First;

  let direction: Direction | null = null;
  let confidence = 0;

  if (
    latest > ind.emaFast &&
    ind.emaFast >= ind.emaSlow &&
    latest >= ind.donchianMid &&
    priceSlopeUp &&
    ind.rsi >= 50 &&
    ind.rsi <= 80 &&
    ind.stochK >= 45 &&
    ind.tickMomentumUp >= 0.55
  ) {
    direction = 'CALL';
    confidence = callConfidence(ind);
  } else if (
    latest < ind.emaFast &&
    ind.emaFast <= ind.emaSlow &&
    latest <= ind.donchianMid &&
    priceSlopeDown &&
    ind.rsi <= 50 &&
    ind.rsi >= 20 &&
    ind.stochK <= 55 &&
    ind.tickMomentumDown >= 0.55
  ) {
    direction = 'PUT';
    confidence = putConfidence(ind);
  }

  return { direction, confidence, indicators: ind };
}

// Anti-martingale: reduz o stake após perdas consecutivas e pausa após 5.
export function streakStakeMultiplier(consecutiveLosses: number): { multiplier: number; blocked: boolean } {
  if (consecutiveLosses >= 5) return { multiplier: 0, blocked: true };
  if (consecutiveLosses >= 3) return { multiplier: 0.25, blocked: false };
  if (consecutiveLosses === 2) return { multiplier: 0.5, blocked: false };
  return { multiplier: 1, blocked: false };
}
