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
import { resolveClobCredentials, getOnchainBalance } from './helpers/clob-client';
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

// Estado anterior do modo live — usado para detectar a transição DRY-RUN → LIVE
// e encerrar posições existentes antes de começar a operar.
let liveAnterior = false;

// Máximo de pares (posições reais) simultâneos. Acima disso o robô para de
// ABRIR posição nova — continua apenas completando hedges parciais e
// monitorando as abertas (evita estourar o capital da deposit wallet e
// repetir o caso da DOGE que abriu uma perna e não conseguiu completar).
const MAX_PARES_ABERTOS = 3;

/** Conta os pares (posições reais) atualmente abertos na Polymarket. */
async function contarParesAbertos(userId: any): Promise<number> {
  try {
    const abertas = await (PredictionArbStrategy as any).find({
      userId,
      positionOpen: true,
      $or: [
        { yesShares: { $gte: 1 } },
        { noShares: { $gte: 1 } },
      ],
    }).lean();
    // Uma posição com as DUAS pernas no mesmo mercado conta como 1 par.
    return abertas.length;
  } catch (e: any) {
    log.warn(`⚠️ Falha ao contar pares abertos: ${e.message}`);
    return 0;
  }
}

/**
 * Capital já comprometido (posições reais + ordens ativas) vs saldo on-chain.
 * Retorna o saldo livre estimado. Usado para não abrir posição nova quando o
 * capital não cobre o par inteiro (causa do caso DOGE YES=10 NO=0).
 */
