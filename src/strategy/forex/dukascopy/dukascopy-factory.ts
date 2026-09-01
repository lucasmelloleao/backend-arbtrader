// Factory do adaptador Dukascopy: cria a partir de uma ExchangeKey do banco,
// com cache por keyId (uma conexão à ponte por processo).
import ExchangeKey from '../../../models/ExchangeKey';
import { decryptSecretKey } from '../../../utils/encryption';
import { DukascopyAdapter } from './dukascopy-adapter';

const dukascopyAdapterCache = new Map<string, DukascopyAdapter>();

export function isDukascopyExchange(exchangeId: string): boolean {
  return exchangeId === 'dukascopy';
}

export function buildDukascopyAdapter(key: any): DukascopyAdapter {
  const aad = key.userId ? `${key.userId}-${key.exchangeId}` : '';
  const decrypt = (v: string | undefined | null) => {
    if (!v) return '';
    try { return decryptSecretKey(String(v), aad); } catch { return String(v); }
  };
  const username = key.username || key.accountId || '';
  const password = decrypt(key.password || key.apiSecret || '');
  if (!username) throw new Error('DukascopyAdapter: username ausente na ExchangeKey');
  if (!password) throw new Error('DukascopyAdapter: password ausente na ExchangeKey');
  return new DukascopyAdapter({
    jnlpUrl: key.jnlpUrl || 'http://platform.dukascopy.com/demo_3/jforex_3.jnlp',
    username,
    password,
  });
}

export async function getSharedDukascopyAdapter(key: any): Promise<DukascopyAdapter> {
  const keyId = String(key._id || '');
  if (keyId && dukascopyAdapterCache.has(keyId)) {
    return dukascopyAdapterCache.get(keyId)!;
  }
  const adapter = buildDukascopyAdapter(key);
  await adapter.connect();
  if (keyId) dukascopyAdapterCache.set(keyId, adapter);
  return adapter;
}
