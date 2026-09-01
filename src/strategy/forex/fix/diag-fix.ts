// Diagnóstico da conexão FIX: conecta TLS na porta, envia Logon e loga TUDO que recebe.
// Lê a senha da ExchangeKey do banco (descriptografada).
import { loadEnv } from '../../../utils/env-loader';
loadEnv();
import * as tls from 'tls';
import { connectToDatabase } from '../../../config/db';
import ExchangeKey from '../../../models/ExchangeKey';
import { decryptSecretKey } from '../../../utils/encryption';
import { encodeFix, nowUtc } from './fix-protocol';

const SUB = (process.argv[2] === 'trade' ? 'TRADE' : (process.argv[2] === 'quote' ? 'QUOTE' : 'QUOTE'));
const PORT = SUB === 'TRADE' ? 5212 : 5211;

async function main() {
  await connectToDatabase();
  const key = await (ExchangeKey as any).findOne({ exchangeId: 'fix', active: true }).sort({ createdAt: -1 }).lean();
  if (!key) { console.error('Nenhuma key fix'); process.exit(1); }
  const aad = `${key.userId}-${key.exchangeId}`;
  const password = (() => { try { return decryptSecretKey(String(key.password), aad); } catch { return String(key.password); } })();
  const host = key.host || 'live-us-eqx-01.p.c-trader.com';
  const sender = key.senderCompId || 'live.pepperstone.1382148';
  const username = key.username || '1382148';

  console.log(`Conectando TLS a ${host}:${PORT} (${SUB})...`);

  const socket = tls.connect({ host, port: PORT, rejectUnauthorized: false }, () => {
    console.log('TLS conectado. cipher:', socket.getCipher()?.name, 'authorized:', socket.authorized);
    const body = { '98': '0', '108': '30', '141': 'Y', '553': username, '554': password };
    const header: Record<string, string> = { '35': 'A', '49': sender, '56': 'CSERVER', '34': '1', '52': nowUtc() };
    header['57'] = SUB;
    header['50'] = SUB;
    const raw = encodeFix(header, body);
    console.log('ENVIANDO LOGON:', JSON.stringify(raw.replace(/\u0001/g, '|')));
    socket.write(raw);
  });

  socket.on('secureConnect', () => console.log('secureConnect OK'));
  socket.on('data', (d) => {
    console.log('RECEBEU (%d bytes):', d.length, JSON.stringify(d.toString('utf8').replace(/\u0001/g, '|')));
  });
  socket.on('error', (e) => console.error('ERRO:', e.message));
  socket.on('close', () => console.log('CONEXÃO FECHADA'));

  setTimeout(() => { console.log('Timeout de 12s. Encerrando.'); socket.destroy(); process.exit(0); }, 12000);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
