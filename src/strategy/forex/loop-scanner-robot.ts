// Loop scanner da Arbitragem Forex: varre oportunidades, salva como trades e
// cria estratégias (ForexArbStrategy) para as melhores. Espelha o padrão de
// perpetuals/loop-scanner-robot.ts.
import { loadEnv } from '../../utils/env-loader';
loadEnv();
import { connectToDatabase } from '../../config/db';
import { scanForexArbitrage, ForexOpportunity, cleanupSkippedTrades, SCANNER_CONFIG, isCtraderExchange } from './scanner';
import { isFixExchange } from './fix/fix-factory';
import { isDukascopyExchange } from './dukascopy/dukascopy-factory';
import ForexArbSettings from '../../models/ForexArbSettings';
import ForexArbStrategy from '../../models/ForexArbStrategy';
import ExchangeKey from '../../models/ExchangeKey';
import BotStatus from '../../models/BotStatus';

const getTs = () => `[${new Date().toISOString()}]`;
const log = {
  info: (...args: any[]) => console.log(getTs(), '[FOREX-SCANNER]', ...args),
  warn: (...args: any[]) => console.warn(getTs(), '[FOREX-SCANNER]', ...args),
  error: (...args: any[]) => console.error(getTs(), '[FOREX-SCANNER]', ...args),
};

process.on('uncaughtException', (err) => {
  log.error('🔥 [FATAL CRASH] uncaughtException detectada:', err?.message, '| Stack:', err?.stack);
});
process.on('unhandledRejection', (reason: any) => {
  log.error('🔥 [FATAL CRASH] unhandledRejection detectada. Razão:', reason?.message || reason);
});

const BASE_CYCLE_MS = 3000;

async function deleteOldStrategies(userId: any) {
  const threshold = Date.now() - 10 * 60 * 1000;
  const res = await (ForexArbStrategy as any).deleteMany({
    userId,
    isAutoCreated: true,
    positionOpen: false,
    active: true,
    createdAt: { $lt: new Date(threshold) },
  }).catch(() => null);
  if (res?.deletedCount) {
    log.info(`🧹 [CLEANUP ${userId}] Removidas ${res.deletedCount} estratégias Forex antigas sem posição.`);
  }
}

async function runRoundForSettings(settings: any) {
  const t0 = Date.now();
  const userId = settings.userId;
  const keys = await (ExchangeKey as any).find({ userId, active: true }).lean();
  log.info(`⏱️ [settings ${settings._id}] ExchangeKeys Forex carregadas: ${keys.length}`);

  const exchanges: string[] = settings.allowedExchanges?.length
    ? settings.allowedExchanges
    : Array.from(new Set(keys.map((k: any) => k.exchangeId)));

  const keyByExchange = new Map<string, any>();
  for (const k of keys as any[]) {
    if (!keyByExchange.has(k.exchangeId)) keyByExchange.set(k.exchangeId, k);
  }

  if (keyByExchange.size === 0) {
    log.warn(`⚠️ [settings ${settings._id}] Nenhuma ExchangeKey ativa para Forex — pulando.`);
    return;
  }

  await deleteOldStrategies(userId);

  const config = {
    minProfitPct: settings.minProfitPct ?? SCANNER_CONFIG.minProfitPct,
    minVolume24hUSD: settings.minVolume24hUSD ?? SCANNER_CONFIG.minVolume24hUSD,
    maxPairs: SCANNER_CONFIG.maxPairs,
    maxTrianglesPerScan: 200,
    // Não força rota negativa: o scanner só reporta oportunidades ≥ minProfitPct.
    // O fluxo de captura instantânea no forex-arb também não deve operar no prejuízo.
    forceFirstExecution: false,
    // cTrader/FIX/Dukascopy não expõem volume 24h por ticker → pula o filtro de volume
    skipVolumeFilter: (ex: string) => isCtraderExchange(ex) || isFixExchange(ex) || isDukascopyExchange(ex),
  };

  log.info(`🔍 [settings ${settings._id}] Escaneando Forex em [${exchanges.join(', ')}]...`);

  const scanResults = await Promise.allSettled(
    exchanges.map(async (ex: string) => {
      try {
        return await scanForexArbitrage(ex, config, keyByExchange.get(ex));
      } catch (e: any) {
        log.error(`❌ ForexScanner error para ${ex}:`, e?.message);
        return [] as ForexOpportunity[];
      }
    })
  );

  let allOpportunities: ForexOpportunity[] = [];
  for (const result of scanResults) {
    if (result.status === 'fulfilled') allOpportunities = allOpportunities.concat(result.value);
  }

  allOpportunities.sort((a, b) => b.expectedProfitPct - a.expectedProfitPct);

  // A criação de estratégias foi DESATIVADA: o fluxo agora é de captura
  // instantânea no forex-arb (abre + fecha na hora, fica flat). Criar
  // estratégias aqui fazia o forex-arb executar o fluxo antigo (deixar
  // posição aberta). Mantemos o log para observabilidade.
  if (allOpportunities.length > 0) {
    log.info(`📊 [settings ${settings._id}] ${allOpportunities.length} oportunidade(s) encontradas (captura será avaliada pelo forex-arb). Melhor: ${allOpportunities[0].legs.map(l => l.symbol).join(' -> ')} (${allOpportunities[0].expectedProfitPct.toFixed(4)}%)`);
  }

  log.info(`✅ [settings ${settings._id}] runRoundForSettings Forex TOTAL: ${Date.now() - t0}ms`);
}

async function runRound() {
  const settingsList = await ForexArbSettings.find().lean();
  if (!settingsList.length) {
    log.warn('⚠️ Nenhum ForexArbSettings no banco. Crie as configurações no frontend.');
    return;
  }

  await cleanupSkippedTrades().catch(() => null);

  // Heartbeat
  for (const settings of settingsList as any[]) {
    if (settings.userId) {
      (BotStatus as any).updateOne(
        { userId: String(settings.userId), botName: 'forex-arb' },
        { $set: { lastHeartbeat: new Date() } },
        { upsert: true }
      ).catch(() => {});
      break;
    }
  }

  for (const settings of settingsList as any[]) {
    if (settings.isScanningEnabled !== true) continue;

    const interval = Math.min(settings.scanIntervalMs ?? 3000, 3000);
    const lastScan = settings.lastScannedAt ? new Date(settings.lastScannedAt).getTime() : 0;
    if (Date.now() - lastScan < interval) continue;

    const ts0 = Date.now();
    try {
      await runRoundForSettings(settings);
      await ForexArbSettings.updateOne(
        { _id: settings._id },
        { $set: { lastScannedAt: new Date() } }
      );
      log.info(`⏱️ [SCANNER FOREX] roundForSettings ${settings._id} levou ${Date.now() - ts0}ms`);
    } catch (e: any) {
      log.error(`❌ Erro no ciclo do settings ${settings._id}:`, e?.message, e?.stack);
    }
  }
}

async function mainLoop() {
  await connectToDatabase();
  log.info('🚀 [FOREX SCANNER LOOP] Iniciado. Monitorando ForexArbSettings habilitados.');

  while (true) {
    try {
      await runRound();
    } catch (e: any) {
      log.error('❌ Erro no loop de scanner Forex:', e instanceof Error ? e.message : JSON.stringify(e));
    }
    log.info(`🔄 [FOREX SCANNER LOOP] Ciclo completo. Dormindo ${BASE_CYCLE_MS}ms...`);
    await new Promise(r => setTimeout(r, BASE_CYCLE_MS));
  }
}

mainLoop().catch(e => log.error('Fatal error:', e));
