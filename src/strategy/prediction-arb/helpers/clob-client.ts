// Cliente da CLOB API do Polymarket (ordens, book, posições).
// Auth: assinatura EIP-712 derivada da chave privada da wallet (ExchangeKey).
// CLOB V2 (live desde 2026-04-28): usa a SDK oficial @polymarket/clob-client-v2
// para o wire protocol (orderToJsonV2) e auth L2 (HMAC headers).
// Fonte: https://docs.polymarket.com/v2-migration
import { ethers } from 'ethers';
import { ClobClient, createL2Headers, orderToJsonV2, OrderType } from '@polymarket/clob-client-v2';
import type { BalanceAllowanceResponse } from '@polymarket/clob-client-v2/dist/types/clob';
import { decryptSecretKey } from '../../../utils/encryption';
import { withTimeout } from '../../perpetuals/helpers/ccxt-factory';

// Lido em RUNTIME (não no import) porque o loadEnv() roda depois dos imports
// serem hoisted — sem isso o proxy configurado no .env/secrets.enc era ignorado.
function getClobBase(): string {
  return process.env.POLYMARKET_CLOB_BASE || 'https://clob.polymarket.com';
}

// Cache de clientes SDK por endereço (reutiliza credenciais L2 derivadas).
const sdkClients = new Map<string, ClobClient>();

/**
 * Envolve um ethers.Wallet num formato compatível com o signer que a SDK
 * @polymarket/clob-client-v2 espera (viem-like). O viem chama
 * signTypedData({ domain, types, primaryType, message }) — adaptamos.
 */
function toViemLikeSigner(wallet: ethers.Wallet): any {
  return {
    account: { address: wallet.address },
    address: wallet.address,
    signTypedData: (args: any) => {
      // viem: signTypedData({ account, domain, types, primaryType, message })
      // ethers: signTypedData(domain, types, value)
      const { domain, types, primaryType, message } = args || {};
      const value = message;
      // Converte types viem ({ Name: [...] }) para ethers ([{name,type},...])
      const ethersTypes: any = {};
      for (const [key, arr] of Object.entries(types || {})) {
        ethersTypes[key] = arr;
      }
      return wallet.signTypedData(domain, ethersTypes, value);
    },
    getAddress: async () => wallet.address,
  };
}

/** Instancia (ou reutiliza) o ClobClient oficial da SDK para a wallet. */
export async function getClobClient(credentials: ClobCredentials): Promise<ClobClient> {
  const cached = sdkClients.get(credentials.address);
  if (cached) return cached;

  // Garante as credenciais L2 (deriva se necessário) para auth nas ordens.
  if (!credentials.apiCreds) {
    credentials.apiCreds = await deriveClobApiKey(credentials);
  }
  const wallet = new ethers.Wallet(credentials.privateKey);
  const client = new ClobClient({
    host: getClobBase(),
    chain: 137,
    signer: toViemLikeSigner(wallet),
    creds: { apiKey: credentials.apiCreds.key, secret: credentials.apiCreds.secret, passphrase: credentials.apiCreds.passphrase } as any,
    signatureType: 1,
    funderAddress: credentials.address,
    useServerTime: true, // evita clock skew no HMAC (401 de auth)
  });
  sdkClients.set(credentials.address, client);
  return client;
}

/**
 * Sincroniza o saldo/allowance de colateral da wallet com o CLOB v2.
 *
 * A CLOB mantém um saldo "registrado" que só é atualizado quando o usuário
 * chama `/balance-allowance/update` (ou deposita pela UI). Se o pUSD foi
 * transferido para a deposit wallet mas o update nunca rodou, o CLOB vê o
 * saldo antigo e rejeita ordens com "not enough balance / allowance".
 * Chamar antes de cada ordem garante que o saldo on-chain seja reconhecido.
 *
 * Nota: NÃO usa client.updateBalanceAllowance da SDK (clob-client-v2) — ela
 * assina o requestPath com a query embutida, gerando 401. Aqui o HMAC usa o
 * requestPath limpo e a query vai só na URL (testado: retorna 200).
 */
export async function updateCollateralBalance(credentials: ClobCredentials): Promise<BalanceAllowanceResponse | null> {
  try {
    if (!credentials.apiCreds) {
      credentials.apiCreds = await deriveClobApiKey(credentials);
    }
    const signer = toViemLikeSigner(new ethers.Wallet(credentials.privateKey));
    const endpoint = '/balance-allowance/update';
    const headers = await (createL2Headers as any)(signer, credentials.apiCreds, {
      method: 'GET',
      requestPath: endpoint,
    });
    const res = await withTimeout(
      fetch(`${getClobBase()}${endpoint}?asset_type=COLLATERAL`, { headers }),
      15_000,
      null
    );
    if (!res) return null;
    const data = (await res.json().catch(() => ({}))) as Partial<BalanceAllowanceResponse>;
    return res.ok ? (data as BalanceAllowanceResponse) : null;
  } catch (e: any) {
    log.warn(`⚠️ updateCollateralBalance falhou: ${e.message}`);
    return null;
  }
}

