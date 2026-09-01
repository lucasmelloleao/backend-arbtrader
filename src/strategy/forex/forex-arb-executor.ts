// Executor de Arbitragem Forex: abre (executa pernas) e fecha posições.
// Espelha o padrão de perp-funding-executor.ts / perp-close-executor.ts.
import ccxt from 'ccxt';
import mongoose from 'mongoose';
import { decryptSecretKey } from '../../utils/encryption';
import { connectToDatabase } from '../../config/db';
import Redis from 'ioredis';
import ForexArbStrategy from '../../models/ForexArbStrategy';
import ForexArbTrade from '../../models/ForexArbTrade';
import ExchangeKey from '../../models/ExchangeKey';
import { isCtraderExchange } from './scanner';
import { getSharedCtraderAdapter } from './ctrader/ctrader-factory';
import { isFixExchange, getSharedFixAdapter } from './fix/fix-factory';
import { isDukascopyExchange, getSharedDukascopyAdapter } from './dukascopy/dukascopy-factory';

const getTs = () => `[${new Date().toISOString()}]`;
const log = {
  info: (...args: any[]) => console.log(getTs(), '[FOREX-EXEC]', ...args),
  warn: (...args: any[]) => console.warn(getTs(), '[FOREX-EXEC]', ...args),
  error: (...args: any[]) => console.error(getTs(), '[FOREX-EXEC]', ...args),
};

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T = null as any): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
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
    return Boolean(await (r as any).set(`hft:forex_arb_lock:${id}`, '1', 'NX', 'EX', 60));
  } catch { return true; }
}

async function unlockStrategy(id: string) {
  const r = getRedisClient();
  if (!r) return;
  try { await r.del(`hft:forex_arb_lock:${id}`); } catch { }
}

// ─── Exchange factory ──────────────────────────────────────────────────────────

async function getExchange(doc: any) {
  const { exchangeId, apiKey, apiSecret, userId } = doc;

  // cTrader/Pepperstone (Open API) → adaptador compartilhado (WebSocket protobuf, com cache)
  if (isCtraderExchange(exchangeId)) {
    return getSharedCtraderAdapter(doc);
  }

  // FIX API (Pepperstone) → adaptador FIX (TCP/TLS, com cache)
  if (isFixExchange(exchangeId)) {
    return getSharedFixAdapter(doc);
  }

  // Dukascopy (JForex SDK via ponte Java) → adaptador HTTP
  if (isDukascopyExchange(exchangeId)) {
    return getSharedDukascopyAdapter(doc);
  }


  const id = exchangeId === 'gateio' ? 'gate' : exchangeId;
  const cls: any = (ccxt as any)[id] ?? (ccxt as any).pro?.[id] ?? (ccxt as any)[exchangeId];
  if (!cls) throw new Error(`Exchange "${exchangeId}" não suportada pelo ccxt`);

  let secret = apiSecret;
  try {
    const aad = userId ? `${userId}-${exchangeId}` : '';
    secret = decryptSecretKey(String(apiSecret || ''), aad);
  } catch { /* usa raw */ }

  const instance = new cls({
    apiKey,
    secret,
    enableRateLimit: true,
    timeout: 8000,
    options: { fetchCurrencies: false },
  });
  instance.has = { ...(instance.has || {}), fetchCurrencies: false };
  return instance;
}

async function resolveExchangeKey(strat: any) {
  const keyId = strat.exchangeKeyId ?? null;
  if (!keyId) throw new Error('Sem exchangeKeyId na estratégia');
  const key = await (ExchangeKey as any).findById(keyId).lean();
  if (!key) throw new Error(`ExchangeKey não encontrado (id=${keyId})`);
  return key;
}

async function recordLoss(strat: any, lossUSDT: number) {
  const maxLoss = Number(strat.maxDailyLoss ?? 0);
  const newAccum = Number(strat.dailyLossAccum ?? 0) + lossUSDT;
  const hitLimit = maxLoss > 0 && newAccum >= maxLoss;

  await (ForexArbStrategy as any).findByIdAndUpdate(strat._id, {
    dailyLossAccum: newAccum,
    lastLossAt: new Date(),
    ...(hitLimit ? { autoExecute: false, active: false } : {}),
  });

  if (hitLimit) {
    log.error(`⛔ [${strat.name}] Limite diário atingido (${newAccum.toFixed(2)} USDT). Estratégia desativada.`);
  }
}

