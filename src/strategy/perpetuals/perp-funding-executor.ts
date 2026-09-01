// @ts-nocheck
import ccxt from 'ccxt';
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
  async tradeOpened(strategyName: string, symbol: string, size: number, price: number, opts: any = {}) {
    const mode = opts.dryRun ? '🧪 (SIMULADO / DRY-RUN)' : '🚀 (LIVE)';
    const spotStr = opts.spotSymbol ? ` / ${opts.spotSymbol}` : '';
    await sendTelegramAlert(
      `🟢 *OPERAÇÃO DE ENTRADA ABERTA* ${mode}\n` +
      `📌 *Estratégia:* ${strategyName}\n` +
      `🔀 *Par:* ${symbol}${spotStr}\n` +
      `⚡ *Ação:* Spot LONG + Perp SHORT\n` +
      `💰 *Tamanho da Posição:* $${size.toFixed(2)} USDT\n` +
      `📍 Spot: $${(opts.spotPrice || price).toFixed(4)} | Perp: $${(opts.perpPrice || price).toFixed(4)}`
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

let _globalOpenMutex: Promise<() => Promise<void>> = Promise.resolve(async () => {});
let _acquiredGlobal = false;
function isGlobalOpeningInFlight(): boolean {
  return _acquiredGlobal;
}
async function acquireGlobalOpenLock(): Promise<() => Promise<void>> {
  let release!: () => Promise<void>;
  const previous = _globalOpenMutex;
  _globalOpenMutex = new Promise<() => Promise<void>>((resolve) => {
    previous.then(() => {
      _acquiredGlobal = true;
      release = async () => { _acquiredGlobal = false; resolve(release); };
    });
  });
  await previous;
  return release;
}

async function getExchange(doc: any, isPerp: boolean = false) {
  const { exchangeId, apiKey, apiSecret, userId } = doc;
  const id = exchangeId === 'gateio' ? 'gate' : exchangeId;
  const cls: any = (ccxt as any)[id] ?? (ccxt as any).pro?.[id] ?? (ccxt as any)[exchangeId];
  if (!cls) throw new Error(`Exchange "${exchangeId}" não suportada pelo ccxt`);

  let secret = apiSecret;
  try {
    const aad = userId ? `${userId}-${exchangeId}` : '';
    secret = decryptSecretKey(String(apiSecret || ''), aad);
  } catch { }

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

export async function executeStrategy(strategyId: string, opts: { dryRun?: boolean; overrideTradeSize?: number } = {}) {
  const dryRun       = opts.dryRun ?? (process.env.PERP_ALLOW_LIVE !== 'true');
  const testMaxUsd   = Number(process.env.TEST_MAX_USD ?? process.env.PERP_TEST_MAX_USD ?? 0);

  if (!await lockStrategy(strategyId)) throw new Error('Estratégia bloqueada (outra execução em curso)');

  const releaseGlobalLock = await acquireGlobalOpenLock();

  try {
    const strat = await (PerpArbStrategy as any).findById(strategyId).lean();
    if (!strat) throw new Error('Estratégia não encontrada no banco de dados');

    const symUpper = (strat.perpSymbol || strat.spotSymbol || strat.name || '').toUpperCase();
    if (symUpper.includes('CASHCAT') || symUpper.startsWith('CASH/') || symUpper.startsWith('CASH:') || symUpper.includes('/CASH') || symUpper === 'CASH') {
      throw new Error(`Abertura bloqueada: A moeda CASH/CASHCAT está desativada no robô.`);
    }

    if (!strat.active) throw new Error(`Estratégia "${strat.name}" está inativa (active=false) no banco de dados. Execução abortada.`);
    if ((strat as any).positionOpen && !opts.overrideTradeSize) throw new Error(`Estratégia "${strat.name}" já possui posição aberta (positionOpen=true). Execução duplicada abortada.`);

    const { perpKey, spotKey } = await resolveExchangeKeys(strat);
    const perpExchange = await getExchange(perpKey, true);
    const spotExchange = await getExchange(spotKey, false);

    log.info(`🚀 Executando [${strat.name}] | Perp: ${perpKey.name} | Spot: ${spotKey.name} | ${dryRun ? 'DRY-RUN' : 'LIVE'}`);

    let perpTicker: any = null;
    let spotTicker: any = null;
    try { perpTicker = await withTimeout(perpExchange.fetchTicker(strat.perpSymbol), 8000, null); } catch { }
    try { spotTicker = await withTimeout(spotExchange.fetchTicker(strat.spotSymbol), 8000, null); } catch { }

    let perpPrice = perpTicker?.last ?? perpTicker?.bid ?? perpTicker?.ask ?? null;
    let spotPrice = spotTicker?.last ?? spotTicker?.bid ?? spotTicker?.ask ?? null;

    if (!perpPrice || perpPrice <= 0) {
      try {
        const ob = await withTimeout(perpExchange.fetchOrderBook(strat.perpSymbol, 1), 8000, null);
        perpPrice = ob?.bids?.[0]?.[0] ?? ob?.asks?.[0]?.[0] ?? null;
      } catch { }
    }

    if (!spotPrice || spotPrice <= 0) {
      try {
        const ob = await withTimeout(spotExchange.fetchOrderBook(strat.spotSymbol, 1), 8000, null);
        spotPrice = ob?.asks?.[0]?.[0] ?? ob?.bids?.[0]?.[0] ?? null;
      } catch { }
    }

    if (!perpPrice || perpPrice <= 0) {
      throw new Error(`Preço do perpétuo ${strat.perpSymbol} indisponível (ticker + orderbook = null). Abortando para evitar tamanho de ordem incorreto.`);
    }

    let spotFree = 0;
    let futuresFree = 0;
    let calculatedTradeSize = 0;

    try {
      const { getCachedBalance, getDetailedSpotBalance, getDetailedFuturesBalance } = await import('./funding-arb');
      const perpKeyId = String(strat.perpExchangeKeyId || strat.exchangeKeyId || '');
      const cached = getCachedBalance(perpKeyId);

      if (cached) {
        spotFree = cached.spotUsdt;
        futuresFree = cached.futuresUsdt;
        log.info(`💰 [CACHE] Saldo do ciclo — Spot: $${spotFree.toFixed(2)} | Futuros: $${futuresFree.toFixed(2)} USDT`);
      } else {
        const { spotUsdt } = await getDetailedSpotBalance(spotExchange);
        const { futuresUsdt } = await getDetailedFuturesBalance(perpExchange);
        spotFree = spotUsdt;
        futuresFree = futuresUsdt;
        log.info(`💰 [API] Saldo buscado da exchange — Spot: $${spotFree.toFixed(2)} | Futuros: $${futuresFree.toFixed(2)} USDT`);
      }

      if (futuresFree <= 0) {
        throw new Error(`Saldo livre de FUTUROS zerado/indisponível ($${futuresFree.toFixed(2)}). Abortando abertura — sem margem para o perp.`);
      }

      const minAvailableUsd = Math.min(
        spotFree > 0 ? spotFree : Infinity,
        futuresFree > 0 ? futuresFree : Infinity
      );

      const safeMinAvailableUsd = minAvailableUsd !== Infinity ? Math.floor(minAvailableUsd * 0.95 * 100) / 100 : Infinity;

      if (opts.overrideTradeSize) {
        calculatedTradeSize = Number(opts.overrideTradeSize);
        if (safeMinAvailableUsd > 0 && safeMinAvailableUsd !== Infinity && calculatedTradeSize > safeMinAvailableUsd) {
          log.info(`💵 Ajustando aporte manual ($${calculatedTradeSize.toFixed(2)}) para o saldo livre seguro ($${safeMinAvailableUsd.toFixed(2)} USDT)`);
          calculatedTradeSize = safeMinAvailableUsd;
        }
      } else {
        const configuredMaxPerCoin = Number(strat.tradeSize || 0);
        if (safeMinAvailableUsd > 0 && safeMinAvailableUsd !== Infinity) {
          calculatedTradeSize = configuredMaxPerCoin > 0 ? Math.min(safeMinAvailableUsd, configuredMaxPerCoin) : safeMinAvailableUsd;
        } else {
          calculatedTradeSize = configuredMaxPerCoin;
        }
      }

      if (calculatedTradeSize < 10) {
        throw new Error(`Saldo livre disponível em Spot ($${spotFree.toFixed(2)}) ou Futuros ($${futuresFree.toFixed(2)}) com margem de segurança aplicada é inferior ao mínimo de $10.00 USDT. Ordem cancelada.`);
      }
    } catch (balErr: any) {
      if (balErr.message?.includes('inferior ao mínimo')) throw balErr;
      log.warn(`⚠️ Erro ao verificar saldos em Spot/Futuros:`, balErr?.message);
    }

    const rawTradeSize = (testMaxUsd > 0 && calculatedTradeSize > testMaxUsd)
      ? testMaxUsd
      : calculatedTradeSize;

    const tradeSize = rawTradeSize;
    log.info(`📌 [LIMITE ORDEM] Saldo Spot livre=${spotFree.toFixed(2)} | Saldo Futuros livre=${futuresFree.toFixed(2)} | Valor final ordem=$${tradeSize.toFixed(2)} USDT`);

    if (testMaxUsd > 0 && rawTradeSize < calculatedTradeSize) {
      log.info(`⚠️  Cap de teste: ${calculatedTradeSize} → ${rawTradeSize} USDT`);
    }

    const trade: any = await PerpArbTrade.create({
      userId: strat.userId,
      strategyId: strat._id,
      strategyName: strat.name,
      perpSymbol: strat.perpSymbol,
      spotSymbol: strat.spotSymbol,
      type: 'open_hedge',
      status: dryRun ? 'simulated' : 'detected',
      amount: tradeSize,
      baseAmount: spotPrice > 0 ? tradeSize / spotPrice : undefined,
      spotPrice,
      perpPrice,
      fundingRate: strat.currentFundingRate !== undefined && strat.currentFundingRate !== null ? Number(strat.currentFundingRate) / 100 : (strat.minFundingRatePct ? Number(strat.minFundingRatePct) / 100 : null),
      fundingPct: strat.currentFundingRate ?? strat.minFundingRatePct ?? null,
    });

    if (dryRun) {
      log.info(`[dry-run] LONG spot ${strat.spotSymbol} + SHORT perp ${strat.perpSymbol} — ${tradeSize} USDT`);
      trade.status = 'simulated';
      await trade.save();

      await (PerpArbStrategy as any).findByIdAndUpdate(strat._id, {
        positionOpen: true,
        positionSize: tradeSize,
        positionOpenedAt: new Date(),
        fundingCollected: 0,
        fundingCount: 0,
        fundingHistory: []
      });

      if (strat.userId) {
        takePortfolioSnapshot(String(strat.userId), true).catch(() => {});
      }

      if (isTelegramEnabled()) {
        const basePrice = perpPrice || spotPrice || 1;
        await alerts.tradeOpened(strat.name, strat.perpSymbol, tradeSize, basePrice, {
          dryRun: true,
          spotSymbol: strat.spotSymbol,
          spotPrice: spotPrice || undefined,
          perpPrice: perpPrice || undefined,
          baseAmount: basePrice > 0 ? tradeSize / basePrice : undefined,
          userId: String(strat.userId || ''),
        });
      }

      return trade;
    }

    try {
      try { if (!spotExchange.markets || Object.keys(spotExchange.markets).length === 0) await spotExchange.loadMarkets(); } catch {}
      try { if (!perpExchange.markets || Object.keys(perpExchange.markets).length === 0) await perpExchange.loadMarkets(); } catch {}

      const spotMarket = spotExchange.markets?.[strat.spotSymbol];
      const perpMarket = perpExchange.markets?.[strat.perpSymbol];

      const contractSize = Number(perpMarket?.contractSize ?? 1);
      let perpAmountNum = (tradeSize / Number(perpPrice || 1)) / contractSize;

      if (perpMarket?.limits?.amount?.max && perpAmountNum > perpMarket.limits.amount.max) {
        log.warn(`⚠️ Quantidade ${perpAmountNum} excede o limite por ordem no Perp (${perpMarket.limits.amount.max}). Ajustando.`);
        perpAmountNum = perpMarket.limits.amount.max;
      }

      const perpAmountStr = perpExchange.amountToPrecision ? perpExchange.amountToPrecision(strat.perpSymbol, perpAmountNum) : String(perpAmountNum);
      const exactPerpContracts = Number(perpAmountStr);
      const baseUnitsForPerp = exactPerpContracts * contractSize;
      const spotAmountNum = baseUnitsForPerp;
      const spotAmount = spotExchange.amountToPrecision ? spotExchange.amountToPrecision(strat.spotSymbol, spotAmountNum) : spotAmountNum;
      const perpAmount = exactPerpContracts;

      trade.spotQuantity = Number(spotAmount);
      trade.perpQuantity = Number(perpAmount);

      try {
        if (perpExchange.has['setMarginMode'] && perpExchange.id !== 'mexc') {
           await withTimeout(perpExchange.setMarginMode('cross', strat.perpSymbol, { leverage: 1 }), 8000, null);
           log.info(`🛡️ Margin mode ajustado para CROSS no Perpétuo.`);
        }
      } catch (e: any) {
        if (e.message?.includes('Contract not activated') || e.message?.includes('1002') || e.message?.includes('not activated')) {
          throw new Error(`Contrato Perpétuo não ativado na corretora (${strat.perpSymbol}): ${e.message}`);
        }
        log.warn(`⚠️ Aviso: Falha ao setar Margin Mode: ${e.message}`);
      }

      try {
        if (perpExchange.has['setLeverage']) {
           await withTimeout(perpExchange.setLeverage(1, strat.perpSymbol, { openType: 2, positionType: 2 }), 8000, null);
           log.info(`🛡️ Alavancagem ajustada para 1x no Perpétuo.`);
        }
      } catch (e: any) {
        if (e.message?.includes('Contract not activated') || e.message?.includes('1002') || e.message?.includes('not activated') || e.message?.includes('permission')) {
          throw new Error(`Contrato Perpétuo não ativado/sem permissão na corretora (${strat.perpSymbol}): ${e.message}`);
        }
        log.warn(`⚠️ Aviso: Falha ao setar Leverage 1x: ${e.message}`);
      }

      try {
        const feeCheck = await withTimeout(
          perpExchange.fetchTradingFee(strat.perpSymbol),
          8000
        );
        if (feeCheck === null) {
          log.warn(`⚠️ Timeout ao verificar contrato perp ${strat.perpSymbol} — prosseguindo com cautela.`);
        } else {
          log.info(`✅ Contrato Perpétuo ${strat.perpSymbol} ativo (fee verificada).`);
        }
      } catch (e: any) {
        const msg = e?.message || String(e);
        if (msg.includes('Contract not activated') || msg.includes('1002') || msg.includes('not activated') || msg.includes('permission') || msg.includes('does not exist')) {
          throw new Error(`🛑 Contrato Perpétuo NÃO ativado (${strat.perpSymbol}) — abortando antes de abrir o Spot: ${msg}`);
        }
        log.warn(`⚠️ Aviso na verificação do contrato perp: ${msg}`);
      }

      try {
        const { getCachedFuturesFree } = await import('./funding-arb');
        const futuresUsdt = await withTimeout(getCachedFuturesFree(perpExchange), 8000, 0);
        // Notional real da posição: quantidade (contratos) × contractSize × preço
        const needed = perpAmountNum * contractSize * Number(perpPrice || 0);
        if (futuresUsdt > 0 && needed > 0 && futuresUsdt < needed * 1.2) {
          throw new Error(`🛑 Saldo de FUTUROS insuficiente (${strat.perpSymbol}): livre=$${futuresUsdt.toFixed(2)} necessário(s+20%)=$${(needed * 1.2).toFixed(2)} — abortando antes de abrir o Spot.`);
        }
        if (futuresUsdt === 0 && needed > 0) {
          throw new Error(`🛑 Saldo de FUTUROS zerado/indisponível (${strat.perpSymbol}) — abortando antes de abrir o Spot (evita reversão com taxa).`);
        }
        log.info(`✅ Saldo de futuros OK (com folga de 20%): livre=$${futuresUsdt.toFixed(2)} | necessário=$${needed.toFixed(2)}`);
      } catch (e: any) {
        if (e?.message?.includes('Saldo de FUTUROS')) throw e;
        log.warn(`⚠️ Erro na verificação de saldo de futuros: ${e?.message || e}`);
      }

      log.info(`🚀 Enviando ordens simultâneas (Spot LONG e Perp SHORT)...`);
      const formattedQuoteQty = Math.floor(tradeSize * 100) / 100;
      
      const spotOrderPromise = spotExchange.id === 'mexc'
        ? spotExchange.createOrder(strat.spotSymbol, 'market', 'buy', spotAmount, undefined, { quoteOrderQty: formattedQuoteQty })
        : spotExchange.createOrder(strat.spotSymbol, 'market', 'buy', spotAmount, spotPrice, { cost: tradeSize, quoteOrderQty: formattedQuoteQty });

      const perpOrderPromise = perpExchange.createMarketSellOrder(strat.perpSymbol, perpAmount, { positionSide: 'SHORT', hedged: true });

      const results = await withTimeout(
        Promise.allSettled([spotOrderPromise, perpOrderPromise]),
        30000
      );

      const spotResult = results[0];
      const perpResult = results[1];
      
      let spotOrder = spotResult.status === 'fulfilled' ? spotResult.value : null;
      let perpOrder = perpResult.status === 'fulfilled' ? perpResult.value : null;

      const baseSymbol = strat.spotSymbol.split('/')[0];
      let netSpotAmount = 0;

      if (spotResult.status === 'fulfilled') {
        log.info(`✅ Spot LONG aberto: ${spotOrder?.id || 'ok'} @ ~${spotPrice}`);

        const filled = Number(spotOrder?.filled || spotOrder?.amount || spotAmountNum);
        let totalFeeInBase = 0;
        if (spotOrder?.fee?.cost) {
          const feeCurr = spotOrder.fee.currency;
          if (feeCurr === baseSymbol || feeCurr === strat.spotSymbol) {
            totalFeeInBase += Number(spotOrder.fee.cost);
          }
        } else if (Array.isArray(spotOrder?.fees)) {
          for (const f of spotOrder.fees) {
            if (f.currency === baseSymbol || f.currency === strat.spotSymbol) {
              totalFeeInBase += Number(f.cost || 0);
            }
          }
        }
        if (totalFeeInBase === 0 && filled > 0) {
          const estimatedFeePct = spotMarket?.taker ?? 0.001;
          totalFeeInBase = filled * estimatedFeePct;
        }
        netSpotAmount = Math.max(0, filled - totalFeeInBase);
      } else {
        log.error(`❌ Spot LONG falhou: ${spotResult.reason?.message}`);
      }

      if (perpResult.status === 'fulfilled') {
        log.info(`✅ Perp SHORT aberto: ${perpOrder?.id || 'ok'} @ ~${perpPrice}`);
      } else {
        log.error(`❌ Perp SHORT falhou: ${perpResult.reason?.message}`);
      }

      if (spotResult.status === 'fulfilled' && perpResult.status === 'rejected') {
        log.error(`⚠️ Tentando reverter a ordem Spot para evitar exposição direcional...`);
        if (isTelegramEnabled()) {
          await sendTelegramAlert(
            `🚨 *ERRO CRÍTICO DE EXECUÇÃO (PERP FALHOU)*\n` +
            `📌 *Estratégia:* ${strat.name}\n` +
            `🔀 *Spot LONG executou com sucesso, mas Perp SHORT falhou!*\n` +
            `❌ *Erro Perpétuo:* \`${perpResult.reason?.message}\`\n` +
            `🔄 *Ação:* Tentando reverter a ordem Spot para evitar exposição direcional.`
          ).catch(() => {});
        }
        try {
          let rollbackAmount = netSpotAmount;
          try {
            const balance = await spotExchange.fetchBalance();
            const freeBaseBalance = Number(balance?.[baseSymbol]?.free || 0);
            if (freeBaseBalance > 0) {
              rollbackAmount = freeBaseBalance;
            }
          } catch (balErr: any) {
            log.warn(`⚠️ Erro ao consultar saldo spot para rollback, usando saldo líquido calculado (${netSpotAmount}): ${balErr?.message}`);
          }

          const formattedRollbackAmount = spotExchange.amountToPrecision ? spotExchange.amountToPrecision(strat.spotSymbol, rollbackAmount) : rollbackAmount;
          log.info(`↩️  Executando reversão de ${formattedRollbackAmount} ${baseSymbol} no Spot...`);
          await spotExchange.createMarketSellOrder(strat.spotSymbol, formattedRollbackAmount);
          log.info('↩️  Spot revertido com sucesso.');
          if (isTelegramEnabled()) {
            await sendTelegramAlert(`✅ ↩️ *Spot revertido com sucesso!* Exposição zerada (${formattedRollbackAmount} ${baseSymbol}).`).catch(() => {});
          }
        } catch (revertErr: any) {
          log.error('❌ Falha crítica ao reverter spot:', revertErr.message);
          if (isTelegramEnabled()) {
            await sendTelegramAlert(`⚠️ 🔥 *FALHA CRÍTICA AO REVERTER SPOT:* \`${revertErr.message}\`. Fechamento manual imediato requerido!`).catch(() => {});
          }
        }
        await recordLoss(strat, tradeSize * 0.002);
        throw new Error(`Perp order falhou: ${perpResult.reason?.message}`);
      }
      
      if (perpResult.status === 'fulfilled' && spotResult.status === 'rejected') {
        log.error(`⚠️ Tentando reverter a ordem Perp para evitar exposição direcional...`);
        if (isTelegramEnabled()) {
          await sendTelegramAlert(
            `🚨 *ERRO CRÍTICO DE EXECUÇÃO (SPOT FALHOU)*\n` +
            `📌 *Estratégia:* ${strat.name}\n` +
            `🔀 *Perp SHORT executou com sucesso, mas Spot LONG falhou!*\n` +
            `❌ *Erro Spot:* \`${spotResult.reason?.message}\`\n` +
            `🔄 *Ação:* Tentando reverter a ordem Perp para evitar exposição direcional.`
          ).catch(() => {});
        }
        try {
          await perpExchange.createMarketBuyOrder(strat.perpSymbol, perpAmount, { reduceOnly: true, positionSide: 'SHORT', hedged: true });
          log.info('↩️  Perp SHORT revertido com sucesso.');
          if (isTelegramEnabled()) {
            await sendTelegramAlert(`✅ ↩️ *Perp SHORT revertido com sucesso!* Exposição zerada.`).catch(() => {});
          }
        } catch (revertErr: any) {
          log.error('❌ Falha crítica ao reverter perp:', revertErr.message);
          if (isTelegramEnabled()) {
            await sendTelegramAlert(`⚠️ 🔥 *FALHA CRÍTICA AO REVERTER PERPÉTUO:* \`${revertErr.message}\`. Fechamento manual imediato requerido!`).catch(() => {});
          }
        }
        await recordLoss(strat, tradeSize * 0.002);
        throw new Error(`Spot order falhou: ${spotResult.reason?.message}`);
      }

      if (spotResult.status === 'rejected' && perpResult.status === 'rejected') {
         throw new Error(`Ambas as ordens falharam. Spot: ${spotResult.reason?.message} | Perp: ${perpResult.reason?.message}`);
      }

      trade.spotOrderId = spotOrder?.id;
      trade.perpOrderId = perpOrder?.id;

      // Atualiza com os valores reais de preenchimento (filled / avg price) da exchange
      const [spotFill, perpFill] = await Promise.all([
        resolveOrderFill(spotExchange, spotOrder, strat.spotSymbol),
        resolveOrderFill(perpExchange, perpOrder, strat.perpSymbol),
      ]);

      const realSpotFilled = spotFill.filled;
      const realSpotPrice = spotFill.price;
      if (realSpotFilled > 0) {
        trade.spotQuantity = realSpotFilled;
        trade.baseAmount = realSpotFilled;
      }
      if (realSpotPrice > 0) trade.spotPrice = realSpotPrice;

      const realPerpFilled = perpFill.filled;
      const realPerpPrice = perpFill.price;
      if (realPerpFilled > 0) trade.perpQuantity = realPerpFilled;
      if (realPerpPrice > 0) trade.perpPrice = realPerpPrice;

      trade.status = 'executed';
      await trade.save();
      
      const currentPosSize = strat.positionOpen ? Number(strat.positionSize || 0) : 0;
      const newPosSize = currentPosSize + tradeSize;

      await (PerpArbStrategy as any).findByIdAndUpdate(strat._id, {
        positionOpen: true,
        positionSize: newPosSize,
        ...(strat.positionOpen ? {} : { positionOpenedAt: new Date(), fundingCollected: 0, fundingCount: 0, fundingHistory: [] }),
      });

      if (strat.userId) {
        takePortfolioSnapshot(String(strat.userId), true).catch(() => {});
      }

      if (isTelegramEnabled()) {
        const basePrice = perpPrice || spotPrice || 1;
        await alerts.tradeOpened(strat.name, strat.perpSymbol, tradeSize, basePrice, {
          dryRun: false,
          spotSymbol: strat.spotSymbol,
          spotPrice: spotPrice || undefined,
          perpPrice: perpPrice || undefined,
          baseAmount: basePrice > 0 ? tradeSize / basePrice : undefined,
          userId: String(strat.userId || ''),
        });
      }

      return trade;

    } catch (e: any) {
      if (trade.status !== 'failed') {
        trade.status = 'failed';
        trade.errorMessage = e.message;
        await trade.save();
      }
      if (isTelegramEnabled()) {
        await alerts.tradeFailed(strat.name, `Falha na entrada: ${e.message}`);
      }
      throw e;
    }

  } finally {
    await releaseGlobalLock();
    await unlockStrategy(strategyId);
  }
}

if (require.main === module) {
  (async () => {
    const strategyId = process.argv[2];
    const dry = !process.argv.includes('--live');
    if (!strategyId) {
      log.error('Uso: npx tsx perp-funding-executor.ts <strategyId> [--live]');
      process.exit(1);
    }
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI required');
    await connectToDatabase();
    const result = await executeStrategy(strategyId, { dryRun: dry });
    log.info('Resultado:', result);
    process.exit(0);
  })().catch(err => { log.error(err); process.exit(1); });
}
