// Estratégia de Scalping Forex de Alta Frequência
// Suporta indicadores técnicos: RSI, EMA Fast/Slow e Trailing Stop curto.
import { loadEnv } from '../../utils/env-loader';
loadEnv();
import { connectToDatabase } from '../../config/db';
import ForexArbSettings from '../../models/ForexArbSettings';
import ForexArbStrategy from '../../models/ForexArbStrategy';
import ForexArbTrade from '../../models/ForexArbTrade';
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

  const prevEmaFast = calculateEMA(prices.slice(0, -1), 5);
  const prevEmaSlow = calculateEMA(prices.slice(0, -1), 15);

  // Exige CRUZAMENTO REAL (crossover no último tick):
  // COMPRA: No tick anterior EMA5 <= EMA15, e no tick atual EMA5 > EMA15 com RSI < 65
  // VENDA: No tick anterior EMA5 >= EMA15, e no tick atual EMA5 < EMA15 com RSI > 35
  const crossoverBuy = prevEmaFast <= prevEmaSlow && emaFast > emaSlow;
  const crossoverSell = prevEmaFast >= prevEmaSlow && emaFast < emaSlow;

  if (crossoverBuy && rsi < 65) {
    return {
      symbol,
      action: 'BUY',
      reason: `Cruzamento de Alta! EMA5 (${emaFast.toFixed(5)}) cruzou acima de EMA15 (${emaSlow.toFixed(5)}) e RSI (${rsi.toFixed(1)}) < 65`,
      price: currentPrice
    };
  } else if (crossoverSell && rsi > 35) {
    return {
      symbol,
      action: 'SELL',
      reason: `Cruzamento de Baixa! EMA5 (${emaFast.toFixed(5)}) cruzou abaixo de EMA15 (${emaSlow.toFixed(5)}) e RSI (${rsi.toFixed(1)}) > 35`,
      price: currentPrice
    };
  }

  return { symbol, action: 'NEUTRAL', reason: 'Sem sinal claro de cruzamento', price: currentPrice };
}