// ─── Cálculo de quantidade por perna ───────────────────────────────────────────
// Dada uma rota de pernas (ex: buy ETH/BTC, sell ETH/USDT, buy BTC/USDT),
// calcula a quantidade de cada perna. A rota triangular A->B->C->A é executada
// como: (1) comprar B vendendo A, (2) vender B por C, (3) comprar A com C.
// `tradeSize` é o valor inicial em USDT (equivalente à moeda A quando A é o
// numerário). A quantidade de cada perna deriva da anterior.

export function computeLegAmounts(legs: Array<{ symbol: string; side: 'buy' | 'sell'; price: number }>, tradeSize: number): Array<{ symbol: string; side: 'buy' | 'sell'; price: number; amount: number }> {
  const result: Array<{ symbol: string; side: 'buy' | 'sell'; price: number; amount: number }> = [];

  // Primeira perna: converte a moeda de partida (numerário) para a moeda da rota.
  // Se a 1a perna é 'buy X/Y', gastamos tradeSize de Y para comprar X.
  // Se a 1a perna é 'sell X/Y', vendemos tradeSize de X (assumindo X = numerário).
  const firstLeg = legs[0];
  if (!firstLeg) return result;

  let currentAmount = tradeSize;
  if (firstLeg.side === 'buy') {
    // Compramos firstLeg.base gastando currentAmount da quote (Y)
    // amount = currentAmount / price (quantidade de X comprada)
    const amount = currentAmount / firstLeg.price;
    result.push({ ...firstLeg, amount });
    currentAmount = amount; // agora temos X
  } else {
    // Vendemos currentAmount de X (base) — a quantidade é currentAmount
    result.push({ ...firstLeg, amount: currentAmount });
    currentAmount = currentAmount * firstLeg.price; // recebemos Y
  }

  // Pernas seguintes: alternam entre comprar/vender derivando da anterior
  for (let i = 1; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.side === 'buy') {
      // Compramos a base gastando currentAmount da quote
      const amount = currentAmount / leg.price;
      result.push({ ...leg, amount });
      currentAmount = amount;
    } else {
      // Vendemos currentAmount da base
      result.push({ ...leg, amount: currentAmount });
      currentAmount = currentAmount * leg.price;
    }
  }

  return result;
}

// ─── Reversão: inverte as pernas executadas (compra vira venda e vice-versa) ──

async function reverseLegs(exchange: any, executed: Array<{ symbol: string; side: 'buy' | 'sell'; amount: number }>) {
  const reversed: string[] = [];
  for (const leg of [...executed].reverse()) {
    const opposite: 'buy' | 'sell' = leg.side === 'buy' ? 'sell' : 'buy';
    try {
      const order = await exchange.createMarketOrder(leg.symbol, opposite, leg.amount);
      reversed.push(order?.id || 'ok');
    } catch (e: any) {
      log.error(`❌ Falha ao reverter perna ${leg.symbol} (${opposite}):`, e.message);
    }
  }
  return reversed;
}

// ─── closeArbitrage ────────────────────────────────────────────────────────────

const CLOSE_DEDUP_WINDOW_MS = 60_000;

async function hasRecentCloseInFlight(strategyId: string): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - CLOSE_DEDUP_WINDOW_MS);
    const existing = await (ForexArbTrade as any).findOne({
      ...(mongoose.Types.ObjectId.isValid(strategyId) ? { strategyId } : {}),
      type: 'close',
      status: { $in: ['detected', 'executed'] },
      createdAt: { $gte: cutoff },
    }).sort({ createdAt: -1 }).lean();
    return Boolean(existing);
  } catch {
    return false;
  }
}

