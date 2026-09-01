import mongoose from 'mongoose';

// ─── DNS over HTTPS (DoH) para contornar bloqueio de porta 53 ─────────────────
// Resolve mongodb+srv:// via Cloudflare/Google/Quad9 DoH, evitando o erro
// "querySrv ECONNREFUSED" em redes domésticas / VPNs que bloqueiam DNS na porta 53.

const DOH_PROVIDERS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
  'https://dns.quad9.net:5053/dns-query',
];

async function dohFetch(query: string, headers: Record<string, string>) {
  for (const provider of DOH_PROVIDERS) {
    try {
      const resp = await fetch(`${provider}?${query}`, { headers: headers as any, signal: AbortSignal.timeout(5000) });
      if (resp.ok) return resp;
    } catch {
      continue;
    }
  }
  throw new Error('Falha ao resolver via DoH após tentar todos os provedores');
}

async function resolveAtlasSRVviaDoH(srvUri: string): Promise<string> {
  const withoutScheme = srvUri.replace('mongodb+srv://', 'https://');
  const url = new URL(withoutScheme);

  const hostname    = url.hostname;
  const userInfo    = `${url.username}:${url.password}`;
  const database    = url.pathname || '/';
  const searchParams = url.search || '';

  // 1. Resolve registros SRV
  const srvResp = await dohFetch(`name=_mongodb._tcp.${hostname}&type=SRV`, {
    Accept: 'application/dns-json',
  });
  const srvData = await srvResp.json() as { Answer?: Array<{ type: number; data: string }> };

  const hosts = (srvData.Answer || [])
    .filter((r) => r.type === 33)
    .map((r) => {
      const parts = r.data.trim().split(/\s+/);
      const port   = parts[2];
      const target = parts[3].replace(/\.$/, '');
      return `${target}:${port}`;
    });

  if (hosts.length === 0) {
    throw new Error(`DoH: nenhum registro SRV encontrado para ${hostname}`);
  }

  // 2. Resolve registro TXT para opções extras (authSource, replicaSet…)
  const txtResp = await dohFetch(`name=${hostname}&type=TXT`, {
    Accept: 'application/dns-json',
  });
  const txtData = await txtResp.json() as { Answer?: Array<{ type: number; data: string }> };

  const txtOptions = (txtData.Answer || [])
    .filter((r) => r.type === 16)
    .map((r) => r.data.replace(/"/g, '').trim())
    .join('&');

  // 3. Monta URI direta sem mongodb+srv://
  const queryParts = [txtOptions, 'tls=true', 'ssl=true'].filter(Boolean);
  if (searchParams) queryParts.push(searchParams.replace(/^\?/, ''));

  return `mongodb://${userInfo}@${hosts.join(',')}${database}?${queryParts.join('&')}`;
}

// ─── connectToDatabase ────────────────────────────────────────────────────────

export async function connectToDatabase() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  let uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/solana_flash_db';

  const opts = {
    bufferCommands: false,
    serverSelectionTimeoutMS: 10000,
  };

  // Se a URI usa mongodb+srv://, resolve via DoH antes de conectar
  if (uri.startsWith('mongodb+srv://')) {
    try {
      console.log('🔍 [MongoDB] Resolvendo SRV do Atlas via DoH (HTTPS)…');
      uri = await resolveAtlasSRVviaDoH(uri);
      console.log('✅ [MongoDB] SRV resolvido com sucesso.');
    } catch (err: any) {
      console.error('❌ [MongoDB] Falha ao resolver SRV via DoH:', err.message);
      throw err;
    }
  }

  console.log('🔌 [MongoDB] Tentando conectar ao MongoDB...');
  try {
    await mongoose.connect(uri, opts);
    console.log('✅ [MongoDB] Conectado com sucesso!');
    return mongoose.connection;
  } catch (err: any) {
    console.error('❌ [MongoDB] Falha na conexão:', err.message, err.code);
    throw err;
  }
}
