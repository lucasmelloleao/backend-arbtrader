// Factory do adaptador FIX: cria a partir de uma ExchangeKey do banco,
// com cache por keyId (uma conexão por processo).
import ExchangeKey from '../../../models/ExchangeKey';
import { decryptSecretKey } from '../../../utils/encryption';
import { FixAdapter } from './fix-adapter';

const log = {
  info: (...args: any[]) => console.log('[FIX-FACTORY]', ...args),
  warn: (...args: any[]) => console.warn('[FIX-FACTORY]', ...args),
  error: (...args: any[]) => console.error('[FIX-FACTORY]', ...args),
};

const fixAdapterCache = new Map<string, FixAdapter>();

export function isFixExchange(exchangeId: string): boolean {
  return exchangeId === 'fix' || exchangeId === 'pepperstone-fix' || exchangeId === 'ctrader-fix';
}

export function buildFixAdapter(key: any): FixAdapter {
  const aad = key.userId ? `${key.userId}-${key.exchangeId}` : '';
  const decrypt = (v: string | undefined | null) => {
    if (!v) return '';
    try { return decryptSecretKey(String(v), aad); } catch { return String(v); }
  };

  const host = key.host || 'live-us-eqx-01.p.c-trader.com';
  const senderCompId = key.senderCompId || '';
  const username = key.username || key.accountId || '';
  const password = decrypt(key.password || key.apiSecret || '');
  const quotePort = key.quotePort ? Number(key.quotePort) : 5211;
  const tradePort = key.tradePort ? Number(key.tradePort) : 5212;

  if (!senderCompId) throw new Error('FixAdapter: senderCompId ausente na ExchangeKey');
  if (!username) throw new Error('FixAdapter: username (login) ausente na ExchangeKey');
  if (!password) throw new Error('FixAdapter: password ausente na ExchangeKey');

  return new FixAdapter({
    host,
    quotePort,
    tradePort,
    senderCompId,
    targetCompId: key.targetCompId || 'CSERVER',
    username,
    password,
    heartBtInt: key.heartBtInt ? Number(key.heartBtInt) : 30,
  });
}

export async function getSharedFixAdapter(key: any): Promise<FixAdapter> {
  const keyId = String(key._id || '');
  if (keyId && fixAdapterCache.has(keyId)) {
    const cached = fixAdapterCache.get(keyId)!;
    try {
      await cached.connect();
      return cached;
    } catch {
      fixAdapterCache.delete(keyId);
      cached.destroy();
    }
  }
  const adapter = buildFixAdapter(key);
  await adapter.connect();
  if (keyId) fixAdapterCache.set(keyId, adapter);
  return adapter;
}
