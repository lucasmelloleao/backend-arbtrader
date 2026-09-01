// Scanner de Arbitragem Forex (simples e triangular) dentro de uma corretora.
// Usa ccxt sem chave (dados públicos de tickers) para detectar oportunidades
// e calcular o retorno LÍQUIDO após taxas. Não envia ordens.
import ccxt from 'ccxt';
import mongoose from 'mongoose';
import ForexArbTrade from '../../models/ForexArbTrade';
import { CtraderAdapter } from './ctrader/ctrader-adapter';
import { buildCtraderAdapter } from './ctrader/ctrader-factory';
import { isFixExchange, buildFixAdapter } from './fix/fix-factory';
import { isDukascopyExchange, buildDukascopyAdapter } from './dukascopy/dukascopy-factory';

const getTs = () => `[${new Date().toISOString()}]`;
const log = {
  info: (...args: any[]) => console.log(getTs(), '[FOREX-SCANNER]', ...args),
  warn: (...args: any[]) => console.warn(getTs(), '[FOREX-SCANNER]', ...args),
  error: (...args: any[]) => console.error(getTs(), '[FOREX-SCANNER]', ...args),
};

export const SCANNER_CONFIG = {
  minProfitPct: 0.05,        // retorno líquido mínimo (%) para considerar
  minVolume24hUSD: 20000,
  scanIntervalMs: 60_000,
  maxStrategiesPerScan: 5,
  maxPairs: 60,              // máximo de pares analisados por exchange
  takerFeePct: 0.001,        // taxa taker padrão (0.1%) — usado quando market não expõe
};

export type ForexLeg = {
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
};

export type ForexOpportunity = {
  exchangeId: string;
  type: 'simple' | 'triangular';
  legs: ForexLeg[];
  expectedProfitPct: number;  // retorno líquido após taxas (%)
  grossProfitPct: number;     // retorno bruto antes de taxas (%)
  totalFeePct: number;
  volume24hUSD: number;
  last: number;
};

// ─── Filtro FOREX (fiat) ─────────────────────────────────────────────────────
// Considera pares onde a moeda BASE é fiat/metal, e a quote é:
//   - outra fiat/metal (ex: EUR/USD, GBP/JPY, XAU/USD) — broker tradicional
//   - USDT/USDC (ex: EUR/USDT, GBP/USDT, BRL/USDT) — formato da MEXC "Forex" (TradFi)
// NÃO inclui cripto puro (BTC/USDT, ETH/USDT etc.).
const FOREX_QUOTES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'XAU', 'XAG', 'TRY', 'BRL'];
const FOREX_BASE = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'XAU', 'XAG', 'TRY', 'BRL'];

function isForexPair(symbol: string): boolean {
  if (!symbol.includes('/')) return false;
  const [baseRaw, quoteRaw] = symbol.split('/');
  const base = baseRaw.toUpperCase();
  const quote = (quoteRaw.split(':')[0] || '').toUpperCase();
  // Base precisa ser fiat/metal. Quote pode ser fiat/metal ou stablecoin (MEXC).
  if (!FOREX_BASE.includes(base)) return false;
  return FOREX_QUOTES.includes(quote) || quote === 'USDT' || quote === 'USDC';
}

function baseOf(symbol: string): string {
  return symbol.split('/')[0].toUpperCase();
}

function quoteOf(symbol: string): string {
  return (symbol.split('/')[1]?.split(':')[0] || '').toUpperCase();
}

