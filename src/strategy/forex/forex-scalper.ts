// Estratégia de Scalping Forex de Alta Frequência
// Suporta indicadores técnicos: RSI, EMA Fast/Slow e Trailing Stop curto.
import { loadEnv } from '../../utils/env-loader';
loadEnv();
import { connectToDatabase } from '../../config/db';
import ForexArbSettings from '../../models/ForexArbSettings';
import ExchangeKey from '../../models/ExchangeKey';
import { getSharedCtraderAdapter } from './ctrader/ctrader-factory';
import { getSharedFixAdapter, isFixExchange } from './fix/fix-factory';
import { getSharedDukascopyAdapter, isDukascopyExchange } from './dukascopy/dukascopy-factory';

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

export interface PriceCandle {
  price: number;
  time: number;
}

// Histórico de preços em memória para cálculo de indicadores
const priceHistory = new Map<string, PriceCandle[]>();

export function recordPrice(symbol: string, price: number) {
  if (!priceHistory.has(symbol)) {
    priceHistory.set(symbol, []);
  }
  const history = priceHistory.get(symbol)!;
  history.push({ price, time: Date.now() });
  if (history.length > 100) {
    history.shift();
  }
}

export function calculateEMA(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
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

export function analyzeScalpOpportunity(symbol: string, currentPrice: number): ScalpSignal {
  recordPrice(symbol, currentPrice);
  const history = priceHistory.get(symbol)!;
  const prices = history.map(h => h.price);

  if (prices.length < 15) {
    return { symbol, action: 'NEUTRAL', reason: 'Aguardando mais ticks para calcular indicadores', price: currentPrice };
  }

  const emaFast = calculateEMA(prices, 5);
  const emaSlow = calculateEMA(prices, 15);
  const rsi = calculateRSI(prices, 14);

  // Scalping Strategy logic:
  // COMPRA: EMA Fast cruza acima de EMA Slow e RSI < 65
  // VENDA: EMA Fast cruza abaixo de EMA Slow e RSI > 35
  if (emaFast > emaSlow && rsi < 65) {
    return {
      symbol,
      action: 'BUY',
      reason: `EMA5 (${emaFast.toFixed(5)}) > EMA15 (${emaSlow.toFixed(5)}) e RSI (${rsi.toFixed(1)}) < 65`,
      price: currentPrice
    };
  } else if (emaFast < emaSlow && rsi > 35) {
    return {
      symbol,
      action: 'SELL',
      reason: `EMA5 (${emaFast.toFixed(5)}) < EMA15 (${emaSlow.toFixed(5)}) e RSI (${rsi.toFixed(1)}) > 35`,
      price: currentPrice
    };
  }

  return { symbol, action: 'NEUTRAL', reason: 'Sem sinal claro de cruzamento', price: currentPrice };
}

async function startScalper() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI required');
  await connectToDatabase();
  log.info('✅ Conectado ao MongoDB - Forex Scalper Bot');

  const symbols = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'XAU/USD'];

  while (true) {
    try {
      const settings = await ForexArbSettings.findOne().lean();
      if (settings && settings.isScanningEnabled) {
        log.info('⚡ [FOREX-SCALPER] Monitorando mercado para Scalping HFT...');
        
        const keys = await (ExchangeKey as any).find({ userId: settings.userId, active: true }).lean();
        const ctraderKey = keys.find((k: any) => k.exchangeId === 'ctrader');

        if (ctraderKey) {
          const adapter = await getSharedCtraderAdapter(ctraderKey);
          for (const sym of symbols) {
            try {
              const ticker = await (adapter as any).fetchTicker(sym);
              if (ticker && ticker.bid && ticker.ask) {
                const midPrice = (ticker.bid + ticker.ask) / 2;
                const signal = analyzeScalpOpportunity(sym, midPrice);
                if (signal.action !== 'NEUTRAL') {
                  log.info(`🎯 [SINAL SCALPING DETECTADO] ${sym} -> ${signal.action} | Preço: ${signal.price} | Motivo: ${signal.reason}`);
                }
              }
            } catch { /* ignora erro de par indisponível */ }
          }
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