/** Consulta o saldo/allowance de colateral que a CLOB vê para a wallet. */
export async function getCollateralBalance(credentials: ClobCredentials): Promise<{ balance: number; allowances: Record<string, string> } | null> {
  try {
    if (!credentials.apiCreds) {
      credentials.apiCreds = await deriveClobApiKey(credentials);
    }
    const signer = toViemLikeSigner(new ethers.Wallet(credentials.privateKey));
    const endpoint = '/balance-allowance';
    const headers = await (createL2Headers as any)(signer, credentials.apiCreds, {
      method: 'GET',
      requestPath: endpoint,
    });
    const res = await withTimeout(
      fetch(`${getClobBase()}${endpoint}?asset_type=COLLATERAL`, { headers }),
      15_000,
      null
    );
    if (!res || !res.ok) return null;
    const data = (await res.json()) as BalanceAllowanceResponse;
    return {
      balance: Number(data?.balance || 0) / 1e6,
      allowances: data?.allowances || {},
    };
  } catch (e: any) {
    log.warn(`⚠️ getCollateralBalance falhou: ${e.message}`);
    return null;
  }
}

// PUSD (colateral da Polymarket) e RPC da Polygon
const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';

/**
 * Saldo pUSD ON-CHAIN da deposit wallet (via RPC da Polygon).
 *
 * É a fonte da verdade do capital disponível para operar — o CLOB valida
 * as ordens da deposit wallet contra esse saldo. Usado pelo MM para não
 * cotar quando o custo do par + ordens ativas excede o saldo.
 */
export async function getOnchainBalance(depositWallet?: string): Promise<number> {
  try {
    const dw = String(depositWallet || DEPOSIT_WALLET || '').trim();
    if (!dw) return 0;
    const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC || 'https://polygon-bor-rpc.publicnode.com', 137);
    const pusd = new ethers.Contract(PUSD, ['function balanceOf(address) view returns (uint256)'], provider);
    const bal = await pusd.balanceOf(dw);
    return Number(ethers.formatUnits(bal, 6));
  } catch (e: any) {
    log.warn(`⚠️ getOnchainBalance falhou: ${e.message}`);
    return 0;
  }
}

// V2 Exchange contract (Polygon): https://docs.polymarket.com/resources/contracts
const EXCHANGE_V2 = '0xE111180000d2663C0091e4f400237545B87B996B';
const NEG_RISK_EXCHANGE_V2 = '0xe2222d279d744050d28e00520010520000310F59';

// Deposit wallet da wallet signer (deployada via relayer — o saldo/allowances
// ficam nela). Ordens usam signatureType=3 (EIP-1271) com maker = deposit wallet.
const DEPOSIT_WALLET = process.env.POLYMARKET_DEPOSIT_WALLET || '0x82d51169a7af29f26a276aaa303bc29b67f1c130';

