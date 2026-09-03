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
import { withRpcFailover } from './rpc-failover';

// Proxy Dublin (contorna geoblock do servidor). Lido em runtime.
function getProxyBase(): string {
  const base = process.env.POLYMARKET_CLOB_BASE;
  if (!base) throw new Error('POLYMARKET_CLOB_BASE não configurada para o proxy CLOB');
  return base;
}

// Cache de clients por endereço.
const clients = new Map<string, any>();

/** Interface para o documento ExchangeKeyPolymarket. */
export interface ExchangeKeyDoc {
  _id: any;
  userId: string;
  apiKey: string;
  apiSecret: string;
  relayerApiKey?: string;
  relayerApiKeyAddress?: string;
  depositWallet: string;
  active?: boolean;
}

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
      const u = new URL(String((url as any).url));
      target = new (global as any).Request(getProxyBase() + u.pathname + u.search, {
        method: (url as any).method,
        headers: (url as any).headers,
        body: (url as any).body,
        duplex: 'half',
      });
    }
    return origFetch(target, opts);
  };
}

/** Descriptografa a private key da ExchangeKey. */
function getPrivateKey(doc: ExchangeKeyDoc): string {
  let pk = String(doc.apiSecret || '');
  try {
    const aad = doc.userId ? `${doc.userId}-polymarket` : '';
    pk = decryptSecretKey(pk, aad);
  } catch { /* raw */ }
  return pk.startsWith('0x') ? pk : `0x${pk}`;
}

/** Cria (ou reutiliza) o secure client da SDK para a wallet EOA + deposit wallet. */
export async function getSecureClient(exchangeKeyDoc: ExchangeKeyDoc): Promise<any> {
  installProxyIntercept();
  const address = String(exchangeKeyDoc.apiKey || '').toLowerCase();
  const cached = clients.get(address);
  if (cached) return cached;

  const relayerKey = String(exchangeKeyDoc.relayerApiKey || process.env.POLYMARKET_RELAYER_KEY || '').trim();
  if (!relayerKey) throw new Error('Relayer API key não configurada (ExchangeKey polymarket)');

  const depositWallet = String(exchangeKeyDoc.depositWallet || '').toLowerCase();
  if (!depositWallet.startsWith('0x') || depositWallet.length !== 42) {
    throw new Error('Deposit wallet não configurada ou inválida na ExchangeKey');
  }

  const signer = privateKey(getPrivateKey(exchangeKeyDoc));
  const client = await createSecureClient({
    wallet: depositWallet,
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
  const dw = String(exchangeKeyDoc?.depositWallet || '').trim();
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
  // 1. Tenta o caminho da SDK (funciona quando o mercado está na Gamma).
  //    Com RETRY amplo: o "No market found" é timing — o mercado pode sair da
  //    Gamma por vários minutos após o vencimento antes de ficar "pronto"
  //    para o redeem. Até 30 tentativas com 10s de espera (~5min) cobrem a
  //    demora normal de encerramento e liberação do capital.
  const MAX_TENTATIVAS = 30;
  const ESPERA_MS = 10_000;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      const client = await getSecureClient(exchangeKeyDoc);
      await client.redeemPositions({ conditionId });
      return;
    } catch (e: any) {
      const msg = String(e?.message || '');
      const ehTiming = msg.includes('No market found') || msg.includes('rate limit') || msg.includes('429');
      if (!ehTiming) {
        // Erro não relacionado a timing — não adianta retry infinito, cai direto.
        throw e;
      }
      if (tentativa === MAX_TENTATIVAS) {
        console.warn(`⚠️ [redeem] SDK falhou após ${MAX_TENTATIVAS} tentativas (${msg.slice(0, 80)}). Tentando redeem direto no contrato...`);
        break;
      }
      console.warn(`⚠️ [redeem] SDK falhou na tentativa ${tentativa}/${MAX_TENTATIVAS} (${msg.slice(0, 80)}). Aguardando ${ESPERA_MS / 1000}s e tentando de novo...`);
      await new Promise((r) => setTimeout(r, ESPERA_MS));
    }
  }

  // 2. Fallback: redeem direto no contrato. Detectar se o mercado é negRisk
  //    (via CLOB /neg-risk) para escolher o adapter correto.
  console.warn(`⚠️ [redeem] SDK não conseguiu após retries. Tentando redeem direto no contrato...`);
  const { ethers } = await import('ethers');

  const COLLATERAL = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
  const CONDITIONAL_TOKENS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
  const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

  let pk = String(exchangeKeyDoc.apiSecret || '');
  try {
    const aad = exchangeKeyDoc.userId ? `${exchangeKeyDoc.userId}-polymarket` : '';
    pk = decryptSecretKey(pk, aad);
  } catch { /* raw */ }
  if (!pk.startsWith('0x')) pk = `0x${pk}`;

  const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

  // Detecta negRisk pelo primeiro tokenId da posição (via CLOB)
  let negRisk = false;
  try {
    const dw = String(exchangeKeyDoc.depositWallet || '').trim();
    const posRes = await fetch(`https://data-api.polymarket.com/positions?user=${dw}&limit=100`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (posRes?.ok) {
      const poss = await posRes.json();
      const pos = (Array.isArray(poss) ? poss : []).find((p: { conditionId: string; asset?: string }) => p.conditionId === conditionId);
      if (pos?.asset) {
        const nr = await fetch(`https://clob.polymarket.com/neg-risk?token_id=${pos.asset}`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
        if (nr?.ok) {
          const nrj = (await nr.json()) as { neg_risk?: boolean };
          negRisk = nrj?.neg_risk === true;
        }
      }
    }
  } catch { /* assume não negRisk */ }

  const redeemAbi = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  ];
  const target = negRisk ? NEG_RISK_ADAPTER : CONDITIONAL_TOKENS;
  console.warn(`ℹ️ [redeem] Mercado ${negRisk ? 'NEG-RISK' : 'padrão'} — usando adapter ${negRisk ? 'NegRisk' : 'CTF'}.`);

  // Executa o redeem com failover de RPC
  await withRpcFailover(async (provider) => {
    const wallet = new ethers.Wallet(pk, provider);
    const contract = new ethers.Contract(target, redeemAbi, wallet);
    const tx = await contract.redeemPositions(COLLATERAL, ZERO, conditionId, [0, 1], { gasLimit: 500000 });
    await tx.wait();
    console.warn(`✅ [redeem] Redeem direto OK (tx ${tx.hash}).`);
  });
}
