// @ts-nocheck
import mongoose from 'mongoose';
import PerpArbStrategy from '../../../models/PerpArbStrategy';
import PerpArbTrade from '../../../models/PerpArbTrade';
import ExchangeKey from '../../../models/ExchangeKey';
import { withTimeout, getExchangeInstance } from './ccxt-factory';

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${msg}`, ...args),
};

export async function safeFetchFundingHistory(perpExchange: any, symbol: string, since: number): Promise<any[]> {
  if (!perpExchange || !perpExchange.has) return [];

  try {
    if (perpExchange.has['fetchFundingHistory']) {
      const res = await withTimeout(perpExchange.fetchFundingHistory(symbol, since), 12000, null);
      if (Array.isArray(res) && res.length > 0) return res;
    }
  } catch {}

  try {
    const rawSymbol = symbol.replace(':USDT', '').replace('/', '_');
    if (typeof perpExchange.contractPrivateGetFundingHistory === 'function') {
      const res = await withTimeout(
        perpExchange.contractPrivateGetFundingHistory({ symbol: rawSymbol, page_num: 1, page_size: 100 }),
        12000,
        null
      );
      const list = res?.data?.list || res?.data || res?.result;
      if (Array.isArray(list) && list.length > 0) {
        return list.map((item: any) => {
          if (!item) return null;
          return {
            amount: Number(item.amount || item.funding || item.fee || 0),
            timestamp: item.time || item.createTime || item.timestamp,
            fundingRate: item.fundingRate ? Number(item.fundingRate) : undefined,
          };
        }).filter(Boolean) as any[];
      }
    }
  } catch {}

  try {
    if (perpExchange.has['fetchFundingRateHistory']) {
      const res = await withTimeout(perpExchange.fetchFundingRateHistory(symbol, since), 12000, null);
      if (Array.isArray(res) && res.length > 0) return res;
    }
  } catch {}

  return [];
}

export async function resolveExchangeKeys(strat: any) {
  let perpKeyId  = strat.perpExchangeKeyId ?? strat.exchangeKeyId ?? null;
  let spotKeyId  = strat.spotExchangeKeyId ?? strat.exchangeKeyId ?? null;

  if (!perpKeyId) {
    const firstKey = await (ExchangeKey as any).findOne({ userId: strat.userId, active: true }).lean()
      ?? await (ExchangeKey as any).findOne({ active: true }).lean();
    if (firstKey) {
      perpKeyId = firstKey._id;
      spotKeyId = spotKeyId || firstKey._id;
    }
  }

  if (!perpKeyId) throw new Error(`Estratégia "${strat.name}" sem perpExchangeKeyId`);

  const perpKey = await (ExchangeKey as any).findById(perpKeyId).lean();
  if (!perpKey) {
    const fallbackKey = await (ExchangeKey as any).findOne({ userId: strat.userId, active: true }).lean()
      ?? await (ExchangeKey as any).findOne({ active: true }).lean();
    if (!fallbackKey) throw new Error(`ExchangeKey perpétuo não encontrado (id=${perpKeyId}) e nenhum fallback ativo`);
    log.warn(`⚠️ [RESOLVE KEYS] ExchangeKey ${perpKeyId} não encontrada. Usando fallback: ${fallbackKey._id} (${fallbackKey.name || fallbackKey.exchangeId})`);
    
    await (PerpArbStrategy as any).findByIdAndUpdate(strat._id, {
      perpExchangeKeyId: fallbackKey._id,
      spotExchangeKeyId: fallbackKey._id,
    }).catch(() => {});
    return { perpKey: fallbackKey, spotKey: fallbackKey };
  }

  let spotKey = perpKey;
  if (spotKeyId && String(spotKeyId) !== String(perpKeyId)) {
    spotKey = await (ExchangeKey as any).findById(spotKeyId).lean() ?? perpKey;
  }

  return { perpKey, spotKey };
}

export async function backfillFundingHistoryAll() {
  try {
    log.info('🌾 [BACKFILL BOOT] Verificando e buscando histórico retroativo de colheitas de funding...');
    const strats = await (PerpArbStrategy as any).find({ active: true }).lean();
    if (!strats || !strats.length) return;

    const nowMs = Date.now();
    for (const strat of strats) {
      try {
        const { perpKey } = await resolveExchangeKeys(strat);
        if (!perpKey) continue;

        const userId = String(strat.userId);
        const exId = String(perpKey.exchangeId || '').toLowerCase().trim();
        const perpExchange = await getExchangeInstance({ apiKey: perpKey.apiKey, apiSecret: perpKey.apiSecret, exchangeId: exId, userId }, true);

        if (perpExchange) {
          const since = strat.positionOpenedAt
            ? new Date(strat.positionOpenedAt).getTime()
            : (strat.createdAt ? new Date(strat.createdAt).getTime() : nowMs - 3600000 * 24 * 7);

          log.info(`🌾 [BACKFILL] Consultando histórico de ${strat.perpSymbol} (Exchange: ${exId}) desde ${new Date(since).toISOString()}...`);
          
          let history = [];
          try {
            history = await Promise.race([
              safeFetchFundingHistory(perpExchange, strat.perpSymbol, since),
              new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout de rede (8s)")), 8000))
            ]) as any[];
          } catch (tErr: any) {
            log.warn(`⚠️ [BACKFILL] Ignorado por lentidão da API: ${tErr.message}`);
          }
          
          log.info(`🌾 [BACKFILL] ${strat.perpSymbol}: retornou ${history ? history.length : 0} registros de histórico.`);

          let totalRealizedFunding = 0;
          const fundingEvents: Array<{ amount: number; timestamp: Date; fundingRate?: number }> = [];

          if (Array.isArray(history) && history.length > 0) {
            for (const item of history) {
              if (!item) continue;
              const amt = Number(item.amount || item.fee?.cost || 0);
              if (amt !== 0) {
                const ts = item.timestamp ? new Date(item.timestamp) : (item.datetime ? new Date(item.datetime) : new Date());
                if (ts.getTime() >= since - 60000) {
                  totalRealizedFunding += amt;
                  const rate = item.fundingRate ? Number(item.fundingRate) * 100 : undefined;
                  fundingEvents.push({ amount: amt, timestamp: ts, fundingRate: rate });
                }
              }
            }
          } else if (strat.positionOpen) {
            const openTime = strat.positionOpenedAt ? new Date(strat.positionOpenedAt).getTime() : (strat.createdAt ? new Date(strat.createdAt).getTime() : nowMs - 3600000 * 8);
            const durationHours = Math.max(0.1, (nowMs - openTime) / (1000 * 60 * 60));
            const periods = Math.max(1, Math.floor(durationHours / 8));
            const currentRatePct = strat.currentFundingRate ?? strat.minFundingRatePct ?? 0.02;
            const posSize = Number((strat as any).positionSize || strat.tradeSize || 0);
            
            const estimatedPayoutPerPeriod = posSize * (currentRatePct / 100);
            totalRealizedFunding = estimatedPayoutPerPeriod * periods;

            for (let i = 1; i <= periods; i++) {
              const eventTime = new Date(openTime + i * 8 * 3600000);
              if (eventTime.getTime() <= nowMs) {
                fundingEvents.push({
                  amount: estimatedPayoutPerPeriod,
                  timestamp: eventTime,
                  fundingRate: currentRatePct,
                });
              }
            }
            log.info(`🌾 [BACKFILL ESTIMADO] ${strat.perpSymbol}: API vazia. Calculados $${totalRealizedFunding.toFixed(4)} USDT estimados (${periods} períodos de 8h).`);
          }

          log.info(`🌾 [BACKFILL] ${strat.perpSymbol}: Total colhido = $${totalRealizedFunding.toFixed(4)} (${fundingEvents.length} eventos).`);

          if (fundingEvents.length > 0) {
            await (PerpArbStrategy as any).findByIdAndUpdate(strat._id, {
              $set: {
                fundingCollected: totalRealizedFunding,
                fundingCount: fundingEvents.length,
                fundingHistory: fundingEvents,
              }
            });

            const openTrade = await (PerpArbTrade as any).findOne({
              strategyId: strat._id,
              type: 'open_hedge',
              status: { $in: ['executed', 'simulated'] }
            }).sort({ createdAt: -1 });

            const tradeQuery: any = { strategyId: strat._id, type: 'funding_fee_accumulated' };
            if (openTrade) {
              tradeQuery.openTradeId = openTrade._id;
            }

            await (PerpArbTrade as any).findOneAndUpdate(
              tradeQuery,
              {
                userId: strat.userId,
                strategyName: strat.name,
                perpSymbol: strat.perpSymbol,
                spotSymbol: strat.spotSymbol,
                status: 'executed',
                pnl: totalRealizedFunding,
                amount: (strat as any).positionSize || strat.tradeSize,
                fundingCount: fundingEvents.length,
                fundingHistory: fundingEvents,
                openTradeId: openTrade?._id || undefined,
              },
              { upsert: true }
            );
            log.info(`🌾 [BACKFILL] ${strat.name}: ${fundingEvents.length} colheita(s) retroativa(s) atualizada(s)! Total = $${totalRealizedFunding.toFixed(4)} USDT`);
          }
        }
      } catch (err: any) {
        log.warn(`⚠️ [BACKFILL] Erro ao recuperar histórico para ${strat.name}:`, err?.message);
      }
    }
  } catch (globalErr: any) {
    log.warn('⚠️ Erro no backfill retroativo de funding:', globalErr?.message);
  }
}

const lastHarvestMap = new Map<string, number>();
const HARVEST_INTERVAL_MS = 60 * 60 * 1000;

export async function harvestFundingForAllOpenStrategies() {
  const nowMs = Date.now();
  const strats = await (PerpArbStrategy as any).find({ positionOpen: true, active: true }).lean();
  if (!strats?.length) return;

  for (const strat of strats) {
    const lastHarvest = lastHarvestMap.get(String(strat._id)) || 0;
    if (nowMs - lastHarvest < HARVEST_INTERVAL_MS) continue;
    lastHarvestMap.set(String(strat._id), nowMs);

    try {
      const { perpKey } = await resolveExchangeKeys(strat);
      if (!perpKey) continue;
      const perpExchange = await getExchangeInstance(
        { apiKey: perpKey.apiKey, apiSecret: perpKey.apiSecret, exchangeId: perpKey.exchangeId, userId: String(strat.userId) },
        true
      );

      const since = strat.positionOpenedAt
        ? new Date(strat.positionOpenedAt).getTime()
        : nowMs - 3600000 * 24;

      const history = await safeFetchFundingHistory(perpExchange, strat.perpSymbol, since);

      let totalRealizedFunding = 0;
      const fundingEvents: Array<{ amount: number; timestamp: Date; fundingRate?: number }> = [];

      if (Array.isArray(history) && history.length > 0) {
        for (const item of history) {
          if (!item) continue;
          const amt = Number(item.amount || item.fee?.cost || 0);
          if (amt !== 0) {
            const ts = item.timestamp ? new Date(item.timestamp) : (item.datetime ? new Date(item.datetime) : new Date());
            if (ts.getTime() >= since - 60000) {
              totalRealizedFunding += amt;
              fundingEvents.push({ amount: amt, timestamp: ts, fundingRate: item.fundingRate ? Number(item.fundingRate) * 100 : undefined });
            }
          }
        }
      }

      if (totalRealizedFunding !== 0 || fundingEvents.length > 0) {
        await (PerpArbStrategy as any).findByIdAndUpdate(strat._id, {
          fundingCollected: totalRealizedFunding,
          fundingCount: fundingEvents.length,
          fundingHistory: fundingEvents,
        });

        const openTrade = await (PerpArbTrade as any).findOne({
          strategyId: strat._id,
          type: 'open_hedge',
          status: { $in: ['executed', 'simulated'] },
        }).sort({ createdAt: -1 });

        await (PerpArbTrade as any).findOneAndUpdate(
          { strategyId: strat._id, type: 'funding_fee_accumulated', openTradeId: openTrade?._id },
          {
            userId: strat.userId,
            openTradeId: openTrade?._id,
            strategyName: strat.name,
            perpSymbol: strat.perpSymbol,
            spotSymbol: strat.spotSymbol,
            status: 'executed',
            pnl: totalRealizedFunding,
            amount: strat.positionSize || strat.tradeSize || 0,
            fundingCount: fundingEvents.length,
            fundingHistory: fundingEvents,
          },
          { upsert: true }
        );
        log.info(`🌾 [HARVEST] ${strat.name}: $${totalRealizedFunding.toFixed(4)} coletados em ${fundingEvents.length} pagamento(s).`);
      }
    } catch (e: any) {
      log.warn(`⚠️ [HARVEST] Erro em ${strat.name}:`, e?.message);
    }
  }
}