export async function closeArbitrage(strategyId: string, opts: { dryRun?: boolean; reason?: string } = {}) {
  const dryRun = opts.dryRun !== undefined ? opts.dryRun : (process.env.PERP_ALLOW_LIVE !== 'true');

  if (!await lockStrategy(strategyId)) throw new Error('Estratégia bloqueada (outra execução em curso)');

  try {
    const strat = await (ForexArbStrategy as any).findById(strategyId).lean();
    if (!strat) throw new Error(`Nenhuma estratégia encontrada para "${strategyId}"`);
    if (!strat.positionOpen) throw new Error(`Estratégia "${strat.name}" não possui posição aberta.`);

    if (await hasRecentCloseInFlight(strategyId)) {
      const msg = `⛔ [${strat.name}] Já existe um fechamento em andamento. Abortando disparo duplicado.`;
      log.warn(msg);
      throw new Error(msg);
    }

    const key = await resolveExchangeKey(strat);
    const exchange = await getExchange(key);

    log.info(`🚀 Executando fechamento [${strat.name}] | ${dryRun ? 'DRY-RUN' : 'LIVE'}`);

    // Busca preços atuais das pernas
    const legsWithPrices: Array<{ symbol: string; side: 'buy' | 'sell'; price: number }> = [];
    for (const leg of strat.legs || []) {
      let price = leg.price;
      try {
        const tk: any = await withTimeout(exchange.fetchTicker(leg.symbol), 8000, null);
        price = tk?.last ?? tk?.bid ?? leg.price;
      } catch {}
      if (!price || price <= 0) {
        throw new Error(`Preço indisponível para ${leg.symbol} no fechamento`);
      }
      legsWithPrices.push({ symbol: leg.symbol, side: leg.side, price });
    }

    // Inverte as pernas: quem comprou vende, quem vendeu compra (mesmas quantidades)
    const closeLegs = legsWithPrices.map((leg) => ({
      symbol: leg.symbol,
      side: (leg.side === 'buy' ? 'sell' : 'buy') as 'buy' | 'sell',
      price: leg.price,
    }));

    const trade: any = await ForexArbTrade.create({
      userId: strat.userId,
      strategyId: strat._id,
      strategyName: strat.name,
      exchangeId: strat.exchangeId,
      type: 'close',
      status: dryRun ? 'simulated' : 'detected',
      legs: closeLegs,
      amount: strat.positionSize || strat.tradeSize,
      reason: opts.reason || 'Fechamento de posição',
    });

    if (dryRun) {
      trade.status = 'simulated';
      await trade.save();
      await (ForexArbStrategy as any).findByIdAndUpdate(strat._id, {
        positionOpen: false, status: 'closed', closedAt: new Date(), active: false,
      });
      return trade;
    }

    // Executa as pernas inversas com as quantidades originais
    const executed: Array<{ symbol: string; side: 'buy' | 'sell'; amount: number }> = [];
    for (let i = 0; i < closeLegs.length; i++) {
      const leg = closeLegs[i];
      const originalLeg = strat.legs[i];
      const amount = Number(originalLeg?.amount || 0);
      if (amount <= 0) throw new Error(`Quantidade inválida para ${leg.symbol} no fechamento`);

      try {
        const order = await withTimeout(
          exchange.createMarketOrder(leg.symbol, leg.side, amount),
          15000, null
        );
        if (!order) throw new Error(`Timeout ao fechar ${leg.symbol}`);
        executed.push({ symbol: leg.symbol, side: leg.side, amount });
        log.info(`✅ Fechamento perna ${i + 1}/${closeLegs.length}: ${leg.side.toUpperCase()} ${amount} ${leg.symbol} (${(order as any)?.id || 'ok'})`);
      } catch (e: any) {
        log.error(`❌ Falha ao fechar perna ${leg.symbol}:`, e.message);
        // Tenta reverter as já fechadas para não ficar exposto
        await reverseLegs(exchange, executed);
        throw new Error(`Falha no fechamento da perna ${leg.symbol}: ${e.message}`);
      }
    }

    // PnL realizado: para cTrader usa o PnL não realizado real das posições
    // (somando as pernas da estratégia); para CCXT mantém a estimativa por preços.
    let realizedPnl = 0;
    if ((isCtraderExchange(strat.exchangeId) || isFixExchange(strat.exchangeId) || isDukascopyExchange(strat.exchangeId)) && typeof (exchange as any).getPositionsPnL === 'function') {
      try {
        const positionsPnl = await (exchange as any).getPositionsPnL();
        for (const leg of strat.legs || []) {
          const pos = positionsPnl.get(leg.symbol);
          if (pos) realizedPnl += pos.netPnl;
        }
        if (realizedPnl !== 0) {
          log.info(`📊 [${strat.name}] PnL real das posições antes do fechamento: $${realizedPnl.toFixed(4)}`);
        }
      } catch (e: any) {
        log.warn(`⚠️ [${strat.name}] Não foi possível obter PnL real: ${e.message}. Usando estimativa.`);
        realizedPnl = 0;
      }
    }
    if (realizedPnl === 0) {
      for (let i = 0; i < strat.legs.length; i++) {
        const openLeg = strat.legs[i];
        const closeLeg = closeLegs[i];
        const amount = Number(openLeg?.amount || 0);
        if (openLeg.side === 'buy') {
          realizedPnl += (closeLeg.price - openLeg.price) * amount;
        } else {
          realizedPnl += (openLeg.price - closeLeg.price) * amount;
        }
      }
    }

    trade.status = 'executed';
    trade.realizedPnl = realizedPnl;
    await trade.save();

    await (ForexArbStrategy as any).findByIdAndUpdate(strat._id, {
      positionOpen: false, status: 'closed', closedAt: new Date(), pnl: realizedPnl,
      ...(strat.isAutoCreated ? { active: false } : { active: false }),
    });



    log.info(`✅ [${strat.name}] Arbitragem FECHADA. PnL realizado: $${realizedPnl.toFixed(4)}`);
    return trade;

  } finally {
    await unlockStrategy(strategyId);
  }
}

