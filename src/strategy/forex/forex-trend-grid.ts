import { loadEnv } from '../../utils/env-loader';
loadEnv();
import { connectToDatabase } from '../../config/db';
import ForexArbSettings from '../../models/ForexArbSettings';
import ForexArbStrategy from '../../models/ForexArbStrategy';
import ForexArbTrade from '../../models/ForexArbTrade';
import ExchangeKey from '../../models/ExchangeKey';
import BotStatus from '../../models/BotStatus';
import { getSharedCtraderAdapter } from './ctrader/ctrader-factory';
import logger from '../../utils/logger';

const log = logger.child({ module: 'forex-trend-grid' });

export interface GridPosition {
  id: string | number;
  positionId?: string;
  orderId?: string;
  entryPrice: number;
  volume: number;
  side: 'BUY' | 'SELL';
  createdAt: number;
}

export class TrendGridEngine {
  public symbol: string;
  public side: 'BUY' | 'SELL';
  public lotSize: number;
  public pipSize: number;
  public stepPips: number;
  public trailingPips: number;
  public maxGridLevels: number;
  public positions: GridPosition[] = [];
  public highestPrice: number = 0;
  public lowestPrice: number = Infinity;
  public globalTrailingStop: number | null = null;
  public isPendingOrder: boolean = false;

  constructor(config: {
    symbol: string;
    side: 'BUY' | 'SELL';
    lotSize?: number;
    pipSize?: number;
    stepPips?: number;
    trailingPips?: number;
    maxGridLevels?: number;
  }) {
    this.symbol = config.symbol;
    this.side = config.side;
    this.lotSize = config.lotSize || 0.01;
    this.pipSize = config.pipSize || (this.symbol.includes('JPY') ? 0.01 : 0.0001);
    this.stepPips = config.stepPips || 15;
    this.trailingPips = config.trailingPips || 10;
    this.maxGridLevels = config.maxGridLevels || 5;
  }

  // Preço médio ponderado pelo volume de todas as ordens abertas na grade
  public getWeightedAveragePrice(): number {
    if (this.positions.length === 0) return 0;
    const totalVolume = this.positions.reduce((acc, p) => acc + p.volume, 0);
    const totalCost = this.positions.reduce((acc, p) => acc + (p.entryPrice * p.volume), 0);
    return totalVolume > 0 ? totalCost / totalVolume : 0;
  }