const PRIORITY_QUOTES = ['EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'XAU', 'XAG', 'USD'];

function quoteRankOf(sym: string): number {
  const q = quoteOf(sym);
  const idx = PRIORITY_QUOTES.indexOf(q);
  return idx === -1 ? PRIORITY_QUOTES.length : idx;
}

// Encontra o símbolo de um par (base/quote) no market da exchange, tentando
// variações comuns (ex: BTC/USDT, BTCUSDT, XAU/USD, BTC/USD:BTC — perp delivery
// da MEXC com sufixo :XXX).
function findPairSymbol(markets: Record<string, any>, base: string, quote: string): string | null {
  const candidates = [
    `${base}/${quote}`,
    `${base}/${quote}:${quote}`,
    `${base}${quote}`,
  ];
  for (const c of candidates) {
    if (markets[c]) return c;
  }
  // Busca case-insensitive, aceitando qualquer sufixo ':XXX' (ex: BTC/USD:BTC)
  const upperBase = base.toUpperCase();
  const upperQuote = quote.toUpperCase();
  for (const key of Object.keys(markets)) {
    const [symPart] = key.split(':');
    const [b, q] = symPart.split('/');
    if (b && q && b.toUpperCase() === upperBase && q.toUpperCase() === upperQuote) return key;
  }
  return null;
}

// Calcula o retorno líquido de uma rota triangular A->B->C->A.
// Para cada perna, se o par é base/quote e queremos converter base->quote,
// usamos o BID (vendemos base); para quote->base usamos o ASK (compramos base).
// Retorno = produto das taxas de conversão - 1 - taxas de cada perna.
export function computeTriangularReturn(
  markets: Record<string, any>,
  tickers: Record<string, any>,
  a: string,
  b: string,
  c: string,
  takerFeePct: number,
): { profitPct: number; grossPct: number; feePct: number; legs: ForexLeg[] } | null {
  // Rota: A -> B -> C -> A
  const pairs: Array<[string, string, 'a_to_b' | 'b_to_a']> = [
    [a, b, 'a_to_b'],
    [b, c, 'a_to_b'],
    [c, a, 'a_to_b'],
  ];

  let product = 1;
  let feePct = 0;
  const legs: ForexLeg[] = [];

  for (const [from, to, dir] of pairs) {
    const sym = findPairSymbol(markets, from, to);
    const invSym = findPairSymbol(markets, to, from);
    const ticker = tickers[sym!] || tickers[invSym!];
    if (!ticker) return null;

    // Se o par direto from/to existe, usamos a conversão direta
    if (sym) {
      // Converter from -> to: se o par é from/to, vendemos from (bid)
      const price = ticker.bid || ticker.last;
      if (!price || price <= 0) return null;
      // 1 from -> price to
      product *= price;
      const market = markets[sym];
      const fee = market?.taker ?? takerFeePct;
      feePct += fee * 100;
      legs.push({ symbol: sym, side: 'sell', price });
    } else if (invSym) {
      // Par inverso to/from: converter from -> to = comprar to (ask no par to/from)
      // 1 from = 1/ask to
      const price = ticker.ask || ticker.last;
      if (!price || price <= 0) return null;
      product *= 1 / price;
      const market = markets[invSym];
      const fee = market?.taker ?? takerFeePct;
      feePct += fee * 100;
      legs.push({ symbol: invSym, side: 'buy', price });
    } else {
      return null;
    }
  }

  const grossPct = (product - 1) * 100;
  const profitPct = grossPct - feePct;
  return { profitPct, grossPct, feePct, legs };
}

// Arbitragem simples: discrepância entre dois pares que compartilham uma moeda.
// Ex: se BTC/USD e BTC/EUR implicam uma taxa EUR/USD diferente do par real EUR/USD,
// há oportunidade. Aqui calculamos pares A/X vs A/Y vs X/Y (mesma lógica do triangular,
// mas o scanner prioriza triangular que é o caso mais comum).
export function computeSimpleReturn(
  markets: Record<string, any>,
  tickers: Record<string, any>,
  base: string,
  quote1: string,
  quote2: string,
  takerFeePct: number,
): { profitPct: number; grossPct: number; feePct: number; legs: ForexLeg[] } | null {
  // base/quote1 e base/quote2 e quote1/quote2
  return computeTriangularReturn(markets, tickers, base, quote1, quote2, takerFeePct);
}

// Corretoras que usam o adaptador cTrader (Open API protobuf) em vez de CCXT.
export function isCtraderExchange(exchangeId: string): boolean {
  return exchangeId === 'ctrader' || exchangeId === 'pepperstone';
}

// Re-exporta o factory compartilhado (criação a partir de ExchangeKey + cache).
export { buildCtraderAdapter };

export async function scanForexArbitrage(exchangeId: string, config: any, key?: any, adapterOverride?: any): Promise<ForexOpportunity[]> {
  const t0 = Date.now();
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI!, { dbName: 'TraderProd' });
  }

  // ─── cTrader (Open API) / FIX / Dukascopy: adaptadores com chave ─
  if (isCtraderExchange(exchangeId) || isFixExchange(exchangeId) || isDukascopyExchange(exchangeId)) {
    if (!key) {
      log.warn(`⚠️ ForexScanner [${exchangeId}]: exige uma ExchangeKey cadastrada. Pulando.`);
      return [];
    }
    let adapter: any = null;
    let ownsAdapter = false;
    try {
      if (adapterOverride) {
        adapter = adapterOverride;
      } else {
        adapter = isFixExchange(exchangeId) ? buildFixAdapter(key)
          : isDukascopyExchange(exchangeId) ? buildDukascopyAdapter(key)
          : buildCtraderAdapter(key);
        ownsAdapter = true;
      }
      await adapter.connect();
      const markets = await adapter.loadMarkets();
      const allPairs = Object.keys(markets).filter(isForexPair);
      const pairSymbolsSorted = allPairs
        .sort((a, b) => quoteRankOf(a) - quoteRankOf(b) || a.localeCompare(b));
      const topPairs = pairSymbolsSorted.slice(0, config.maxPairs || SCANNER_CONFIG.maxPairs);
      log.info(`🔍 ForexScanner [${exchangeId}]: ${allPairs.length} pares forex (fiat/metal), analisando ${topPairs.length}`);

      if (topPairs.length === 0) {
        log.warn(`⚠️ ForexScanner [${exchangeId}]: nenhum par forex encontrado na conta.`);
        if (ownsAdapter) await adapter.destroy().catch(() => {});
        return [];
      }

      const tickers = await adapter.fetchTickers(topPairs);

      const takerFeePct = SCANNER_CONFIG.takerFeePct;
      const opportunities: ForexOpportunity[] = [];
      const seenRoutes = new Set<string>();

      const currencies = new Map<string, Set<string>>();
      for (const sym of topPairs) {
        const base = baseOf(sym);
        const quote = quoteOf(sym);
        if (!currencies.has(quote)) currencies.set(quote, new Set());
        currencies.get(quote)!.add(base);
      }

      const maxTriangles = config.maxTrianglesPerScan || 200;
      let trianglesChecked = 0;
      const nearMisses: Array<{ route: string; grossPct: number; netPct: number; feePct: number; legs: ForexLeg[] }> = [];
      const missingCrossPairs = new Set<string>();

      for (const [quote, bases] of currencies) {
        const baseList = Array.from(bases);
        for (let i = 0; i < baseList.length && trianglesChecked < maxTriangles; i++) {
          for (let j = i + 1; j < baseList.length && trianglesChecked < maxTriangles; j++) {
            const b1 = baseList[i];
            const b2 = baseList[j];
            trianglesChecked++;

            const crossSym = findPairSymbol(markets as any, b1, b2);
            const crossInv = findPairSymbol(markets as any, b2, b1);
            if (!crossSym && !crossInv) {
              if (missingCrossPairs.size < 20) missingCrossPairs.add(`${b1}/${b2} (ou ${b2}/${b1})`);
              continue;
            }

            const result = computeTriangularReturn(markets as any, tickers as any, b1, b2, quote, takerFeePct);
            if (!result) continue;

            // Filtro de moeda inicial: o robô opera com USD na carteira, então a
            // primeira perna do ciclo (b1 -> b2) deve partir de USD. A rota é
            // b1 -> b2 -> quote -> b1; exigimos b1 = USD (ex: USD -> EUR -> GBP -> USD).
            if (b1 !== 'USD') continue;

            const routeKey = [b1, b2, quote].sort().join('-');
            if (seenRoutes.has(routeKey)) continue;
            seenRoutes.add(routeKey);

            const routeLabel = `${b1}->${b2}->${quote}->${b1}`;

            if (nearMisses.length < 50) {
              nearMisses.push({ route: routeLabel, grossPct: result.grossPct, netPct: result.profitPct, feePct: result.feePct, legs: result.legs });
            }

            const isMinProfitable = result.profitPct >= (config.minProfitPct ?? SCANNER_CONFIG.minProfitPct);
            if (!isMinProfitable && !config.forceFirstExecution) {
              continue;
            }

            // cTrader/FIX não expõem volume 24h por ticker → pula o filtro de volume.
            const volume24hUSD = result.legs.reduce((acc, leg) => {
              const tk = tickers[leg.symbol];
              return acc + (tk?.quoteVolume || 0);
            }, 0);

            const skipVolume = typeof config.skipVolumeFilter === 'function'
              ? config.skipVolumeFilter(exchangeId)
              : config.skipVolumeFilter === true;
            if (skipVolume || volume24hUSD >= (config.minVolume24hUSD ?? SCANNER_CONFIG.minVolume24hUSD)) {
              opportunities.push({
                exchangeId,
                type: 'triangular',
                legs: result.legs,
                expectedProfitPct: result.profitPct,
                grossProfitPct: result.grossPct,
                totalFeePct: result.feePct,
                volume24hUSD: volume24hUSD || 1, // evita zerado na UI
                last: result.legs[0]?.price || 0,
              });
            }
          }
        }
      }

      // Se forçar a primeira execução e nenhuma rota superou o filtro, pega a melhor rota testada (nearMisses)
      if (opportunities.length === 0 && config.forceFirstExecution && nearMisses.length > 0) {
        nearMisses.sort((a, b) => b.netPct - a.netPct);
        const best = nearMisses[0];
        log.info(`⚡ [FORCE FIRST EXECUTION] Nenhuma oportunidade acima do lucro mínimo. Forçando melhor rota encontrada: ${best.route} (Net: ${best.netPct.toFixed(4)}%)`);
        opportunities.push({
          exchangeId,
          type: 'triangular',
          legs: (best as any).legs,
          expectedProfitPct: best.netPct,
          grossProfitPct: best.grossPct,
          totalFeePct: best.feePct,
          volume24hUSD: 1,
          last: (best as any).legs[0]?.price || 0,
        });
      }

      log.info(`🔀 ForexScanner [${exchangeId}] — ${trianglesChecked} triângulos testados (${seenRoutes.size} rotas válidas, ${opportunities.length} acima do mínimo)`);
      if (missingCrossPairs.size > 0) {
        log.info(`   ⛔ Pares cruzados AUSENTES (impedem o triângulo): ${Array.from(missingCrossPairs).join(', ')}`);
      }
      if (opportunities.length > 0) {
        for (const op of opportunities.slice(0, 10)) {
          log.info(`      ${op.legs.map(l => l.symbol).join(' -> ')} | Gross ${op.grossProfitPct.toFixed(4)}% | Fees ${op.totalFeePct.toFixed(3)}% | Net ${op.expectedProfitPct.toFixed(4)}%`);
        }
      }

      opportunities.sort((a, b) => b.expectedProfitPct - a.expectedProfitPct);

      log.info(`\n🏆 TOP Forex Arbitrage Opportunities [${exchangeId}] (líquido após taxas):`);
      log.info('\n' + opportunities.slice(0, 10).map((op, i) =>
        `  ${String(i + 1).padStart(2)}. ${op.type.toUpperCase().padEnd(10)} | ${op.legs.map(l => l.symbol).join(' -> ')} | Net: ${op.expectedProfitPct.toFixed(4)}% | Gross: ${op.grossProfitPct.toFixed(4)}% | Fees: ${op.totalFeePct.toFixed(3)}%`
      ).join('\n'));

      if (ownsAdapter) await adapter.destroy().catch(() => {});
      log.info(`⏱️ ForexScanner [${exchangeId}]: TOTAL ${Date.now() - t0}ms, oportunidades=${opportunities.length}`);
      return opportunities;
    } catch (e: any) {
      log.warn(`⚠️ ForexScanner [${exchangeId}] abortado: ${e.message}`);
      if (ownsAdapter) await adapter?.destroy().catch(() => {});
      return [];
    }
  }

  // ─── CCXT (corretoras cripto) ───────────────────────────────────────────────
  const ccxtId = exchangeId === 'gateio' ? 'gate' : exchangeId;
  let exchange: any = null;
  try {
    exchange = new (ccxt as any)[ccxtId]({
      enableRateLimit: true,
      timeout: 10000,
      options: { fetchCurrencies: false },
    });
  } catch (e: any) {
    log.warn(`⚠️ ForexScanner [${exchangeId}] não suportada pelo ccxt: ${e.message}`);
    return [];
  }
  exchange.has = { ...(exchange.has || {}), fetchCurrencies: false };

  const timeout = (ms: number, label: string) =>
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        try { exchange.destroy(); } catch {}
        reject(new Error(`${label} timeout após ${ms}ms`));
      }, ms)
    );

  let markets: any = {};
  try {
    markets = await Promise.race([exchange.loadMarkets(), timeout(20000, 'loadMarkets')]);
  } catch (e: any) {
    log.warn(`⚠️ ForexScanner [${exchangeId}] abortado em loadMarkets: ${e.message}`);
    try { exchange.destroy(); } catch {}
    return [];
  }

  // Filtra APENAS pares forex (fiat/fiat + metais), deduplicando: se existir
  // o mesmo par no formato spot (sem ':') e com sufixo (ex: EUR/USD e EUR/USD:EUR),
  // mantém apenas o spot.
  const pairSymbols = Object.keys(markets)
    .filter(isForexPair)
    .filter((sym, i, arr) => {
      const spot = sym.split(':')[0];
      const hasSuffix = sym.includes(':');
      if (!hasSuffix) return true;
      // Mantém o com sufixo apenas se o spot equivalente NÃO existe
      return !arr.includes(spot);
    });

  // Prioriza os majors forex (EUR, GBP, JPY, CHF, AUD, CAD, NZD) e metais
  // antes dos demais — evita pares exóticos pouco líquidos.
  const pairSymbolsSorted = [...pairSymbols].sort((a, b) => quoteRankOf(a) - quoteRankOf(b) || a.localeCompare(b));
  const topPairs = pairSymbolsSorted.slice(0, config.maxPairs || SCANNER_CONFIG.maxPairs);
  log.info(`🔍 ForexScanner [${exchangeId}]: ${pairSymbols.length} pares forex (fiat/metal), analisando ${topPairs.length}`);

  // Sem pares forex na corretora (ex: MEXC não lista fiat-fiat): encerra sem erro
  if (topPairs.length === 0) {
    log.warn(`⚠️ ForexScanner [${exchangeId}]: nenhum par forex encontrado. Corretora não suporta fiat-fiat ou requer chave (broker forex).`);
    try { exchange.destroy(); } catch {}
    return [];
  }

  // Log detalhado dos pares analisados, agrupados por moeda quote (contexto p/ avaliação)
  const pairsByQuote = new Map<string, string[]>();
  for (const sym of topPairs) {
    const quote = quoteOf(sym);
    if (!pairsByQuote.has(quote)) pairsByQuote.set(quote, []);
    pairsByQuote.get(quote)!.push(sym);
  }
  log.info(`📋 ForexScanner [${exchangeId}] — Pares analisados por moeda quote (${pairsByQuote.size} grupos):`);
  for (const [quote, syms] of pairsByQuote) {
    log.info(`   ${quote}: ${syms.join(', ')}`);
  }

  let tickers: any = {};
  try {
    tickers = await Promise.race([exchange.fetchTickers(topPairs), timeout(20000, 'fetchTickers')]);
  } catch (e: any) {
    log.warn(`⚠️ ForexScanner [${exchangeId}] abortado em fetchTickers: ${e.message}`);
    try { exchange.destroy(); } catch {}
    return [];
  }

  const takerFeePct = SCANNER_CONFIG.takerFeePct;
  const opportunities: ForexOpportunity[] = [];
  const seenRoutes = new Set<string>();

  // Agrupa moedas por quote para montar triângulos
  const currencies = new Map<string, Set<string>>(); // quote -> Set<base>
  for (const sym of topPairs) {
    const base = baseOf(sym);
    const quote = quoteOf(sym);
    if (!currencies.has(quote)) currencies.set(quote, new Set());
    currencies.get(quote)!.add(base);
  }

  // Gera triângulos: para cada moeda central Q com bases [B1, B2, ...],
  // testa B1/Q -> B2/Q -> B1/B2 (ou inversos)
  const maxTriangles = config.maxTrianglesPerScan || 200;
  let trianglesChecked = 0;
  const nearMisses: Array<{ route: string; grossPct: number; netPct: number; feePct: number }> = [];
  const missingCrossPairs = new Set<string>();

  for (const [quote, bases] of currencies) {
    const baseList = Array.from(bases);
    for (let i = 0; i < baseList.length && trianglesChecked < maxTriangles; i++) {
      for (let j = i + 1; j < baseList.length && trianglesChecked < maxTriangles; j++) {
        const b1 = baseList[i];
        const b2 = baseList[j];
        trianglesChecked++;

        // Rota: b1 -> b2 -> quote -> b1 (usando pares b1/quote, b2/quote, b1/b2)
        // Se o par cruzado b1/b2 não existe no mercado, registra para o log
        const crossSym = findPairSymbol(markets, b1, b2);
        const crossInv = findPairSymbol(markets, b2, b1);
        if (!crossSym && !crossInv) {
          if (missingCrossPairs.size < 20) {
            missingCrossPairs.add(`${b1}/${b2} (ou ${b2}/${b1})`);
          }
          continue;
        }

        const result = computeTriangularReturn(markets, tickers, b1, b2, quote, takerFeePct);
        if (!result) continue;

        const routeKey = [b1, b2, quote].sort().join('-');
        if (seenRoutes.has(routeKey)) continue;
        seenRoutes.add(routeKey);

        const routeLabel = `${b1}->${b2}->${quote}->${b1}`;

        // Registra rotas que ficaram próximas do mínimo (contexto de oportunidades perdidas)
        if (result.profitPct < (config.minProfitPct ?? SCANNER_CONFIG.minProfitPct)) {
          if (nearMisses.length < 30) {
            nearMisses.push({ route: routeLabel, grossPct: result.grossPct, netPct: result.profitPct, feePct: result.feePct });
          }
          continue;
        }

        const volume24hUSD = result.legs.reduce((acc, leg) => {
          const tk = tickers[leg.symbol];
          return acc + (tk?.quoteVolume || 0);
        }, 0);

        if (volume24hUSD >= (config.minVolume24hUSD ?? SCANNER_CONFIG.minVolume24hUSD)) {
          opportunities.push({
            exchangeId,
            type: 'triangular',
            legs: result.legs,
            expectedProfitPct: result.profitPct,
            grossProfitPct: result.grossPct,
            totalFeePct: result.feePct,
            volume24hUSD,
            last: result.legs[0]?.price || 0,
          });
        }
      }
    }
  }

  // Log das rotas testadas (contexto: triângulos válidos e quase-oportunidades)
  log.info(`🔀 ForexScanner [${exchangeId}] — ${trianglesChecked} triângulos testados (${seenRoutes.size} rotas válidas, ${opportunities.length} acima do mínimo ${config.minProfitPct ?? SCANNER_CONFIG.minProfitPct}%)`);
  if (missingCrossPairs.size > 0) {
    log.info(`   ⛔ Pares cruzados AUSENTES (impedem o triângulo): ${Array.from(missingCrossPairs).join(', ')}`);
    log.info(`      → Com apenas pares fiat/USDT (MEXC), não há par fiat-fiat para fechar o triângulo. Triangular exige corretora com pares cruzados (ex: OANDA).`);
  }
  if (opportunities.length > 0) {
    log.info(`   ✅ Rotas com retorno líquido ≥ mínimo:`);
    for (const op of opportunities.slice(0, 10)) {
      log.info(`      ${op.legs.map(l => l.symbol).join(' -> ')} | Gross ${op.grossProfitPct.toFixed(4)}% | Fees ${op.totalFeePct.toFixed(3)}% | Net ${op.expectedProfitPct.toFixed(4)}%`);
    }
  }
  if (nearMisses.length > 0) {
    log.info(`   ⚠️ Quase-oportunidades (abaixo do mínimo, até 30):`);
    for (const nm of nearMisses) {
      log.info(`      ${nm.route} | Gross ${nm.grossPct.toFixed(4)}% | Fees ${nm.feePct.toFixed(3)}% | Net ${nm.netPct.toFixed(4)}%`);
    }
  }

  opportunities.sort((a, b) => b.expectedProfitPct - a.expectedProfitPct);

  log.info(`\n🏆 TOP Forex Arbitrage Opportunities [${exchangeId}] (líquido após taxas):`);
  log.info('\n' + opportunities.slice(0, 10).map((op, i) =>
    `  ${String(i + 1).padStart(2)}. ${op.type.toUpperCase().padEnd(10)} | ${op.legs.map(l => l.symbol).join(' -> ')} | Net: ${op.expectedProfitPct.toFixed(4)}% | Gross: ${op.grossProfitPct.toFixed(4)}% | Fees: ${op.totalFeePct.toFixed(3)}% | Vol: $${Math.round(op.volume24hUSD).toLocaleString()}`
  ).join('\n'));

  try { exchange.destroy(); } catch {}
  if (global.gc) global.gc();

  log.info(`⏱️ ForexScanner [${exchangeId}]: TOTAL ${Date.now() - t0}ms, oportunidades=${opportunities.length} (triângulos testados: ${trianglesChecked})`);
  return opportunities;
}

export async function cleanupSkippedTrades(): Promise<void> {
  await ForexArbTrade.deleteMany({ status: { $in: ['skipped', 'failed'] } }).catch(() => null);
}
