// @ts-nocheck
import ccxt from 'ccxt';
import mongoose from 'mongoose';
import { decryptSecretKey } from '../../utils/encryption';
import { connectToDatabase } from '../../config/db';
import Redis from 'ioredis';
import PerpArbStrategy from '../../models/PerpArbStrategy';
import PerpArbTrade from '../../models/PerpArbTrade';
import ExchangeKey from '../../models/ExchangeKey';
import { sendTelegramAlert } from '../../utils/telegram';
import { takePortfolioSnapshot } from './funding-arb';

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${msg}`, ...args),
};

const isTelegramEnabled = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

const alerts = {
  async tradeClosed(strategyName: string, symbol: string, pnl: number, funding: number, opts: any = {}) {
    const mode = opts.dryRun ? '🧪 (SIMULADO / DRY-RUN)' : '🚀 (LIVE)';
    const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
    await sendTelegramAlert(
      `${pnlEmoji} *POSIÇÃO FECHADA* ${mode}\n` +
      `📌 *Estratégia:* ${strategyName}\n` +
      `🔀 *Par:* ${symbol}${opts.spotSymbol ? ` / ${opts.spotSymbol}` : ''}\n` +
      `💰 *PnL Realizado:* $${pnl.toFixed(2)} USDT\n` +
      `📊 *Funding Coletado:* $${funding.toFixed(2)} USDT\n` +
      `💵 *Tamanho:* $${(opts.size || 0).toFixed(2)} USDT\n` +
      `📝 *Motivo:* ${opts.reason || 'N/A'}`
    );
  },
  async tradeFailed(strategyName: string, error: string) {
    await sendTelegramAlert(`🔴 *Trade Falhou* - ${strategyName}\nErro: ${error}`);
  },
  async dailyLossLimit(strategyName: string, accumulated: number, limit: number) {
    await sendTelegramAlert(
      `⛔ *Limite de Perda Diária Atingido* - ${strategyName}\n` +
      `Perda acumulada: $${accumulated.toFixed(2)}\n` +
      `Limite: $${limit.toFixed(2)}\n` +
      `Estratégia desativada automaticamente.`
    );
  }
};

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T = null as any): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

/**
 * Resolve o preço médio real de execução (avgPrice) de uma ordem.
 * Usa o retorno do createOrder e, se o average não vier preenchido
 * (comum na MEXC), consulta a ordem na corretora via fetchOrder.
 */
async function resolveOrderFill(exchange: any, order: any, symbol: string): Promise<{ filled: number; price: number }> {
  const fallback = {
    filled: Number(order?.filled || order?.amount || 0),
    price: Number(order?.average || 0),
  };
  const orderId = String(order?.id || '');
  const isSentinel = !orderId || order?.skipped || orderId === 'ALREADY_CLOSED' || orderId === 'CONSOLIDATED' || orderId === 'RECONCILED';
  if (isSentinel || !exchange?.fetchOrder) return fallback;

  try {
    const fetched: any = await withTimeout(exchange.fetchOrder(orderId, symbol), 8000, null);
    if (!fetched) return fallback;

    // Preço médio: prioriza average do ccxt; depois campos nativos da corretora
    const info = fetched?.info || {};
    const infoAvg = Number(
      info?.avgPrice ?? info?.avg_price ?? info?.dealAvgPrice ?? info?.dealAvgPriceStr ?? info?.price ?? 0
    );
    const avg = Number(fetched?.average || 0) || infoAvg;

    // Spot: deriva o preço médio de fill de quote/amount quando average não vem
    let filled = Number(fetched?.filled || fetched?.amount || 0);
    let price = avg;
    if (!(price > 0) && filled > 0) {
      const quote = Number(fetched?.cost || fetched?.info?.cummulativeQuoteQty || fetched?.info?.cumulativeQuoteQty || 0);
      if (quote > 0) price = quote / filled;
    }

    return {
      filled: filled > 0 ? filled : fallback.filled,
      price: price > 0 ? price : fallback.price,
    };
  } catch (e: any) {
    log.warn(`⚠️ Não foi possível consultar a ordem ${orderId} (${symbol}) para o preço real de fill: ${e?.message}`);
    return fallback;
  }
}

// ─── Redis (optional locking) ─────────────────────────────────────────────────

let _redis: Redis | null = null;
let _redisInit = false;

function getRedisClient(): Redis | null {
  if (_redisInit) return _redis;
  _redisInit = true;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const c = new Redis(url);
    c.on('error', () => { });
    _redis = c;
  } catch { _redis = null; }
  return _redis;
}

async function lockStrategy(id: string): Promise<boolean> {
  const r = getRedisClient();
  if (!r) return true;
  try {
    return Boolean(await (r as any).set(`hft:perp_arb_lock:${id}`, '1', 'NX', 'EX', 60));
  } catch { return true; }
}

async function unlockStrategy(id: string) {
  const r = getRedisClient();
  if (!r) return;
  try { await r.del(`hft:perp_arb_lock:${id}`); } catch { }
}

// ─── Exchange factory ──────────────────────────────────────────────────────────

async function getExchange(doc: any, isPerp: boolean = false) {
  const { exchangeId, apiKey, apiSecret, userId } = doc;
  const id = exchangeId === 'gateio' ? 'gate' : exchangeId;
  const cls: any = (ccxt as any)[id] ?? (ccxt as any).pro?.[id] ?? (ccxt as any)[exchangeId];
  if (!cls) throw new Error(`Exchange "${exchangeId}" não suportada pelo ccxt`);

  let secret = apiSecret;
  try {
    const aad = userId ? `${userId}-${exchangeId}` : '';
    secret = decryptSecretKey(String(apiSecret || ''), aad);
  } catch { /* usa raw */ }

  const config: any = {
    apiKey,
    secret,
    enableRateLimit: true,
    timeout: 8000,
    options: {
      defaultType: isPerp ? (id === 'mexc' || id === 'gate' || id === 'bybit' ? 'swap' : 'future') : 'spot',
      fetchCurrencies: false,
    },
  };

  const instance = new cls(config);
  instance.has = { ...(instance.has || {}), fetchCurrencies: false };
  return instance;
}

// ─── Consulta posição real do Perp na exchange ────────────────────────────────

async function fetchPerpPosition(perpExchange: any, perpSymbol: string): Promise<{ contracts: number; notional: number; side: string | null }> {
  const fallback = { contracts: 0, notional: 0, side: null };
  try {
    if (!perpExchange.has?.['fetchPositions']) {
      return { contracts: NaN, notional: NaN, side: null };
    }
    const positions = await perpExchange.fetchPositions([perpSymbol]);
    const pos = (positions || []).find((p: any) => {
      const symbolMatch = String(p.symbol || '').toLowerCase() === String(perpSymbol).toLowerCase();
      const signed = Number(p.contractsSigned ?? 0);
      const contracts = Number(p.contracts ?? 0);
      return symbolMatch && (signed !== 0 || contracts > 0);
    });
    if (!pos) return fallback;
    const contracts = Math.abs(Number(pos.contracts ?? 0));
    const signed = Number(pos.contractsSigned ?? 0);
    return {
      contracts: signed !== 0 ? Math.abs(signed) : contracts,
      notional: Math.abs(Number(pos.notional ?? 0)),
      side: pos.side ?? (signed > 0 ? 'long' : signed < 0 ? 'short' : null),
    };
  } catch (e: any) {
    const msg = String(e?.message || '');
    if (msg.includes('2009') || msg.includes('nonexistent') || msg.includes('not exist')) {
      return fallback;
    }
    return { contracts: NaN, notional: NaN, side: null };
  }
}

// ─── Resolve os dois lados da estratégia ──────────────────────────────────────

async function resolveExchangeKeys(strat: any) {
  const perpKeyId  = strat.perpExchangeKeyId ?? strat.exchangeKeyId ?? null;
  const spotKeyId  = strat.spotExchangeKeyId ?? strat.exchangeKeyId ?? null;

  if (!perpKeyId) throw new Error('Sem perpExchangeKeyId na estratégia');

  const perpKey = await (ExchangeKey as any).findById(perpKeyId).lean();
  if (!perpKey) throw new Error(`ExchangeKey perpétuo não encontrado (id=${perpKeyId})`);

  const spotKey = (spotKeyId && String(spotKeyId) !== String(perpKeyId))
    ? (await (ExchangeKey as any).findById(spotKeyId).lean() ?? perpKey)
    : perpKey;

  return { perpKey, spotKey, sameExchange: String(perpKey._id) === String(spotKey._id) };
}

// ─── Protection: registra perda e aplica cooldown ─────────────────────────────

async function recordLoss(strat: any, lossUSDT: number) {
  const maxLoss = Number(strat.maxDailyLoss ?? 0);
  const newAccum = Number(strat.dailyLossAccum ?? 0) + lossUSDT;
  const hitLimit = maxLoss > 0 && newAccum >= maxLoss;

  await (PerpArbStrategy as any).findByIdAndUpdate(strat._id, {
    dailyLossAccum: newAccum,
    lastLossAt: new Date(),
    ...(hitLimit ? { autoExecute: false, active: false } : {}),
  });

  if (hitLimit) {
    log.error(`⛔ [${strat.name}] Limite diário atingido (${newAccum.toFixed(2)} USDT). Estratégia desativada.`);
    if (isTelegramEnabled()) {
      await alerts.dailyLossLimit(strat.name, newAccum, maxLoss);
    }
  }
}

// ─── closeStrategy ──────────────────────────────────────────────────────────

const CLOSE_DEDUP_WINDOW_MS = 60_000;

async function hasRecentCloseInFlight(strategyId: string, perpSymbol: string): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - CLOSE_DEDUP_WINDOW_MS);
    const existing = await (PerpArbTrade as any).findOne({
      $or: [
        ...(mongoose.Types.ObjectId.isValid(strategyId) ? [{ strategyId }] : []),
        { perpSymbol },
      ],
      type: 'close_hedge',
      status: { $in: ['detected', 'executed'] },
      createdAt: { $gte: cutoff },
    }).sort({ createdAt: -1 }).lean();
    return Boolean(existing);
  } catch {
    return false;
  }
}

export async function closeStrategy(strategyId: string, opts: { dryRun?: boolean; reason?: string } = {}) {
  const dryRun       = opts.dryRun !== undefined ? opts.dryRun : (process.env.PERP_ALLOW_LIVE !== 'true');
  const testMaxUsd   = Number(process.env.TEST_MAX_USD ?? process.env.PERP_TEST_MAX_USD ?? 0);

  if (!await lockStrategy(strategyId)) throw new Error('Estratégia bloqueada (outra execução em curso)');

  try {
    // ── Carrega estratégia por ID, por Símbolo ou por Trade Órfão ────
    let strat: any = null;
    if (mongoose.Types.ObjectId.isValid(strategyId)) {
      strat = await (PerpArbStrategy as any).findById(strategyId).lean();
    }
    if (!strat) {
      strat = await (PerpArbStrategy as any).findOne({ perpSymbol: { $regex: new RegExp(`^${strategyId}`, 'i') } }).lean();
    }

    // Fallback para quando o cartão da estratégia foi excluído, mas o trade de abertura existe
    if (!strat) {
      const openTrade: any = await (PerpArbTrade as any).findOne({
        $or: [
          ...(mongoose.Types.ObjectId.isValid(strategyId) ? [{ _id: strategyId }, { strategyId }] : []),
          { perpSymbol: { $regex: new RegExp(`^${strategyId}`, 'i') } }
        ],
        type: 'open_hedge',
        status: { $in: ['executed', 'simulated'] }
      }).sort({ createdAt: -1 }).lean();

      if (openTrade) {
        const firstKey = await (ExchangeKey as any).findOne({ userId: openTrade.userId, active: true }).lean()
          ?? await (ExchangeKey as any).findOne({ active: true }).lean();

        strat = {
          _id: openTrade.strategyId || openTrade._id,
          userId: openTrade.userId,
          name: openTrade.strategyName || `[SISTEMA] ${openTrade.perpSymbol}`,
          perpSymbol: openTrade.perpSymbol,
          spotSymbol: openTrade.spotSymbol,
          tradeSize: openTrade.amount,
          positionSize: openTrade.amount,
          positionOpen: true,
          perpExchangeKeyId: firstKey?._id,
          spotExchangeKeyId: firstKey?._id,
          isOrphaned: true
        };
      }
    }

    if (!strat) throw new Error(`Nenhuma estratégia ou posição ativa encontrada para "${strategyId}"`);

    // ── Trava anti-duplicação de fechamento ──────────────────────────────────
    const stratIdStr = String(strat._id || strategyId);
    const stratSymbol = String(strat.perpSymbol || '');
    if (await hasRecentCloseInFlight(stratIdStr, stratSymbol)) {
      const msg = `⛔ [${strat.name}] Já existe um fechamento em andamento para ${stratSymbol} (criado nos últimos ${CLOSE_DEDUP_WINDOW_MS / 1000}s). Abortando disparo duplicado.`;
      log.warn(msg);
      throw new Error(msg);
    }

    // ── Resolve as duas exchanges ─────────────────────────────────────────────
    const { perpKey, spotKey } = await resolveExchangeKeys(strat);
    const perpExchange = await getExchange(perpKey, true);
    const spotExchange = await getExchange(spotKey, false);

    log.info(`🚀 Executando [${strat.name}] | Perp: ${perpKey.name} | Spot: ${spotKey.name} | ${dryRun ? 'DRY-RUN' : 'LIVE'}`);

    // ── Fetch preços ──────────────────────────────────────────────────────────
    let perpTicker: any = null;
    let spotTicker: any = null;
    try { perpTicker = await withTimeout(perpExchange.fetchTicker(strat.perpSymbol), 8000, null); } catch { }
    try { spotTicker = await withTimeout(spotExchange.fetchTicker(strat.spotSymbol), 8000, null); } catch { }

    const perpPrice = perpTicker?.last ?? null;
    const spotPrice = spotTicker?.last ?? null;

    // ── Cap de valor para testes ──────────────────────────────────────────────
    const tradeSize = (testMaxUsd > 0 && Number(strat.positionSize || strat.tradeSize) > testMaxUsd)
      ? testMaxUsd
      : Number(strat.positionSize || strat.tradeSize);

    if (testMaxUsd > 0 && tradeSize < Number(strat.tradeSize)) {
      log.info(`⚠️  Cap de teste: ${strat.tradeSize} → ${tradeSize} USDT`);
    }

    // Busca o trade de abertura correspondente para calcular o PnL Realizado e recuperar os preços de entrada
    const openTrade: any = await (PerpArbTrade as any).findOne({
      strategyId: strat._id,
      type: 'open_hedge',
      status: { $in: ['executed', 'simulated'] }
    }).sort({ createdAt: -1 });

    let realizedPnL = 0;
    let spotPnL = 0;
    let perpPnL = 0;
    const fundingCollected = Number(strat.fundingCollected || 0);

    const entrySpotPrice = Number(openTrade?.spotPrice || spotPrice || 0);
    const entryPerpPrice = Number(openTrade?.perpPrice || perpPrice || 0);
    const exitSpotPrice = Number(spotPrice || entrySpotPrice);
    const exitPerpPrice = Number(perpPrice || entryPerpPrice);

    if (openTrade && exitSpotPrice > 0 && exitPerpPrice > 0) {
      if (entrySpotPrice > 0) {
        spotPnL = ((exitSpotPrice - entrySpotPrice) / entrySpotPrice) * tradeSize;
      }
      if (entryPerpPrice > 0) {
        perpPnL = ((entryPerpPrice - exitPerpPrice) / entryPerpPrice) * tradeSize;
      }
      realizedPnL = spotPnL + perpPnL + fundingCollected;
    } else {
      realizedPnL = fundingCollected;
    }

    const closeReason = opts.reason || 'Comando Manual (Dashboard / Telegram)';
    const trade: any = await PerpArbTrade.create({
      userId: strat.userId,
      strategyId: strat._id,
      openTradeId: openTrade?._id || undefined,
      strategyName: strat.name,
      perpSymbol: strat.perpSymbol,
      spotSymbol: strat.spotSymbol,
      type: 'close_hedge',
      status: dryRun ? 'simulated' : 'detected',
      amount: tradeSize,
      baseAmount: openTrade?.baseAmount || openTrade?.spotQuantity || (exitSpotPrice > 0 ? tradeSize / exitSpotPrice : undefined),
      spotPrice: entrySpotPrice,
      spotExitPrice: exitSpotPrice,
      perpPrice: entryPerpPrice,
      perpExitPrice: exitPerpPrice,
      spotQuantity: openTrade?.spotQuantity || (exitSpotPrice > 0 ? tradeSize / exitSpotPrice : undefined),
      perpQuantity: openTrade?.perpQuantity || (exitPerpPrice > 0 ? tradeSize / exitPerpPrice : undefined),
      spotPnl: Number(spotPnL.toFixed(4)),
      perpPnl: Number(perpPnL.toFixed(4)),
      fundingCollected: Number(fundingCollected.toFixed(4)),
      pnl: Number(realizedPnL.toFixed(4)),
      reason: closeReason,
      openedAt: openTrade?.createdAt || strat.positionOpenedAt || undefined,
      fundingHistory: strat.fundingHistory || [],
    });

    // ── Dry-run: apenas simula ────────────────────────────────────────────────
    if (dryRun) {
      log.info(`[dry-run] SHORT spot ${strat.spotSymbol} + LONG perp ${strat.perpSymbol} (FECHAMENTO) — ${tradeSize} USDT`);
      trade.status = 'simulated';
      await trade.save();
      
      if (strat.isAutoCreated) {
        await (PerpArbStrategy as any).findByIdAndDelete(strat._id);
        log.info(`🗑️ [CLEANUP] Estratégia [${strat.name}] criada automaticamente foi excluída após o fechamento.`);
      } else {
        await (PerpArbStrategy as any).findByIdAndUpdate(strat._id, {
          active: false,
          positionOpen: false,
          positionOpenedAt: null,
          fundingCollected: 0,
          fundingCount: 0,
          fundingHistory: []
        });
      }

      if (strat.userId) {
        takePortfolioSnapshot(String(strat.userId), true).catch(() => {});
      }

      if (isTelegramEnabled()) {
        await alerts.tradeClosed(strat.name, strat.perpSymbol, realizedPnL, Number(strat.fundingCollected || 0), {
          dryRun: true,
          spotSymbol: strat.spotSymbol,
          reason: opts.reason || 'Simulação de fechamento',
          size: tradeSize,
        });
      }

      return trade;
    }

    // ── LIVE: coloca ordens nas duas exchanges ────────────────────────────────
    try {
      if (!spotExchange.markets || Object.keys(spotExchange.markets).length === 0) {
        try { await spotExchange.loadMarkets(); } catch {}
      }
      if (!perpExchange.markets || Object.keys(perpExchange.markets).length === 0) {
        try { await perpExchange.loadMarkets(); } catch {}
      }

      const spotMarket = spotExchange.markets?.[strat.spotSymbol];
      const perpMarket = perpExchange.markets?.[strat.perpSymbol];

      const contractSize = perpMarket?.contractSize || 1;

      let spotAmountNum = tradeSize / Number(spotPrice || 1);
      let perpAmountNum = (tradeSize / Number(perpPrice || 1)) / contractSize;

      // Saldo real de Spot disponível (limite infalível contra Oversold 30005)
      let spotFreeBase = 0;
      try {
        const baseSymbol = strat.spotSymbol.split('/')[0];
        const balance = await spotExchange.fetchBalance();
        spotFreeBase = Number(balance?.[baseSymbol]?.free ?? balance?.free?.[baseSymbol] ?? 0);
        if (spotFreeBase > 0) {
          log.info(`📦 Saldo disponível no Spot para ${baseSymbol}: ${spotFreeBase} (estimado: ${spotAmountNum})`);
          if (spotFreeBase < spotAmountNum) {
            spotAmountNum = spotFreeBase;
            perpAmountNum = spotFreeBase / contractSize;
          } else if (spotFreeBase > spotAmountNum * 1.01) {
            const residual = spotFreeBase - spotAmountNum;
            log.info(`🧹 [${strat.name}] Sobra de ${residual.toFixed(4)} ${baseSymbol} no Spot (de ciclos anteriores). Vendendo saldo completo (${spotFreeBase.toFixed(4)}) para zerar exposição.`);
            spotAmountNum = spotFreeBase;
          }
        }
      } catch (balErr: any) {
        log.warn('⚠️ Não foi possível consultar saldo Spot pré-fechamento:', balErr.message);
      }

      // ── Verifica a posição real do Perp na exchange antes de fechar ──────
      let perpAlreadyClosed = false;
      const sellingFullSpotBalance = spotFreeBase > 0 && spotAmountNum >= spotFreeBase * 0.999;
      try {
        const perpPos = await fetchPerpPosition(perpExchange, strat.perpSymbol);
        if (Number.isFinite(perpPos.contracts) && perpPos.contracts === 0) {
          perpAlreadyClosed = true;
          log.info(`ℹ️ [${strat.name}] Posição PERP já não existe na corretora (contracts=0). Fechando apenas o Spot, sem ordem Perp.`);
        } else if (Number.isFinite(perpPos.contracts) && perpPos.contracts > 0) {
          perpAmountNum = perpPos.contracts;
          if (!sellingFullSpotBalance) {
            const realNotional = perpPos.notional > 0 ? perpPos.notional : perpPos.contracts * contractSize * Number(perpPrice || 1);
            if (realNotional > 0) {
              const realSpot = realNotional / Number(spotPrice || 1);
              if (realSpot > 0 && realSpot < spotAmountNum * 1.05) {
                spotAmountNum = realSpot;
              }
            }
          } else {
            log.info(`ℹ️ [${strat.name}] Spot será zerado (${spotAmountNum.toFixed(4)}) e Perp fechará ${perpPos.contracts} contratos (${perpPos.side || '?'}).`);
          }
          log.info(`ℹ️ [${strat.name}] Posição PERP confirmada: ${perpPos.contracts} contratos (${perpPos.side || '?'}). Ajustando fechamento para a quantidade real.`);
        }
      } catch (posErr: any) {
        log.warn(`⚠️ [${strat.name}] Não foi possível confirmar posição Perp pré-fechamento:`, posErr.message);
      }

      // ── Trava FINAL anti-Oversold ──
      if (spotFreeBase > 0 && spotAmountNum > spotFreeBase) {
        const diff = spotAmountNum - spotFreeBase;
        log.info(`🛡️ [${strat.name}] Spot desejado (${spotAmountNum.toFixed(4)}) excede saldo disponível (${spotFreeBase.toFixed(4)}). Limitando fechamento ao saldo real (-${diff.toFixed(4)}).`);
        spotAmountNum = spotFreeBase;
        perpAmountNum = spotFreeBase / contractSize;
        if (perpAlreadyClosed) {
          log.info(`ℹ️ [${strat.name}] Perp já fechado (sem posição) — Spot limitado ao saldo sem ajuste adicional de Perp.`);
        }
      }

      // ── Calcula quantidades formatadas DEPOIS de todos os ajustes ────────
      const spotAmount = spotExchange.amountToPrecision ? spotExchange.amountToPrecision(strat.spotSymbol, spotAmountNum) : spotAmountNum;
      const perpAmount = perpExchange.amountToPrecision ? perpExchange.amountToPrecision(strat.perpSymbol, perpAmountNum) : perpAmountNum;

      const spotAmountFormatted = spotExchange.amountToPrecision ? spotExchange.amountToPrecision(strat.spotSymbol, spotAmount) : spotAmount;
      const perpAmountFormatted = perpExchange.amountToPrecision ? perpExchange.amountToPrecision(strat.perpSymbol, perpAmount) : perpAmount;

      log.info(`🚀 Enviando ordens simultâneas de FECHAMENTO (Spot SELL: ${spotAmountFormatted} e Perp BUY: ${perpAmountFormatted})...`);
      const perpClosePromise = perpAlreadyClosed
        ? Promise.resolve({ skipped: true, id: undefined })
        : perpExchange.createMarketBuyOrder(strat.perpSymbol, Number(perpAmountFormatted), { reduceOnly: true, positionSide: 'SHORT' });

      const results = await withTimeout(
        Promise.allSettled([
          spotExchange.createMarketSellOrder(strat.spotSymbol, Number(spotAmountFormatted)),
          perpClosePromise
        ]),
        30000
      );

      const spotResult = results[0];
      const perpResult = results[1];
      
      let spotOrder = spotResult.status === 'fulfilled' ? spotResult.value : null;
      let perpOrder = perpResult.status === 'fulfilled' ? perpResult.value : null;

      if (spotResult.status === 'fulfilled') {
        log.info(`✅ Spot SHORT (Fechamento) aberto: ${spotOrder?.id ?? 'ok'} @ ~${spotPrice}`);
      } else {
        log.error(`❌ Spot SHORT falhou: ${spotResult.reason?.message}`);
      }

      if (perpResult.status === 'fulfilled') {
        log.info(`✅ Perp LONG (Fechamento) aberto: ${perpOrder?.id ?? 'ok'} @ ~${perpPrice}`);
      } else {
        log.error(`❌ Perp LONG falhou: ${perpResult.reason?.message}`);
      }

      // Trata erro 2009 como SUCESSO
      const isPerp2009 = perpResult.status === 'rejected' && (
        String(perpResult.reason?.message || '').includes('2009') ||
        String(perpResult.reason?.message || '').includes('nonexistent') ||
        String(perpResult.reason?.message || '').includes('not exist')
      );
      if (isPerp2009) {
        log.info(`ℹ️ [${strat.name}] Perp retornou "Position is nonexistent or closed" — posição já estava fechada. Tratando como sucesso.`);
        perpAlreadyClosed = true;
        perpOrder = { id: 'ALREADY_CLOSED', skipped: true };
      }

      // Reversão de segurança
      if (spotResult.status === 'fulfilled' && perpResult.status === 'rejected' && !isPerp2009) {
        log.error(`⚠️ Tentando reverter a ordem Spot de Fechamento (Re-comprando Spot) para evitar exposição direcional...`);
        try {
          await spotExchange.createMarketBuyOrder(strat.spotSymbol, spotAmount);
          log.info('↩️  Spot revertido com sucesso (Posição Hedge original mantida).');
        } catch (revertErr: any) {
          log.error('❌ Falha crítica ao reverter spot fechamento:', revertErr.message);
        }
        await recordLoss(strat, tradeSize * 0.002);
        throw new Error(`Perp close order falhou: ${perpResult.reason?.message}`);
      }
      
      if (perpResult.status === 'fulfilled' && spotResult.status === 'rejected') {
        log.error(`⚠️ Tentando reverter a ordem Perp de Fechamento (Re-vendendo Perp) para evitar exposição direcional...`);
        try {
          await perpExchange.createMarketSellOrder(strat.perpSymbol, perpAmount);
          log.info('↩️  Perp revertido com sucesso (Posição Hedge original mantida).');
        } catch (revertErr: any) {
          log.error('❌ Falha crítica ao reverter perp fechamento:', revertErr.message);
        }
        await recordLoss(strat, tradeSize * 0.002);
        throw new Error(`Spot close order falhou: ${spotResult.reason?.message}`);
      }

      if (spotResult.status === 'rejected' && perpResult.status === 'rejected' && !isPerp2009) {
         throw new Error(`Ambas as ordens falharam. Spot: ${spotResult.reason?.message} | Perp: ${perpResult.reason?.message}`);
      }

      // ── Reconciliação: perp já fechado (2009) + Spot sem saldo (Oversold) ──
      if (spotResult.status === 'rejected' && isPerp2009) {
        const spotMsg = String(spotResult.reason?.message || '');
        const isSpotClosed = spotMsg.includes('Oversold') || spotMsg.includes('30005') ||
          spotMsg.includes('insufficient') || spotMsg.includes('Balance') || spotMsg.includes('no balance');
        if (isSpotClosed) {
          log.info(`ℹ️ [${strat.name}] Posição já fechada na corretora (Perp: 2009 + Spot: ${spotMsg}). Reconciliando estado como FECHADO.`);
          spotOrder = { id: 'ALREADY_CLOSED', skipped: true };
          perpOrder = { id: 'ALREADY_CLOSED', skipped: true };
        } else {
          throw new Error(`Spot close order falhou: ${spotResult.reason?.message}`);
        }
      }

      trade.spotOrderId = spotOrder?.id;
      trade.perpOrderId = perpOrder?.id;

      const [spotExitFill, perpExitFill] = await Promise.all([
        resolveOrderFill(spotExchange, spotOrder, strat.spotSymbol),
        resolveOrderFill(perpExchange, perpOrder, strat.perpSymbol),
      ]);

      const realSpotExitQty = spotExitFill.filled;
      const realSpotExitPrice = spotExitFill.price;
      if (realSpotExitQty > 0) {
        trade.spotQuantity = realSpotExitQty;
        trade.baseAmount = realSpotExitQty;
      }
      if (realSpotExitPrice > 0) trade.spotExitPrice = realSpotExitPrice;

      const realPerpExitQty = perpExitFill.filled;
      const realPerpExitPrice = perpExitFill.price;
      if (realPerpExitQty > 0) trade.perpQuantity = realPerpExitQty;
      if (realPerpExitPrice > 0) trade.perpExitPrice = realPerpExitPrice;

      trade.status = 'executed';
      await trade.save();
      
      // Se foi criada automaticamente pelo scanner, deleta o registro; senão desativa.
      if (strat.isAutoCreated) {
        await (PerpArbStrategy as any).findByIdAndDelete(strat._id);
        log.info(`🗑️ [CLEANUP] Estratégia [${strat.name}] criada automaticamente foi excluída após o fechamento.`);
      } else {
        await (PerpArbStrategy as any).findByIdAndUpdate(strat._id, {
          active: false,
          positionOpen: false,
          positionOpenedAt: null,
          fundingCollected: 0,
          fundingCount: 0,
          fundingHistory: []
        });
        log.info(`✅ [${strat.name}] Estratégia FECHADA E DESATIVADA COM SUCESSO.`);
      }
      
      if (isTelegramEnabled()) {
        await alerts.tradeClosed(strat.name, strat.perpSymbol, realizedPnL, Number(strat.fundingCollected || 0), {
          dryRun: false,
          spotSymbol: strat.spotSymbol,
          reason: opts.reason || 'Fechamento de posição acionado',
          size: tradeSize,
        });
      }

      if (strat.userId) {
        takePortfolioSnapshot(String(strat.userId), true).catch(() => {});
      }

      return trade;

    } catch (e: any) {
      if (trade.status !== 'failed') {
        trade.status = 'failed';
        trade.errorMessage = e.message;
        await trade.save();
      }
      if (isTelegramEnabled()) {
        await alerts.tradeFailed(strat.name, `Falha no fechamento: ${e.message}`);
      }
      throw e;
    }

  } finally {
    await unlockStrategy(strategyId);
  }
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const strategyId = process.argv[2];
    const dry = !process.argv.includes('--live');
    if (!strategyId) {
      log.error('Uso: npx tsx perp-close-executor.ts <strategyId> [--live]');
      process.exit(1);
    }
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI required');
    await connectToDatabase();
    const result = await closeStrategy(strategyId, { dryRun: dry });
    log.info('Resultado do Fechamento:', result);
    process.exit(0);
  })().catch(err => { log.error(err); process.exit(1); });
}
