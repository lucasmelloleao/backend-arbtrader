// Market making com inventário em prediction markets (Polymarket).
//
// Estratégia: cota pares auto-hedgeados (compra YES + compra NO com soma < 1)
// de forma progressiva — começa no bid e sobe em direção ao ask até preencher.
// Quando ambos os lados preenchem, o par paga $1 no vencimento (lucro =
// 1 - soma dos preços pagos). O inventário acumulado é limitado por caps e
// rebalanceado quando desbalanceia.
import PredictionArbStrategy from '../../models/PredictionArbStrategy';
import PredictionArbTrade from '../../models/PredictionArbTrade';
import ExchangeKey from '../../models/ExchangeKey';
import { resolvePolymarketKey } from './prediction-scanner';
import { resolveClobCredentials, placeOrder, cancelOrder, fetchBook, fetchPositions, signOrder } from './helpers/clob-client';
import { placeOrderViaSdk, cancelOrderViaSdk, fetchPositionsViaSdk } from './helpers/secure-client';
import { makerEntryPrices } from './helpers/pricing';

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
};

/** Busca o melhor bid/ask de um token. */
async function bookPrices(tokenId: string): Promise<{ bid: number; ask: number }> {
  try {
    const book = await fetchBook(tokenId);
    return { bid: book.bids[0]?.[0] || 0, ask: book.asks[0]?.[0] || 0 };
  } catch {
    return { bid: 0, ask: 0 };
  }
}

/** Profundidade acumulada no bid até atingir `targetShares` (em shares). */
async function bookBidDepth(tokenId: string, targetShares: number): Promise<number> {
  try {
    const book = await fetchBook(tokenId);
    let acc = 0;
    for (const [price, size] of book.bids) {
      if (price <= 0) continue;
      acc += size;
      if (acc >= targetShares) break;
    }
    return acc;
  } catch {
    return 0;
  }
}

/**
 * Cota um lado do par: preço maker (bid) com progressão em direção ao ask.
 */
export function progressiveQuotePrice(bid: number, ask: number, step: number, attempt: number): number {
  if (bid <= 0) return 0;
  if (ask <= 0) return bid;
  // attempt 0 = bid puro; a cada tentativa sobe um step em direção ao ask
  const maxAdd = Math.max(0, ask - bid);
  return Math.min(ask, bid + step * attempt);
}

/**
 * Loop de market making para uma estratégia: reconcilia inventário real,
 * cota o par (com progressão), cancela ordens antigas e mantém caps.
 * Retorna { quoted, filled }.
 */
