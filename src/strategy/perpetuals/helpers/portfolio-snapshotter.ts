// @ts-nocheck
import mongoose from 'mongoose';
import PerpArbStrategy from '../../../models/PerpArbStrategy';
import PerpArbTrade from '../../../models/PerpArbTrade';
import ExchangeKey from '../../../models/ExchangeKey';
import PortfolioSnapshot from '../../../models/PortfolioSnapshot';
import { withTimeout, getExchangeInstance } from './ccxt-factory';
import { getDetailedSpotBalance, getDetailedFuturesBalance } from './balance-fetcher';

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${msg}`, ...args),
};

let lastSnapshotTimestamp = 0;
let isSnapshotRunning = false;

export async function takePortfolioSnapshot(userId: string, force: boolean = false) {
  const now = Date.now();
  if (!force && now - lastSnapshotTimestamp < 15 * 1000) return;
  if (isSnapshotRunning) return;

  isSnapshotRunning = true;
  lastSnapshotTimestamp = now;

  try {
    let query: any = { active: true };
    if (userId) {
      const userObjId = mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : userId;
      query.$or = [{ userId: userObjId }, { userId: String(userId) }];
    }
    const keys = await (ExchangeKey as any).find(query).lean();
    
    if (!keys || !keys.length) {
      isSnapshotRunning = false;
      return;
    }

    let strategiesRef: any[] = [];
    try {
      strategiesRef = await (PerpArbStrategy as any).find({
        $or: [{ active: true }, { positionOpen: true }]
      }).lean();
    } catch { strategiesRef = []; }

    const openCostByBase: Record<string, { spotPrice: number; totalCost: number; totalQty: number }> = {};
    try {
      const openHedgeTrades = await (PerpArbTrade as any).find({
        type: 'open_hedge',
        status: { $in: ['executed', 'simulated'] },
      }).sort({ createdAt: 1 }).lean();

      const closeHedgeTrades = await (PerpArbTrade as any).find({
        type: 'close_hedge',
        status: { $in: ['executed', 'simulated'] },
      }).sort({ createdAt: 1 }).lean();

      for (const open of openHedgeTrades) {
        const openCreated = new Date(open.createdAt).getTime();
        let closed = !!closeHedgeTrades.some(
          (c: any) => String(c.openTradeId || '') === String(open._id || '')
        );

        if (!closed) {
          const sym = open.perpSymbol || '';
          const fechouPorSimbolo = closeHedgeTrades
            .filter((c: any) => new Date(c.createdAt).getTime() > openCreated)
            .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .find((c: any) => {
              if (!sym) return false;
              return String(c.perpSymbol || '').toLowerCase() === String(sym).toLowerCase();
            });
          if (fechouPorSimbolo) closed = true;
          else {
            const pastOpens = openHedgeTrades
              .filter((o: any) => {
                const oCreated = new Date(o.createdAt).getTime();
                return String(o.perpSymbol || '').toLowerCase() === String(sym).toLowerCase() && oCreated < openCreated;
              })
              .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
            
            const closesApos = closeHedgeTrades
              .filter((c: any) => new Date(c.createdAt).getTime() > openCreated)
              .sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
            
            for (const close of closesApos) {
              if (String(close.perpSymbol || '').toLowerCase() !== String(sym).toLowerCase()) continue;
              const priorOpenForClose = pastOpens.find((o: any) => {
                const oCreated = new Date(o.createdAt).getTime();
                const cCreated = new Date(close.createdAt).getTime();
                return oCreated < cCreated;
              });
              if (priorOpenForClose && String(priorOpenForClose._id) === String(open._id)) {
                closed = true;
                break;
              }
            }
          }
        }

        if (closed) continue;

        const spotSymbol = String(open.spotSymbol || '');
        const baseSymbol = spotSymbol.split('/')[0].trim() || spotSymbol;
        const price = Number(open.spotPrice || 0);
        const amount = Number(open.amount || 0);

        if (price > 0 && amount > 0) {
          const qty = Number(open.spotQuantity || (amount / price));
          const prev = openCostByBase[baseSymbol];
          if (prev) {
            const newTotalQty = prev.totalQty + qty;
            prev.totalCost = prev.totalCost + amount;
            prev.spotPrice = newTotalQty > 0 ? (prev.totalCost / newTotalQty) : prev.spotPrice;
            prev.totalQty = newTotalQty;
          } else {
            openCostByBase[baseSymbol] = { spotPrice: price, totalCost: amount, totalQty: qty };
          }
        }
      }
    } catch (costErr: any) {
      log.warn('⚠️ Erro ao calcular cost basis no snapshot:', costErr?.message);
    }

    for (const key of keys) {
      const exId = String(key.exchangeId || '').toLowerCase().trim();
      if (exId === 'hyperliquid' || exId === 'ctrader' || exId === 'fix' || exId === 'dukascopy' || exId === 'oanda') {
        continue;
      }
      try {
        const spotInstance = await getExchangeInstance({ apiKey: key.apiKey, apiSecret: key.apiSecret, exchangeId: exId, userId }, false);
        const perpInstance = await getExchangeInstance({ apiKey: key.apiKey, apiSecret: key.apiSecret, exchangeId: exId, userId }, true);

        const { spotUsdt = 0, spotUsdc = 0, rawBalance: spotBalObj = null } = (await getDetailedSpotBalance(spotInstance).catch(() => ({} as any))) || {};
        const { futuresUsdt = 0, futuresUsdc = 0 } = (await getDetailedFuturesBalance(perpInstance).catch(() => ({} as any))) || {};

        let spotTotalEquity = (spotUsdt || 0) + (spotUsdc || 0);
        if (spotBalObj && spotBalObj.total) {
          const totals = spotBalObj.total;
          const spotBalancesInfo = spotBalObj.info?.balances || spotBalObj.info?.assets || [];
          for (const code of Object.keys(totals)) {
            const amt = Number(totals[code] || 0);
            if (amt > 0 && code !== 'USDT' && code !== 'USDC') {
              try {
                const symbol = `${code}/USDT`;
                const tickers = await spotInstance.fetchTickers([symbol]).catch(() => ({}));
                let price = Number(tickers[symbol]?.last || tickers[symbol]?.close || tickers[symbol]?.bid || 0);
                if (price === 0) {
                  const ticker = await spotInstance.fetchTicker(symbol).catch(() => null);
                  price = Number(ticker?.last || ticker?.close || 0);
                }
                if (price > 0) {
                  spotTotalEquity += amt * price;
                } else {
                  const codeUsd = Number(spotBalObj[code]?.usdValue || spotBalObj[code]?.total || 0);
                  if (codeUsd > 0) spotTotalEquity += codeUsd;
                }
              } catch (altErr: any) {
                log.warn(`⚠️ Erro ao converter moedas spot de ${key.name}:`, altErr?.message);
              }
            }
          }
        }

        let futuresTotalEquity = 0;
        if (perpInstance?.has?.['fetchBalance']) {
          try {
            const futBal = await perpInstance.fetchBalance().catch(() => null);
            if (futBal) {
              const totalT = Number(futBal.total?.USDT ?? futBal.USDT?.total ?? 0);
              futuresTotalEquity = totalT;

              if (futBal.info) {
                const dataArr = Array.isArray(futBal.info)
                  ? futBal.info
                  : (Array.isArray(futBal.info.data) ? futBal.info.data : (Array.isArray(futBal.info?.balances) ? futBal.info.balances : []));
                const itemT = dataArr.find((b: any) => b.currency === 'USDT' || b.asset === 'USDT');
                if (itemT) {
                  const eq = Number(itemT.equity || itemT.total || itemT.cashBalance || 0);
                  if (eq > futuresTotalEquity) futuresTotalEquity = eq;
                }
              }
            }
          } catch {}
        }
        if (futuresTotalEquity === 0) {
          futuresTotalEquity = futuresUsdt + futuresUsdc;
        }

        await (ExchangeKey as any).findByIdAndUpdate(key._id, {
          $set: {
            spotUsdt,
            spotUsdc,
            spotTotalEquity,
            futuresUsdt,
            futuresUsdc,
            futuresTotalEquity,
            balancesUpdatedAt: new Date(),
          }
        });

        const spotBal = spotTotalEquity;
        const perpBal = futuresTotalEquity;
        const totalUsdValue = Number((spotBal + perpBal).toFixed(2));

        const totalFreeUsdt = spotUsdt + futuresUsdt;
        if (spotUsdt > 13 && futuresUsdt > 13) {
          const targetHalf = totalFreeUsdt / 2;
          const diffFromTarget = Math.abs(spotUsdt - targetHalf);
          const imbalancePct = (diffFromTarget / totalFreeUsdt) * 100;

          if (imbalancePct > 10) {
            const transferAmount = Math.floor(diffFromTarget * 100) / 100;
            if (transferAmount >= 1) {
              try {
                const fromAcc = spotUsdt > futuresUsdt ? 'spot' : (exId === 'mexc' || exId === 'gateio' || exId === 'bybit' ? 'swap' : 'future');
                const toAcc = spotUsdt > futuresUsdt ? (exId === 'mexc' || exId === 'gateio' || exId === 'bybit' ? 'swap' : 'future') : 'spot';

                let transferDone = false;
                if (typeof spotInstance.transfer === 'function') {
                  try {
                    await spotInstance.transfer('USDT', transferAmount, fromAcc, toAcc);
                    transferDone = true;
                  } catch (ccxtErr: any) {
                    log.warn(`⚠️ [REBALANCE ${exId.toUpperCase()}] CCXT transfer falhou: ${ccxtErr?.message}`);
                  }
                }

                if (!transferDone && exId === 'mexc') {
                  try {
                    if (fromAcc === 'spot' && typeof spotInstance.contractPrivatePostAssetInternalTransfer === 'function') {
                      await spotInstance.contractPrivatePostAssetInternalTransfer({
                        currency: 'USDT',
                        amount: transferAmount,
                        type: 'SPOT_TO_CONTRACT'
                      });
                      transferDone = true;
                    } else if (fromAcc !== 'spot' && typeof spotInstance.contractPrivatePostAssetInternalTransfer === 'function') {
                      await spotInstance.contractPrivatePostAssetInternalTransfer({
                        currency: 'USDT',
                        amount: transferAmount,
                        type: 'CONTRACT_TO_SPOT'
                      });
                      transferDone = true;
                    }
                  } catch (mexcErr: any) {
                    log.warn(`⚠️ [REBALANCE MEXC Direct API] Falha na transferência direta:`, mexcErr?.message);
                  }
                }

                if (transferDone) {
                  log.info(`✅ 🔄 [REBALANCE ${exId.toUpperCase()}] Transferido $${transferAmount.toFixed(2)} USDT Livre de ${fromAcc.toUpperCase()} -> ${toAcc.toUpperCase()} (Desbalanceamento: ${imbalancePct.toFixed(1)}%)`);
                }
              } catch (transErr: any) {
                log.warn(`⚠️ [REBALANCE ${exId.toUpperCase()}] Erro ao transferir saldo:`, transErr?.message);
              }
            }
          }
        }

        const assetBalances: Array<{
          asset: string; free: number; used: number; total: number; usdValue: number;
          avgCostPrice?: number | null; investedValue?: number; totalQty?: number; pnl?: number; pnlPct?: number | null;
        }> = [];

        if (spotBalObj && spotBalObj.total) {
          const totals = spotBalObj.total;
          const spotBalancesInfo = spotBalObj.info?.balances || spotBalObj.info?.assets || [];
          for (const code of Object.keys(totals)) {
            const amt = Number(totals[code] || 0);
            if (amt <= 0) continue;
            let usdValue = 0;
            const infoItem = Array.isArray(spotBalancesInfo)
              ? spotBalancesInfo.find((b: any) => (b.asset || b.currency) === code)
              : null;
            const freeAmt = Number(infoItem?.free ?? (spotBalObj[code]?.free ?? 0));
            const usedAmt = Number(infoItem?.locked ?? infoItem?.used ?? (spotBalObj[code]?.used ?? 0));

            if (code === 'USDT' || code === 'USDC') {
              usdValue = amt;
            } else {
              let price = Number(spotBalObj[code]?.usdValue ?? 0);
              if (price > 0) price = price / amt;
              let spotBid: number | null = null;
              let spotAsk: number | null = null;
              if (price <= 0 || !spotBid || !spotAsk) {
                const symbol = `${code}/USDT`;
                try {
                  const t = await withTimeout(spotInstance.fetchTicker(symbol), 6000, null);
                  price = Number(t?.last || t?.close || price || 0);
                  spotBid = Number(t?.bid || t?.last || price || 0) || null;
                  spotAsk = Number(t?.ask || t?.last || price || 0) || null;
                } catch { price = 0; }
              }
              if (price > 0) usdValue = amt * price;

              if (usdValue > 0) {
                const cost = openCostByBase[code];
                const unitPrice = amt > 0 ? Number((usdValue / amt).toFixed(8)) : null;
                const dbEntry: {
                  asset: string; free: number; used: number; total: number; usdValue: number; price?: number | null;
                  bidPrice?: number | null; askPrice?: number | null;
                  avgCostPrice?: number | null; investedValue?: number; totalQty?: number; pnl?: number; pnlPct?: number | null;
                } = {
                  asset: code,
                  free: Number(freeAmt || 0),
                  used: Number(usedAmt || 0),
                  total: amt,
                  usdValue: Number(usdValue.toFixed(4)),
                  price: unitPrice,
                  bidPrice: spotBid || unitPrice,
                  askPrice: spotAsk || unitPrice,
                };
                if (cost) {
                  const investedQty = Math.min(cost.totalQty, amt);
                  const investedValue = Number((investedQty * cost.spotPrice).toFixed(4));
                  const pnl = Number((usdValue - investedValue).toFixed(4));
                  dbEntry.avgCostPrice = Number(cost.spotPrice.toFixed(8));
                  dbEntry.investedValue = investedValue;
                  dbEntry.totalQty = Number(cost.totalQty.toFixed(8));
                  dbEntry.pnl = pnl;
                  dbEntry.pnlPct = investedValue > 0 ? Number(((pnl / investedValue) * 100).toFixed(4)) : null;
                }
                assetBalances.push(dbEntry);
              }
            }
          }
        }

        if (assetBalances.length === 0) {
          if (spotBal > 0) assetBalances.push({ asset: 'USDT/USDC (Spot)', free: spotUsdt, used: 0, total: spotBal, usdValue: spotBal });
        }
        if (perpBal > 0) {
          assetBalances.push({ asset: 'USDT/USDC (Perp)', free: futuresUsdt, used: 0, total: perpBal, usdValue: perpBal });
        }

        const positions: Array<Record<string, any>> = [];
        let futuresUnrealizedPnl = 0;
        try {
          if (perpInstance?.has?.['fetchPositions']) {
            const openPositions = await withTimeout(perpInstance.fetchPositions(), 10000, []);
            if (Array.isArray(openPositions)) {
              for (const p of openPositions) {
                const contracts = Math.abs(Number(p.contracts ?? p.contractsSigned ?? 0));
                if (contracts <= 0) continue;
                const symbol = String(p.symbol || '');
                const side = p.side || (Number(p.contractsSigned) > 0 ? 'long' : 'short');
                const contractSize = Number(p.contractSize ?? 1);
                const entryPrice = Number(p.entryPrice ?? p.entryprice ?? p.openPrice ?? 0) || null;
                const liquidationPrice = Number(p.liquidationPrice ?? p.liquidationprice ?? 0) || null;
                const leverage = Number(p.leverage ?? 1) || 1;
                const margin = Number(p.initialMargin ?? p.positionMargin ?? 0) || 0;

                const info = p.info || {};
                const unrealizedPnl = Number(
                  info.unRealizedPnl ?? info.unrealizedPnl ?? p.unrealizedPnl ?? p.unrealizedProfit ?? 0
                ) || 0;

                let markPrice: number | null = Number(p.markPrice ?? p.markprice ?? 0) || null;
                let perpBid: number | null = Number(p.bidPrice ?? p.bidprice ?? 0) || null;
                let perpAsk: number | null = Number(p.askPrice ?? p.askprice ?? 0) || null;
                if (!markPrice || !perpBid || !perpAsk) {
                  try {
                    const t = await withTimeout(perpInstance.fetchTicker(symbol), 6000, null);
                    markPrice = Number(t?.last || t?.close || t?.markPrice || markPrice || 0) || null;
                    perpBid = Number(t?.bid || t?.last || markPrice || 0) || null;
                    perpAsk = Number(t?.ask || t?.last || markPrice || 0) || null;
                  } catch { }
                }

                const notional = markPrice
                  ? contracts * contractSize * markPrice
                  : (entryPrice ? contracts * contractSize * entryPrice : 0);

                futuresUnrealizedPnl += unrealizedPnl;

                let strategyName: string | null = null;
                const matched = strategiesRef?.find((s: any) => String(s.perpSymbol || '').toLowerCase() === symbol.toLowerCase());
                if (matched) strategyName = matched.name || null;

                positions.push({
                  symbol,
                  side,
                  contracts,
                  contractSize,
                  notional: Number(notional.toFixed(4)),
                  entryPrice,
                  markPrice,
                  bidPrice: perpBid || markPrice,
                  askPrice: perpAsk || markPrice,
                  liquidationPrice,
                  leverage,
                  unrealizedPnl: Number(unrealizedPnl.toFixed(4)),
                  unrealizedPnlPct: notional > 0 ? Number(((unrealizedPnl / notional) * 100).toFixed(4)) : 0,
                  margin: Number(margin.toFixed(4)),
                  strategyName,
                });
              }
            }
          }
        } catch (posErr: any) {
          log.warn(`⚠️ Erro ao buscar posições futuras no snapshot:`, posErr?.message);
        }

        const keyUserId = key.userId || userId;
        const snapshotUserId = mongoose.Types.ObjectId.isValid(String(keyUserId)) ? new mongoose.Types.ObjectId(String(keyUserId)) : keyUserId;

        const finalSpotBal = Number(spotBal || 0);
        const finalPerpBal = Number(perpBal || 0);
        const finalFuturesUnrealizedPnl = Number(futuresUnrealizedPnl || 0);

        if (totalUsdValue > 0) {
          await (PortfolioSnapshot as any).create({
            userId: snapshotUserId,
            exchange: exId,
            totalUsdValue,
            balances: assetBalances,
            positions,
            spotTotalUsd: Number(finalSpotBal.toFixed(2)),
            futuresTotalUsd: Number(finalPerpBal.toFixed(2)),
            futuresUnrealizedPnl: Number(finalFuturesUnrealizedPnl.toFixed(4)),
            timestamp: new Date(),
          });
          log.info(`📸 [CACHE SALDO & SNAPSHOT] ${key.name} (${exId}) -> Spot Equity: $${finalSpotBal.toFixed(2)} (USDT Livre: $${Number(spotUsdt || 0).toFixed(2)}) | Futures Equity: $${finalPerpBal.toFixed(2)} (USDT Livre: $${Number(futuresUsdt || 0).toFixed(2)}) | Posições: ${positions.length} | PnL não realizado: $${finalFuturesUnrealizedPnl.toFixed(4)}`);
        }
      } catch (exErr: any) {
        log.warn(`⚠️ [SNAPSHOT ${exId.toUpperCase()}] Erro geral ao processar snapshot: ${exErr?.message}`);
      }
    }
  } catch (err: any) {
    log.warn(`⚠️ Erro ao atualizar saldos em cache no funding-arb:`, err?.message);
  } finally {
    isSnapshotRunning = false;
  }
}
