// Cliente da Data API do Polymarket (posições e histórico de trades).
// Fonte: https://data-api.polymarket.com
import { withTimeout } from '../../perpetuals/helpers/ccxt-factory';

// Pode apontar para o proxy (ex: POLYMARKET_DATA_BASE=https://proxy-...vercel.app/api/proxy/data)
// quando o servidor não alcança a Polymarket diretamente (região restrita).
// Lido em runtime: o loadEnv() roda depois dos imports serem hoisted.
function getDataBase(): string {
  return process.env.POLYMARKET_DATA_BASE || 'https://data-api.polymarket.com';
}

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
};

/** Busca posições do usuário (com PnL realizado). */
export async function fetchUserPositions(address: string): Promise<any[]> {
  const res = await withTimeout(
    fetch(`${getDataBase()}/positions?user=${address}`),
    10_000,
    null
  );
  if (!res || !res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/** Busca histórico de trades do usuário (fills reais). */
export async function fetchUserTrades(address: string, limit = 100): Promise<any[]> {
  const res = await withTimeout(
    fetch(`${getDataBase()}/trades?user=${address}&limit=${limit}`),
    10_000,
    null
  );
  if (!res || !res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export { log };
