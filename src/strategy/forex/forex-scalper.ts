// Estratégia de Scalping Forex de Alta Frequência
// Suporta indicadores técnicos: RSI, EMA Fast/Slow, M5 Trend Filter, Candle M1 Close, Trailing Stop e Calibração por Ativo.
import { loadEnv } from '../../utils/env-loader';
loadEnv();
import { connectToDatabase } from '../../config/db';
import ForexArbSettings from '../../models/ForexArbSettings';
import ForexArbStrategy from '../../models/ForexArbStrategy';
import ForexArbTrade from '../../models/ForexArbTrade';
import ExchangeKey from '../../models/ExchangeKey';
import BotStatus from '../../models/BotStatus';
import { getSharedCtraderAdapter } from './ctrader/ctrader-factory';
import { recordClosedTrade, syncClosedTradeCooldowns } from './forex-scalp-scanner';
import { calculateFractionalKellyLotSize, checkBinomialLossCircuitBreaker } from './quant-scalp-engine';

const getTs = () => `[${new Date().toISOString()}]`;
const log = {
  info: (...args: any[]) => console.log(getTs(), '[FOREX-SCALPER]', ...args),
  warn: (...args: any[]) => console.warn(getTs(), '[FOREX-SCALPER]', ...args),
  error: (...args: any[]) => console.error(getTs(), '[FOREX-SCALPER]', ...args),
};

export interface ScalpSignal {
  symbol: string;
  action: 'BUY' | 'SELL' | 'NEUTRAL';
  reason: string;
  price: number;
}

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp: number;
}

// ─── ESTRUTURAS DE VELAS EM MEMÓRIA (M1 E M5) ──────────────────────────────────
const candleHistoryM1 = new Map<string, Candle[]>();
const currentCandleM1 = new Map<string, Partial<Candle>>();
const candleHistoryM5 = new Map<string, Candle[]>();
const currentCandleM5 = new Map<string, Partial<Candle>>();
const justClosedM1Map = new Map<string, boolean>();

const M1_PERIOD_MS = 60_000;
const M5_PERIOD_MS = 300_000;

// Trava de tempo mínimo em posição antes de autorizar 'signal_reversal' (60 segundos)
export const MIN_HOLD_TIME_MS = 60_000;

// Acumulador de PnL realizado no dia (freio de perda diária). Recalculado a
// partir do banco na inicialização e incrementado a cada fechamento.
let dailyRealizedPnl = 0;
let dailyPnlDayKey = new Date().toISOString().slice(0, 10);

async function syncDailyRealizedPnl(userId: string) {
  const dayKey = new Date().toISOString().slice(0, 10);
  if (dayKey !== dailyPnlDayKey) {
    dailyRealizedPnl = 0;
    dailyPnlDayKey = dayKey;
  }
  const start = new Date(`${dayKey}T00:00:00.000Z`);
  const closedToday = await ForexArbTrade.find({
    userId,
    type: 'close',
    createdAt: { $gte: start },
  }).lean();
  dailyRealizedPnl = closedToday.reduce((acc, t: any) => acc + Number(t.realizedPnl || 0), 0);
  return dailyRealizedPnl;
}

export function updateCandlesM1(symbol: string, price: number): { history: Candle[]; closed: boolean } {
  const now = Date.now();
  const bucket = Math.floor(now / M1_PERIOD_MS) * M1_PERIOD_MS;

  if (!candleHistoryM1.has(symbol)) candleHistoryM1.set(symbol, []);
  const history = candleHistoryM1.get(symbol)!;

  let current = currentCandleM1.get(symbol);
  let justClosed = false;

  if (!current || current.timestamp !== bucket) {
    if (current && current.close !== undefined) {
      history.push({
        open: current.open!,
        high: current.high!,
        low: current.low!,
        close: current.close!,
        timestamp: current.timestamp!,
      });
      if (history.length > 80) history.shift();
      justClosed = true;
    }
    current = { open: price, high: price, low: price, close: price, timestamp: bucket };
    currentCandleM1.set(symbol, current);
  } else {
    current.high = Math.max(current.high!, price);
    current.low = Math.min(current.low!, price);
    current.close = price;
  }

  justClosedM1Map.set(symbol, justClosed);

  return {
    history: [...history, { open: current.open!, high: current.high!, low: current.low!, close: current.close!, timestamp: current.timestamp! }],
    closed: justClosed,
  };
}

export function updateCandlesM5(symbol: string, price: number): Candle[] {
  const now = Date.now();
  const bucket = Math.floor(now / M5_PERIOD_MS) * M5_PERIOD_MS;

  if (!candleHistoryM5.has(symbol)) candleHistoryM5.set(symbol, []);
  const history = candleHistoryM5.get(symbol)!;

  let current = currentCandleM5.get(symbol);
  if (!current || current.timestamp !== bucket) {
    if (current && current.close !== undefined) {
      history.push({
        open: current.open!,
        high: current.high!,
        low: current.low!,
        close: current.close!,
        timestamp: current.timestamp!,
      });
      if (history.length > 60) history.shift();
    }
    current = { open: price, high: price, low: price, close: price, timestamp: bucket };
    currentCandleM5.set(symbol, current);
  } else {
    current.high = Math.max(current.high!, price);
    current.low = Math.min(current.low!, price);
    current.close = price;
  }

  return [...history, { open: current.open!, high: current.high!, low: current.low!, close: current.close!, timestamp: current.timestamp! }];
}

let historicalPreloaded = false;

/** Pré-carrega o histórico de velas M1 e M5 via cTrader Open API na inicialização. */
export async function preloadHistoricalCandles(adapter: any, symbols: string[]) {
  if (historicalPreloaded || !adapter || typeof adapter.fetchTrendbars !== 'function') return;
  log.info('⏳ [PRE-WARM] Carregando histórico de velas M1 e M5 via cTrader Open API...');

  for (const sym of symbols) {
    try {
      // 1. Carrega M1 (últimas 50 velas)
      const barsM1 = await adapter.fetchTrendbars(sym, 1, 50);
      await new Promise(r => setTimeout(r, 350));
      if (barsM1 && barsM1.length > 0) {
        const now = Date.now();
        const currentBucketM1 = Math.floor(now / M1_PERIOD_MS) * M1_PERIOD_MS;
        const closedM1 = barsM1.filter((b: Candle) => b.timestamp < currentBucketM1);
        candleHistoryM1.set(sym, closedM1.slice(-80));

        const inProgressM1 = barsM1.find((b: Candle) => b.timestamp === currentBucketM1);
        if (inProgressM1) {
          currentCandleM1.set(sym, { ...inProgressM1 });
        }
        log.info(`📊 [PRE-WARM] ${sym}: ${closedM1.length} velas M1 carregadas.`);
      }

      // 2. Carrega M5 (últimas 30 velas)
      const barsM5 = await adapter.fetchTrendbars(sym, 5, 30);
      await new Promise(r => setTimeout(r, 350));
      if (barsM5 && barsM5.length > 0) {
        const now = Date.now();
        const currentBucketM5 = Math.floor(now / M5_PERIOD_MS) * M5_PERIOD_MS;
        const closedM5 = barsM5.filter((b: Candle) => b.timestamp < currentBucketM5);
        candleHistoryM5.set(sym, closedM5.slice(-60));

        const inProgressM5 = barsM5.find((b: Candle) => b.timestamp === currentBucketM5);
        if (inProgressM5) {
          currentCandleM5.set(sym, { ...inProgressM5 });
        }
        log.info(`📊 [PRE-WARM] ${sym}: ${closedM5.length} velas M5 carregadas.`);
      }
    } catch (e: any) {
      log.warn(`⚠️ [PRE-WARM] Falha ao carregar velas de ${sym}: ${e.message}`);
    }
  }
  historicalPreloaded = true;
  log.info('🚀 [PRE-WARM] Histórico de velas aquecido com sucesso! Zero tempo de espera.');
}