// Struct V2: remove taker/expiration/nonce/feeRateBps; adiciona timestamp/metadata/builder.
const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'metadata', type: 'bytes32' },
    { name: 'builder', type: 'bytes32' },
  ],
};

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${msg}`, ...args),
};

export interface ClobCredentials {
  address: string;
  privateKey: string;
  apiCreds?: { key: string; secret: string; passphrase: string };
}

// Cache de credenciais L2 por endereço (derivadas uma vez, reutilizadas).
const l2CredsCache = new Map<string, { key: string; secret: string; passphrase: string }>();

/** CLOB Auth typed-data (L1) — usado para derivar as credenciais L2. */
const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
};
const CLOB_AUTH_DOMAIN = { name: 'ClobAuthDomain', version: '1', chainId: 137 };

/**
 * Obtém credenciais L2 válidas: tenta derivar (GET /auth/derive-api-key,
 * reutiliza a existente); se falhar, cria com nonces crescentes.
 */
export async function deriveClobApiKey(credentials: ClobCredentials): Promise<{ key: string; secret: string; passphrase: string }> {
  const cached = l2CredsCache.get(credentials.address);
  if (cached) return cached;

  const wallet = new ethers.Wallet(credentials.privateKey);
  const tempClient = new ClobClient({
    host: getClobBase(),
    chain: 137,
    signer: toViemLikeSigner(wallet),
    useServerTime: true,
  });

  // 1. Tenta derivar a existente com nonces 0..5 (a nonce=0 pode estar corrompida
  //    por integração antiga — as demais são válidas)
  for (let nonce = 0; nonce <= 5; nonce++) {
    try {
      const derived = await (tempClient as any).deriveApiKey(nonce);
      const out = {
        key: String(derived?.key || ''),
        secret: String(derived?.secret || ''),
        passphrase: String(derived?.passphrase || ''),
      };
      if (out.key && out.secret && out.passphrase) {
        l2CredsCache.set(credentials.address, out);
        return out;
      }
    } catch { /* tenta próximo nonce */ }
  }

  // 2. Cria com nonces 0..5 (a 0 pode estar corrompida)
  let lastError = '';
  for (let nonce = 0; nonce <= 5; nonce++) {
    try {
      const creds = await (tempClient as any).createApiKey(nonce);
      const out = {
        key: String(creds?.key || ''),
        secret: String(creds?.secret || ''),
        passphrase: String(creds?.passphrase || ''),
      };
      if (out.key && out.secret && out.passphrase) {
        l2CredsCache.set(credentials.address, out);
        return out;
      }
    } catch (e: any) {
      lastError = e.message;
    }
  }
  throw new Error(`CLOB derive-api-key falhou: ${lastError || 'sem resposta'}`);
}

/** Deriva as credenciais de assinatura a partir de uma ExchangeKey com exchangeId 'polymarket'. */
export function resolveClobCredentials(exchangeKeyDoc: any): ClobCredentials {
  const address = String(exchangeKeyDoc.apiKey || '').toLowerCase();
  if (!address.startsWith('0x') || address.length !== 42) {
    throw new Error('ExchangeKey polymarket inválida: apiKey deve ser o endereço 0x... da wallet');
  }
  let privateKey = String(exchangeKeyDoc.apiSecret || '');
  try {
    const aad = exchangeKeyDoc.userId ? `${exchangeKeyDoc.userId}-polymarket` : '';
    privateKey = decryptSecretKey(privateKey, aad);
  } catch {
    // usa raw se não estiver criptografada
  }
  const wallet = new ethers.Wallet(privateKey);
  if (wallet.address.toLowerCase() !== address) {
    throw new Error(`ExchangeKey polymarket: endereço (${address}) não bate com a chave privada (${wallet.address})`);
  }
  return { address, privateKey };
}

/** Gera o domínio EIP-712 do Exchange V2 (Polymarket CLOB). */
export function orderDomain(chainId = 137, negRisk = false): { name: string; version: string; chainId: number; verifyingContract: string } {
  return {
    name: 'Polymarket CTF Exchange',
    version: '2',
    chainId,
    verifyingContract: negRisk ? NEG_RISK_EXCHANGE_V2 : EXCHANGE_V2,
  };
}

/** Assina uma ordem limit (maker) no formato CLOB V2 e devolve o payload para POST /order. */
export async function signOrder(params: {
  credentials: ClobCredentials;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number; // preço por ação em pUSD (ex: 0.47)
  size: number; // número de ações
  expirationMs?: number; // GTD no wire (não assinado)
  negRisk?: boolean;
}): Promise<{ order: any; signature: string }> {
  const { credentials, tokenId, side, price, size } = params;
  const expirationSec = Math.floor((Date.now() + (params.expirationMs ?? 60 * 60 * 1000)) / 1000);
  const timestamp = BigInt(Date.now()); // ms — substitui nonce p/ unicidade

  // makerAmount = custo em pUSD (6 casas), takerAmount = ações (6 casas)
  const makerAmount = Math.round(size * price * 1e6);
  const takerAmount = Math.round(size * 1e6);
  const salt = BigInt(Date.now() * 1000 + Math.floor(Math.random() * 1000));
  const sideNum = side === 'BUY' ? 0 : 1;
  const zeroBytes32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

  const wallet = new ethers.Wallet(credentials.privateKey);
  const domain = orderDomain(137, params.negRisk ?? false);

  // Deposit wallet: maker/signer = deposit wallet, signatureType=3 (EIP-1271).
  // A assinatura é feita pela EOA signer (owner da deposit wallet).
  const order = {
    salt,
    maker: DEPOSIT_WALLET,
    signer: DEPOSIT_WALLET,
    tokenId: BigInt(tokenId),
    makerAmount: BigInt(makerAmount),
    takerAmount: BigInt(takerAmount),
    side: sideNum,
    signatureType: 3, // EIP-1271 (deposit wallet)
    timestamp,
    metadata: zeroBytes32,
    builder: zeroBytes32,
  };

  const signature = await wallet.signTypedData(domain, ORDER_TYPES, order);

  return {
    order: {
      salt: order.salt.toString(),
      maker: order.maker,
      signer: order.signer,
      taker: '0x0000000000000000000000000000000000000000', // V2: zero no wire
      tokenId: order.tokenId.toString(),
      makerAmount: order.makerAmount.toString(),
      takerAmount: order.takerAmount.toString(),
      expiration: '0', // GTC: sem expiração no wire (o orderType já define GTC)
      side: side, // wire usa string "BUY"/"SELL"
      signatureType: order.signatureType,
      timestamp: order.timestamp.toString(),
      metadata: order.metadata,
      builder: order.builder,
    },
    signature,
  };
}

/** Coloca uma ordem no CLOB (POST /order) com auth L2 via createL2Headers da SDK. */
export async function placeOrder(
  credentials: ClobCredentials,
  signed: { order: any; signature: string }
): Promise<string> {
  // Garante credenciais L2
  if (!credentials.apiCreds) {
    credentials.apiCreds = await deriveClobApiKey(credentials);
  }

  // Sincroniza saldo/allowance com o CLOB antes da ordem: sem isso a CLOB usa
  // o saldo stale (ex: $0.02) e rejeita com "not enough balance / allowance"
  // mesmo com pUSD depositado na wallet (o update registra o saldo on-chain).
  await updateCollateralBalance(credentials).catch(() => {});

  // Monta o wire V2 com orderToJsonV2 da SDK (converte salt p/ int etc.)
  // owner = signer EOA (dono da API key); maker/signer da ordem = deposit wallet.
  const orderPayload = orderToJsonV2(
    { ...signed.order, signature: signed.signature },
    credentials.address,
    OrderType.GTC,
    false,
    false
  );
  const bodyStr = JSON.stringify(orderPayload);

  const signer = toViemLikeSigner(new ethers.Wallet(credentials.privateKey));
  const headers = await (createL2Headers as any)(signer, credentials.apiCreds, {
    method: 'POST',
    requestPath: '/order',
    body: bodyStr,
  });

  const res = await withTimeout(
    fetch(`${getClobBase()}/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: bodyStr,
    }),
    15_000,
    null
  );
  if (!res) throw new Error('Timeout ao colocar ordem no CLOB');
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`CLOB placeOrder falhou: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return String(data?.orderID || data?.orderId || '');
}

/** Cancela uma ordem (DELETE /order/:id). */
export async function cancelOrder(credentials: ClobCredentials, orderId: string): Promise<void> {
  if (!credentials.apiCreds) {
    credentials.apiCreds = await deriveClobApiKey(credentials);
  }
  const path = `/order/${orderId}`;
  const bodyStr = JSON.stringify({ owner: credentials.address });
  const signer = toViemLikeSigner(new ethers.Wallet(credentials.privateKey));
  const headers = await (createL2Headers as any)(signer, credentials.apiCreds, {
    method: 'DELETE',
    requestPath: path,
    body: bodyStr,
  });
  const res = await withTimeout(
    fetch(`${getClobBase()}${path}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: bodyStr,
    }),
    15_000,
    null
  );
  if (res && !res.ok) {
    const data = await res.json().catch(() => ({}));
    log.warn(`⚠️ CLOB cancelOrder ${orderId}: ${JSON.stringify(data).slice(0, 200)}`);
  }
}

