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
 * Determina o PipSize e tamanho de tick adequado para cada classe de ativo da FxPro / cTrader.
 * - Cryptos (BTC, ETH, etc.): 1.0 (ou 0.01 se XRP/DOGE/ADA)
 * - Índices (US30, NAS100, GER40, etc.): 1.0 ou 0.1
 * - Metais (XAUUSD / Ouro): 0.1, XAGUSD: 0.01
 * - Petróleo / Commodities (USOIL, UKOIL): 0.01
 * - Forex JPY Crosses (USDJPY, EURJPY, GBPJPY, AUDJPY, CADJPY, etc.): 0.01
 * - Forex Standard Majors / Minors (EURUSD, EURGBP, AUDCAD, etc.): 0.0001
 */
export function getFxProSymbolPipSize(symbol: string): number {
  const sym = (symbol || '').replace('/', '').toUpperCase();
  if (sym.startsWith('BTC') || sym.startsWith('ETH')) {
    return 1.0;
  }
  if (sym.includes('XRP') || sym.includes('DOGE') || sym.includes('ADA') || sym.includes('SOL') || sym.includes('LTC')) {
    return 0.01;
  }
  if (sym.includes('US30') || sym.includes('NAS100') || sym.includes('US500') || sym.includes('GER40') || sym.includes('UK100') || sym.includes('JP225')) {
    return 1.0;
  }
  if (sym.includes('XAU') || sym.includes('GOLD')) {
    return 0.1;
  }
  if (sym.includes('XAG') || sym.includes('SILVER') || sym.includes('USOIL') || sym.includes('UKOIL')) {
    return 0.01;
  }
  if (sym.includes('JPY')) {
    return 0.01;
  }
  return 0.0001;
}

/**
 * Retorna o número de casas decimais para formatação de preços por símbolo.
 */
export function getFxProPriceDecimals(symbol: string): number {
  const pip = getFxProSymbolPipSize(symbol);
  if (pip >= 1.0) return 2;
  if (pip >= 0.1) return 2;
  if (pip >= 0.01) return 3;
  return 5;
}

/**
 * Calcula ATR em Pips para Forex/Metais/Índices/Cryptos.
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
/**
 * Calcula EMA (Exponential Moving Average) para uma série de preços.
 */
export function calculateEMA(prices: number[], period: number): number {
  if (!prices || prices.length === 0) return 0;
  if (prices.length < period) {
    return prices.reduce((a, b) => a + b, 0) / prices.length;
  }
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Determina direção de tendência com confluência de EMA 9 / EMA 21 e Slope de Tendência.
 */
export function determineFxProTrendDirection(prices: number[]): { side: 'BUY' | 'SELL'; strength: number; isStrong: boolean } {
  if (!prices || prices.length < 10) {
    return { side: 'BUY', strength: 0.5, isStrong: false };
  }
  const emaFast = calculateEMA(prices, 9);
  const emaSlow = calculateEMA(prices, 21);
  const lastPrice = prices[prices.length - 1];
  const midPoint = prices[Math.floor(prices.length / 2)];

  const isEmaBullish = emaFast > emaSlow;
  const isPriceAboveEma = lastPrice > emaFast;
  const isRecentSlopeUp = lastPrice > midPoint;

  let score = 0;
  if (isEmaBullish) score += 1;
  if (isPriceAboveEma) score += 1;
  if (isRecentSlopeUp) score += 1;

  const side: 'BUY' | 'SELL' = score >= 2 ? 'BUY' : 'SELL';
  const strength = score === 3 || score === 0 ? 0.9 : 0.6;
  const isStrong = score === 3 || score === 0;

  return { side, strength, isStrong };
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
  maxLot = 0.10
): number {
  const configuredLot = minLot || 0.01;
  // Limita o lote máximo conservadoramente ao lote configurado na estratégia
  const lotCeiling = Math.min(maxLot, Math.max(configuredLot, 0.10));
  const b = Math.max(0.5, riskRewardRatio);
  const p = Math.min(0.95, Math.max(0.05, winProb));
  const q = 1 - p;
  const kellyPct = Math.max(0, (b * p - q) / b);
  const adjustedPct = kellyPct * fraction; // Fractional Kelly

  const riskAmount = balanceUsd * Math.max(0.005, Math.min(0.02, adjustedPct));
  const rawLot = (riskAmount * leverage) / 100000;
  const finalLot = Math.min(lotCeiling, Math.max(configuredLot, Number(rawLot.toFixed(2))));
  return finalLot;
}
