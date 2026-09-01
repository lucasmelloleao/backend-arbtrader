// Encerramento de pares: vende ambos os lados no CLOB ou resolve no vencimento.
// Reconciliado com posições reais (fonte da verdade = CLOB).
import PredictionArbStrategy from '../../models/PredictionArbStrategy';
import PredictionArbTrade from '../../models/PredictionArbTrade';
import ExchangeKey from '../../models/ExchangeKey';
import { resolvePolymarketKey } from './prediction-scanner';
import { resolveClobCredentials, placeOrder, cancelOrder, fetchBook, fetchPositions, signOrder } from './helpers/clob-client';
import { placeOrderViaSdk, cancelOrderViaSdk, fetchPositionsViaSdk } from './helpers/secure-client';
import { pairExitPnl } from './helpers/pricing';

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

  // PnL estimado (vender o par)
  const entryYes = Number(strat.avgYesPrice || openTrade?.yesPrice || 0);
  const entryNo = Number(strat.avgNoPrice || openTrade?.noPrice || 0);
  const pnl = (entryYes > 0 && entryNo > 0 && askYes > 0 && askNo > 0)
    ? pairExitPnl({ yes: entryYes, no: entryNo }, { yes: askYes, no: askNo }, shares, 0)
    : 0;

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
      if (useSdk) await cancelOrderViaSdk(keyDoc, id).catch(() => {});
      else await cancelOrder(credentials, id).catch(() => {});
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
