// Cliente de ordens Polymarket via SDK oficial + proxy Dublin.
//
// Fluxo VALIDADO em produção (ordem real matched):
// 1. A SDK @polymarket/client ASSINA + POSTA a ordem com a deposit wallet
//    (signatureType=3 / ERC-1271).
// 2. O fetch é INTERCEPTADO globalmente: qualquer chamada a
//    clob.polymarket.com é redirecionada para o proxy Vercel em Dublin
//    (dub1), contornando o geoblock do servidor (Alemanha) para trading.
import { createSecureClient, relayerApiKey } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { decryptSecretKey } from '../../../utils/encryption';
import { updateCollateralBalance, resolveClobCredentials } from './clob-client';

// Deposit wallet da wallet signer (deployada via relayer).
const DEPOSIT_WALLET = process.env.POLYMARKET_DEPOSIT_WALLET || '0x82d51169a7af29f26a276aaa303bc29b67f1c130';
// Proxy Dublin (contorna geoblock do servidor). Lido em runtime.
function getProxyBase(): string {
  return process.env.POLYMARKET_CLOB_BASE || 'https://proxy-vercel-lilac.vercel.app/api/proxy/clob';
}

// Cache de clients por endereço.
const clients = new Map<string, any>();

/** Instala o intercept global que redireciona clob.polymarket.com → proxy. */
let interceptInstalled = false;
function installProxyIntercept(): void {
  if (interceptInstalled) return;
  interceptInstalled = true;
  const origFetch = global.fetch;
  (global as any).fetch = async (url: any, opts: any) => {
    let target = url;
    if (typeof url === 'string' && url.startsWith('https://clob.polymarket.com')) {
      target = getProxyBase() + url.slice('https://clob.polymarket.com'.length);
    } else if (url && typeof url === 'object' && String((url as any).url || '').startsWith('https://clob.polymarket.com')) {
      const u = new URL((url as any).url);
      target = new Request(getProxyBase() + u.pathname + u.search, {
        method: (url as any).method,
        headers: (url as any).headers,
        body: (url as any).body,
        duplex: 'half',
      } as any);
    }
    return origFetch(target, opts);
  };
}

/** Descriptografa a private key da ExchangeKey. */
function getPrivateKey(doc: any): string {
  let pk = String(doc.apiSecret || '');
  try {
    const aad = doc.userId ? `${doc.userId}-polymarket` : '';
    pk = decryptSecretKey(pk, aad);
  } catch { /* raw */ }
  return pk.startsWith('0x') ? pk : `0x${pk}`;
}

/** Cria (ou reutiliza) o secure client da SDK para a wallet EOA + deposit wallet. */
export async function getSecureClient(exchangeKeyDoc: any): Promise<any> {
  installProxyIntercept();
  const address = String(exchangeKeyDoc.apiKey || '').toLowerCase();
  const cached = clients.get(address);
  if (cached) return cached;

  const relayerKey = String(exchangeKeyDoc.relayerApiKey || process.env.POLYMARKET_RELAYER_KEY || '').trim();
  if (!relayerKey) throw new Error('Relayer API key não configurada (ExchangeKey polymarket)');

  const signer = privateKey(getPrivateKey(exchangeKeyDoc));
  const client = await createSecureClient({
    wallet: DEPOSIT_WALLET,
    signer,
    apiKey: relayerApiKey({ key: relayerKey, address: String(exchangeKeyDoc.apiKey || '').toLowerCase() }),
  });
  clients.set(address, client);
  return client;
}

/**
 * Coloca uma ordem limit via SDK (deposit wallet / ERC-1271), postando pelo
 * proxy Dublin. Retorna o id da ordem ou lança erro.
 */
