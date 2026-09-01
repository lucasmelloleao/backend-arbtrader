import { Response } from 'express';
import mongoose from 'mongoose';
import ccxt from 'ccxt';
import PerpArbStrategy from '../models/PerpArbStrategy';
import PerpArbTrade from '../models/PerpArbTrade';
import ExchangeKey from '../models/ExchangeKey';
import { decryptSecretKey } from '../utils/encryption';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import redis from '../utils/redis';

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

// 1. CLOSE STRATEGY
export async function closeStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');
    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const { strategyId, id, perpSymbol } = req.body;
    const targetId = strategyId || id;

    if (!targetId && !perpSymbol) {
      return res.status(400).json(isDashboardPath ? { error: 'strategyId ou perpSymbol é obrigatório' } : { success: false, message: 'strategyId ou perpSymbol é obrigatório.' });
    }

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    
    let strat: any = null;
    if (targetId && isValidObjectId(targetId)) {
      strat = await PerpArbStrategy.findOne({ _id: targetId, userId: userObjId });
    }
    if (!strat && perpSymbol) {
      strat = await PerpArbStrategy.findOne({ perpSymbol, userId: userObjId });
    }

    let redisPublished = false;
    if (redis) {
      try {
        await redis.publish('perp-arb-control', JSON.stringify({ 
          action: 'CLOSE_STRATEGY', 
          strategyId: strat ? String(strat._id) : (targetId || ''),
          perpSymbol: perpSymbol || strat?.perpSymbol || ''
        }));
        redisPublished = true;
      } catch (err) {
        console.error('❌ [Redis CLOSE Strategy] Error:', err);
      }
    }

    if (!strat) {
      return res.status(404).json(isDashboardPath ? { error: 'Estratégia não encontrada' } : { success: false, message: 'Estratégia não encontrada.' });
    }

    const positionSize = Number(strat.positionSize || strat.tradeSize || 0);
    const fundingCollected = Number(strat.fundingCollected || 0);
    const lastSpot = Number(strat.lastSpotPrice || 0);
    const lastPerp = Number(strat.lastPerpPrice || 0);

    const openTrade: any = await PerpArbTrade.findOne({
      strategyId: strat._id,
      type: 'open_hedge',
      status: { $in: ['executed', 'simulated'] }
    }).sort({ createdAt: -1 });

    let realizedPnL = fundingCollected;
    if (openTrade && lastSpot > 0 && lastPerp > 0) {
      const openSpot = Number(openTrade.spotPrice || lastSpot);
      const openPerp = Number(openTrade.perpPrice || lastPerp);

      const spotPnL = openSpot > 0 ? ((lastSpot - openSpot) / openSpot) * positionSize : 0;
      const perpPnL = openPerp > 0 ? ((openPerp - lastPerp) / openPerp) * positionSize : 0;

      realizedPnL = spotPnL + perpPnL + fundingCollected;
    }

    const msg = redisPublished
      ? `Fechamento de [${strat.name}] acionado — o robô está executando as ordens.`
      : `Atenção: Redis indisponível. O fechamento de [${strat.name}] NÃO foi enviado ao robô.`;

    if (isDashboardPath) {
      return res.json({
        success: true,
        message: msg,
        pnl: realizedPnL,
        status: 'detected',
      });
    } else {
      return res.json({
        success: true,
        message: msg,
        data: {
          pnl: realizedPnL,
          status: 'detected'
        }
      });
    }
  } catch (error: any) {
    console.error('❌ [closeStrategy] Error:', error.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: error.message } : { success: false, message: error.message });
  }
}

