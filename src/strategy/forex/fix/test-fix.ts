// Script de teste da integração FIX API (Pepperstone/cTrader).
// Uso: npx tsx src/strategy/forex/fix/test-fix.ts
// Lê as credenciais do banco (ExchangeKey exchangeId='fix'/'pepperstone-fix')
// e testa: conexão (QUOTE+TRADE) → Security List → fetchTickers.
import { loadEnv } from '../../../utils/env-loader';
loadEnv();
import { connectToDatabase } from '../../../config/db';
import ExchangeKey from '../../../models/ExchangeKey';
import { buildFixAdapter } from './fix-factory';

const log = {
  info: (...args: any[]) => console.log('[FIX-TEST]', ...args),
  warn: (...args: any[]) => console.warn('[FIX-TEST]', ...args),
  error: (...args: any[]) => console.error('[FIX-TEST]', ...args),
};

async function main() {
  await connectToDatabase();
  const keys = await (ExchangeKey as any).find({
    exchangeId: { $in: ['fix', 'pepperstone-fix', 'ctrader-fix'] },
    active: true,
  }).lean();

  if (!keys.length) {
    log.error('❌ Nenhuma ExchangeKey FIX encontrada no banco.');
    process.exit(1);
  }

  const key = keys[0];
  log.info(`🔑 Testando FIX com key "${key.name}" (${key._id})`);

  const adapter = buildFixAdapter(key);

  try {
    await adapter.connect();
    log.info('✅ Conexão FIX (QUOTE + TRADE) OK.');

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

    log.info('✅ Teste FIX concluído com sucesso.');
  } catch (e: any) {
    log.error('❌ Falha no teste FIX:', e.message);
    process.exit(1);
  } finally {
    adapter.destroy();
    process.exit(0);
  }
}

main().catch((e) => { log.error('Fatal:', e.message); process.exit(1); });
