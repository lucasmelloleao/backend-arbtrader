// Executor de entrada: monta o par completo (YES+NO) com ordens maker no CLOB.
// Reconcilia posições reais (fonte da verdade = CLOB / Data API).
import mongoose from 'mongoose';
import PredictionArbStrategy from '../../models/PredictionArbStrategy';
import PredictionArbTrade from '../../models/PredictionArbTrade';
import { resolvePolymarketKey } from './prediction-scanner';
import { resolveClobCredentials, placeOrder, cancelOrder, fetchBook, fetchPositions, signOrder } from './helpers/clob-client';
import { fetchUserPositions } from './helpers/data-client';
import { makerEntryPrices, completenessSpreadPct } from './helpers/pricing';

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${msg}`, ...args),
};

const ORDER_TIMEOUT_MS = 45_000;

/** Busca a melhor profundidade do book para um token (bids e asks). */
async function bestBids(strategy: any): Promise<{ bidYes: number; bidNo: number; askYes: number; askNo: number }> {
  let bidYes = 0;
  let bidNo = 0;
  let askYes = 0;
  let askNo = 0;
  try {
    if (strategy.tokenIdYes) {
      const book = await fetchBook(strategy.tokenIdYes);
      bidYes = book.bids[0]?.[0] || 0;
      askYes = book.asks[0]?.[0] || 0;
    }
  } catch {}
  try {
    if (strategy.tokenIdNo) {
      const book = await fetchBook(strategy.tokenIdNo);
      bidNo = book.bids[0]?.[0] || 0;
      askNo = book.asks[0]?.[0] || 0;
    }
  } catch {}
  return { bidYes, bidNo, askYes, askNo };
}

/** Reconcilia as posições reais no CLOB e atualiza o banco. */
export async function reconcilePosition(strategy: any, credentials: any): Promise<{ yesShares: number; noShares: number }> {
  const positions = await fetchPositions(credentials).catch(() => []);
  const yesPos = positions.find((p: any) => p.asset_id === strategy.tokenIdYes || p.condition_id === strategy.conditionId);
  const noPos = positions.find((p: any) => p.asset_id === strategy.tokenIdNo || p.condition_id === strategy.conditionId);

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
  return { yesShares, noShares };
}

export async function executeStrategy(strategyId: string, opts: { dryRun?: boolean } = {}) {
  const dryRun = opts.dryRun ?? true;

  const strat: any = await (PredictionArbStrategy as any).findById(strategyId).lean();
  if (!strat) throw new Error('Estratégia não encontrada');
  if (!strat.active) throw new Error(`Estratégia "${strat.slug}" inativa`);
  if (strat.positionOpen) throw new Error(`Estratégia "${strat.slug}" já possui posição aberta`);

  const key = await resolvePolymarketKey(strat.userId);
  if (!key) throw new Error('Nenhuma ExchangeKey polymarket ativa encontrada');

  // Preços atuais (bids e asks para preço agressivo)
  const { bidYes, bidNo, askYes, askNo } = await bestBids(strat);
  const yes = strat.yesPrice || bidYes;
  const no = strat.noPrice || bidNo;
  const spread = completenessSpreadPct({ yes, no });
  if (spread <= 0) {
    throw new Error(`Spread de completude não é positivo (${spread.toFixed(2)}%) — sem arbitragem`);
  }

  // Quantidade de ações por lado: aloca tradeSize em cada lado
  const tradeSize = Number(strat.tradeSize || 100);
  const shares = Math.max(1, Math.floor(tradeSize)); // 1 ação = $1 notional

  // Preços de entrada agressivos: coloca no ASK (taker) se o spread ainda for
  // lucrativo; senão usa o preço maker no bid (espera fill). Preferir agressivo
  // aumenta a chance de preencher nos mercados updown finos.
  const entryMaker = makerEntryPrices(bidYes, bidNo, Math.min(spread, strat.spreadPct || 0.5));
  const askSum = askYes + askNo;
  const aggressivePossible = askYes > 0 && askNo > 0 && askSum < 1 && (1 - askSum) * 100 >= 0.1;
  let entry = entryMaker;

  if (!entryMaker && aggressivePossible) {
    // Sem book maker suficiente, mas dá para cruzar o spread lucrativamente
    entry = { yes: askYes, no: askNo };
    log.info(`⚡ [${strat.slug}] Book maker insuficiente — cruzando spread (taker): YES ${askYes} + NO ${askNo}`);
  } else if (entryMaker && aggressivePossible) {
    // Tenta o ASK se o spread residual (após taxas) ainda for positivo;
    // senão mantém maker no bid.
    const makerSum = entryMaker.yes + entryMaker.no;
    const residualSpread = (1 - askSum) * 100;
    if (residualSpread >= Math.min(spread, strat.spreadPct || 0.5) * 0.3) {
      entry = { yes: askYes, no: askNo };
      log.info(`⚡ [${strat.slug}] Modo agressivo (cruzando spread): YES ${askYes} + NO ${askNo} (soma ${askSum.toFixed(4)})`);
    } else {
      log.info(`📌 [${strat.slug}] Modo maker: YES ${entryMaker.yes} + NO ${entryMaker.no} (soma ${makerSum.toFixed(4)})`);
    }
  }
  if (!entry) {
    throw new Error('Não foi possível calcular preços de entrada (book insuficiente)');
  }

  const trade: any = await PredictionArbTrade.create({
    userId: strat.userId,
    strategyId: strat._id,
    marketId: strat.marketId,
    slug: strat.slug,
    question: strat.question,
    type: 'open_pair',
    status: dryRun ? 'simulated' : 'detected',
    yesPrice: entry.yes,
    noPrice: entry.no,
    amount: tradeSize * 2,
    yesShares: shares,
    noShares: shares,
    spreadPct: spread,
  });

  if (dryRun) {
    log.info(`[dry-run] Par ${strat.slug}: comprar ${shares} YES @ ${entry.yes.toFixed(4)} + ${shares} NO @ ${entry.no.toFixed(4)} (soma ${(entry.yes + entry.no).toFixed(4)})`);
    trade.status = 'simulated';
    await trade.save();
    return trade;
  }

  const credentials = resolveClobCredentials(key);
  const orderIds: string[] = [];
  try {
    // Coloca ordens maker nos dois lados
    const yesOrder = await signOrder({ credentials, tokenId: strat.tokenIdYes, side: 'BUY', price: entry.yes, size: shares });
    const noOrder = await signOrder({ credentials, tokenId: strat.tokenIdNo, side: 'BUY', price: entry.no, size: shares });

    const [yesId, noId] = await Promise.all([
      placeOrder(credentials, yesOrder).catch((e: any) => { log.warn(`⚠️ Ordem YES falhou: ${e.message}`); return null; }),
      placeOrder(credentials, noOrder).catch((e: any) => { log.warn(`⚠️ Ordem NO falhou: ${e.message}`); return null; }),
    ]);

    if (yesId) orderIds.push(yesId);
    if (noId) orderIds.push(noId);

    // Aguarda fills e reconcilia posição real (mais tempo = mais chance de fill)
    await new Promise((r) => setTimeout(r, Math.min(ORDER_TIMEOUT_MS, 30_000)));
    const { yesShares, noShares } = await reconcilePosition(strat, credentials);
    const yesFilled = yesShares >= shares * 0.3;
    const noFilled = noShares >= shares * 0.3;
    const bothFilled = yesFilled && noFilled;

    if (yesFilled || noFilled) {
      // Aceita fill parcial: abre a posição com o que preencheu (reconcilia depois)
      trade.status = 'executed';
      trade.yesShares = yesShares;
      trade.noShares = noShares;
      trade.orderIds = orderIds;
      if (!bothFilled) {
        trade.errorMessage = `Fill parcial aceito: YES=${yesShares}/${shares} NO=${noShares}/${shares}`;
        log.warn(`⚠️ [${strat.slug}] Fill parcial aceito: YES=${yesShares} NO=${noShares}. Continuando com o que preencheu.`);
      }
      await trade.save();

      await (PredictionArbStrategy as any).findByIdAndUpdate(strat._id, {
        positionOpen: true,
        positionSize: (yesShares + noShares) / 2,
        yesShares,
        noShares,
        lastCheckAt: new Date(),
      });
      log.info(`✅ Par aberto ${strat.slug}: ${yesShares} YES + ${noShares} NO`);
      return trade;
    }

    // Fill parcial: NÃO cancela as ordens — deixa-as GTC ativas e registra como
    // "detected" para o próximo ciclo reconciliar (mais agressivo: dá tempo ao fill).
    trade.status = 'detected';
    trade.yesShares = yesShares;
    trade.noShares = noShares;
    trade.orderIds = orderIds;
    trade.errorMessage = `Aguardando fill: YES=${yesShares}/${shares} NO=${noShares}/${shares} (ordens GTC mantidas)`;
    await trade.save();

    // Marca a estratégia como aberta (mesmo com fill 0) para o loop não
    // duplicar ordens; o monitor reconcilia a posição real nos ciclos seguintes.
    await (PredictionArbStrategy as any).findByIdAndUpdate(strat._id, {
      positionOpen: true,
      positionSize: (yesShares + noShares) / 2,
      yesShares,
      noShares,
      lastCheckAt: new Date(),
    });
    log.warn(`⏳ [${strat.slug}] Sem fill ainda (YES=${yesShares} NO=${noShares}). Ordens GTC mantidas — monitor vai reconciliar.`);
    return trade;
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