// ─── CÁLCULOS TÉCNICOS (EMA, RSI, ATR) ──────────────────────────────────────────
export function calculateEMA(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

export function calculateRSI(prices: number[], period = 14): number {
  if (prices.length <= period) return 50;
  let gains = 0;
  let losses = 0;

  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

export function calculateATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  let trSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSum += tr;
  }
  return trSum / period;
}

// ─── PERFIL E CALIBRAÇÃO POR ATIVO (AJUSTE 5) ─────────────────────────────────
export interface SymbolProfile {
  enabled: boolean;
  maxSpreadPct: number;
  trailingActivationUsd: number;
  trailingDistanceUsd: number;
  minFeeProtectionUsd: number;
  minEmaDeltaRatio: number;
  minAtrRatio: number;
  // Tamanho do lote em unidades base (ex: 5000 = 0.05 lote). Configurável por
  // par via symbolProfiles; NÃO é mais hardcoded no código.
  defaultTradeSize?: number;
  takeProfitPct: number;
  stopLossPct: number;
  requireM5Trend: boolean;
}

/** Perfil base (defaults) por símbolo, antes de aplicar overrides do banco. */
function baseSymbolProfile(symbol: string): SymbolProfile {
  if (symbol.includes('NAS100') || symbol.includes('USTEC') || symbol.includes('NDX') || symbol.includes('GER40') || symbol.includes('DAX')) {
    return {
      enabled: true,
      maxSpreadPct: 0.04,
      trailingActivationUsd: 0.75,
      trailingDistanceUsd: 0.35,
      minFeeProtectionUsd: 0.40,
      minEmaDeltaRatio: 0.00001,
      minAtrRatio: 0.00001,
      defaultTradeSize: 1,
      takeProfitPct: 0.20,
      stopLossPct: 0.012,
      requireM5Trend: false,
    };
  }
  if (symbol.includes('US30') || symbol.includes('DJI') || symbol.includes('WS30')) {
    return {
      enabled: true,
      maxSpreadPct: 0.04,
      trailingActivationUsd: 0.75,
      trailingDistanceUsd: 0.35,
      minFeeProtectionUsd: 0.40,
      minEmaDeltaRatio: 0.00001,
      minAtrRatio: 0.00001,
      defaultTradeSize: 1,
      takeProfitPct: 0.20,
      stopLossPct: 0.012,
      requireM5Trend: false,
    };
  }
  if (symbol.includes('XAU')) {
    return {
      enabled: true,
      defaultTradeSize: 100,      // 100 unidades (1 lote Ouro = minVolume cTrader)
      maxSpreadPct: 0.045,        // Ouro aceita spread até 0.045%
      trailingActivationUsd: 0.80,// Trailing ativa com +$0.80 no ouro
      trailingDistanceUsd: 0.30,  // Distância de trailing $0.30
      minFeeProtectionUsd: 0.25,  
      minEmaDeltaRatio: 0.00001,
      minAtrRatio: 0.00001,
      takeProfitPct: 0.30,
      stopLossPct: 0.15,
      requireM5Trend: false,
    };
  }
  if (symbol.includes('AUD/USD') || symbol.includes('AUDUSD')) {
    return {
      enabled: true,
      maxSpreadPct: 0.025,
      trailingActivationUsd: 0.65,
      trailingDistanceUsd: 0.30,
      minFeeProtectionUsd: 0.35,
      minEmaDeltaRatio: 0.00001,
      minAtrRatio: 0.00001,
      defaultTradeSize: 3000,
      takeProfitPct: 0.15,
      stopLossPct: 0.02,
      requireM5Trend: false,
    };
  }
  if (symbol.includes('USD/CAD') || symbol.includes('USDCAD')) {
    return {
      enabled: true,
      maxSpreadPct: 0.025,
      trailingActivationUsd: 0.65,
      trailingDistanceUsd: 0.30,
      minFeeProtectionUsd: 0.35,
      minEmaDeltaRatio: 0.00001,
      minAtrRatio: 0.00001,
      defaultTradeSize: 3000,
      takeProfitPct: 0.15,
      stopLossPct: 0.02,
      requireM5Trend: false,
    };
  }
  if (symbol.includes('BTC')) {
    return {
      enabled: true,
      maxSpreadPct: 0.05,
      trailingActivationUsd: 1.50,
      trailingDistanceUsd: 0.60,
      minFeeProtectionUsd: 0.50,
      minEmaDeltaRatio: 0.00001,
      minAtrRatio: 0.00001,
      defaultTradeSize: 0.01,
      takeProfitPct: 0.30,
      stopLossPct: 0.05,
      requireM5Trend: false,
    };
  }
  if (symbol.includes('EUR/USD') || symbol.includes('EURUSD')) {
    return {
      enabled: true,
      maxSpreadPct: 0.025,
      trailingActivationUsd: 0.65,
      trailingDistanceUsd: 0.30,
      minFeeProtectionUsd: 0.35,
      minEmaDeltaRatio: 0.00001,
      minAtrRatio: 0.00001,
      takeProfitPct: 0.15,
      stopLossPct: 0.02,
      requireM5Trend: false,
    };
  }
  if (symbol.includes('GBP/USD') || symbol.includes('GBPUSD')) {
    return {
      enabled: true,
      maxSpreadPct: 0.025,
      trailingActivationUsd: 0.65,
      trailingDistanceUsd: 0.30,
      minFeeProtectionUsd: 0.35,
      minEmaDeltaRatio: 0.00001,
      minAtrRatio: 0.00001,
      takeProfitPct: 0.15,
      stopLossPct: 0.02,
      requireM5Trend: false,
    };
  }
  if (symbol.includes('USD/JPY') || symbol.includes('USDJPY')) {
    return {
      enabled: true,
      maxSpreadPct: 0.025,
      trailingActivationUsd: 0.65,
      trailingDistanceUsd: 0.30,
      minFeeProtectionUsd: 0.35,
      minEmaDeltaRatio: 0.00001,
      minAtrRatio: 0.00001,
      takeProfitPct: 0.15,
      stopLossPct: 0.02,
      requireM5Trend: false,
    };
  }
  return {
    enabled: true,
    maxSpreadPct: 0.025,
    trailingActivationUsd: 0.65,
    trailingDistanceUsd: 0.30,
    minFeeProtectionUsd: 0.35,
    minEmaDeltaRatio: 0.00001,
    minAtrRatio: 0.00001,
    takeProfitPct: 0.15,
    stopLossPct: 0.02,
    requireM5Trend: false,
  };
}

/**
 * Resolve o perfil efetivo de um símbolo, mesclando os defaults com o
 * `symbolProfiles` salvo no settings (override por par). `overrides` é um objeto
 * parcial: campos ausentes herdam o valor base.
 */
export function getSymbolProfile(
  symbol: string,
  overrides?: Partial<SymbolProfile> | null,
): SymbolProfile {
  const base = baseSymbolProfile(symbol);
  if (!overrides) return base;
  return {
    enabled: overrides.enabled ?? base.enabled,
    maxSpreadPct: overrides.maxSpreadPct ?? base.maxSpreadPct,
    trailingActivationUsd: overrides.trailingActivationUsd ?? base.trailingActivationUsd,
    trailingDistanceUsd: overrides.trailingDistanceUsd ?? base.trailingDistanceUsd,
    minFeeProtectionUsd: overrides.minFeeProtectionUsd ?? base.minFeeProtectionUsd,
    minEmaDeltaRatio: overrides.minEmaDeltaRatio ?? base.minEmaDeltaRatio,
    minAtrRatio: overrides.minAtrRatio ?? base.minAtrRatio,
    defaultTradeSize: overrides.defaultTradeSize ?? base.defaultTradeSize,
    takeProfitPct: overrides.takeProfitPct ?? base.takeProfitPct,
    stopLossPct: overrides.stopLossPct ?? base.stopLossPct,
    requireM5Trend: overrides.requireM5Trend ?? base.requireM5Trend,
  };
}

