import { loadEnv } from '../../utils/env-loader';
loadEnv();
import { connectToDatabase } from '../../config/db';
import { scanExchangeFunding, ScannerOpportunity, SCANNER_CONFIG, cleanupSkippedTrades } from './scanner';
import PerpArbStrategy from '../../models/PerpArbStrategy';
import PerpArbSettings from '../../models/PerpArbSettings';
import ExchangeKey from '../../models/ExchangeKey';
import BotStatus from '../../models/BotStatus';
import PortfolioSnapshot from '../../models/PortfolioSnapshot';
import { getDetailedSpotBalance, getDetailedFuturesBalance, getExchangeInstance, takePortfolioSnapshot, backfillFundingHistoryAll, consolidateDuplicateOpenPositions, harvestFundingForAllOpenStrategies } from './funding-arb';

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${msg}`, ...args),
};

const isTelegramEnabled = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

process.on('uncaughtException', (err) => {
  log.error(`🔥 [FATAL CRASH] uncaughtException detectada: ${err?.message} | Stack: ${err?.stack}`);
});

process.on('unhandledRejection', (reason: any, promise) => {
  log.error(`🔥 [FATAL CRASH] unhandledRejection detectada. Razão: ${reason?.message || reason} | Stack: ${reason?.stack}`);
});

const requiredEnv = ['MONGODB_URI'];
for (const v of requiredEnv) {
  if (!process.env[v]) {
    console.error(`❌ ENV missing: ${v}`);
    process.exit(1);
  }
}

const BASE_CYCLE_MS = 30 * 1000;
const rebalanceResultCache = new Map<string, { result: boolean; at: number }>();
const REBALANCE_RESULT_CACHE_MS = 30000;

async function attemptRebalance(spotEx: any, perpEx: any, exId: string): Promise<boolean> {
  const cacheKey = `${exId}_${spotEx.apiKey || ''}`;
  const cached = rebalanceResultCache.get(cacheKey);
  if (cached && Date.now() - cached.at < REBALANCE_RESULT_CACHE_MS) return cached.result;

  try {
    const { spotUsdt } = await getDetailedSpotBalance(spotEx);
    const { futuresUsdt } = await getDetailedFuturesBalance(perpEx);
    const totalFreeUsdt = spotUsdt + futuresUsdt;

    if (totalFreeUsdt <= 0) {
      rebalanceResultCache.set(cacheKey, { result: false, at: Date.now() });
      return false;
    }

    const targetHalf = totalFreeUsdt / 2;
    const diffFromTarget = Math.abs(spotUsdt - targetHalf);
    const imbalancePct = (diffFromTarget / totalFreeUsdt) * 100;

    if (imbalancePct > 5 && (spotUsdt > 13 || futuresUsdt > 13)) {
      const transferAmount = Math.floor(diffFromTarget * 100) / 100;
      if (transferAmount < 1) {
        rebalanceResultCache.set(cacheKey, { result: false, at: Date.now() });
        return false;
      }

      const fromAcc = spotUsdt > futuresUsdt ? 'spot' : (exId === 'mexc' || exId === 'gateio' || exId === 'bybit' ? 'swap' : 'future');
      const toAcc = spotUsdt > futuresUsdt ? (exId === 'mexc' || exId === 'gateio' || exId === 'bybit' ? 'swap' : 'future') : 'spot';

      let transferDone = false;
      if (typeof spotEx.transfer === 'function') {
        try {
          await spotEx.transfer('USDT', transferAmount, fromAcc, toAcc);
          transferDone = true;
        } catch (e: any) {
          log.warn(`⚠️ [REBALANCE ${exId.toUpperCase()}] CCXT transfer falhou: ${e?.message}`);
        }
      }

      if (!transferDone && exId === 'mexc') {
        try {
          const type = fromAcc === 'spot' ? 'SPOT_TO_CONTRACT' : 'CONTRACT_TO_SPOT';
          if (typeof spotEx.contractPrivatePostAssetInternalTransfer === 'function') {
            await spotEx.contractPrivatePostAssetInternalTransfer({ currency: 'USDT', amount: transferAmount, type });
            transferDone = true;
          }
        } catch (e: any) {
          log.warn(`⚠️ [REBALANCE MEXC Direct API] Falha na transferência direta:`, e?.message);
        }
      }

      if (transferDone) {
        log.info(`✅ 🔄 [REBALANCE ${exId.toUpperCase()}] Transferido $${transferAmount.toFixed(2)} USDT de ${fromAcc.toUpperCase()} -> ${toAcc.toUpperCase()} (Desbalanceamento: ${imbalancePct.toFixed(1)}%)`);
        rebalanceResultCache.set(cacheKey, { result: true, at: Date.now() });
        return true;
      }
    }

    rebalanceResultCache.set(cacheKey, { result: false, at: Date.now() });
    return false;
  } catch (e: any) {
    log.warn(`⚠️ [REBALANCE ${exId.toUpperCase()}] Erro:`, e?.message);
    rebalanceResultCache.set(cacheKey, { result: false, at: Date.now() });
    return false;
  }
}

async function createStrategiesFromOpportunities(
  opportunities: ScannerOpportunity[],
  exchangeKeys: Map<string, any>,
  settings: any,
) {
  if (!opportunities.length) return;

  const existing = await (PerpArbStrategy as any).find({ userId: settings.userId, active: true })
    .select('exchangeId perpSymbol spotSymbol').lean();
  const existingPairs = new Set(existing.map((s: any) => `${s.exchangeId}|${s.perpSymbol}|${s.spotSymbol}`));

  const exchangeTradeSizes = new Map<string, number>();
  const processedExchanges = new Set<string>();

  for (const op of opportunities) {
    if (processedExchanges.has(op.exchangeId)) continue;
    processedExchanges.add(op.exchangeId);

    const key = exchangeKeys.get(op.exchangeId);
    if (!key) continue;

    let tradeSize = Number(settings.tradeSize ?? SCANNER_CONFIG.targetSpotBuyUSD);

    try {
      const spotEx = await getExchangeInstance(key, false);
      const perpEx = await getExchangeInstance(key, true);

      await attemptRebalance(spotEx, perpEx, op.exchangeId);
      await new Promise(r => setTimeout(r, 1500));

      const { spotUsdt } = await getDetailedSpotBalance(spotEx);
      const { futuresUsdt } = await getDetailedFuturesBalance(perpEx);

      if (futuresUsdt <= 0) {
        log.warn(`⚠️ [TRADE SIZE ${op.exchangeId.toUpperCase()}] Saldo livre de FUTUROS zerado ($${futuresUsdt.toFixed(2)}). Pulando criação de estratégia para não falhar na abertura.`);
        continue;
      }

      const minAvailable = Math.min(
        spotUsdt > 0 ? spotUsdt : Infinity,
        futuresUsdt > 0 ? futuresUsdt : Infinity,
      );

      if (minAvailable > 0 && minAvailable !== Infinity) {
        if (minAvailable < tradeSize) {
          log.info(`⚠️ [TRADE SIZE LIMITADO ${op.exchangeId.toUpperCase()}] Config=$${tradeSize.toFixed(2)} | Disponível=$${minAvailable.toFixed(2)} | Usando=$${minAvailable.toFixed(2)}`);
          tradeSize = minAvailable;
        }
      }

      if (tradeSize < 10) {
        log.warn(`⚠️ Scanner ignorado para ${op.exchangeId.toUpperCase()}: tradeSize $${tradeSize.toFixed(2)} abaixo do mínimo $10.`);
        continue;
      }
    } catch (e: any) {
      log.warn(`⚠️ Erro ao calcular tradeSize para ${op.exchangeId}:`, e?.message);
    }

    exchangeTradeSizes.set(op.exchangeId, tradeSize);
  }

  const maxPerScan = settings.maxStrategiesPerScan ?? SCANNER_CONFIG.maxStrategiesPerScan;
  let created = 0;

  for (const opp of opportunities) {
    if (created >= maxPerScan) break;

    const key = exchangeKeys.get(opp.exchangeId);
    if (!key) continue;

    const pairKey = `${opp.exchangeId}|${opp.symbol}|${opp.spotSymbol}`;
    if (existingPairs.has(pairKey)) continue;

    const tradeSize = exchangeTradeSizes.get(opp.exchangeId);
    if (!tradeSize) continue;

    const strat = new (PerpArbStrategy as any)({
      userId: settings.userId,
      settingsId: settings._id,
      exchangeId: opp.exchangeId,
      name: `Auto-${opp.symbol.replace(':USDT', '')}`,
      perpSymbol: opp.symbol,
      spotSymbol: opp.spotSymbol,
      tradeSize,
      minFundingRatePct: settings.minFundingRatePct ?? SCANNER_CONFIG.minFundingRatePct,
      maxSlippagePct: settings.maxSlippagePct ?? 0.1,
      maxDailyLoss: settings.maxDailyLoss ?? 10,
      closeThresholdPct: settings.spreadCloseThresholdPct ?? 0.3,
      cooldownAfterLossMs: 3600000,
      autoExecute: true,
      isAutoCreated: true,
      active: true,
      positionOpen: false,
      perpExchangeKeyId: key._id,
      spotExchangeKeyId: key._id,
    });

    await strat.save();
    existingPairs.add(pairKey);
    created++;
    log.info(`✅ Estratégia criada [${strat.name}] @ ${opp.exchangeId} (user=${settings.userId})`);
  }

  if (created > 0) {
    log.info(`🆕 [settings ${settings._id}] Scanner criou ${created} estratégia(s) este ciclo.`);
  }
}

async function deleteOldStrategies(userId: any) {
  const threshold = Date.now() - 10 * 60 * 1000;
  const res = await (PerpArbStrategy as any).deleteMany({
    userId,
    isAutoCreated: true,
    positionOpen: false,
    createdAt: { $lt: new Date(threshold) },
  }).catch(() => null);
  if (res?.deletedCount) {
    log.info(`🧹 [CLEANUP ${userId}] Removidas ${res.deletedCount} estratégias antigas sem posição.`);
  }
}

async function runRoundForSettings(settings: any) {
  const t0 = Date.now();
  const userId = settings.userId;
  const keys = await (ExchangeKey as any).find({ userId, active: true }).lean();
  log.info(`⏱️ [settings ${settings._id}] ExchangeKeys carregadas: ${keys.length} (${Date.now() - t0}ms)`);

  const exchanges: string[] = settings.allowedExchanges?.length
    ? settings.allowedExchanges
    : Array.from(new Set(keys.map((k: any) => k.exchangeId)));

  const keyByExchange = new Map<string, any>();
  for (const k of keys as any[]) {
    if (!keyByExchange.has(k.exchangeId)) keyByExchange.set(k.exchangeId, k);
  }

  if (keyByExchange.size === 0) {
    log.warn(`⚠️ [settings ${settings._id}] Nenhuma ExchangeKey ativa — pulando.`);
    return;
  }

  await deleteOldStrategies(userId);

  const config = {
    minFundingRatePct: settings.minFundingRatePct ?? SCANNER_CONFIG.minFundingRatePct,
    minVolume24hUSD: settings.minVolume24hUSD ?? SCANNER_CONFIG.minVolume24hUSD,
    targetSpotBuyUSD: settings.targetSpotBuyUSD ?? SCANNER_CONFIG.targetSpotBuyUSD,
    maxStrategiesPerScan: settings.maxStrategiesPerScan ?? SCANNER_CONFIG.maxStrategiesPerScan,
    maxPerpScan: settings.maxPerpScan ?? SCANNER_CONFIG.maxPerpScan,
    minEntrySpreadPct: settings.minEntrySpreadPct ?? 0,
  };

  log.info(`🔍 [settings ${settings._id}] Escaneando [${exchanges.join(', ')}] para user=${userId}...`);

  let allOpportunities: ScannerOpportunity[] = [];

  const scanResults = await Promise.allSettled(
    exchanges
      .filter(ex => {
        if (!keyByExchange.has(ex)) {
          log.warn(`⚠️ Sem chave ativa em ${ex} — pulando.`);
          return false;
        }
        return true;
      })
      .map(async ex => {
        const tex0 = Date.now();
        try {
          const opps = await scanExchangeFunding(ex, config).catch((e: any) => {
            log.error(`❌ Scanner error para ${ex} após ${Date.now() - tex0}ms: ${e?.message}`);
            return [];
          });
          log.info(`⏱️ [settings ${settings._id}] scanExchangeFunding(${ex}) levou ${Date.now() - tex0}ms, opps=${opps.length}`);
          return opps;
        } catch (sincErr: any) {
          log.error(`❌ [SCAN SÍNCRONO] Erro crítico ao iniciar scanner de ${ex}: ${sincErr?.message}`);
          return [];
        }
      })
  );

  for (const result of scanResults) {
    if (result.status === 'fulfilled') {
      allOpportunities = allOpportunities.concat(result.value);
    }
  }

  if (!allOpportunities.length) {
    log.info(`🔍 [settings ${settings._id}] Nenhuma oportunidade encontrada neste ciclo.`);
    return;
  }

  allOpportunities.sort((a, b) => {
    const diff = b.netFundingPct - a.netFundingPct;
    if (Math.abs(diff) > 0.005) return diff;
    return b.volume24hUSD - a.volume24hUSD;
  });

  log.info(`🔍 [settings ${settings._id}] ${allOpportunities.length} oportunidade(s) encontrada(s).`);

  await createStrategiesFromOpportunities(allOpportunities, keyByExchange, settings);

  log.info(`✅ [settings ${settings._id}] runRoundForSettings TOTAL: ${Date.now() - t0}ms`);
}

async function runRound() {
  const t0 = Date.now();
  const settingsList = await PerpArbSettings.find().lean();
  log.info(`⏱️ [SCANNER] PerpArbSettings carregados: ${settingsList.length} (${Date.now() - t0}ms)`);

  if (!settingsList.length) {
    log.warn('⚠️ Nenhum PerpArbSettings no banco. Abra o frontend e salve as configurações.');
    return;
  }

  try {
    await cleanupSkippedTrades();
  } catch { }

  for (const settings of settingsList as any[]) {
    if (settings.userId) {
      takePortfolioSnapshot(String(settings.userId)).catch(err => {
        log.error(`❌ [SNAPSHOT BACKGROUND] Erro em segundo plano: ${err?.message}`);
      });
    }
  }

  cleanupOldSnapshotsThrottled();

  harvestFundingForAllOpenStrategies().catch(err => {
    log.error(`❌ [HARVEST BACKGROUND] Erro em segundo plano: ${err?.message}`);
  });

  for (const settings of settingsList as any[]) {
    if (settings.userId) {
      (BotStatus as any).updateOne(
        { userId: String(settings.userId), botName: 'funding-arb' },
        { $set: { lastHeartbeat: new Date() } },
        { upsert: true }
      ).catch(() => {});
      break;
    }
  }

  for (const settings of settingsList as any[]) {
    if (settings.isScanningEnabled !== true) continue;

    const interval = settings.scanIntervalMs ?? SCANNER_CONFIG.scanIntervalMs;
    const lastScan = settings.lastScannedAt ? new Date(settings.lastScannedAt).getTime() : 0;
    if (Date.now() - lastScan < interval) continue;

    const ts0 = Date.now();
    try {
      await runRoundForSettings(settings);
      log.info(`⏱️ [SCANNER] roundForSettings ${settings._id} levou ${Date.now() - ts0}ms`);
      await PerpArbSettings.updateOne(
        { _id: settings._id },
        { $set: { lastScannedAt: new Date() } }
      );
    } catch (e: any) {
      log.error(`❌ Erro no ciclo do settings ${settings._id} após ${Date.now() - ts0}ms: ${e?.message}`);
    }
  }
}

async function mainLoop() {
  await connectToDatabase();
  log.info('🚀 [SCANNER LOOP] Iniciado. Monitorando PerpArbSettings habilitados.');

  try {
    const ipRes = await fetch('https://api.ipify.org?format=json');
    if (ipRes.ok) {
      const ipData = await ipRes.json() as any;
      log.info(`🌐 [OUTBOUND IP] IP de Saída do Bot: ${ipData.ip}`);
    }
  } catch (e: any) {
    log.warn(`⚠️ Não foi possível identificar o IP de saída: ${e.message}`);
  }

  if (isTelegramEnabled()) {
    const { sendTelegramAlert } = require('../../utils/telegram');
    await sendTelegramAlert("🟢 *Scanner Perpétuos* | Inicializado com sucesso e monitorando.").catch(() => {});
    log.info('💣 Boot alert enviado — scanner está vivo!');
  }

  try {
    const initConfig = await PerpArbSettings.findOne().lean() as any;
    const targetUserId = initConfig?.userId ? String(initConfig.userId) : '';
    log.info('📸 [BOOT] Disparando snapshot patrimonial...');
    await takePortfolioSnapshot(targetUserId, true);
    log.info('🧹 [BOOT] Disparando consolidação de posições duplicadas...');
    await consolidateDuplicateOpenPositions();
    log.info('🌾 [BOOT] Disparando backfill de histórico de funding...');
    await backfillFundingHistoryAll();
  } catch (e: any) {
    log.warn(`⚠️ Erro no boot do scanner-loop: ${e?.message}`);
  }

  let cycleCount = 0;

  while (true) {
    cycleCount++;
    const cycleStart = Date.now();
    try {
      await runRound();
    } catch (e: any) {
      log.error(`❌ Erro no loop de scanner: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
    }
    log.info(`🔄 [SCANNER LOOP] Ciclo #${cycleCount} completo em ${Date.now() - cycleStart}ms. Dormindo ${BASE_CYCLE_MS}ms...`);
    await new Promise(r => setTimeout(r, BASE_CYCLE_MS));
  }
}

let lastCleanupTimestamp = 0;
async function cleanupOldSnapshotsThrottled() {
  const now = Date.now();
  if (now - lastCleanupTimestamp < 43200000) return;
  lastCleanupTimestamp = now;

  try {
    const seteDiasAtras = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const res = await PortfolioSnapshot.deleteMany({
      timestamp: { $lt: seteDiasAtras }
    });
    if (res?.deletedCount) {
      log.info(`🧹 [CLEANUP SNAPSHOTS] Removidos ${res.deletedCount} snapshots patrimoniais com mais de 7 dias.`);
    }
  } catch (e: any) {
    log.error(`❌ [CLEANUP SNAPSHOTS] Erro na limpeza: ${e.message}`);
  }
}

mainLoop().catch(e => log.error(`Fatal error: ${e.message}`));
