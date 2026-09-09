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
  maxSpreadPct: number;
  trailingActivationUsd: number;
  trailingDistanceUsd: number;
  minFeeProtectionUsd: number;
  minEmaDeltaRatio: number;
  minAtrRatio: number;
  defaultTradeSize: number; // unidades base calibradas para ~$30 USD de margem (1:200)
}

export function getSymbolProfile(symbol: string): SymbolProfile {
  if (symbol.includes('XAU')) {
    return {
      maxSpreadPct: 0.035,        // Ouro aceita spread até 0.035%
      trailingActivationUsd: 0.20,// Trailing ativa com +$0.20 no ouro
      trailingDistanceUsd: 0.05,  // Distância de trailing $0.05
      minFeeProtectionUsd: 0.08,  // Piso mínimo garantido para cobrir taxas do ouro
      minEmaDeltaRatio: 0.00002,
      minAtrRatio: 0.00002,
      defaultTradeSize: 1,        // 0.01 lote (1 oz) ≈ $21,79 de margem
    };
  }
  if (symbol.includes('EUR/USD') || symbol.includes('EURUSD')) {
    return {
      maxSpreadPct: 0.018,
      trailingActivationUsd: 0.25, // Ativação calibrada para 0.05 lote
      trailingDistanceUsd: 0.10,
      minFeeProtectionUsd: 0.15,
      minEmaDeltaRatio: 0.00002,
      minAtrRatio: 0.00002,
      defaultTradeSize: 5000,     // 0.05 lote = 5.000 EUR ≈ $29,06 de margem
    };
  }
  if (symbol.includes('GBP/USD') || symbol.includes('GBPUSD')) {
    return {
      maxSpreadPct: 0.018,
      trailingActivationUsd: 0.25, // Ativação calibrada para 0.04 lote
      trailingDistanceUsd: 0.10,
      minFeeProtectionUsd: 0.15,
      minEmaDeltaRatio: 0.00002,
      minAtrRatio: 0.00002,
      defaultTradeSize: 4000,     // 0.04 lote = 4.000 GBP ≈ $27,08 de margem
    };
  }
  if (symbol.includes('USD/JPY') || symbol.includes('USDJPY')) {
    return {
      maxSpreadPct: 0.018,
      trailingActivationUsd: 0.25, // Ativação calibrada para 0.06 lote
      trailingDistanceUsd: 0.10,
      minFeeProtectionUsd: 0.15,
      minEmaDeltaRatio: 0.00002,
      minAtrRatio: 0.00002,
      defaultTradeSize: 6000,     // 0.06 lote = 6.000 USD ≈ $30,00 de margem
    };
  }
  return {
    maxSpreadPct: 0.018,
    trailingActivationUsd: 0.15,
    trailingDistanceUsd: 0.05,
    minFeeProtectionUsd: 0.08,
    minEmaDeltaRatio: 0.00002,
    minAtrRatio: 0.00002,
    defaultTradeSize: 1000,
  };
}