// ─── executeTriangularCapture ──────────────────────────────────────────────────
// Captura instantânea de arbitragem triangular: analisa o lucro REAL com os
// preços atuais (bid/ask), e se for lucrativo, abre as 3 pernas e fecha
// imediatamente (sem deixar posição aberta). Fica sempre flat.
//
// Retorno: { operated: boolean, reason?: string, profitPct?: number, realizedPnl?: number, ... }

export type CaptureResult = {
  operated: boolean;
  reason?: string;
  profitPct?: number;
  realizedPnl?: number;
  opened?: any[];
  closed?: any[];
  trade?: any;
};

export async function executeTriangularCapture(
  opportunity: { legs: Array<{ symbol: string; side: 'buy' | 'sell'; price: number }> },
  settings: any,
  key: any,
): Promise<CaptureResult> {
  const tradeSize = Number(settings?.tradeSize ?? 100);
  const minProfitPct = Number(settings?.minProfitPct ?? 0.05);

  const exchange = await getExchange(key);

  // 1. Preços atuais (bid/ask) de cada perna para calcular o lucro EXECUTÁVEL.
  // Usa fetchTickers (não lança se algum ticker não chegar — retorna o que tiver).
  const symbols = opportunity.legs.map((l) => l.symbol);
  const tickers: any = await withTimeout(exchange.fetchTickers(symbols), 10000, null);
  if (!tickers) {
    return { operated: false, reason: 'timeout ao obter tickers' };
  }
  const prices: Record<string, { bid: number; ask: number }> = {};
  const missing: string[] = [];
  for (const sym of symbols) {
    const tk = tickers[sym];
    if (tk && tk.bid > 0 && tk.ask > 0) {
      prices[sym] = { bid: Number(tk.bid), ask: Number(tk.ask) };
    } else {
      missing.push(sym);
    }
  }
  if (missing.length > 0) {
    return { operated: false, reason: `sem preço bid/ask para: ${missing.join(', ')}` };
  }

  // Preço executável: compra paga ASK, venda recebe BID
  const executableLegs = opportunity.legs.map((leg) => ({
    symbol: leg.symbol,
    side: leg.side,
    price: leg.side === 'buy' ? prices[leg.symbol].ask : prices[leg.symbol].bid,
  }));

  // 2. Calcula o lucro líquido do ciclo completo (100 → moedas → 100) com os
  // preços executáveis. Reusa computeLegAmounts: o valor final vs inicial = lucro.
  const amounts = computeLegAmounts(executableLegs, tradeSize);
  const firstLeg = amounts[0];
  if (!firstLeg) return { operated: false, reason: 'rota vazia' };

  // Simula o ciclo para achar o valor final na moeda de partida:
  // a última perna devolve para a moeda inicial; profitPct = (final - inicial)/inicial
  let current = tradeSize;
  for (const leg of amounts) {
    if (leg.side === 'sell') current = current * leg.price;          // vende base → recebe quote
    else current = current / leg.price;                              // compra base → gasta quote
  }
  const profitPct = ((current - tradeSize) / tradeSize) * 100;

  if (profitPct < minProfitPct) {
    return { operated: false, reason: `lucro ${profitPct.toFixed(4)}% < mínimo ${minProfitPct}%` };
  }

  log.info(`🎯 [CAPTURE] Oportunidade lucrativa: ${amounts.map(a => `${a.side} ${a.amount.toFixed(4)} ${a.symbol}`).join(' -> ')} | lucro ${profitPct.toFixed(4)}%`);

  // 3. Abre as 3 pernas
  const opened: any[] = [];
  for (let i = 0; i < amounts.length; i++) {
    const leg = amounts[i];
    try {
      const order: any = await withTimeout(exchange.createMarketOrder(leg.symbol, leg.side, leg.amount), 15000, null);
      if (!order) throw new Error(`Timeout ao abrir ${leg.symbol}`);
      opened.push({
        symbol: leg.symbol,
        side: leg.side,
        amount: leg.amount,
        orderId: order?.id,
        positionId: order?.positionId ? String(order.positionId) : undefined,
        volumeProtocol: order?.amount != null ? Number(order.amount) : undefined,
      });
      log.info(`✅ [CAPTURE] Perna ${i + 1}/${amounts.length} aberta: ${leg.side.toUpperCase()} ${leg.amount.toFixed(4)} ${leg.symbol} (order ${order.id}, position ${order.positionId})`);
    } catch (e: any) {
      log.error(`❌ [CAPTURE] Falha ao abrir perna ${i + 1} (${leg.symbol}):`, e.message);
      // Reverte as já abertas (fecha as posições criadas)
      await reverseLegs(exchange, opened);
      return { operated: false, reason: `falha ao abrir ${leg.symbol}: ${e.message}`, opened };
    }
  }

  // 4. Fecha IMEDIATAMENTE cada posição criada (via closePosition por positionId)
  const closed: any[] = [];
  for (const p of opened) {
    if (!p.positionId || !p.volumeProtocol) {
      closed.push({ symbol: p.symbol, error: 'sem positionId/volume' });
      continue;
    }
    try {
      const res = await exchange.closePosition(p.positionId, p.volumeProtocol);
      closed.push({ symbol: p.symbol, positionId: p.positionId, result: res });
      log.info(`✅ [CAPTURE] Posição fechada: ${p.symbol} (position ${p.positionId})`);
    } catch (e: any) {
      closed.push({ symbol: p.symbol, positionId: p.positionId, error: e.message });
      log.error(`❌ [CAPTURE] Falha ao fechar ${p.symbol} (${p.positionId}):`, e.message);
    }
  }

  // 5. Registra a operação (execução + fechamento = round-trip concluído, flat)
  const trade: any = await ForexArbTrade.create({
    userId: settings.userId,
    strategyName: `CAPTURE-${opportunity.legs.map(l => l.symbol.split('/')[0]).join('/')}`,
    exchangeId: opportunity.legs[0] ? 'ctrader' : 'ctrader',
    type: 'execution',
    status: 'executed',
    legs: amounts.map(l => ({ symbol: l.symbol, side: l.side, price: l.price, amount: l.amount })),
    amount: tradeSize,
    expectedProfitPct: profitPct,
    realizedPnl: (profitPct / 100) * tradeSize,
    reason: 'captura triangular instantânea (flat)',
  });

  log.info(`✅ [CAPTURE] Round-trip concluído: +${profitPct.toFixed(4)}% (≈$${((profitPct / 100) * tradeSize).toFixed(4)}) — FLAT, sem posições abertas.`);
  return { operated: true, profitPct, realizedPnl: (profitPct / 100) * tradeSize, opened, closed, trade };
}

