// RPC Failover para Polygon - múltiplos endpoints com retry automático
import { ethers } from 'ethers';

const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

// Endpoints RPC da Polygon em ordem de prioridade
const RPC_ENDPOINTS = [
  process.env.POLYGON_RPC_PRIMARY,
  process.env.POLYGON_RPC_SECONDARY,
  process.env.POLYGON_RPC_TERTIARY,
  'https://polygon-bor-rpc.publicnode.com',
  'https://alchemy.com/v2/demo',
  'https://polygon-rpc.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon.llamarpc.com',
  'https://quicknode.com/v2/demo',
].filter(Boolean) as string[];

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${msg}`, ...args),
};

/**
 * Tenta executar uma operação com failover entre múltiplos RPCs.
 * Retorna o resultado da primeira chamada bem-sucedida.
 */
export async function withRpcFailover<T>(
  operation: (provider: ethers.JsonRpcProvider) => Promise<T>,
  endpoints: string[] = RPC_ENDPOINTS
): Promise<T> {
  let lastError: Error | null = null;

  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i];
    const provider = new ethers.JsonRpcProvider(endpoint, 137);

    try {
      const result = await operation(provider);
      if (i > 0) {
        log.info(`✅ RPC failover: sucesso no endpoint #${i + 1} (${endpoint})`);
      }
      return result;
    } catch (e: any) {
      lastError = e;
      log.warn(`⚠️ RPC endpoint #${i + 1} falhou (${endpoint}): ${e.message}`);
      // Continua para o próximo endpoint
    }
  }

  throw lastError || new Error('Todos os endpoints RPC falharam');
}

/**
 * Obtém saldo pUSD ON-CHAIN da deposit wallet com failover de RPC.
 */
export async function getOnchainBalanceWithFailover(depositWallet: string): Promise<number> {
  try {
    const dw = String(depositWallet || '').trim();
    if (!dw) return 0;

    return await withRpcFailover(async (provider) => {
      const pusd = new ethers.Contract(PUSD, ERC20_ABI, provider);
      const bal = await pusd.balanceOf(dw);
      return Number(ethers.formatUnits(bal, 6));
    });
  } catch (e: any) {
    log.error(`❌ getOnchainBalanceWithFailover falhou em todos os endpoints: ${e.message}`);
    return 0;
  }
}

/**
 * Verifica se um endpoint RPC está saudável.
 */
export async function checkRpcHealth(endpoint: string): Promise<boolean> {
  try {
    const provider = new ethers.JsonRpcProvider(endpoint, 137);
    await provider.getBlockNumber();
    return true;
  } catch {
    return false;
  }
}

/**
 * Retorna o primeiro endpoint RPC saudável.
 */
export async function getHealthyRpcEndpoint(endpoints: string[] = RPC_ENDPOINTS): Promise<string | null> {
  for (const endpoint of endpoints) {
    if (await checkRpcHealth(endpoint)) {
      return endpoint;
    }
  }
  return null;
}

export { RPC_ENDPOINTS };