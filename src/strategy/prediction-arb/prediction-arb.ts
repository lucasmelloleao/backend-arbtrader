// Loop principal do robô de prediction markets (PredictionArb).
// Ciclo: scan → auto-execução → monitoramento/saída → heartbeat.
import { loadEnv } from '../../utils/env-loader';
loadEnv();
import mongoose from 'mongoose';
import Redis from 'ioredis';
import PredictionArbSettings from '../../models/PredictionArbSettings';
import PredictionArbStrategy from '../../models/PredictionArbStrategy';
import BotStatus from '../../models/BotStatus';
import { connectToDatabase } from '../../config/db';
import { sendTelegramAlert } from '../../utils/telegram';
import { runScan, resolvePolymarketKey } from './prediction-scanner';
import { executeStrategy, reconcilePosition } from './prediction-executor';
import { closeStrategy } from './prediction-close';
import { rebalanceInventory, runMarketMaking } from './prediction-market-maker';
import { isPredictionLiveAllowed } from './prediction-live';
import { resolveClobCredentials } from './helpers/clob-client';
import { redeemPositionsViaSdk } from './helpers/secure-client';
import { syncPredictionHistory } from './sync-history';
import ExchangeKey from '../../models/ExchangeKey';

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${msg}`, ...args),
};

const isTelegramEnabled = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
const BOT_NAME = 'prediction-arb';
const DEFAULT_INTERVAL_MS = 60_000;

// Contador de ciclos para o sync periódico do histórico (a cada 4 ciclos ~2min)
let syncCycleCount = 0;

function getRedisClient(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const c = new Redis(url);
    c.on('error', () => {});
    return c;
  } catch {
    return null;
  }
}

async function heartbeat(userId: any) {
  if (!userId) return;
  await (BotStatus as any).updateOne(
    { userId: String(userId), botName: BOT_NAME },
    { $set: { lastHeartbeat: new Date() } },
    { upsert: true }
  ).catch(() => {});
}

async function monitorOpenStrategies(settings: any) {
  // Busca TODAS as estratégias que podem ter posição na Polymarket: as marcadas
  // como abertas, as com ordens ativas (openOrderIds) e as em market making.
  // O MM grava openOrderIds mas NÃO marca positionOpen — sem incluir essas,
  // uma posição que preencheu na Polymarket nunca é reconciliada no banco
  // (bug: compra real invisível no frontend).
  const strats = await (PredictionArbStrategy as any).find({
    userId: settings.userId,
    $or: [
      { positionOpen: true },
      { openOrderIds: { $exists: true, $ne: [] } },
      { mmActive: true },
    ],
  }).lean();

  for (const strat of strats) {
    try {
      const liveAllowed = await isPredictionLiveAllowed();

      // Reconcilia posição real no CLOB (pega fills que chegaram depois das
      // ordens GTC mantidas). Roda SEMPRE (não só quando shares=0): o banco
      // pode estar defasado (ex: fill parcial antigo) e a Polymarket preencher
      // o resto depois — sem reconciliar sempre, o banco fica cego para o
      // estado real (bug de shares desatualizadas).
      try {
        const key = await resolvePolymarketKey(settings.userId);
        if (key) {
          const keyDoc = await ExchangeKey.findById(key._id).lean().catch(() => key);
          const pos = await reconcilePosition(strat, keyDoc);
          // Atualiza o objeto em memória para o resto do ciclo usar dados frescos
          strat.yesShares = pos.yesShares;
          strat.noShares = pos.noShares;
          strat.positionSize = (pos.yesShares + pos.noShares) / 2;
          log.info(`🔁 [${strat.slug}] Posição reconciliada no CLOB (YES=${pos.yesShares} NO=${pos.noShares}).`);
        }
      } catch (e: any) {
        log.warn(`⚠️ [${strat.slug}] Falha ao reconciliar posição: ${e.message}`);
      }

      // Rebalance de inventário quando desbalanceado
      await rebalanceInventory(strat, { dryRun: !liveAllowed });

      // Condições de saída
      const now = Date.now();
      const endMs = strat.endDate ? new Date(strat.endDate).getTime() : 0;
      const hoursToEnd = endMs > 0 ? (endMs - now) / 3600000 : Infinity;

      // Mercado venceu: faz redeem das posições (recupera o pUSD) e encerra.
      if (hoursToEnd <= 0 && strat.positionOpen) {
        log.info(`⏰ [${strat.slug}] Mercado venceu. Fazendo redeem das posições...`);
        try {
          const key = await resolvePolymarketKey(settings.userId);
          if (key && strat.conditionId) {
            const keyDoc = await ExchangeKey.findById(key._id).lean().catch(() => key);
            await redeemPositionsViaSdk(keyDoc, strat.conditionId);
            log.info(`✅ [${strat.slug}] Redeem executado.`);
          }
        } catch (e: any) {
          log.warn(`⚠️ [${strat.slug}] Redeem falhou: ${e.message}`);
        }
        await (PredictionArbStrategy as any).findByIdAndUpdate(strat._id, {
          positionOpen: false,
          positionSize: 0,
          yesShares: 0,
          noShares: 0,
          avgYesPrice: 0,
          avgNoPrice: 0,
          active: false,
          lastCheckAt: new Date(),
        });
        continue;
      }

      if (hoursToEnd <= 1) {
        log.info(`⏰ [${strat.slug}] Vencimento próximo (${hoursToEnd.toFixed(1)}h). Segurando par até resolução.`);
        continue;
      }

      // Convergência: soma >= 1 → lucro garantido no vencimento
      const sum = Number(strat.yesPrice || 0) + Number(strat.noPrice || 0);
      const realizedPct = strat.positionSize > 0 && Number(strat.avgYesPrice || 0) > 0 && Number(strat.avgNoPrice || 0) > 0
        ? ((1 - (Number(strat.avgYesPrice) + Number(strat.avgNoPrice))) / (Number(strat.avgYesPrice) + Number(strat.avgNoPrice))) * 100
        : 0;

      const target = Number(settings.targetProfitPct || strat.targetProfitPct || 1.0);
      if (sum >= 1 || realizedPct >= target) {
        const reason = sum >= 1
          ? `Par convergiu (yes+no=${sum.toFixed(4)})`
          : `Take-profit atingido (${realizedPct.toFixed(2)}%)`;
        log.info(`🎯 [${strat.slug}] ${reason}. Fechando.`);
        if (settings.isScanningEnabled) {
          closeStrategy(String(strat._id), { dryRun: !liveAllowed, reason }).catch((e: any) => {
            log.error(`❌ Erro no fechamento [${strat.slug}]: ${e.message}`);
          });
        }
      }
    } catch (e: any) {
      log.warn(`⚠️ Erro no monitoramento de ${strat.slug}: ${e.message}`);
    }
  }
}

/**
 * Remove estratégias expiradas (endDate passado) que não têm posição aberta.
 * Mercados updown de 15min ficam sem book após o vencimento — manter a
 * estratégia só polui a base e impede novas criações para períodos seguintes.
 */
async function cleanupExpiredStrategies(userId: any) {
  try {
    const res = await (PredictionArbStrategy as any).deleteMany({
      userId,
      positionOpen: false,
      endDate: { $lt: new Date() },
    });
    if (res.deletedCount > 0) {
      log.info(`🧹 [CLEANUP] Removidas ${res.deletedCount} estratégia(s) expirada(s) sem posição.`);
    }
  } catch (e: any) {
    log.warn(`⚠️ [CLEANUP] Falha ao limpar estratégias expiradas: ${e.message}`);
  }
}

async function runCycle() {
  const settings = await (PredictionArbSettings as any).findOne().lean();
  if (!settings) {
    log.warn('⚠️ Nenhum PredictionArbSettings no banco. Crie as configurações primeiro.');
    return;
  }

  // Descarta estratégias cujo mercado já venceu
  await cleanupExpiredStrategies(settings.userId);

  await heartbeat(settings.userId);

  if (settings.isScanningEnabled !== true) {
    log.info('⏸️ [PREDICTION-ARB] Scan desabilitado (isScanningEnabled=false).');
    return;
  }

  const key = await resolvePolymarketKey(settings.userId);
  if (!key) {
    log.warn('⚠️ Nenhuma ExchangeKey polymarket ativa. Adicione exchangeId=polymarket com a wallet.');
    return;
  }

  const liveAllowed = await isPredictionLiveAllowed();
  log.info(`💡 [PREDICTION-ARB] Modo: ${liveAllowed ? 'LIVE (ordens reais)' : 'DRY-RUN (simulação)'}`);

  // 1. Scan
  const config = {
    minSpreadPct: Number(settings.minSpreadPct ?? 0.5),
    minVolume24hUSD: Number(settings.minVolume24hUSD ?? 10000),
    maxStrategiesPerScan: Number(settings.maxStrategiesPerScan ?? 5),
    tradeSize: Number(settings.tradeSize ?? 100),
    allowedMarkets: settings.allowedMarkets || [],
    marketFilter: settings.marketFilter || '',
    marketCoins: settings.marketCoins || [],
  };
  const scan = await runScan(settings.userId, config, liveAllowed).catch((e: any) => {
    log.error(`❌ Erro no scan: ${e.message}`);
    return { scanned: 0, created: 0, updated: 0 };
  });

  // 2. Auto-execução (fluxo antigo — estratégias SEM mmActive usam ordem única)
  const candidates = await (PredictionArbStrategy as any).find({
    userId: settings.userId,
    active: true,
    autoExecute: true,
    mmActive: { $ne: true },
    positionOpen: false,
    spreadPct: { $gte: config.minSpreadPct },
  }).sort({ spreadPct: -1 }).limit(2).lean();

  for (const strat of candidates) {
    try {
      const live = await isPredictionLiveAllowed();
      await executeStrategy(String(strat._id), { dryRun: !live });
    } catch (e: any) {
      log.error(`❌ Auto-exec falhou [${strat.slug}]: ${e.message}`);
    }
  }

  // 3. Market making com inventário nas estratégias monitoradas
  //    (sem posição real OU com posição marcada mas inventário zero).
  //    - Exclui mercados com < 5min para vencer: nos updown de 15min, nos
  //      minutos finais um lado converge (0.95+) e o book do lado barato
  //      some (bid=0) — sem chance de fill maker nem ordem >= $1.
  //    - A janela boa é entre 5 e 13 min restantes: spread de completude
  //      aberto + book com os dois lados + tempo de fill.
  //    - Rotaciona (updatedAt asc = as menos cotadas primeiro) em vez de
  //      martelar sempre a de maior spread.
  //    - Limitado a 2 por ciclo; a checagem de saldo no runMarketMaking
  //      impede de estourar o capital.
  const MIN_MINUTOS_PARA_VENCER = 5;
  const limiteVencimento = new Date(Date.now() + MIN_MINUTOS_PARA_VENCER * 60 * 1000);
  const mmTargets = await (PredictionArbStrategy as any).find({
    userId: settings.userId,
    active: true,
    mmActive: true,
    endDate: { $gte: limiteVencimento },
    $or: [
      { positionOpen: false },
      { positionOpen: true, yesShares: 0, noShares: 0 },
    ],
  }).sort({ updatedAt: 1 }).limit(2).lean();
  for (const strat of mmTargets) {
    try {
      await runMarketMaking(strat, { dryRun: !liveAllowed });
    } catch (e: any) {
      log.warn(`⚠️ [MM] Falha em ${strat.slug}: ${e.message}`);
    }
  }

  // 4. Monitoramento das abertas
  await monitorOpenStrategies(settings);

  // 5. Sincroniza o histórico de operações com a Polymarket (a cada ~2min).
  //    Cria/atualiza os close_pair com PnL quando a operação fecha (redeem/
  //    venda) — sem isso o Histórico de Trades do frontend fica sem as
  //    operações encerradas e sem o lucro/prejuízo.
  syncCycleCount++;
  if (syncCycleCount >= 4) {
    syncCycleCount = 0;
    try {
      const r = await syncPredictionHistory(settings.userId);
      log.info(`🔁 [SYNC] Histórico sincronizado (${r.criados} criados, ${r.atualizados} atualizados).`);
    } catch (e: any) {
      log.warn(`⚠️ [SYNC] Falha ao sincronizar histórico: ${e.message}`);
    }
  }

  // Atualiza lastScannedAt
  await (PredictionArbSettings as any).findByIdAndUpdate(settings._id, { lastScannedAt: new Date() });

  log.info(`🔁 [PREDICTION-ARB] Ciclo concluído (scanned=${scan.scanned}, created=${scan.created}).`);
}

async function main() {
  await connectToDatabase();
  log.info('🚀 [PREDICTION-ARB] Iniciado. Monitorando PredictionArbSettings.');

  if (isTelegramEnabled()) {
    sendTelegramAlert('🟢 *Prediction Arb Bot* | Inicializado com sucesso.').catch(() => {});
  }

  // Redis control channel
  const redis = getRedisClient();
  if (redis) {
    redis.subscribe('prediction-arb-control', (err) => {
      if (!err) log.info('📡 [REDIS] Inscrito no canal prediction-arb-control');
    });
    redis.on('message', async (channel, message) => {
      if (channel !== 'prediction-arb-control') return;
      try {
        const data = JSON.parse(message);
        if (data.action === 'CLOSE_STRATEGY' && data.strategyId) {
          log.info(`⚡ [REDIS] Fechamento solicitado para ${data.strategyId}`);
          closeStrategy(String(data.strategyId), { dryRun: !(await isPredictionLiveAllowed()), reason: 'Comando Manual' })
            .catch((e: any) => log.error(`❌ Close via Redis falhou: ${e.message}`));
        }
      } catch (e: any) {
        log.error('❌ Erro ao processar mensagem Redis:', e.message);
      }
    });
  }

  // Intervalo do ciclo
  const settings = await (PredictionArbSettings as any).findOne().lean();
  const interval = Number(settings?.scanIntervalMs || DEFAULT_INTERVAL_MS);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runCycle();
    } catch (e: any) {
      log.error('❌ [PREDICTION-ARB] Erro no ciclo:', e.message);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

if (require.main === module || !module.parent) {
  main().catch((e: any) => {
    log.error('Fatal:', e.message);
    process.exit(1);
  });
}

export default main;