// 2. INCREASE STRATEGY
export async function increaseStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');
    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const { strategyId, id, amount } = req.body;
    const targetId = strategyId || id;
    const increaseAmount = Number(amount);

    if (!targetId || isNaN(increaseAmount) || increaseAmount <= 0) {
      return res.status(400).json(isDashboardPath ? { error: 'strategyId e amount (> 0) são obrigatórios' } : { success: false, message: 'strategyId e amount (> 0) são obrigatórios.' });
    }

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;

    let strat: any = null;
    if (targetId && isValidObjectId(targetId)) {
      strat = await PerpArbStrategy.findOne({ _id: targetId, userId: userObjId });
    }

    if (!strat) {
      const openTrade: any = await PerpArbTrade.findOne({
        userId: userObjId,
        type: 'open_hedge',
        status: { $in: ['executed', 'simulated'] }
      }).sort({ createdAt: -1 });

      if (openTrade) {
        if (openTrade.strategyId) {
          strat = await PerpArbStrategy.findOne({ _id: openTrade.strategyId, userId: userObjId });
        }
        if (!strat && openTrade.perpSymbol) {
          strat = await PerpArbStrategy.findOne({ perpSymbol: openTrade.perpSymbol, userId: userObjId });
        }
      }
    }

    if (!strat) {
      const lastTrade: any = await PerpArbTrade.findOne({
        userId: userObjId,
        type: 'open_hedge',
        status: { $in: ['executed', 'simulated'] }
      }).sort({ createdAt: -1 });

      if (lastTrade) {
        strat = await PerpArbStrategy.create({
          userId: userObjId,
          name: lastTrade.strategyName || lastTrade.perpSymbol,
          perpSymbol: lastTrade.perpSymbol,
          spotSymbol: lastTrade.spotSymbol,
          tradeSize: lastTrade.amount || increaseAmount,
          minFundingRatePct: lastTrade.fundingPct || 0.01,
          positionOpen: true,
          positionSize: lastTrade.amount || increaseAmount,
          positionOpenedAt: lastTrade.createdAt,
          active: true,
        });
      }
    }

    if (!strat) {
      return res.status(404).json(isDashboardPath ? { error: 'Nenhuma posição ou estratégia encontrada' } : { success: false, message: 'Nenhuma posição ou estratégia encontrada.' });
    }

    if (!strat.positionOpen) {
      strat.positionOpen = true;
    }

    const previousSize = Number(strat.positionSize || strat.tradeSize || 0);

    if (redis) {
      try {
        await redis.publish('perp-arb-control', JSON.stringify({
          action: 'INCREASE_STRATEGY',
          strategyId: String(strat._id),
          amount: increaseAmount,
        }));
      } catch (err) {
        console.error('❌ [Redis INCREASE Strategy] Error:', err);
      }
    }

    const increaseTrade = await PerpArbTrade.create({
      userId: userObjId,
      strategyId: strat._id,
      strategyName: strat.name,
      perpSymbol: strat.perpSymbol,
      spotSymbol: strat.spotSymbol,
      type: 'open_hedge',
      status: 'executed',
      amount: increaseAmount,
      spotPrice: strat.lastSpotPrice || undefined,
      perpPrice: strat.lastPerpPrice || undefined,
      fundingRate: strat.currentFundingRate !== undefined && strat.currentFundingRate !== null ? Number(strat.currentFundingRate) / 100 : (strat.minFundingRatePct ? Number(strat.minFundingRatePct) / 100 : null),
      fundingPct: strat.currentFundingRate ?? strat.minFundingRatePct ?? null,
    });

    const newPositionSize = previousSize + increaseAmount;
    strat.positionSize = newPositionSize;
    await strat.save();

    const msg = `Aporte aumentado em +$${increaseAmount.toFixed(2)} USDT com sucesso! Novo total: $${newPositionSize.toFixed(2)} USDT.`;

    if (isDashboardPath) {
      return res.json({
        success: true,
        message: msg,
        newPositionSize,
        trade: increaseTrade,
      });
    } else {
      return res.json({
        success: true,
        message: msg,
        data: {
          newPositionSize,
          trade: increaseTrade
        }
      });
    }
  } catch (error: any) {
    console.error('❌ [increaseStrategy] Error:', error.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: error.message } : { success: false, message: error.message });
  }
}

