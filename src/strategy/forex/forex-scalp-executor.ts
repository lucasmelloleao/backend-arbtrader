// Robô 2 - Executor & Gerenciador de Posições de Scalping Forex
// Focado 100% em monitorar ordens detectadas, abrir posições na cTrader e realizar a gestão em tempo real (TP, SL e Trailing Stop)
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
  info: (...args: any[]) => console.log(getTs(), '[FOREX-SCALP-EXECUTOR]', ...args),
  warn: (...args: any[]) => console.warn(getTs(), '[FOREX-SCALP-EXECUTOR]', ...args),
  error: (...args: any[]) => console.error(getTs(), '[FOREX-SCALP-EXECUTOR]', ...args),
};

// Controle local das posições sob gestão: symbol -> { positionId, side, entryPrice, amount, entryTime, peakPnlPct }
const activePositions = new Map<string, { positionId?: string; side: 'BUY' | 'SELL'; entryPrice: number; amount: number; entryTime: number; peakPnlPct: number }>();

async function startScalpExecutor() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI required');
  await connectToDatabase();
  log.info('✅ Conectado ao MongoDB - Forex Scalp Executor Bot (Robô 2)');

  const symbols = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'XAU/USD'];

  while (true) {
    try {
      const settings = await ForexArbSettings.findOne().lean();
      if (settings && settings.isScanningEnabled) {
        log.info('⚡ [FOREX-SCALP-EXECUTOR] Gerenciando e monitorando posições ativas...');

        const keys = await (ExchangeKey as any).find({ userId: settings.userId, active: true }).lean();
        const ctraderKey = keys.find((k: any) => k.exchangeId === 'ctrader');

        if (ctraderKey) {
          const adapter = await getSharedCtraderAdapter(ctraderKey);
          await adapter.loadMarkets();
          const tradeSize = settings.tradeSize || 100;

          // 1. RECONCILE CTRADER: Sincroniza posições reais abertas na cTrader
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
                  log.info(`🔄 [RECONCILE CTRADER] Posição #${posId} sob gestão para ${sym} (${side})`);
                }
              }
            }

            // Remove da gestão se a posição foi fechada na cTrader
            for (const sym of symbols) {
              if (!cTraderOpenSymbols.has(sym) && activePositions.has(sym)) {
                activePositions.delete(sym);
              }
            }
          } catch { /* erro no reconcile */ }

          // 2. BUSCA SINAIS / OPORTUNIDADES PENDENTES GERADAS PELO ROBÔ 1 (SCANNER)
          if (settings.autoExecute) {
            const pendingOpp = await ForexArbTrade.findOne({
              userId: settings.userId,
              type: 'opportunity_found',
              status: 'detected'
            }).sort({ createdAt: 1 });

            if (pendingOpp && pendingOpp.legs && pendingOpp.legs.length > 0) {
              const leg = pendingOpp.legs[0];
              const sym = leg.symbol;
              const side = leg.side as 'buy' | 'sell';

              // Garante que não existe posição ativa para este par antes de abrir
              if (!activePositions.has(sym)) {
                log.info(`🚀 [ORDEM ABERTA PELO ROBÔ 2] Executando sinal para ${sym} (${side.toUpperCase()})...`);
                try {
                  const orderRes = await adapter.createMarketOrder(sym, side, tradeSize);
                  const posIdReal = orderRes?.positionId ? String(orderRes.positionId) : null;
                  const posIdNew = posIdReal || orderRes?.id || `pos_${Date.now()}`;
                  const entryPrice = orderRes?.price || leg.price || 0;

                  activePositions.set(sym, {
                    positionId: String(posIdNew),
                    side: side.toUpperCase() as 'BUY' | 'SELL',
                    entryPrice,
                    amount: tradeSize,
                    entryTime: Date.now(),
                    peakPnlPct: 0,
                  });

                  // Marcar oportunidade como executada
                  pendingOpp.status = 'executed';
                  await pendingOpp.save();

                  // Persiste a nova estratégia ativa no MongoDB com o positionId oficial da cTrader
                  const stratDoc = await ForexArbStrategy.create({
                    userId: settings.userId,
                    exchangeKeyId: ctraderKey._id,
                    name: `Scalping ${sym} (${side.toUpperCase()})`,
                    exchangeId: 'ctrader',
                    type: 'simple',
                    legs: [{ symbol: sym, side, price: entryPrice, amount: tradeSize, orderId: String(posIdNew) }],
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
                    legs: [{ symbol: sym, side, price: entryPrice, amount: tradeSize, orderId: orderRes?.id }],
                    amount: tradeSize,
                    status: 'executed',
                    reason: pendingOpp.reason,
                  });

                  log.info(`✅ [ORDEM EXECUTADA E REGISTRADA COM SUCESSO] #${posIdNew} ${sym} ${side.toUpperCase()}`);

                } catch (execErr: any) {
                  log.error(`❌ [ERRO AO EXECUTAR ORDEM] ${sym}:`, execErr?.message || execErr);
                  pendingOpp.status = 'failed';
                  await pendingOpp.save();
                }
              } else {
                // Se já existir posição aberta, marca a oportunidade antiga como ignorada
                pendingOpp.status = 'skipped';
                await pendingOpp.save();
              }
            }
          }

          // 3. MONITORAMENTO EM TEMPO REAL DAS POSIÇÕES ATIVAS (TP, SL E TRAILING STOP)
          try {
            const tickers = await (adapter as any).fetchTickers(symbols);
            for (const sym of symbols) {
              const ticker = tickers[sym];
              const activePos = activePositions.get(sym);

              if (activePos && ticker && ticker.bid && ticker.ask) {
                const midPrice = (ticker.bid + ticker.ask) / 2;
                if (activePos.entryPrice === 0) activePos.entryPrice = midPrice;

                const pnlPct = activePos.side === 'BUY'
                  ? ((midPrice - activePos.entryPrice) / activePos.entryPrice) * 100
                  : ((activePos.entryPrice - midPrice) / activePos.entryPrice) * 100;

                // Atualiza pico de ganho da posição
                if (pnlPct > activePos.peakPnlPct) {
                  activePos.peakPnlPct = pnlPct;
                }

                const atingiuTP = pnlPct >= 0.20; // Take profit fixo em +0.20%
                const atingiuSL = pnlPct <= -0.10; // Stop loss fixo em -0.10%
                const atingiuTrailing = activePos.peakPnlPct >= 0.10 && (activePos.peakPnlPct - pnlPct) >= 0.05; // Trailing stop

                // Verifica se há sinal de reversão gerado pelo scanner
                const pendingOppReversao = await ForexArbTrade.findOne({
                  userId: settings.userId,
                  type: 'opportunity_found',
                  status: 'detected',
                  'legs.symbol': sym
                });
                const reversaoSinal = pendingOppReversao && pendingOppReversao.legs && pendingOppReversao.legs[0]?.side.toUpperCase() !== activePos.side;

                if (atingiuTP || atingiuSL || atingiuTrailing || reversaoSinal) {
                  const motivoFechar = atingiuTrailing
                    ? `Trailing Stop acionado (Pico: +${activePos.peakPnlPct.toFixed(3)}%, Atual: +${pnlPct.toFixed(3)}%)`
                    : atingiuTP
                      ? `Take Profit atingido (+${pnlPct.toFixed(3)}%)`
                      : atingiuSL
                        ? `Stop Loss atingido (${pnlPct.toFixed(3)}%)`
                        : `Reversão de sinal detectada no mercado`;

                  const closeSide = activePos.side === 'BUY' ? 'sell' : 'buy';
                  log.info(`🔄 [AUTO-SCALPER EXECUTOR CLOSE] Encerrando posição #${activePos.positionId || 'indefinida'} de ${activePos.side} em ${sym}. Motivo: ${motivoFechar}`);

                  try {
                    let closeRes;
                    if (activePos.positionId && !activePos.positionId.startsWith('pos_')) {
                      // Usa fechamento oficial de posição por ProtoOAClosePositionReq da cTrader
                      closeRes = await adapter.closePosition(activePos.positionId, activePos.amount * 100);
                    } else {
                      closeRes = await adapter.createMarketOrder(sym, closeSide, activePos.amount);
                    }

                    const pnlEst = (pnlPct / 100) * activePos.amount;
                    activePositions.delete(sym);
                    log.info(`✅ [POSIÇÃO ENCERRADA PELO ROBÔ 2] ${sym}! PnL: $${pnlEst.toFixed(2)} | Resposta:`, closeRes);

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
            }
          } catch { /* erro no fetchTickers */ }
        }
      }
    } catch (err: any) {
      log.error('❌ Erro no loop do Scalp Executor:', err.message);
    }
    await new Promise(r => setTimeout(r, 1000)); // Execução rápida de 1s
  }
}

if (require.main === module) {
  startScalpExecutor().catch((e) => log.error('🔥 Erro fatal no Scalp Executor:', e.message));
}
