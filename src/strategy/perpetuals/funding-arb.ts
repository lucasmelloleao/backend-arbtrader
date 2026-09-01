// @ts-nocheck
import { loadEnv } from '../../utils/env-loader';
loadEnv();
import mongoose from 'mongoose';
import Redis from 'ioredis';
import PerpArbStrategy from '../../models/PerpArbStrategy';
import PerpArbTrade from '../../models/PerpArbTrade';
import ExchangeKey from '../../models/ExchangeKey';
import PerpArbSettings from '../../models/PerpArbSettings';
import { connectToDatabase } from '../../config/db';

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${msg}`, ...args),
};

import {
  getExchangeInstance,
  invalidateExchangeCache,
  withTimeout
} from './helpers/ccxt-factory';

import {
  getDetailedSpotBalance,
  getDetailedFuturesBalance,
  reconcilePhantomPosition
} from './helpers/balance-fetcher';

import {
  safeFetchFundingHistory,
  resolveExchangeKeys,
  backfillFundingHistoryAll,
  harvestFundingForAllOpenStrategies
} from './helpers/funding-history-manager';

import {
  takePortfolioSnapshot
} from './helpers/portfolio-snapshotter';

export { getExchangeInstance, invalidateExchangeCache, withTimeout };
export { getDetailedSpotBalance, getDetailedFuturesBalance, reconcilePhantomPosition };
export { safeFetchFundingHistory, resolveExchangeKeys, backfillFundingHistoryAll, harvestFundingForAllOpenStrategies };
export { takePortfolioSnapshot };

const balanceCache = new Map<string, { spotUsdt: number; futuresUsdt: number; at: number }>();
const BALANCE_CACHE_TTL_MS = 60_000;
const LOCK_WATCHDOG_MS = 120_000;

let _openingLocked = false;
let _openingLockedAt = 0;
let globalCloseSettings: any = null;

async function enterOpeningLock(): Promise<() => void> {
  _openingLocked = true;
  _openingLockedAt = Date.now();
  return () => { _openingLocked = false; _openingLockedAt = 0; };
}

function isOpeningInFlight(): boolean {
  if (_openingLocked && Date.now() - _openingLockedAt > LOCK_WATCHDOG_MS) {
    log.warn('⚠️ [MUTEX] Lock de abertura expirado por watchdog (>2min). Liberando automaticamente.');
    _openingLocked = false;
    _openingLockedAt = 0;
  }
  return _openingLocked;
}

export function setCachedBalance(exchangeKeyId: string, spotUsdt: number, futuresUsdt: number) {
  balanceCache.set(String(exchangeKeyId), { spotUsdt, futuresUsdt, at: Date.now() });
}

export function getCachedBalance(exchangeKeyId: string): { spotUsdt: number; futuresUsdt: number } | null {
  const entry = balanceCache.get(String(exchangeKeyId));
  if (entry && Date.now() - entry.at < BALANCE_CACHE_TTL_MS) {
    return { spotUsdt: entry.spotUsdt, futuresUsdt: entry.futuresUsdt };
  }
  return null;
}

const futuresFreeCache = new Map<string, { futuresUsdt: number; at: number }>();
export async function getCachedFuturesFree(perpExchange: any): Promise<number> {
  const key = `${perpExchange.id}_${perpExchange.apiKey || ''}`;
  const cached = futuresFreeCache.get(key);
  if (cached && Date.now() - cached.at < 1500) {
    return cached.futuresUsdt;
  }
  const { futuresUsdt } = await getDetailedFuturesBalance(perpExchange);
  futuresFreeCache.set(key, { futuresUsdt, at: Date.now() });
  return futuresUsdt;
}

function isInCooldown(strat: any): boolean {
  if (!strat.lastLossAt || !strat.cooldownAfterLossMs) return false;
  const elapsed = Date.now() - new Date(strat.lastLossAt).getTime();
  return elapsed < Number(strat.cooldownAfterLossMs);
}

async function checkAndAccumulateDailyLoss(strat: any, lossAmount: number) {
  const maxLoss = Number(strat.maxDailyLoss ?? 0);
  const current = Number(strat.dailyLossAccum ?? 0);
  const newTotal = current + lossAmount;

  await (PerpArbStrategy as any).findByIdAndUpdate(strat._id, {
    dailyLossAccum: newTotal,
    lastLossAt: new Date(),
    ...(maxLoss > 0 && newTotal >= maxLoss ? { autoExecute: false } : {}),
  });

  if (maxLoss > 0 && newTotal >= maxLoss) {
    log.warn(`⛔ [${strat.name}] Limite de perda diária atingido (${newTotal.toFixed(2)}/${maxLoss} USDT). autoExecute desativado.`);
  }
}

export async function consolidateDuplicateOpenPositions() {
  try {
    const openStrats = await (PerpArbStrategy as any).find({
      positionOpen: true,
      positionOpenedAt: { $ne: null },
    }).lean();

    if (!openStrats || openStrats.length === 0) return;

    const groups = new Map<string, any[]>();
    for (const s of openStrats) {
      const perpKeyId = String(s.perpExchangeKeyId || s.exchangeKeyId || '');
      const key = `${perpKeyId}::${String(s.perpSymbol || '').toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }

    for (const [key, group] of groups) {
      if (group.length <= 1) continue;

      group.sort((a, b) => new Date(b.positionOpenedAt || b.createdAt).getTime() - new Date(a.positionOpenedAt || a.createdAt).getTime());
      const primary = group[0];
      const duplicates = group.slice(1);

      const symbol = primary.perpSymbol;
      const totalSize = Number(primary.positionSize || primary.tradeSize || 0) +
        duplicates.reduce((sum, d) => sum + Number(d.positionSize || d.tradeSize || 0), 0);

      log.info(`🧹 [CONSOLIDAÇÃO] ${group.length} estratégias abertas para ${symbol} (a corretora agrega em 1). Mantendo [${primary.name}] com ${totalSize.toFixed(2)} USDT e encerrando ${duplicates.map(d => `[${d.name}]`).join(', ')}.`);

      await (PerpArbStrategy as any).findByIdAndUpdate(primary._id, {
        positionSize: totalSize,
        name: group.map(g => g.name).join(' + '),
      });

      for (const dup of duplicates) {
        const realizedFunding = Number(dup.fundingCollected || 0);
        await (PerpArbTrade as any).create({
          userId: dup.userId,
          strategyId: dup._id,
          strategyName: dup.name,
          perpSymbol: dup.perpSymbol,
          spotSymbol: dup.spotSymbol,
          type: 'close_hedge',
          status: 'executed',
          amount: Number(dup.positionSize || dup.tradeSize || 0),
          spotPrice: dup.lastSpotPrice || null,
          perpPrice: dup.lastPerpPrice || null,
          pnl: realizedFunding,
          reason: 'Consolidação automática (corretora agrega múltiplos hedges no mesmo par em 1 posição)',
          openedAt: dup.positionOpenedAt || undefined,
          fundingHistory: dup.fundingHistory || [],
          spotOrderId: 'CONSOLIDATED',
          perpOrderId: 'CONSOLIDATED',
        });
        await (PerpArbStrategy as any).findByIdAndUpdate(dup._id, {
          positionOpen: false,
          positionOpenedAt: null,
          positionSize: 0,
          fundingCollected: 0,
          fundingCount: 0,
          fundingHistory: [],
        });
        log.info(`✅ [CONSOLIDAÇÃO] Estratégia [${dup.name}] marked consolidated.`);
      }
    }
  } catch (e: any) {
    log.warn('⚠️ Erro na consolidação de posições duplicadas:', e?.message);
  }
}