  // Processa o tick em tempo real para expansão da grade ou encerramento pelo Trailing Stop Global
  public onTick(
    bid: number,
    ask: number,
    onOpenOrder: (side: 'BUY' | 'SELL', marketPrice: number) => Promise<GridPosition | null>,
    onCloseAll: (reason: string) => Promise<void>
  ): { action: 'NONE' | 'EXPAND' | 'CLOSE_TRAILING'; details?: any } {
    if (this.positions.length === 0 || this.isPendingOrder) return { action: 'NONE' };

    const currentPrice = this.side === 'BUY' ? bid : ask;
    const stepDistance = this.stepPips * this.pipSize;
    const trailingDistance = this.trailingPips * this.pipSize;

    if (this.side === 'BUY') {
      const lastEntry = this.positions[this.positions.length - 1].entryPrice;

      // 1. Condição de Expansão (Pyramiding): preço avançou X pips a favor da última entrada
      if (
        currentPrice >= lastEntry + stepDistance &&
        this.positions.length < this.maxGridLevels
      ) {
        this.isPendingOrder = true;
        onOpenOrder('BUY', ask)
          .then((newPos) => {
            if (newPos) {
              this.positions.push(newPos);
              this.highestPrice = ask;
              log.info(`📊 [GRID BUY EXPANDIDO] ${this.symbol}: nível ${this.positions.length}/${this.maxGridLevels} @ ${ask}. Média: ${this.getWeightedAveragePrice().toFixed(5)}`);
            }
          })
          .finally(() => {
            this.isPendingOrder = false;
          });
        return { action: 'EXPAND', details: { level: this.positions.length + 1, price: ask } };
      }

      // 2. Trailing Stop Global: marca d'água de preço mais alto
      if (currentPrice > this.highestPrice) {
        this.highestPrice = currentPrice;
        const avgPrice = this.getWeightedAveragePrice();
        const candidateStop = this.highestPrice - trailingDistance;

        // Ativa ou eleva o Trailing Stop apenas se proteger acima do Break-Even (Preço Médio Ponderado)
        if (candidateStop > avgPrice) {
          this.globalTrailingStop = Math.max(this.globalTrailingStop || 0, candidateStop);
        }
      }

      // 3. Verificação de Saída: preço recuou e tocou o Trailing Stop Global
      if (this.globalTrailingStop !== null && currentPrice <= this.globalTrailingStop) {
        onCloseAll(`Trailing Stop Global Atingido (Piso: ${this.globalTrailingStop.toFixed(5)}, Preço: ${currentPrice.toFixed(5)})`);
        return { action: 'CLOSE_TRAILING', details: { floor: this.globalTrailingStop, currentPrice } };
      }
    } else if (this.side === 'SELL') {
      const lastEntry = this.positions[this.positions.length - 1].entryPrice;

      // 1. Expansão para venda (preço caindo a favor)
      if (
        currentPrice <= lastEntry - stepDistance &&
        this.positions.length < this.maxGridLevels
      ) {
        this.isPendingOrder = true;
        onOpenOrder('SELL', bid)
          .then((newPos) => {
            if (newPos) {
              this.positions.push(newPos);
              this.lowestPrice = bid;
              log.info(`📊 [GRID SELL EXPANDIDO] ${this.symbol}: nível ${this.positions.length}/${this.maxGridLevels} @ ${bid}. Média: ${this.getWeightedAveragePrice().toFixed(5)}`);
            }
          })
          .finally(() => {
            this.isPendingOrder = false;
          });
        return { action: 'EXPAND', details: { level: this.positions.length + 1, price: bid } };
      }

      // 2. Trailing Stop Global para venda
      if (currentPrice < this.lowestPrice) {
        this.lowestPrice = currentPrice;
        const avgPrice = this.getWeightedAveragePrice();
        const candidateStop = this.lowestPrice + trailingDistance;

        if (candidateStop < avgPrice) {
          this.globalTrailingStop = this.globalTrailingStop === null
            ? candidateStop
            : Math.min(this.globalTrailingStop, candidateStop);
        }
      }

      // 3. Verificação de Saída para venda
      if (this.globalTrailingStop !== null && currentPrice >= this.globalTrailingStop) {
        onCloseAll(`Trailing Stop Global Atingido (Teto: ${this.globalTrailingStop.toFixed(5)}, Preço: ${currentPrice.toFixed(5)})`);
        return { action: 'CLOSE_TRAILING', details: { floor: this.globalTrailingStop, currentPrice } };
      }
    }

    return { action: 'NONE' };
  }
}

// Rastreamento em memória das grades ativas e histórico recente de cotações por símbolo
const activeGridEngines = new Map<string, { engine: TrendGridEngine; strategyId: string }>();
const priceHistories = new Map<string, number[]>();