// 3. VOID CLOSE STRATEGY
export async function voidCloseStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');
    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const { strategyId, id, perpSymbol } = req.body;
    const targetId = strategyId || id;

    if (!targetId && !perpSymbol) {
      return res.status(400).json(isDashboardPath ? { error: 'strategyId ou perpSymbol é obrigatório' } : { success: false, message: 'strategyId ou perpSymbol é obrigatório.' });
    }

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;

    let strat: any = null;
    if (targetId && isValidObjectId(targetId)) {
      strat = await PerpArbStrategy.findOne({ _id: targetId, userId: userObjId });
    }
    if (!strat && perpSymbol) {
      strat = await PerpArbStrategy.findOne({ perpSymbol, userId: userObjId });
    }

    if (!strat) {
      return res.status(404).json(isDashboardPath ? { error: 'Estratégia não encontrada' } : { success: false, message: 'Estratégia não encontrada.' });
    }

    const positionSize = Number(strat.positionSize || strat.tradeSize || 0);

    await PerpArbTrade.create({
      userId: userObjId,
      strategyId: strat._id,
      strategyName: strat.name,
      perpSymbol: strat.perpSymbol,
      spotSymbol: strat.spotSymbol,
      type: 'close_hedge',
      status: 'voided',
      amount: positionSize,
      pnl: 0,
    });

    strat.positionOpen = false;
    strat.active = false;
    strat.positionSize = 0;
    strat.positionOpenedAt = null;
    strat.fundingCollected = 0;
    await strat.save();

    const msg = `Posição [${strat.name}] marcada como encerrada pela corretora (sem PnL).`;

    return res.json({
      success: true,
      message: msg
    });
  } catch (error: any) {
    console.error('❌ [voidCloseStrategy] Error:', error.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: error.message } : { success: false, message: error.message });
  }
}

// 4. GET LOGS
export async function getLogs(req: AuthenticatedRequest, res: Response) {
  let processName = 'scanner';
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');
    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    processName = (req.query.process as string) || 'scanner';
    const lines = (req.query.lines as string) || '150';

    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    try {
      const { stdout, stderr } = await execAsync(`pm2 logs ${processName} --lines ${lines} --nostream --raw`);
      const rawOutput = stdout || stderr || '';
      const logLines = rawOutput
        .split('\n')
        .map((l: string) => l.trim())
        .filter(Boolean);

      const responseData = {
        process: processName,
        linesCount: logLines.length,
        logs: logLines.length > 0 ? logLines : [`[${new Date().toISOString()}] Robô ${processName} operante (sem novos logs no período).`],
        timestamp: new Date().toISOString(),
      };

      return res.json(isDashboardPath ? responseData : { success: true, message: 'ok', data: responseData });
    } catch (execErr: any) {
      // Fallback gracioso caso o comando pm2 logs falhe
      const fallbackMsg = execErr.message || 'Erro ao executar pm2 logs localmente';
      const responseData = {
        process: processName,
        linesCount: 1,
        logs: [`⚠️ Logs ${processName}: ${fallbackMsg}`],
        timestamp: new Date().toISOString(),
      };
      return res.json(isDashboardPath ? responseData : { success: true, message: 'ok', data: responseData });
    }
  } catch (error: any) {
    console.error('❌ [getLogs] Error:', error.message);
    const isDashboardPath = req.path.includes('/auth/');
    const errorData = {
      process: processName,
      linesCount: 1,
      logs: [`⚠️ Erro ao recuperar logs (${processName}): ${error.message}`],
      timestamp: new Date().toISOString(),
    };
    return res.json(isDashboardPath ? errorData : { success: true, message: 'ok', data: errorData });
  }
}

// 5. MANUAL SCAN
const EXCHANGES = ['binance', 'bybit', 'okx', 'mexc', 'gateio', 'kucoin', 'huobi', 'bitget'];

