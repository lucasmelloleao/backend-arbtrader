// Atualiza credenciais cTrader (clientSecret/accessToken/refreshToken) na ExchangeKey.
// Uso (env vars para não expor segredos no histórico do shell):
//   CTRADER_CLIENT_SECRET=... CTRADER_ACCESS_TOKEN=... CTRADER_REFRESH_TOKEN=... \
//     npx tsx src/strategy/forex/ctrader/set-credentials.ts [--key-id=<id>]
// Só atualiza os campos fornecidos. Os valores são criptografados (AES-256-GCM).
import { loadEnv } from '../../../utils/env-loader';
loadEnv();
import { connectToDatabase } from '../../../config/db';
import ExchangeKey from '../../../models/ExchangeKey';
import { encryptSecretKey } from '../../../utils/encryption';

const log = {
  info: (...args: any[]) => console.log('[CTRADER-SET-CREDS]', ...args),
  warn: (...args: any[]) => console.warn('[CTRADER-SET-CREDS]', ...args),
  error: (...args: any[]) => console.error('[CTRADER-SET-CREDS]', ...args),
};

async function main() {
  const clientSecret = process.env.CTRADER_CLIENT_SECRET;
  const accessToken = process.env.CTRADER_ACCESS_TOKEN;
  const refreshToken = process.env.CTRADER_REFRESH_TOKEN;
  const keyId = process.argv.find((a) => a.startsWith('--key-id='))?.split('=')[1];

  if (!clientSecret && !accessToken && !refreshToken) {
    log.error('Nada para atualizar. Defina CTRADER_CLIENT_SECRET / CTRADER_ACCESS_TOKEN / CTRADER_REFRESH_TOKEN.');
    process.exit(1);
  }

  await connectToDatabase();

  const query: any = { exchangeId: { $in: ['ctrader', 'pepperstone'] }, active: true };
  if (keyId) query._id = keyId;
  const key = await (ExchangeKey as any).findOne(query).sort({ createdAt: -1 }).lean();
  if (!key) {
    log.error('❌ ExchangeKey cTrader não encontrada no banco.');
    process.exit(1);
  }

  const aad = `${key.userId}-${key.exchangeId}`;
  const set: any = {};
  if (clientSecret) set.clientSecret = encryptSecretKey(clientSecret, aad);
  if (accessToken) set.accessToken = encryptSecretKey(accessToken, aad);
  if (refreshToken) set.refreshToken = encryptSecretKey(refreshToken, aad);
  if (accessToken || refreshToken) set.ctraderTokenUpdatedAt = new Date();

  await (ExchangeKey as any).findByIdAndUpdate(key._id, { $set: set });
  log.info(`✅ Credenciais cTrader atualizadas na key "${key.name}" (${key._id}): clientSecret=${!!clientSecret}, accessToken=${!!accessToken}, refreshToken=${!!refreshToken}`);
  process.exit(0);
}

main().catch((e) => { log.error(e.message); process.exit(1); });
