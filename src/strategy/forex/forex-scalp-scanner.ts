// Robô 1 - Scanner Detector de Sinais de Scalping Forex
// Focado exclusivamente em monitorar ticks, calcular EMA5/EMA15 e RSI14 e identificar cruzamentos (crossover).
import { loadEnv } from '../../utils/env-loader';
loadEnv();
import { connectToDatabase } from '../../config/db';
import ForexArbSettings from '../../models/ForexArbSettings';
import ForexArbStrategy from '../../models/ForexArbStrategy';
import ForexArbTrade from '../../models/ForexArbTrade';
import ExchangeKey from '../../models/ExchangeKey';
import { getSharedCtraderAdapter } from './ctrader/ctrader-factory';
import {
  calculateFrictionCost,
  calculateMicroPrice,
  calculateLogReturns,
  calculateAutocorrelationRho1,
  calculateDynamicZScore,
  calculateHurstExponent,
  calculateGarmanKlassVolatility,
  detectVolumeAbsorption,
  checkMarketSessionLiquidity,
  calculateOrnsteinUhlenbeckHalfLife
} from './quant-scalp-engine';

const getTs = () => `[${new Date().toISOString()}]`;
const log = {
  info: (...args: any[]) => console.log(getTs(), '[FOREX-SCALP-SCANNER]', ...args),
  warn: (...args: any[]) => console.warn(getTs(), '[FOREX-SCALP-SCANNER]', ...args),
  error: (...args: any[]) => console.error(getTs(), '[FOREX-SCALP-SCANNER]', ...args),
};

export interface ScalpSignal {
  symbol: string;
  action: 'BUY' | 'SELL' | 'NEUTRAL';
  reason: string;
  price: number;
}

const priceHistory = new Map<string, Array<{ price: number; timestamp: number }>>();
const lastClosedTradeTime = new Map<string, number>();

export function recordClosedTrade(symbol: string, timestamp: number = Date.now()) {
  lastClosedTradeTime.set(symbol, timestamp);
}

export async function syncClosedTradeCooldowns() {
  try {
    const closedStrats = await ForexArbStrategy.find({
      positionOpen: false,
      closedAt: { $exists: true }
    }).sort({ closedAt: -1 }).select('legs closedAt').lean();

    for (const strat of closedStrats) {
      const sym = (strat as any).legs?.[0]?.symbol;
      if (sym && (strat as any).closedAt) {
        const closedTime = new Date((strat as any).closedAt).getTime();
        if (!lastClosedTradeTime.has(sym) || closedTime > (lastClosedTradeTime.get(sym) || 0)) {
          lastClosedTradeTime.set(sym, closedTime);
        }
      }
    }
  } catch (e: any) {
    // ignore
  }
}

function recordPrice(symbol: string, price: number) {
  if (!priceHistory.has(symbol)) {
    priceHistory.set(symbol, []);
  }
  const history = priceHistory.get(symbol)!;
  history.push({ price, timestamp: Date.now() });
  if (history.length > 100) {
    history.shift();
  }
}

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp: number;
}

const candleHistory = new Map<string, Candle[]>();
const currentCandleMap = new Map<string, Partial<Candle>>();
const CANDLE_PERIOD_MS = 60_000; // Velas M1 (1 minuto)

function updateCandles(symbol: string, price: number): Candle[] {
  const now = Date.now();
  const currentBucket = Math.floor(now / CANDLE_PERIOD_MS) * CANDLE_PERIOD_MS;

  if (!candleHistory.has(symbol)) {
    candleHistory.set(symbol, []);
  }
  const history = candleHistory.get(symbol)!;

  let current = currentCandleMap.get(symbol);
  if (!current || current.timestamp !== currentBucket) {
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
    current = {
      open: price,
      high: price,
      low: price,
      close: price,
      timestamp: currentBucket,
    };
    currentCandleMap.set(symbol, current);
  } else {
    current.high = Math.max(current.high!, price);
    current.low = Math.min(current.low!, price);
    current.close = price;
  }

  return [...history, {
    open: current.open!,
    high: current.high!,
    low: current.low!,
    close: current.close!,
    timestamp: current.timestamp!,
  }];
}

function calculateEMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] * k) + (ema * (1 - k));
  }
  return ema;
}

function calculateRSI(prices: number[], period: number = 14): number {
  if (prices.length < period + 1) return 50;
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

function calculateBollingerBands(prices: number[], period: number = 20, multiplier: number = 2.0) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    upper: sma + (multiplier * stdDev),
    middle: sma,
    lower: sma - (multiplier * stdDev),
    bandwidth: (stdDev * multiplier * 2) / sma
  };
}

function calculateATR(candles: Candle[], period: number = 14): number {
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

function calculateADX(candles: Candle[], period: number = 14): number {
  if (candles.length < period * 2) return 25; // Fallback neutro se faltar amostragem
  let plusDM = 0;
  let minusDM = 0;
  let trSum = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;

    if (upMove > downMove && upMove > 0) plusDM += upMove;
    if (downMove > upMove && downMove > 0) minusDM += downMove;

    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    trSum += tr;
  }

  if (trSum === 0) return 0;
  const plusDI = (plusDM / trSum) * 100;
  const minusDI = (minusDM / trSum) * 100;
  const dxDenominator = plusDI + minusDI;
  if (dxDenominator === 0) return 0;
  const dx = (Math.abs(plusDI - minusDI) / dxDenominator) * 100;
  return dx;
}