// Controle de posições abertas por símbolo: symbol -> { positionId, side, entryPrice, amount, entryTime, peakPnlPct }
const activePositions = new Map<string, { positionId?: string; side: 'BUY' | 'SELL'; entryPrice: number; amount: number; entryTime: number; peakPnlPct: number }>();

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
          const tradeSize = settings.tradeSize || 100; // Tamanho padrão da ordem em unidades base

          // Sincroniza posições reais da cTrader por símbolo
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
                  activePositions.set(sym, {
                    positionId: posId,
                    side,
                    entryPrice,
                    amount: amount > 0 ? amount : tradeSize,
                    entryTime: Date.now(),
                    peakPnlPct: 0,
                  });
                  log.info(`🔄 [RECONCILE CTRADER] Posição #${posId} detectada na cTrader para ${sym} (${side})`);
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
            const tickers = await (adapter as any).fetchTickers(symbols);
            for (const sym of symbols) {
              const ticker = tickers[sym];
              if (ticker && ticker.bid && ticker.ask) {
                const midPrice = (ticker.bid + ticker.ask) / 2;
                const signal = analyzeScalpOpportunity(sym, midPrice);

                // --- 1. AVALIAÇÃO DE FECHAMENTO (TAKE PROFIT / STOP LOSS / TRAILING STOP) PARA POSIÇÃO EXISTENTE ---
                const activePos = activePositions.get(sym);

                if (activePos) {
                  if (activePos.entryPrice === 0) {
                    activePos.entryPrice = midPrice; // Ajusta preço base de referência se veio da cTrader
                  }

                  const pnlPct = activePos.side === 'BUY'
                    ? ((midPrice - activePos.entryPrice) / activePos.entryPrice) * 100
                    : ((activePos.entryPrice - midPrice) / activePos.entryPrice) * 100;

                  // Atualiza pico de ganho da posição (Peak PnL %)
                  if (pnlPct > activePos.peakPnlPct) {
                    activePos.peakPnlPct = pnlPct;
                  }

                  const atingiuTP = pnlPct >= 0.20; // Take profit máximo fixo em +0.20%
                  const atingiuSL = pnlPct <= -0.10; // Stop loss fixo em -0.10%
                  // Trailing stop: Se o pico ultrapassou +0.10% e recuou 0.05% do topo
                  const atingiuTrailing = activePos.peakPnlPct >= 0.10 && (activePos.peakPnlPct - pnlPct) >= 0.05;
                  const reversaoSinal = signal.action !== 'NEUTRAL' && signal.action !== activePos.side;

                  if (atingiuTP || atingiuSL || atingiuTrailing || reversaoSinal) {
                    const motivoFechar = atingiuTrailing
                      ? `Trailing Stop acionado (Pico: +${activePos.peakPnlPct.toFixed(3)}%, Atual: +${pnlPct.toFixed(3)}%)`
                      : atingiuTP
                        ? `Take Profit atingido (+${pnlPct.toFixed(3)}%)`
                        : atingiuSL
                          ? `Stop Loss atingido (${pnlPct.toFixed(3)}%)`
                          : `Reversão de sinal para ${signal.action}`;

                    const closeSide = activePos.side === 'BUY' ? 'sell' : 'buy';
                    log.info(`🔄 [AUTO-SCALPER CLOSE] Encerrando posição de ${activePos.side} em ${sym}. Motivo: ${motivoFechar}`);

                    try {
                      const closeRes = await adapter.createMarketOrder(sym, closeSide, activePos.amount);
                      const pnlEst = (pnlPct / 100) * activePos.amount;
                      activePositions.delete(sym);
                      log.info(`✅ [POSIÇÃO ENCERRADA COM SUCESSO] ${sym}! PnL: $${pnlEst.toFixed(2)} | Resposta:`, closeRes);

                      try {
                        const existingStrat = await ForexArbStrategy.findOne({
                          userId: settings.userId,
                          name: `Scalping ${sym} (${activePos.side})`,
                          positionOpen: true
                        });

                        if (existingStrat) {
                          existingStrat.positionOpen = false;
                          existingStrat.status = 'closed';
                          existingStrat.active = false;
                          existingStrat.closedAt = new Date();
                          existingStrat.pnl = pnlEst;
                          await existingStrat.save();

                          await ForexArbTrade.create({
                            userId: settings.userId,
                            strategyId: existingStrat._id,
                            strategyName: existingStrat.name,
                            exchangeId: 'ctrader',
                            type: 'close',
                            legs: [{ symbol: sym, side: closeSide, price: midPrice, amount: activePos.amount, orderId: closeRes?.id }],
                            amount: activePos.amount,
                            realizedPnl: pnlEst,
                            status: 'executed',
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

                // --- 2. ABERTURA DE NOVA POSIÇÃO QUANDO NÃO HÁ POSIÇÕES ABERTAS PARA O SÍMBOLO ---
                // Trava estrita de 1 posição ativa por par (Verifica memória + Mongo DB):
                const temPosicaoAbertaNoBanco = await ForexArbStrategy.exists({
                  userId: settings.userId,
                  name: new RegExp(`Scalping ${sym.replace('/', '\\/')}`),
                  positionOpen: true
                });

                if (!activePositions.has(sym) && !temPosicaoAbertaNoBanco && signal.action !== 'NEUTRAL') {
                  log.info(`🎯 [SINAL SCALPING DETECTADO] ${sym} -> ${signal.action} | Preço: ${signal.price} | Motivo: ${signal.reason}`);
                  const side = signal.action === 'BUY' ? 'buy' : 'sell';
                  log.info(`🚀 [ORDEM AUTO-SCALPER] Enviando ordem de ${signal.action} para ${sym} (${tradeSize} unidades)...`);
                  try {
                    const orderRes = await adapter.createMarketOrder(sym, side, tradeSize);
                    const posIdNew = orderRes?.positionId || orderRes?.id || `pos_${Date.now()}`;
                    activePositions.set(sym, {
                      positionId: String(posIdNew),
                      side: signal.action,
                      entryPrice: midPrice,
                      amount: tradeSize,
                      entryTime: Date.now(),
                      peakPnlPct: 0,
                    });
                    log.info(`✅ [ORDEM ABERTA COM SUCESSO] #${posIdNew} ${sym} ${signal.action}! ID/Result:`, orderRes);

                    try {
                      const stratDoc = await ForexArbStrategy.create({
                        userId: settings.userId,
                        exchangeKeyId: ctraderKey._id,
                        name: `Scalping ${sym} (${signal.action})`,
                        exchangeId: 'ctrader',
                        type: 'simple',
                        legs: [{ symbol: sym, side, price: midPrice, amount: tradeSize, orderId: orderRes?.id }],
                        tradeSize,
                        positionOpen: true,
                        positionOpenedAt: new Date(),
                        positionSize: tradeSize,
                        status: 'open',
                        active: true,
                      });

                      await ForexArbTrade.create({
                        userId: settings.userId,
                        strategyId: stratDoc._id,
                        strategyName: stratDoc.name,
                        exchangeId: 'ctrader',
                        type: 'execution',
                        legs: [{ symbol: sym, side, price: midPrice, amount: tradeSize, orderId: orderRes?.id }],
                        amount: tradeSize,
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
          } catch { /* ignora erro de fetch */ }
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
