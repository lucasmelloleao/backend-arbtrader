// Scanner de prediction markets: busca mercados na Gamma API, calcula
// spreads de completude e cria/atualiza estratégias no banco.
import PredictionArbStrategy from '../../models/PredictionArbStrategy';
import ExchangeKey from '../../models/ExchangeKey';
import { fetchOpenMarkets, fetchMarketBySlug, invalidateMarketsCache, GammaMarket } from './helpers/gamma-client';
import { fetchBook } from './helpers/clob-client';
import { completenessSpreadPct } from './helpers/pricing';
import { PREDICTION_ARB_CONFIG } from '../../config/prediction-arb';

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
};

export interface ScanConfig {
  minSpreadPct: number;
  minVolume24hUSD: number;
  maxStrategiesPerScan: number;
  tradeSize: number;
  allowedMarkets?: string[];
  /** Filtro opcional por termo no slug (ex: 'btc') — monitora só mercados que contêm o termo. */
  marketFilter?: string;
  /** Moedas para monitorar mercados updown (ex: ['btc','eth','sol']) — busca os slugs gerados. */
  marketCoins?: string[];
  /** Probabilidade mínima para entrada direcional de alta certeza (ex: 0.95 = 95%). */
  minHighCertaintyProb?: number;
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Calcula o spread de completude REAL usando o order book do CLOB.
 * A arbitragem é executada comprando nos BIDS dos dois lados:
 * spreadExecutavel = 1 - (bidYes + bidNo). Usa o melhor bid de cada lado.
 */
export async function fetchBookSpread(
  m: GammaMarket,
  minDepthUsd: number = PREDICTION_ARB_CONFIG.scan.minDepthUsdBase
): Promise<{ bidYes: number; bidNo: number; askYes: number; askNo: number; spreadPct: number; depthOk: boolean }> {
  let bidYes = 0;
  let bidNo = 0;
  let askYes = 0;
  let askNo = 0;
  let depthOk = true;

  try {
    if (m.clobTokenIds?.[0]) {
      const book = await fetchBook(m.clobTokenIds[0]);
      // bids já normalizados (melhor primeiro) pelo fetchBook
      bidYes = book.bids[0]?.[0] || 0;
      askYes = book.asks[0]?.[0] || 0;
      // Profundidade acumulada no melhor bid (lado YES)
      let depth = 0;
      for (const [p, size] of book.bids) {
        if (p <= 0) continue;
        depth += p * size;
        if (depth >= minDepthUsd) break;
      }
      if (depth < minDepthUsd) depthOk = false;
    }
  } catch {}
  try {
    if (m.clobTokenIds?.[1]) {
      const book = await fetchBook(m.clobTokenIds[1]);
      bidNo = book.bids[0]?.[0] || 0;
      askNo = book.asks[0]?.[0] || 0;
      // Corr. 3: profundidade também no lado NO — antes só o YES era checado,
      // então mercado com book fino de um lado passava como "ok".
      let depthNo = 0;
      for (const [p, size] of book.bids) {
        if (p <= 0) continue;
        depthNo += p * size;
        if (depthNo >= minDepthUsd) break;
      }
      if (depthNo < minDepthUsd) depthOk = false;
    }
  } catch {}

  // Spread executável: comprar nos bids dos dois lados
  const spreadPct = bidYes > 0 && bidNo > 0 ? completenessSpreadPct({ yes: bidYes, no: bidNo }) : 0;
  return { bidYes, bidNo, askYes, askNo, spreadPct, depthOk };
}

export interface MarketOpportunity {
  market: GammaMarket;
  yes: number;
  no: number;
  spreadPct: number;
  bidYes: number;
  bidNo: number;
  volume: number;
  /** false se o book não tinha profundidade mínima. */
  depthOk?: boolean;
  /** Direção de alta certeza (YES ou NO com prob >= 0.95) */
  highCertaintySide?: 'YES' | 'NO';
  certaintyProb?: number;
}

/** Filtra e ordena mercados (foco exclusivo em entradas direcionais com alta certeza). */
export async function evaluateMarketsWithBooks(markets: GammaMarket[], config: ScanConfig): Promise<MarketOpportunity[]> {
  const allowed = new Set((config.allowedMarkets || []).map((s) => s.toLowerCase()));
  const filter = String(config.marketFilter || '').toLowerCase();
  const maxHorizonMs = 60 * 60 * 1000; // Máximo 1 hora para vencer (descarta mercados longos)
  const minProb = Number(config.minHighCertaintyProb ?? PREDICTION_ARB_CONFIG.scan.minHighCertaintyProb ?? 0.95);

  const candidates = markets.filter((m) => {
    if (!m.active || m.closed) return false;
    if (m.endDate && new Date(m.endDate).getTime() < Date.now()) return false;
    // Elimina mercados que vão vencer daqui a mais de 1 hora
    if (m.endDate && new Date(m.endDate).getTime() > Date.now() + maxHorizonMs) return false;
    if (allowed.size > 0 && !allowed.has(String(m.slug || '').toLowerCase())) return false;
    if (filter && !String(m.slug || '').toLowerCase().includes(filter) && !String(m.question || '').toLowerCase().includes(filter)) return false;
    if (toNum(m.volumeNum) < config.minVolume24hUSD) return false;
    return m.clobTokenIds?.length >= 2;
  });

  const minDepthUsdScan = Math.max(
    PREDICTION_ARB_CONFIG.scan.minDepthUsdBase,
    Number(config.tradeSize ?? PREDICTION_ARB_CONFIG.scan.tradeSize) * PREDICTION_ARB_CONFIG.scan.depthMultiplier
  );
  const evaluated: MarketOpportunity[] = [];
  for (const m of candidates.slice(0, 30)) {
    const book = await fetchBookSpread(m, minDepthUsdScan);
    const gammaYes = toNum(m.outcomePrices?.[0]);
    const gammaNo = toNum(m.outcomePrices?.[1]);
    const yes = book.bidYes || gammaYes;
    const no = book.bidNo || gammaNo;
    const spreadPct = book.spreadPct || completenessSpreadPct({ yes, no });

    let highCertaintySide: 'YES' | 'NO' | undefined;
    let certaintyProb = 0;

    if (yes >= minProb) {
      highCertaintySide = 'YES';
      certaintyProb = yes;
    } else if (no >= minProb) {
      highCertaintySide = 'NO';
      certaintyProb = no;
    }

    if (highCertaintySide) {
      evaluated.push({
        market: m,
        yes,
        no,
        spreadPct,
        bidYes: book.bidYes,
        bidNo: book.bidNo,
        volume: toNum(m.volumeNum),
        depthOk: book.depthOk,
        highCertaintySide,
        certaintyProb,
      });
    }
  }

  return evaluated
    .filter((e) => e.depthOk !== false)
    .sort((a, b) => (b.certaintyProb || 0) - (a.certaintyProb || 0))
    .slice(0, config.maxStrategiesPerScan);
}

/** Cria estratégias para as oportunidades (ou atualiza preços das existentes). */
export async function createStrategiesFromMarkets(
  userId: string,
  opportunities: MarketOpportunity[],
  config: ScanConfig,
  exchangeKeyId?: string,
  autoExecute = false
): Promise<number> {
  let created = 0;
  for (const opp of opportunities) {
    const m = opp.market;
    const existing = await PredictionArbStrategy.findOne({ userId, marketId: m.id }).lean();

    if (existing) {
      await PredictionArbStrategy.findByIdAndUpdate(existing._id, {
        yesPrice: opp.yes,
        noPrice: opp.no,
        spreadPct: opp.spreadPct,
        endDate: m.endDate ? new Date(m.endDate) : null,
        lastCheckAt: new Date(),
        // No modo colheita, garante que estratégias existentes também executem
        ...(autoExecute ? { autoExecute: true, mmActive: true } : {}),
      });
      continue;
    }

    await PredictionArbStrategy.create({
      userId,
      exchangeKeyId: exchangeKeyId || null,
      marketId: m.id,
      slug: m.slug,
      question: m.question,
      conditionId: m.conditionId,
      tokenIdYes: m.clobTokenIds?.[0],
      tokenIdNo: m.clobTokenIds?.[1],
      yesPrice: opp.yes,
      noPrice: opp.no,
      spreadPct: opp.spreadPct,
      endDate: m.endDate ? new Date(m.endDate) : null,
      tradeSize: config.tradeSize,
      active: true,
      // Com a colheita ativa (allowLiveTrading), executa automaticamente
      // via market making com inventário (cotação progressiva em par)
      autoExecute,
      mmActive: autoExecute,
      isAutoCreated: true,
      lastCheckAt: new Date(),
    });
    created++;
  }
  return created;
}

/** Busca um mercado específico (para criação manual via controller). */
export async function findMarket(slug: string): Promise<GammaMarket | null> {
  return fetchMarketBySlug(slug);
}

/**
 * Gera slugs de mercados updown rápidos de 5m e 15m (ex: btc-updown-5m-<ts>, btc-updown-15m-<ts>)
 * para os próximos N períodos e busca na Gamma.
 */
export async function fetchUpdownMarkets(filter: string, periodsAhead = 4): Promise<GammaMarket[]> {
  const raw = String(filter || '').toLowerCase().trim();
  const prefix = raw.includes('updown') ? raw.replace(/[^a-z0-9]/g, '-') : `${raw.replace(/[^a-z0-9]/g, '-')}-updown`;
  const now = Math.floor(Date.now() / 1000);
  const out: GammaMarket[] = [];

  // 1. Slugs de 5 Minutos (slots de 300s)
  const currentSlot5m = Math.floor(now / 300) * 300;
  for (let i = 0; i < periodsAhead; i++) {
    const ts = currentSlot5m + i * 300;
    const slug = `${prefix}-5m-${ts}`;
    try {
      const m = await fetchMarketBySlug(slug);
      if (m && m.active && !m.closed && m.clobTokenIds?.length >= 2) out.push(m);
    } catch {
      // período ainda não criado — ignora
    }
  }

  // 2. Slugs de 15 Minutos (slots de 900s)
  const currentSlot15m = Math.floor(now / 900) * 900;
  for (let i = 0; i < periodsAhead; i++) {
    const ts = currentSlot15m + i * 900;
    const slug = `${prefix}-15m-${ts}`;
    try {
      const m = await fetchMarketBySlug(slug);
      if (m && m.active && !m.closed && m.clobTokenIds?.length >= 2) out.push(m);
    } catch {
      // período ainda não criado — ignora
    }
  }
  return out;
}

/** Executa um scan completo e retorna o resumo. */
export async function runScan(userId: any, config: ScanConfig, autoExecute = false): Promise<{ scanned: number; created: number; updated: number }> {
  invalidateMarketsCache();
  let markets = await fetchOpenMarkets({ limit: 100 });

  // Moedas updown: busca slugs gerados para cada moeda configurada
  const coins = config.marketCoins && config.marketCoins.length ? config.marketCoins : (config.marketFilter ? [config.marketFilter] : []);
  if (coins.length) {
    const existing = new Set(markets.map((m) => m.slug));
    let found = 0;
    for (const coin of coins) {
      try {
        const updown = await fetchUpdownMarkets(coin);
        for (const m of updown) {
          if (!existing.has(m.slug)) {
            markets.push(m);
            existing.add(m.slug);
            found++;
          }
        }
      } catch (e: any) {
        log.warn(`⚠️ [PREDICTION SCAN] Falha ao buscar updown ${coin}: ${e.message}`);
      }
    }
    log.info(`🔍 [PREDICTION SCAN] Updown (${coins.join(',')}): ${found} mercado(s) adicionado(s) via slug.`);
  }

  const opportunities = await evaluateMarketsWithBooks(markets, config);
  const created = await createStrategiesFromMarkets(userId, opportunities, config, undefined, autoExecute);

  log.info(`🔍 [PREDICTION SCAN] Mercados avaliados: ${markets.length} | Oportunidades: ${opportunities.length} | Criadas: ${created}`);
  for (const opp of opportunities.slice(0, 5)) {
    log.info(`  - ${opp.market.slug} | spread=${opp.spreadPct.toFixed(2)}% | bidYes=${opp.bidYes} bidNo=${opp.bidNo}`);
  }

  return { scanned: markets.length, created, updated: 0 };
}

/** Resolve a ExchangeKey polymarket ativa do usuário (para trading). */
export async function resolvePolymarketKey(userId: string): Promise<any | null> {
  const key = await ExchangeKey.findOne({ userId, exchangeId: 'polymarket', active: true }).lean();
  return key || null;
}

export { log };