export async function runMarketMaking(
  strategy: any,
  opts: { dryRun?: boolean } = {},
): Promise<{ quoted: boolean; orderIds: string[] }> {
  const dryRun = opts.dryRun ?? true;

  // Só opera em mercados ativos e com tokens
  if (!strategy.active) return { quoted: false, orderIds: [] };
  if (!strategy.tokenIdYes || !strategy.tokenIdNo) return { quoted: false, orderIds: [] };

  const key = await resolvePolymarketKey(strategy.userId);
  if (!key) return { quoted: false, orderIds: [] };
  // ExchangeKey completa (para a SDK ler apiSecret/relayerApiKey)
  const keyDoc = await ExchangeKey.findById(key._id).lean().catch(() => key);
  const credentials = resolveClobCredentials(keyDoc);
  // true se a SDK pode operar (relayer key configurada)
  const useSdk = Boolean(String(keyDoc?.relayerApiKey || process.env.POLYMARKET_RELAYER_KEY || '').trim());

  const cap = Number(strategy.maxInventoryPairs ?? 10);
  const step = Number(strategy.quoteStep ?? 0.005);
  const tradeSize = Number(strategy.tradeSize ?? 100);
  const sharesPerQuote = Math.max(1, Math.min(Math.floor(tradeSize), cap)); // ações por lado

  // 1. Inventário real (fonte da verdade) — via SDK quando disponível
  let positions: any[] = [];
  if (useSdk) {
    positions = await fetchPositionsViaSdk(keyDoc).catch(() => []);
  } else {
    positions = await fetchPositions(credentials).catch(() => []);
  }
  const yesPos = positions.find((p: any) => p.asset_id === strategy.tokenIdYes || String(p.token_id || '') === strategy.tokenIdYes);
  const noPos = positions.find((p: any) => p.asset_id === strategy.tokenIdNo || String(p.token_id || '') === strategy.tokenIdNo);
  const yesShares = Number(yesPos?.size || 0);
  const noShares = Number(noPos?.size || 0);
  const yesAvg = Number(yesPos?.avg_price || 0);
  const noAvg = Number(noPos?.avg_price || 0);

  await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, {
    yesShares,
    noShares,
    ...(yesAvg > 0 ? { avgYesPrice: yesAvg } : {}),
    ...(noAvg > 0 ? { avgNoPrice: noAvg } : {}),
    positionSize: (yesShares + noShares) / 2,
  });

  // 2. Se ambos os lados têm inventário, o par está montado — registra a
  //    operação (se ainda não registrada) e segura até vencimento.
  const hasPair = yesShares >= 1 && noShares >= 1;
  if (hasPair) {
    log.info(`🧺 [${strategy.slug}] Par completo: ${yesShares} YES + ${noShares} NO. Segurando até vencimento.`);
    // Cancela ordens abertas (não quer mais acumular)
    for (const oid of strategy.openOrderIds || []) {
      if (useSdk) await cancelOrderViaSdk(keyDoc, oid).catch(() => {});
      else await cancelOrder(credentials, oid).catch(() => {});
    }
    await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, {
      openOrderIds: [],
      positionOpen: true,
      positionSize: (yesShares + noShares) / 2,
      yesShares,
      noShares,
      ...(yesAvg > 0 ? { avgYesPrice: yesAvg } : {}),
      ...(noAvg > 0 ? { avgNoPrice: noAvg } : {}),
    });

    // Registra o trade de abertura se ainda não existir (open_pair executado)
    const jaRegistrado = await PredictionArbTrade.findOne({
      strategyId: strategy._id,
      type: 'open_pair',
      status: 'executed',
    }).lean();
    if (!jaRegistrado) {
      await PredictionArbTrade.create({
        userId: strategy.userId,
        strategyId: strategy._id,
        marketId: strategy.marketId,
        slug: strategy.slug,
        question: strategy.question,
        type: 'open_pair',
        status: 'executed',
        yesPrice: yesAvg || strategy.yesPrice,
        noPrice: noAvg || strategy.noPrice,
        amount: (yesShares + noShares) / 2,
        yesShares,
        noShares,
        spreadPct: strategy.spreadPct,
        reason: 'Par preenchido via market making',
      }).catch(() => {});
      log.info(`📝 [${strategy.slug}] Operação registrada: ${yesShares} YES + ${noShares} NO.`);
    }
    return { quoted: false, orderIds: [] };
  }

  // 2.5 Lado único exposto: se só UM lado preencheu (ex: YES=10, NO=0), o robô
  //     fica com risco direcional. Tenta completar o par; se o mercado está
  //     perto do vencimento, VENDE o lado único para não perder tudo.
  const oneSideOnly = (yesShares >= 1) !== (noShares >= 1);
  if (oneSideOnly) {
    const endMs = strategy.endDate ? new Date(strategy.endDate).getTime() : 0;
    const hoursToEnd = endMs > 0 ? (endMs - Date.now()) / 3600000 : Infinity;
    const exposedShares = yesShares >= 1 ? yesShares : noShares;
    const exposedSide = yesShares >= 1 ? 'YES' : 'NO';
    const exposedToken = yesShares >= 1 ? strategy.tokenIdYes : strategy.tokenIdNo;

    // Se falta < 30min para vencer e o outro lado não preencheu, reverte o lado exposto.
    if (hoursToEnd < 0.5) {
      log.warn(`⚠️ [${strategy.slug}] Lado único exposto (${exposedSide} ${exposedShares}) com vencimento em ${hoursToEnd.toFixed(2)}h. Vendendo para não perder.`);
      try {
        // Vende no bid atual para sair da posição
        const book = await bookPrices(exposedToken);
        if (book.bid > 0 && useSdk) {
          await placeOrderViaSdk(keyDoc, { tokenId: exposedToken, side: 'SELL', price: book.bid, size: exposedShares });
          log.info(`✅ [${strategy.slug}] Lado ${exposedSide} vendido (${exposedShares} @ ${book.bid}).`);
        } else if (book.bid > 0) {
          const sell = await signOrder({ credentials, tokenId: exposedToken, side: 'SELL', price: book.bid, size: exposedShares });
          await placeOrder(credentials, sell);
          log.info(`✅ [${strategy.slug}] Lado ${exposedSide} vendido (${exposedShares} @ ${book.bid}).`);
        }
      } catch (e: any) {
        log.warn(`⚠️ [${strategy.slug}] Falha ao vender lado exposto: ${e.message}`);
      }
      // Cancela ordens do outro lado e marca como fechada (sem posição útil)
      for (const oid of strategy.openOrderIds || []) {
        if (useSdk) await cancelOrderViaSdk(keyDoc, oid).catch(() => {});
        else await cancelOrder(credentials, oid).catch(() => {});
      }
      await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, {
        openOrderIds: [], positionOpen: false, yesShares: 0, noShares: 0, active: false, mmActive: false,
      });
      return { quoted: false, orderIds: [] };
    }

    // Ainda tem tempo: tenta completar o par (cotar o lado faltante com prioridade)
    log.info(`🎯 [${strategy.slug}] Lado único (${exposedSide} ${exposedShares}). Tentando completar o par...`);
  }

  // 3. Cap de inventário: se um lado já está perto do cap, não acumula mais do lado certo
  const capReached = yesShares >= cap || noShares >= cap;
  if (capReached) {
    log.warn(`🧯 [${strategy.slug}] Cap de inventário atingido (YES=${yesShares} NO=${noShares}). Parando cotação.`);
    for (const oid of strategy.openOrderIds || []) {
      await cancelOrder(credentials, oid).catch(() => {});
    }
    await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, { openOrderIds: [] });
    return { quoted: false, orderIds: [] };
  }

  // 4. Preços do book
  const bYes = await bookPrices(strategy.tokenIdYes);
  const bNo = await bookPrices(strategy.tokenIdNo);
  if (bYes.bid <= 0 || bNo.bid <= 0) {
    log.warn(`⚠️ [${strategy.slug}] Book insuficiente para cotar (bidYes=${bYes.bid} bidNo=${bNo.bid}).`);
    return { quoted: false, orderIds: [] };
  }

  // 4.1 Profundidade: só cotar se AMBOS os lados têm book para o tamanho da
  //     ordem. Se um lado não tem profundidade, entrar resultaria em posição
  //     de lado único (risco direcional) — evita a perda vista antes.
  const depthYes = await bookBidDepth(strategy.tokenIdYes, sharesPerQuote);
  const depthNo = await bookBidDepth(strategy.tokenIdNo, sharesPerQuote);
  if (depthYes < sharesPerQuote || depthNo < sharesPerQuote) {
    log.warn(`⚠️ [${strategy.slug}] Profundidade insuficiente: YES depth=${depthYes.toFixed(1)} NO depth=${depthNo.toFixed(1)} (precisa ${sharesPerQuote}). Não cotando.`);
    return { quoted: false, orderIds: [] };
  }

  // 5. Preço do par: soma < 1 para garantir lucro no vencimento.
  //    Usa o makerEntryPrices (soma = 1 - spreadAlvo) e progride em direção ao ask.
  const targetSpread = Math.max(Number(strategy.spreadPct || 0.5), 0.2);
  const baseEntry = makerEntryPrices(bYes.bid, bNo.bid, targetSpread);
  if (!baseEntry) {
    log.warn(`⚠️ [${strategy.slug}] Não foi possível montar par maker (bids ${bYes.bid}/${bNo.bid}).`);
    return { quoted: false, orderIds: [] };
  }

  // Progressão: quantas tentativas já fizemos (via quoteStep count no campo)
  const attempt = Number(strategy.mmQuoteAttempt ?? 0);
  const yesPrice = progressiveQuotePrice(baseEntry.yes, bYes.ask || baseEntry.yes, step, attempt);
  const noPrice = progressiveQuotePrice(baseEntry.no, bNo.ask || baseEntry.no, step, attempt);
  const pairSum = yesPrice + noPrice;
  if (pairSum >= 1) {
    log.warn(`⚠️ [${strategy.slug}] Preços progrediram demais (soma ${pairSum.toFixed(4)} ≥ 1). Resetando cotação.`);
    await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, { mmQuoteAttempt: 0 });
    return { quoted: false, orderIds: [] };
  }

  // 6. Cancela ordens antigas antes de re-cotar (evita acúmulo de ordens parciais)
  for (const oid of strategy.openOrderIds || []) {
    if (useSdk) await cancelOrderViaSdk(keyDoc, oid).catch(() => {});
    else await cancelOrder(credentials, oid).catch(() => {});
  }

  if (dryRun) {
    log.info(`[dry-run] MM ${strategy.slug}: YES ${sharesPerQuote} @ ${yesPrice.toFixed(4)} + NO ${sharesPerQuote} @ ${noPrice.toFixed(4)} (soma ${pairSum.toFixed(4)}, tentativa ${attempt})`);
    await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, { mmQuoteAttempt: attempt + 1, openOrderIds: [] });
    return { quoted: true, orderIds: [] };
  }

  // 7. Coloca as ordens do par (via SDK quando possível — suporta deposit wallet)
  const orderIds: string[] = [];
  try {
    if (useSdk) {
      const [yesId, noId] = await Promise.all([
        placeOrderViaSdk(keyDoc, { tokenId: strategy.tokenIdYes, side: 'BUY', price: yesPrice, size: sharesPerQuote })
          .catch((e: any) => { log.warn(`⚠️ [${strategy.slug}] Ordem YES (SDK) falhou: ${e.message}`); return null; }),
        placeOrderViaSdk(keyDoc, { tokenId: strategy.tokenIdNo, side: 'BUY', price: noPrice, size: sharesPerQuote })
          .catch((e: any) => { log.warn(`⚠️ [${strategy.slug}] Ordem NO (SDK) falhou: ${e.message}`); return null; }),
      ]);
      if (yesId) orderIds.push(yesId);
      if (noId) orderIds.push(noId);
    } else {
      const yesOrder = await signOrder({ credentials, tokenId: strategy.tokenIdYes, side: 'BUY', price: yesPrice, size: sharesPerQuote });
      const noOrder = await signOrder({ credentials, tokenId: strategy.tokenIdNo, side: 'BUY', price: noPrice, size: sharesPerQuote });
      const [yesId, noId] = await Promise.all([
        placeOrder(credentials, yesOrder).catch((e: any) => { log.warn(`⚠️ [${strategy.slug}] Ordem YES falhou: ${e.message}`); return null; }),
        placeOrder(credentials, noOrder).catch((e: any) => { log.warn(`⚠️ [${strategy.slug}] Ordem NO falhou: ${e.message}`); return null; }),
      ]);
      if (yesId) orderIds.push(yesId);
      if (noId) orderIds.push(noId);
    }

    await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, {
      openOrderIds: orderIds,
      mmQuoteAttempt: orderIds.length === 2 ? attempt + 1 : 0, // só progride se ambas as ordens foram aceitas
      mmActive: true,
    });

    if (orderIds.length > 0) {
      log.info(`📣 [${strategy.slug}] Cotações: YES ${sharesPerQuote} @ ${yesPrice.toFixed(4)} + NO ${sharesPerQuote} @ ${noPrice.toFixed(4)} (soma ${pairSum.toFixed(4)}, tentativa ${attempt + 1})`);
    }

    // Registra a cotação como trade (tipo mm_quote) para observabilidade
    await PredictionArbTrade.create({
      userId: strategy.userId,
      strategyId: strategy._id,
      slug: strategy.slug,
      question: strategy.question,
      type: 'mm_quote',
      status: 'open',
      yesPrice,
      noPrice,
      amount: sharesPerQuote * pairSum,
      yesShares: sharesPerQuote,
      noShares: sharesPerQuote,
      orderIds,
      reason: `MM tentativa ${attempt + 1}`,
    }).catch(() => {});
  } catch (e: any) {
    log.warn(`⚠️ [${strategy.slug}] Falha ao cotar MM: ${e.message}`);
  }
  return { quoted: orderIds.length > 0, orderIds };
}

