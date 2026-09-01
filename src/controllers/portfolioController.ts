import { Response } from 'express';
import mongoose from 'mongoose';
import PortfolioSnapshot from '../models/PortfolioSnapshot';
import ExchangeKey from '../models/ExchangeKey';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

export async function getPortfolioResumo(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Não autorizado.' });
    }

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    const keys = await ExchangeKey.find({ userId: userObjId, active: true })
      .select('exchangeId name spotUsdt spotUsdc spotTotalEquity futuresUsdt futuresUsdc futuresTotalEquity')
      .lean();

    const exchanges = keys.map((k: any) => ({
      id: k._id.toString(),
      name: k.name,
      exchangeId: k.exchangeId,
      spotUsdt: k.spotUsdt || 0,
      spotUsdc: k.spotUsdc || 0,
      spotTotalEquity: k.spotTotalEquity || 0,
      futuresUsdt: k.futuresUsdt || 0,
      futuresUsdc: k.futuresUsdc || 0,
      futuresTotalEquity: k.futuresTotalEquity || 0
    }));

    const consolidated = {
      spotUsdt: exchanges.reduce((acc, ex) => acc + ex.spotUsdt, 0),
      spotUsdc: exchanges.reduce((acc, ex) => acc + ex.spotUsdc, 0),
      spotTotalEquity: exchanges.reduce((acc, ex) => acc + ex.spotTotalEquity, 0),
      futuresUsdt: exchanges.reduce((acc, ex) => acc + ex.futuresUsdt, 0),
      futuresUsdc: exchanges.reduce((acc, ex) => acc + ex.futuresUsdc, 0),
      futuresTotalEquity: exchanges.reduce((acc, ex) => acc + ex.futuresTotalEquity, 0),
      exchanges
    };

    return res.json({
      success: true,
      message: 'ok',
      data: consolidated
    });
  } catch (e: any) {
    console.error('❌ [GET Portfolio Resumo] Error:', e.message);
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function getPortfolioHistorico(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Não autorizado.' });
    }

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    
    // Busca os snapshots históricos
    const snapshots = await PortfolioSnapshot.find({ userId: userObjId })
      .sort({ timestamp: -1 })
      .limit(100)
      .lean();

    const formatted = snapshots.map((s: any) => ({
      timestamp: s.timestamp,
      totalUsdValue: s.totalUsdValue || 0,
      spotTotalUsd: s.spotTotalUsd || 0,
      futuresTotalUsd: s.futuresTotalUsd || 0,
      futuresUnrealizedPnl: s.futuresUnrealizedPnl || 0
    }));

    return res.json({
      success: true,
      message: 'ok',
      data: formatted
    });
  } catch (e: any) {
    console.error('❌ [GET Portfolio Histórico] Error:', e.message);
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function getPortfolioLive(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Não autorizado.' });
    }

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;

    // Busca os snapshots mais recentes do usuário
    const latestSnapshots = await PortfolioSnapshot.find({ userId: userObjId })
      .sort({ timestamp: -1 })
      .limit(20)
      .lean();

    // Filtra para pegar apenas o mais recente por exchange
    const byExchange = new Map<string, any>();
    for (const snap of latestSnapshots) {
      const ex = snap.exchange || 'unknown';
      if (!byExchange.has(ex)) {
        byExchange.set(ex, snap);
      }
    }

    const activeSnaps = Array.from(byExchange.values());

    const spotCoins: any[] = [];
    const positions: any[] = [];
    let spotTotalUsd = 0;
    let futuresUnrealizedPnl = 0;
    let latestTimestamp = new Date(0);

    for (const snap of activeSnaps) {
      const exchangeName = snap.exchange;
      
      if (snap.timestamp && new Date(snap.timestamp) > latestTimestamp) {
        latestTimestamp = new Date(snap.timestamp);
      }

      spotTotalUsd += snap.spotTotalUsd || 0;
      futuresUnrealizedPnl += snap.futuresUnrealizedPnl || 0;

      if (Array.isArray(snap.balances)) {
        for (const bal of snap.balances) {
          const totalQty = bal.total || (bal.free || 0) + (bal.used || 0);
          let computedPrice = bal.price || null;
          if ((computedPrice === null || computedPrice === undefined) && bal.usdValue > 0 && totalQty > 0) {
            computedPrice = Number((bal.usdValue / totalQty).toFixed(8));
          }

          spotCoins.push({
            asset: bal.asset,
            free: bal.free || 0,
            used: bal.used || 0,
            total: totalQty,
            usdValue: bal.usdValue || 0,
            price: computedPrice,
            bidPrice: bal.bidPrice || computedPrice,
            askPrice: bal.askPrice || computedPrice,
            avgCostPrice: bal.avgCostPrice || null,
            totalCost: bal.totalCost || 0,
            totalQty: bal.totalQty || 0,
            investedValue: bal.investedValue || 0,
            pnl: bal.pnl || 0,
            pnlPct: bal.pnlPct || null,
            exchange: exchangeName
          });
        }
      }

      if (Array.isArray(snap.positions)) {
        for (const pos of snap.positions) {
          const entryPrice = pos.entryPrice || null;
          const markPrice = pos.markPrice || null;
          const liquidationPrice = pos.liquidationPrice || (entryPrice ? Number((entryPrice * 2).toFixed(4)) : null);

          positions.push({
            exchange: exchangeName,
            symbol: pos.symbol,
            side: pos.side,
            contracts: pos.contracts || 0,
            contractSize: pos.contractSize || 1,
            qty: pos.qty || 0,
            notional: pos.notional || 0,
            entryPrice,
            markPrice,
            bidPrice: pos.bidPrice || markPrice,
            askPrice: pos.askPrice || markPrice,
            liquidationPrice,
            leverage: pos.leverage || 1,
            unrealizedPnl: pos.unrealizedPnl || 0,
            unrealizedPnlPct: pos.unrealizedPnlPct || 0,
            margin: pos.margin || 0
          });
        }
      }
    }

    if (latestTimestamp.getTime() === 0) {
      latestTimestamp = new Date();
    }

    return res.json({
      success: true,
      message: 'ok',
      data: {
        spotCoins,
        positions,
        spotTotalUsd,
        futuresUnrealizedPnl,
        timestamp: latestTimestamp.toISOString()
      }
    });
  } catch (e: any) {
    console.error('❌ [GET Portfolio Live] Error:', e.message);
    return res.status(500).json({ success: false, message: e.message });
  }
}
