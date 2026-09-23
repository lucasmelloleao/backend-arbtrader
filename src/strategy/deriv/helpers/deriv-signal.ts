// Motor Quantitativo Ortogonal Deriv com CUSUM, Teste de Razão de Variância (Lo-MacKinlay) e Spike Filter

export type Direction = 'CALL' | 'PUT';

export interface IndicatorSnapshot {
  er: number;
  r2: number;
  slope: number;
  imbalance: number;
  emaFast: number;
  emaSlow: number;
  latestPrice: number;
  varianceRatio: number; // Lo-MacKinlay Variance Ratio (q=10)
  cusumExceeded: boolean; // Alerta de quebra estrutural CUSUM
  regimeScore: number; // Score de qualidade para Asset Rotation (ER * 0.5 + R2 * 0.5)
  // Campos mantidos para logs informativos e compatibilidade
  rsi?: number;
  stochK?: number;
  tickMomentumUp?: number;
  tickMomentumDown?: number;
  kaufmanER: number;
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
  public static readonly WINDOW_CUSUM = 80;

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

  /**
   * Teste de Razão de Variância (Lo-MacKinlay) com q = 10 ticks
   * VR = Var(retornos agregados em q) / (q * Var(retorno 1 tick))
   * VR > 1.10 -> Persistência de Tendência (Efeito Manada)
   * VR ≈ 1.00 -> Random Walk Puro (Passeio Aleatório / Cassino)
   * VR < 0.90 -> Reversão à Média Ruidosa
   */
  public static calculateVarianceRatio(prices: number[], q = 10): number {
    if (prices.length < q * 3) return 1.0;

    // 1-period returns
    const r1: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      r1.push(prices[i] - prices[i - 1]);
    }
    const mean1 = r1.reduce((a, b) => a + b, 0) / r1.length;
    const var1 = r1.reduce((a, b) => a + Math.pow(b - mean1, 2), 0) / (r1.length - 1 || 1);
    if (var1 === 0) return 1.0;

    // q-period returns
    const rq: number[] = [];
    for (let i = q; i < prices.length; i++) {
      rq.push(prices[i] - prices[i - q]);
    }
    const meanQ = rq.reduce((a, b) => a + b, 0) / rq.length;
    const varQ = rq.reduce((a, b) => a + Math.pow(b - meanQ, 2), 0) / (rq.length - 1 || 1);

    const vr = varQ / (q * var1);
    return Number(vr.toFixed(3));
  }

  /**
   * Filtro CUSUM (Cumulative Sum) para detecção de quebra estrutural / choque de regime
   * Acumula desvios normalizados em relação à média recente.
   * Dispara se a soma acumulada positiva ou negativa exceder o limiar h = 4.5 sigmas.
   */
  public static checkCusumAnomaly(prices: number[]): boolean {
    if (prices.length < 30) return false;
    const slice = prices.slice(-Math.min(prices.length, this.WINDOW_CUSUM));
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / slice.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return false;

    // Constante de tolerância k e limiar de decisão h
    const k = 0.5 * stdDev;
    const h = 4.5 * stdDev;

    let sPos = 0;
    let sNeg = 0;

    for (let i = 0; i < slice.length; i++) {
      const diff = slice[i] - mean;
      sPos = Math.max(0, sPos + diff - k);
      sNeg = Math.max(0, sNeg - diff - k);

      if (sPos > h || sNeg > h) {
        return true; // Quebra estrutural detectada
      }
    }
    return false;
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
          varianceRatio: 1.0,
          cusumExceeded: false,
          regimeScore: 0,
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
    const varianceRatio = this.calculateVarianceRatio(prices, 10);
    const cusumExceeded = this.checkCusumAnomaly(prices);
    const regimeScore = Number(((er * 0.5) + (r2 * 0.5)).toFixed(3));

    const indicators: IndicatorSnapshot = {
      er,
      r2,
      slope,
      imbalance,
      emaFast,
      emaSlow,
      latestPrice: currentPrice,
      varianceRatio,
      cusumExceeded,
      regimeScore,
      kaufmanER: er,
      tickMomentumUp: Math.max(0, imbalance),
      tickMomentumDown: Math.max(0, -imbalance),
    };

    // 1. Camada de Regime (Gatekeeper de Ruído vs Tendência)
    // 1.1. Filtro de Spike / Cauda Gorda (> 3 sigmas)
    const returns: number[] = [];
    for (let i = 1; i < regimePrices.length; i++) {
      returns.push(Math.abs(regimePrices[i] - regimePrices[i - 1]));
    }
    const meanReturn = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
    const varReturn = returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / (returns.length || 1);
    const sigmaTick = Math.sqrt(varReturn) || 0.01;
    const lastTickJump = Math.abs(prices[prices.length - 1] - prices[prices.length - 2]);

    if (lastTickJump > 3 * sigmaTick && sigmaTick > 0.001) {
      return { direction: null, confidence: 0, indicators };
    }

    // 1.2. Filtro CUSUM (Quebra Estrutural / Mudança Brusca)
    if (cusumExceeded) {
      return { direction: null, confidence: 0, indicators };
    }

    // 1.3. Teste de Razão de Variância (Lo-MacKinlay): Rejeita Random Walk Puro (VR < 1.08)
    if (varianceRatio < 1.08) {
      return { direction: null, confidence: 0, indicators };
    }

    // 1.4. Gatekeeper Clássico de Regime: ER e R²
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
