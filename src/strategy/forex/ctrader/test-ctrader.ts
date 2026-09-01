// Script de teste da integração cTrader Open API.
// Uso: npx tsx src/strategy/forex/ctrader/test-ctrader.ts [--demo]
// Lê as credenciais do banco (ExchangeKey exchangeId='ctrader'/'pepperstone')
// e testa: conexão → loadMarkets → fetchTickers → (opcional) fetchTicker.
import { loadEnv } from '../../../utils/env-loader';
loadEnv();
import { connectToDatabase } from '../../../config/db';
import ExchangeKey from '../../../models/ExchangeKey';
import { buildCtraderAdapter } from '../ctrader/ctrader-factory';

const log = {
  info: (...args: any[]) => console.log('[CTRADER-TEST]', ...args),
  warn: (...args: any[]) => console.warn('[CTRADER-TEST]', ...args),
  error: (...args: any[]) => console.error('[CTRADER-TEST]', ...args),
};

const IS_DEMO = process.argv.includes('--demo');

async function main() {
  await connectToDatabase();
  const keys = await (ExchangeKey as any).find({
    exchangeId: { $in: ['ctrader', 'pepperstone'] },
    active: true,
  }).lean();

  if (!keys.length) {
    log.error('❌ Nenhuma ExchangeKey cTrader/pepperstone encontrada no banco.');
    process.exit(1);
  }

  // Prefere a conta do ambiente pedido
  const key = keys.find((k: any) => (IS_DEMO ? k.environment === 'demo' : k.environment !== 'demo')) || keys[0];
  const env = key.environment === 'demo' ? 'demo' : 'live';
  log.info(`🔑 Testando cTrader (${env}) com key "${key.name}" (${key._id})`);

  const adapter = buildCtraderAdapter(key, {
    onTokenRefresh: async (accessToken, refreshToken) => {
      log.info('🔄 (callback) token renovado — persistiria no banco aqui.');
    },
  });

  try {
    await adapter.connect();
    log.info('✅ Conexão + autenticação OK.');

    const markets = await adapter.loadMarkets();
    const pairs = Object.keys(markets);
    log.info(`📈 ${pairs.length} símbolos carregados.`);
    log.info(`   Amostra: ${pairs.slice(0, 15).join(', ')}...`);

    // Tickers de alguns majors
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

    // fetchTicker unitário
    if (sample[0]) {
      const tk = await adapter.fetchTicker(sample[0]);
      log.info(`📊 fetchTicker(${sample[0]}): bid=${tk.bid} ask=${tk.ask} last=${tk.last}`);
    }

    log.info('✅ Teste concluído com sucesso.');
  } catch (e: any) {
    log.error('❌ Falha no teste cTrader:', e.message);
    process.exit(1);
  } finally {
    await adapter.destroy().catch(() => {});
    process.exit(0);
  }
}

main().catch((e) => { log.error('Fatal:', e.message); process.exit(1); });
