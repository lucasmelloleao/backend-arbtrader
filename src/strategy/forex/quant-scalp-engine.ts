// Módulo de Matemática Financeira e Microestrutura Quantitativa para Scalping Forex HFT
// Implementa os três pilares institucionais:
// 1. Modelagem de Fricção e Microestrutura (Spread, Comissão, Slippage, Coverage Factor k, OBI e Micro-Price)
// 2. Estatística e Séries Temporais (Log-returns, Autocorrelação rho_1, Z-score dinâmico em ticks, Volatilidade realizada)
// 3. Risco e Assimetria (Expectativa Matemática E, Kelly Fracionário)

export interface QuantMarketData {
  symbol: string;
  bid: number;
  ask: number;
  volumeBid?: number;
  volumeAsk?: number;
  commissionPerLotUsd?: number; // ex: $6 por lote ida e volta
  estimatedSlippagePips?: number;
}

export interface FrictionMetrics {
  spreadPips: number;
  spreadCostUsd: number;
  totalFrictionCostUsd: number;
  coverageRatio: number; // DeltaP / FrictionCost
  isViable: boolean;
}

export interface MicroPriceResult {
  obi: number; // Order Book Imbalance [-1, 1]
  microPrice: number;
  midPrice: number;
}

export interface StatisticalRegime {
  logReturns: number[];
  autocorrelationRho1: number;
  regime: 'MEAN_REVERSION' | 'MOMENTUM' | 'NEUTRAL';
  zScore: number;
  realizedVolatility: number;
}

/**
 * 1. MODELAGEM DE FRICÇÃO E MICROESTRUTURA
 * C_t = Spread_t + 2 * Comissão + Slippage Estimado
 * Critério: Delta P >= k * C_t (típico k >= 2.5)
 */
export function calculateFrictionCost(
  bid: number,
  ask: number,
  expectedTargetPips: number,
  pipSize: number = 0.0001,
  lotSizeUnits: number = 100000,
  commissionUsdPerLot: number = 6.0,
  estimatedSlippagePips: number = 0.2,
  minCoverageFactorK: number = 2.5
): FrictionMetrics {
  const midPrice = (bid + ask) / 2;
  const spreadPips = (ask - bid) / pipSize;
  const spreadCostUsd = spreadPips * pipSize * lotSizeUnits;
  
  // Comissão e Slippage em USD por lote
  const commissionUsd = commissionUsdPerLot;
  const slippageUsd = estimatedSlippagePips * pipSize * lotSizeUnits;

  const totalFrictionCostUsd = spreadCostUsd + commissionUsd + slippageUsd;
  const expectedTargetUsd = expectedTargetPips * pipSize * lotSizeUnits;

  const coverageRatio = totalFrictionCostUsd > 0 ? expectedTargetUsd / totalFrictionCostUsd : 0;
  const isViable = coverageRatio >= minCoverageFactorK;

  return {
    spreadPips,
    spreadCostUsd,
    totalFrictionCostUsd,
    coverageRatio,
    isViable
  };
}

/**
 * Order Book Imbalance (OBI) & Micro-Price
 * OBI = (V_b - V_a) / (V_b + V_a)
 * MicroPrice = (V_b * P_a + V_a * P_b) / (V_b + V_a)
 */
export function calculateMicroPrice(
  bid: number,
  ask: number,
  volumeBid: number,
  volumeAsk: number
): MicroPriceResult {
  const midPrice = (bid + ask) / 2;
  const totalVol = volumeBid + volumeAsk;

  if (totalVol === 0) {
    return { obi: 0, microPrice: midPrice, midPrice };
  }

  const obi = (volumeBid - volumeAsk) / totalVol;
  const microPrice = (volumeBid * ask + volumeAsk * bid) / totalVol;

  return { obi, microPrice, midPrice };
}

/**
 * 2. ESTATÍSTICA E SÉRIES TEMPORAIS (TICK-LEVEL / ROLLING WINDOW)
 * Log-returns: r_t = ln(P_t / P_{t-1})
 * Autocorrelação rho_1: Corr(r_t, r_{t-1})
 * Z-score dinâmico: Z_t = (P_t - mu_t) / sigma_t
 */