// ─── ANÁLISE DE OPORTUNIDADES (AJUSTES 1, 4 E 5) ──────────────────────────────
export function analyzeScalpOpportunity(
  symbol: string,
  bid: number,
  ask: number
): ScalpSignal {
  const currentPrice = (bid + ask) / 2;
  const profile = getSymbolProfile(symbol);

  // 1. Filtro Estrito de Spread
  const spreadPct = ((ask - bid) / currentPrice) * 100;
  if (spreadPct > profile.maxSpreadPct) {
    return { symbol, action: 'NEUTRAL', reason: `Spread elevado (${spreadPct.toFixed(4)}% > ${profile.maxSpreadPct}%)`, price: currentPrice };
  }

  // 2. Atualização de Velas M1 e M5
  const { history: candlesM1 } = updateCandlesM1(symbol, currentPrice);
  const candlesM5 = updateCandlesM5(symbol, currentPrice);

  if (candlesM1.length < 15) {
    return { symbol, action: 'NEUTRAL', reason: `Aguardando velas M1 (${candlesM1.length}/15)`, price: currentPrice };
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
  const emaFast = calculateEMA(closesM1, 5);
  const emaSlow = calculateEMA(closesM1, 15);
  const rsi = calculateRSI(closesM1, 14);
  const atr = calculateATR(candlesM1, 14);

  // Filtro de Volatilidade Mínima (ATR - apenas descarta mercado totalmente parado)
  if (atr > 0 && atr < currentPrice * profile.minAtrRatio) {
    return { symbol, action: 'NEUTRAL', reason: `Mercado consolidado/sem volatilidade (ATR=${atr.toFixed(5)})`, price: currentPrice };
  }

  // Crossover e Momentum M1
  const prevCloses = closesM1.slice(0, -1);
  const prevEmaFast = calculateEMA(prevCloses, 5);
  const prevEmaSlow = calculateEMA(prevCloses, 15);

  const crossoverBuy = prevEmaFast <= prevEmaSlow && emaFast > emaSlow;
  const crossoverSell = prevEmaFast >= prevEmaSlow && emaFast < emaSlow;
  const isBullishTrend = emaFast > emaSlow && currentPrice >= emaSlow * 0.9999;
  const isBearishTrend = emaFast < emaSlow && currentPrice <= emaSlow * 1.0001;
  const emaDelta = Math.abs(emaFast - emaSlow);

  // 5. Confluência BUY (Cruzamento M1 ou Momentum de Alta + RSI saudável + Tendência M5 favorável)
  if ((crossoverBuy || isBullishTrend) && rsi >= 38 && rsi <= 68) {
    if (m5Trend === 'BEARISH') {
      return { symbol, action: 'NEUTRAL', reason: `Compra filtrada: Tendência M5 em baixa`, price: currentPrice };
    }
    return {
      symbol,
      action: 'BUY',
      reason: `🎯 CONFLUÊNCIA BUY! EMA5>EMA15 (Delta:${emaDelta.toFixed(5)}), RSI:${rsi.toFixed(1)}, M5:${m5Trend}`,
      price: currentPrice
    };
  }

  // 6. Confluência SELL (Cruzamento M1 ou Momentum de Baixa + RSI saudável + Tendência M5 favorável)
  if ((crossoverSell || isBearishTrend) && rsi >= 32 && rsi <= 62) {
    if (m5Trend === 'BULLISH') {
      return { symbol, action: 'NEUTRAL', reason: `Venda filtrada: Tendência M5 em alta`, price: currentPrice };
    }
    return {
      symbol,
      action: 'SELL',
      reason: `🎯 CONFLUÊNCIA SELL! EMA5<EMA15 (Delta:${emaDelta.toFixed(5)}), RSI:${rsi.toFixed(1)}, M5:${m5Trend}`,
      price: currentPrice
    };
  }

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

async function startScalper() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI required');
  await connectToDatabase();
  log.info('✅ Conectado ao MongoDB - Forex Scalper Bot (Versão Otimizada com 5 Ajustes)');

  const symbols = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'XAU/USD'];

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
          } catch { /* erro transitório no reconcile */ }

          try {
            let livePnlBySymbol = new Map<string, { positionId?: string; netPnl: number }>();
            try {
              livePnlBySymbol = await (adapter as any).getPositionsPnL();
            } catch {
              // fallback
            }

            const tickers = await (adapter as any).fetchTickers(symbols);
            for (const sym of symbols) {
              const ticker = tickers[sym];
              if (ticker && ticker.bid && ticker.ask) {
                const midPrice = (ticker.bid + ticker.ask) / 2;
                const profile = getSymbolProfile(sym);
                const signal = analyzeScalpOpportunity(sym, ticker.bid, ticker.ask);
                const isM1Closed = justClosedM1Map.get(sym) || false;

                // --- 1. GESTÃO DE SAÍDA (TP, SL, TRAILING E REVERSÃO FILTRADA) ---
                const activePos = activePositions.get(sym);

                if (activePos) {
                  if (activePos.entryPrice === 0) activePos.entryPrice = midPrice;

                  const pnlPct = activePos.side === 'BUY'
                    ? ((midPrice - activePos.entryPrice) / activePos.entryPrice) * 100
                    : ((activePos.entryPrice - midPrice) / activePos.entryPrice) * 100;

                  // Busca PnL em tempo real por símbolo normalizado ou positionId
                  let livePnlUsd: number | undefined = livePnlBySymbol.get(sym)?.netPnl;
                  if (livePnlUsd === undefined) {
                    const rawSym = sym.replace('/', '');
                    livePnlUsd = livePnlBySymbol.get(rawSym)?.netPnl;
                  }
                  if (livePnlUsd === undefined && activePos.positionId) {
                    for (const row of livePnlBySymbol.values()) {
                      if (row.positionId === activePos.positionId) {
                        livePnlUsd = row.netPnl;
                        break;
                      }
                    }
                  }

                  // Cálculo do PnL USD (usa PnL real da corretora ou calcula com base no volume/lote)
                  const priceDiff = activePos.side === 'BUY'
                    ? (midPrice - activePos.entryPrice)
                    : (activePos.entryPrice - midPrice);
                  const pnlUsd = Number.isFinite(livePnlUsd)
                    ? Number(livePnlUsd)
                    : (activePos.amount && activePos.amount > 0
                        ? priceDiff * activePos.amount
                        : (pnlPct / 100) * tradeSize);

                  // Atualiza picos de ganho
                  if (pnlPct > activePos.peakPnlPct) activePos.peakPnlPct = pnlPct;
                  if (pnlUsd > activePos.peakPnlUsd) activePos.peakPnlUsd = pnlUsd;

                  // Trailing Stop calibrado por ativo (Gatilho +$0.07 USD com proteção de taxas)
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

                  const isGoldPair = sym.includes('XAU');
                  const isJpyPair = sym.endsWith('/JPY') || sym.endsWith('JPY');
                  const unitMult = isGoldPair ? 1 : (isJpyPair && midPrice > 0 ? 1000 / midPrice : 1000);
                  const trailingFloorPrice = activePos.trailingActive && activePos.trailingFloorUsd > 0
                    ? (activePos.side === 'BUY'
                        ? activePos.entryPrice + (activePos.trailingFloorUsd / unitMult)
                        : activePos.entryPrice - (activePos.trailingFloorUsd / unitMult))
                    : null;

                  // Sincroniza o Trailing Stop Loss diretamente nos servidores da cTrader (server-side execution)
                  if (
                    trailingFloorPrice &&
                    activePos.positionId &&
                    !activePos.positionId.startsWith('pos_') &&
                    trailingFloorPrice !== activePos.lastSyncedFloorPrice
                  ) {
                    activePos.lastSyncedFloorPrice = trailingFloorPrice;
                    if (typeof (adapter as any).amendPositionSLTP === 'function') {
                      const market = (adapter as any).marketsBySymbol?.get(sym);
                      const digits = market?.digits ?? (isGoldPair ? 2 : (isJpyPair ? 3 : 5));
                      const roundedFloorPrice = Number(trailingFloorPrice.toFixed(digits));
                      (adapter as any).amendPositionSLTP(activePos.positionId, roundedFloorPrice).catch((err: any) => {
                        log.warn(`⚠️ [CTRADER-SLTP] Erro ao sincronizar Stop Loss na cTrader (${sym}): ${err.message}`);
                      });
                    }
                  }

                  let currentAction = '⏳ Monitorando mercado';
                  if (activePos.trailingActive) {
                    const retracao = activePos.peakPnlUsd - pnlUsd;
                    currentAction = retracao > 0.01
                      ? `⚠️ Retração em andamento: PnL $${pnlUsd.toFixed(2)} | Piso fechamento: +$${activePos.trailingFloorUsd.toFixed(2)} USD`
                      : `🔒 Trailing Ativo: Pico +$${activePos.peakPnlUsd.toFixed(2)} | Piso fechamento: +$${activePos.trailingFloorUsd.toFixed(2)} USD`;
                  } else {
                    currentAction = `⏳ Monitorando: PnL $${pnlUsd.toFixed(2)} USD (Ativa em +$${profile.trailingActivationUsd.toFixed(2)} USD)`;
                  }

                  // Sincroniza em tempo real com o MongoDB para o Frontend
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

                  const takeProfitTarget = settings.takeProfitPct ?? 0.20;
                  const stopLossTarget = Math.abs(settings.stopLossPct ?? 0.10);

                  const atingiuTP = pnlPct >= takeProfitTarget;
                  const atingiuSL = pnlPct <= -stopLossTarget;
                  const atingiuTrailing = activePos.trailingActive && pnlUsd <= activePos.trailingFloorUsd;

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

                  if (atingiuTP || atingiuSL || atingiuTrailing || reversaoSinalValida) {
                    const reasonType = atingiuTrailing
                      ? 'trailing_stop'
                      : atingiuTP
                        ? 'take_profit'
                        : atingiuSL
                          ? 'stop_loss'
                          : 'signal_reversal';

                    const motivoFechar = atingiuTrailing
                      ? `Trailing USD acionado (Pico: +$${activePos.peakPnlUsd.toFixed(2)}, Piso: +$${activePos.trailingFloorUsd.toFixed(2)}, Atual: $${pnlUsd.toFixed(2)})`
                      : atingiuTP
                        ? `Take Profit atingido (+${pnlPct.toFixed(3)}%)`
                        : atingiuSL
                          ? `Stop Loss atingido (${pnlPct.toFixed(3)}%)`
                          : `Reversão de sinal confirmada no M1 (${Math.round(tempoAbertoMs / 1000)}s)`;

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
                      const vol = activePos.amount || (isGold ? 1 : 1000);
                      const diffPrice = activePos.side === 'BUY' ? (closePrice - activePos.entryPrice) : (activePos.entryPrice - closePrice);
                      const calcGross = isGold
                        ? diffPrice * (vol > 10 ? vol / 100 : vol)
                        : (isJpy && closePrice > 0 ? (diffPrice * vol) / closePrice : diffPrice * vol);
                      const comm = closeRes?.commission != null && Number(closeRes.commission) > 0 ? Number(closeRes.commission) : (isGold ? 0.08 : 0.06);
                      const calcNet = calcGross - comm;

                      const finalPnlUsd = closeRes?.realizedPnl != null && !isNaN(Number(closeRes.realizedPnl)) && Math.abs(Number(closeRes.realizedPnl)) < 100000
                        ? Number(closeRes.realizedPnl)
                        : calcNet;

                      const closeVolume = Number(closeRes?.amount || activePos.amount || 0);
                      const closeAmountUsd = closeVolume > 0 && closePrice > 0 ? amountUsdFor(sym, closeVolume, closePrice) : null;
                      activePositions.delete(sym);
                      log.info(`✅ [POSIÇÃO ENCERRADA] ${sym}! PnL Real cTrader: $${finalPnlUsd.toFixed(2)} | Preço Fechamento: ${closePrice} | Motivo: ${reasonType}`);

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
                            legs: [{ symbol: sym, side: closeSide, price: closePrice, amount: closeVolume, volume: closeVolume, amountUsd: closeAmountUsd, orderId: closeRes?.id }],
                            amount: closeVolume,
                            volume: closeVolume,
                            amountUsd: closeAmountUsd,
                            realizedPnl: finalPnlUsd,
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
                }

                // --- 2. ABERTURA DE NOVA POSIÇÃO QUANDO NÃO HÁ POSIÇÕES ABERTAS ---
                const temPosicaoAbertaNoBanco = await ForexArbStrategy.exists({
                  userId: settings.userId,
                  name: new RegExp(`Scalping ${sym.replace('/', '\\/')}`),
                  positionOpen: true
                });

                if (
                  settings.isScanningEnabled &&
                  settings.autoExecute &&
                  !activePositions.has(sym) &&
                  !temPosicaoAbertaNoBanco &&
                  signal.action !== 'NEUTRAL'
                ) {
                  log.info(`🎯 [SINAL SCALPING DETECTADO] ${sym} -> ${signal.action} | Preço: ${signal.price} | Motivo: ${signal.reason}`);
                  const side = signal.action === 'BUY' ? 'buy' : 'sell';
                  const targetTradeSize = profile.defaultTradeSize || tradeSize;
                  log.info(`🚀 [ORDEM AUTO-SCALPER] Enviando ordem de ${signal.action} para ${sym} (${targetTradeSize} unidades)...`);
                  try {
                    const orderRes = await adapter.createMarketOrder(sym, side, targetTradeSize);
                    const posIdNew = orderRes?.positionId || orderRes?.id || `pos_${Date.now()}`;
                    const volume = Number(orderRes?.amount || 0);
                    const amountUsd = volume > 0 && midPrice > 0 ? amountUsdFor(sym, volume, midPrice) : targetTradeSize;
                    const market = (adapter as any).marketsBySymbol.get(sym);
                    const volumeProtocol = market
                      ? Math.max(1, Math.round((targetTradeSize / (market.lotSize || 100000)) * 100))
                      : 1;

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

                    // Ativa proteções iniciais (SL e TP) na corretora logo na entrada
                    const isGoldPair = sym.includes('XAU');
                    const isJpyPair = sym.endsWith('/JPY') || sym.endsWith('JPY');
                    const digits = market?.digits ?? (isGoldPair ? 2 : (isJpyPair ? 3 : 5));
                    const stopLossPct = Math.abs(settings.stopLossPct ?? 0.10);
                    const takeProfitPct = settings.takeProfitPct ?? 0.20;

                    const initialSL = signal.action === 'BUY'
                      ? execPrice * (1 - stopLossPct / 100)
                      : execPrice * (1 + stopLossPct / 100);

                    const initialTP = signal.action === 'BUY'
                      ? execPrice * (1 + takeProfitPct / 100)
                      : execPrice * (1 - takeProfitPct / 100);

                    const roundedSL = Number(initialSL.toFixed(digits));
                    const roundedTP = Number(initialTP.toFixed(digits));

                    if (posIdNew && !String(posIdNew).startsWith('pos_') && typeof (adapter as any).amendPositionSLTP === 'function') {
                      (adapter as any).amendPositionSLTP(posIdNew, roundedSL, roundedTP).catch((err: any) => {
                        log.warn(`⚠️ [CTRADER-INITIAL-SLTP] Erro ao registrar SL/TP inicial na cTrader (${sym}): ${err.message}`);
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
    await new Promise(r => setTimeout(r, 2000));
  }
}

if (require.main === module) {
  startScalper().catch(err => {
    log.error('Erro fatal no bot de Scalping:', err);
    process.exit(1);
  });
}
