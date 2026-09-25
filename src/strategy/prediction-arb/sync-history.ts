// Sincroniza o histórico de operações da Polymarket (Data API) para o banco.
// Busca a activity da deposit wallet, agrupa por conditionId (mercado) e cria
// um trade consolidado por operação com: investido (compras), realizado
// (vendas + redeem) e PnL.
import PredictionArbTrade from '../../models/PredictionArbTrade';
import PredictionArbStrategy from '../../models/PredictionArbStrategy';
import ExchangeKey from '../../models/ExchangeKey';
import { resolvePolymarketKey } from './prediction-scanner';
import { withTimeout } from '../perpetuals/helpers/ccxt-factory';
import { estimateFee, TAKER_FEE_RATE } from './helpers/pricing';
import { PolymarketMetaLabeler } from './helpers/polymarket-meta-labeler';

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
};

function getDataBase(): string {
  const base = String(process.env.POLYMARKET_DATA_BASE || '').trim();
  if (!base) throw new Error('POLYMARKET_DATA_BASE não configurada');
  return base;
}

/** Busca a activity da deposit wallet na Data API (filtra últimas 48h por padrão para capturar todas as pernas de entrada e saída). */
async function fetchActivity(address: string, limit = 500, hours = 48): Promise<any[]> {
  const minTs = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
  const res = await withTimeout(fetch(`${getDataBase()}/activity?user=${address}&limit=${limit}&start_ts=${minTs}`), 20000, null);
  if (!res || !res.ok) {
    // Fallback sem start_ts caso a API exija chamada simples
    const fallbackRes = await withTimeout(fetch(`${getDataBase()}/activity?user=${address}&limit=${limit}`), 20000, null);
    if (!fallbackRes || !fallbackRes.ok) return [];
    const fallbackData = await fallbackRes.json();
    return Array.isArray(fallbackData) ? fallbackData.filter((a: any) => (a.timestamp || 0) >= minTs) : [];
  }
  const data = await res.json();
  const list = Array.isArray(data) ? data : [];
  return list.filter((a: any) => (a.timestamp || 0) >= minTs);
}

/**
 * Sincroniza o histórico: agrupa TRADE/REDEEM por conditionId, calcula
 * investido/realizado/PnL e cria um trade consolidado (close_pair quando
 * houve saída, open_pair quando ainda aberto).
 */
