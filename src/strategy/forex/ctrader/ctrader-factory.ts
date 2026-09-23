// Factory compartilhado do adaptador cTrader.
// Centraliza: criação a partir de uma ExchangeKey do banco, cache por keyId
// (reutiliza a conexão WebSocket entre operações do mesmo processo) e
// persistência de tokens renovados (criptografados).
import ExchangeKey from '../../../models/ExchangeKey';
import { decryptSecretKey, encryptSecretKey } from '../../../utils/encryption';
import { CtraderAdapter } from './ctrader-adapter';
import { isCtraderExchange } from '../scanner';

const log = {
  info: (...args: any[]) => console.log('[CTRADER-FACTORY]', ...args),
  warn: (...args: any[]) => console.warn('[CTRADER-FACTORY]', ...args),
  error: (...args: any[]) => console.error('[CTRADER-FACTORY]', ...args),
};

const adapterCache = new Map<string, CtraderAdapter>();

export type CtraderAdapterOverrides = {
  accountId?: string;
  environment?: 'demo' | 'live';
};

// Cria o adaptador cTrader a partir de uma ExchangeKey do banco.
export function buildCtraderAdapter(
  key: any,
  opts: {
    onTokenRefresh?: (accessToken: string, refreshToken: string) => Promise<void>;
    overrides?: CtraderAdapterOverrides;
  } = {}
): CtraderAdapter {
  const aad = key.userId ? `${key.userId}-${key.exchangeId}` : '';
  const decrypt = (v: string | undefined | null) => {
    if (!v) return '';
    try { return decryptSecretKey(String(v), aad); } catch { return String(v); }
  };
  const clientSecret = decrypt(key.clientSecret || key.apiSecret);
  const accessToken = decrypt(key.accessToken || '');
  const refreshToken = decrypt(key.refreshToken || '');
  if (!key.clientId) throw new Error('CtraderAdapter: clientId ausente na ExchangeKey');
  if (!clientSecret) throw new Error('CtraderAdapter: clientSecret ausente na ExchangeKey');
  if (!accessToken) throw new Error('CtraderAdapter: accessToken ausente na ExchangeKey');

  const accountId = opts.overrides?.accountId || (key.accountId ? String(key.accountId) : '');
  const environment = (opts.overrides?.environment || key.environment) === 'live' ? 'live' : 'demo';

  return new CtraderAdapter({
    clientId: String(key.clientId),
    clientSecret,
    accessToken,
    refreshToken: refreshToken || undefined,
    accountId,
    environment,
  }, { onTokenRefresh: opts.onTokenRefresh });
}

// Persiste o novo par de tokens no ExchangeKey (criptografado) após refresh.
export async function persistCtraderTokens(keyId: string, key: any, accessToken: string, refreshToken: string) {
  try {
    const aad = key.userId ? `${key.userId}-${key.exchangeId}` : '';
    await (ExchangeKey as any).findByIdAndUpdate(keyId, {
      $set: {
        accessToken: encryptSecretKey(accessToken, aad),
        refreshToken: encryptSecretKey(refreshToken, aad),
        ctraderTokenUpdatedAt: new Date(),
      },
    });
    log.info('✅ Tokens cTrader renovados e persistidos no ExchangeKey.');
  } catch (e: any) {
    log.error('❌ Falha ao persistir tokens cTrader renovados:', e.message);
  }
}

// Retorna um adaptador compartilhado (com cache) para uma ExchangeKey.
export async function getSharedCtraderAdapter(
  key: any,
  overrides?: CtraderAdapterOverrides
): Promise<CtraderAdapter> {
  const keyId = String(key._id || '');
  const accountId = overrides?.accountId || (key.accountId ? String(key.accountId) : '');
  const environment = (overrides?.environment || key.environment) === 'live' ? 'live' : 'demo';
  const cacheKey = `${keyId}:${accountId}:${environment}`;

  if (cacheKey && adapterCache.has(cacheKey)) {
    const cached = adapterCache.get(cacheKey)!;
    try {
      await cached.connect();
      return cached;
    } catch {
      adapterCache.delete(cacheKey);
      await cached.destroy().catch(() => {});
    }
  }
  const adapter = buildCtraderAdapter(key, {
    overrides: { accountId, environment },
    onTokenRefresh: (accessToken, refreshToken) =>
      persistCtraderTokens(keyId, key, accessToken, refreshToken),
  });
  await adapter.connect();
  if (cacheKey) adapterCache.set(cacheKey, adapter);
  return adapter;
}

export { isCtraderExchange };