/** Rebalancea inventário desbalanceado: vende o lado pesado (existente). */
export async function rebalanceInventory(strategy: any, opts: { dryRun?: boolean } = {}) {
  const dryRun = opts.dryRun ?? true;
  const yesShares = Number(strategy.yesShares || 0);
  const noShares = Number(strategy.noShares || 0);
  if (yesShares === 0 || noShares === 0) return;

  const imbalance = Math.abs(yesShares - noShares) / Math.max(yesShares, noShares);
  if (imbalance < 0.1) return; // tolerância de 10%

  const key = await resolvePolymarketKey(strategy.userId);
  if (!key) return;
  const credentials = resolveClobCredentials(key);

  const heavySide = yesShares > noShares ? 'YES' : 'NO';
  const heavyToken = heavySide === 'YES' ? strategy.tokenIdYes : strategy.tokenIdNo;
  const diff = Math.abs(yesShares - noShares);

  try {
    const book = await fetchBook(heavyToken);
    const bid = book.bids[0]?.[0] || 0;
    if (bid <= 0) return;

    const sellOrder = await signOrder({ credentials, tokenId: heavyToken, side: 'SELL', price: bid, size: diff });
    if (dryRun) {
      log.info(`[dry-run] Rebalance ${strategy.slug}: vender ${diff} ${heavySide} @ ${bid.toFixed(4)}`);
      await PredictionArbTrade.create({
        userId: strategy.userId,
        strategyId: strategy._id,
        slug: strategy.slug,
        type: 'rebalance',
        status: 'simulated',
        side: heavySide,
        amount: diff * bid,
        pnl: 0,
        reason: 'Rebalance de inventário (dry-run)',
      });
      return;
    }
    await placeOrder(credentials, sellOrder);
    log.info(`✅ Rebalance ${strategy.slug}: vendeu ${diff} ${heavySide}`);
  } catch (e: any) {
    log.warn(`⚠️ Rebalance ${strategy.slug} falhou: ${e.message}`);
  }
}

/** Coloca ordens maker nos dois lados de uma estratégia ainda sem posição. */
export async function placeMakerQuotes(strategy: any, opts: { dryRun?: boolean; feeRate?: number } = {}) {
  const dryRun = opts.dryRun ?? true;
  return runMarketMaking(strategy, { dryRun });
}

export { log };
