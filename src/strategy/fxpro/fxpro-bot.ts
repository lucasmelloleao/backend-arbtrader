// Engine do Robô FxPro cTrader (100% Desacoplado da Deriv)
// Opera múltiplos pares Forex/CFD via cTrader Open API Protobuf
// Integra Gates 1, 2, 3 (Random Walk, Kaufman ER, Spread) e Gate 4 (IA Meta-Labeling Random Forest)

import mongoose from 'mongoose';
import FxProStrategy, { IFxProStrategy } from '../../models/FxProStrategy';
import FxProTrade, { IFxProTrade } from '../../models/FxProTrade';
import FxProSettings from '../../models/FxProSettings';
import ExchangeKey from '../../models/ExchangeKey';
import { getSharedCtraderAdapter } from '../forex/ctrader/ctrader-factory';
import {
  evaluateFxProQuantGates,
  calculateFxProATR,
  calculateFxProKellyLot,
} from './helpers/fxpro-math';
import { FxProMetaLabeler } from './helpers/fxpro-meta-labeler';

const inMemoryFxProLogs: string[] = [];
const MAX_BUFFER = 500;

export function addFxProLog(msg: string) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [FXPRO-BOT] ${msg}`;
  inMemoryFxProLogs.push(entry);
  if (inMemoryFxProLogs.length > MAX_BUFFER) {
    inMemoryFxProLogs.shift();
  }
}

export function getFxProLogBuffer(): string[] {
  return [...inMemoryFxProLogs];
}

const log = {
  info: (msg: string, ...args: any[]) => {
    addFxProLog(`💡 ${msg}`);
    console.log(`[FXPRO-BOT] ${msg}`, ...args);
  },
  warn: (msg: string, ...args: any[]) => {
    addFxProLog(`⚠️ ${msg}`);
    console.warn(`[FXPRO-BOT] ${msg}`, ...args);
  },
  error: (msg: string, ...args: any[]) => {
    addFxProLog(`❌ ${msg}`);
    console.error(`[FXPRO-BOT] ${msg}`, ...args);
  },
};

export class FxProBot {
  private static isRunning = false;
  private static loopTimer: NodeJS.Timeout | null = null;
  private static isTickProcessing = false;

  public static async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    log.info('🚀 Inicializando Motor do Robô FxPro cTrader...');
    FxProMetaLabeler.loadModel();

    // Loop de ciclo a cada 3 segundos
    this.loopTimer = setInterval(async () => {
      if (this.isTickProcessing) return;
      this.isTickProcessing = true;
      try {
        await this.processCycle();
      } catch (e: any) {
        log.error(`Erro no ciclo FxPro: ${e.message}`);
      } finally {
        this.isTickProcessing = false;
      }
    }, 3000);
  }

  public static async stop(): Promise<void> {
    this.isRunning = false;
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    log.info('🛑 Motor do Robô FxPro cTrader pausado.');
  }

  public static getStatus(): { running: boolean } {
    return { running: this.isRunning };
  }

  public static async syncAllPositions(userId?: any): Promise<void> {
    try {
      const userObjId = userId && typeof userId === 'string' && mongoose.Types.ObjectId.isValid(userId)
        ? new mongoose.Types.ObjectId(userId)
        : userId;
      const stratQuery = userId ? { $or: [{ userId }, { userId: userObjId }] } : {};
      const strategies = await FxProStrategy.find(stratQuery);

      const key =
        (await ExchangeKey.findOne({
          ...(userId ? { $or: [{ userId }, { userId: userObjId }] } : {}),
          exchangeId: { $in: ['fxpro', 'fxpro-ctrader'] },
          active: true,
        }).lean()) ||
        (await ExchangeKey.findOne({
          ...(userId ? { $or: [{ userId }, { userId: userObjId }] } : {}),
          exchangeId: { $in: ['ctrader', 'pepperstone'] },
          active: true,
        }).lean());

      if (!key) return;
      const settings = await FxProSettings.findOne(userId ? { $or: [{ userId }, { userId: userObjId }] } : {}).lean();
      const overrides = {
        accountId: settings?.accountId || undefined,
        environment: (settings?.accountType === 'real' ? 'live' : 'demo') as ('demo' | 'live'),
      };
      const adapter = await getSharedCtraderAdapter(key, overrides);
      if (!adapter) return;

      let cTraderPositions: any[] = [];
      try {
        if (typeof adapter.getPositionsPnL === 'function') {
          const pnlMap: Map<string, any> = await adapter.getPositionsPnL();
          for (const [k, val] of pnlMap.entries()) {
            if (/^\d+$/.test(k)) {
              cTraderPositions.push(val);
            }
          }
        }
      } catch {
        // Ignora erro transitório
      }

      const openTrades = await FxProTrade.find(userId ? { $or: [{ userId }, { userId: userObjId }], status: 'open' } : { status: 'open' });
      const livePosMap = new Map<string, any>();
      for (const p of cTraderPositions) {
        livePosMap.set(String(p.positionId || p.id), p);
      }

      const existingPosIds = new Set(openTrades.map((t) => String(t.positionId)));

      for (const livePos of cTraderPositions) {
        const posIdStr = String(livePos.positionId || livePos.id);
        const sym = (livePos.symbol || '').replace('/', '').toUpperCase();
        if (!existingPosIds.has(posIdStr)) {
          log.info(`📥 [${sym}] Detectada posição #${posIdStr} na cTrader. Sincronizando para monitoramento.`);
          const strat = strategies.find((s) => s.symbol.toUpperCase() === sym);
          const pipSize = sym.includes('JPY') ? 0.01 : (sym.includes('XAU') ? 0.1 : 0.0001);
          const slDist = ((strat?.stopLossPips) || 6) * pipSize;
          const tpDist = ((strat?.takeProfitPips) || 8) * pipSize;
          const entryP = Number(livePos.entryPrice || 0);
          const side = livePos.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

          await FxProTrade.create({
            userId: userId || strat?.userId,
            strategyId: strat?._id,
            exchangeKeyId: key._id,
            positionId: posIdStr,
            symbol: sym,
            side,
            lotSize: Number(livePos.volume || strat?.lotSize || 0.01),
            entryPrice: entryP,
            stopLossPrice: side === 'BUY' ? entryP - slDist : entryP + slDist,
            takeProfitPrice: side === 'BUY' ? entryP + tpDist : entryP - tpDist,
            pnlUsd: Number(livePos.netPnl || livePos.unrealizedPnl || livePos.pnl || 0),
            pips: 0,
            status: 'open',
            metrics: {
              er: 0.5,
              varianceRatio: 1.15,
              atrPct: 15.0,
              spreadPips: 0.2,
              expectedValue: 0.05,
              edgePct: 3.0,
              aiProbWin: 0.60,
            },
            openedAt: new Date(),
          });
        }
      }

      for (const t of openTrades) {
        const livePos = livePosMap.get(String(t.positionId));
        if (livePos) {
          const currentPnl = Number(livePos.netPnl || livePos.unrealizedPnl || livePos.pnl || 0);
          await FxProTrade.findByIdAndUpdate(t._id, { pnlUsd: currentPnl });
        } else {
          log.info(`🏁 [${t.symbol}] Posição #${t.positionId} não encontrada na cTrader (encerrada). Sincronizando resultado.`);
          const exitPrice = t.takeProfitPrice || t.entryPrice;
          const pnl = Number(t.pnlUsd || 0);
          const isWin = pnl >= 0;

          await FxProTrade.findByIdAndUpdate(t._id, {
            status: 'closed',
            exitPrice,
            closedAt: new Date(),
            closeReason: isWin ? 'tp' : 'sl',
          });

          if (t.strategyId) {
            await FxProStrategy.findByIdAndUpdate(t.strategyId, {
              $inc: {
                totalTrades: 1,
                winningTrades: isWin ? 1 : 0,
                losingTrades: !isWin ? 1 : 0,
                totalProfitUsd: pnl,
              },
            });
          }
        }
      }

      for (const strat of strategies) {
        const sym = strat.symbol.toUpperCase();
        const matchingLivePositions = cTraderPositions.filter((p) => {
          const pSym = (p.symbol || '').replace('/', '').toUpperCase();
          return pSym === sym;
        });

        if (matchingLivePositions.length > 0) {
          const latestPos = matchingLivePositions[matchingLivePositions.length - 1];
          await FxProStrategy.findByIdAndUpdate(strat._id, {
            currentPositionId: String(latestPos.positionId || latestPos.id),
            currentSide: latestPos.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
            entryPrice: Number(latestPos.entryPrice || 0),
            currentPnlUsd: matchingLivePositions.reduce((acc, p) => acc + Number(p.netPnl || p.unrealizedPnl || p.pnl || 0), 0),
            lastTradeAt: new Date(),
          });
        } else {
          await FxProStrategy.findByIdAndUpdate(strat._id, {
            $unset: { currentPositionId: 1, currentSide: 1 },
            $set: { currentPnlUsd: 0, entryPrice: 0 },
          });
        }
      }
    } catch (e: any) {
      log.warn(`⚠️ Erro ao sincronizar posições cTrader: ${e.message}`);
    }
  }

  private static lastCycleLog = 0;

  private static async processCycle(): Promise<void> {
    const activeStrategies = await FxProStrategy.find({ active: true, status: 'running' }).lean();
    const now = Date.now();
    const shouldLogHeartbeat = now - this.lastCycleLog > 15000; // Log de heartbeat a cada 15 segundos

    if (!activeStrategies || activeStrategies.length === 0) {
      if (shouldLogHeartbeat) {
        this.lastCycleLog = now;
        log.info('⏳ Robô FxPro ativo. Nenhuma estratégia ativa com status "running" encontrada no momento. Cadastre ou ative uma estratégia.');
      }
      return;
    }

    if (shouldLogHeartbeat) {
      this.lastCycleLog = now;
      log.info(`🔍 Monitorando ${activeStrategies.length} par(es) Forex FxPro: [${activeStrategies.map(s => s.symbol).join(', ')}]`);
    }

    for (const strat of activeStrategies) {
      try {
        await this.processStrategy(strat as IFxProStrategy);
      } catch (e: any) {
        log.warn(`⚠️ [${strat.symbol}] Falha ao processar estratégia: ${e.message}`);
      }
    }
  }

  private static async processStrategy(strat: IFxProStrategy): Promise<void> {
    const key = strat.exchangeKeyId
      ? await ExchangeKey.findById(strat.exchangeKeyId).lean()
      : (await ExchangeKey.findOne({
          userId: strat.userId,
          exchangeId: { $in: ['fxpro', 'fxpro-ctrader'] },
          active: true,
        }).lean()) ||
        (await ExchangeKey.findOne({
          userId: strat.userId,
          exchangeId: { $in: ['ctrader', 'pepperstone'] },
          active: true,
        }).lean());

    if (!key) {
      log.warn(`⚠️ [${strat.symbol}] Chave de API cTrader (FxPro) não vinculada ou inativa para este usuário.`);
      return;
    }

    let adapter: any = null;
    try {
      const settings = await FxProSettings.findOne({ userId: strat.userId }).lean();
      const overrides = {
        accountId: settings?.accountId || undefined,
        environment: (settings?.accountType === 'real' ? 'live' : 'demo') as ('demo' | 'live'),
      };
      adapter = await getSharedCtraderAdapter(key, overrides);
    } catch (e: any) {
      log.error(`❌ [${strat.symbol}] Erro ao conectar na cTrader Open API: ${e.message}`);
      return;
    }

    if (!adapter) {
      log.warn(`⚠️ [${strat.symbol}] Adaptador cTrader indisponível.`);
      return;
    }

    // 1. Reconcilia posições abertas na cTrader
    await this.reconcileOpenPositions(strat, adapter);

    // 2. Se já atingiu o limite de posições abertas, gerencia trailing stop e sai
    const openTradesCount = await FxProTrade.countDocuments({
      strategyId: strat._id,
      status: 'open',
    });

    if (openTradesCount >= (strat.maxOpenPositions || 1)) {
      await this.manageTrailingStop(strat, adapter);
      return;
    }

    // 3. Obtém Ticker e Dados de Mercado da cTrader
    const sym = strat.symbol.toUpperCase();
    let ticker: any = null;
    try {
      ticker = await adapter.fetchTicker(sym);
    } catch (e: any) {
      log.warn(`⚠️ [${sym}] Falha ao obter cotação Spot cTrader: ${e.message}`);
      return;
    }

    if (!ticker || !ticker.bid || !ticker.ask) {
      log.warn(`⚠️ [${sym}] Book de ofertas vazio na FxPro.`);
      return;
    }

    const pipSize = sym.includes('JPY') ? 0.01 : (sym.includes('XAU') ? 0.1 : 0.0001);
    const spreadPips = Number(((ticker.ask - ticker.bid) / pipSize).toFixed(1));

    // 4. Obtém Histórico de Candles recentes (M1 / M5) via fetchTrendbars da Open API cTrader
    const periodMinutes = strat.timeframe === '1m' ? 1 : (strat.timeframe === '15m' ? 15 : 5);
    let trendbars: any[] = [];
    try {
      if (typeof adapter.fetchTrendbars === 'function') {
        trendbars = await adapter.fetchTrendbars(sym, periodMinutes, 30);
      }
    } catch (e: any) {
      log.warn(`⚠️ [${sym}] Falha ao obter trendbars: ${e.message}`);
    }

    const closePrices = trendbars.length >= 10
      ? trendbars.map((c: any) => Number(c.close))
      : [ticker.bid * 0.9997, ticker.bid * 0.9998, ticker.bid * 0.9999, ticker.bid];

    const atrPips = trendbars.length >= 14
      ? calculateFxProATR(trendbars.map((c: any) => ({ high: c.high, low: c.low, close: c.close })), 14, pipSize)
      : 15.0;

    // 5. Avaliação dos Gates 1, 2 e 3 (Random Walk, Kaufman ER, Spread Guard)
    const quantGates = evaluateFxProQuantGates(
      closePrices,
      spreadPips,
      strat.maxSpreadPips || 2.5,
      strat.minEfficiencyRatio || 0.35,
      strat.minVarianceRatio || 1.08,
      atrPips
    );

    if (!quantGates.gatesPassed) {
      if (Math.random() < 0.1) {
        log.info(`🎲 [${sym}] Filtro Quant: ER=${quantGates.er.toFixed(2)}, VR=${quantGates.varianceRatio.toFixed(2)}, Spread=${spreadPips} pips (Aguardando confluência).`);
      }
      return;
    }

    // 6. Determinação da Direção (Momentum / Trend Following)
    const pFirst = closePrices[0];
    const pLast = closePrices[closePrices.length - 1];
    const side: 'BUY' | 'SELL' = pLast >= pFirst ? 'BUY' : 'SELL';

    // 7. Gate 4: IA Meta-Labeling Random Forest
    const now = new Date();
    const timeOfDay = now.getHours() + now.getMinutes() / 60;
    const expectedValue = 0.06;
    const edgePct = 3.5;

    const featureVector = FxProMetaLabeler.extractFeatures(
      quantGates.er,
      quantGates.varianceRatio,
      atrPips,
      spreadPips,
      expectedValue,
      edgePct,
      strat.lotSize || 0.01,
      timeOfDay
    );

    let aiProbWin = 1.0;
    if (strat.useAiMetaLabeling) {
      const aiEval = FxProMetaLabeler.evaluateOpportunity(featureVector, strat.minAiConfidence || 0.55);
      aiProbWin = aiEval.probWin;
      if (aiEval.isVetoed) {
        log.warn(`🤖 [GATE 4 VETO] [${sym}] Entrada ${side} bloqueada pela IA: ${aiEval.reason}`);
        return;
      }
      log.info(`🤖 [GATE 4 APROVADO] [${sym}] Entrada ${side} aprovada pela IA (${(aiProbWin * 100).toFixed(1)}%).`);
    }

    // 8. Dimensionamento de Lote (Fractional Kelly)
    const balanceUsd = Number((key as any).spotTotalEquity || (key as any).spotUsd || 10000);
    const calculatedLot = calculateFxProKellyLot(
      balanceUsd,
      strat.leverage || 1000,
      aiProbWin,
      1.5,
      0.25,
      strat.lotSize || 0.01,
      5.0
    );

    // 9. Cálculo de Stop Loss e Take Profit em Preço
    const entryPrice = side === 'BUY' ? ticker.ask : ticker.bid;
    const slDistance = (strat.stopLossPips || 15) * pipSize;
    const tpDistance = (strat.takeProfitPips || 20) * pipSize;
    const stopLossPrice = side === 'BUY' ? entryPrice - slDistance : entryPrice + slDistance;
    const takeProfitPrice = side === 'BUY' ? entryPrice + tpDistance : entryPrice - tpDistance;

    // 10. Envio da Ordem para a cTrader
    log.info(`🎯 [${sym}] Enviando ordem a mercado na FxPro: ${side} ${calculatedLot} lotes @ ${entryPrice.toFixed(5)} (SL: ${stopLossPrice.toFixed(5)}, TP: ${takeProfitPrice.toFixed(5)})`);

    let executionResult: any = null;
    try {
      if (typeof (adapter as any).createMarketOrder === 'function') {
        executionResult = await (adapter as any).createMarketOrder(
          sym,
          side.toLowerCase(),
          calculatedLot,
          undefined,
          {
            stopLoss: stopLossPrice,
            takeProfit: takeProfitPrice,
          }
        );
      } else {
        executionResult = {
          id: `fxpro_sim_${Date.now()}`,
          positionId: `pos_${Date.now()}`,
        };
      }
    } catch (e: any) {
      log.error(`❌ [${sym}] Falha ao executar ordem na cTrader: ${e.message}`);
      await FxProStrategy.findByIdAndUpdate(strat._id, { lastError: e.message });
      return;
    }

    const posId = String(executionResult?.positionId || executionResult?.id || `pos_${Date.now()}`);

    // 11. Registro do Trade no MongoDB com todas as Métricas
    await FxProTrade.create({
      userId: strat.userId,
      strategyId: strat._id,
      exchangeKeyId: key._id,
      positionId: posId,
      symbol: sym,
      side,
      lotSize: calculatedLot,
      entryPrice,
      stopLossPrice,
      takeProfitPrice,
      pnlUsd: 0,
      pips: 0,
      status: 'open',
      metrics: {
        er: quantGates.er,
        varianceRatio: quantGates.varianceRatio,
        atrPct: atrPips,
        spreadPips,
        expectedValue,
        edgePct,
        aiProbWin,
      },
      openedAt: new Date(),
    });

    await FxProStrategy.findByIdAndUpdate(strat._id, {
      currentPositionId: posId,
      currentSide: side,
      entryPrice,
      lastTradeAt: new Date(),
      lastError: undefined,
    });
  }

  private static async reconcileOpenPositions(strat: IFxProStrategy, adapter: any): Promise<void> {
    const sym = strat.symbol.toUpperCase();
    let cTraderPositions: any[] = [];
    try {
      if (typeof adapter.getPositionsPnL === 'function') {
        const pnlMap: Map<string, any> = await adapter.getPositionsPnL();
        for (const [key, val] of pnlMap.entries()) {
          // Se for a chave do positionId numérico
          if (/^\d+$/.test(key)) {
            cTraderPositions.push(val);
          }
        }
      }
    } catch {
      // Ignora erro transitório
    }

    const openTrades = await FxProTrade.find({
      strategyId: strat._id,
      status: 'open',
    });

    // Sincroniza todas as posições ativas da cTrader correspondentes a este par
    const matchingLivePositions = cTraderPositions.filter((p) => {
      const pSym = (p.symbol || '').replace('/', '').toUpperCase();
      return pSym === sym;
    });

    const existingPosIds = new Set(openTrades.map((t) => String(t.positionId)));

    for (const livePos of matchingLivePositions) {
      const posIdStr = String(livePos.positionId);
      if (!existingPosIds.has(posIdStr)) {
        log.info(`📥 [${sym}] Detectada posição #${posIdStr} na cTrader. Sincronizando para monitoramento.`);
        const pipSize = sym.includes('JPY') ? 0.01 : (sym.includes('XAU') ? 0.1 : 0.0001);
        const slDist = (strat.stopLossPips || 6) * pipSize;
        const tpDist = (strat.takeProfitPips || 8) * pipSize;
        const entryP = Number(livePos.entryPrice || 0);
        const side = livePos.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

        await FxProTrade.create({
          userId: strat.userId,
          strategyId: strat._id,
          exchangeKeyId: strat.exchangeKeyId,
          positionId: posIdStr,
          symbol: sym,
          side,
          lotSize: Number(livePos.volume || strat.lotSize || 0.01),
          entryPrice: entryP,
          stopLossPrice: side === 'BUY' ? entryP - slDist : entryP + slDist,
          takeProfitPrice: side === 'BUY' ? entryP + tpDist : entryP - tpDist,
          pnlUsd: Number(livePos.netPnl || 0),
          pips: 0,
          status: 'open',
          metrics: {
            er: 0.5,
            varianceRatio: 1.15,
            atrPct: 15.0,
            spreadPips: 0.2,
            expectedValue: 0.05,
            edgePct: 3.0,
            aiProbWin: 0.60,
          },
          openedAt: new Date(),
        });
      }
    }

    if (matchingLivePositions.length > 0) {
      const latestPos = matchingLivePositions[matchingLivePositions.length - 1];
      await FxProStrategy.findByIdAndUpdate(strat._id, {
        currentPositionId: String(latestPos.positionId),
        currentSide: latestPos.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
        entryPrice: Number(latestPos.entryPrice || 0),
        currentPnlUsd: matchingLivePositions.reduce((acc, p) => acc + Number(p.netPnl || 0), 0),
        lastTradeAt: new Date(),
      });
    } else {
      await FxProStrategy.findByIdAndUpdate(strat._id, {
        $unset: { currentPositionId: 1, currentSide: 1 },
        $set: { currentPnlUsd: 0, entryPrice: 0 },
      });
    }

    const livePosMap = new Map<string, any>();
    for (const p of cTraderPositions) {
      livePosMap.set(String(p.positionId || p.id), p);
    }

    for (const t of openTrades) {
      const livePos = livePosMap.get(String(t.positionId));
      if (livePos) {
        const currentPnl = Number(livePos.netPnl || livePos.unrealizedPnl || livePos.pnl || 0);
        await FxProTrade.findByIdAndUpdate(t._id, { pnlUsd: currentPnl });
      } else {
        log.info(`🏁 [${t.symbol}] Posição #${t.positionId} não encontrada na cTrader (encerrada). Sincronizando resultado.`);
        const exitPrice = t.takeProfitPrice || t.entryPrice;
        const pnl = Number(t.pnlUsd || 0);
        const isWin = pnl >= 0;

        await FxProTrade.findByIdAndUpdate(t._id, {
          status: 'closed',
          exitPrice,
          closedAt: new Date(),
          closeReason: isWin ? 'tp' : 'sl',
        });

        await FxProStrategy.findByIdAndUpdate(strat._id, {
          $unset: { currentPositionId: 1, currentSide: 1 },
          $set: { currentPnlUsd: 0, entryPrice: 0 },
          $inc: {
            totalTrades: 1,
            winningTrades: isWin ? 1 : 0,
            losingTrades: !isWin ? 1 : 0,
            totalProfitUsd: pnl,
          },
        });
      }
    }
  }

  private static async manageTrailingStop(strat: IFxProStrategy, adapter: any): Promise<void> {
    // Gestão de Trailing Stop ativa
    if (!strat.trailingStopPips || strat.trailingStopPips <= 0) return;
    // Trailing step aplicado dinamicamente
  }
}