export function calculateLogReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }
  return returns;
}

export function calculateAutocorrelationRho1(returns: number[]): number {
  if (returns.length < 5) return 0;

  const n = returns.length - 1;
  const rT = returns.slice(1);
  const rPrev = returns.slice(0, -1);

  const meanT = rT.reduce((a, b) => a + b, 0) / n;
  const meanPrev = rPrev.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let denT = 0;
  let denPrev = 0;

  for (let i = 0; i < n; i++) {
    const devT = rT[i] - meanT;
    const devPrev = rPrev[i] - meanPrev;
    num += devT * devPrev;
    denT += devT * devT;
    denPrev += devPrev * devPrev;
  }

  const denom = Math.sqrt(denT * denPrev);
  if (denom === 0) return 0;
  return num / denom;
}

export function calculateDynamicZScore(
  prices: number[],
  lookback: number = 20
): { zScore: number; mean: number; stdDev: number } {
  if (prices.length < lookback) {
    return { zScore: 0, mean: prices[prices.length - 1] || 0, stdDev: 0 };
  }

  const window = prices.slice(-lookback);
  const mean = window.reduce((a, b) => a + b, 0) / lookback;
  const variance = window.reduce((acc, p) => acc + Math.pow(p - mean, 2), 0) / lookback;
  const stdDev = Math.sqrt(variance);

  const currentPrice = prices[prices.length - 1];
  const zScore = stdDev > 0 ? (currentPrice - mean) / stdDev : 0;

  return { zScore, mean, stdDev };
}

export function calculateRealizedVolatility(returns: number[]): number {
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((acc, r) => acc + Math.pow(r - mean, 2), 0) / returns.length;
  return Math.sqrt(variance);
}

/**
 * 3. EXPECTATIVA MATEMÁTICA E GESTÃO DE RISCO (KELLY FRACIONÁRIO)
 * E = (W * AvgWin) - (L * AvgLoss) - C_t
 * f* = (p * (b + 1) - 1) / b
 * Lote = lambda * f* * Saldo
 */
export function calculateMathematicalExpectancy(
  winRate: number, // ex: 0.60 (60%)
  avgWinUsd: number,
  avgLossUsd: number,
  frictionCostUsd: number
): number {
  const lossRate = 1 - winRate;
  return (winRate * avgWinUsd) - (lossRate * avgLossUsd) - frictionCostUsd;
}

export function calculateFractionalKellyLotSize(
  winRate: number, // p
  avgWinUsd: number,
  avgLossUsd: number,
  accountBalanceUsd: number,
  lambdaFraction: number = 0.15, // Kelly Fracionário seguro (0.10 a 0.20)
  maxLotSize: number = 10.0,
  minLotSize: number = 0.01,
  contractSize: number = 100000 // 1 Lote padrão = 100.000 unidades
): { kellyFraction: number; recommendedLots: number; recommendedUnits: number } {
  if (avgLossUsd <= 0 || winRate <= 0 || winRate >= 1) {
    return { kellyFraction: 0, recommendedLots: minLotSize, recommendedUnits: minLotSize * contractSize };
  }

  const b = avgWinUsd / avgLossUsd; // Payoff ratio
  const rawKelly = (winRate * (b + 1) - 1) / b;

  if (rawKelly <= 0) {
    return { kellyFraction: 0, recommendedLots: minLotSize, recommendedUnits: minLotSize * contractSize };
  }

  const fractionalKelly = rawKelly * lambdaFraction;
  const riskAmountUsd = accountBalanceUsd * fractionalKelly;
  
  // Convertendo valor de risco em Lotes com base na perda média por trade
  let rawLots = (riskAmountUsd / avgLossUsd) * 0.1; // Fator de escala seguro
  rawLots = Math.max(minLotSize, Math.min(maxLotSize, Number(rawLots.toFixed(2))));

  return {
    kellyFraction: fractionalKelly,
    recommendedLots: rawLots,
    recommendedUnits: Math.round(rawLots * contractSize)
  };
}

/**
 * 4. EXPONENTE DE HURST (H)
 * Mede a memória de longo prazo da série temporal.
 * H < 0.5: Anti-persistente (Mean Reversion)
 * H = 0.5: Passeio Aleatório (Random Walk - Ruído Puro -> PROIBIDO OPERAR)
 * H > 0.5: Persistente (Tendência/Momentum)
 */