/** Busca o order book de um token (GET /book). */
export async function fetchBook(tokenId: string): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
  const res = await withTimeout(fetch(`${getClobBase()}/book?token_id=${tokenId}`), 10_000, null);
  if (!res || !res.ok) return { bids: [], asks: [] };
  const data: any = await res.json();

  // A CLOB da Polymarket retorna bids do PIOR para o MELHOR preço, e asks do
  // MAIOR para o MENOR preço. Normalizamos: bids em ordem decrescente de preço
  // (melhor primeiro) e asks em ordem crescente (melhor primeiro).
  const bids = (data?.bids || [])
    .map((b: any) => [Number(b.price), Number(b.size)] as [number, number])
    .sort((a: [number, number], b: [number, number]) => b[0] - a[0]);
  const asks = (data?.asks || [])
    .map((a: any) => [Number(a.price), Number(a.size)] as [number, number])
    .sort((a: [number, number], b: [number, number]) => a[0] - b[0]);
  return { bids, asks };
}

/** Busca posições reais do usuário (GET /positions) — fonte da verdade. */
export async function fetchPositions(credentials: ClobCredentials): Promise<any[]> {
  const res = await withTimeout(
    fetch(`${getClobBase()}/positions?user=${credentials.address}`),
    10_000,
    null
  );
  if (!res || !res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export { log };