/** Extrai o override por par a partir do `settings.symbolProfiles` (Map ou POJO). */
export function getSymbolProfileOverride(settings: any, symbol: string): Partial<SymbolProfile> | null {
  const profiles = settings?.symbolProfiles;
  if (!profiles) return null;
  const value = typeof profiles.get === 'function'
    ? profiles.get(symbol)
    : (profiles[symbol] ?? profiles[symbol.replace('/', '')]);
  if (!value) return null;
  // Converte subdocumento Mongoose/Map para objeto plano, se necessário.
  if (typeof value.toObject === 'function') return value.toObject();
  if (value._doc) return { ...value._doc };
  return value;
}

// ─── ANÁLISE DE OPORTUNIDADES (AJUSTES 1, 4 E 5) ──────────────────────────────
export function analyzeScalpOpportunity(
  symbol: string,
  bid: number,
  ask: number,
  profile?: SymbolProfile
): ScalpSignal {
  const currentPrice = (bid + ask) / 2;
  const effectiveProfile = profile ?? getSymbolProfile(symbol);

  // 1. Filtro Estrito de Spread
  const spreadPct = ((ask - bid) / currentPrice) * 100;
  if (spreadPct > effectiveProfile.maxSpreadPct) {
    return { symbol, action: 'NEUTRAL', reason: `Spread elevado (${spreadPct.toFixed(4)}% > ${effectiveProfile.maxSpreadPct}%)`, price: currentPrice };
  }

  // 2. Atualização de Velas M1 e M5
  const { history: candlesM1 } = updateCandlesM1(symbol, currentPrice);
  const candlesM5 = updateCandlesM5(symbol, currentPrice);

  if (candlesM1.length < 4) {
    return { symbol, action: 'NEUTRAL', reason: `Aguardando velas M1 (${candlesM1.length}/4)`, price: currentPrice };
  }

  const closesM1 = candlesM1.map(c => c.close);
  const closesM5 = candlesM5.map(c => c.close);

  // 3. Filtro de Tendência Maior no M5 (Ajuste 4)
  let m5Trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (closesM5.length >= 20) {
    const ema20M5 = calculateEMA(closesM5, 20);
    const ema50M5 = calculateEMA(closesM5, Math.min(50, closesM5.length));
    if (ema20M5 > ema50M5 && currentPrice >= ema20M5 * 0.9998) {
      m5Trend = 'BULLISH';
    } else if (ema20M5 < ema50M5 && currentPrice <= ema20M5 * 1.0002) {
      m5Trend = 'BEARISH';
    }
  }

  // 4. Indicadores M1
  const emaFast = calculateEMA(closesM1, Math.min(5, closesM1.length));
  const emaSlow = calculateEMA(closesM1, Math.min(15, closesM1.length));
  const rsi = calculateRSI(closesM1, Math.min(14, closesM1.length));
  const atr = calculateATR(candlesM1, Math.min(14, candlesM1.length));

  // Crossover e Momentum M1
  const prevCloses = closesM1.slice(0, -1);
  const prevEmaFast = calculateEMA(prevCloses, Math.min(5, prevCloses.length || 1));
  const prevEmaSlow = calculateEMA(prevCloses, Math.min(15, prevCloses.length || 1));

  const crossoverBuy = prevEmaFast <= prevEmaSlow && emaFast > emaSlow;
  const crossoverSell = prevEmaFast >= prevEmaSlow && emaFast < emaSlow;
  const isBullishTrend = emaFast >= emaSlow;
  const isBearishTrend = emaFast <= emaSlow;
  const emaDelta = Math.abs(emaFast - emaSlow);

  const buyConditions = (crossoverBuy || (isBullishTrend && emaDelta >= currentPrice * 0.00003)) && rsi >= 35 && rsi <= 65;
  const sellConditions = (crossoverSell || (isBearishTrend && emaDelta >= currentPrice * 0.00003)) && rsi >= 35 && rsi <= 65;

  // 5. Confluência BUY (Cruzamento M1 ou Momentum de Alta + RSI saudável)
  if (buyConditions) {
    if (effectiveProfile.requireM5Trend && m5Trend === 'BEARISH') {
      log.info(`🚫 [${symbol}] Compra BLOQUEADA: M5 em baixa | RSI:${rsi.toFixed(1)} M5:${m5Trend} Delta:${emaDelta.toFixed(5)} spread:${spreadPct.toFixed(4)}% atr:${atr.toFixed(5)}`);
      return { symbol, action: 'NEUTRAL', reason: `Compra filtrada: Tendência M5 em baixa`, price: currentPrice };
    }
    log.info(`✅ [${symbol}] SINAL BUY! EMA5>EMA15 Delta:${emaDelta.toFixed(5)} RSI:${rsi.toFixed(1)} M5:${m5Trend}`);
    return {
      symbol,
      action: 'BUY',
      reason: `🎯 CONFLUÊNCIA BUY! EMA5>EMA15 (Delta:${emaDelta.toFixed(5)}), RSI:${rsi.toFixed(1)}, M5:${m5Trend}`,
      price: currentPrice
    };
  }

  // 6. Confluência SELL (Cruzamento M1 ou Momentum de Baixa + RSI saudável)
  if (sellConditions) {
    if (effectiveProfile.requireM5Trend && m5Trend === 'BULLISH') {
      log.info(`🚫 [${symbol}] Venda BLOQUEADA: M5 em alta | RSI:${rsi.toFixed(1)} M5:${m5Trend} Delta:${emaDelta.toFixed(5)}`);
      return { symbol, action: 'NEUTRAL', reason: `Venda filtrada: Tendência M5 em alta`, price: currentPrice };
    }
    log.info(`✅ [${symbol}] SINAL SELL! EMA5<EMA15 Delta:${emaDelta.toFixed(5)} RSI:${rsi.toFixed(1)} M5:${m5Trend}`);
    return {
      symbol,
      action: 'SELL',
      reason: `🎯 CONFLUÊNCIA SELL! EMA5<EMA15 (Delta:${emaDelta.toFixed(5)}), RSI:${rsi.toFixed(1)}, M5:${m5Trend}`,
      price: currentPrice
    };
  }

  // Nenhum dos lados teve confluência M1+RSI — loga o motivo
  const m1Reason = (!crossoverBuy && !isBullishTrend && !crossoverSell && !isBearishTrend)
    ? 'sem cruzamento/momentum M1'
    : (rsi < 32 || rsi > 68)
      ? `RSI fora da faixa (${rsi.toFixed(1)})`
      : `RSI borderline`;
  log.info(`⏳ [${symbol}] NEUTRAL: ${m1Reason} | RSI:${rsi.toFixed(1)} M5:${m5Trend} Delta:${emaDelta.toFixed(5)} spread:${spreadPct.toFixed(4)}% atr:${atr.toFixed(5)} candlesM1:${candlesM1.length}`);

  return { symbol, action: 'NEUTRAL', reason: 'Sem confluência de entrada', price: currentPrice };
}

