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
import { makerEntryPrices, fetchSpotPrice, fetchSpotAtrInfo } from './helpers/pricing';
import { PREDICTION_ARB_CONFIG } from '../../config/prediction-arb';

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

/** Profundidade acumulada no ASK em USD (price × size) — contraparte p/ compra taker. */
async function bookAskDepthUsd(tokenId: string, targetUsd: number): Promise<number> {
  try {
    const book = await fetchBook(tokenId);
    let accUsd = 0;
    for (const [price, size] of book.asks) {
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
 * attempt 0 = bid puro; a cada tentativa sobe um step.
 * Se não há ask de referência (book de um lado só), AVANÇA mesmo assim por
 * step — antes travava no bid fixo e a ordem maker nunca progredia nem casava
 * (caso real da DOGE que cotou YES@0.50 por ciclos sem fill). O teto seguro
 * é aplicado pelo chamador (soma do par < 1 / regra do hedge ≤ 1.1).
 */
export function progressiveQuotePrice(bid: number, ask: number, step: number, attempt: number): number {
  if (bid <= 0) return 0;
  if (ask > 0) return Math.min(ask, bid + step * attempt);
  return bid + step * attempt;
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

  const cap = Number(strategy.maxInventoryPairs ?? PREDICTION_ARB_CONFIG.risk.maxInventoryPairs);
  const step = Number(strategy.quoteStep ?? PREDICTION_ARB_CONFIG.marketMaking.quoteStep);
  const tradeSize = Number(strategy.tradeSize ?? PREDICTION_ARB_CONFIG.scan.tradeSize);
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

  // ── HARD CAP DE EXPOSIÇÃO POR MERCADO (Corr. bola de neve) ──────────────
  // Teto por lado = o aporte alvo (sharesPerQuote) com pequena folga p/
  // aceitar fill parcial (exposureCapMultiplier×). Acima disso o robô NUNCA compra mais nada
  // neste mercado — só cancela ordens e segura até o vencimento. Isso impede
  // o caso SOL 5→10→15 (a defasagem da Data API fazia o MM "completar hedge"
  // comprando em cima de posição que já tinha preenchido).
  // Obs: par MONTADO balanceado é tratado pelo bloco `hasPair` abaixo (segura
  // e registra); par montado desbalanceado cai no fluxo de rebalance (vende o
  // excesso perto do vencimento). Este guard só captura exposição acima do teto.
  const tetoLado = Math.ceil(sharesPerQuote * PREDICTION_ARB_CONFIG.risk.exposureCapMultiplier);
  const estourouCapExposicao = yesShares > tetoLado || noShares > tetoLado;
  if (estourouCapExposicao) {
    log.warn(`🧯 [${strategy.slug}] Exposição estourou o teto (${yesShares}/${noShares} > ${tetoLado}/lado). Cancelando ordens e segurando — NÃO compra mais neste mercado.`);
    for (const oid of strategy.openOrderIds || []) {
      if (useSdk) await cancelOrderViaSdk(keyDoc, oid).catch(() => {});
      else await cancelOrder(credentials, oid).catch(() => {});
    }
    await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, {
      openOrderIds: [],
      positionOpen: yesShares >= 1 || noShares >= 1,
      positionSize: (yesShares + noShares) / 2,
      yesShares,
      noShares,
      ...(yesAvg > 0 ? { avgYesPrice: yesAvg } : {}),
      ...(noAvg > 0 ? { avgNoPrice: noAvg } : {}),
    });
    return { quoted: false, orderIds: [] };
  }

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
      try {
        if (useSdk) await cancelOrderViaSdk(keyDoc, oid);
        else await cancelOrder(credentials, oid);
      } catch (e: any) {
        log.warn(`⚠️ falha ao cancelar ordem ${oid}: ${e.message}`);
      }
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

  // 3. Cap de inventário: se um lado já está no cap, NÃO acumula mais dele.
  //    MAS se está desbalanceado (um lado menor que o outro), permite completar
  //    pelo lado leve — o cap não pode travar o completar do par (era o que
  //    deixava 15 vs 10: o UP bateu o cap e o MM parou antes de comprar o DOWN).
  const oneSideOnly = (yesShares >= 1) !== (noShares >= 1);
  const excesso = Math.abs(yesShares - noShares);
  const desbalanceado = !oneSideOnly && excesso > 0;
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

  const MIN_LIQUIDEZ_USD = PREDICTION_ARB_CONFIG.marketMaking.minLiquidityUsd;
  const temLadoLeveProf = yesShares !== noShares;
  const ladoLeveProf = temLadoLeveProf ? (yesShares > noShares ? 'NO' : 'YES') : null;

  const checaProfundidade = async (lado: 'YES' | 'NO' | null): Promise<boolean> => {
    const tokens = lado ? [lado === 'YES' ? strategy.tokenIdYes : strategy.tokenIdNo] : [strategy.tokenIdYes, strategy.tokenIdNo];
    for (const tok of tokens) {
      const liqBid = await bookBidDepthUsd(tok, MIN_LIQUIDEZ_USD);
      const liqAsk = await bookAskDepthUsd(tok, MIN_LIQUIDEZ_USD);
      const liqMax = Math.max(liqBid, liqAsk);
      if (liqMax < MIN_LIQUIDEZ_USD) {
        log.warn(`⚠️ [${strategy.slug}] Liquidez insuficiente (bid $${liqBid.toFixed(2)} / ask $${liqAsk.toFixed(2)}, mín $${MIN_LIQUIDEZ_USD}). Não cotando.`);
        return false;
      }
    }
    return true;
  };
  if (temLadoLeveProf) {
    if (!(await checaProfundidade(ladoLeveProf))) return { quoted: false, orderIds: [] };
  } else if (!(await checaProfundidade(null))) {
    return { quoted: false, orderIds: [] };
  }

  const askSum = bYes.ask + bNo.ask;
  const TAKER_MARGEM = PREDICTION_ARB_CONFIG.marketMaking.takerMargin;
  const podeTaker = bYes.ask > 0 && bNo.ask > 0 && askSum + TAKER_MARGEM < 1;

  const targetSpread = Math.max(Number(strategy.spreadPct || 0.5), 0.2);
  const baseEntry = makerEntryPrices(bYes.bid, bNo.bid, targetSpread);

  let yesPrice: number;
  let noPrice: number;
  let modoTaker = false;
  let attempt = Number(strategy.mmQuoteAttempt ?? 0);

  const highCertaintySide = strategy.highCertaintySide || (bYes.bid >= bNo.bid ? 'YES' : 'NO');
  const certaintyProb = Number(strategy.certaintyProb || (highCertaintySide === 'YES' ? bYes.bid : bNo.bid));
  const minProb = Number(strategy.minHighCertaintyProb ?? PREDICTION_ARB_CONFIG.scan.minHighCertaintyProb ?? 0.97);

  const temLadoLeve = yesShares !== noShares;
  if (yesShares > 0 || noShares > 0) {
    const sideAberto = yesShares > 0 ? 'YES' : 'NO';
    const sharesAbertas = Math.max(yesShares, noShares);
    const tokenAberto = sideAberto === 'YES' ? strategy.tokenIdYes : strategy.tokenIdNo;
    const bAtual = sideAberto === 'YES' ? bYes : bNo;

    // ── REFINAMENTO 1: STOP LIMIT DE EMERGÊNCIA COM SLIPPAGE MÁXIMO ─────────
    // Se a cotação no livro despencar abaixo de 0.75 (75%), aciona Venda Limitada
    // aceitando slippage máximo até $0.65. Tenta por 2s no CLOB. Se não preencher,
    // retém a posição (probabilidade de reversão ao strike é superior a aceitar vender a $0.05).
    const STOP_OUT_THRESHOLD = 0.75;
    const MIN_STOP_LIMIT_PRICE = 0.65;

    if (bAtual.bid > 0 && bAtual.bid < STOP_OUT_THRESHOLD) {
      log.warn(`🚨 [${strategy.slug}] EMERGENCY STOP OUT ATIVADO: Cotação de ${sideAberto} despencou para ${bAtual.bid.toFixed(4)} (< ${STOP_OUT_THRESHOLD}).`);
      
      const stopPrice = Math.max(MIN_STOP_LIMIT_PRICE, bAtual.bid);
      log.info(`🎯 [${strategy.slug}] Enviando Stop Limit: Venda de ${sharesAbertas} ${sideAberto} @ min $${stopPrice.toFixed(4)} (slippage controlado).`);

      try {
        let stopOrderId: string | null = null;
        if (useSdk) {
          stopOrderId = await placeOrderViaSdk(keyDoc, { tokenId: tokenAberto, side: 'SELL', price: stopPrice, size: sharesAbertas });
        } else {
          const sellOrd = await signOrder({ credentials, tokenId: tokenAberto, side: 'SELL', price: stopPrice, size: sharesAbertas });
          stopOrderId = await placeOrder(credentials, sellOrd);
        }

        // Aguarda 2 segundos para checar se a ordem preencheu
        await new Promise(r => setTimeout(r, 2000));

        // Reconcilia saldo restante de posições
        let posPosStop: any[] = [];
        if (useSdk) posPosStop = await fetchPositionsViaDataApi(keyDoc).catch(() => []);
        else posPosStop = await fetchPositions(credentials).catch(() => []);
        
        const posPos = posPosStop.find((p: any) => String(p.asset || p.asset_id || p.token_id || '') === tokenAberto);
        const sharesRestantes = Number(posPos?.size || 0);

        if (sharesRestantes <= 0) {
          log.info(`✅ [${strategy.slug}] Stop Limit Executado com Sucesso! Posição encerrada sem dump a preço vil.`);
          await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, {
            positionOpen: false, yesShares: 0, noShares: 0, positionSize: 0, active: false, mmActive: false,
          });
        } else {
          log.warn(`⚠️ [${strategy.slug}] Stop Limit não preencheu em 2s (restam ${sharesRestantes} cotas). Cancelando ordem e MANTENDO posição p/ reversão.`);
          if (stopOrderId) {
            if (useSdk) await cancelOrderViaSdk(keyDoc, stopOrderId).catch(() => {});
            else await cancelOrder(credentials, stopOrderId).catch(() => {});
          }
        }
      } catch (e: any) {
        log.warn(`⚠️ [${strategy.slug}] Falha ao processar Stop Limit: ${e.message}`);
      }
      return { quoted: false, orderIds: [] };
    }

    log.info(`📌 [${strategy.slug}] Posição direcional aberta (${yesShares} YES / ${noShares} NO @ ${bAtual.bid.toFixed(3)}). Não faz hedge. Aguardando vencimento.`);
    return { quoted: false, orderIds: [] };
  }

  // ── AJUSTE 4: CIRCUIT BREAKER (TILT GUARD DE PERDAS CONSECUTIVAS) ──────────
  const cooldownMs = 30 * 60 * 1000; // 30 minutos de pausa
  const lastLoss = strategy.lastLossAt ? new Date(strategy.lastLossAt).getTime() : 0;
  if (lastLoss > 0 && (Date.now() - lastLoss) < cooldownMs) {
    const minsRestantes = Math.ceil((cooldownMs - (Date.now() - lastLoss)) / 60000);
    log.info(`🛑 [${strategy.slug}] CIRCUIT BREAKER ATIVO: Pausa pós-loss em vigor (faltam ${minsRestantes}m). Não opera neste mercado.`);
    return { quoted: false, orderIds: [] };
  }

  // ── AJUSTE 1: PREÇO DE ENTRADA SEMÂNTICO (ASK >= 0.97 E ASK <= 0.99) ─────────
  const targetAskProb = highCertaintySide === 'YES' ? bYes.ask : bNo.ask;
  const targetBidProb = highCertaintySide === 'YES' ? bYes.bid : bNo.bid;
  // O preço do Ask de entrada precisa refletir probabilidade entre 97% ($0.97) e 99% ($0.99)
  const currentProb = targetAskProb > 0 ? targetAskProb : targetBidProb;

  if (currentProb < minProb || currentProb > 0.99) {
    log.info(`👀 [${strategy.slug}] RADAR ATIVO (${highCertaintySide} Ask=${targetAskProb.toFixed(3)} / Bid=${targetBidProb.toFixed(3)} prob=${(currentProb * 100).toFixed(1)}% fora do intervalo 97%-99%). Observando.`);
    return { quoted: false, orderIds: [] };
  }

  // ── AJUSTE 2: CORTE FINAL DE ENTRADA (BLACKOUT HARD CUTOFF - 8 SEGUNDOS) ────
  const endMs = strategy.endDate ? new Date(strategy.endDate).getTime() : 0;
  const segsRestantes = endMs > 0 ? (endMs - Date.now()) / 1000 : Infinity;
  
  const HARD_CUTOFF_SEGS = 8;
  if (segsRestantes <= HARD_CUTOFF_SEGS) {
    log.warn(`🛑 [${strategy.slug}] CORTE FINAL DE BLACKOUT: Faltam apenas ${segsRestantes.toFixed(1)}s (<= ${HARD_CUTOFF_SEGS}s). CLOB entrando em freeze/halt. Novas ordens bloqueadas.`);
    return { quoted: false, orderIds: [] };
  }

  const slugLower = String(strategy.slug || '').toLowerCase();
  const is15m = slugLower.includes('-15m-');
  const isAltcoin = /^(sol|doge|xrp)/i.test(slugLower);

  const maxSegsEntrada = isAltcoin
    ? (is15m ? 120 : 45)
    : (is15m ? 300 : 120);

  if (segsRestantes > maxSegsEntrada) {
    log.info(`⏳ [${strategy.slug}] RADAR DE TEMPO (${highCertaintySide} prob=${(currentProb * 100).toFixed(1)}%): Faltam ${segsRestantes.toFixed(0)}s (> ${maxSegsEntrada}s em ${isAltcoin ? 'Altcoin' : 'Major'} ${is15m ? '15m' : '5m'}). Aguardando janela final de ${maxSegsEntrada}s para disparar.`);
    return { quoted: false, orderIds: [] };
  }

  // ── REFINAMENTO 2: ATR DINÂMICO NO SPOT DISTANCE GUARD ────────────────────
  const coinMatch = slugLower.match(/^(btc|eth|sol|doge|xrp)/i);
  if (coinMatch) {
    const symbol = coinMatch[1].toUpperCase();
    const { spotPrice, atrPct } = await fetchSpotAtrInfo(symbol);
    const strikeEstimate = Number(strategy.strikePrice || strategy.openSpotPrice || 0);

    // Piso Fixo: Altcoins = 0.15%, Majors = 0.08%.
    // Exigência Dinâmica: Math.max(piso, 0.5 × ATR(1m))
    const pisoPct = isAltcoin ? 0.15 : 0.08;
    const atrDinamicoPct = atrPct > 0 ? 0.5 * atrPct : 0;
    const minDistPctRequired = Math.max(pisoPct, atrDinamicoPct);

    if (spotPrice > 0 && strikeEstimate > 0) {
      const distPct = (Math.abs(spotPrice - strikeEstimate) / strikeEstimate) * 100;
      if (distPct < minDistPctRequired) {
        log.warn(`⚠️ [${strategy.slug}] BLOQUEIO DE PONTO DE CORTE (ATR Dinâmico): Preço spot ${symbol} ($${spotPrice}) colado no strike ($${strikeEstimate}) - Distância ${distPct.toFixed(3)}% < Exigido ${minDistPctRequired.toFixed(3)}% (Piso ${pisoPct}% / ATR 1m: ${atrPct.toFixed(3)}%). Trade descartado.`);
        return { quoted: false, orderIds: [] };
      }
    }
  }

  // ── REFINAMENTO 3: SONDAGEM DE PROFUNDIDADE NO BID PARA ABSORÇÃO ──────────
  // Antes de entrar, valida se o lado oposto (Bid de saída) possui profundidade suficiente
  // para absorver a posição caso seja necessário acionar o Stop Limit a $0.75.
  const targetTokenId = highCertaintySide === 'YES' ? strategy.tokenIdYes : strategy.tokenIdNo;
  const valorPosicaoUsd = sharesPerQuote * 0.75;
  const profundidadeBidUsd = await bookBidDepthUsd(targetTokenId, valorPosicaoUsd);
  if (profundidadeBidUsd < valorPosicaoUsd) {
    log.warn(`⚠️ [${strategy.slug}] SONDAGEM DE PROFUNDIDADE FALHOU: Bid oposto tem apenas $${profundidadeBidUsd.toFixed(2)} de liquidez (exigido mín $${valorPosicaoUsd.toFixed(2)} para absorver eventual Stop a 0.75). Entrada abortada.`);
    return { quoted: false, orderIds: [] };
  }

  const isYes = highCertaintySide === 'YES';
  const targetBid = isYes ? bYes.bid : bNo.bid;
  const targetAsk = isYes ? bYes.ask : bNo.ask;
  yesPrice = isYes ? (targetAsk > 0 ? targetAsk : targetBid) : 0;
  noPrice = !isYes ? (targetAsk > 0 ? targetAsk : targetBid) : 0;
  modoTaker = targetAsk > 0;
  const pairSum = yesPrice + noPrice;
  if (pairSum >= 1 && !temLadoLeve && !highCertaintySide) {
    log.warn(`⚠️ [${strategy.slug}] Preços progrediram demais (soma ${pairSum.toFixed(4)} ≥ 1). Resetando cotação.`);
    await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, { mmQuoteAttempt: 0 });
    return { quoted: false, orderIds: [] };
  }
  // 6. Cancela ordens antigas ANTES de checar saldo/recotar (evita acúmulo de
  //     ordens parciais e libera o capital travado em ordens GTC que não
  //     preencheram — sem isso a checagem de saldo trava tudo).
  for (const oid of strategy.openOrderIds || []) {
    try {
      if (useSdk) await cancelOrderViaSdk(keyDoc, oid);
      else await cancelOrder(credentials, oid);
    } catch (e: any) {
      log.warn(`⚠️ falha ao cancelar ordem ${oid}: ${e.message}`);
    }
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
  // Custo REAL da rodada: no modo lado leve (completar hedge) só a perna leve
  // é comprada (tamanho = diferença exata); senão, o par inteiro.
  const ladoLeveCalc = yesShares > noShares ? 'NO' : (noShares > yesShares ? 'YES' : null);
  const sharesCompletarCalc = ladoLeveCalc ? Math.abs(yesShares - noShares) : 0;
  const tamanhoRealCalc = ladoLeveCalc
    ? Math.max(1, Math.min(sharesCompletarCalc, sharesPerQuote))
    : sharesPerQuote;
  const custoPernaLeve = ladoLeveCalc
    ? tamanhoRealCalc * (ladoLeveCalc === 'YES' ? yesPrice : noPrice)
    : 0;
  const custoOrdensAtivas = (strategy.openOrderIds || []).length * sharesPerQuote * pairSum;
  const custoPar = ladoLeveCalc ? custoPernaLeve : sharesPerQuote * pairSum;
  if (saldoDisponivel > 0 && custoOrdensAtivas + custoPar > saldoDisponivel) {

    log.warn(`⚠️ [${strategy.slug}] Saldo insuficiente (custo ${custoOrdensAtivas.toFixed(2)}+${custoPar.toFixed(2)} > disponível $${saldoDisponivel.toFixed(2)}). Não cotando.`);
    return { quoted: false, orderIds: [] };
  }

  // 5.0 Tamanho mínimo por ordem: a Polymarket exige no mínimo $1 por ordem
  //     (BUY marketable). Se price * shares < $1 num dos lados, a ordem é
  //     rejeitada. Se um lado está tão barato que exigiria inflar o tamanho
  //     além de maxOrderInflationMultiplier x o tradeSize (ex: 5 -> 25 shares), NÃO cota — inflar o
  //     tamanho num lado barato foi o que causou o par 25+25 comprado caro.
  const MIN_ORDER_USD = PREDICTION_ARB_CONFIG.risk.minOrderUsd;
  const valorYes = yesPrice * sharesPerQuote;
  const valorNo = noPrice * sharesPerQuote;
  // No modo lado leve só o lado leve é comprado — a checagem de mínimo aplica
  // só nele (o lado pesado já está no inventário, não será comprado de novo).
  const verificarMinimo = (valor: number, preco: number): boolean => {
    if (valor >= MIN_ORDER_USD) return true;
    const minShares = Math.ceil(MIN_ORDER_USD / preco);
    const tradeSizeOriginal = Math.max(1, Math.min(Math.floor(Number(strategy.tradeSize ?? PREDICTION_ARB_CONFIG.scan.tradeSize)), cap));
    if (minShares <= cap && minShares <= tradeSizeOriginal * PREDICTION_ARB_CONFIG.risk.maxOrderInflationMultiplier) {
      log.warn(`⚠️ [${strategy.slug}] Ordem abaixo do mínimo $1 (valor $${valor.toFixed(2)}). Ajustando para ${minShares} shares.`);
      sharesPerQuote = minShares;
      return true;
    }
    log.warn(`⚠️ [${strategy.slug}] Lado sub-mínimo exigiria inflar demais (${minShares}sh > 2x tradeSize ${tradeSizeOriginal}). Não cotando.`);
    return false;
  };
  if (highCertaintySide && !ladoLeveCalc) {
    const isYes = highCertaintySide === 'YES';
    const val = isYes ? valorYes : valorNo;
    const prc = isYes ? yesPrice : noPrice;
    if (!verificarMinimo(val, prc)) return { quoted: false, orderIds: [] };
  } else if (ladoLeveCalc) {
    const valorLeve = ladoLeveCalc === 'YES' ? valorYes : valorNo;
    const precoLeve = ladoLeveCalc === 'YES' ? yesPrice : noPrice;
    if (!verificarMinimo(valorLeve, precoLeve)) return { quoted: false, orderIds: [] };
  } else if (!verificarMinimo(valorYes, yesPrice) || !verificarMinimo(valorNo, noPrice)) {
    return { quoted: false, orderIds: [] };
  }

  if (dryRun) {
    log.info(`[dry-run] MM ${strategy.slug} (${modoTaker ? 'TAKER' : 'maker'}): YES ${sharesPerQuote} @ ${yesPrice.toFixed(4)} + NO ${sharesPerQuote} @ ${noPrice.toFixed(4)} (soma ${pairSum.toFixed(4)})`);
    await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, { mmQuoteAttempt: attempt + 1, openOrderIds: [] });
    return { quoted: true, orderIds: [] };
  }

  // 7. Coloca as ordens do par (via SDK quando possível — suporta deposit wallet)
  //    Se o inventário está desbalanceado, cota SÓ o lado leve com o tamanho
  //    EXACT da diferença; se for alta certeza, cota SÓ o lado de alta certeza;
  //    senão cota os dois lados juntos.
  const orderIds: string[] = [];
  try {
    // Usa o lado leve já calculated na checagem de saldo
    const ladoLeve = ladoLeveCalc;
    const sharesCompletar = ladoLeve ? sharesCompletarCalc : 0;
    const tamanhoLadoLeve = ladoLeve ? tamanhoRealCalc : sharesPerQuote;
    if (useSdk) {
      const colocaLado = async (tokenId: string, price: number, lado: string, size: number): Promise<string | null> => {
        try {
          const id = await placeOrderViaSdk(keyDoc, { tokenId, side: 'BUY', price, size });
          return id;
        } catch (e: any) {
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
      const isYes = highCertaintySide === 'YES';
      const tok = isYes ? strategy.tokenIdYes : strategy.tokenIdNo;
      const prc = isYes ? yesPrice : noPrice;
      log.info(`🚀 [${strategy.slug}] Enviando Ordem Direcional (${highCertaintySide}): ${tamanhoLadoLeve} sh @ ${prc.toFixed(4)}`);
      const id = await colocaLado(tok, prc, highCertaintySide, tamanhoLadoLeve);
      if (id) orderIds.push(id);
    } else {
      const isYes = highCertaintySide === 'YES';
      const tok = isYes ? strategy.tokenIdYes : strategy.tokenIdNo;
      const prc = isYes ? yesPrice : noPrice;
      const ordem = await signOrder({ credentials, tokenId: tok, side: 'BUY', price: prc, size: tamanhoLadoLeve });
      const id = await placeOrder(credentials, ordem).catch((e: any) => {
        log.warn(`⚠️ [${strategy.slug}] Ordem Direcional falhou: ${e.message}`);
        return null;
      });
      if (id) orderIds.push(id);
    }

    // Corr. 3: PROGRIDE o preço a cada ciclo enquanto a ordem não casar —
    // antes resetava para 0 quando uma das pernas falhava/ficava no book,
    // então a cotação nunca avançava (YES@0.50 preso para sempre). Agora o
    // attempt sobe sempre que a ordem foi aceita no CLOB (mesmo sem fill); o
    // preço avança um step por ciclo até casar ou estourar a trava de soma.
    const proximoAttempt = orderIds.length > 0 ? attempt + 1 : attempt;
    const enviouHedge = Boolean(ladoLeve) && orderIds.length > 0;

    // ── TRATAMENTO DE PREENCHIMENTO PARCIAL (PARTIAL FILL RECONCILIATION) ────
    // Aguarda 500ms para a ordens taker (com expiração de 5s) liquidarem e reconcilia
    // o inventário real on-chain/Data API para registrar exatamente o filled_size.
    if (orderIds.length > 0) {
      await new Promise(r => setTimeout(r, 500));
      let freshPositions: any[] = [];
      if (useSdk) {
        freshPositions = await fetchPositionsViaDataApi(keyDoc).catch(() => []);
        if (freshPositions.length === 0) freshPositions = await fetchPositionsViaSdk(keyDoc).catch(() => []);
      } else {
        freshPositions = await fetchPositions(credentials).catch(() => []);
      }
      const freshYes = Number(freshPositions.find((p: any) => String(p.asset || p.asset_id || p.token_id || '') === strategy.tokenIdYes || p.side === 'Up')?.size || 0);
      const freshNo = Number(freshPositions.find((p: any) => String(p.asset || p.asset_id || p.token_id || '') === strategy.tokenIdNo || p.side === 'Down')?.size || 0);

      const filledSize = Math.max(freshYes, freshNo);
      log.info(`📊 [${strategy.slug}] Posição real pós-ordem (Filled Size registrado): YES=${freshYes} NO=${freshNo} (Solicitado: ${tamanhoLadoLeve})`);

      await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, {
        openOrderIds: orderIds,
        mmQuoteAttempt: proximoAttempt,
        mmActive: true,
        yesShares: freshYes,
        noShares: freshNo,
        positionSize: filledSize,
        positionOpen: freshYes >= 1 || freshNo >= 1,
        ...(enviouHedge ? { ultimoHedgeAt: new Date() } : {}),
      });
    } else {
      await (PredictionArbStrategy as any).findByIdAndUpdate(strategy._id, {
        openOrderIds: orderIds,
        mmQuoteAttempt: proximoAttempt,
        mmActive: true,
        ...(enviouHedge ? { ultimoHedgeAt: new Date() } : {}),
      });
    }

    if (orderIds.length > 0) {
      log.info(`📣 [${strategy.slug}] Cotações (${modoTaker ? 'TAKER' : 'maker'}): YES ${sharesPerQuote} @ ${yesPrice.toFixed(4)} + NO ${sharesPerQuote} @ ${noPrice.toFixed(4)} (soma ${pairSum.toFixed(4)}) | attempt=${proximoAttempt}`);
    }

    // Registra a cotação como trade (tipo mm_quote) para observabilidade.
    // O schema foi corrigido para aceitar type=mm_quote e status=open; o log
    // de erro substitui o catch mudo (antes o enum inválido falhava invisível).
    await PredictionArbTrade.create({
      userId: strategy.userId,
      strategyId: strategy._id,
      slug: strategy.slug,
      question: strategy.question,
      type: 'mm_quote',
      status: 'open',
      yesPrice,
      noPrice,
      amount: ladoLeve ? tamanhoLadoLeve * (ladoLeve === 'YES' ? yesPrice : noPrice) : sharesPerQuote * pairSum,
      yesShares: ladoLeve === 'YES' ? tamanhoLadoLeve : (ladoLeve ? 0 : sharesPerQuote),
      noShares: ladoLeve === 'NO' ? tamanhoLadoLeve : (ladoLeve ? 0 : sharesPerQuote),
      orderIds,
      reason: ladoLeve
        ? `MM completando hedge: ${tamanhoLadoLeve} ${ladoLeve} (attempt ${proximoAttempt})`
        : (modoTaker ? 'Entrada taker simultânea (par balanceado)' : `MM maker tentativa ${proximoAttempt}`),
    }).catch((e: any) => log.warn(`⚠️ [${strategy.slug}] Falha ao registrar mm_quote: ${e.message}`));
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

  // Só rebalanceia (vende excesso) nos últimos rebalanceWindowMinutes. Antes disso, o MM
  // completa o par pelo lado leve — vender cedo realizava perda desnecessária
  // (o caso do mercado 8:15: DOWN comprado a 0.50 vendido a 0.44 em 13s).
  const endMs = strategy.endDate ? new Date(strategy.endDate).getTime() : 0;
  const hoursToEnd = endMs > 0 ? (endMs - Date.now()) / 3600000 : Infinity;
  if (hoursToEnd >= PREDICTION_ARB_CONFIG.marketMaking.rebalanceWindowMinutes / 60) return;

  const key = await resolvePolymarketKey(strategy.userId);
  if (!key) return;
  // ExchangeKey completa (com relayerApiKey) — a SDK opera com a deposit
  // wallet (EIP-1271). O caminho antigo (signOrder+placeOrder do CLOB direto)
  // usava a EOA e falhava com "order owner has to be the owner of the API KEY".
  const keyDoc = await ExchangeKey.findById(key._id).lean().catch(() => key);
  const credentials = resolveClobCredentials(keyDoc);
  const useSdk = Boolean(String(keyDoc?.relayerApiKey || process.env.POLYMARKET_RELAYER_KEY || '').trim());

  const heavySide = yesShares > noShares ? 'YES' : 'NO';
  const heavyToken = heavySide === 'YES' ? strategy.tokenIdYes : strategy.tokenIdNo;
  const diff = Math.abs(yesShares - noShares);

  try {
    const book = await fetchBook(heavyToken);
    const bid = book.bids[0]?.[0] || 0;
    if (bid <= 0) return;

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
    if (useSdk) {
      await placeOrderViaSdk(keyDoc, { tokenId: heavyToken, side: 'SELL', price: bid, size: diff });
      log.info(`✅ Rebalance ${strategy.slug}: vendeu ${diff} ${heavySide} via SDK`);
    } else {
      const sellOrder = await signOrder({ credentials, tokenId: heavyToken, side: 'SELL', price: bid, size: diff });
      await placeOrder(credentials, sellOrder);
      log.info(`✅ Rebalance ${strategy.slug}: vendeu ${diff} ${heavySide}`);
    }
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