// ─── executeArbitrage ──────────────────────────────────────────────────────────

export async function executeArbitrage(strategyId: string, opts: { dryRun?: boolean; forceFirstExecution?: boolean } = {}) {
  const dryRun = opts.dryRun !== undefined ? opts.dryRun : false;

  if (!await lockStrategy(strategyId)) throw new Error('Estratégia bloqueada (outra execução em curso)');

  try {
    const strat = await (ForexArbStrategy as any).findById(strategyId).lean();
    if (!strat) throw new Error('Estratégia não encontrada no banco de dados');
    if (!strat.active) throw new Error(`Estratégia "${strat.name}" está inativa.`);
    if (strat.positionOpen) throw new Error(`Estratégia "${strat.name}" já possui posição aberta.`);

    const key = await resolveExchangeKey(strat);
    const exchange = await getExchange(key);

    log.info(`🚀 Executando arbitragem [${strat.name}] | ${dryRun ? 'DRY-RUN' : 'LIVE'}`);

    // Utiliza diretamente os preços capturados na detecção da oportunidade/estratégia para execução instantânea
    const freshLegs = (strat.legs || []).map((leg: any) => ({
      symbol: leg.symbol,
      side: leg.side as 'buy' | 'sell',
      price: Number(leg.price || 0),
    }));
    log.info(`⚡ [${strat.name}] Execução instantânea com preços capturados: ${freshLegs.map((l: any) => `${l.symbol}=${l.price}`).join(', ')}`);

    const minProfitPct = Number(strat.minProfitPct || 0.05);
    const expectedProfitPct = Number(strat.expectedProfitPct || 0);
    const forceRun = opts.forceFirstExecution ?? strat.forceFirstExecution ?? true;

    if (!forceRun && expectedProfitPct < minProfitPct) {
      const msg = `⛔ [${strat.name}] Retorno esperado (${expectedProfitPct.toFixed(3)}%) abaixo do mínimo (${minProfitPct}%). Abortando execução.`;
      log.warn(msg);
      throw new Error(msg);
    }

    const tradeSize = Number(strat.tradeSize || 100);

    const trade: any = await ForexArbTrade.create({
      userId: strat.userId,
      strategyId: strat._id,
      strategyName: strat.name,
      exchangeId: strat.exchangeId,
      type: 'execution',
      status: dryRun ? 'simulated' : 'detected',
      legs: freshLegs,
      amount: tradeSize,
      expectedProfitPct,
    });

    if (dryRun) {
      trade.status = 'simulated';
      await trade.save();
      await (ForexArbStrategy as any).findByIdAndUpdate(strat._id, {
        positionOpen: true, positionOpenedAt: new Date(), positionSize: tradeSize, status: 'open',
      });
      return trade;
    }

    // Calcula quantidades por perna
    const amounts = computeLegAmounts(freshLegs, tradeSize);
    log.info(`📐 [${strat.name}] Quantidades calculadas por perna: ${amounts.map((a: any) => `${a.side.toUpperCase()} ${a.amount.toFixed(4)} ${a.symbol}`).join(' | ')}`);

    // Submissão direta para a cTrader
    log.info(`🚀 [${strat.name}] Disparando ordem a mercado na cTrader via WebSocket...`);

    // Executa as pernas sequencialmente
    const executed: Array<{ symbol: string; side: 'buy' | 'sell'; amount: number }> = [];
    for (let i = 0; i < amounts.length; i++) {
      const leg = amounts[i];
      try {
        const order = await withTimeout(
          exchange.createMarketOrder(leg.symbol, leg.side, leg.amount),
          15000, null
        );
        if (!order) throw new Error(`Timeout ao executar ${leg.symbol}`);
        executed.push({ symbol: leg.symbol, side: leg.side, amount: leg.amount });
        log.info(`✅ Perna ${i + 1}/${amounts.length}: ${leg.side.toUpperCase()} ${leg.amount.toFixed(6)} ${leg.symbol} (${(order as any)?.id || 'ok'})`);
      } catch (e: any) {
        log.error(`❌ Falha na perna ${i + 1} (${leg.symbol}):`, e.message);
        // Reverte pernas já executadas para não ficar exposto
        await reverseLegs(exchange, executed);
        await recordLoss(strat, tradeSize * 0.002);
        throw new Error(`Falha na perna ${leg.symbol}: ${e.message}`);
      }
    }

    trade.status = 'executed';
    trade.legs = amounts.map((l) => ({ symbol: l.symbol, side: l.side, price: l.price, amount: l.amount }));
    await trade.save();

    await (ForexArbStrategy as any).findByIdAndUpdate(strat._id, {
      positionOpen: true,
      positionOpenedAt: new Date(),
      positionSize: tradeSize,
      status: 'open',
      forceFirstExecution: false,
      legs: amounts.map((l) => ({ symbol: l.symbol, side: l.side, price: l.price, amount: l.amount })),
    });



    log.info(`✅ [${strat.name}] Arbitragem ABERTA (${amounts.length} pernas, ${tradeSize} USDT).`);
    return trade;

  } finally {
    await unlockStrategy(strategyId);
  }
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const strategyId = process.argv[2];
    const action = process.argv[3] || 'open'; // 'open' | 'close'
    const dry = !process.argv.includes('--live');
    if (!strategyId) {
      log.error('Uso: npx tsx forex-arb-executor.ts <strategyId> [open|close] [--live]');
      process.exit(1);
    }
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI required');
    await connectToDatabase();
    const result = action === 'close'
      ? await closeArbitrage(strategyId, { dryRun: dry })
      : await executeArbitrage(strategyId, { dryRun: dry });
    log.info('Resultado:', result);
    process.exit(0);
  })().catch(err => { log.error(err); process.exit(1); });
}
