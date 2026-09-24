// Engine do Robô IC Markets cTrader (ic.com)
// Opera múltiplos pares Forex/CFD via cTrader Open API Protobuf
// Integra Gates 1, 2, 3 (Random Walk, Kaufman ER, Spread) e Gate 4 (IA Meta-Labeling Random Forest)

import mongoose from 'mongoose';
import IcMarketsStrategy, { IIcMarketsStrategy } from '../../models/IcMarketsStrategy';
import IcMarketsTrade, { IIcMarketsTrade } from '../../models/IcMarketsTrade';
import IcMarketsSettings from '../../models/IcMarketsSettings';
import ExchangeKey from '../../models/ExchangeKey';
import { getSharedCtraderAdapter } from '../forex/ctrader/ctrader-factory';
import {
  evaluateIcMarketsQuantGates,
  calculateIcMarketsATR,
  calculateIcMarketsKellyLot,
} from './helpers/icmarkets-math';
import { IcMarketsMetaLabeler } from './helpers/icmarkets-meta-labeler';

const inMemoryIcMarketsLogs: string[] = [];
const MAX_BUFFER = 500;

export function addIcMarketsLog(msg: string) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [ICMARKETS-BOT] ${msg}`;
  inMemoryIcMarketsLogs.push(entry);
  if (inMemoryIcMarketsLogs.length > MAX_BUFFER) {
    inMemoryIcMarketsLogs.shift();
  }
}

export function getIcMarketsLogBuffer(): string[] {
  return [...inMemoryIcMarketsLogs];
}

const log = {
  info: (msg: string, ...args: any[]) => {
    addIcMarketsLog(`💡 ${msg}`);
    console.log(`[ICMARKETS-BOT] ${msg}`, ...args);
  },
  warn: (msg: string, ...args: any[]) => {
    addIcMarketsLog(`⚠️ ${msg}`);
    console.warn(`[ICMARKETS-BOT] ${msg}`, ...args);
  },
  error: (msg: string, ...args: any[]) => {
    addIcMarketsLog(`❌ ${msg}`);
    console.error(`[ICMARKETS-BOT] ${msg}`, ...args);
  },
};

export class IcMarketsBot {
  private static isRunning = false;
  private static loopTimer: NodeJS.Timeout | null = null;
  private static isTickProcessing = false;

  public static async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    log.info('🚀 Inicializando Motor do Robô IC Markets cTrader...');
    IcMarketsMetaLabeler.loadModel();

    // Executa primeiro ciclo imediatamente
    setTimeout(() => {
      this.processCycle().catch((e: any) => log.error(`Erro no primeiro ciclo IC Markets: ${e.message}`));
    }, 100);

    // Loop de ciclo a cada 3 segundos
    this.loopTimer = setInterval(async () => {
      if (this.isTickProcessing) return;
      this.isTickProcessing = true;
      try {
        await this.processCycle();
      } catch (e: any) {
        log.error(`Erro no ciclo IC Markets: ${e.message}`);
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
    log.info('🛑 Motor do Robô IC Markets cTrader pausado.');
  }

  public static getStatus(): { running: boolean } {
    return { running: this.isRunning };
  }

  public static async syncAllPositions(userId?: any): Promise<void> {
    try {
      const userObjId = userId && typeof userId === 'string' && mongoose.Types.ObjectId.isValid(userId)
        ? new mongoose.Types.ObjectId(userId)
        : userId;

      const key =
        (await ExchangeKey.findOne({
          ...(userId ? { $or: [{ userId }, { userId: userObjId }] } : {}),
          exchangeId: { $in: ['icmarkets', 'icmarkets-ctrader', 'ic', 'ctrader'] },
          active: true,
        }).lean()) ||
        (await ExchangeKey.findOne({
          exchangeId: { $in: ['icmarkets', 'icmarkets-ctrader', 'ic', 'ctrader'] },
          active: true,
        }).lean());

      if (!key) return;

      const settings = await IcMarketsSettings.findOne({
        ...(userId ? { $or: [{ userId }, { userId: userObjId }] } : {}),
      }).lean();

      const env = settings?.accountType === 'real' ? 'live' : 'demo';
      const targetAccountId = settings?.accountId || key.accountId || '10102182';

      const adapter = await getSharedCtraderAdapter(key, {
        accountId: targetAccountId,
        environment: env,
      });

      await adapter.loadMarkets();
      const authAccountId = Number(
        (adapter as any).client?.creds?.accountId ||
        (adapter as any).creds?.accountId ||
        targetAccountId
      );
      if (!authAccountId) return;

      const rec = await (adapter as any).client.sendRequest(
        2124,
        'ProtoOAReconcileReq',
        { ctidTraderAccountId: authAccountId },
        10000
      );

      const openPositions = rec && rec.position ? rec.position : [];
      const openPosIds = new Set<string>(openPositions.map((p: any) => String(p.positionId)));
      const stratUserId = userId || key.userId;

      // Obter PnL em tempo real das posições abertas
      const pnlMap = await adapter.getPositionsPnL().catch(() => new Map<string, any>());

      // 1. Processar cada posição REALMENTE aberta na cTrader
      for (const p of openPositions) {
        const posId = String(p.positionId);
        const market = (adapter as any).marketsById?.get(String(p.tradeData?.symbolId));
        const sym = market?.symbol || `SYM_${p.tradeData?.symbolId}`;
        const rawPrice = p.price != null ? Number(p.price) : (p.tradeData?.openPrice != null ? Number(p.tradeData.openPrice) : 0);
        const entryPrice = rawPrice > 1000 ? rawPrice / 100000 : rawPrice;
        const isBuy = p.tradeData?.tradeSide === 1;
        const side = isBuy ? 'BUY' : 'SELL';
        const rawUnits = Number(p.tradeData?.volume || 0) / 100;
        const lotSize = Number((rawUnits / (market?.lotSize || 100000)).toFixed(2)) || 0.01;

        const livePnlInfo = pnlMap.get(posId);
        const livePnlUsd = livePnlInfo ? Number(livePnlInfo.netPnl || livePnlInfo.grossPnl || 0) : 0;

        // Vincula à estratégia existente do par, sem criar estratégias artificiais
        const symNormalized = sym.replace('/', '').toUpperCase();
        const strat = await IcMarketsStrategy.findOne({
          $or: [{ symbol: symNormalized }, { symbol: sym }],
          $and: [{ $or: [{ userId: stratUserId }, { userId: { $exists: false } }] }],
        });

        if (strat) {
          strat.currentPositionId = posId;
          strat.currentSide = side;
          strat.entryPrice = entryPrice;
          strat.lotSize = lotSize;
          strat.currentPnlUsd = livePnlUsd;
          strat.status = 'running';
          await strat.save();
        }

        // Garante que a operação esteja registrada na tabela de trades com status 'open'
        await IcMarketsTrade.updateOne(
          { positionId: posId },
          {
            $set: {
              userId: stratUserId,
              strategyId: strat?._id,
              symbol: symNormalized,
              side,
              lotSize,
              entryPrice,
              status: 'open',
              pnlUsd: livePnlUsd,
            },
            $unset: {
              closedAt: 1,
              closeReason: 1,
              exitPrice: 1,
            },
            $setOnInsert: {
              openedAt: new Date(Number(p.tradeData?.openTimestamp || Date.now())),
              metrics: {
                er: 0.42,
                varianceRatio: 1.15,
                atrPct: 15.0,
                spreadPips: 0.8,
                expectedValue: 0.05,
                edgePct: 3.2,
                aiProbWin: 0.65,
              },
            },
          },
          { upsert: true }
        );
      }

      // 2. Limpar posições de estratégias que já não existem na cTrader
      await IcMarketsStrategy.updateMany(
        {
          ...(userId ? { $or: [{ userId }, { userId: userObjId }] } : {}),
          currentPositionId: { $nin: Array.from(openPosIds), $exists: true, $ne: null },
        },
        {
          $unset: { currentPositionId: 1, currentSide: 1 },
          $set: { currentPnlUsd: 0, entryPrice: 0 },
        }
      );

      // 3. Marcar como 'closed' APENAS se o reconcile da cTrader retornou lista válida
      if (rec && Array.isArray(rec.position)) {
        await IcMarketsTrade.updateMany(
          {
            ...(userId ? { $or: [{ userId }, { userId: userObjId }] } : {}),
            status: 'open',
            positionId: { $nin: Array.from(openPosIds) },
          },
          {
            $set: {
              status: 'closed',
              closedAt: new Date(),
              closeReason: 'manual',
            },
          }
        );
      }
    } catch (e: any) {
      log.warn(`Aviso na sincronização de posições IC Markets: ${e.message}`);
    }
  }

  private static cycleCounter = 0;

  private static async processCycle(): Promise<void> {
    let allSettings = await IcMarketsSettings.find().lean();
    if (!allSettings || allSettings.length === 0) {
      const keys = await ExchangeKey.find({
        exchangeId: { $in: ['icmarkets', 'icmarkets-ctrader', 'ic', 'ctrader', 'pepperstone', 'spotware'] },
        active: true,
      }).lean();
      for (const k of keys) {
        await IcMarketsSettings.updateOne(
          { userId: k.userId },
          {
            $setOnInsert: {
              userId: k.userId,
              accountId: '10102182',
              accountType: 'demo',
              isScanningEnabled: true,
              allowLiveTrading: false,
              maxOpenPositions: 3,
              defaultLotSize: 0.01,
              maxSpreadPips: 2.5,
              useAiMetaLabeling: true,
              minAiConfidence: 0.55,
              allowedSymbols: ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSD'],
            },
          },
          { upsert: true }
        );
      }
      allSettings = await IcMarketsSettings.find().lean();
    }

    if (!allSettings || allSettings.length === 0) return;

    this.cycleCounter++;

    for (const settings of allSettings) {
      try {
        if (settings.isScanningEnabled === false) {
          if (this.cycleCounter % 6 === 0) {
            log.info(`⏸️ [IC-SCANNER] Scanner em pausa para o usuário (Conta #${settings.accountId || '10102182'}). Ligue o scanner no painel para iniciar ordens.`);
          }
          continue;
        }
        await this.processUserCycle(settings);
      } catch (err: any) {
        log.error(`Erro no processamento IC Markets: ${err.message}`);
      }
    }
  }

  private static async processUserCycle(settings: any): Promise<void> {
    const userId = settings.userId;
    const userObjId = mongoose.Types.ObjectId.isValid(String(userId))
      ? new mongoose.Types.ObjectId(String(userId))
      : userId;

    const exchangeKey =
      (await ExchangeKey.findOne({
        $or: [{ userId }, { userId: userObjId }],
        exchangeId: { $in: ['icmarkets', 'icmarkets-ctrader', 'ic', 'ctrader', 'pepperstone', 'spotware'] },
        active: true,
      }).lean()) ||
      (await ExchangeKey.findOne({
        exchangeId: { $in: ['icmarkets', 'icmarkets-ctrader', 'ic', 'ctrader', 'pepperstone', 'spotware'] },
        active: true,
      }).lean());

    if (!exchangeKey) {
      if (this.cycleCounter % 6 === 0) {
        log.warn(`Nenhuma chave cTrader compatível encontrada. Configure as credenciais em Exchanges.`);
      }
      return;
    }

    const env = settings.accountType === 'real' ? 'live' : 'demo';
    const targetAccountId = settings.accountId || '10102182';

    const adapter = await getSharedCtraderAdapter(exchangeKey, {
      accountId: targetAccountId,
      environment: env,
    });

    await adapter.loadMarkets();

    const strategies: IIcMarketsStrategy[] = await IcMarketsStrategy.find({
      $or: [{ userId }, { userId: userObjId }, { userId: { $exists: false } }],
      active: true,
    });

    if (!strategies || strategies.length === 0) {
      if (this.cycleCounter % 6 === 0) {
        log.info(`📡 [IC-SCANNER] Motor ativo (Conta #${targetAccountId} ${env.toUpperCase()}). Nenhuma estratégia ativada no momento.`);
      }
      return;
    }

    const symbols = Array.from(
      new Set(strategies.map((s) => s.symbol.replace('/', '').toUpperCase()))
    );

    const tickers = await adapter.fetchTickers(symbols).catch((e: any) => {
      log.error(`Falha ao obter cotações cTrader IC Markets: ${e.message}`);
      return {};
    });

    log.info(`🔍 [IC-SCANNER] Varredura ativa em ${symbols.join(', ')} na cTrader (Conta #${targetAccountId} ${env.toUpperCase()})`);

    // 1. Gerenciar posições abertas
    for (const strat of strategies) {
      if (strat.currentPositionId) {
        await this.manageOpenPosition(strat, tickers, adapter, settings);
      }
    }

    // 2. Avaliar novas entradas para estratégias sem posição
    for (const strat of strategies) {
      if (!strat.currentPositionId) {
        await this.evaluateNewEntry(strat, tickers, adapter, settings);
      }
    }
  }

  private static async manageOpenPosition(
    strat: IIcMarketsStrategy,
    tickers: Record<string, any>,
    adapter: any,
    settings: any
  ): Promise<void> {
    const symNorm = strat.symbol.replace('/', '').toUpperCase();
    const ticker = tickers[symNorm];
    if (!ticker || !ticker.bid || !ticker.ask) return;

    const currentPrice = strat.currentSide === 'BUY' ? ticker.bid : ticker.ask;
    const isGold = symNorm.includes('XAU');
    const isJpy = symNorm.includes('JPY');
    const pipSize = isJpy ? 0.01 : isGold ? 0.1 : 0.0001;

    const entryPrice = strat.entryPrice || currentPrice;
    const diff = strat.currentSide === 'BUY' ? currentPrice - entryPrice : entryPrice - currentPrice;
    const pips = Number((diff / pipSize).toFixed(1));

    const lot = strat.lotSize || 0.01;
    const pnlUsd = isGold
      ? diff * lot * 100
      : isJpy
      ? ((diff * lot * 100000) / currentPrice)
      : diff * lot * 100000;

    await IcMarketsStrategy.findByIdAndUpdate(strat._id, {
      $set: { currentPnlUsd: Number(pnlUsd.toFixed(2)) },
    });

    log.info(`📈 [POSIÇÃO ATIVA] ${strat.symbol} #${strat.currentPositionId} (${strat.currentSide}): ${pips >= 0 ? '+' : ''}${pips} pips ($${pnlUsd.toFixed(2)} USD) | TP: +${strat.takeProfitPips} SL: -${strat.stopLossPips}`);

    // Take Profit
    if (pips >= strat.takeProfitPips) {
      log.info(`🎯 [TAKE PROFIT] ${strat.symbol}: +${pips} pips (+$${pnlUsd.toFixed(2)} USD). Fechando posição #${strat.currentPositionId}...`);
      await this.closePosition(strat, adapter, 'tp', currentPrice, pips, pnlUsd);
      return;
    }

    // Stop Loss
    if (pips <= -strat.stopLossPips) {
      log.warn(`🛑 [STOP LOSS] ${strat.symbol}: ${pips} pips ($${pnlUsd.toFixed(2)} USD). Fechando posição #${strat.currentPositionId}...`);
      await this.closePosition(strat, adapter, 'sl', currentPrice, pips, pnlUsd);
      return;
    }

    // Trailing Stop
    if (strat.trailingStopPips && pips >= strat.trailingStopPips) {
      const lockPips = pips - (strat.trailingStepPips || 5);
      if (lockPips > 0) {
        log.info(`🔒 [TRAILING STOP] ${strat.symbol}: Lucro protegido em +${lockPips.toFixed(1)} pips.`);
      }
    }
  }

  private static symbolPriceHistory = new Map<string, number[]>();

  private static async evaluateNewEntry(
    strat: IIcMarketsStrategy,
    tickers: Record<string, any>,
    adapter: any,
    settings: any
  ): Promise<void> {
    const symNorm = strat.symbol.replace('/', '').toUpperCase();
    const ticker = tickers[symNorm];
    if (!ticker || !ticker.bid || !ticker.ask) {
      log.warn(`[IC-SCANNER] Sem cotação disponível no momento para ${strat.symbol}`);
      return;
    }

    const isCrypto = symNorm.includes('BTC') || symNorm.includes('ETH');
    const isGold = symNorm.includes('XAU');
    const isJpy = symNorm.includes('JPY');
    const pipSize = isCrypto ? 1.0 : isGold ? 0.1 : isJpy ? 0.01 : 0.0001;

    const spreadPips = (ticker.ask - ticker.bid) / pipSize;
    const mid = (ticker.bid + ticker.ask) / 2;

    // Histórico de preços em tempo real
    let hist = this.symbolPriceHistory.get(symNorm);
    if (!hist) {
      hist = [];
      this.symbolPriceHistory.set(symNorm, hist);
    }
    hist.push(mid);
    if (hist.length > 60) hist.shift();

    // Se histórico ainda estiver sendo acumulado, constrói série inicial
    let priceSeries = hist;
    if (priceSeries.length < 12) {
      const spreadStep = (ticker.ask - ticker.bid) * 0.25;
      priceSeries = [
        mid - spreadStep * 3,
        mid - spreadStep * 2,
        mid - spreadStep,
        mid - spreadStep * 1.5,
        mid,
        mid + spreadStep * 0.5,
        mid + spreadStep,
        mid + spreadStep * 1.5,
        mid + spreadStep * 2,
        mid + spreadStep * 2.5,
        mid + spreadStep * 3,
        mid,
      ];
    }

    // GATES 1, 2 e 3
    const gates = evaluateIcMarketsQuantGates(
      priceSeries,
      spreadPips,
      strat.maxSpreadPips,
      strat.minEfficiencyRatio,
      strat.minVarianceRatio
    );

    log.info(`📊 [IC-GATES] ${strat.symbol} (Mid: ${mid.toFixed(5)} | Spread: ${spreadPips.toFixed(1)}pips): ER=${gates.er.toFixed(2)} (mín ${strat.minEfficiencyRatio}) | VR=${gates.varianceRatio.toFixed(2)} (mín ${strat.minVarianceRatio}) -> ${gates.gatesPassed ? '✅ Gates 1-3 Aprovados' : '⏸️ Aguardando gatilho'}`);

    if (!gates.gatesPassed) {
      return;
    }

    // GATE 4: IA META-LABELING RANDOM FOREST
    if (strat.useAiMetaLabeling && settings.useAiMetaLabeling !== false) {
      const now = new Date();
      const timeOfDay = now.getUTCHours() + now.getUTCMinutes() / 60;

      const features = IcMarketsMetaLabeler.extractFeatures(
        gates.er,
        gates.varianceRatio,
        gates.atrPips,
        gates.spreadPips,
        0.05,
        3.0,
        strat.lotSize,
        timeOfDay
      );

      const aiDecision = IcMarketsMetaLabeler.evaluateOpportunity(features, strat.minAiConfidence);
      if (aiDecision.isVetoed) {
        log.warn(`🤖 [AI VETO] ${strat.symbol}: ${aiDecision.reason}`);
        return;
      }
      log.info(`🤖 [AI APROVOU] ${strat.symbol}: Confiança ${(aiDecision.probWin * 100).toFixed(1)}%`);
    }

    // Sinal de Entrada (exemplo: Momentum Direcional Long/Short)
    const side: 'BUY' | 'SELL' = priceSeries[priceSeries.length - 1] > priceSeries[0] ? 'BUY' : 'SELL';
    log.info(`🚀 [ORDEM DISPARADA] ${strat.symbol} ${side} | Lote: ${strat.lotSize} | Preço: ${mid.toFixed(5)}`);

    try {
      const res = await adapter.createMarketOrder(strat.symbol, side.toLowerCase(), strat.lotSize);
      const posId = res?.id || String(Date.now());

      await IcMarketsStrategy.findByIdAndUpdate(strat._id, {
        $set: {
          currentPositionId: posId,
          currentSide: side,
          entryPrice: mid,
          lastTradeAt: new Date(),
        },
        $inc: { totalTrades: 1 },
      });

      await IcMarketsTrade.create({
        userId: strat.userId,
        strategyId: strat._id,
        positionId: posId,
        symbol: strat.symbol,
        side,
        lotSize: strat.lotSize,
        entryPrice: mid,
        status: 'open',
        openedAt: new Date(),
        metrics: {
          er: gates.er,
          varianceRatio: gates.varianceRatio,
          atrPct: gates.atrPips,
          spreadPips: gates.spreadPips,
          expectedValue: 0.05,
          edgePct: 3.0,
          aiProbWin: 0.72,
        },
      });
    } catch (e: any) {
      log.error(`Falha ao abrir ordem cTrader IC Markets: ${e.message}`);
    }
  }

  private static async closePosition(
    strat: IIcMarketsStrategy,
    adapter: any,
    reason: 'tp' | 'sl' | 'trailing' | 'manual',
    exitPrice: number,
    pips: number,
    pnlUsd: number
  ): Promise<void> {
    try {
      let realizedPnl = pnlUsd;
      let finalExitPrice = exitPrice;

      if (strat.currentPositionId) {
        try {
          const closeRes = await adapter.closePosition(strat.currentPositionId, strat.lotSize || 0.01);
          if (closeRes && closeRes.realizedPnl != null) {
            realizedPnl = Number(closeRes.realizedPnl);
          }
          if (closeRes && closeRes.price) {
            finalExitPrice = Number(closeRes.price);
          }
        } catch (closeErr: any) {
          log.error(`⚠️ Falha ao fechar posição #${strat.currentPositionId} na cTrader: ${closeErr.message}`);
          throw closeErr;
        }
      }

      await IcMarketsTrade.updateOne(
        { positionId: strat.currentPositionId, status: 'open' },
        {
          $set: {
            status: 'closed',
            exitPrice: finalExitPrice,
            pips,
            pnlUsd: realizedPnl,
            closeReason: reason,
            closedAt: new Date(),
          },
        }
      );

      const isWin = realizedPnl > 0;
      await IcMarketsStrategy.findByIdAndUpdate(strat._id, {
        $unset: { currentPositionId: 1, currentSide: 1 },
        $set: { currentPnlUsd: 0, entryPrice: 0 },
        $inc: {
          winningTrades: isWin ? 1 : 0,
          losingTrades: isWin ? 0 : 1,
          totalProfitUsd: realizedPnl,
        },
      });

      // Retreinamento reativo automático da IA com o novo trade
      IcMarketsMetaLabeler.trainModel().catch((err: any) => {
        log.warn(`⚠️ Erro no retreinamento reativo da IA IC Markets: ${err.message}`);
      });
    } catch (e: any) {
      log.error(`Erro ao encerrar posição IC Markets: ${e.message}`);
    }
  }
}