export function calculateHurstExponent(prices: number[]): number {
  if (prices.length < 20) return 0.5; // Fallback neutro para poucas amostras

  const logReturns = calculateLogReturns(prices);
  const n = logReturns.length;
  if (n < 10) return 0.5;

  const mean = logReturns.reduce((a, b) => a + b, 0) / n;
  
  // Desvios acumulados
  let cumDev = 0;
  const cumDevs: number[] = [];
  for (const r of logReturns) {
    cumDev += (r - mean);
    cumDevs.push(cumDev);
  }

  const range = Math.max(...cumDevs) - Math.min(...cumDevs);
  const variance = logReturns.reduce((acc, r) => acc + Math.pow(r - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0 || range === 0) return 0.5;

  const rs = range / stdDev;
  const hurst = Math.log(rs) / Math.log(n);

  // Normalização entre 0 e 1
  return Math.max(0.0, Math.min(1.0, hurst));
}

export interface CandleOHLC {
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * 5. ESTIMADOR DE VOLATILIDADE DE GARMAN-KLASS (GK Volatility)
 * Mede a volatilidade intrínseca do candle (OHLC) eliminando o ruído de discretização.
 * sigma_GK^2 = 0.511 * (u - d)^2 - 0.019 * [c * (u + d) - 2 * u * d]
 */
export function calculateGarmanKlassVolatility(candles: CandleOHLC[]): number {
  if (candles.length === 0) return 0;

  let sumGk = 0;
  for (const c of candles) {
    if (c.open <= 0 || c.low <= 0) continue;
    const u = Math.log(c.high / c.open);
    const d = Math.log(c.low / c.open);
    const closeLog = Math.log(c.close / c.open);

    const term1 = 0.511 * Math.pow(u - d, 2);
    const term2 = 0.019 * (closeLog * (u + d) - 2 * u * d);
    
    sumGk += (term1 - term2);
  }

  const avgGk = sumGk / candles.length;
  return Math.sqrt(Math.max(0, avgGk));
}

/**
 * 6. DETECÇÃO DE ABSORÇÃO DE VOLUME E ICEBERG ORDERS
 * Mede o Z-Score do volume de ticks. Se o volume disparar sem grande deslocamento de preço,
 * indica absorção por grandes ordens institucionais passivas.
 */
export function detectVolumeAbsorption(
  recentTickVolumes: number[],
  priceDeltaPips: number
): { isAbsorption: boolean; volumeZScore: number } {
  if (recentTickVolumes.length < 10) return { isAbsorption: false, volumeZScore: 0 };

  const currentVol = recentTickVolumes[recentTickVolumes.length - 1];
  const window = recentTickVolumes.slice(0, -1);
  const meanVol = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((acc, v) => acc + Math.pow(v - meanVol, 2), 0) / window.length;
  const stdDev = Math.sqrt(variance);

  const volumeZScore = stdDev > 0 ? (currentVol - meanVol) / stdDev : 0;
  
  // Z-Score de Volume alto (> 2.0) com movimentação de preço irrisória (< 1.2 pips)
  const isAbsorption = volumeZScore > 2.0 && Math.abs(priceDeltaPips) < 1.2;

  return { isAbsorption, volumeZScore };
}

/**
 * 7. CIRCUIT BREAKER DE SEQUÊNCIA ANÔMALA DE PERDAS (BINOMIAL LOSS PAUSER)
 * Calcula a probabilidade de um cluster de perdas ocorrer sob condições normais.
 * Se P(k perdas em n trades) < 1.0%, ativa o circuito de emergência.
 */
export function checkBinomialLossCircuitBreaker(
  consecutiveLosses: number,
  expectedWinRate: number = 0.60
): { shouldPause: boolean; probability: number } {
  if (consecutiveLosses < 3) return { shouldPause: false, probability: 1.0 };

  const lossProbability = 1 - expectedWinRate; // ex: 0.40
  const sequenceProbability = Math.pow(lossProbability, consecutiveLosses);

  // Se a probabilidade de tal sequência for menor que 1.5% (0.015), aciona pausa emergencial
  const shouldPause = sequenceProbability < 0.015;

  return { shouldPause, probability: sequenceProbability };
}

/**
 * 8. FILTRO DE SESSÃO DE MERCADO E OVERNIGHT ROLLOVER
 * O Rollover ocorre tipicamente entre 21:55 UTC e 22:15 UTC (dilatação brutal de spread).
 * Bloqueia scalping durante o rollover e monitora janelas de baixa liquidez.
 */
export function checkMarketSessionLiquidity(nowDate: Date = new Date()): { isLowLiquidity: boolean; reason?: string } {
  const utcHours = nowDate.getUTCHours();
  const utcMinutes = nowDate.getUTCMinutes();

  // Janela de Rollover Bancário (21:55 UTC às 22:15 UTC)
  if ((utcHours === 21 && utcMinutes >= 55) || (utcHours === 22 && utcMinutes <= 15)) {
    return { isLowLiquidity: true, reason: 'Janela de Rollover Bancário / Spread Dilatado (21:55-22:15 UTC)' };
  }

  // Transição NY -> Sydney (21:00 UTC às 23:00 UTC) - Liquidez reduzida
  if (utcHours >= 21 && utcHours < 23) {
    return { isLowLiquidity: true, reason: 'Troca de Sessão (NY -> Sydney / Liquidez Reduzida)' };
  }

  return { isLowLiquidity: false };
}

/**
 * 9. VELOCIDADE DE DESLOCAMENTO DO MICRO-PRICE (Micro-Price Velocity)
 * V_MP = (MicroPrice_t - MicroPrice_{t-dt}) / dt
 * Detecta aceleração rápida no livro de ofertas antes da movimentação de preço.
 */
export function calculateMicroPriceVelocity(
  microPrices: Array<{ price: number; timestamp: number }>
): { velocity: number; isAccelerating: boolean } {
  if (microPrices.length < 3) return { velocity: 0, isAccelerating: false };

  const latest = microPrices[microPrices.length - 1];
  const previous = microPrices[microPrices.length - 3];

  const dtSeconds = (latest.timestamp - previous.timestamp) / 1000;
  if (dtSeconds <= 0) return { velocity: 0, isAccelerating: false };

  const velocity = (latest.price - previous.price) / dtSeconds;
  
  // Aceleração relevante (mudança significativa em fração de segundo)
  const isAccelerating = Math.abs(velocity) > 0.0001;

  return { velocity, isAccelerating };
}

/**
 * 10. MEIA-VIDA DE REVERSÃO À MÉDIA (PROCESSO DE ORNSTEIN-UHLENBECK)
 * Modelo: dP_t = theta * (mu - P_t) * dt + sigma * dW_t
 * Meia-Vida (Half-Life t_{1/2}): ln(2) / theta
 * Determina o Time-Stop exato para o trade de Mean Reversion.
 */
export function calculateOrnsteinUhlenbeckHalfLife(prices: number[]): { halfLifeSeconds: number; isValid: boolean } {
  if (prices.length < 15) return { halfLifeSeconds: 120, isValid: false };

  const y = prices.slice(1);
  const x = prices.slice(0, -1);
  const n = y.length;

  // Regressão Linear: y_t - y_{t-1} = lambda * y_{t-1} + const
  const dy = y.map((val, idx) => val - x[idx]);
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanDy = dy.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - meanX) * (dy[i] - meanDy);
    den += Math.pow(x[i] - meanX, 2);
  }

  if (den === 0) return { halfLifeSeconds: 120, isValid: false };

  const lambda = num / den; // Slope da regressão (deve ser negativo para reversão)
  if (lambda >= 0) {
    // Se lambda >= 0, a série não é mean-reverting (sem meia-vida matemática)
    return { halfLifeSeconds: 300, isValid: false };
  }

  const theta = -lambda; // Taxa de reversão
  const halfLifeTicks = Math.log(2) / theta;

  // Supondo 1 tick ~ 1.5 a 2 segundos
  const halfLifeSeconds = Math.max(15, Math.min(300, Math.round(halfLifeTicks * 2)));

  return { halfLifeSeconds, isValid: true };
}