export async function manualScan(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');
    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const symbolParam = req.query.symbol as string;
    const isGlobalScan = !symbolParam || symbolParam.trim() === '';

    let spotSymbolFilter = '';
    let perpSymbolFilter = '';
    
    if (!isGlobalScan) {
      const base = symbolParam.split('/')[0].toUpperCase();
      const quote = symbolParam.split('/')[1]?.split(':')[0]?.toUpperCase() || 'USDT';
      spotSymbolFilter = `${base}/${quote}`;
      perpSymbolFilter = `${base}/${quote}:USDT`;
    }

    const spotExchangeParam = req.query.spotExchange as string;
    const perpExchangeParam = req.query.perpExchange as string;

    const withTimeout = (promise: Promise<any>, ms: number) => {
      return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
      ]);
    };

    if (spotExchangeParam && perpExchangeParam && spotExchangeParam !== perpExchangeParam) {
      const spotExId = spotExchangeParam.toLowerCase().trim();
      const perpExId = perpExchangeParam.toLowerCase().trim();

      const spotCcxtId = spotExId === 'gateio' ? 'gate' : spotExId;
      const perpCcxtId = perpExId === 'gateio' ? 'gate' : perpExId;

      if (!(ccxt as any)[spotCcxtId] || !(ccxt as any)[perpCcxtId]) {
        return res.status(400).json(isDashboardPath ? { error: `Corretoras ${spotExId} / ${perpExId} não suportadas` } : { success: false, message: `Corretoras ${spotExId} / ${perpExId} não suportadas.` });
      }

      const spotExchange = new (ccxt as any)[spotCcxtId]({ enableRateLimit: true, timeout: 10000, options: { fetchCurrencies: false } });
      spotExchange.has = { ...(spotExchange.has || {}), fetchCurrencies: false };
      const perpExchange = new (ccxt as any)[perpCcxtId]({ enableRateLimit: true, timeout: 10000, options: { fetchCurrencies: false } });
      perpExchange.has = { ...(perpExchange.has || {}), fetchCurrencies: false };

      const [spotMarkets, perpMarkets] = await Promise.all([
        withTimeout(spotExchange.loadMarkets(), 15000),
        withTimeout(perpExchange.loadMarkets(), 15000)
      ]);

      let pSymbolsToFetch = isGlobalScan 
        ? Object.keys(perpMarkets).filter(s => s.endsWith(':USDT')) 
        : [perpSymbolFilter];

      let validPairs: { pSym: string; sSym: string }[] = [];
      for (const pSym of pSymbolsToFetch) {
        const base = pSym.split('/')[0];
        const quote = pSym.split('/')[1]?.split(':')[0] || 'USDT';
        const sSym = `${base}/${quote}`;
        if (spotMarkets[sSym] && perpMarkets[pSym]) {
          validPairs.push({ pSym, sSym });
        }
      }

      const pSymbols = validPairs.map(v => v.pSym);
      const sSymbols = Array.from(new Set(validPairs.map(v => v.sSym)));

      const [pTickers, sTickers, fundingObj] = await Promise.all([
        withTimeout(perpExchange.fetchTickers(pSymbols).catch(() => ({})), 15000),
        withTimeout(spotExchange.fetchTickers(sSymbols).catch(() => ({})), 15000),
        withTimeout((perpExchange.has['fetchFundingRates'] ? perpExchange.fetchFundingRates(pSymbols) : perpExchange.fetchFundingRate(pSymbols[0] || '').then((r: any) => ({ [(pSymbols[0] || '')]: r }))).catch(() => ({})), 15000)
      ]);

      const opps = [];
      for (const pair of validPairs) {
        const pTicker = pTickers[pair.pSym];
        const sTicker = sTickers[pair.sSym];
        if (!pTicker || !sTicker || !pTicker.last || !sTicker.last) continue;

        let fundingRate = 0;
        if (fundingObj[pair.pSym] && fundingObj[pair.pSym].fundingRate !== undefined) {
          fundingRate = Number(fundingObj[pair.pSym].fundingRate);
        } else if (pTicker.info) {
          const rateStr = pTicker.info.fundingRate || pTicker.info.funding_rate || pTicker.info.lastFundingRate;
          if (rateStr !== undefined) fundingRate = Number(rateStr);
        }
        if (isNaN(fundingRate)) fundingRate = 0;

        const fundingPct = fundingRate * 100;
        const perpBid = pTicker.bid || pTicker.last;
        const spotAsk = sTicker.ask || sTicker.last;
        const spreadPct = spotAsk > 0 ? ((perpBid - spotAsk) / spotAsk) * 100 : 0;

        const perpMarket = perpMarkets[pair.pSym];
        const spotMarket = spotMarkets[pair.sSym];

        const perpFee = perpMarket?.taker !== undefined ? perpMarket.taker : 0.0005; 
        const spotFee = spotMarket?.taker !== undefined ? spotMarket.taker : 0.001; 
        const totalFeePct = (perpFee + spotFee) * 100;
        const netFundingPct = fundingPct + spreadPct - totalFeePct;

        const perpSlippage = pTicker.last && perpBid ? (Math.abs(pTicker.last - perpBid) / perpBid) * 100 : 0;
        const spotSlippage = sTicker.last && spotAsk ? (Math.abs(sTicker.last - spotAsk) / spotAsk) * 100 : 0;
        const estimatedSlippagePct = Math.max(perpSlippage, spotSlippage);

        opps.push({
          exchange: `${spotExId.toUpperCase()} (Spot) ⚡ ${perpExId.toUpperCase()} (Perp)`,
          spotExchange: spotExId,
          perpExchange: perpExId,
          symbol: pair.pSym,
          spotSymbol: pair.sSym,
          perpBid,
          spotAsk,
          spreadPct,
          fundingPct,
          totalFeePct,
          netFundingPct,
          estimatedSlippagePct,
          volume24h: pTicker.quoteVolume || sTicker.quoteVolume || 0,
        });
      }

      opps.sort((a, b) => b.netFundingPct - a.netFundingPct);

      const responseCross = {
        symbol: isGlobalScan ? 'CROSS SCAN' : spotSymbolFilter,
        results: opps,
        errors: 0,
      };

      return res.json(isDashboardPath ? responseCross : { success: true, message: 'ok', data: responseCross });
    }

    const exchangesParam = req.query.exchanges as string;
    const targetExchanges = exchangesParam ? exchangesParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : EXCHANGES;

    const scanResults = await Promise.allSettled(
      targetExchanges.map(async (exId) => {
        const ccxtId = exId === 'gateio' ? 'gate' : exId;
        if (!(ccxt as any)[ccxtId]) throw new Error(`Exchange ${exId} not supported`);
        
        const exchange = new (ccxt as any)[ccxtId]({ enableRateLimit: true, timeout: 10000, options: { fetchCurrencies: false } });
        exchange.has = { ...(exchange.has || {}), fetchCurrencies: false };

        const markets = await withTimeout(exchange.loadMarkets(), 15000);
        
        let pSymbolsToFetch = isGlobalScan ? Object.keys(markets).filter(s => s.endsWith(':USDT')) : [perpSymbolFilter];
        let sSymbolsToFetch = isGlobalScan ? Array.from(new Set(pSymbolsToFetch.map(s => {
          const base = s.split('/')[0];
          const quote = s.split('/')[1]?.split(':')[0];
          return `${base}/${quote}`;
        }))).filter(s => markets[s] !== undefined) : [spotSymbolFilter];

        const [pTickers, sTickers, fundingObj] = await Promise.all([
          withTimeout(exchange.fetchTickers(pSymbolsToFetch).catch(() => ({})), 15000),
          withTimeout(exchange.fetchTickers(sSymbolsToFetch).catch(() => ({})), 15000),
          withTimeout((exchange.has['fetchFundingRates'] ? exchange.fetchFundingRates(pSymbolsToFetch) : exchange.fetchFundingRate(pSymbolsToFetch[0] || '').then((r: any) => ({ [(pSymbolsToFetch[0] || '')]: r }))).catch(() => ({})), 15000)
        ]);

        const opps = [];

        for (const pSym of pSymbolsToFetch) {
          const symUpper = pSym.toUpperCase();
          if (symUpper.includes('CASHCAT') || symUpper.startsWith('CASH/') || symUpper.startsWith('CASH:') || symUpper.includes('/CASH')) continue;
          const sSym = (() => {
             const base = pSym.split('/')[0];
             const quote = pSym.split('/')[1]?.split(':')[0];
             return `${base}/${quote}`;
          })();
          
          const perpMarket = markets[pSym];
          const spotMarket = markets[sSym];
          if (!perpMarket || !spotMarket) continue;

          const pTicker = pTickers[pSym];
          const sTicker = sTickers[sSym];
          if (!pTicker || !sTicker || !pTicker.last || !sTicker.last) continue;

          if (isGlobalScan && (pTicker.quoteVolume || 0) < 50000) continue;

          let fundingRate = 0;
          if (fundingObj[pSym] && fundingObj[pSym].fundingRate !== undefined) {
            fundingRate = Number(fundingObj[pSym].fundingRate);
          } else if (pTicker.info) {
            const rateStr = pTicker.info.fundingRate || pTicker.info.funding_rate || pTicker.info.lastFundingRate;
            if (rateStr !== undefined) fundingRate = Number(rateStr);
          }
          if (!fundingRate || isNaN(fundingRate)) continue;

          const fundingPct = fundingRate * 100;
          if (isGlobalScan && fundingPct <= 0) continue;

          const perpBid = pTicker.bid || pTicker.last;
          const spotAsk = sTicker.ask || sTicker.last;
          const spreadPct = spotAsk > 0 ? ((perpBid - spotAsk) / spotAsk) * 100 : 0;

          const perpContractSize = perpMarket.contractSize || 1;
          const perpBidNotional = (pTicker.bidVolume || 0) * perpContractSize * perpBid;
          const spotAskNotional = (sTicker.askVolume || 0) * spotAsk;

          if (isGlobalScan) {
            if ((pTicker.quoteVolume || 0) < 150000) continue;
            if (spreadPct > 3) continue;
            if (pTicker.bidVolume && perpBidNotional < 50) continue;
            if (sTicker.askVolume && spotAskNotional < 50) continue;
          }

          const perpFee = perpMarket.taker !== undefined ? perpMarket.taker : 0.0005; 
          const spotFee = spotMarket.taker !== undefined ? spotMarket.taker : 0.001; 
          const totalFeePct = (perpFee + spotFee) * 100;

          const netFundingPct = fundingPct + spreadPct - totalFeePct;

          const perpSlippage = pTicker.last && perpBid ? (Math.abs(pTicker.last - perpBid) / perpBid) * 100 : 0;
          const spotSlippage = sTicker.last && spotAsk ? (Math.abs(sTicker.last - spotAsk) / spotAsk) * 100 : 0;
          const estimatedSlippagePct = Math.max(perpSlippage, spotSlippage);

          opps.push({
            exchange: exId.toUpperCase(),
            spotExchange: exId,
            perpExchange: exId,
            symbol: pSym,
            spotSymbol: sSym,
            perpBid,
            spotAsk,
            spreadPct,
            fundingPct,
            totalFeePct,
            netFundingPct,
            estimatedSlippagePct,
            volume24h: pTicker.quoteVolume || 0,
          });
        }
        
        return opps;
      })
    );

    const successfulResults = scanResults
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .sort((a, b) => b.netFundingPct - a.netFundingPct);

    const failedResults = scanResults
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map(r => r.reason.message);

    const responseNormal = {
      symbol: isGlobalScan ? 'GLOBAL SCAN' : spotSymbolFilter,
      results: successfulResults,
      errors: failedResults.length,
    };

    return res.json(isDashboardPath ? responseNormal : { success: true, message: 'ok', data: responseNormal });
  } catch (error: any) {
    console.error('❌ [manualScan] Error:', error.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: error.message } : { success: false, message: error.message });
  }
}