async function saldoLivreEstimado(userId: any, key: any): Promise<{ livre: number; saldo: number; comprometido: number }> {
  const saldo = await getOnchainBalance(String(key?.depositWallet || '')).catch(() => 0);
  // Soma o custo médio das posições reais (fonte: banco, reconciliado pelo monitor)
  const abertas = await (PredictionArbStrategy as any).find({
    userId,
    $or: [
      { yesShares: { $gte: 1 } },
      { noShares: { $gte: 1 } },
    ],
  }).lean();
  let comprometido = 0;
  for (const s of abertas) {
    const yes = Number(s.yesShares || 0);
    const no = Number(s.noShares || 0);
    const yesCusto = yes * (Number(s.avgYesPrice || s.yesPrice || 0) || 0);
    const noCusto = no * (Number(s.avgNoPrice || s.noPrice || 0) || 0);
    comprometido += yesCusto + noCusto;
  }
  return { livre: saldo - comprometido, saldo, comprometido };
}

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
      // Só encerra a estratégia se o redeem FUNCIONOU — se falhou (timing,
      // mercado ainda não pronto), mantém positionOpen para o próximo ciclo
      // tentar de novo. Antes zerava a estratégia mesmo com redeem falho,
      // deixando o capital preso para sempre (resgate manual no portal).
      if (hoursToEnd <= 0 && strat.positionOpen) {
        let redeemOk = false;
        try {
          const key = await resolvePolymarketKey(settings.userId);
          if (key && strat.conditionId) {
            const keyDoc = await ExchangeKey.findById(key._id).lean().catch(() => key);
            await redeemPositionsViaSdk(keyDoc, strat.conditionId);
            log.info(`✅ [${strat.slug}] Redeem executado.`);
            redeemOk = true;
          }
        } catch (e: any) {
          log.warn(`⚠️ [${strat.slug}] Redeem falhou (vai tentar de novo no próximo ciclo): ${e.message}`);
        }
        if (redeemOk) {
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
        } else {
          await (PredictionArbStrategy as any).findByIdAndUpdate(strat._id, {
            lastCheckAt: new Date(),
          });
        }
        continue;
      }

      // Vencimento próximo: só "segura" se houver par REAL e BALANCEADO
      // (os dois lados com shares). Perna única (um lado = 0) NÃO é par:
      // segurar até a resolução é risco direcional total (perde tudo se o
      // lado errado vencer). Nesses casos o fluxo cai para o MM completar o
      // hedge (Grupo B) ou, se inviável, vender o lado único antes do fim.
      const yesSh = Number(strat.yesShares || 0);
      const noSh = Number(strat.noShares || 0);
      const parCompleto = yesSh >= 1 && noSh >= 1;
      if (hoursToEnd <= 1 && parCompleto) {
        log.info(`⏰ [${strat.slug}] Vencimento próximo (${hoursToEnd.toFixed(1)}h). Segurando par até resolução.`);
        continue;
      }
      // Perna única perto do vencimento: tenta completar o hedge via MM
      // (o Grupo B do ciclo roda antes do monitor). Se o MM decidir não
      // completar (custo > 1.1, saldo), ele mesmo cancela ordens e sinaliza.
      if (hoursToEnd <= 1 && (yesSh >= 1 || noSh >= 1)) {
        log.warn(`⚠️ [${strat.slug}] Perna única perto do vencimento (YES=${yesSh} NO=${noSh}). Tentando completar hedge antes da resolução...`);
        try {
          const live = await isPredictionLiveAllowed();
          await runMarketMaking(strat, { dryRun: !live });
        } catch (e: any) {
          log.warn(`⚠️ [${strat.slug}] Falha ao tentar completar hedge: ${e.message}`);
        }
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

  // Transição DRY-RUN → LIVE (colheita ligada): DELETA as estratégias que estão
  // em monitoramento (sem posição real) — começando limpo, sem estratégias
  // antigas de sessões anteriores. As que têm posição real são mantidas
  // (o monitor cuida delas até o vencimento).
  if (liveAllowed && !liveAnterior) {
    log.info('🚦 [PREDICTION-ARB] Colheita ligada. Limpando estratégias em monitoramento...');
    try {
      const limpar = await (PredictionArbStrategy as any).find({
        userId: settings.userId,
        $or: [
          { positionOpen: false },
          { positionOpen: true, yesShares: 0, noShares: 0 },
        ],
      }).lean();
      if (limpar.length === 0) {
        log.info('✅ Nenhuma estratégia em monitoramento para limpar.');
      }
      for (const strat of limpar) {
        await (PredictionArbStrategy as any).deleteOne({ _id: strat._id });
        log.info(`🗑️ [${strat.slug}] Estratégia em monitoramento deletada ao ligar colheita.`);
      }
    } catch (e: any) {
      log.warn(`⚠️ Falha ao limpar estratégias na transição live: ${e.message}`);
    }
  }
  liveAnterior = liveAllowed;

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
  //    Respeita o limite de pares abertos: não abre posição nova se já houver
  //    MAX_PARES_ABERTOS posições reais consumindo capital.
  const paresAbertos = await contarParesAbertos(settings.userId);
  const podeAbrirNovo = paresAbertos < MAX_PARES_ABERTOS;
  if (!podeAbrirNovo) {
    log.info(`🔒 [PREDICTION-ARB] Limite de ${MAX_PARES_ABERTOS} pares abertos atingido (${paresAbertos}). Não abrindo posições novas.`);
  }

  const candidates = podeAbrirNovo
    ? await (PredictionArbStrategy as any).find({
        userId: settings.userId,
        active: true,
        autoExecute: true,
        mmActive: { $ne: true },
        positionOpen: false,
        spreadPct: { $gte: config.minSpreadPct },
      }).sort({ spreadPct: -1 }).limit(2).lean()
    : [];

  for (const strat of candidates) {
    try {
      const live = await isPredictionLiveAllowed();
      await executeStrategy(String(strat._id), { dryRun: !live });
    } catch (e: any) {
      log.error(`❌ Auto-exec falhou [${strat.slug}]: ${e.message}`);
    }
  }

  // 3. Market making com inventário nas estratégias monitoradas.
  //    REGRA DOS 5 MIN: vale só para ABRIR posição NOVA (mercado sem posição).
  //    Estratégia com hedge PARCIAL (um lado preenchido, outro não) PODE
  //    completar a perna faltante até o fim — deixar sem hedge no vencimento
  //    é risco direcional (perde tudo se o lado errado vencer).
  //    - Sem posição: só entra entre 5 e 20 min restantes (janela boa).
  //    - Com posição parcial (desbalanceada): pode completar o hedge mesmo
  //      faltando < 5 min.
  //    - Exclui mercados com > 20min (períodos futuros, sem referência).
  const MIN_MINUTOS_PARA_VENCER = 5;
  const MAX_MINUTOS_PARA_VENCER = 20;
  const limiteVencimento = new Date(Date.now() + MIN_MINUTOS_PARA_VENCER * 60 * 1000);
  const limiteFuturo = new Date(Date.now() + MAX_MINUTOS_PARA_VENCER * 60 * 1000);

  // Grupo A: mercados sem posição real (abrir posição nova) — respeita 5-20min.
  //    Só roda se houver vaga no limite de pares abertos E saldo livre para o
  //    par inteiro (o caso DOGE YES=10 NO=0 aconteceu por falta de orçamento
  //    global: o MM checava saldo por estratégia e abria várias em paralelo).
  let mmTargets: any[] = [];
  if (podeAbrirNovo) {
    const orcamento = await saldoLivreEstimado(settings.userId, key);
    // Custo estimado do par novo: tradeSize aplicado nos dois lados (pior caso)
    const tradeSizeConf = Number(settings.tradeSize ?? 100);
    const custoParNovo = tradeSizeConf * 2;
    if (orcamento.livre < custoParNovo) {
      log.warn(`🔒 [PREDICTION-ARB] Saldo livre insuficiente para abrir par novo (livre $${orcamento.livre.toFixed(2)} < custo $${custoParNovo.toFixed(2)} de ${tradeSizeConf}/lado; saldo total $${orcamento.saldo.toFixed(2)}, comprometido $${orcamento.comprometido.toFixed(2)}).`);
    } else {
      mmTargets = await (PredictionArbStrategy as any).find({
        userId: settings.userId,
        active: true,
        mmActive: true,
        endDate: { $gte: limiteVencimento, $lte: limiteFuturo },
        $or: [
          { positionOpen: false },
          { positionOpen: true, yesShares: 0, noShares: 0 },
        ],
      }).sort({ updatedAt: 1 }).limit(2).lean();
    }
  }

  // Grupo B: mercados com hedge PARCIAL (um lado preenchido) — pode completar
  // a perna faltante até o fim (exceção à regra dos 5 min).
  const hedgeParcial = await (PredictionArbStrategy as any).find({
    userId: settings.userId,
    active: true,
    mmActive: true,
    endDate: { $lte: limiteFuturo },
    $or: [
      { positionOpen: true, yesShares: { $gte: 1 }, noShares: 0 },
      { positionOpen: true, yesShares: 0, noShares: { $gte: 1 } },
      { positionOpen: true, yesShares: { $gte: 1 }, noShares: { $gte: 1 } },
    ],
  }).sort({ updatedAt: 1 }).limit(2).lean();

  const targets = [...hedgeParcial, ...mmTargets].filter(
    (s, i, arr) => arr.findIndex((x) => String(x._id) === String(s._id)) === i,
  ).slice(0, 3);

  // Prioriza hedge parcial: se há perna única esperando completar, ele roda
  // primeiro (e sempre, mesmo no limite de pares — completar não abre par novo).
  const hedgeIds = new Set(hedgeParcial.map((s: any) => String(s._id)));
  const alvosPriorizados = [...targets].sort((a: any, b: any) =>
    Number(hedgeIds.has(String(b._id))) - Number(hedgeIds.has(String(a._id)))
  );

  for (const strat of alvosPriorizados) {
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
