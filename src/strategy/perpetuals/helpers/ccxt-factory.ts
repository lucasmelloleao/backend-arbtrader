// @ts-nocheck
import ccxt from 'ccxt';
import { decryptSecretKey } from '../../../utils/encryption';

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${msg}`, ...args),
};

const EXCHANGE_CACHE_TTL_MS = 30 * 60 * 1000;
const exchangeCache = new Map<string, { instance: any; createdAt: number }>();

export function getExchangeFromCache(key: string): any | null {
  const entry = exchangeCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > EXCHANGE_CACHE_TTL_MS) {
    exchangeCache.delete(key);
    return null;
  }
  return entry.instance;
}

export function setExchangeInCache(key: string, instance: any): void {
  exchangeCache.set(key, { instance, createdAt: Date.now() });
}

export function invalidateExchangeCache(exchangeId: string, apiKey: string): void {
  for (const [k] of exchangeCache) {
    if (k.startsWith(`${exchangeId}_${apiKey || 'no_key'}`)) {
      exchangeCache.delete(k);
      log.warn(`⚠️ [EXCHANGE CACHE] Instância ${exchangeId} invalidada por erro de autenticação.`);
    }
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, fallbackValue: T): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallbackValue), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

export async function getExchangeInstance(exchangeKeyDoc: any, isPerp: boolean = false) {
  const { exchangeId, apiKey, apiSecret, userId } = exchangeKeyDoc;
  const cacheKey = `${exchangeId}_${apiKey || 'no_key'}_${isPerp ? 'perp' : 'spot'}`;

  const cached = getExchangeFromCache(cacheKey);
  if (cached) return cached;

  const id = exchangeId === 'gateio' ? 'gate' : exchangeId;
  const cls: any = (ccxt as any)[id] ?? (ccxt as any).pro?.[id] ?? (ccxt as any)[exchangeId];
  if (!cls) throw new Error(`Exchange "${exchangeId}" não suportada pelo ccxt`);

  let secret = apiSecret;
  try {
    const aad = userId ? `${userId}-${exchangeId}` : '';
    secret = decryptSecretKey(String(apiSecret || ''), aad);
  } catch {
    // usa raw se descriptografia falhar
  }

  const defaultType = isPerp ? (id === 'mexc' || id === 'gate' || id === 'bybit' ? 'swap' : 'future') : 'spot';
  const config: any = {
    apiKey,
    secret,
    enableRateLimit: true,
    timeout: 10000,
    options: {
      defaultType,
      fetchCurrencies: false,
      adjustForTimeDifference: true,
      recvWindow: 15000,
    },
  };

  const instance = new cls(config);
  instance.has = { ...(instance.has || {}), fetchCurrencies: false };

  if (id === 'mexc') {
    try {
      const res = await withTimeout(fetch('https://api.mexc.com/api/v3/time').then(r => r.json()), 3000, null);
      if (res && res.serverTime) {
        const serverDiff = res.serverTime - Date.now();
        if (Math.abs(serverDiff) > 1000) {
          const origNonce = instance.nonce.bind(instance);
          instance.nonce = () => origNonce() + serverDiff;
          log.info(`⏱️ [MEXC TIME SYNC] Relógio alinhado com o servidor MEXC (Offset: ${serverDiff} ms).`);
        }
      }
    } catch {}
  }

  setExchangeInCache(cacheKey, instance);
  return instance;
}