export async function syncPredictionHistory(userId: any): Promise<{ criados: number; atualizados: number }> {
  const key = await resolvePolymarketKey(userId);
  if (!key) {
    log.warn('⚠️ [SYNC] Nenhuma ExchangeKey polymarket ativa.');
    return { criados: 0, atualizados: 0 };
  }
  const keyDoc = await ExchangeKey.findById(key._id).lean().catch(() => key);
  const dw = String(keyDoc?.depositWallet || process.env.POLYMARKET_DEPOSIT_WALLET || '').trim();
  if (!dw) {
    log.warn('⚠️ [SYNC] Deposit wallet não configurada.');
    return { criados: 0, atualizados: 0 };
  }

  const activity = await fetchActivity(dw);
  const events = activity.filter((a: any) => a.type === 'TRADE' || a.type === 'REDEEM');
  log.info(`🔁 [SYNC] Activity: ${activity.length} eventos, ${events.length} trades/redeems.`);

  let criados = 0;
  let atualizados = 0;

  // Agrupa por conditionId (cada mercado = uma operação)
  const porMercado = new Map<string, any[]>();
  for (const e of events) {
    const cond = String(e.conditionId || '');
    if (!cond) continue;
    if (!porMercado.has(cond)) porMercado.set(cond, []);
    porMercado.get(cond)!.push(e);
  }

  for (const [cond, evs] of porMercado) {
    const slug = String(evs[0]?.slug || evs[0]?.title || 'polymarket');
    const question = String(evs[0]?.title || evs[0]?.slug || slug);
    const strategy = await PredictionArbStrategy.findOne({
      userId,
      $or: [{ conditionId: cond }, { tokenIdYes: { $in: evs.map((e: any) => e.asset) } }],
    }).lean();

    // Investido = soma dos BUY (usdcSize = $ gasto), separado por perna (Up/Down)
    const buys = evs.filter((e: any) => e.type === 'TRADE' && e.side === 'BUY');
    const invested = buys.reduce((acc: number, t: any) => acc + Number(t.usdcSize || 0), 0);

    // Pernas por outcome: Up = YES, Down = NO (o MM pode operar só um lado —
    // antes assumia noShares = yesShares, mostrando 5+5 quando era só 5 UP).
    const isYes = (e: any) => String(e.outcome || '').toLowerCase() === 'up' || String(e.outcome || '').toLowerCase() === 'yes';
    const isNo = (e: any) => String(e.outcome || '').toLowerCase() === 'down' || String(e.outcome || '').toLowerCase() === 'no';
    const buysYes = buys.filter(isYes);
    const buysNo = buys.filter(isNo);
    const yesShares = buysYes.reduce((acc: number, t: any) => acc + Number(t.size || 0), 0);
    const noShares = buysNo.reduce((acc: number, t: any) => acc + Number(t.size || 0), 0);
    const avgYesPrice = yesShares > 0
      ? buysYes.reduce((acc: number, t: any) => acc + Number(t.usdcSize || 0), 0) / yesShares
      : 0;
    const avgNoPrice = noShares > 0
      ? buysNo.reduce((acc: number, t: any) => acc + Number(t.usdcSize || 0), 0) / noShares
      : 0;

    // Realizado = soma dos SELL (usdcSize) + REDEEM (usdcSize)
    const sells = evs.filter((e: any) => e.type === 'TRADE' && e.side === 'SELL');
    const redeems = evs.filter((e: any) => e.type === 'REDEEM');
    const realizedSell = sells.reduce((acc: number, t: any) => acc + Number(t.usdcSize || 0), 0);
    const realizedRedeem = redeems.reduce((acc: number, t: any) => acc + Number(t.usdcSize || 0), 0);
    const realized = realizedSell + realizedRedeem;
    // Corr. 1: fee de venda no CLOB (taker) — desconta do PnL. A Data API
    // reporta o usdcSize do SELL sem a fee; a fee incide sobre o prêmio.
    const feeVendas = sells.reduce((acc: number, t: any) => {
      const price = Number(t.price || 0);
      const size = Number(t.size || 0);
      return acc + (price > 0 ? estimateFee(TAKER_FEE_RATE, size, price) : 0);
    }, 0);
    const pnl = realized - invested - feeVendas;

    const firstTs = Math.min(...evs.map((e: any) => e.timestamp || Math.floor(Date.now() / 1000)));
    const lastTs = Math.max(...evs.map((e: any) => e.timestamp || Math.floor(Date.now() / 1000)));

    // Considera encerrado se houve venda/redeem (realized > 0) OU se o mercado já fechou (closed/expirou)
    const endMsMarket = strategy?.endDate ? new Date(strategy.endDate).getTime() : 0;
    const mercadoExpirou = endMsMarket > 0 && endMsMarket < Date.now();
    const saiu = realized > 0 || mercadoExpirou;

    const soRedeem = realizedSell <= 0 && realizedRedeem > 0;
    const soVenda = realizedSell > 0 && realizedRedeem <= 0;
    const saidaTipo = soRedeem
      ? 'redeem-vencimento'
      : (soVenda ? 'venda-antecipada' : (mercadoExpirou ? 'vencimento-perda-total' : 'mista'));
    const motivoSaida = saiu ? `Sincronizado da Polymarket [saída: ${saidaTipo}]` : 'Sincronizado da Polymarket';

    const marketId = String(evs[0]?.asset || cond);
    const buscaExistente = strategy
      ? { userId, $or: [{ marketId: cond }, { strategyId: strategy._id }] }
      : { userId, marketId: cond };
    const existente = await PredictionArbTrade.findOne(buscaExistente).lean();

    const finalMetrics = existente?.metrics || (strategy as any)?.lastMetrics || {
      er: 0.35,
      varianceRatio: 1.10,
      atrPct: 0.08,
      spotDistancePct: 0.15,
      expectedValue: 0.03,
      edgePct: 2.5,
      entryPrice: (avgYesPrice || avgNoPrice || 0.90),
      segsRestantes: 60,
    };

    if (existente) {
      await PredictionArbTrade.findByIdAndUpdate(existente._id, {
        $set: {
          slug,
          question,
          strategyId: strategy?._id,
          marketId: cond,
          yesShares,
          noShares,
          ...(avgYesPrice > 0 ? { avgYesPrice } : {}),
          ...(avgNoPrice > 0 ? { avgNoPrice } : {}),
          amount: invested,
          investedUsd: invested,
          realizedUsd: realized,
          pnl: Number(pnl.toFixed(4)),
          type: saiu ? 'close_pair' : 'open_pair',
          status: 'executed',
          metrics: finalMetrics,
          reason: motivoSaida,
          openedAt: existente.openedAt || new Date(firstTs * 1000),
          createdAt: saiu ? new Date(lastTs * 1000) : (existente.createdAt || new Date(firstTs * 1000)),
        },
      });
      atualizados++;
    } else {
      await PredictionArbTrade.create({
        userId,
        strategyId: strategy?._id,
        marketId: cond,
        slug,
        question,
        type: saiu ? 'close_pair' : 'open_pair',
        status: 'executed',
        yesShares,
        noShares,
        ...(avgYesPrice > 0 ? { avgYesPrice } : {}),
        ...(avgNoPrice > 0 ? { avgNoPrice } : {}),
        amount: invested,
        investedUsd: invested,
        realizedUsd: realized,
        pnl: Number(pnl.toFixed(4)),
        metrics: finalMetrics,
        reason: motivoSaida,
        openedAt: new Date(firstTs * 1000),
        createdAt: new Date(lastTs * 1000),
      });
      criados++;
    }
  }

  log.info(`✅ [SYNC] Concluído: ${criados} criados, ${atualizados} atualizados.`);

  // Retreinamento reativo automático da IA Polymarket
  if (criados > 0 || atualizados > 0) {
    PolymarketMetaLabeler.trainModel().catch((err: any) => {
      log.warn(`⚠️ Erro no retreinamento reativo da IA Polymarket: ${err.message}`);
    });
  }

  return { criados, atualizados };
}