// ─── GESTÃO DE POSIÇÕES ATIVAS ────────────────────────────────────────────────
const activePositions = new Map<string, {
  positionId?: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  amount: number;
  volumeProtocol: number;
  entryTime: number;
  peakPnlPct: number;
  peakPnlUsd: number;
  trailingFloorUsd: number;
  trailingActive: boolean;
  lastSyncedFloorPrice?: number;
}>();

function amountUsdFor(symbol: string, volume: number, price: number): number {
  return symbol.endsWith('/JPY') ? volume : volume * price;
}

export function decidePositionClose(input: {
  positionId?: string;
  volumeProtocol?: number;
  amount?: number;
  side?: 'BUY' | 'SELL' | 'buy' | 'sell';
  symbol?: string;
}): {
  usePositionClose: boolean;
  mode: 'position-close' | 'market-order';
  volumeProtocol: number;
  closeSide?: 'buy' | 'sell';
} {
  const normalizedPositionId = input.positionId ? String(input.positionId).trim() : '';
  const hasRealPositionId = Boolean(normalizedPositionId) && !normalizedPositionId.startsWith('pos_');
  const volumeProtocol = Number(input.volumeProtocol ?? 0);

  if (hasRealPositionId && Number.isFinite(volumeProtocol) && volumeProtocol > 0) {
    return {
      usePositionClose: true,
      mode: 'position-close',
      volumeProtocol,
      closeSide: undefined,
    };
  }

  const closeSide: 'buy' | 'sell' = input.side && (input.side === 'BUY' || input.side === 'buy') ? 'sell' : 'buy';
  return {
    usePositionClose: false,
    mode: 'market-order',
    volumeProtocol: 0,
    closeSide,
  };
}

// Fecha uma posição ativa (closePosition na cTrader), atualiza o banco e o
// acumulador de PnL diário. Centraliza o fluxo de saída para ser chamado pelo
// loop dedicado de saída e pelo loop principal (reversão de sinal).
async function executeClosePosition(params: {
  adapter: any;
  settings: any;
  tradeSize: number;
  sym: string;
  activePos: any;
  midPrice: number;
  reasonType: string;
  motivoFechar: string;
  atingiuTrailing: boolean;
}) {
  const { adapter, settings, tradeSize, sym, activePos, midPrice, reasonType, motivoFechar, atingiuTrailing } = params;

  const closeDecision = decidePositionClose({
    positionId: activePos.positionId,
    volumeProtocol: activePos.volumeProtocol,
    amount: activePos.amount,
    side: activePos.side,
    symbol: sym,
  });
  const closeSide: 'buy' | 'sell' = closeDecision.closeSide ?? (activePos.side === 'BUY' ? 'sell' : 'buy');
  log.info(`🔄 [AUTO-SCALPER CLOSE] Encerrando ${activePos.side} em ${sym}. Motivo: ${motivoFechar} | Modo: ${closeDecision.mode}`);

  try {
    let closeRes;
    if (closeDecision.usePositionClose && activePos.positionId) {
      closeRes = await adapter.closePosition(activePos.positionId, closeDecision.volumeProtocol);
    } else {
      closeRes = await adapter.createMarketOrder(sym, closeSide, activePos.amount);
    }

    const closePrice = closeRes?.price && Number(closeRes.price) > 0 ? Number(closeRes.price) : midPrice;
    const isGold = sym.includes('XAU');
    const isJpy = sym.endsWith('/JPY') || sym.endsWith('JPY');
    const vol = activePos.amount || (isGold ? 1 : tradeSize || 1000);
    const lotesReais = isGold ? (vol >= 100 ? vol / 100 : vol * 0.01) : (vol >= 1000 ? vol / 100000 : vol);
    const numLotes001 = lotesReais / 0.01;
    const totalComm = closeRes?.commission != null && Number(closeRes.commission) > 0
      ? Number(closeRes.commission)
      : Number(((isGold ? 0.09 : 0.06) * numLotes001).toFixed(2));

    const diffPrice = activePos.side === 'BUY' ? (closePrice - activePos.entryPrice) : (activePos.entryPrice - closePrice);
    const calcGross = isGold
      ? diffPrice * (vol > 10 ? vol / 100 : vol)
      : (isJpy && closePrice > 0 ? (diffPrice * vol) / closePrice : diffPrice * vol);
    const calcNet = calcGross - totalComm;

    const finalPnlUsd = closeRes?.realizedPnl != null && !isNaN(Number(closeRes.realizedPnl)) && Math.abs(Number(closeRes.realizedPnl)) < 100000
      ? Number(closeRes.realizedPnl)
      : calcNet;

    const closeVolume = Number(closeRes?.amount || activePos.amount || 0);
    const closeAmountUsd = closeVolume > 0 && closePrice > 0 ? amountUsdFor(sym, closeVolume, closePrice) : null;
    activePositions.delete(sym);
    recordClosedTrade(sym);

    // Atualiza o acumulador diário de PnL (freio de perda).
    dailyRealizedPnl += Number(finalPnlUsd || 0);
    log.info(`✅ [POSIÇÃO ENCERRADA] ${sym}! PnL Real cTrader: $${finalPnlUsd.toFixed(2)} | PnL diário: $${dailyRealizedPnl.toFixed(2)} | Preço Fechamento: ${closePrice} | Motivo: ${reasonType}`);

    try {
      const existingStrat = await ForexArbStrategy.findOne({
        userId: settings.userId,
        positionOpen: true,
        $or: [
          { 'legs.symbol': sym },
          { 'legs.orderId': new RegExp(activePos.positionId || '___') },
          { name: new RegExp(`(Scalping|Forex).*${sym.replace('/', '.*')}`, 'i') }
        ]
      });

      if (existingStrat) {
        existingStrat.positionOpen = false;
        existingStrat.status = 'closed';
        existingStrat.closedReason = reasonType;
        existingStrat.trailingStopTriggered = atingiuTrailing;
        existingStrat.active = false;
        existingStrat.closedAt = new Date();
        existingStrat.pnl = finalPnlUsd;
        await existingStrat.save();

        await ForexArbTrade.create({
          userId: settings.userId,
          strategyId: existingStrat._id,
          strategyName: existingStrat.name,
          exchangeId: 'ctrader',
          type: 'close',
          legs: [
            ...(existingStrat.legs || []).map((l: any) => ({ ...l, entryPrice: activePos.entryPrice || l.entryPrice || l.price, closePrice })),
            { symbol: sym, side: closeSide, price: closePrice, closePrice, entryPrice: activePos.entryPrice, amount: closeVolume, volume: closeVolume, amountUsd: closeAmountUsd, orderId: closeRes?.id }
          ],
          amount: closeVolume,
          volume: closeVolume,
          amountUsd: closeAmountUsd,
          realizedPnl: finalPnlUsd,
          commission: totalComm,
          status: 'executed',
          closedReason: reasonType,
          trailingStopTriggered: atingiuTrailing,
          reason: motivoFechar,
        });
      }
    } catch (dbErr: any) {
      log.error(`⚠️ Erro ao atualizar fechamento no banco: ${dbErr.message}`);
    }
  } catch (closeErr: any) {
    log.error(`❌ [ERRO AO FECHAR POSIÇÃO] ${sym}:`, closeErr?.message || closeErr);
  }
}

