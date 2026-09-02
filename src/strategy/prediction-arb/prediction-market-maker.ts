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
import { resolveClobCredentials, placeOrder, cancelOrder, fetchBook, fetchPositions, signOrder, getOnchainBalance } from './helpers/clob-client';
import { placeOrderViaSdk, cancelOrderViaSdk, fetchPositionsViaSdk, fetchPositionsViaDataApi } from './helpers/secure-client';
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

/** Profundidade acumulada no bid em USD (price × size) até atingir `targetUsd`. */
async function bookBidDepthUsd(tokenId: string, targetUsd: number): Promise<number> {
  try {
    const book = await fetchBook(tokenId);
    let accUsd = 0;
    for (const [price, size] of book.bids) {
      if (price <= 0) continue;
      accUsd += price * size;
      if (accUsd >= targetUsd) break;
    }
    return accUsd;
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
  let sharesPerQuote = Math.max(1, Math.min(Math.floor(tradeSize), cap)); // ações por lado

  // 1. Inventário real (fonte da verdade) — via Data API da deposit wallet
  //    (a SDK listPositions retorna {} para a deposit wallet EIP-1271, então
  //    não enxerga as posições reais; sem isso o MM nunca detecta o par
  //    montado nem o desbalanceamento — causa do 15 vs 10).
  let positions: any[] = [];
  if (useSdk) {
    positions = await fetchPositionsViaDataApi(keyDoc).catch(() => []);
    if (positions.length === 0) {
      positions = await fetchPositionsViaSdk(keyDoc).catch(() => []);
    }
  } else {
    positions = await fetchPositions(credentials).catch(() => []);
  }
  // Data API retorna asset (não asset_id); normaliza para o formato esperado
  const yesPos = positions.find((p: any) =>
    String(p.asset || '') === strategy.tokenIdYes || String(p.asset_id || '') === strategy.tokenIdYes || String(p.token_id || '') === strategy.tokenIdYes || p.side === 'Up');
  const noPos = positions.find((p: any) =>
    String(p.asset || '') === strategy.tokenIdNo || String(p.asset_id || '') === strategy.tokenIdNo || String(p.token_id || '') === strategy.tokenIdNo || p.side === 'Down');
  const yesShares = Number(yesPos?.size || 0);
  const noShares = Number(noPos?.size || 0);
  const yesAvg = Number(yesPos?.avg_price || yesPos?.price || 0);
  const noAvg = Number(noPos?.avg_price || noPos?.price || 0);

  await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, {
    yesShares,
    noShares,
    ...(yesAvg > 0 ? { avgYesPrice: yesAvg } : {}),
    ...(noAvg > 0 ? { avgNoPrice: noAvg } : {}),
    positionSize: (yesShares + noShares) / 2,
  });

  // 2. Se ambos os lados têm inventário (e balanceado), o par está montado —
  //    registra a operação e segura até vencimento. Se desbalanceado (diferença
  //    > 10%), NÃO segura: cai para a lógica de completar/rebalancear abaixo.
  const imbalance = yesShares > 0 || noShares > 0
    ? Math.abs(yesShares - noShares) / Math.max(yesShares, noShares)
    : 0;
  const hasPair = yesShares >= 1 && noShares >= 1 && imbalance <= 0.1;
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

  // 2.5 Inventário desbalanceado: quando um lado tem MUITO mais que o outro
  //     (ex: YES=15, NO=10), o robô fica com risco direcional. Duas frentes:
  //     - Se o mercado está MUITO perto do vencimento (< 5min), VENDE o
  //       excesso do lado pesado para não carregar risco até o fim.
  //     - Senão, cotar SÓ o lado leve (completar o par) e nunca o lado
  //       pesado — assim o par converge para balanceado.
  //     NOTA: antes era < 30min — agressivo demais para mercados de 15min:
  //       vendia o lado recém-comprado antes do par completar (o caso do
  //       mercado 8:15, onde o DOWN comprado a 0.50 foi vendido a 0.44
  //       13s depois, realizando perda desnecessária).
  const oneSideOnly = (yesShares >= 1) !== (noShares >= 1);
  const desbalanceado = !oneSideOnly && imbalance > 0.1;
  const excesso = Math.abs(yesShares - noShares);
  if (oneSideOnly || desbalanceado) {
    const endMs = strategy.endDate ? new Date(strategy.endDate).getTime() : 0;
    const hoursToEnd = endMs > 0 ? (endMs - Date.now()) / 3600000 : Infinity;
    const exposedShares = Math.max(yesShares, noShares);
    const exposedSide = yesShares >= noShares ? 'YES' : 'NO';
    const exposedToken = yesShares >= noShares ? strategy.tokenIdYes : strategy.tokenIdNo;

    // Se falta < 5min para vencer e o par não está completo, reverte o excesso.
    if (hoursToEnd < 5 / 60) {
      log.warn(`⚠️ [${strategy.slug}] Inventário desbalanceado (${exposedSide} ${exposedShares}, diff ${excesso}) com vencimento em ${hoursToEnd.toFixed(2)}h. Vendendo excesso para não perder.`);
      try {
        // Vende o excesso no bid atual para reduzir o risco direcional
        const book = await bookPrices(exposedToken);
        if (book.bid > 0 && useSdk) {
          await placeOrderViaSdk(keyDoc, { tokenId: exposedToken, side: 'SELL', price: book.bid, size: excesso });
          log.info(`✅ [${strategy.slug}] Excesso ${exposedSide} vendido (${excesso} @ ${book.bid}).`);
        } else if (book.bid > 0) {
          const sell = await signOrder({ credentials, tokenId: exposedToken, side: 'SELL', price: book.bid, size: excesso });
          await placeOrder(credentials, sell);
          log.info(`✅ [${strategy.slug}] Excesso ${exposedSide} vendido (${excesso} @ ${book.bid}).`);
        }
      } catch (e: any) {
        log.warn(`⚠️ [${strategy.slug}] Falha ao vender excesso: ${e.message}`);
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

    // Ainda tem tempo: tenta completar o par (cotar o lado leve com prioridade)
    log.info(`🎯 [${strategy.slug}] Inventário desbalanceado (YES=${yesShares} NO=${noShares}). Tentando completar o par (foco no lado leve)...`);
  }

  // 3. Cap de inventário: se um lado já está no cap, NÃO acumula mais dele.
  //    MAS se está desbalanceado (um lado menor que o outro), permite completar
  //    pelo lado leve — o cap não pode travar o completar do par (era o que
  //    deixava 15 vs 10: o UP bateu o cap e o MM parou antes de comprar o DOWN).
  const capReached = yesShares >= cap || noShares >= cap;
  const desbalanceadoParaCompletar = (oneSideOnly || desbalanceado) && excesso > 0;
  if (capReached && !desbalanceadoParaCompletar) {
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

  // 4.0 Mercado quase-resolvido: se um lado já convergiu (bid < 0.10 ou >
  //     0.90), o "spread" de completude é ilusório — o lado barato não tem
  //     book nem liquidez para fill, e o lado caro arrisca perda na resolução.
  //     Não cotar: foi o que causou o par 25+25 comprado a 0.82/0.17.
  //     EXCEÇÃO: se já há posição (hedge parcial), COMPLETA a perna faltante
  //     mesmo em quase-resolvido — deixar sem hedge no vencimento é pior
  //     (risco direcional de perder tudo).
  const temPosicaoParcial = yesShares >= 1 || noShares >= 1;
  const bidMenor = Math.min(bYes.bid, bNo.bid);
  const bidMaior = Math.max(bYes.bid, bNo.bid);
  if ((bidMenor < 0.10 || bidMaior > 0.90) && !temPosicaoParcial) {
    log.warn(`⚠️ [${strategy.slug}] Mercado quase-resolvido (bidYes=${bYes.bid} bidNo=${bNo.bid}). Não cotando (risco direcional).`);
    return { quoted: false, orderIds: [] };
  }

  // 4.1 Profundidade: só cotar se AMBOS os lados têm book para o tamanho da
  //     ordem. Se um lado não tem profundidade, entrar resultaria em posição
  //     de lado único (risco direcional) — evita a perda vista antes.
  //     Além das shares, exige um mínimo em USD (liquidez real): mercados
  //     finos com bid ilusório (ex: 0.48 sem volume) não preenchem e travam
  //     o capital — foi o caso das 2 ordens a 0.48 que ficaram no book.
  const depthYes = await bookBidDepth(strategy.tokenIdYes, sharesPerQuote);
  const depthNo = await bookBidDepth(strategy.tokenIdNo, sharesPerQuote);
  if (depthYes < sharesPerQuote || depthNo < sharesPerQuote) {
    log.warn(`⚠️ [${strategy.slug}] Profundidade insuficiente: YES depth=${depthYes.toFixed(1)} NO depth=${depthNo.toFixed(1)} (precisa ${sharesPerQuote}). Não cotando.`);
    return { quoted: false, orderIds: [] };
  }
  const MIN_LIQUIDEZ_USD = 20; // liquidez mínima por lado (bid × size)
  const liqYes = await bookBidDepthUsd(strategy.tokenIdYes, MIN_LIQUIDEZ_USD);
  const liqNo = await bookBidDepthUsd(strategy.tokenIdNo, MIN_LIQUIDEZ_USD);
  if (liqYes < MIN_LIQUIDEZ_USD || liqNo < MIN_LIQUIDEZ_USD) {
    log.warn(`⚠️ [${strategy.slug}] Liquidez insuficiente no bid: YES $${liqYes.toFixed(2)} NO $${liqNo.toFixed(2)} (mín $${MIN_LIQUIDEZ_USD}). Não cotando.`);
    return { quoted: false, orderIds: [] };
  }

  // 5. Preço do par: soma < 1 para garantir lucro no vencimento.
  //    PRIORIDADE: entrada TAKER simultânea nos dois lados (preço = ask).
  //    Se askYes + askNo + margem < 1, as duas ordens são colocadas no ask via
  //    Promise.all — a Polymarket efetiva as duas no mesmo instante e o par
  //    nasce balanceado (sem fill parcial desigual como o 21 vs 10).
  //    Se não há folga no ask, NÃO cota (evita o maker GTC desbalanceado).
  const askSum = bYes.ask + bNo.ask;
  const TAKER_MARGEM = 0.002; // 0.2% de folga mínima sobre o ask
  const podeTaker = bYes.ask > 0 && bNo.ask > 0 && askSum + TAKER_MARGEM < 1;

  // Preço maker (bid) — usado como fallback quando o mercado está em modo
  // post-only (recém-aberto) e rejeita ordens taker no ask.
  const targetSpread = Math.max(Number(strategy.spreadPct || 0.5), 0.2);
  const baseEntry = makerEntryPrices(bYes.bid, bNo.bid, targetSpread);

  let yesPrice: number;
  let noPrice: number;
  let modoTaker = false;
  let attempt = Number(strategy.mmQuoteAttempt ?? 0);

  if (podeTaker && baseEntry) {
    // Entrada taker: preço = ask dos dois lados (efetiva junto)
    yesPrice = bYes.ask;
    noPrice = bNo.ask;
    modoTaker = true;
    attempt = 0; // taker não progride — efetiva direto
    log.info(`⚡ [${strategy.slug}] Entrada taker simultânea: YES ${yesPrice.toFixed(4)} + NO ${noPrice.toFixed(4)} (soma ${(yesPrice + noPrice).toFixed(4)})`);
  } else {
    // Sem folga no ask (ou sem baseEntry): cota maker no bid
    if (!baseEntry) {
      log.warn(`⚠️ [${strategy.slug}] Não foi possível montar par maker (bids ${bYes.bid}/${bNo.bid}).`);
      return { quoted: false, orderIds: [] };
    }
    yesPrice = progressiveQuotePrice(baseEntry.yes, bYes.ask || baseEntry.yes, step, attempt);
    noPrice = progressiveQuotePrice(baseEntry.no, bNo.ask || baseEntry.no, step, attempt);
    modoTaker = false;
  }
  const pairSum = yesPrice + noPrice;
  if (pairSum >= 1) {
    log.warn(`⚠️ [${strategy.slug}] Preços progrediram demais (soma ${pairSum.toFixed(4)} ≥ 1). Resetando cotação.`);
    await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, { mmQuoteAttempt: 0 });
    return { quoted: false, orderIds: [] };
  }

  // 6. Cancela ordens antigas ANTES de checar saldo/recotar (evita acúmulo de
  //     ordens parciais e libera o capital travado em ordens GTC que não
  //     preencheram — sem isso a checagem de saldo trava tudo).
  for (const oid of strategy.openOrderIds || []) {
    if (useSdk) await cancelOrderViaSdk(keyDoc, oid).catch(() => {});
    else await cancelOrder(credentials, oid).catch(() => {});
  }
  // Após cancelar, limpa o registro local (o passo 7 grava as novas)
  if ((strategy.openOrderIds || []).length > 0) {
    await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, { openOrderIds: [] });
    strategy.openOrderIds = [];
  }

  // 4.5 Saldo on-chain da deposit wallet: não cotar se o custo do par + ordens
  //     ativas exceder o saldo disponível. Sem isso, o MM empilha ordens
  //     maker que travam o capital (ex: $4.95 ativos de $5.38) e as novas
  //     ordens são rejeitadas pelo CLOB com "not enough balance".
  const saldoDisponivel = await getOnchainBalance(String(keyDoc?.depositWallet || '')).catch(() => 0);
  const custoOrdensAtivas = (strategy.openOrderIds || []).length * sharesPerQuote * pairSum;
  const custoPar = sharesPerQuote * pairSum;
  if (saldoDisponivel > 0 && custoOrdensAtivas + custoPar > saldoDisponivel) {
    log.warn(`⚠️ [${strategy.slug}] Saldo insuficiente (custo ${custoOrdensAtivas.toFixed(2)}+${custoPar.toFixed(2)} > disponível $${saldoDisponivel.toFixed(2)}). Não cotando.`);
    return { quoted: false, orderIds: [] };
  }

  // 5.0 Tamanho mínimo por ordem: a Polymarket exige no mínimo $1 por ordem
  //     (BUY marketable). Se price * shares < $1 num dos lados, a ordem é
  //     rejeitada. Se um lado está tão barato que exigiria inflar o tamanho
  //     além de 2x o tradeSize (ex: 5 -> 25 shares), NÃO cota — inflar o
  //     tamanho num lado barato foi o que causou o par 25+25 comprado caro.
  const MIN_ORDER_USD = 1;
  const valorYes = yesPrice * sharesPerQuote;
  const valorNo = noPrice * sharesPerQuote;
  if (valorYes < MIN_ORDER_USD || valorNo < MIN_ORDER_USD) {
    const minSharesYes = Math.ceil(MIN_ORDER_USD / yesPrice);
    const minSharesNo = Math.ceil(MIN_ORDER_USD / noPrice);
    const minShares = Math.max(minSharesYes, minSharesNo);
    const tradeSizeOriginal = Math.max(1, Math.min(Math.floor(Number(strategy.tradeSize ?? 100)), cap));
    if (minShares <= cap && minShares <= tradeSizeOriginal * 2) {
      log.warn(`⚠️ [${strategy.slug}] Ordem abaixo do mínimo $1 (YES $${valorYes.toFixed(2)} NO $${valorNo.toFixed(2)}). Ajustando para ${minShares} shares/lado.`);
      sharesPerQuote = minShares;
    } else {
      log.warn(`⚠️ [${strategy.slug}] Lado sub-mínimo exigiria inflar demais (${minShares}sh > 2x tradeSize ${tradeSizeOriginal}). Não cotando.`);
      return { quoted: false, orderIds: [] };
    }
  }

  if (dryRun) {
    log.info(`[dry-run] MM ${strategy.slug} (${modoTaker ? 'TAKER' : 'maker'}): YES ${sharesPerQuote} @ ${yesPrice.toFixed(4)} + NO ${sharesPerQuote} @ ${noPrice.toFixed(4)} (soma ${pairSum.toFixed(4)})`);
    await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, { mmQuoteAttempt: attempt + 1, openOrderIds: [] });
    return { quoted: true, orderIds: [] };
  }

  // 7. Coloca as ordens do par (via SDK quando possível — suporta deposit wallet)
  //    Se o inventário está desbalanceado, cota SÓ o lado leve com o tamanho
  //    EXATO da diferença (completa o par até balancear — nunca ultrapassa);
  //    senão cota os dois lados juntos (taker) ou o par maker.
  const orderIds: string[] = [];
  try {
    const ladoLeve = yesShares > noShares ? 'NO' : (noShares > yesShares ? 'YES' : null);
    // Tamanho para completar o par desbalanceado: diferença exata entre os lados
    const sharesCompletar = ladoLeve ? Math.abs(yesShares - noShares) : 0;
    const tamanhoLadoLeve = Math.max(1, Math.min(sharesCompletar, sharesPerQuote));
    if (useSdk) {
      const colocaLado = async (tokenId: string, price: number, lado: string, size: number): Promise<string | null> => {
        try {
          const id = await placeOrderViaSdk(keyDoc, { tokenId, side: 'BUY', price, size });
          return id;
        } catch (e: any) {
          // Modo post-only (mercado recém-aberto): o CLOB rejeita ordens taker
          // no ask. Recota no bid (maker), que é permitido em post-only.
          if (e?.code === 'post_only_mode' && modoTaker && baseEntry) {
            const precoMaker = lado === 'YES' ? baseEntry.yes : baseEntry.no;
            log.warn(`⚠️ [${strategy.slug}] Post-only: recotando ${lado} no bid (${precoMaker.toFixed(4)}) em vez de taker.`);
            try {
              const id2 = await placeOrderViaSdk(keyDoc, { tokenId, side: 'BUY', price: precoMaker, size });
              return id2;
            } catch (e2: any) {
              log.warn(`⚠️ [${strategy.slug}] Ordem ${lado} (SDK) falhou mesmo no maker: ${e2.message}`);
              return null;
            }
          }
          log.warn(`⚠️ [${strategy.slug}] Ordem ${lado} (SDK) falhou: ${e.message}`);
          return null;
        }
      };
      if (ladoLeve) {
        // Completar o hedge SÓ se a soma não ficar absurda: preço médio da
        // perna pesada + preço da perna leve deve ser < 1.1. Se o mercado se
        // moveu MUITO e a soma ficou >= 1.1, completar garante prejuízo grande.
        // Soma entre 1.0 e 1.1: completa mesmo com pequeno prejuízo — se a
        // perna não abriu no tempo adequado, fechar o hedge (perda máx ~10%)
        // é melhor que segurar lado único com risco direcional total (pode
        // perder tudo no vencimento).
        const precoMedioPesado = ladoLeve === 'NO' ? yesAvg : noAvg;
        const precoLeve = ladoLeve === 'YES' ? yesPrice : noPrice;
        if (precoMedioPesado > 0 && precoMedioPesado + precoLeve >= 1.1) {
          log.warn(`⚠️ [${strategy.slug}] Completar hedge sairia caro demais (perna pesada média ${precoMedioPesado.toFixed(4)} + ${ladoLeve} ${precoLeve.toFixed(4)} = ${(precoMedioPesado + precoLeve).toFixed(4)} ≥ 1.1). NÃO completando — segurando lado único.`);
          // Cancela ordens pendentes do outro lado (evita fill acidental com prejuízo)
          for (const oid of strategy.openOrderIds || []) {
            if (useSdk) await cancelOrderViaSdk(keyDoc, oid).catch(() => {});
            else await cancelOrder(credentials, oid).catch(() => {});
          }
          return { quoted: false, orderIds: [] };
        }
        log.info(`🎯 [${strategy.slug}] Completando par: comprar ${tamanhoLadoLeve} ${ladoLeve} (diferença ${sharesCompletar}).`);
        const id = await colocaLado(
          ladoLeve === 'YES' ? strategy.tokenIdYes : strategy.tokenIdNo,
          ladoLeve === 'YES' ? yesPrice : noPrice,
          ladoLeve,
          tamanhoLadoLeve,
        );
        if (id) orderIds.push(id);
      } else {
        const [yesId, noId] = await Promise.all([
          colocaLado(strategy.tokenIdYes, yesPrice, 'YES', sharesPerQuote),
          colocaLado(strategy.tokenIdNo, noPrice, 'NO', sharesPerQuote),
        ]);
        if (yesId) orderIds.push(yesId);
        if (noId) orderIds.push(noId);
      }
    } else {
      if (ladoLeve) {
        const tokenId = ladoLeve === 'YES' ? strategy.tokenIdYes : strategy.tokenIdNo;
        const price = ladoLeve === 'YES' ? yesPrice : noPrice;
        const ordem = await signOrder({ credentials, tokenId, side: 'BUY', price, size: tamanhoLadoLeve });
        const id = await placeOrder(credentials, ordem).catch((e: any) => {
          log.warn(`⚠️ [${strategy.slug}] Ordem ${ladoLeve} falhou: ${e.message}`);
          return null;
        });
        if (id) orderIds.push(id);
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
    }

    await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, {
      openOrderIds: orderIds,
      mmQuoteAttempt: orderIds.length === 2 ? attempt + 1 : 0, // só progride se ambas as ordens foram aceitas
      mmActive: true,
    });

    if (orderIds.length > 0) {
      log.info(`📣 [${strategy.slug}] Cotações (${modoTaker ? 'TAKER' : 'maker'}): YES ${sharesPerQuote} @ ${yesPrice.toFixed(4)} + NO ${sharesPerQuote} @ ${noPrice.toFixed(4)} (soma ${pairSum.toFixed(4)})`);
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
      reason: modoTaker ? 'Entrada taker simultânea (par balanceado)' : `MM maker tentativa ${attempt + 1}`,
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

  // Só rebalanceia (vende excesso) nos últimos 5min. Antes disso, o MM
  // completa o par pelo lado leve — vender cedo realizava perda desnecessária
  // (o caso do mercado 8:15: DOWN comprado a 0.50 vendido a 0.44 em 13s).
  const endMs = strategy.endDate ? new Date(strategy.endDate).getTime() : 0;
  const hoursToEnd = endMs > 0 ? (endMs - Date.now()) / 3600000 : Infinity;
  if (hoursToEnd >= 5 / 60) return;

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
