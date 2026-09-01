// Cliente da Gamma API do Polymarket (dados públicos, sem autenticação).
// Fonte: https://gamma-api.polymarket.com
import { withTimeout } from '../../perpetuals/helpers/ccxt-factory';

// Pode apontar para o proxy (ex: POLYMARKET_GAMMA_BASE=https://proxy-...vercel.app/api/proxy/gamma)
// quando o servidor não alcança a Polymarket diretamente (região restrita).
// Lido em runtime: o loadEnv() roda depois dos imports serem hoisted.
function getGammaBase(): string {
  return process.env.POLYMARKET_GAMMA_BASE || 'https://gamma-api.polymarket.com';
}
const CACHE_TTL_MS = 30_000;

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${msg}`, ...args),
};

let marketsCache: { data: GammaMarket[]; at: number } | null = null;

/** Mercado binário conforme retornado pela Gamma API (campos usados pelo robô). */
export interface GammaMarket {
  id: string;
  slug: string;
  question: string;
  conditionId: string;
  clobTokenIds: string[]; // [tokenIdYes, tokenIdNo]
  outcomePrices: string[]; // ["0.47", "0.52"]
  volumeNum: number;
  liquidityNum: number;
  endDate: string;
  active: boolean;
  closed: boolean;
  umaResolutionStatus?: string;
  outcomes?: string[];
}

async function getJson(url: string): Promise<any> {
  const res = await withTimeout(fetch(url), 10_000, null);
  if (!res || !res.ok) return null;
  return res.json();
}

/** A Gamma API devolve alguns campos como strings JSON — normaliza para array. */
function parseJsonArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Normaliza um mercado bruto da Gamma para o formato interno. */
function normalizeMarket(m: any): GammaMarket | null {
  if (!m || !m.id || !m.slug) return null;
  const tokens = parseJsonArray(m.clobTokenIds);
  const prices = parseJsonArray(m.outcomePrices);
  return {
    id: String(m.id),
    slug: String(m.slug),
    question: String(m.question || m.slug),
    conditionId: String(m.conditionId || ''),
    clobTokenIds: tokens.map(String),
    outcomePrices: prices.map(String),
    volumeNum: Number(m.volumeNum || 0),
    liquidityNum: Number(m.liquidityNum || 0),
    endDate: m.endDate ? String(m.endDate) : '',
    active: m.active === true,
    closed: m.closed === true,
    umaResolutionStatus: m.umaResolutionStatus,
    outcomes: parseJsonArray(m.outcomes).map(String),
  };
}

/**
 * Lista mercados abertos ordenados por volume (default). Usa cache curto
 * para respeitar o rate-limit da API pública.
 */
export async function fetchOpenMarkets(opts: { limit?: number; order?: string } = {}): Promise<GammaMarket[]> {
  const { limit = 100, order = 'volumeNum' } = opts;
  if (marketsCache && Date.now() - marketsCache.at < CACHE_TTL_MS) {
    return marketsCache.data;
  }

  const url = `${getGammaBase()}/markets?closed=false&limit=${limit}&order=${order}&ascending=false`;
  const data = await getJson(url);
  const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  const normalized = list.map(normalizeMarket).filter(Boolean) as GammaMarket[];
  marketsCache = { data: normalized, at: Date.now() };
  return normalized;
}

/** Busca um mercado específico por slug ou id. */
export async function fetchMarketBySlug(slug: string): Promise<GammaMarket | null> {
  const url = `${getGammaBase()}/markets?slug=${encodeURIComponent(slug)}`;
  const data = await getJson(url);
  const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  return normalizeMarket(list[0]);
}

/** Invalida o cache (usado após scan manual). */
export function invalidateMarketsCache(): void {
  marketsCache = null;
}

export { log };