export async function runTrendGridLoop() {
  const symbols = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'BTC/USD', 'XAU/USD', 'NAS100', 'US30', 'GER40'];
  log.info('🚀 [TREND GRID BOT] Conectando ao banco de dados e iniciando motor de Piramidagem...');
  await connectToDatabase();

  while (true) {
    try {
      const settings = await ForexArbSettings.findOne().lean();
      if (!settings || !settings.userId) {
        if (Math.random() < 0.05) log.warn('⚠️ [TREND GRID] Configurações de Forex (ForexArbSettings) não encontradas no banco.');
      } else {
        if (settings.gridEnabled === false) {
          await ForexArbSettings.updateOne({ _id: settings._id }, { $set: { gridEnabled: true } });
          settings.gridEnabled = true;
          log.info('✅ [TREND GRID] Robô Trend Grid HABILITADO no banco de dados!');
        }

        // Atualiza o Heartbeat do bot para o frontend exibir ONLINE (forex-arb, forex-trend-grid, forex-scalper)
        await (BotStatus as any).updateOne(
          { userId: String(settings.userId), botName: { $in: ['forex-trend-grid', 'forex-scalper', 'forex-arb'] } },
          { $set: { lastHeartbeat: new Date(), botName: 'forex-arb' } },
          { upsert: true }
        ).catch(() => {});

        const keys = await ExchangeKey.find({ userId: settings.userId, active: true }).lean();
        const ctraderKey = keys.find((k: any) => k.exchangeId === 'ctrader');

        if (!ctraderKey) {
          if (Math.random() < 0.05) log.warn('⚠️ [TREND GRID] Chave cTrader ativa não encontrada para o usuário.');
        } else {
          const adapter = await getSharedCtraderAdapter(ctraderKey);
          const tickers = await adapter.fetchTickers(symbols);

          for (const sym of symbols) {
            const ticker = tickers[sym];
            if (!ticker || !ticker.bid || !ticker.ask) continue;

            if (Date.now() % 10000 < 500 && sym === 'EUR/USD') {
              const totalGrids = activeGridEngines.size;
              if (totalGrids > 0) {
                log.info(`⚡ [TREND GRID OPERANDO] ${totalGrids} grade(s) ativa(s) sendo monitorada(s) | Tick ${sym}: ${ticker.bid}/${ticker.ask}`);
              } else {
                log.info(`⏳ [TREND GRID AGUARDANDO] Motor ativo | Cotações fluindo (${sym}: ${ticker.bid}/${ticker.ask}) | Aguardando iniciar nova grade no painel...`);
              }
            }

            // Sincroniza/Restaura estratégias de grade ativas no MongoDB para a memória
            const dbGridStrategies = await ForexArbStrategy.find({
              userId: settings.userId,
              type: 'trend_grid',
              positionOpen: true,
              active: true
            }).lean();

            for (const strat of dbGridStrategies) {
              const symName = strat.legs?.[0]?.symbol;
              if (symName && !activeGridEngines.has(symName)) {
                const side = (strat.legs?.[0]?.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL';
                const engine = new TrendGridEngine({
                  symbol: symName,
                  side,
                  lotSize: strat.tradeSize || 0.01,
                  stepPips: strat.gridStepPips || 15,
                  trailingPips: strat.gridTrailingPips || 10,
                  maxGridLevels: strat.maxGridLevels || 5,
                });

                if (strat.gridPositions && strat.gridPositions.length > 0) {
                  engine.positions = strat.gridPositions;
                  if (side === 'BUY') {
                    engine.highestPrice = Math.max(...strat.gridPositions.map((p: any) => p.entryPrice));
                  } else {
                    engine.lowestPrice = Math.min(...strat.gridPositions.map((p: any) => p.entryPrice));
                  }
                }
                if (strat.globalTrailingStopPrice) {
                  engine.globalTrailingStop = strat.globalTrailingStopPrice;
                }

                activeGridEngines.set(symName, { engine, strategyId: (strat as any)._id.toString() });
                log.info(`🔄 [GRID RESTAURADO] Estratégia de grade ativa restaurada do banco para ${symName} (${side}) com ${engine.positions.length} posições.`);
              }
            }

            // AUTO-DETECÇÃO DE OPORTUNIDADES (ENTRADA AUTOMÁTICA):
            // Se o ativo não possui grade ativa e o robô está habilitado, analisa a micro-tendência para iniciar nova grade
            if (!activeGridEngines.has(sym) && settings.gridEnabled !== false) {
              const priceHistory = priceHistories.get(sym) || [];
              const midPrice = (ticker.bid + ticker.ask) / 2;
              priceHistory.push(midPrice);
              if (priceHistory.length > 20) priceHistory.shift();
              priceHistories.set(sym, priceHistory);

              if (priceHistory.length >= 10) {
                const firstPrice = priceHistory[0];
                const lastPrice = priceHistory[priceHistory.length - 1];
                const deltaPips = (lastPrice - firstPrice) / (sym.includes('JPY') ? 0.01 : 0.0001);
                
                // Critério de Tendência Autônoma: variação mínima de 3 pips nos últimos 10-20 ticks
                if (Math.abs(deltaPips) >= 3.0) {
                  const autoSide: 'BUY' | 'SELL' = deltaPips > 0 ? 'BUY' : 'SELL';
                  log.info(`🎯 [TREND GRID AUTO-DETECT] Oportunidade detectada em ${sym}! Tendência de ${autoSide} (${deltaPips.toFixed(1)} pips). Abrindo grade automática...`);

                  try {
                    const lotSize = settings.lotSize || 0.01;
                    const volUnits = lotSize * 100000;
                    const orderRes = await adapter.createMarketOrder(sym, autoSide.toLowerCase() as 'buy' | 'sell', volUnits);
                    const posId = orderRes?.positionId || orderRes?.id || Date.now().toString();
                    const entryPrice = orderRes?.price ? Number(orderRes.price) : (autoSide === 'BUY' ? ticker.ask : ticker.bid);

                    const firstPos: GridPosition = {
                      id: posId,
                      positionId: String(posId),
                      orderId: orderRes?.id ? String(orderRes.id) : String(posId),
                      entryPrice,
                      volume: lotSize,
                      side: autoSide,
                      createdAt: Date.now(),
                    };

                    const newStrat = await ForexArbStrategy.create({
                      userId: settings.userId,
                      name: `TrendGrid Auto ${sym} (${autoSide})`,
                      type: 'trend_grid',
                      tradeSize: lotSize,
                      gridStepPips: 15,
                      gridTrailingPips: 10,
                      maxGridLevels: 5,
                      positionOpen: true,
                      active: true,
                      legs: [{ symbol: sym, side: autoSide, exchangeId: 'ctrader' }],
                      gridPositions: [firstPos],
                      weightedAvgPrice: entryPrice,
                      gridLevelsCount: 1,
                      currentPrice: midPrice,
                      currentAction: `🚀 Grade Autônoma Iniciada (Nível 1/5 @ ${entryPrice})`,
                    });

                    const engine = new TrendGridEngine({
                      symbol: sym,
                      side: autoSide,
                      lotSize,
                      stepPips: 15,
                      trailingPips: 10,
                      maxGridLevels: 5,
                    });
                    engine.positions = [firstPos];
                    if (autoSide === 'BUY') engine.highestPrice = entryPrice;
                    else engine.lowestPrice = entryPrice;

                    activeGridEngines.set(sym, { engine, strategyId: (newStrat as any)._id.toString() });
                    log.info(`✅ [TREND GRID AUTO INICIADO] Nova grade criada com sucesso para ${sym} (${autoSide}) @ ${entryPrice}`);
                  } catch (err: any) {
                    log.error(`❌ [TREND GRID AUTO ERROR] Falha ao iniciar grade autônoma para ${sym}: ${err.message}`);
                  }
                }
              }
            }

            const gridData = activeGridEngines.get(sym);

            if (gridData) {
              const { engine, strategyId } = gridData;

              engine.onTick(
                ticker.bid,
                ticker.ask,
                async (side, marketPrice) => {
                  try {
                    const vol = engine.lotSize * 100000;
                    const orderRes = await adapter.createMarketOrder(sym, side.toLowerCase() as 'buy' | 'sell', vol);
                    const posId = orderRes?.positionId || orderRes?.id || Date.now().toString();

                    const newPos: GridPosition = {
                      id: posId,
                      positionId: String(posId),
                      orderId: orderRes?.id ? String(orderRes.id) : String(posId),
                      entryPrice: orderRes?.price ? Number(orderRes.price) : marketPrice,
                      volume: engine.lotSize,
                      side,
                      createdAt: Date.now(),
                    };

                    await ForexArbStrategy.findByIdAndUpdate(strategyId, {
                      $push: { gridPositions: newPos },
                      $set: {
                        weightedAvgPrice: engine.getWeightedAveragePrice(),
                        gridLevelsCount: engine.positions.length + 1,
                        currentPrice: marketPrice,
                      }
                    });

                    return newPos;
                  } catch (err: any) {
                    log.error(`❌ [GRID ORDER ERROR] Falha ao enviar ordem no grid para ${sym}: ${err.message}`);
                    return null;
                  }
                },
                async (reason) => {
                  log.info(`🔒 [GRID CLOSE ALL] Fechando todas as ordens da grade de ${sym}. Motivo: ${reason}`);
                  try {
                    for (const pos of engine.positions) {
                      if (pos.positionId) {
                        const volumeProtocol = Math.round(pos.volume * 100);
                        await adapter.closePosition(pos.positionId, volumeProtocol).catch(() => {});
                      }
                    }

                    const avgPrice = engine.getWeightedAveragePrice();
                    const closePrice = engine.side === 'BUY' ? ticker.bid : ticker.ask;
                    const priceDiff = engine.side === 'BUY' ? (closePrice - avgPrice) : (avgPrice - closePrice);
                    const totalVolume = engine.positions.reduce((acc, p) => acc + p.volume, 0);
                    const realizedPnl = priceDiff * totalVolume * 100000;

                    await ForexArbStrategy.findByIdAndUpdate(strategyId, {
                      positionOpen: false,
                      status: 'closed',
                      closedReason: 'grid_trailing_stop',
                      trailingStopTriggered: true,
                      active: false,
                      closedAt: new Date(),
                      pnl: realizedPnl,
                    });

                    await ForexArbTrade.create({
                      userId: settings.userId,
                      strategyId,
                      strategyName: `TrendGrid ${sym} (${engine.side})`,
                      exchangeId: 'ctrader',
                      type: 'close',
                      amount: totalVolume * 100000,
                      volume: totalVolume,
                      realizedPnl,
                      status: 'executed',
                      closedReason: 'grid_trailing_stop',
                      reason,
                    });

                    activeGridEngines.delete(sym);
                  } catch (closeErr: any) {
                    log.error(`❌ [GRID CLOSE ERROR] Erro ao fechar grade de ${sym}: ${closeErr.message}`);
                  }
                }
              );

              if (engine.positions.length > 0) {
                const mid = (ticker.bid + ticker.ask) / 2;
                await ForexArbStrategy.findByIdAndUpdate(strategyId, {
                  currentPrice: mid,
                  globalTrailingStopPrice: engine.globalTrailingStop,
                  weightedAvgPrice: engine.getWeightedAveragePrice(),
                  currentAction: engine.globalTrailingStop
                    ? `🔒 Trailing Stop Global (Nível ${engine.positions.length}/${engine.maxGridLevels} | Piso: ${engine.globalTrailingStop.toFixed(5)})`
                    : `📈 Grade Expandindo (Nível ${engine.positions.length}/${engine.maxGridLevels} | Méd: ${engine.getWeightedAveragePrice().toFixed(5)})`,
                }).catch(() => {});
              }
            }
          }
        }
      }
    } catch (err: any) {
      log.error(`⚠️ Erro no ciclo do Trend Grid: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, 500));
  }
}

if (require.main === module) {
  runTrendGridLoop().catch(err => log.error('Erro fatal no motor Trend Grid:', err));
}