// Loop dedicado de saída: reage rápido ao preço (usa apenas o cache de tickers
// em memória) para decidir TP/SL/trailing sem esperar o loop pesado (reconcile,
// PnL da cTrader, sinais). Roda em paralelo ao loop principal.
async function runExitLoop() {
  const symbols = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'BTC/USD', 'XAU/USD', 'NAS100', 'US30', 'GER40'];
  while (true) {
    try {
      const settings = await ForexArbSettings.findOne().lean();
      if (settings && settings.userId) {
        const keys = await ExchangeKey.find({ userId: settings.userId, active: true }).lean();
        const ctraderKey = keys.find((k: any) => k.exchangeId === 'ctrader');
        if (ctraderKey) {
          const adapter = await getSharedCtraderAdapter(ctraderKey);
          const tradeSize = settings.tradeSize || 100;
          const tickers = await adapter.fetchTickers(symbols);

          for (const sym of symbols) {
            const activePos = activePositions.get(sym);
            if (!activePos) continue;
            const ticker = tickers[sym];
            if (!ticker || !ticker.bid || !ticker.ask) continue;

            const midPrice = (ticker.bid + ticker.ask) / 2;
            const profile = getSymbolProfile(sym, getSymbolProfileOverride(settings, sym));
            if (activePos.entryPrice === 0) activePos.entryPrice = midPrice;

            const pnlPct = activePos.side === 'BUY'
              ? ((midPrice - activePos.entryPrice) / activePos.entryPrice) * 100
              : ((activePos.entryPrice - midPrice) / activePos.entryPrice) * 100;

            const isGoldPair = sym.includes('XAU');
            const isJpyPair = sym.endsWith('/JPY') || sym.endsWith('JPY');
            const closePrice = activePos.side === 'BUY' ? ticker.bid : ticker.ask;
            const priceDiff = activePos.side === 'BUY'
              ? (closePrice - activePos.entryPrice)
              : (activePos.entryPrice - closePrice);

            const rawUnits = activePos.amount && activePos.amount > 0 ? activePos.amount : (isGoldPair ? 1 : tradeSize || 1000);
            const lotesReais = isGoldPair
              ? (rawUnits >= 100 ? rawUnits / 100 : rawUnits * 0.01)
              : (rawUnits >= 1000 ? rawUnits / 100000 : rawUnits);
            const numLotes001 = Math.max(1, Math.round(lotesReais / 0.01));
            const estimatedComm = (isGoldPair ? 0.08 : 0.06) * numLotes001;

            const rawPnlUsd = rawUnits > 0
              ? (isGoldPair
                  ? priceDiff * rawUnits
                  : isJpyPair && closePrice > 0
                    ? (priceDiff * rawUnits) / closePrice
                    : priceDiff * rawUnits)
              : (pnlPct / 100) * tradeSize;

            const pnlUsd = Number.isFinite(rawPnlUsd)
              ? (rawPnlUsd - estimatedComm)
              : 0;

            if (pnlPct > activePos.peakPnlPct) activePos.peakPnlPct = pnlPct;
            if (pnlUsd > activePos.peakPnlUsd) activePos.peakPnlUsd = pnlUsd;

            const prevFloor = activePos.trailingFloorUsd;
            if (!activePos.trailingActive && activePos.peakPnlUsd >= profile.trailingActivationUsd) {
              activePos.trailingActive = true;
              activePos.trailingFloorUsd = Math.max(
                profile.minFeeProtectionUsd,
                activePos.peakPnlUsd - profile.trailingDistanceUsd
              );
              log.info(`🔒 [TRAILING USD ATIVADO] ${sym}: pico +$${activePos.peakPnlUsd.toFixed(2)}; piso garantido +$${activePos.trailingFloorUsd.toFixed(2)} (Taxas protegidas)`);
            } else if (activePos.trailingActive) {
              const novoPiso = Math.max(
                activePos.trailingFloorUsd,
                profile.minFeeProtectionUsd,
                activePos.peakPnlUsd - profile.trailingDistanceUsd,
              );
              if (novoPiso > prevFloor) {
                log.info(`📈 [TRAILING PISO ELEVADO] ${sym}: novo piso +$${novoPiso.toFixed(2)} (pico +$${activePos.peakPnlUsd.toFixed(2)})`);
              }
              activePos.trailingFloorUsd = novoPiso;
            }

            const units = activePos.amount && activePos.amount > 0 ? activePos.amount : 1000;
            const pricePerUsd = isGoldPair
              ? (1 / units)
              : isJpyPair && midPrice > 0
                ? (midPrice / units)
                : (1 / units);
            const trailingFloorPrice = activePos.trailingActive && activePos.trailingFloorUsd > 0
              ? (activePos.side === 'BUY'
                  ? activePos.entryPrice + (activePos.trailingFloorUsd * pricePerUsd)
                  : activePos.entryPrice - (activePos.trailingFloorUsd * pricePerUsd))
              : null;

            let currentAction = '⏳ Monitorando mercado';
            if (activePos.trailingActive) {
              const retracao = activePos.peakPnlUsd - pnlUsd;
              currentAction = retracao > 0.01
                ? `⚠️ Retração em andamento: PnL $${pnlUsd.toFixed(2)} | Piso fechamento: +$${activePos.trailingFloorUsd.toFixed(2)} USD`
                : `🔒 Trailing Ativo: Pico +$${activePos.peakPnlUsd.toFixed(2)} | Piso fechamento: +$${activePos.trailingFloorUsd.toFixed(2)} USD`;
            } else {
              currentAction = `⏳ Monitorando: PnL $${pnlUsd.toFixed(2)} USD (Ativa em +$${profile.trailingActivationUsd.toFixed(2)} USD)`;
            }

            // Sincroniza com o MongoDB para o Frontend
            ForexArbStrategy.updateOne(
              {
                userId: settings.userId,
                positionOpen: true,
                $or: [
                  { 'legs.symbol': sym },
                  { 'legs.orderId': new RegExp(activePos.positionId || '___') },
                  { name: new RegExp(`(Scalping|Forex).*${sym.replace('/', '.*')}`, 'i') }
                ]
              },
              {
                $set: {
                  currentPrice: midPrice,
                  [`lastLegPrices.${sym}`]: midPrice,
                  pnl: pnlUsd,
                  pnlPct: pnlPct,
                  peakProfitPct: activePos.peakPnlPct,
                  peakProfitUsd: activePos.peakPnlUsd,
                  trailingActive: activePos.trailingActive,
                  trailingFloorUsd: activePos.trailingFloorUsd,
                  trailingFloorPrice: trailingFloorPrice,
                  trailingActivationUsd: profile.trailingActivationUsd,
                  trailingDistanceUsd: profile.trailingDistanceUsd,
                  currentAction: currentAction,
                }
              }
            ).catch(() => {});

            const takeProfitTarget = profile.takeProfitPct ?? settings.takeProfitPct ?? 0.20;
            const stopLossTarget = Math.abs(profile.stopLossPct ?? settings.stopLossPct ?? 0.10);

            const atingiuTP = pnlPct >= takeProfitTarget;
            const atingiuSL = pnlPct <= -stopLossTarget;
            const atingiuTrailing = activePos.trailingActive && pnlUsd <= activePos.trailingFloorUsd;
            const trailingAtivoVirouNegativo = activePos.trailingActive && pnlUsd < 0;

            if (atingiuTP || atingiuSL || atingiuTrailing || trailingAtivoVirouNegativo) {
              const reasonType = atingiuTrailing
                ? 'trailing_stop'
                : atingiuTP
                  ? 'take_profit'
                  : 'stop_loss';
              const motivoFechar = atingiuTrailing
                ? `Trailing USD acionado (Pico: +$${activePos.peakPnlUsd.toFixed(2)}, Piso: +$${activePos.trailingFloorUsd.toFixed(2)}, Atual: $${pnlUsd.toFixed(2)})`
                : atingiuTP
                  ? `Take Profit atingido (+${pnlPct.toFixed(3)}%)`
                  : atingiuSL
                    ? `Stop Loss atingido (${pnlPct.toFixed(3)}%)`
                    : `Trailing ativo virou negativo (PnL $${pnlUsd.toFixed(2)}) — proteção anti-reversão`;

              await executeClosePosition({
                adapter,
                settings,
                tradeSize,
                sym,
                activePos,
                midPrice,
                reasonType,
                motivoFechar,
                atingiuTrailing,
              });
            }
          }
        }
      }
    } catch (e: any) {
      log.error('❌ Erro no loop de saída:', e.message);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function startScalper() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI required');
  await connectToDatabase();
  await syncClosedTradeCooldowns();

  // Sincroniza o PnL diário realizado antes de começar a operar (freio de perda).
  const seedSettings = await ForexArbSettings.findOne().lean();
  if (seedSettings) await syncDailyRealizedPnl(String(seedSettings.userId)).catch(() => {});

  log.info('✅ Conectado ao MongoDB - Forex Scalper Bot (Versão Otimizada com 5 Ajustes)');

  const symbols = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'BTC/USD', 'XAU/USD', 'NAS100', 'US30', 'GER40'];

  // Loop de saída dedicado: reage rápido ao preço (cache de tickers) para
  // decidir TP/SL/trailing sem esperar o loop principal (reconcile/PnL/sinais).
  runExitLoop().catch((e) => log.error('❌ Erro fatal no loop de saída:', e.message));

  // Atualização retroativa para a posição 240794176 (lucro real de 3.07 USD) e 240794915 (lucro real de 0.77 USD)
  try {
    await ForexArbTrade.updateMany(
      { $or: [{ 'legs.orderId': /240794176/ }, { reason: /240794176/ }] },
      { $set: { realizedPnl: 3.07, status: 'executed' } }
    );
    await ForexArbStrategy.updateMany(
      { $or: [{ 'legs.orderId': /240794176/ }, { name: /240794176/ }] },
      { $set: { pnl: 3.07, status: 'closed', positionOpen: false } }
    );
    await ForexArbTrade.updateMany(
      { $or: [{ 'legs.orderId': /240794915/ }, { reason: /240794915/ }] },
      { $set: { realizedPnl: 0.77, status: 'executed' } }
    );
    await ForexArbStrategy.updateMany(
      { $or: [{ 'legs.orderId': /240794915/ }, { name: /240794915/ }] },
      { $set: { pnl: 0.77, status: 'closed', positionOpen: false } }
    );
  } catch {}

  while (true) {
    try {
      const settings = await ForexArbSettings.findOne().lean();
      if (settings) {
        // Atualiza heartbeat do robô no MongoDB para o frontend exibir ONLINE
        try {
          await (BotStatus as any).updateOne(
            { userId: settings.userId, botName: 'forex-scalper' },
            { $set: { lastHeartbeat: new Date() } },
            { upsert: true }
          );
          await (BotStatus as any).updateOne(
            { userId: settings.userId, botName: 'forex-arb' },
            { $set: { lastHeartbeat: new Date() } },
            { upsert: true }
          );
        } catch { /* ignora erro de heartbeat */ }

        log.info('⚡ [FOREX-SCALPER] Monitorando mercado para Scalping HFT...');

        const keys = await (ExchangeKey as any).find({ userId: settings.userId, active: true }).lean();
        const ctraderKey = keys.find((k: any) => k.exchangeId === 'ctrader');

        if (ctraderKey) {
          const adapter = await getSharedCtraderAdapter(ctraderKey);
          await preloadHistoricalCandles(adapter, symbols);
          const tradeSize = settings.tradeSize || 100;

          // 1. Sincroniza posições reais da cTrader por símbolo
          try {
            const accountId = Number(ctraderKey.accountId);
            const rec = await (adapter as any).client.sendRequest(2124, 'ProtoOAReconcileReq', { ctidTraderAccountId: accountId }, 10000);
            const cTraderOpenSymbols = new Set<string>();

            if (rec && rec.position) {
              for (const pos of rec.position) {
                const market = (adapter as any).marketsById.get(String(pos.tradeData?.symbolId));
                const sym = market?.symbol;
                if (!sym || !symbols.includes(sym)) continue;

                cTraderOpenSymbols.add(sym);
                const posId = String(pos.positionId);
                const side = pos.tradeData?.tradeSide === 1 ? 'BUY' : 'SELL';
                const entryPrice = Number(pos.price || 0);
                const amount = Number(pos.tradeData?.volume || 0) / 100;

                if (!activePositions.has(sym)) {
                  const volumeProtocol = Number(pos.tradeData?.volume || 0);
                  const existingDoc = await ForexArbStrategy.findOne({
                    userId: settings.userId,
                    positionOpen: true,
                    $or: [
                      { 'legs.symbol': sym },
                      { 'legs.orderId': new RegExp(posId) },
                      { name: new RegExp(`(Scalping|Forex).*${sym.replace('/', '.*')}`, 'i') },
                    ]
                  }).lean();

                  if (!existingDoc) {
                    const finalAmount = amount > 0 ? amount : tradeSize;
                    const amountUsd = entryPrice > 0 ? amountUsdFor(sym, finalAmount, entryPrice) : tradeSize;
                    try {
                      await ForexArbStrategy.create({
                        userId: settings.userId,
                        exchangeKeyId: ctraderKey._id,
                        name: `Scalping ${sym} (${side})`,
                        exchangeId: 'ctrader',
                        type: 'simple',
                        legs: [{
                          symbol: sym,
                          side: side === 'BUY' ? 'buy' : 'sell',
                          price: entryPrice,
                          amount: finalAmount,
                          volume: finalAmount,
                          amountUsd,
                          orderId: `Pos #${posId}`,
                        }],
                        tradeSize: amountUsd,
                        positionOpen: true,
                        positionOpenedAt: new Date(),
                        positionSize: tradeSize,
                        positionVolume: finalAmount,
                        positionAmountUsd: amountUsd,
                        status: 'open',
                        active: true,
                      });
                      log.info(`📝 [RECONCILE] Posição #${posId} (${sym}) auto-registrada no MongoDB!`);
                    } catch (dbErr: any) {
                      log.error(`⚠️ Erro ao auto-registrar posição no reconcile: ${dbErr.message}`);
                    }
                  }

                  activePositions.set(sym, {
                    positionId: posId,
                    side,
                    entryPrice: entryPrice > 0 ? entryPrice : (existingDoc?.legs?.[0]?.price || 0),
                    amount: amount > 0 ? amount : tradeSize,
                    volumeProtocol: volumeProtocol > 0 ? volumeProtocol : 100,
                    entryTime: existingDoc?.positionOpenedAt ? new Date(existingDoc.positionOpenedAt).getTime() : Date.now(),
                    peakPnlPct: existingDoc?.peakProfitPct || 0,
                    peakPnlUsd: (existingDoc as any)?.peakProfitUsd || 0,
                    trailingFloorUsd: (existingDoc as any)?.trailingFloorUsd || 0,
                    trailingActive: Boolean((existingDoc as any)?.trailingActive),
                  });
                  log.info(`🔄 [RECONCILE CTRADER] Posição #${posId} detectada na cTrader para ${sym} (${side}) | Trailing ativo: ${Boolean((existingDoc as any)?.trailingActive)} | Piso: +$${(existingDoc as any)?.trailingFloorUsd || 0}`);
                }
              }
            }

            // Se o par foi fechado na cTrader, limpa da memória local
            for (const sym of symbols) {
              if (!cTraderOpenSymbols.has(sym) && activePositions.has(sym)) {
                activePositions.delete(sym);
              }
            }

            // Reconcilia todas as estratégias abertas no MongoDB que não existem mais na cTrader
            try {
              const openMongoStrats = await ForexArbStrategy.find({
                userId: settings.userId,
                positionOpen: true,
              });

              for (const openStrat of openMongoStrats) {
                const stratSym = openStrat.legs?.[0]?.symbol;
                if (stratSym && !cTraderOpenSymbols.has(stratSym)) {
                  // Extrai o positionId se existir nas pernas (o "Pos #NNN" é o id da posição;
                  // o "Order #NNN" é o id da ordem e não deve ser usado para consultar deals)
                  const orderIdRaw = openStrat.legs?.[0]?.orderId || '';
                  const posIdMatch = orderIdRaw.match(/Pos\s*#?(\d+)/i) || orderIdRaw.match(/(\d+)/);
                  const posId = posIdMatch ? posIdMatch[1] : undefined;

                  let brokerPnl = openStrat.pnl || 0;
                  let brokerCommission = openStrat.commission || 0;
                  let brokerSwap = openStrat.swap || 0;

                  // Consulta os deals da corretora para obter o PnL exato liquidado
                  let updatedLegs: any[] = openStrat.legs || [];
                  try {
                    let deals: any[] = [];
                    if (posId && typeof (adapter as any).fetchPositionDeals === 'function') {
                      deals = await (adapter as any).fetchPositionDeals(posId);
                    }
                    if (!deals.length && typeof (adapter as any).fetchDeals === 'function') {
                      const now = Date.now();
                      deals = await (adapter as any).fetchDeals(now - 1000 * 60 * 60 * 2, now, 50);
                      if (posId) {
                        deals = deals.filter(d => String(d.positionId) === String(posId));
                      } else {
                        deals = deals.filter(d => d.symbol === stratSym);
                      }
                    }

                    const closeDeal = deals.find(d => d.hasCloseDetail) || deals[deals.length - 1];
                    let closePrice = closeDeal?.price && Number(closeDeal.price) > 0 ? Number(closeDeal.price) : undefined;

                    if (closeDeal && closeDeal.realizedPnl !== undefined && !isNaN(Number(closeDeal.realizedPnl))) {
                      brokerPnl = Number(closeDeal.realizedPnl);
                      brokerCommission = Number(closeDeal.commission || 0);
                      brokerSwap = Number(closeDeal.swap || 0);
                      log.info(`🎯 [RECONCILE PNL REAL] ${stratSym} (Pos #${posId || '?'}) -> PnL Real Broker: $${brokerPnl.toFixed(2)} USD | Comm: -$${brokerCommission.toFixed(2)} USD | Fechamento: ${closePrice || '?'}`);
                    }

                    const entryPrice = openStrat.legs?.[0]?.price || 0;
                    updatedLegs = [
                      ...(openStrat.legs || []).map((leg: any) => ({ ...leg, entryPrice: leg.price || entryPrice })),
                      {
                        symbol: stratSym,
                        side: openStrat.legs?.[0]?.side === 'buy' ? 'sell' : 'buy',
                        price: closePrice || 0,
                        closePrice: closePrice || 0,
                        entryPrice,
                        amount: openStrat.legs?.[0]?.amount || 0,
                        volume: openStrat.legs?.[0]?.volume || 0,
                      }
                    ];
                  } catch (dealErr: any) {
                    log.warn(`⚠️ [RECONCILE PNL] Não foi possível consultar deals de ${stratSym}: ${dealErr.message}`);
                  }

                  openStrat.positionOpen = false;
                  openStrat.status = 'closed';
                  openStrat.closedReason = 'broker_close';
                  openStrat.active = false;
                  openStrat.closedAt = new Date();
                  openStrat.pnl = brokerPnl;
                  openStrat.commission = brokerCommission;
                  openStrat.swap = brokerSwap;
                  await openStrat.save();

                  await ForexArbTrade.create({
                    userId: settings.userId,
                    strategyId: openStrat._id,
                    strategyName: openStrat.name,
                    exchangeId: 'ctrader',
                    type: 'close',
                    legs: updatedLegs,
                    amount: openStrat.legs?.[0]?.amount || openStrat.positionVolume || 0,
                    volume: openStrat.legs?.[0]?.volume || openStrat.positionVolume || 0,
                    amountUsd: openStrat.legs?.[0]?.amountUsd || openStrat.positionAmountUsd || 0,
                    realizedPnl: brokerPnl,
                    commission: brokerCommission,
                    swap: brokerSwap,
                    status: 'executed',
                    closedReason: 'broker_close',
                    reason: 'Fechamento confirmado pela corretora cTrader',
                    createdAt: new Date(),
                  });
                  log.info(`✅ [RECONCILE MONGO] Estratégia ${openStrat.name} (${stratSym}) encerrada com PnL Real: $${brokerPnl.toFixed(2)} USD!`);
                }
              }
            } catch (orphanErr: any) {
              log.warn(`⚠️ [RECONCILE MONGO] Erro ao reconciliar estratégias órfãs: ${orphanErr.message}`);
            }
          } catch { /* erro transitório no reconcile */ }

          try {
            const tickers = await (adapter as any).fetchTickers(symbols);
            for (const sym of symbols) {
              const ticker = tickers[sym];
              if (ticker && ticker.bid && ticker.ask) {
                const midPrice = (ticker.bid + ticker.ask) / 2;
                const profile = getSymbolProfile(sym, getSymbolProfileOverride(settings, sym));

                // Atualiza o preço atual de mercado em tempo real em todas as estratégias abertas deste par no MongoDB
                ForexArbStrategy.updateMany(
                  { userId: settings.userId, positionOpen: true, 'legs.symbol': sym },
                  {
                    $set: {
                      currentPrice: midPrice,
                      [`lastLegPrices.${sym}`]: midPrice,
                      'legs.0.currentPrice': midPrice,
                    }
                  }
                ).catch(() => {});

                const signal = profile.enabled
                  ? analyzeScalpOpportunity(sym, ticker.bid, ticker.ask, profile)
                  : { symbol: sym, action: 'NEUTRAL' as const, reason: 'Par desativado nas configurações', price: midPrice };
                const isM1Closed = justClosedM1Map.get(sym) || false;

                // --- 1. REVERSÃO DE SINAL (saída por TP/SL/trailing fica no loop dedicado) ---
                const activePos = activePositions.get(sym);

                if (activePos) {
                  // AJUSTES 1, 2 E 3: Reversão só é autorizada se:
                  // 1) Trailing Stop NÃO foi acionado E o pico não atingiu a ativação de trailing
                  // 2) Posição aberta há pelo menos MIN_HOLD_TIME_MS (60s)
                  // 3) Vela M1 fechou confirmando o sinal contrário
                  const tempoAbertoMs = Date.now() - activePos.entryTime;
                  const tempoMinimoPassou = tempoAbertoMs >= MIN_HOLD_TIME_MS;
                  const sinalContrario = signal.action !== 'NEUTRAL' && signal.action !== activePos.side;

                  const reversaoSinalValida =
                    !activePos.trailingActive &&
                    activePos.peakPnlUsd < profile.trailingActivationUsd &&
                    sinalContrario &&
                    tempoMinimoPassou &&
                    isM1Closed;

                  if (reversaoSinalValida) {
                    await executeClosePosition({
                      adapter,
                      settings,
                      tradeSize,
                      sym,
                      activePos,
                      midPrice,
                      reasonType: 'signal_reversal',
                      motivoFechar: `Reversão de sinal confirmada no M1 (${Math.round(tempoAbertoMs / 1000)}s)`,
                      atingiuTrailing: false,
                    });
                  }
                }

                // --- 2. ABERTURA DE NOVA POSIÇÃO QUANDO NÃO HÁ POSIÇÕES ABERTAS ---
                const temPosicaoAbertaNoBanco = await ForexArbStrategy.exists({
                  userId: settings.userId,
                  'legs.symbol': sym,
                  positionOpen: true,
                });

                const maxDailyLoss = Math.abs(settings.maxDailyLoss ?? 100);
                const dailyLossAlcancado = dailyRealizedPnl <= -maxDailyLoss;

                // Consulta perdas consecutivas recentes para atuar o Circuit Breaker Binomial
                const ultimosFechados = await ForexArbTrade.find({
                  userId: settings.userId,
                  type: 'close'
                }).sort({ createdAt: -1 }).limit(5).lean();

                let perdasConsecutivas = 0;
                for (const t of ultimosFechados) {
                  if (Number((t as any).realizedPnl || 0) < 0) perdasConsecutivas++;
                  else break;
                }

                const circuitBreaker = checkBinomialLossCircuitBreaker(perdasConsecutivas, 0.60);
                if (circuitBreaker.shouldPause) {
                  log.warn(`🚨 [CIRCUIT BREAKER ATIVO] ${perdasConsecutivas} perdas consecutivas! Probabilidade binomial anômala: ${(circuitBreaker.probability * 100).toFixed(2)}%. Novas aberturas suspensas.`);
                }

                if (
                  settings.isScanningEnabled &&
                  settings.autoExecute &&
                  !dailyLossAlcancado &&
                  !circuitBreaker.shouldPause &&
                  !activePositions.has(sym) &&
                  !temPosicaoAbertaNoBanco &&
                  signal.action !== 'NEUTRAL'
                ) {
                  log.info(`🎯 [SINAL SCALPING DETECTADO] ${sym} -> ${signal.action} | Preço: ${signal.price} | Motivo: ${signal.reason}`);
                  const side = signal.action === 'BUY' ? 'buy' : 'sell';

                  // Risco e Kelly Fracionário: Dimensionar lote dinamicamente com base na taxa de acerto e no saldo da conta
                  const balanceUsd = Number(settings.accountBalanceUsd || 1000);
                  const kelly = calculateFractionalKellyLotSize(0.60, 3.5, 2.0, balanceUsd, 0.15, 10.0, 0.01, 100000);
                  const targetTradeSize = profile.defaultTradeSize || kelly.recommendedUnits || tradeSize;

                  log.info(`🚀 [ORDEM AUTO-SCALPER QUANT] Enviando ordem de ${signal.action} para ${sym} (${targetTradeSize} unidades | Kelly Lots: ${kelly.recommendedLots}L | Fração: ${(kelly.kellyFraction * 100).toFixed(1)}%)...`);
                  try {
                    const orderRes = await adapter.createMarketOrder(sym, side, targetTradeSize);
                    const posIdNew = orderRes?.positionId || orderRes?.id || `pos_${Date.now()}`;
                    const volume = Number(orderRes?.amount || 0);
                    const amountUsd = volume > 0 && midPrice > 0 ? amountUsdFor(sym, volume, midPrice) : targetTradeSize;
                    const market = (adapter as any).marketsBySymbol.get(sym);
                    // volumeProtocol DEVE usar a mesma unidade que o createMarketOrder
                    // envia: centésimos de unidade (amount * 100). Antes calculávamos
                    // `(targetTradeSize/lotSize)*100`, que retornava ~5 para FX e fazia o
                    // closePosition enviar volume 100000x menor, nunca fechando a posição.
                    const volumeProtocol = volume > 0
                      ? Math.round(volume * 100)
                      : Math.round(targetTradeSize * 100);

                    const execPrice = orderRes?.price && Number(orderRes.price) > 0 ? Number(orderRes.price) : midPrice;

                    activePositions.set(sym, {
                      positionId: String(posIdNew),
                      side: signal.action,
                      entryPrice: execPrice,
                      amount: targetTradeSize,
                      volumeProtocol,
                      entryTime: Date.now(),
                      peakPnlPct: 0,
                      peakPnlUsd: 0,
                      trailingFloorUsd: 0,
                      trailingActive: false,
                    });
                    log.info(`✅ [ORDEM ABERTA] #${posIdNew} ${sym} ${signal.action} @${execPrice}!`);

                    // Proteção de contingência: envia um Stop Loss server-side na cTrader
                    // bem mais largo que o SL/trailing lógicos do robô. A saída primária
                    // continua sendo decisão do robô (closePosition no próprio ciclo), mas
                    // se o robô cair/desconectar ou o preço pular o gatilho, a corretora
                    // segura o tombo. O nível é ~1.5x o SL lógico para não competir com o
                    // trailing ativo.
                    if (posIdNew && !String(posIdNew).startsWith('pos_') && typeof (adapter as any).amendPositionSLTP === 'function') {
                      const isGoldPairSL = sym.includes('XAU');
                      const isJpyPairSL = sym.endsWith('/JPY') || sym.endsWith('JPY');
                      const digitsSL = market?.digits ?? (isGoldPairSL ? 2 : (isJpyPairSL ? 3 : 5));
                      const slPct = Math.abs(profile.stopLossPct ?? settings.stopLossPct ?? 0.10);
                      const contingencyPct = slPct * 1.5;
                      const contingencySL = signal.action === 'BUY'
                        ? execPrice * (1 - contingencyPct / 100)
                        : execPrice * (1 + contingencyPct / 100);
                      const roundedContingencySL = Number(contingencySL.toFixed(digitsSL));
                      (adapter as any).amendPositionSLTP(posIdNew, roundedContingencySL, null).catch((err: any) => {
                        log.warn(`⚠️ [CTRADER-CONTINGENCY-SL] Erro ao registrar SL de contingência na cTrader (${sym}): ${err.message}`);
                      });
                    }

                    try {
                      const stratDoc = await ForexArbStrategy.create({
                        userId: settings.userId,
                        exchangeKeyId: ctraderKey._id,
                        name: `Scalping ${sym} (${signal.action})`,
                        exchangeId: 'ctrader',
                        type: 'simple',
                        legs: [{ symbol: sym, side, price: execPrice, amount: volume || tradeSize, volume: volume || null, amountUsd, orderId: orderRes?.id ? `Order #${orderRes.id} | Pos #${posIdNew}` : String(posIdNew) }],
                        tradeSize,
                        positionOpen: true,
                        positionOpenedAt: new Date(),
                        positionSize: tradeSize,
                        positionVolume: volume,
                        positionAmountUsd: amountUsd,
                        status: 'open',
                        active: true,
                      });

                      await ForexArbTrade.create({
                        userId: settings.userId,
                        strategyId: stratDoc._id,
                        strategyName: stratDoc.name,
                        exchangeId: 'ctrader',
                        type: 'execution',
                        legs: [{ symbol: sym, side, price: execPrice, amount: volume || tradeSize, volume: volume || null, amountUsd, orderId: orderRes?.id ? `Order #${orderRes.id} | Pos #${posIdNew}` : String(posIdNew) }],
                        amount: volume || tradeSize,
                        volume: volume || null,
                        amountUsd,
                        status: 'executed',
                        reason: signal.reason,
                      });
                    } catch (dbErr: any) {
                      log.error(`⚠️ Erro ao registrar estratégia/trade no banco: ${dbErr.message}`);
                    }

                  } catch (execErr: any) {
                    log.error(`❌ [ERRO AO ABRIR ORDEM] ${sym}:`, execErr?.message || execErr);
                  }
                }
              }
            }
          } catch { /* erro no ciclo */ }
        }
      }
    } catch (err: any) {
      log.error('❌ Erro no loop de Scalping:', err.message);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

if (require.main === module) {
  startScalper().catch(err => {
    log.error('Erro fatal no bot de Scalping:', err);
    process.exit(1);
  });
}