export function analyzeScalpOpportunity(
  symbol: string,
  bid: number,
  ask: number,
  volumeBid: number = 0,
  volumeAsk: number = 0
): ScalpSignal {
  const currentPrice = (bid + ask) / 2;
  recordPrice(symbol, currentPrice);

  // 0. Filtro de Liquidez de Sessão e Rollover
  const sessionCheck = checkMarketSessionLiquidity();
  if (sessionCheck.isLowLiquidity) {
    return { symbol, action: 'NEUTRAL', reason: `Filtro de Sessão / Liquidez Reduzida (${sessionCheck.reason})`, price: currentPrice };
  }

  const priceHistoryList = priceHistory.get(symbol)?.map(p => p.price) || [currentPrice];
  
  // 1. Modelagem de Fricção e Microestrutura (Custo Total C_t e Fator de Cobertura k)
  const expectedTargetPips = 5.0;
  const pipSize = symbol.includes('JPY') ? 0.01 : (symbol.includes('XAU') ? 0.1 : 0.0001);
  const minCoverageK = symbol.includes('XAU') ? 1.1 : 1.2; // Afrouxado para alta frequência
  const friction = calculateFrictionCost(bid, ask, expectedTargetPips, pipSize, 100000, 5.0, 0.2, minCoverageK);

  if (!friction.isViable) {
    return {
      symbol,
      action: 'NEUTRAL',
      reason: `Fricção alta / Cobertura insuficiente (${friction.coverageRatio.toFixed(2)}x < ${minCoverageK}x | Spread: ${friction.spreadPips.toFixed(1)} pips)`,
      price: currentPrice
    };
  }

  // Order Book Imbalance (OBI) & Micro-Price
  let microPriceStr = '';
  if (volumeBid > 0 && volumeAsk > 0) {
    const micro = calculateMicroPrice(bid, ask, volumeBid, volumeAsk);
    microPriceStr = ` | OBI: ${micro.obi.toFixed(2)} MicroP: ${micro.microPrice.toFixed(5)}`;
  }

  // 2. Cooldown Reduzido para 45 Segundos (45.000ms)
  const lastTime = lastClosedTradeTime.get(symbol) || 0;
  if (Date.now() - lastTime < 45000) {
    const restSec = Math.ceil((45000 - (Date.now() - lastTime)) / 1000);
    return { symbol, action: 'NEUTRAL', reason: `Em cooldown após fechamento (${restSec}s restantes)`, price: currentPrice };
  }

  const candles = updateCandles(symbol, currentPrice);
  const closes = candles.map(c => c.close);

  if (candles.length < 2) {
    return { symbol, action: 'NEUTRAL', reason: `Aguardando velas M1 (possuí ${candles.length}/2)`, price: currentPrice };
  }

  // 3. Análise de Série Temporal Tick & Log-Returns
  const logReturns = calculateLogReturns(priceHistoryList);
  const rho1 = calculateAutocorrelationRho1(logReturns);
  const { zScore } = calculateDynamicZScore(priceHistoryList, 20);
  const hurst = calculateHurstExponent(priceHistoryList);
  const gkVol = calculateGarmanKlassVolatility(candles);
  const atr = calculateATR(candles, 14);

  const tickVolumes = candles.map(c => c.close > 0 ? 1 : 0);
  const lastPriceDeltaPips = Math.abs(closes[closes.length - 1] - (closes[closes.length - 2] || closes[closes.length - 1])) / pipSize;
  const absorption = detectVolumeAbsorption(tickVolumes, lastPriceDeltaPips);

  const adx = calculateADX(candles, 14);
  const bb = calculateBollingerBands(closes, 20, 2.0);
  const emaFast = calculateEMA(closes, 5);
  const emaSlow = calculateEMA(closes, 15);
  const rsi = calculateRSI(closes, 14);

  const prevCloses = closes.slice(0, -1);
  const prevEmaFast = calculateEMA(prevCloses, 5);
  const prevEmaSlow = calculateEMA(prevCloses, 15);

  const crossoverBuy = (prevEmaFast <= prevEmaSlow && emaFast > emaSlow) || (emaFast > emaSlow);
  const crossoverSell = (prevEmaFast >= prevEmaSlow && emaFast < emaSlow) || (emaFast < emaSlow);

  const emaDelta = Math.abs(emaFast - emaSlow);

  // Classificação de Regime Quantitativo Flexível:
  if (rho1 < 0.00 || hurst < 0.50) {
    // REGIME: REVERSÃO À MÉDIA (Mean Reversion)
    const ouHalfLife = calculateOrnsteinUhlenbeckHalfLife(priceHistoryList);
    const ouStr = ouHalfLife.isValid ? ` | OU t1/2: ${ouHalfLife.halfLifeSeconds}s` : '';

    if (zScore < -0.80 && rsi < 55) {
      return {
        symbol,
        action: 'BUY',
        reason: `🎯 QUANT MEAN-REVERSION BUY! Z-Score:${zScore.toFixed(2)} < -0.80, Hurst:${hurst.toFixed(2)}, RSI:${rsi.toFixed(1)}${microPriceStr}${ouStr}`,
        price: currentPrice
      };
    }
    if (zScore > 0.80 && rsi > 45) {
      return {
        symbol,
        action: 'SELL',
        reason: `🎯 QUANT MEAN-REVERSION SELL! Z-Score:${zScore.toFixed(2)} > +0.80, Hurst:${hurst.toFixed(2)}, RSI:${rsi.toFixed(1)}${microPriceStr}${ouStr}`,
        price: currentPrice
      };
    }
  }

  // REGIME: MOMENTUM / TENDÊNCIA
  if (crossoverBuy && rsi >= 35 && rsi <= 75) {
    return {
      symbol,
      action: 'BUY',
      reason: `🎯 QUANT MOMENTUM BUY! EMA5>EMA15 (Delta:${emaDelta.toFixed(5)}), Hurst:${hurst.toFixed(2)}, Z-Score:${zScore.toFixed(2)}, RSI:${rsi.toFixed(1)}${microPriceStr}`,
      price: currentPrice
    };
  }

  if (crossoverSell && rsi >= 25 && rsi <= 65) {
    return {
      symbol,
      action: 'SELL',
      reason: `🎯 QUANT MOMENTUM SELL! EMA5<EMA15 (Delta:${emaDelta.toFixed(5)}), Hurst:${hurst.toFixed(2)}, Z-Score:${zScore.toFixed(2)}, RSI:${rsi.toFixed(1)}${microPriceStr}`,
      price: currentPrice
    };
  }

  return { symbol, action: 'NEUTRAL', reason: `Sem gatilho quant (Hurst:${hurst.toFixed(2)}, Z:${zScore.toFixed(2)}, rho1:${rho1.toFixed(3)}, Absorp:${absorption.isAbsorption})`, price: currentPrice };
}

