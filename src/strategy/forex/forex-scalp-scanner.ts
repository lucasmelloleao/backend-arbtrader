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
  ask: number
): ScalpSignal {
  const currentPrice = (bid + ask) / 2;
  
  // 1. Filtro de Spread Máximo (Máximo 0.020%)
  const spreadPct = ((ask - bid) / currentPrice) * 100;
  if (spreadPct > 0.020) {
    return { symbol, action: 'NEUTRAL', reason: `Spread elevado (${spreadPct.toFixed(4)}% > 0.020%)`, price: currentPrice };
  }

  // 2. Cooldown Estrito de 5 Minutos (300.000ms) após fechar trade no mesmo par
  const lastTime = lastClosedTradeTime.get(symbol) || 0;
  if (Date.now() - lastTime < 300000) {
    const restSec = Math.ceil((300000 - (Date.now() - lastTime)) / 1000);
    return { symbol, action: 'NEUTRAL', reason: `Em cooldown de 5 min após fechamento (${restSec}s restantes)`, price: currentPrice };
  }

  const candles = updateCandles(symbol, currentPrice);
  const closes = candles.map(c => c.close);

  if (candles.length < 15) {
    return { symbol, action: 'NEUTRAL', reason: `Aguardando velas M1 (possuí ${candles.length}/15)`, price: currentPrice };
  }

  const atr = calculateATR(candles, 14);
  const minAtrThreshold = currentPrice * 0.00015; // Mínimo de volatilidade ativa
  if (atr < minAtrThreshold) {
    return { symbol, action: 'NEUTRAL', reason: `Mercado sem volatilidade/consolidação rasa (ATR=${atr.toFixed(5)})`, price: currentPrice };
  }

  const adx = calculateADX(candles, 14);
  if (adx < 20) {
    return { symbol, action: 'NEUTRAL', reason: `Tendência fraca (ADX=${adx.toFixed(1)} < 20)`, price: currentPrice };
  }

  const bb = calculateBollingerBands(closes, 20, 2.0);
  const emaFast = calculateEMA(closes, 5);
  const emaSlow = calculateEMA(closes, 15);
  const rsi = calculateRSI(closes, 14);

  const prevCloses = closes.slice(0, -1);
  const prevEmaFast = calculateEMA(prevCloses, 5);
  const prevEmaSlow = calculateEMA(prevCloses, 15);
  const prev2EmaSlow = calculateEMA(closes.slice(0, -3), 15);

  const crossoverBuy = prevEmaFast <= prevEmaSlow && emaFast > emaSlow;
  const crossoverSell = prevEmaFast >= prevEmaSlow && emaFast < emaSlow;

  // Distância mínima entre EMAs para evitar cruzamento falso colado
  const emaDelta = Math.abs(emaFast - emaSlow);
  const minEmaDelta = currentPrice * 0.00010;
  if (emaDelta < minEmaDelta) {
    return { symbol, action: 'NEUTRAL', reason: `Cruzamento raso (Delta EMA=${emaDelta.toFixed(6)})`, price: currentPrice };
  }

  const emaSlowSlope = emaSlow - prev2EmaSlow;

  // 3. Condições de Entrada de Alta Precisão (BUY)
  // Cruzamento de Alta + Slope Positivo + RSI (45-60) + Preço perto da Banda Média/Inferior + ADX > 20
  const isNearOrBelowUpperBB = bb ? currentPrice <= bb.upper : true;
  if (crossoverBuy && emaSlowSlope > 0 && rsi >= 45 && rsi <= 60 && isNearOrBelowUpperBB) {
    return {
      symbol,
      action: 'BUY',
      reason: `🎯 CONFLUÊNCIA BUY! EMA5>EMA15 (Delta:${emaDelta.toFixed(5)}), Inclin:+${emaSlowSlope.toFixed(6)}, RSI:${rsi.toFixed(1)}, ADX:${adx.toFixed(1)}, ATR:${atr.toFixed(5)}`,
      price: currentPrice
    };
  } 
  // 4. Condições de Entrada de Alta Precisão (SELL)
  // Cruzamento de Baixa + Slope Negativo + RSI (40-55) + Preço perto da Banda Média/Superior + ADX > 20
  const isNearOrAboveLowerBB = bb ? currentPrice >= bb.lower : true;
  if (crossoverSell && emaSlowSlope < 0 && rsi >= 40 && rsi <= 55 && isNearOrAboveLowerBB) {
    return {
      symbol,
      action: 'SELL',
      reason: `🎯 CONFLUÊNCIA SELL! EMA5<EMA15 (Delta:${emaDelta.toFixed(5)}), Inclin:${emaSlowSlope.toFixed(6)}, RSI:${rsi.toFixed(1)}, ADX:${adx.toFixed(1)}, ATR:${atr.toFixed(5)}`,
      price: currentPrice
    };
  }

  return { symbol, action: 'NEUTRAL', reason: `Sem confluência (RSI=${rsi.toFixed(1)}, ADX=${adx.toFixed(1)}, Slope=${emaSlowSlope.toFixed(6)})`, price: currentPrice };
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
