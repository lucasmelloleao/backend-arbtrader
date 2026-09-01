// Diagnóstico 3: tenta várias variações do Logon FIX e loga qualquer resposta bruta.
import { loadEnv } from '../../../utils/env-loader';
loadEnv();
import * as tls from 'tls';
import { connectToDatabase } from '../../../config/db';
import ExchangeKey from '../../../models/ExchangeKey';
import { decryptSecretKey } from '../../../utils/encryption';
import { encodeFix, nowUtc } from './fix-protocol';

async function main() {
  await connectToDatabase();
  const key = await (ExchangeKey as any).findOne({ exchangeId: 'fix', active: true });
  if (!key) { console.error('Nenhuma key fix'); process.exit(1); }
  const aad = `${key.userId}-${key.exchangeId}`;
  const password = (() => { try { return decryptSecretKey(String(key.password), aad); } catch { return String(key.password); } })();
  const host = key.host || 'live-uk-eqx-01.p.c-trader.com';
  const sender = key.senderCompId || 'live.pepperstone.1382148';
  const username = key.username || '1382148';

  const variants: Array<{ name: string; target: string; sub: string | null; port: number }> = [
    { name: 'TRADE CSERVER com 57/50', target: 'CSERVER', sub: 'TRADE', port: 5212 },
    { name: 'TRADE cServer com 57/50', target: 'cServer', sub: 'TRADE', port: 5212 },
    { name: 'TRADE CSERVER sem 57/50', target: 'CSERVER', sub: null, port: 5212 },
    { name: 'QUOTE CSERVER com 57/50', target: 'CSERVER', sub: 'QUOTE', port: 5211 },
  ];

  for (const v of variants) {
    console.log(`\n=== ${v.name} (${host}:${v.port}) ===`);
    await new Promise<void>((resolve) => {
      const socket = tls.connect({ host, port: v.port, rejectUnauthorized: false }, () => {
        const body = { '98': '0', '108': '30', '141': 'Y', '553': username, '554': password };
        const header: Record<string, string> = { '35': 'A', '49': sender, '56': v.target, '34': '1', '52': nowUtc() };
        if (v.sub) { header['57'] = v.sub; header['50'] = v.sub; }
        const raw = encodeFix(header, body);
        console.log('ENVIO:', JSON.stringify(raw.replace(/\u0001/g, '|')));
        socket.write(raw);
        setTimeout(() => { console.log('  -> sem resposta em 6s'); socket.destroy(); resolve(); }, 6000);
      });
      let got = false;
      socket.on('data', (d) => {
        got = true;
        console.log('  RESPOSTA:', JSON.stringify(d.toString('utf8').replace(/\u0001/g, '|')));
        socket.destroy();
        resolve();
      });
      socket.on('error', (e) => { console.log('  ERRO:', e.message); resolve(); });
    });
    if (process.env.DIAG_STOP) break;
  }
  process.exit(0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
