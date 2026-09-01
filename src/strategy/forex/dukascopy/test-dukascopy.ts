// Script de teste da integração Dukascopy (via ponte Java JForex).
// Uso: npx tsx src/strategy/forex/dukascopy/test-dukascopy.ts
// Lê as credenciais do banco (ExchangeKey exchangeId='dukascopy'), conecta na
// ponte, lista markets e puxa tickers.
import { loadEnv } from '../../../utils/env-loader';
loadEnv();
import { connectToDatabase } from '../../../config/db';
import ExchangeKey from '../../../models/ExchangeKey';
import { buildDukascopyAdapter } from './dukascopy-factory';

const log = {
  info: (...args: any[]) => console.log('[DUKASCOPY-TEST]', ...args),
  warn: (...args: any[]) => console.warn('[DUKASCOPY-TEST]', ...args),
  error: (...args: any[]) => console.error('[DUKASCOPY-TEST]', ...args),
};

async function main() {
  await connectToDatabase();
  const keys = await (ExchangeKey as any).find({ exchangeId: 'dukascopy', active: true }).lean();

  if (!keys.length) {
    log.error('❌ Nenhuma ExchangeKey Dukascopy encontrada no banco.');
    process.exit(1);
  }

  const key = keys[0];
  log.info(`🔑 Testando Dukascopy com key "${key.name}" (${key._id})`);

  const adapter = buildDukascopyAdapter(key);

  try {
    await adapter.connect();
    log.info('✅ Conexão com a ponte Dukascopy OK.');

    const markets = await adapter.loadMarkets();
    const pairs = Object.keys(markets);
    log.info(`📈 ${pairs.length} símbolos carregados.`);
    log.info(`   Amostra: ${pairs.slice(0, 15).join(', ')}...`);

    const sample = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'GBP/JPY', 'XAU/USD', 'EUR/GBP']
      .filter((s) => pairs.includes(s));
    if (sample.length) {
      const tickers = await adapter.fetchTickers(sample);
      for (const s of sample) {
        const t = tickers[s];
        log.info(`   ${s}: bid=${t?.bid} ask=${t?.ask} last=${t?.last}`);
      }
    } else {
      log.warn('⚠️ Nenhum par major encontrado entre os símbolos carregados.');
    }

    log.info('✅ Teste Dukascopy concluído com sucesso.');
  } catch (e: any) {
    log.error('❌ Falha no teste Dukascopy:', e.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

main().catch((e) => { log.error('Fatal:', e.message); process.exit(1); });
