// Encerramento de pares: vende ambos os lados no CLOB ou resolve no vencimento.
// Reconciliado com posições reais (fonte da verdade = CLOB).
import PredictionArbStrategy from '../../models/PredictionArbStrategy';
import PredictionArbTrade from '../../models/PredictionArbTrade';
import ExchangeKey from '../../models/ExchangeKey';
import { resolvePolymarketKey } from './prediction-scanner';
import { resolveClobCredentials, placeOrder, cancelOrder, fetchBook, fetchPositions, signOrder } from './helpers/clob-client';
import { placeOrderViaSdk, cancelOrderViaSdk, fetchPositionsViaSdk } from './helpers/secure-client';
import { pairExitPnl, estimateFee, TAKER_FEE_RATE } from './helpers/pricing';
import { PREDICTION_ARB_CONFIG } from '../../config/prediction-arb';

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${msg}`, ...args),
};

export async function closeStrategy(strategyId: string, opts: { dryRun?: boolean; reason?: string } = {}) {
  const dryRun = opts.dryRun ?? true;
  const reason = opts.reason || 'Comando Manual';

  const strat: any = await (PredictionArbStrategy as any).findById(strategyId).lean();
  if (!strat) throw new Error('Estratégia não encontrada');
  if (!strat.positionOpen) throw new Error(`Estratégia "${strat.slug}" não possui posição aberta`);

  const openTrade: any = await (PredictionArbTrade as any).findOne({
    strategyId: strat._id,
    type: 'open_pair',
    status: { $in: ['executed', 'simulated'] },
  }).sort({ createdAt: -1 }).lean();

  const key = await resolvePolymarketKey(strat.userId);
  if (!key) throw new Error('Nenhuma ExchangeKey polymarket ativa encontrada');

  // Preços de saída atuais (ask do book)
  let askYes = 0;
  let askNo = 0;
  try {
    if (strat.tokenIdYes) {
      const book = await fetchBook(strat.tokenIdYes);
      askYes = book.asks[0]?.[0] || 0;
    }
  } catch {}
  try {
    if (strat.tokenIdNo) {
      const book = await fetchBook(strat.tokenIdNo);
      askNo = book.asks[0]?.[0] || 0;
    }
  } catch {}

  const yesShares = Number(strat.yesShares || openTrade?.yesShares || 0);
  const noShares = Number(strat.noShares || openTrade?.noShares || 0);
  const shares = Math.min(yesShares, noShares); // fecha o par completo

  // PnL estimado (vender o par) — desconta a TAKER fee da venda no CLOB.
  // A fee da Polymarket incide sobre o prêmio (price × (1-price)), não no
  // notional. Antes o pairExitPnl era chamado com feeRate=0 → PnL superestimado.
  const entryYes = Number(strat.avgYesPrice || openTrade?.yesPrice || 0);
  const entryNo = Number(strat.avgNoPrice || openTrade?.noPrice || 0);
  const feeVendaEstimada = (askYes > 0 ? estimateFee(TAKER_FEE_RATE, shares, askYes) : 0)
    + (askNo > 0 ? estimateFee(TAKER_FEE_RATE, shares, askNo) : 0);
  const pnl = (entryYes > 0 && entryNo > 0 && askYes > 0 && askNo > 0)
    ? pairExitPnl({ yes: entryYes, no: entryNo }, { yes: askYes, no: askNo }, shares, TAKER_FEE_RATE)
    : 0;

  // Corr. 1: nunca vender por gatilho de preço (convergência OU take-profit)
  // se o valor realizável no ASK atual ficar ABAIXO do custo. O gatilho do
  // monitor (sum>=1 / realizedPct) usava o preço do scan (defasado até 30s) —
  // num mercado fino de 15min o book real pode já ter caído, e vender
  // "porque convergiu" realizava perda evitável (casos reais: par 5/5 vendido
  // a $2.11 de $4.95). Com o valor abaixo do custo, é melhor segurar até o
  // vencimento (redeem paga $1 do lado certo) do que vender barato no book.
  // Lança erro para o caller (monitor) saber que não houve fechamento — a
  // posição permanece aberta e o ciclo seguinte tenta de novo ou o redeem
  // resolve no vencimento.
  const ehClosePorPreco = /convergiu|Take-profit|take.profit/i.test(String(reason || ''));
  if (ehClosePorPreco && entryYes > 0 && entryNo > 0 && askYes > 0 && askNo > 0) {
    const valorRealizavel = shares * (askYes + askNo); // receberia vendendo as duas pernas
    const custoPago = shares * (entryYes + entryNo);
    const margemMinima = custoPago * PREDICTION_ARB_CONFIG.exit.minRealizableMargin; // 0.2% — só fecha se não tomar prejuízo
    if (valorRealizavel < custoPago + margemMinima) {
      const msg = `${reason} mas book fraco: realizável $${valorRealizavel.toFixed(2)} < custo $${custoPago.toFixed(2)} (asks ${askYes}/${askNo}). Segurando até vencimento.`;
      log.warn(`⚠️ [${strat.slug}] ${msg}`);
      throw new Error(msg);
    }
  }

  const trade: any = await PredictionArbTrade.create({
    userId: strat.userId,
    strategyId: strat._id,
    openTradeId: openTrade?._id,
    marketId: strat.marketId,
    slug: strat.slug,
    question: strat.question,
    type: 'close_pair',
    status: dryRun ? 'simulated' : 'detected',
    yesPrice: entryYes,
    noPrice: entryNo,
    yesExitPrice: askYes,
    noExitPrice: askNo,
    amount: strat.positionSize,
    yesShares,
    noShares,
    pnl: Number(pnl.toFixed(4)),
    reason,
  });

  if (dryRun) {
    log.info(`[dry-run] Fechar ${strat.slug}: vender ${shares} YES @ ${askYes.toFixed(4)} + ${shares} NO @ ${askNo.toFixed(4)} | pnl estimado $${pnl.toFixed(4)}`);
    trade.status = 'simulated';
    await trade.save();
    return trade;
  }

  const credentials = resolveClobCredentials(key);
  // ExchangeKey completa (para a SDK ler relayerApiKey/apiSecret)
  const keyDoc = await ExchangeKey.findById(key._id).lean().catch(() => key);
  const useSdk = Boolean(String(keyDoc?.relayerApiKey || process.env.POLYMARKET_RELAYER_KEY || '').trim());

  try {
    const orderIds: string[] = [];
    if (useSdk) {
      const [yesId, noId] = await Promise.all([
        placeOrderViaSdk(keyDoc, { tokenId: strat.tokenIdYes, side: 'SELL', price: askYes, size: shares })
          .catch((e: any) => { log.warn(`⚠️ Venda YES (SDK) falhou: ${e.message}`); return null; }),
        placeOrderViaSdk(keyDoc, { tokenId: strat.tokenIdNo, side: 'SELL', price: askNo, size: shares })
          .catch((e: any) => { log.warn(`⚠️ Venda NO (SDK) falhou: ${e.message}`); return null; }),
      ]);
      if (yesId) orderIds.push(yesId);
      if (noId) orderIds.push(noId);
    } else {
      const sellYes = await signOrder({ credentials, tokenId: strat.tokenIdYes, side: 'SELL', price: askYes, size: shares });
      const sellNo = await signOrder({ credentials, tokenId: strat.tokenIdNo, side: 'SELL', price: askNo, size: shares });
      const [yesId, noId] = await Promise.all([
        placeOrder(credentials, sellYes).catch((e: any) => { log.warn(`⚠️ Venda YES falhou: ${e.message}`); return null; }),
        placeOrder(credentials, sellNo).catch((e: any) => { log.warn(`⚠️ Venda NO falhou: ${e.message}`); return null; }),
      ]);
      if (yesId) orderIds.push(yesId);
      if (noId) orderIds.push(noId);
    }

    // Reconcilia posição real após venda
    await new Promise((r) => setTimeout(r, 6000));
    const positions = useSdk
      ? await fetchPositionsViaSdk(keyDoc).catch(() => [])
      : await fetchPositions(credentials).catch(() => []);
    const remainingYes = Number(positions.find((p: any) => p.asset_id === strat.tokenIdYes || String(p.token_id || '') === strat.tokenIdYes)?.size || 0);
    const remainingNo = Number(positions.find((p: any) => p.asset_id === strat.tokenIdNo || String(p.token_id || '') === strat.tokenIdNo)?.size || 0);

    if (remainingYes <= shares * 0.1 && remainingNo <= shares * 0.1) {
      trade.status = 'executed';
      trade.orderIds = orderIds;
      await trade.save();

      // Registra a fee estimada da venda (observabilidade do custo real).
      if (feeVendaEstimada > 0) {
        await PredictionArbTrade.create({
          userId: strat.userId,
          strategyId: strat._id,
          openTradeId: openTrade?._id,
          marketId: strat.marketId,
          slug: strat.slug,
          question: strat.question,
          type: 'fee',
          status: 'executed',
          amount: Number(feeVendaEstimada.toFixed(4)),
          pnl: Number((-feeVendaEstimada).toFixed(4)),
          reason: `Taker fee estimada da venda (${TAKER_FEE_RATE * 100}% sobre prêmio)`,
        }).catch(() => {
        log.warn(`⚠️ falha ao criar trade de fee para ${strat.slug}`);
      });
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
      log.info(`✅ Par fechado ${strat.slug} | pnl $${pnl.toFixed(4)}`);
      return trade;
    }

    for (const id of orderIds) {
      try {
        if (useSdk) await cancelOrderViaSdk(keyDoc, id);
        else await cancelOrder(credentials, id);
      } catch (e: any) {
        log.warn(`⚠️ falha ao cancelar ordem ${id}: ${e.message}`);
      }
    }
    trade.status = 'failed';
    trade.errorMessage = `Fechamento parcial: restam YES=${remainingYes} NO=${remainingNo}`;
    await trade.save();
    throw new Error(trade.errorMessage);
  } catch (e: any) {
    if (trade.status !== 'failed') {
      trade.status = 'failed';
      trade.errorMessage = e.message;
      await trade.save();
    }
    throw e;
  }
}

export { log };
