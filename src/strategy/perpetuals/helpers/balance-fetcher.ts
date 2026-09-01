// @ts-nocheck
import PerpArbTrade from '../../../models/PerpArbTrade';
import PerpArbStrategy from '../../../models/PerpArbStrategy';
import { withTimeout } from './ccxt-factory';

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${msg}`, ...args),
};

export async function getDetailedSpotBalance(exchangeInstance: any): Promise<{ spotUsdt: number; spotUsdc: number; rawBalance: any }> {
  try {
    let balance: any = null;
    if (exchangeInstance.has['fetchBalance']) {
      balance = await withTimeout(exchangeInstance.fetchBalance(), 10000, null);
    }
    if (!balance) return { spotUsdt: 0, spotUsdc: 0, rawBalance: null };

    let spotUsdt = Number(balance.free?.USDT ?? balance.USDT?.free ?? 0);
    let spotUsdc = Number(balance.free?.USDC ?? balance.USDC?.free ?? 0);

    if (spotUsdt === 0 && balance.info && Array.isArray(balance.info.balances)) {
      const itemT = balance.info.balances.find((b: any) => b.asset === 'USDT' || b.currency === 'USDT');
      if (itemT) spotUsdt = Number(itemT.free || itemT.availableBalance || 0);
      const itemC = balance.info.balances.find((b: any) => b.asset === 'USDC' || b.currency === 'USDC');
      if (itemC) spotUsdc = Number(itemC.free || itemC.availableBalance || 0);
    }

    return { spotUsdt, spotUsdc, rawBalance: balance };
  } catch (err: any) {
    log.warn(`⚠️ [BALANCE SPOT ${exchangeInstance.id?.toUpperCase()}] Erro ao buscar saldo spot: ${err?.message}${err?.response?.data ? ` | Response: ${JSON.stringify(err.response.data).slice(0,200)}` : ''}`);
    return { spotUsdt: 0, spotUsdc: 0, rawBalance: null };
  }
}

export function parseBalanceValue(item: any): number {
  if (!item) return 0;
  const equity = Number(item.equity || item.total || item.cashBalance || 0);
  if (equity > 0) return equity;
  const avail = Number(item.availableBalance || item.free || 0);
  const margin = Number(item.positionMargin || item.frozenBalance || item.used || 0);
  return Math.max(0, avail + margin);
}

export function parseFreeValue(item: any): number {
  if (!item) return 0;
  const raw = Number(item.availableOpen ?? item.availableCash ?? item.availableBalance ?? item.free ?? item.availableMargin ?? 0);
  return Math.max(0, raw);
}

export async function getDetailedFuturesBalance(exchangeInstance: any): Promise<{ futuresUsdt: number; futuresUsdc: number }> {
  let futuresUsdt = 0;
  let futuresUsdc = 0;

  try {
    if (exchangeInstance.id === 'mexc' && typeof exchangeInstance.contractPrivateGetAccountAssets === 'function') {
      try {
        const res = await withTimeout(exchangeInstance.contractPrivateGetAccountAssets(), 8000, null);
        const dataArr = res?.data || res?.data?.data || res;
        if (Array.isArray(dataArr)) {
          const usdtItem = dataArr.find((item: any) => item.currency === 'USDT');
          const usdcItem = dataArr.find((item: any) => item.currency === 'USDC');
          if (usdtItem) futuresUsdt = parseFreeValue(usdtItem);
          if (usdcItem) futuresUsdc = parseFreeValue(usdcItem);
          return { futuresUsdt, futuresUsdc };
        }
      } catch {}
    }

    let balance: any = null;
    if (exchangeInstance.has['fetchBalance']) {
      try {
        balance = await withTimeout(exchangeInstance.fetchBalance(), 8000, null);
      } catch (fbErr: any) {
        if (fbErr?.message?.includes('-2015') || fbErr?.message?.includes('permissions')) {
          log.warn(`⚠️ API Key [${exchangeInstance.id}] não possui permissão de Futuros ativada na corretora.`);
        }
      }
    }

    if (balance) {
      const freeT = Number(balance.free?.USDT ?? balance.USDT?.free ?? 0);
      futuresUsdt = Math.max(0, freeT);

      const freeC = Number(balance.free?.USDC ?? balance.USDC?.free ?? 0);
      futuresUsdc = Math.max(0, freeC);

      if (futuresUsdt === 0 && balance.info) {
        const dataArr = Array.isArray(balance.info)
          ? balance.info
          : (Array.isArray(balance.info.data) ? balance.info.data : (Array.isArray(balance.info?.balances) ? balance.info.balances : []));

        const itemT = dataArr.find((b: any) => b.currency === 'USDT' || b.asset === 'USDT');
        if (itemT) futuresUsdt = parseFreeValue(itemT);

        const itemC = dataArr.find((b: any) => b.currency === 'USDC' || b.asset === 'USDC');
        if (itemC) futuresUsdc = parseFreeValue(itemC);
      }
    } else {
      log.warn(`⚠️ [BALANCE FUTUROS ${exchangeInstance.id?.toUpperCase()}] fetchBalance retornou vazio/null`);
    }
  } catch (err: any) {
    log.warn('⚠️ Erro ao calcular saldo de Futuros:', err?.message);
  }
  return { futuresUsdt, futuresUsdc };
}

export async function getExchangeUsdBalance(exchangeInstance: any): Promise<number> {
  const { spotUsdt, spotUsdc } = await getDetailedSpotBalance(exchangeInstance);
  return spotUsdt + spotUsdc;
}

export async function fetchPerpPosition(perpExchange: any, perpSymbol: string): Promise<{ contracts: number; notional: number; side: string | null }> {
  const fallback = { contracts: 0, notional: 0, side: null };
  try {
    if (!perpExchange.has?.['fetchPositions']) {
      return { contracts: NaN, notional: NaN, side: null };
    }
    const positions = await withTimeout(perpExchange.fetchPositions([perpSymbol]), 8000, null);
    if (!Array.isArray(positions)) {
      return { contracts: NaN, notional: NaN, side: null };
    }
    const pos = positions.find((p: any) => {
      const symbolMatch = String(p.symbol || '').toLowerCase() === String(perpSymbol).toLowerCase();
      const signed = Number(p.contractsSigned ?? 0);
      const contracts = Number(p.contracts ?? 0);
      return symbolMatch && (signed !== 0 || contracts > 0);
    });
    if (!pos) return fallback;
    const contracts = Math.abs(Number(pos.contracts ?? 0));
    const signed = Number(pos.contractsSigned ?? 0);
    return {
      contracts: signed !== 0 ? Math.abs(signed) : contracts,
      notional: Math.abs(Number(pos.notional ?? 0)),
      side: pos.side ?? (signed > 0 ? 'long' : signed < 0 ? 'short' : null),
    };
  } catch (e: any) {
    log.warn(`⚠️ Erro ao obter posição no perp para ${perpSymbol}:`, e?.message);
    return { contracts: NaN, notional: NaN, side: null };
  }
}

export async function reconcilePhantomPosition(strat: any, perpExchange: any, spotExchange: any) {
  try {
    const perpPos = await fetchPerpPosition(perpExchange, strat.perpSymbol);
    const contracts = Number(perpPos.contracts);

    if (Number.isFinite(contracts) && contracts === 0) {
      let spotFree = -1;
      try {
        const baseSymbol = strat.spotSymbol.split('/')[0];
        const balance = await withTimeout(spotExchange.fetchBalance(), 8000, null);
        if (balance) {
          spotFree = Number(balance?.[baseSymbol]?.free ?? balance?.free?.[baseSymbol] ?? 0);
        }
      } catch { }

      const threshold = Number(strat.positionSize || strat.tradeSize || 0) * 0.01;
      if (spotFree === 0 || (spotFree > 0 && spotFree * Number(strat.lastSpotPrice || 1) < threshold)) {
        log.info(`🛡️ [RECONCILE] [${strat.name}] Posição fantasma detectada: perp zerado + spot sem saldo real (${spotFree} ${strat.spotSymbol.split('/')[0]}). Fechando estado no banco.`);

        const realizedFunding = Number(strat.fundingCollected || 0);
        await (PerpArbTrade as any).create({
          userId: strat.userId,
          strategyId: strat._id,
          strategyName: strat.name,
          perpSymbol: strat.perpSymbol,
          spotSymbol: strat.spotSymbol,
          type: 'close_hedge',
          status: 'executed',
          amount: Number(strat.positionSize || strat.tradeSize || 0),
          spotPrice: strat.lastSpotPrice || null,
          perpPrice: strat.lastPerpPrice || null,
          pnl: realizedFunding,
          reason: 'Reconciliação automática (posição fantasma — fechada fora do robô)',
          openedAt: strat.positionOpenedAt || undefined,
          fundingHistory: strat.fundingHistory || [],
          spotOrderId: 'RECONCILED',
          perpOrderId: 'RECONCILED',
        });

        if (strat.isAutoCreated) {
          await (PerpArbStrategy as any).findByIdAndDelete(strat._id);
          log.info(`🗑️ [RECONCILE] Estratégia [${strat.name}] criada automaticamente excluída após reconciliação.`);
        } else {
          await (PerpArbStrategy as any).findByIdAndUpdate(strat._id, {
            active: false,
            positionOpen: false,
            positionOpenedAt: null,
            fundingCollected: 0,
            fundingCount: 0,
            fundingHistory: [],
          });
          log.info(`✅ [RECONCILE] Estratégia [${strat.name}] marcada como FECHADA (positionOpen=false).`);
        }
        return true;
      }
    }
  } catch (e: any) {
    log.warn(`⚠️ [RECONCILE] Erro ao reconciliar [${strat.name}]:`, e.message);
  }
  return false;
}