async function main() {
  await connectToDatabase();
  log.info('✅ Connected to MongoDB - Funding Arb');

  if (process.env.REDIS_URL) {
    try {
      const sub = new Redis(process.env.REDIS_URL);
      sub.subscribe('perp-arb-control', (err) => {
        if (!err) log.info('📡 [REDIS] Inscrito no canal perp-arb-control');
      });
      sub.on('message', async (channel, message) => {
        if (channel === 'perp-arb-control') {
          try {
            const data = JSON.parse(message);
            if (data.action === 'CLOSE_STRATEGY' && (data.strategyId || data.perpSymbol)) {
              const targetStr = data.strategyId || data.perpSymbol;
              log.info(`⚡ [REDIS COMMAND] Encerramento solicitado para: ${targetStr}`);
              const closeExec = await import('./perp-close-executor');
              await closeExec.closeStrategy(String(targetStr), { dryRun: false, reason: 'Comando Manual (Dashboard / UI)' });
            } else if (data.action === 'INCREASE_STRATEGY' && data.strategyId && data.amount) {
              log.info(`⚡ [REDIS COMMAND] Aumento de aporte solicitado para: ${data.strategyId} (+${data.amount} USDT)`);
              const openExec = await import('./perp-funding-executor');
              await openExec.executeStrategy(String(data.strategyId), { dryRun: false, overrideTradeSize: Number(data.amount) });
            }
          } catch (e: any) {
            log.error('❌ Erro ao processar mensagem do Redis:', e.message);
          }
        }
      });
    } catch (e: any) {
      log.warn('⚠️ Não foi possível inicializar Redis subscriber:', e.message);
    }
  }

  log.info('✅ Iniciando loop principal...');

  const lastReconcileMap = new Map<string, number>();
  const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
  const peakSpreadMap = new Map<string, number>();
  const trailingActiveMap = new Map<string, boolean>();

  while (true) {
    try {
      log.info('🔁 [FUNDING-ARB] Iniciando ciclo...');
      const config = await PerpArbSettings.findOne().lean();
      globalCloseSettings = config || null;

      await consolidateDuplicateOpenPositions();

      let strategies = await (PerpArbStrategy as any).find({
        $or: [{ active: true }, { positionOpen: true }]
      }).lean();

      const openStratIds = new Set(strategies.filter((s: any) => s.positionOpen).map((s: any) => String(s._id)));
      for (const k of peakSpreadMap.keys()) {
        if (!openStratIds.has(k)) { peakSpreadMap.delete(k); trailingActiveMap.delete(k); }
      }

      try {
        const openHedgeTrades = await (PerpArbTrade as any).find({
          type: 'open_hedge',
          status: { $in: ['executed', 'simulated'] }
        }).sort({ createdAt: -1 }).limit(100).lean();

        const closedStratIds = new Set<string>();
        const closedBySymbol = new Map<string, number>();
        const closeHedges = await (PerpArbTrade as any).find({
          type: 'close_hedge',
          status: { $in: ['executed', 'simulated'] }
        }).select('strategyId perpSymbol createdAt').lean();

        for (const c of closeHedges) {
          const sid = String(c.strategyId || '');
          if (sid) closedStratIds.add(sid);
          const sym = String(c.perpSymbol || '').toLowerCase();
          const ts = new Date(c.createdAt).getTime();
          if (sym && (!closedBySymbol.has(sym) || ts > closedBySymbol.get(sym)!)) {
            closedBySymbol.set(sym, ts);
          }
        }

        for (const openTrade of openHedgeTrades) {
          const sId = typeof openTrade.strategyId === 'object' && openTrade.strategyId !== null
            ? String((openTrade.strategyId as any)._id)
            : String(openTrade.strategyId || '');

          const symbolKey = String(openTrade.perpSymbol || '').toLowerCase();
          const openTs = new Date(openTrade.createdAt).getTime();

          const hasByStratId = sId ? closedStratIds.has(sId) : false;
          const hasBySymbol = symbolKey ? (closedBySymbol.get(symbolKey) ?? 0) >= openTs : false;
          const hasCloseTrade = hasByStratId || hasBySymbol;

          if (!hasCloseTrade) {
            const existsInList = strategies.some(s => String(s._id) === sId || (symbolKey && String(s.perpSymbol || '').toLowerCase() === symbolKey));
            if (!existsInList) {
              let orphanPerpKeyId: any = null;
              try {
                const firstKey = await (ExchangeKey as any).findOne({ userId: openTrade.userId, active: true }).select('_id').lean()
                  ?? await (ExchangeKey as any).findOne({ active: true }).select('_id').lean();
                if (firstKey) orphanPerpKeyId = firstKey._id;
              } catch { }

              log.info(`🛡️ [RESGATE] Posição aberta em trade (${openTrade.perpSymbol}) sem estratégia no banco. Mantendo monitoramento.`);
              strategies.push({
                _id: sId || openTrade._id,
                userId: openTrade.userId,
                name: openTrade.strategyName || `[SISTEMA] ${openTrade.perpSymbol}`,
                perpSymbol: openTrade.perpSymbol,
                spotSymbol: openTrade.spotSymbol,
                tradeSize: openTrade.amount,
                positionSize: openTrade.amount,
                positionOpen: true,
                autoExecute: true,
                active: true,
                minFundingRatePct: 0.001,
                closeThresholdPct: 0.3,
                perpExchangeKeyId: orphanPerpKeyId,
                spotExchangeKeyId: orphanPerpKeyId,
                isOrphanedPosition: true
              } as any);
            }
          }
        }
      } catch (tradeErr: any) {
        log.warn('⚠️ Erro ao resgatar posições órfãs em aberto:', tradeErr.message);
      }

      for (const strat of strategies) {
        try {
          const symUpper = (strat.perpSymbol || strat.spotSymbol || strat.name || '').toUpperCase();
          if (symUpper.includes('CASHCAT') || symUpper.startsWith('CASH/') || symUpper.startsWith('CASH:') || symUpper.includes('/CASH') || symUpper === 'CASH') {
            log.info(`⛔ [${strat.name}] Moeda CASH/CASHCAT bloqueada no sistema. Pulando verificação.`);
            continue;
          }
          const freshStrat = await (PerpArbStrategy as any).findById(strat._id).lean();
          if (freshStrat && !freshStrat.active && !freshStrat.positionOpen) {
            log.info(`⚠️ [${strat.name}] Estratégia desativada e sem posição aberta. Pulando.`);
            continue;
          }

          log.info(`🔁 Processando estratégia: [${strat.name}] ${strat.perpSymbol} / ${strat.spotSymbol}`);

          if (isInCooldown(strat)) {
            const elapsed = Date.now() - new Date(strat.lastLossAt).getTime();
            const remaining = Number(strat.cooldownAfterLossMs) - elapsed;
            log.info(`⏳ [${strat.name}] Em cooldown. Restam ${(remaining/1000).toFixed(0)}s.`);
            continue;
          }

          let perpKey: any, spotKey: any;
          try {
            ({ perpKey, spotKey } = await resolveExchangeKeys(strat));
          } catch (e: any) {
            log.warn(`[${strat.name}] ${e.message} — pulando estratégia.`);
            continue;
          }

          const perpExchange = await getExchangeInstance(perpKey, true);
          const spotExchange = await getExchangeInstance(spotKey, false);

          try {
            const perpKeyId = String(strat.perpExchangeKeyId || strat.exchangeKeyId || '');
            const [{ spotUsdt }, { futuresUsdt }] = await Promise.all([
              getDetailedSpotBalance(spotExchange),
              getDetailedFuturesBalance(perpExchange),
            ]);
            setCachedBalance(perpKeyId, spotUsdt, futuresUsdt);
            futuresFreeCache.set(`${perpExchange.id}_${perpExchange.apiKey || ''}`, { futuresUsdt, at: Date.now() });
          } catch { }

          let perpTicker: any = null;
          let spotTicker: any = null;
          let perpOrderBook: any = null;
          let spotOrderBook: any = null;

          try { perpTicker = await withTimeout(perpExchange.fetchTicker(strat.perpSymbol), 8000, null); } catch (e: any) { log.warn(`⚠️ [${strat.name}] Erro fetchTicker perp:`, e?.message); }
          try { spotTicker = await withTimeout(spotExchange.fetchTicker(strat.spotSymbol), 8000, null); } catch (e: any) { log.warn(`⚠️ [${strat.name}] Erro fetchTicker spot:`, e?.message); }
          try { perpOrderBook = await withTimeout(perpExchange.fetchOrderBook(strat.perpSymbol, 5), 8000, null); } catch (e: any) { log.warn(`⚠️ [${strat.name}] Erro fetchOrderBook perp:`, e?.message); }
          try { spotOrderBook = await withTimeout(spotExchange.fetchOrderBook(strat.spotSymbol, 5), 8000, null); } catch (e: any) { log.warn(`⚠️ [${strat.name}] Erro fetchOrderBook spot:`, e?.message); }

          const logTag = `[${strat.perpSymbol}]`;
          log.info(`${logTag} 📊 Tickers — perp last=${perpTicker?.last ?? 'n/a'} | spot last=${spotTicker?.last ?? 'n/a'}`);

          const perpBestBid = perpOrderBook?.bids?.[0]?.[0] ?? null;
          const perpBestAsk = perpOrderBook?.asks?.[0]?.[0] ?? null;
          const spotBestBid = spotOrderBook?.bids?.[0]?.[0] ?? null;
          const spotBestAsk = spotOrderBook?.asks?.[0]?.[0] ?? null;

          if (!perpExchange.markets || Object.keys(perpExchange.markets).length === 0) {
            try { await withTimeout(perpExchange.loadMarkets(), 8000, null); } catch { }
          }
          const perpMarket = perpExchange.markets ? perpExchange.markets[strat.perpSymbol] : undefined;
          const perpContractSize = perpMarket?.contractSize || 1;
          
          const perpBidDepth = (perpOrderBook?.bids?.slice(0, 5).reduce((s: number, b: number[]) => s + (b[1] || 0), 0) ?? 0) * perpContractSize;
          const spotAskDepth = (spotOrderBook?.asks?.slice(0, 5).reduce((s: number, a: number[]) => s + (a[1] || 0), 0) ?? 0);

          const basePriceForSize = perpBestBid ?? perpTicker?.last ?? spotBestBid ?? spotTicker?.last ?? null;

          log.info(`${logTag} 📈 Livro — perp bid=${perpBestBid ?? 'n/a'} ask=${perpBestAsk ?? 'n/a'} | spot bid=${spotBestBid ?? 'n/a'} ask=${spotBestAsk ?? 'n/a'}`);

          let fundingRate: number | null = null;
          try {
            if ((perpExchange as any).fetchFundingRate) {
              const r = await withTimeout((perpExchange as any).fetchFundingRate(strat.perpSymbol), 8000, null);
              fundingRate = r?.fundingRate ?? r?.funding_rate ?? null;
            } else if ((perpExchange as any).fetchFundingRates) {
              const all = await withTimeout((perpExchange as any).fetchFundingRates(), 8000, []);
              const r = Array.isArray(all) ? (all.find((x: any) => x.symbol === strat.perpSymbol) ?? all[0]) : null;
              fundingRate = r?.fundingRate ?? r?.funding_rate ?? null;
            }
          } catch { }

          if (fundingRate === null || fundingRate === undefined) {
            log.info(`⚠️ [${strat.name}] Funding rate indisponível. Pulando.`);
            continue;
          }

          const fundingPct = Number(fundingRate) * 100;
          const perpAsk = perpBestAsk ?? perpTicker?.last ?? null;
          const spotBid = spotBestBid ?? spotTicker?.last ?? null;
          const spotMid = (spotBestBid !== null && spotBestAsk !== null) ? (spotBestBid + spotBestAsk) / 2 : (spotBid ?? spotTicker?.last ?? null);
          const perpMid = (perpBestBid !== null && perpBestAsk !== null) ? (perpBestBid + perpBestAsk) / 2 : (perpAsk ?? perpTicker?.last ?? null);

          await (PerpArbStrategy as any).findByIdAndUpdate(strat._id, {
            currentFundingRate: fundingPct,
            ...(spotMid ? { lastSpotPrice: spotMid } : {}),
            ...(spotBestBid ? { lastSpotBid: spotBestBid } : {}),
            ...(spotBestAsk ? { lastSpotAsk: spotBestAsk } : {}),
            ...(perpMid ? { lastPerpPrice: perpMid } : {}),
            ...(perpBestBid ? { lastPerpBid: perpBestBid } : {}),
            ...(perpBestAsk ? { lastPerpAsk: perpBestAsk } : {}),
          });

          // Atualiza snapshot do Portfolio em tempo real (para o frontend /portfolio/live ter os preços Bid/Ask atualizados)
          try {
            const { takePortfolioSnapshot } = await import('./helpers/portfolio-snapshotter');
            takePortfolioSnapshot(String(strat.userId), true).catch(() => {});
          } catch {}

          const minFunding = strat.minFundingRatePct ?? 0.001;
          const currentStratState = await (PerpArbStrategy as any).findById(strat._id).lean();
          const isPosOpen = currentStratState ? currentStratState.positionOpen : (strat as any).positionOpen;

          if (isPosOpen) {
            const posSize = (currentStratState as any)?.positionSize || (strat as any).positionSize || strat.tradeSize;
            log.info(`👀 [MONITOR] Estratégia [${strat.name}] ABERTA | Tamanho da Posição: ${posSize} USDT. Monitorando condições de saída...\n`);

            const stratKey = String(strat._id);
            const lastReconcile = lastReconcileMap.get(stratKey) || 0;
            if (Date.now() - lastReconcile > RECONCILE_INTERVAL_MS) {
              lastReconcileMap.set(stratKey, Date.now());
              const reconciled = await reconcilePhantomPosition(strat, perpExchange, spotExchange);
              if (reconciled) continue;
            }
            
            const isFundingNegative = fundingPct <= 0;
            let spreadExitProfitPct = 0;
            if (perpAsk && spotBid) {
              spreadExitProfitPct = (spotBid - perpAsk) / perpAsk * 100;
            }
            
            const cs = globalCloseSettings || {};
            const baseThreshold = Number(strat.closeThresholdPct ?? cs.spreadCloseThresholdPct ?? 0.3);
            const forceThreshold = Number(cs.spreadCloseForcePct ?? 0.3);
            const closeWhileFundingPositive = cs.closeWhileFundingPositive === true;
            const effectiveSpreadThreshold = (!isFundingNegative && !closeWhileFundingPositive) ? forceThreshold : baseThreshold;
            
            const trailingEnabled = cs.trailingStopEnabled !== false;
            const trailingDropPct = Number(cs.trailingStopDropPct ?? 15);
            const targetProfitPct = Number(cs.targetProfitPct ?? 1.2);
            const sKey = String(strat._id);

            const openTradeDoc: any = await (PerpArbTrade as any).findOne({
              $or: [
                { strategyId: strat._id },
                { strategyId: String(strat._id) },
                { perpSymbol: strat.perpSymbol }
              ],
              type: 'open_hedge',
              status: { $in: ['executed', 'simulated'] }
            }).sort({ createdAt: -1 }).lean();

            const fundingTrades = await (PerpArbTrade as any).find({
              $or: [
                { strategyId: strat._id },
                { strategyId: String(strat._id) },
                { perpSymbol: strat.perpSymbol }
              ],
              type: 'funding_fee_accumulated',
            }).lean();

            const openedTime = openTradeDoc?.createdAt ? new Date(openTradeDoc.createdAt).getTime() : 0;
            const accumFunding = (fundingTrades || [])
              .filter((t: any) => !openedTime || new Date(t.createdAt).getTime() >= openedTime)
              .reduce((acc: number, t: any) => acc + Number(t.pnl || 0), 0);

            const histFunding = Array.isArray(strat.fundingHistory)
              ? strat.fundingHistory
                  .filter((h: any) => !openedTime || !h.timestamp || new Date(h.timestamp).getTime() >= openedTime)
                  .reduce((acc: number, h: any) => acc + Number(h.amount || 0), 0)
              : 0;

            const realFundingCollected = Math.max(accumFunding, histFunding, Number(strat.fundingCollected || 0));
            const realPosSize = Number(openTradeDoc?.amount || (currentStratState as any)?.positionSize || strat.positionSize || strat.tradeSize || 0);

            let estimatedNetReturnPct = 0;
            const openSpotPrice = Number(openTradeDoc?.spotPrice || strat.lastSpotPrice || spotBid);
            const openPerpPrice = Number(openTradeDoc?.perpPrice || strat.lastPerpPrice || perpAsk);

            if (spotBid && perpAsk && openSpotPrice > 0 && openPerpPrice > 0) {
              const spotPnL = ((spotBid - openSpotPrice) / openSpotPrice) * realPosSize;
              const perpPnL = ((openPerpPrice - perpAsk) / openPerpPrice) * realPosSize;
              const tradingFees = realPosSize * 0.0012;
              const netReturnUsd = spotPnL + perpPnL + realFundingCollected - tradingFees;
              estimatedNetReturnPct = realPosSize > 0 ? (netReturnUsd / realPosSize) * 100 : 0;
            }

            log.info(`   └ Funding=${fundingPct.toFixed(4)}% | Spread=${spreadExitProfitPct.toFixed(4)}% | Retorno Líquido=${estimatedNetReturnPct.toFixed(2)}% (TP Alvo=${targetProfitPct.toFixed(1)}%)`);

            const profitTrailingDropPct = Number(cs.profitTrailingDropPct ?? 10);
            const dbPeak = Number(strat.peakProfitPct ?? 0);
            const memPeak = peakSpreadMap.get(`profit_${sKey}`) ?? 0;
            let currentProfitPeak = Math.max(dbPeak, memPeak);

            if (estimatedNetReturnPct > currentProfitPeak) {
              currentProfitPeak = estimatedNetReturnPct;
              peakSpreadMap.set(`profit_${sKey}`, estimatedNetReturnPct);
              (PerpArbStrategy as any).findByIdAndUpdate(strat._id, { peakProfitPct: estimatedNetReturnPct }).catch(() => {});
            }

            const isProfitTrailingActive = currentProfitPeak >= targetProfitPct;

            if (isProfitTrailingActive) {
              const absDropPct = currentProfitPeak - estimatedNetReturnPct;
              const profitDropFromPeak = currentProfitPeak > 0 ? (absDropPct / currentProfitPeak) * 100 : 0;
              log.info(`🔥 [TRAILING LUCRO ATIVADO] [${strat.name}] Retorno=${estimatedNetReturnPct.toFixed(2)}% | Pico Max=${currentProfitPeak.toFixed(2)}% | Recuo=${profitDropFromPeak.toFixed(1)}% (Abs=${absDropPct.toFixed(2)}%) (Limite=${profitTrailingDropPct}%)`);
              
              // Dispara fechamento se recuar a porcentagem do limite OU se o retorno cair abaixo do Alvo Mínimo de TP
              const dropThresholdMet = profitDropFromPeak >= profitTrailingDropPct || absDropPct >= (profitTrailingDropPct / 10);
              const fellBelowTarget = estimatedNetReturnPct < targetProfitPct * 0.5;

              if (dropThresholdMet || fellBelowTarget) {
                const reasonStr = fellBelowTarget
                  ? `Trailing Lucro Proteção (Retorno ${estimatedNetReturnPct.toFixed(2)}% recuou do pico +${currentProfitPeak.toFixed(2)}%)`
                  : `Trailing Lucro Fechamento (Pico +${currentProfitPeak.toFixed(2)}%, Recuo ${profitDropFromPeak.toFixed(1)}%)`;

                log.info(`🎯 [TRAILING LUCRO FECHAMENTO] [${strat.name}] ${reasonStr}. Fechando posição!`);
                peakSpreadMap.delete(sKey);
                peakSpreadMap.delete(`profit_${sKey}`);
                trailingActiveMap.delete(sKey);
                if ((strat as any).autoExecute) {
                  const closeExec = await import('./perp-close-executor');
                  closeExec.closeStrategy(String(strat._id), { dryRun: false, reason: reasonStr }).catch((e: any) => {
                    log.error(`❌ Erro no auto-fechamento Trailing Lucro [${strat.name}]:`, e.message);
                  });
                }
              }
            }

            const prevPeak = peakSpreadMap.get(sKey) ?? 0;
            if (spreadExitProfitPct > prevPeak) {
              peakSpreadMap.set(sKey, spreadExitProfitPct);
              if (trailingActiveMap.get(sKey)) {
                log.info(`📈 [TRAILING] [${strat.name}] Novo pico de spread: ${spreadExitProfitPct.toFixed(4)}%`);
              }
            }
            const currentPeak = peakSpreadMap.get(sKey) ?? 0;
            const spreadMet = spreadExitProfitPct >= effectiveSpreadThreshold;

            if (isFundingNegative) {
              log.info(`🚨 [FECHAMENTO ACIONADO] [${strat.name}] Motivo: Funding <= 0`);
              peakSpreadMap.delete(sKey);
              trailingActiveMap.delete(sKey);
              if ((strat as any).autoExecute) {
                const closeExec = await import('./perp-close-executor');
                closeExec.closeStrategy(String(strat._id), { dryRun: false, reason: 'Funding <= 0 (Proteção Automática)' }).catch((e: any) => {
                  log.error(`❌ Erro no auto-fechamento [${strat.name}]:`, e.message);
                });
              }
            } else if (spreadMet && trailingEnabled) {
              if (!trailingActiveMap.get(sKey)) {
                trailingActiveMap.set(sKey, true);
                log.info(`🔥 [TRAILING ATIVADO] [${strat.name}] Spread=${spreadExitProfitPct.toFixed(4)}% atingiu alvo ${effectiveSpreadThreshold.toFixed(2)}%. Rastreando pico...`);
              }

              if (currentPeak > 0) {
                const dropFromPeak = ((currentPeak - spreadExitProfitPct) / currentPeak) * 100;
                log.info(`   └ [TRAILING] Pico=${currentPeak.toFixed(4)}% | Atual=${spreadExitProfitPct.toFixed(4)}% | Recuo=${dropFromPeak.toFixed(1)}% (Limite=${trailingDropPct}%)`);

                if (dropFromPeak >= trailingDropPct) {
                  log.info(`🚨 [TRAILING STOP] [${strat.name}] Spread recuou ${dropFromPeak.toFixed(1)}% do pico (${currentPeak.toFixed(4)}%). Fechando posição.`);
                  peakSpreadMap.delete(sKey);
                  trailingActiveMap.delete(sKey);
                  if ((strat as any).autoExecute) {
                    const closeExec = await import('./perp-close-executor');
                    closeExec.closeStrategy(String(strat._id), { dryRun: false, reason: `Trailing Stop (Pico=${currentPeak.toFixed(2)}% → ${spreadExitProfitPct.toFixed(2)}%, Recuo=${dropFromPeak.toFixed(1)}%)` }).catch((e: any) => {
                      log.error(`❌ Erro no auto-fechamento trailing [${strat.name}]:`, e.message);
                    });
                  }
                }
              }
            } else if (spreadMet && !trailingEnabled) {
              log.info(`🚨 [FECHAMENTO ACIONADO] [${strat.name}] Motivo: Alvo de Spread (${spreadExitProfitPct.toFixed(2)}% >= ${effectiveSpreadThreshold.toFixed(2)}%)`);
              if ((strat as any).autoExecute) {
                const closeExec = await import('./perp-close-executor');
                closeExec.closeStrategy(String(strat._id), { dryRun: false, reason: `Alvo de Spread Atingido (${spreadExitProfitPct.toFixed(2)}%)` }).catch((e: any) => {
                  log.error(`❌ Erro no auto-fechamento [${strat.name}]:`, e.message);
                });
              }
            } else if (!spreadMet && trailingActiveMap.get(sKey)) {
              const dropFromPeak = currentPeak > 0 ? ((currentPeak - spreadExitProfitPct) / currentPeak) * 100 : 0;
              log.info(`   └ [TRAILING] Pico=${currentPeak.toFixed(4)}% | Atual=${spreadExitProfitPct.toFixed(4)}% | Recuo=${dropFromPeak.toFixed(1)}% (Limite=${trailingDropPct}%)`);
              if (dropFromPeak >= trailingDropPct) {
                log.info(`🚨 [TRAILING STOP] [${strat.name}] Spread recuou abaixo do alvo. Fechando.`);
                peakSpreadMap.delete(sKey);
                trailingActiveMap.delete(sKey);
                if ((strat as any).autoExecute) {
                  const closeExec = await import('./perp-close-executor');
                  closeExec.closeStrategy(String(strat._id), { dryRun: false, reason: `Trailing Stop (Recuo de ${dropFromPeak.toFixed(1)}% do pico ${currentPeak.toFixed(2)}%)` }).catch((e: any) => {
                    log.error(`❌ Erro no auto-fechamento trailing [${strat.name}]:`, e.message);
                  });
                }
              }
            }
            continue;
          }

          if (fundingPct < minFunding) {
            log.info(`🔻 [${strat.name}] fundingPct ${fundingPct.toFixed(6)}% abaixo do mínimo ${minFunding}%. Ignorando.`);
            continue;
          }

          const maxCap = Number(config?.maxPortfolioCapUSD ?? 500);
          const openStratsList = strategies.filter((s: any) => s.positionOpen);
          const currentPortfolioExposure = openStratsList.reduce((sum: number, s: any) => sum + Number(s.positionSize || s.tradeSize || 0), 0);
          const nextSize = Number(strat.tradeSize || 100);

          if (maxCap > 0 && (currentPortfolioExposure + nextSize) > maxCap) {
            log.warn(`⛔ [FUNDING-ARB] Limite de carteira atingido ($${currentPortfolioExposure.toFixed(2)} exposto + $${nextSize} novo > $${maxCap} limite). Aguardando encerramento de posições.`);
            continue;
          }

          const perpBid = perpBestBid ?? perpTicker?.last ?? null;
          const spotAsk = spotBestAsk ?? spotTicker?.last ?? null;

          if (perpBid && spotAsk) {
            if (perpBid < spotAsk) {
              log.warn(`⚠️ [${strat.name}] Backwardation: perp bid (${perpBid}) < spot ask (${spotAsk}). Entraria com prejuízo imediato. Ignorando.`);
              await PerpArbTrade.create({
                userId: strat.userId,
                strategyId: strat._id,
                strategyName: strat.name,
                perpSymbol: strat.perpSymbol,
                spotSymbol: strat.spotSymbol,
                type: 'funding_check',
                status: 'skipped',
                amount: strat.tradeSize,
                spotPrice: spotAsk,
                perpPrice: perpBid,
                fundingRate: Number(fundingRate),
                fundingPct,
              });
              continue;
            }
          }

          const perpBidNotional = perpBestBid ? perpBidDepth * perpBestBid : 0;
          const spotAskNotional = spotBestAsk ? spotAskDepth * spotBestAsk : 0;
          const tradeSizeNotional = Number(strat.tradeSize);

          if (perpBidNotional <= 0 || spotAskNotional <= 0 || perpBidNotional < tradeSizeNotional || spotAskNotional < tradeSizeNotional) {
            log.warn(`⚠️ [${strat.name}] Liquidez insuficiente. Pulando.`);
            continue;
          }

          const estimatedSlippagePct = Math.max(
            perpTicker?.last && perpBestBid ? Math.abs(perpTicker.last - perpBestBid) / perpBestBid * 100 : 0,
            spotTicker?.last && spotBestAsk ? Math.abs(spotTicker.last - spotBestAsk) / spotBestAsk * 100 : 0,
          );

          if (estimatedSlippagePct > Number(strat.maxSlippagePct)) {
            log.warn(`⚠️ [${strat.name}] Slippage estimado ${estimatedSlippagePct.toFixed(4)}% > maxSlippage ${strat.maxSlippagePct}%. Ignorando.`);
            await PerpArbTrade.create({
              userId: strat.userId,
              strategyId: strat._id,
              strategyName: strat.name,
              perpSymbol: strat.perpSymbol,
              spotSymbol: strat.spotSymbol,
              type: 'funding_check',
              status: 'skipped',
              amount: strat.tradeSize,
              spotPrice: spotTicker?.last ?? spotAsk,
              perpPrice: perpTicker?.last ?? perpBid,
              fundingRate: Number(fundingRate),
              fundingPct,
            });
            continue;
          }

          await PerpArbTrade.create({
            userId: strat.userId,
            strategyId: strat._id,
            strategyName: strat.name,
            perpSymbol: strat.perpSymbol,
            spotSymbol: strat.spotSymbol,
            type: 'funding_check',
            status: 'detected',
            amount: strat.tradeSize,
            spotPrice: spotTicker?.last ?? spotAsk,
            perpPrice: perpTicker?.last ?? perpBid,
            fundingRate: Number(fundingRate),
            fundingPct,
          });

          const liveStrat = await (PerpArbStrategy as any).findById(strat._id).lean();
          const isAutoExecEnabled = liveStrat ? (liveStrat.autoExecute !== false) : true;
          const isScanningOn = globalCloseSettings ? globalCloseSettings.isScanningEnabled !== false : true;

          if (!isScanningOn) {
            log.info(`⏸️ [${strat.name}] Colheita pausada (isScanningEnabled=false). Abertura bloqueada.`);
            continue;
          }

          if (liveStrat && liveStrat.active && isAutoExecEnabled && !liveStrat.positionOpen) {
            try {
              const dupOpen = await (PerpArbStrategy as any).findOne({
                _id: { $ne: liveStrat._id },
                perpSymbol: liveStrat.perpSymbol,
                positionOpen: true,
              }).lean();
              if (dupOpen) {
                log.info(`⛔ [${strat.name}] Já existe posição aberta para ${liveStrat.perpSymbol} (estratégia [${dupOpen.name}]). A corretora agregaria em uma única operação — pulando abertura duplicada.`);
                continue;
              }
            } catch { }

            log.info(`🔍 Verificando saldo livre da conta Spot para ${strat.name}`);
            const perpKeyId = String(strat.perpExchangeKeyId || strat.exchangeKeyId || '');
            const cachedBal = getCachedBalance(perpKeyId);
            const currentSpotBal = cachedBal?.spotUsdt ?? 0;
            const currentFuturesBal = cachedBal?.futuresUsdt ?? 0;

            if (currentSpotBal > 0 && currentSpotBal < 10) {
              log.info(`ℹ️ [${strat.name}] Auto-execução em espera: Saldo livre Spot de $${currentSpotBal.toFixed(2)} USDT é inferior ao mínimo de $10.00 USDT.`);
              continue;
            }
            if (currentSpotBal === 0 && currentFuturesBal === 0) {
              log.info(`ℹ️ [${strat.name}] Saldo não disponível no cache. Pulando abertura neste ciclo.`);
              continue;
            }

            if (isOpeningInFlight()) {
              log.info(`⏸️ [${strat.name}] Abertura em andamento por outra estratégia. Adiando esta auto-execução para o próximo ciclo.`);
              continue;
            }

            log.info(`🔐 Attempting to acquire opening lock for ${strat.name}`);
            const releaseLock = await enterOpeningLock();
            log.info(`🔓 Acquired opening lock for ${strat.name}`);
            try {
              log.info(`🔍 Verificando saldo livre de FUTUROS para ${strat.name}`);
              const futuresFree = currentFuturesBal > 0 ? currentFuturesBal : await getCachedFuturesFree(perpExchange);
              if (futuresFree <= 0) {
                log.info(`⏸️ [${strat.name}] Saldo LIVRE de FUTUROS zerado ($${futuresFree.toFixed(2)}). Adiando abertura (sem margem para o perp).`);
                checkAndAccumulateDailyLoss(strat, 0).catch(() => {});
                continue;
              }
              if (futuresFree < 10) {
                log.info(`⏸️ [${strat.name}] Saldo LIVRE de FUTUROS ($${futuresFree.toFixed(2)}) < $10. Adiando abertura (evita erro 2005).`);
                checkAndAccumulateDailyLoss(strat, 0).catch(() => {});
                continue;
              }

              const exec = await import('./perp-funding-executor');
              await withTimeout(
                exec.executeStrategy(String(strat._id), { dryRun: false }),
                90000,
                null
              ).then(
                () => {},
                (e: any) => {
                  log.error(`❌ Auto-exec falhou [${strat.name}]:`, e.message);
                }
              );
            } finally {
              releaseLock();
            }
          }
        } catch (e: any) {
          log.warn(`⚠️ Erro ao processar estratégia "${(strat as any).name}": ${e.message}`);
          const errMsg = String(e?.message || '');
          if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('IP') || errMsg.includes('AuthenticationError') || errMsg.includes('InvalidNonce')) {
            try {
              const { perpKey } = await resolveExchangeKeys(strat).catch(() => ({ perpKey: null }));
              if (perpKey) invalidateExchangeCache(perpKey.exchangeId, perpKey.apiKey);
            } catch { }
          }
        }
      }
    } catch (globalErr: any) {
      log.error('❌ Funding arb loop error:', globalErr.message);
    }

    log.info('⏳ [FUNDING ARB] Ciclo concluído. Executando GC e aguardando 10s...');
    const g = global as any;
    if (g.gc) {
      g.gc();
    }
    await new Promise(res => setTimeout(res, 10000));
  }
}

if (require.main === module || !module.parent) {
  log.info('⏳ Aguardando 15 segundos para o scanner inicializar primeiro...');
  setTimeout(() => {
    import('../../utils/telegram').then(({ sendTelegramAlert }) => {
      sendTelegramAlert('🟢 *Funding Arb Bot* | Inicializado com sucesso e monitorando.').catch(() => {});
    });
    main().catch(err => { log.error(err); process.exit(1); });
  }, 15000);
}

export default main;