export async function placeOrderViaSdk(
  exchangeKeyDoc: any,
  params: { tokenId: string; side: 'BUY' | 'SELL'; price: number; size: number }
): Promise<string> {
  // Sincroniza o saldo/allowance de colateral com o CLOB antes da ordem
  // (o update registra o pUSD depositado na wallet como disponível).
  try {
    const creds = resolveClobCredentials(exchangeKeyDoc);
    await updateCollateralBalance(creds);
  } catch (e: any) {
    // não bloqueia a ordem se o update falhar — o CLOB pode já ter o saldo
    console.warn(`⚠️ [secure-client] updateCollateralBalance antes da ordem falhou: ${e.message}`);
  }
  const client = await getSecureClient(exchangeKeyDoc);
  try {
    const res = await client.placeLimitOrder({
      tokenId: params.tokenId,
      price: params.price,
      size: params.size,
      side: params.side,
    });
    const id = res?.orderId || res?.orderID || res?.id;
    if (!id) {
      // Ordens que preenchem na hora (matched) podem não retornar id em alguns casos
      if (res?.ok === true) return 'matched';
      throw new Error(`SDK placeLimitOrder: resposta sem id (${JSON.stringify(res).slice(0, 200)})`);
    }
    return String(id);
  } catch (e: any) {
    // Código de restrição do CLOB (ex: post_only_mode — mercado recém-aberto
    // em modo post-only, só aceita ordens maker). Propaga com o código para
    // o MM decidir: se post_only, cai para maker (bid) em vez de taker.
    const code = e?.code || e?.cause?.code || '';
    if (code === 'post_only_mode' || String(e.message || '').includes('post-only')) {
      const err = new Error(`post_only_mode: ${e.message}`) as any;
      err.code = 'post_only_mode';
      throw err;
    }
    throw e;
  }
}

/** Cancela uma ordem via SDK (o cancelamento também passa pelo proxy). */
export async function cancelOrderViaSdk(exchangeKeyDoc: any, orderId: string): Promise<void> {
  installProxyIntercept();
  const client = await getSecureClient(exchangeKeyDoc);
  await client.cancelOrder(orderId);
}

/** Busca posições reais do usuário via SDK (acesso direto no servidor). */
export async function fetchPositionsViaSdk(exchangeKeyDoc: any): Promise<any[]> {
  installProxyIntercept();
  const client = await getSecureClient(exchangeKeyDoc);
  const positions = await client.listPositions();
  return Array.isArray(positions) ? positions : [];
}

/**
 * Busca posições reais da DEPOSIT WALLET via Data API pública.
 *
 * A SDK listPositions retorna {} para a deposit wallet (não enxerga as
 * posições EIP-1271). A Data API (data-api.polymarket.com/positions?user=DW)
 * é a fonte da verdade que funciona — retorna size/avg_price por token.
 */
export async function fetchPositionsViaDataApi(exchangeKeyDoc: any): Promise<any[]> {
  const dw = String(exchangeKeyDoc?.depositWallet || DEPOSIT_WALLET || '').trim();
  if (!dw) return [];
  const res = await fetch(`https://data-api.polymarket.com/positions?user=${dw}&limit=100`, {
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

/** Faz redeem de posições de mercados resolvidos (recupera o pUSD). */
export async function redeemPositionsViaSdk(exchangeKeyDoc: any, conditionId: string): Promise<void> {
  installProxyIntercept();
  // 1. Tenta o caminho da SDK (funciona quando o mercado ainda está na Gamma).
  try {
    const client = await getSecureClient(exchangeKeyDoc);
    await client.redeemPositions({ conditionId });
    return;
  } catch (e: any) {
    // Se falhou por "No market found" (mercado saiu da listagem), cai para o
    // redeem DIRETO no contrato NegRisk Adapter — não depende da Gamma.
    if (!String(e?.message || '').includes('No market found')) {
      throw e;
    }
    console.warn(`⚠️ [redeem] SDK falhou (No market found). Tentando redeem direto no NegRisk Adapter...`);
  }

  // 2. Redeem direto via NegRisk Adapter (mercados updown são neg-risk).
  //    devolve o pUSD para a deposit wallet (dona das posições); a EOA paga o gas.
  const { ethers } = await import('ethers');

  const RPC = process.env.POLYGON_RPC || 'https://polygon-bor-rpc.publicnode.com';
  const COLLATERAL = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
  const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

  let pk = String(exchangeKeyDoc.apiSecret || '');
  try {
    const aad = exchangeKeyDoc.userId ? `${exchangeKeyDoc.userId}-polymarket` : '';
    pk = decryptSecretKey(pk, aad);
  } catch { /* raw */ }
  if (!pk.startsWith('0x')) pk = `0x${pk}`;

  const provider = new ethers.JsonRpcProvider(RPC, 137);
  const wallet = new ethers.Wallet(pk, provider);
  const negRiskAbi = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  ];
  const adapter = new ethers.Contract(NEG_RISK_ADAPTER, negRiskAbi, wallet);
  const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';
  const tx = await adapter.redeemPositions(COLLATERAL, ZERO, conditionId, [0, 1], { gasLimit: 500000 });
  await tx.wait();
  console.warn(`✅ [redeem] Redeem direto no NegRisk Adapter OK (tx ${tx.hash}).`);
}
