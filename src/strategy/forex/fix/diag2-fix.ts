// Diagnóstico 2: conecta TLS e NÃO envia nada — observa se o servidor envia algo
// espontaneamente (heartbeat/logout) ou fica mudo.
import { loadEnv } from '../../../utils/env-loader';
loadEnv();
import * as tls from 'tls';
import { connectToDatabase } from '../../../config/db';
import ExchangeKey from '../../../models/ExchangeKey';
import { decryptSecretKey } from '../../../utils/encryption';
import { encodeFix, nowUtc } from './fix-protocol';

async function main() {
  await connectToDatabase();
  const key = await (ExchangeKey as any).findOne({ exchangeId: 'fix', active: true }).sort({ createdAt: -1 }).lean();
  if (!key) { console.error('Nenhuma key fix'); process.exit(1); }
  const host = key.host || 'live-us-eqx-01.p.c-trader.com';

  for (const port of [5211, 5212]) {
    console.log(`\n=== Testando ${host}:${port} (sem enviar nada) ===`);
    await new Promise<void>((resolve) => {
      const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
        console.log(`  TLS OK ${port}, cipher:`, socket.getCipher()?.name);
        setTimeout(() => { console.log(`  ${port}: 5s sem enviar nada. Fechando.`); socket.destroy(); resolve(); }, 5000);
      });
      socket.on('data', (d) => console.log(`  ${port} RECEBEU:`, JSON.stringify(d.toString('utf8').replace(/\u0001/g, '|'))));
      socket.on('error', (e) => { console.log(`  ${port} ERRO:`, e.message); resolve(); });
      socket.on('close', () => { /* já resolvido */ });
    });
  }
  process.exit(0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