// 6. AUDITORIA CONSOLIDADA DA EXCHANGE (SPOT + PERP)
export async function auditExchangeTrades(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const exchangeParam = ((req.query.exchange as string) || 'mexc').toLowerCase().trim();
    const daysParam = Number(req.query.days || 5);

    const key = await (ExchangeKey as any).findOne({
      userId,
      exchangeId: exchangeParam,
      active: true,
    }).lean();

    if (!key) {
      return res.status(404).json(
        isDashboardPath
          ? { error: `Chave ativa da exchange ${exchangeParam} não encontrada.` }
          : { success: false, message: `Chave ativa da exchange ${exchangeParam} não encontrada.` }
      );
    }

    let secret = key.apiSecret;
    try {
      const aad = `${userId}-${exchangeParam}`;
      secret = decryptSecretKey(String(key.apiSecret || ''), aad);
    } catch { /* usa raw fallback */ }

    const spotCcxtId = exchangeParam === 'gateio' ? 'gate' : exchangeParam;
    const perpCcxtId = exchangeParam === 'gateio' ? 'gate' : exchangeParam;

    const spotEx = new (ccxt as any)[spotCcxtId]({
      apiKey: key.apiKey,
      secret,
      enableRateLimit: true,
      options: { defaultType: 'spot' },
    });
    const perpEx = new (ccxt as any)[perpCcxtId]({
      apiKey: key.apiKey,
      secret,
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    });

    const since = Date.now() - daysParam * 24 * 60 * 60 * 1000;

    const symbolsPerp = ['BLUAI/USDT:USDT', 'BTR/USDT:USDT', 'ARIA/USDT:USDT', 'FOLKS/USDT:USDT', 'GUA/USDT:USDT', 'CASHCAT/USDT:USDT'];
    const symbolsSpot = ['BLUAI/USDT', 'BTR/USDT', 'ARIA/USDT', 'FOLKS/USDT', 'GUA/USDT', 'CASHCAT/USDT'];

    const spotTrades: any[] = [];
    const perpTrades: any[] = [];

    await Promise.all([
      ...symbolsSpot.map((s) => spotEx.fetchMyTrades(s, since).then((t: any[]) => spotTrades.push(...t)).catch(() => {})),
      ...symbolsPerp.map((s) => perpEx.fetchMyTrades(s, since).then((t: any[]) => perpTrades.push(...t)).catch(() => {})),
    ]);

    const coinsMap: Record<string, {
      spotBuyVol: number;
      spotSellVol: number;
      perpBuyVol: number;
      perpSellVol: number;
      spotFeeUsd: number;
      perpFeeUsd: number;
      tradesCount: number;
      trades: any[];
    }> = {};

    let totalSpotFeeUsd = 0;
    let totalPerpFeeUsd = 0;

    for (const t of spotTrades) {
      const base = String(t.symbol || '').split('/')[0].toUpperCase();
      if (!coinsMap[base]) {
        coinsMap[base] = { spotBuyVol: 0, spotSellVol: 0, perpBuyVol: 0, perpSellVol: 0, spotFeeUsd: 0, perpFeeUsd: 0, tradesCount: 0, trades: [] };
      }
      const feeCost = Number(t.fee?.cost || 0);
      const feeCurr = t.fee?.currency || 'USDT';
      const feeUsd = feeCurr === 'MX' ? feeCost * 3.5 : feeCost;

      coinsMap[base].spotFeeUsd += feeUsd;
      coinsMap[base].tradesCount += 1;
      totalSpotFeeUsd += feeUsd;

      const vol = Number(t.amount || 0) * Number(t.price || 0);
      const sideUpper = t.side?.toUpperCase() || 'BUY';

      if (sideUpper === 'BUY') {
        coinsMap[base].spotBuyVol += vol;
      } else {
        coinsMap[base].spotSellVol += vol;
      }

      coinsMap[base].trades.push({
        id: t.id || String(t.timestamp),
        type: 'SPOT',
        symbol: t.symbol,
        side: sideUpper,
        time: t.timestamp ? new Date(t.timestamp).toISOString() : new Date().toISOString(),
        amount: Number(t.amount || 0),
        price: Number(t.price || 0),
        volumeUsd: Number(vol.toFixed(4)),
        feeCost: Number(feeCost.toFixed(6)),
        feeCurrency: feeCurr,
        feeUsd: Number(feeUsd.toFixed(4)),
      });
    }

    for (const t of perpTrades) {
      const base = String(t.symbol || '').split('/')[0].toUpperCase();
      if (!coinsMap[base]) {
        coinsMap[base] = { spotBuyVol: 0, spotSellVol: 0, perpBuyVol: 0, perpSellVol: 0, spotFeeUsd: 0, perpFeeUsd: 0, tradesCount: 0, trades: [] };
      }
      const feeCost = Number(t.fee?.cost || 0);
      const feeCurr = t.fee?.currency || 'USDT';
      const feeUsd = feeCurr === 'MX' ? feeCost * 3.5 : feeCost;

      coinsMap[base].perpFeeUsd += feeUsd;
      coinsMap[base].tradesCount += 1;
      totalPerpFeeUsd += feeUsd;

      const vol = Number(t.amount || 0) * Number(t.price || 0);
      const sideStr = String(t.side || '').toUpperCase();
      const isPerpOpenShort = sideStr === '3' || sideStr === '1' || sideStr === 'BUY' || sideStr === 'OPEN_SHORT';

      if (isPerpOpenShort) {
        coinsMap[base].perpBuyVol += vol; // Entrada Short
      } else {
        coinsMap[base].perpSellVol += vol; // Saída Short
      }

      coinsMap[base].trades.push({
        id: t.id || String(t.timestamp),
        type: 'PERP',
        symbol: t.symbol,
        side: isPerpOpenShort ? 'OPEN_SHORT' : 'CLOSE_SHORT',
        time: t.timestamp ? new Date(t.timestamp).toISOString() : new Date().toISOString(),
        amount: Number(t.amount || 0),
        price: Number(t.price || 0),
        volumeUsd: Number(vol.toFixed(4)),
        feeCost: Number(feeCost.toFixed(6)),
        feeCurrency: feeCurr,
        feeUsd: Number(feeUsd.toFixed(4)),
      });
    }

    const rows = Object.entries(coinsMap).map(([symbol, data]) => {
      // Ordena as operações por timestamp
      data.trades.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

      // Se o volume de venda Spot for menor que o de compra, existe posição parcialmente ou totalmente em aberto
      let effectiveSpotBuyVol = data.spotBuyVol;
      let effectivePerpOpenVol = data.perpBuyVol;
      let emAbertoDesconsiderado = 0;

      if (data.spotSellVol > 0 && data.spotBuyVol > data.spotSellVol * 1.05) {
        emAbertoDesconsiderado = data.spotBuyVol - data.spotSellVol;
        effectiveSpotBuyVol = data.spotSellVol;
        if (data.perpBuyVol > data.perpSellVol) {
          effectivePerpOpenVol = data.perpSellVol;
        }
      }

      const pnlSpot = data.spotSellVol > 0 ? data.spotSellVol - effectiveSpotBuyVol : 0;
      const pnlPerp = (data.perpSellVol > 0 && effectivePerpOpenVol > 0) ? (effectivePerpOpenVol - data.perpSellVol) : 0;
      const totalTaxas = data.spotFeeUsd + data.perpFeeUsd;
      const resultadoLiquidoReal = pnlSpot + pnlPerp - totalTaxas;

      return {
        symbol,
        volumeEntradaSpot: Number(effectiveSpotBuyVol.toFixed(2)),
        volumeSaidaSpot: Number(data.spotSellVol.toFixed(2)),
        pnlBrutoSpot: Number(pnlSpot.toFixed(2)),
        pnlBrutoPerp: Number(pnlPerp.toFixed(2)),
        taxasSpot: Number(data.spotFeeUsd.toFixed(4)),
        taxasPerp: Number(data.perpFeeUsd.toFixed(4)),
        totalTaxas: Number(totalTaxas.toFixed(4)),
        resultadoLiquidoReal: Number(resultadoLiquidoReal.toFixed(2)),
        tradesCount: data.tradesCount,
        emAbertoDesconsiderado: Number(emAbertoDesconsiderado.toFixed(2)),
        trades: data.trades,
      };
    });

    rows.sort((a, b) => a.resultadoLiquidoReal - b.resultadoLiquidoReal);

    const totalEntradaSpot = rows.reduce((acc, r) => acc + r.volumeEntradaSpot, 0);
    const totalSaidaSpot = rows.reduce((acc, r) => acc + r.volumeSaidaSpot, 0);
    const totalPnlSpot = rows.reduce((acc, r) => acc + r.pnlBrutoSpot, 0);
    const totalPnlPerp = rows.reduce((acc, r) => acc + r.pnlBrutoPerp, 0);
    const totalTaxasTaker = totalSpotFeeUsd + totalPerpFeeUsd;
    const resultadoLiquidoTotal = totalPnlSpot + totalPnlPerp - totalTaxasTaker;

    const resultData = {
      exchange: exchangeParam.toUpperCase(),
      periodDays: daysParam,
      startDate: new Date(since).toISOString(),
      endDate: new Date().toISOString(),
      totais: {
        totalEntradaSpot: Number(totalEntradaSpot.toFixed(2)),
        totalSaidaSpot: Number(totalSaidaSpot.toFixed(2)),
        totalPnlSpot: Number(totalPnlSpot.toFixed(2)),
        totalPnlPerp: Number(totalPnlPerp.toFixed(2)),
        taxasSpot: Number(totalSpotFeeUsd.toFixed(4)),
        taxasPerp: Number(totalPerpFeeUsd.toFixed(4)),
        totalTaxasTaker: Number(totalTaxasTaker.toFixed(4)),
        resultadoLiquidoTotal: Number(resultadoLiquidoTotal.toFixed(2)),
      },
      detalhesPorAtivo: rows,
    };

    return res.json(isDashboardPath ? resultData : { success: true, message: 'ok', data: resultData });
  } catch (error: any) {
    console.error('❌ [auditExchangeTrades] Error:', error.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: error.message } : { success: false, message: error.message });
  }
}