async function startScalpScanner() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI required');
  await connectToDatabase();
  log.info('✅ Conectado ao MongoDB - Forex Scalp Scanner Bot (Robô 1)');

  const symbols = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'XAU/USD'];

  while (true) {
    try {
      const settings = await ForexArbSettings.findOne().lean();
      if (settings && settings.isScanningEnabled) {
        log.info('⚡ [FOREX-SCALP-SCANNER] Escaneando mercado para novas oportunidades...');
        
        const keys = await (ExchangeKey as any).find({ userId: settings.userId, active: true }).lean();
        const ctraderKey = keys.find((k: any) => k.exchangeId === 'ctrader');

        if (ctraderKey) {
          const adapter = await getSharedCtraderAdapter(ctraderKey);
          const tradeSize = settings.tradeSize || 100;

          try {
            const tickers = await (adapter as any).fetchTickers(symbols);
            for (const sym of symbols) {
              const ticker = tickers[sym];
              if (ticker && ticker.bid && ticker.ask) {
                const signal = analyzeScalpOpportunity(sym, ticker.bid, ticker.ask);
                const midPrice = (ticker.bid + ticker.ask) / 2;
                log.info(`📊 [SCALP TICK] ${sym}: Bid=${ticker.bid.toFixed(5)} Ask=${ticker.ask.toFixed(5)} Mid=${midPrice.toFixed(5)} | Status: ${signal.reason}`);

                if (signal.action !== 'NEUTRAL') {
                  // Cooldown de 2 minutos (120000ms) após fechar qualquer posição neste par
                  const ultimaFechada = await ForexArbStrategy.findOne({
                    userId: settings.userId,
                    name: new RegExp(`Scalping ${sym.replace('/', '\\/')}`),
                    positionOpen: false,
                    closedAt: { $ne: null }
                  }).sort({ closedAt: -1 }).lean();

                  if (ultimaFechada && ultimaFechada.closedAt) {
                    const msDesdeFechamento = Date.now() - new Date(ultimaFechada.closedAt).getTime();
                    if (msDesdeFechamento < 120000) {
                      const segRestantes = Math.ceil((120000 - msDesdeFechamento) / 1000);
                      log.info(`⏳ [COOLDOWN ATIVO] ${sym}: Posição encerrada recentemente. Aguardando mais ${segRestantes}s para liberar novo sinal.`);
                      continue;
                    }
                  }

                  const temPosicaoAbertaNoBanco = await ForexArbStrategy.exists({
                    userId: settings.userId,
                    name: new RegExp(`Scalping ${sym.replace('/', '\\/')}`),
                    positionOpen: true
                  });

                  const temOportunidadePendente = await ForexArbTrade.exists({
                    userId: settings.userId,
                    type: 'opportunity_found',
                    status: 'detected',
                    'legs.symbol': sym
                  });

                  if (!temPosicaoAbertaNoBanco && !temOportunidadePendente) {
                    log.info(`🎯 [SINAL SCALPING DETECTADO] ${sym} -> ${signal.action} | Preço: ${signal.price} | Motivo: ${signal.reason}`);
                    const side = signal.action === 'BUY' ? 'buy' : 'sell';

                    try {
                      await ForexArbTrade.create({
                        userId: settings.userId,
                        strategyName: `Scalping ${sym} (${signal.action})`,
                        exchangeId: 'ctrader',
                        type: 'opportunity_found',
                        legs: [{ symbol: sym, side, price: midPrice, amount: tradeSize }],
                        amount: tradeSize,
                        status: 'detected',
                        reason: signal.reason,
                      });
                      log.info(`📢 [SINAL REGISTRADO NO BANCO] Oportunidade enviada para execução: ${sym} (${signal.action})`);
                    } catch (dbErr: any) {
                      log.error(`⚠️ Erro ao registrar oportunidade no banco: ${dbErr.message}`);
                    }
                  } else {
                    log.info(`🔒 [POSIÇÃO ATIVA EXISTENTE] Sinal ignorado para ${sym}: já existe operação aberta.`);
                  }
                }
              }
            }
          } catch { /* erro de fetch */ }
        }
      }
    } catch (err: any) {
      log.error('❌ Erro no loop do Scalp Scanner:', err.message);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

if (require.main === module) {
  startScalpScanner().catch((e) => log.error('🔥 Erro fatal no Scalp Scanner:', e.message));
}
