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

export function analyzeScalpOpportunity(
  symbol: string,
  bid: number,
  ask: number
): ScalpSignal {
  const currentPrice = (bid + ask) / 2;
  
  // 1. Filtro de Spread Máximo (Máximo 0.025%)
  const spreadPct = ((ask - bid) / currentPrice) * 100;
  if (spreadPct > 0.025) {
    return { symbol, action: 'NEUTRAL', reason: `Spread alto (${spreadPct.toFixed(3)}% > 0.025%)`, price: currentPrice };
  }

  // 2. Cooldown de 3 minutos após fechar trade no mesmo par
  const lastTime = lastClosedTradeTime.get(symbol) || 0;
  if (Date.now() - lastTime < 180000) {
    const restSec = Math.ceil((180000 - (Date.now() - lastTime)) / 1000);
    return { symbol, action: 'NEUTRAL', reason: `Em cooldown (${restSec}s restantes)`, price: currentPrice };
  }

  recordPrice(symbol, currentPrice);
  const history = priceHistory.get(symbol)!;
  const prices = history.map(h => h.price);

  if (prices.length < 20) {
    return { symbol, action: 'NEUTRAL', reason: 'Aguardando mais amostragem de preços (min. 20 ticks)', price: currentPrice };
  }

  const emaFast = calculateEMA(prices, 5);
  const emaSlow = calculateEMA(prices, 15);
  const rsi = calculateRSI(prices, 14);

  const prevEmaFast = calculateEMA(prices.slice(0, -1), 5);
  const prevEmaSlow = calculateEMA(prices.slice(0, -1), 15);
  const prev2EmaSlow = calculateEMA(prices.slice(0, -3), 15);

  const crossoverBuy = prevEmaFast <= prevEmaSlow && emaFast > emaSlow;
  const crossoverSell = prevEmaFast >= prevEmaSlow && emaFast < emaSlow;

  // 3. Inclinação da EMA Slow (Tendência do mercado)
  const emaSlowSlope = emaSlow - prev2EmaSlow;

  // 4. Filtro RSI Estrito para evitar exaustão de tendência
  // BUY: Cruzamento de Alta + EMA Slow subindo + RSI entre 45 e 62
  if (crossoverBuy && emaSlowSlope > 0 && rsi >= 45 && rsi <= 62) {
    return {
      symbol,
      action: 'BUY',
      reason: `Cruzamento de Alta com Tendência! EMA5 (${emaFast.toFixed(5)}) > EMA15 (${emaSlow.toFixed(5)}), Inclin: +${emaSlowSlope.toFixed(6)}, RSI: ${rsi.toFixed(1)}`,
      price: currentPrice
    };
  } 
  // SELL: Cruzamento de Baixa + EMA Slow caindo + RSI entre 38 e 55
  else if (crossoverSell && emaSlowSlope < 0 && rsi >= 38 && rsi <= 55) {
    return {
      symbol,
      action: 'SELL',
      reason: `Cruzamento de Baixa com Tendência! EMA5 (${emaFast.toFixed(5)}) < EMA15 (${emaSlow.toFixed(5)}), Inclin: ${emaSlowSlope.toFixed(6)}, RSI: ${rsi.toFixed(1)}`,
      price: currentPrice
    };
  }

  return { symbol, action: 'NEUTRAL', reason: `Sem sinal claro (RSI=${rsi.toFixed(1)}, Slope=${emaSlowSlope.toFixed(6)})`, price: currentPrice };
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
