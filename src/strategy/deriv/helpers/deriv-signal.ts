// Motor Quantitativo Ortogonal Deriv (Gatekeeper -> Vetor Direcional -> Micro-Imbalance)
// Sem colinearidade de indicadores: 3 camadas independentes e sequenciais.

export type Direction = 'CALL' | 'PUT';

export interface IndicatorSnapshot {
  er: number;
  r2: number;
  slope: number;
  imbalance: number;
  emaFast: number;
  emaSlow: number;
  latestPrice: number;
  // Campos mantidos para compatibilidade retroativa e logs informativos
  rsi?: number;
  stochK?: number;
  tickMomentumUp?: number;
  tickMomentumDown?: number;
  kaufmanER: number;
  hurstExponent?: number;
}

export interface SignalDecision {
  direction: Direction | null;
  confidence: number; // 0.0 a 1.0 (calibrada e normalizada)
  indicators: IndicatorSnapshot;
}

export class DerivSignalEngine {
  public static readonly WINDOW_REGIME = 40;
  public static readonly WINDOW_FAST = 9;
  public static readonly WINDOW_SLOW = 21;
  public static readonly WINDOW_MICRO = 10;

  // Kaufman Efficiency Ratio (ER)
  public static calculateER(prices: number[]): number {
    if (prices.length < 2) return 0;
    const n = prices.length - 1;
    const direction = Math.abs(prices[n] - prices[0]);
    let volatility = 0;

    for (let i = 1; i <= n; i++) {
      volatility += Math.abs(prices[i] - prices[i - 1]);
    }

    return volatility === 0 ? 0 : Number((direction / volatility).toFixed(3));
  }

  // Regressão Linear Simples OLS (Slope e R²)
  public static calculateOLS(prices: number[]): { slope: number; r2: number } {
    const n = prices.length;
    if (n < 2) return { slope: 0, r2: 0 };

    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    let sumYY = 0;

    for (let i = 0; i < n; i++) {
      const x = i;
      const y = prices[i];
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumXX += x * x;
      sumYY += y * y;
    }

    const denominator = n * sumXX - sumX * sumX;
    if (denominator === 0) return { slope: 0, r2: 0 };

    const slope = (n * sumXY - sumX * sumY) / denominator;

    // R² (Coeficiente de Determinação)
    const numeratorR = n * sumXY - sumX * sumY;
    const denomR = (n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY);
    const r2 = denomR <= 0 ? 0 : Math.pow(numeratorR / Math.sqrt(denomR), 2);

    return { slope, r2: Number(r2.toFixed(3)) };
  }

  // EMA Simples
  public static calculateEMA(prices: number[], period: number): number {
    if (prices.length === 0) return 0;
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    return Number(ema.toFixed(5));
  }

  // Tick Imbalance recente
  public static calculateImbalance(prices: number[]): number {
    const slice = prices.slice(-this.WINDOW_MICRO);
    let ups = 0;
    let downs = 0;

    for (let i = 1; i < slice.length; i++) {
      if (slice[i] > slice[i - 1]) ups++;
      else if (slice[i] < slice[i - 1]) downs++;
    }

    const total = ups + downs;
    return total === 0 ? 0 : Number(((ups - downs) / total).toFixed(3));
  }

  public static evaluate(prices: number[]): SignalDecision {
    const currentPrice = prices[prices.length - 1] || 0;

    if (prices.length < this.WINDOW_REGIME) {
      return {
        direction: null,
        confidence: 0,
        indicators: {
          er: 0,
          r2: 0,
          slope: 0,
          imbalance: 0,
          emaFast: 0,
          emaSlow: 0,
          latestPrice: currentPrice,
          kaufmanER: 0,
        },
      };
    }

    const regimePrices = prices.slice(-this.WINDOW_REGIME);

    const er = this.calculateER(regimePrices);
    const { slope, r2 } = this.calculateOLS(regimePrices);
    const emaFast = this.calculateEMA(prices, this.WINDOW_FAST);
    const emaSlow = this.calculateEMA(prices, this.WINDOW_SLOW);
    const imbalance = this.calculateImbalance(prices);

    const indicators: IndicatorSnapshot = {
      er,
      r2,
      slope,
      imbalance,
      emaFast,
      emaSlow,
      latestPrice: currentPrice,
      kaufmanER: er,
      tickMomentumUp: Math.max(0, imbalance),
      tickMomentumDown: Math.max(0, -imbalance),
    };

    // 1. Camada de Regime (Gatekeeper de Ruído vs Tendência)
    // 1.1. Filtro de Spike / Cauda Gorda: se a variação do último tick for > 3 * sigma_tick, rejeita choque de volatilidade
    const returns: number[] = [];
    for (let i = 1; i < regimePrices.length; i++) {
      returns.push(Math.abs(regimePrices[i] - regimePrices[i - 1]));
    }
    const meanReturn = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
    const varReturn = returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / (returns.length || 1);
    const sigmaTick = Math.sqrt(varReturn) || 0.01;
    const lastTickJump = Math.abs(prices[prices.length - 1] - prices[prices.length - 2]);

    if (lastTickJump > 3 * sigmaTick && sigmaTick > 0.001) {
      // Choque de volatilidade / Anomalia de tick
      return { direction: null, confidence: 0, indicators };
    }

    // 1.2. Gatekeeper: Aborta se for ruído estocástico (ER e R²)
    if (er < 0.28 || r2 < 0.35) {
      return { direction: null, confidence: 0, indicators };
    }

    // 2. Camada Direcional Macro (Ortogonal)
    const isBullish = currentPrice > emaFast && emaFast > emaSlow && slope > 0 && imbalance > 0;
    const isBearish = currentPrice < emaFast && emaFast < emaSlow && slope < 0 && imbalance < 0;

    if (!isBullish && !isBearish) {
      return { direction: null, confidence: 0, indicators };
    }

    // 3. Score de Confiança Calibrada (Ponderação Ortogonal)
    const erNorm = Math.min(1, er / 0.60); // Satura em 0.60
    const imbNorm = Math.abs(imbalance);
    const confidence = Number(((0.35 * erNorm) + (0.35 * r2) + (0.30 * imbNorm)).toFixed(2));

    return {
      direction: isBullish ? 'CALL' : 'PUT',
      confidence,
      indicators,
    };
  }
}

// Wrapper funcional para integração contínua
export function evaluateSignal(ticks: number[]): SignalDecision {
  return DerivSignalEngine.evaluate(ticks);
}

// Gestão de Sequência de Risco (Cooldown 180s após 3 perdas)
export function streakStakeMultiplier(consecutiveLosses: number): { multiplier: number; blocked: boolean } {
  if (consecutiveLosses >= 3) return { multiplier: 0.25, blocked: true };
  if (consecutiveLosses === 2) return { multiplier: 0.5, blocked: false };
  return { multiplier: 1, blocked: false };
}
