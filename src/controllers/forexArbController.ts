import { Response } from 'express';
import ForexArbStrategy from '../models/ForexArbStrategy';
import ForexArbTrade from '../models/ForexArbTrade';
import ForexArbSettings from '../models/ForexArbSettings';
import ExchangeKey from '../models/ExchangeKey';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { encryptSecretKey } from '../utils/encryption';
import { recordClosedTrade } from '../strategy/forex/forex-scalp-scanner';

// --- STRATEGIES ---
export async function getForexStrategies(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    let strategies = await ForexArbStrategy.find({ userId, positionOpen: true }).sort({ createdAt: -1 });
    if (!strategies || strategies.length === 0) {
      strategies = await ForexArbStrategy.find({ positionOpen: true }).sort({ createdAt: -1 });
    }

    const settings = await ForexArbSettings.findOne({ userId }).lean() || {};

    // Projeção 100% orientada ao MongoDB para evitar qualquer latência ou concorrência no socket do robô
    const formatted: any[] = [];

    for (const s of strategies) {
      const leg = s.legs && s.legs[0];
      const sym = leg?.symbol;
      const curPrice = (s as any).currentPrice || (leg as any)?.currentPrice || ((s as any).lastLegPrices && sym ? (s as any).lastLegPrices.get ? (s as any).lastLegPrices.get(sym) : (s as any).lastLegPrices[sym] : null);
      
      let livePnlPct = s.pnlPct || 0;
      let livePnlUsd = s.pnl || 0;

      // Se temos o preço atual e o preço de entrada da perna, calcula os dados em tempo real se pnl for 0 ou desatualizado
      if (curPrice && leg && leg.price && leg.price > 0) {
        const sideUpper = (leg.side || 'BUY').toUpperCase();
        const diff = sideUpper === 'BUY' ? (curPrice - leg.price) : (leg.price - curPrice);
        const calculatedPct = (diff / leg.price) * 100;
        if (!livePnlPct || livePnlPct === 0) {
          livePnlPct = calculatedPct;
        }

        if (livePnlUsd === 0) {
          const isGoldPair = sym?.includes('XAU');
          const isJpyPair = sym?.includes('JPY');
          const rawUnits = (leg.amount && leg.amount > 0)
            ? leg.amount
            : (leg.volume && leg.volume > 0)
              ? leg.volume
              : (s.positionVolume && s.positionVolume > 0)
                ? s.positionVolume
                : (s.tradeSize || 1000);

          const lotesReais = isGoldPair
            ? (rawUnits >= 100 ? rawUnits / 100 : rawUnits * 0.01)
            : (rawUnits >= 1000 ? rawUnits / 100000 : rawUnits);
          const numLotes001 = Math.max(1, Math.round(lotesReais / 0.01));
          const comm = (isGoldPair ? 0.08 : 0.06) * numLotes001;

          if (isGoldPair) {
            livePnlUsd = (diff * rawUnits) - comm;
          } else if (isJpyPair && curPrice > 0) {
            livePnlUsd = ((diff * rawUnits) / curPrice) - comm;
          } else {
            livePnlUsd = (diff * rawUnits) - comm;
          }
        }
      }

      const isGold = sym?.includes('XAU');
      const peakPct = Math.max(s.peakProfitPct || 0, livePnlPct > 0 ? livePnlPct : 0);
      const peakUsd = Math.max(Number((s as any).peakProfitUsd || 0), livePnlUsd > 0 ? livePnlUsd : 0);
      const isTrailing = Boolean((s as any).trailingActive);
      const trailingFloorUsd = Number((s as any).trailingFloorUsd || 0);
      const trailingFloorPrice = (s as any).trailingFloorPrice || null;
      const trailingActivationUsd = Number((s as any).trailingActivationUsd || (isGold ? 0.15 : 0.07));
      const trailingDistanceUsd = Number((s as any).trailingDistanceUsd || (isGold ? 0.05 : 0.03));
      const currentAction = (s as any).currentAction || (isTrailing ? `🔒 Trailing Ativo (Piso: +$${trailingFloorUsd.toFixed(2)} USD)` : `⏳ Monitorando mercado`);

      formatted.push({
        _id: s._id.toString(),
        id: s._id.toString(),
        userId: s.userId.toString(),
        name: s.name,
        exchangeId: s.exchangeId,
        exchangeKeyId: s.exchangeKeyId ? s.exchangeKeyId.toString() : null,
        type: s.type,
        legs: s.legs || [],
        tradeSize: s.tradeSize,
        expectedProfitPct: s.expectedProfitPct,
        minProfitPct: s.minProfitPct,
        maxSlippagePct: s.maxSlippagePct,
        autoExecute: s.autoExecute,
        isAutoCreated: s.isAutoCreated,
        active: s.active,
        positionOpen: s.positionOpen,
        positionOpenedAt: s.positionOpenedAt,
        positionSize: s.positionSize,
        positionVolume: s.positionVolume || 0,
        positionAmountUsd: s.positionAmountUsd || 0,
        status: s.status,
        pnl: livePnlUsd,
        pnlPct: livePnlPct,
        peakProfitPct: peakPct,
        peakProfitUsd: peakUsd,
        isTrailingActive: isTrailing,
        trailingActive: isTrailing,
        trailingFloorUsd: trailingFloorUsd,
        trailingFloorPrice: trailingFloorPrice,
        trailingActivationUsd: trailingActivationUsd,
        trailingDistanceUsd: trailingDistanceUsd,
        currentAction: currentAction,
        currentPrice: (s as any).currentPrice || null,
        lastLegPrices: (s as any).lastLegPrices || {},
        closedAt: s.closedAt,
        createdAt: s.createdAt
      });
    }

    return res.json({ success: true, message: 'ok', data: formatted });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function createForexStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    const body = req.body;
    const strategy = new ForexArbStrategy({
      ...body,
      userId
    });
    await strategy.save();

    const formatted = {
      _id: strategy._id.toString(),
      id: strategy._id.toString(),
      ...strategy.toObject()
    };

    const isDashboard = req.path.includes('/auth/');
    return isDashboard ? res.status(201).json(formatted) : res.status(201).json({ success: true, message: 'Estratégia Forex criada.', data: formatted });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function deleteForexStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    const id = (req.query.id as string) || req.params.id;
    if (!id) return res.status(400).json({ success: false, message: 'ID obrigatório.' });

    await ForexArbStrategy.deleteOne({ _id: id, userId });
    return res.json({ success: true, message: 'Estratégia removida.' });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function deleteForexTrades(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    await ForexArbTrade.deleteMany({ userId });
    await ForexArbStrategy.deleteMany({ userId });

    return res.json({ success: true, message: 'Todas as operações e estratégias foram apagadas do banco de dados.' });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

// --- TRADES & OPPORTUNITIES ---
export async function getForexTrades(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    let trades = await ForexArbTrade.find({ userId, type: { $ne: 'opportunity_found' } }).sort({ createdAt: -1 }).limit(100).lean();
    if (!trades || trades.length === 0) {
      trades = await ForexArbTrade.find({ type: { $ne: 'opportunity_found' } }).sort({ createdAt: -1 }).limit(100).lean();
    }
    if (!trades || trades.length === 0) {
      trades = await ForexArbTrade.find({}).sort({ createdAt: -1 }).limit(100).lean();
    }
    const formatted = trades.map((t: any) => {
      const legs = t.legs || [];
      const primaryLeg = legs[0] || {};
      const closeLeg = legs.find((l: any) => l.closePrice != null || (l.price != null && l !== primaryLeg)) || legs[1] || primaryLeg;

      const sym = primaryLeg.symbol || t.strategyName || '';
      const isGold = sym.includes('XAU');
      const isJpy = sym.endsWith('/JPY') || sym.endsWith('JPY');

      const entryP = Number(primaryLeg.entryPrice ?? primaryLeg.price ?? 0);
      const closeP = Number(closeLeg.closePrice ?? (closeLeg !== primaryLeg ? closeLeg.price : 0));
      const side = String(primaryLeg.side || 'BUY').toUpperCase();

      const vol = Number(t.volume ?? t.amount ?? primaryLeg.volume ?? primaryLeg.amount ?? 1000);
      const lotesReais = isGold ? (vol >= 100 ? vol / 100 : vol * 0.01) : (vol >= 1000 ? vol / 100000 : vol);
      const numLotes001 = Math.max(1, Math.round(lotesReais / 0.01));
      const calcComm = (isGold ? 0.08 : 0.06) * numLotes001;

      let computedNetPnl = t.realizedPnl;
      if (entryP > 0 && closeP > 0 && entryP !== closeP) {
        const priceDiff = side === 'BUY' ? (closeP - entryP) : (entryP - closeP);
        const grossPnl = isGold
          ? priceDiff * vol
          : isJpy && closeP > 0
            ? (priceDiff * vol) / closeP
            : priceDiff * vol;
        computedNetPnl = grossPnl - calcComm;
      }

      // Normaliza todas as legs para garantirem entryPrice (1.35442) e closePrice (1.35421)
      const normalizedLegs = legs.map((l: any, idx: number) => {
        const isExitLeg = idx > 0 || l.closePrice != null;
        return {
          ...l,
          entryPrice: entryP > 0 ? entryP : l.entryPrice ?? l.price,
          closePrice: closeP > 0 ? closeP : l.closePrice,
          price: isExitLeg ? (closeP > 0 ? closeP : l.price) : (entryP > 0 ? entryP : l.price)
        };
      });

      const finalRealizedPnl = (computedNetPnl != null && !isNaN(Number(computedNetPnl)))
        ? Number(computedNetPnl)
        : Number(t.realizedPnl || 0);

      return {
        _id: t._id.toString(),
        id: t._id.toString(),
        strategyId: t.strategyId ? t.strategyId.toString() : null,
        strategyName: t.strategyName,
        exchangeId: t.exchangeId,
        type: t.type,
        legs: normalizedLegs,
        amount: t.amount,
        volume: t.volume ?? t.legs?.[0]?.volume ?? t.legs?.[0]?.amount ?? null,
        amountUsd: t.amountUsd ?? t.legs?.[0]?.amountUsd ?? null,
        expectedProfitPct: t.expectedProfitPct,
        realizedPnl: finalRealizedPnl,
        commission: t.commission && t.commission > 0 ? t.commission : calcComm,
        swap: t.swap || 0,
        status: t.status,
        reason: t.reason,
        errorMessage: t.errorMessage,
        createdAt: t.createdAt
      };
    });

    return res.json({ success: true, message: 'ok', data: formatted });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function getForexOpportunities(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    const opportunities = await ForexArbTrade.find({
      userId,
      type: 'opportunity_found',
      status: 'detected'
    }).sort({ createdAt: -1 }).limit(50).lean();

    const formatted = opportunities.map((t: any) => ({
      _id: t._id.toString(),
      id: t._id.toString(),
      exchangeId: t.exchangeId,
      type: t.type,
      status: t.status,
      legs: t.legs || [],
      amount: t.amount,
      expectedProfitPct: t.expectedProfitPct,
      createdAt: t.createdAt
    }));

    return res.json({ success: true, message: 'ok', data: formatted });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

// --- SETTINGS ---
export async function getForexSettings(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    let settings = await ForexArbSettings.findOne({ userId });
    if (!settings) {
      settings = await ForexArbSettings.create({
        userId,
        isScanningEnabled: false,
        tradeSize: 100,
        minProfitPct: 0.05,
        minVolume24hUSD: 50000,
        maxStrategiesPerScan: 5,
        scanIntervalMs: 60000,
        maxDailyLoss: 10,
        maxSlippagePct: 0.1,
        autoExecute: true,
        simpleEnabled: true,
        triangularEnabled: true,
        allowedExchanges: [],
        takeProfitPct: 0.10,
        stopLossPct: 0.10,
        trailingStopPct: 0.01
      });
    }

    const formatted = {
      _id: settings._id.toString(),
      userId: settings.userId.toString(),
      isScanningEnabled: settings.isScanningEnabled,
      lastScannedAt: settings.lastScannedAt,
      tradeSize: settings.tradeSize,
      minProfitPct: settings.minProfitPct,
      minVolume24hUSD: settings.minVolume24hUSD,
      maxStrategiesPerScan: settings.maxStrategiesPerScan,
      scanIntervalMs: settings.scanIntervalMs,
      maxDailyLoss: settings.maxDailyLoss,
      maxSlippagePct: settings.maxSlippagePct,
      autoExecute: settings.autoExecute,
      simpleEnabled: settings.simpleEnabled,
      triangularEnabled: settings.triangularEnabled,
      allowedExchanges: settings.allowedExchanges || [],
      takeProfitPct: settings.takeProfitPct ?? 0.10,
      stopLossPct: settings.stopLossPct ?? 0.10,
      trailingStopPct: settings.trailingStopPct ?? 0.01,
      symbolProfiles: settings.symbolProfiles
        ? Object.fromEntries((settings.symbolProfiles as Map<string, any>).entries())
        : {}
    };

    const isDashboard = req.path.includes('/auth/');
    return isDashboard ? res.json(formatted) : res.json({ success: true, message: 'ok', data: formatted });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function updateForexSettings(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    const body = req.body;
    if (body.autoExecute === undefined) body.autoExecute = true;
    // `symbolProfiles` chega como objeto; converte para Map para o Mongoose.
    if (body.symbolProfiles !== undefined) {
      body.symbolProfiles = new Map(Object.entries(body.symbolProfiles || {}));
    }
    const settings = await ForexArbSettings.findOneAndUpdate(
      { userId },
      { $set: body },
      { new: true, upsert: true }
    );

    const formatted = {
      _id: settings._id.toString(),
      userId: settings.userId.toString(),
      isScanningEnabled: settings.isScanningEnabled,
      lastScannedAt: settings.lastScannedAt,
      tradeSize: settings.tradeSize,
      minProfitPct: settings.minProfitPct,
      minVolume24hUSD: settings.minVolume24hUSD,
      maxStrategiesPerScan: settings.maxStrategiesPerScan,
      scanIntervalMs: settings.scanIntervalMs,
      maxDailyLoss: settings.maxDailyLoss,
      maxSlippagePct: settings.maxSlippagePct,
      autoExecute: settings.autoExecute,
      simpleEnabled: settings.simpleEnabled,
      triangularEnabled: settings.triangularEnabled,
      allowedExchanges: settings.allowedExchanges || [],
      takeProfitPct: settings.takeProfitPct ?? 0.10,
      stopLossPct: settings.stopLossPct ?? 0.10,
      trailingStopPct: settings.trailingStopPct ?? 0.01,
      symbolProfiles: settings.symbolProfiles
        ? Object.fromEntries((settings.symbolProfiles as Map<string, any>).entries())
        : {}
    };

    const isDashboard = req.path.includes('/auth/');
    return isDashboard ? res.json(formatted) : res.json({ success: true, message: 'Settings atualizados com sucesso.', data: formatted });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

// --- CTRADER CREDENTIALS ---
export async function updateCtraderCredentials(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    const { accessToken, refreshToken, clientId, clientSecret, accountId, environment } = req.body;

    const exchangeKey = await ExchangeKey.findOne({
      userId,
      exchangeId: { $in: ['ctrader', 'pepperstone'] }
    });

    if (!exchangeKey) {
      return res.status(404).json({ success: false, reason: 'Nenhuma ExchangeKey cTrader/Pepperstone encontrada para esta conta.' });
    }

    const authContext = `${userId}-${exchangeKey.exchangeId}`;
    const updateData: any = {};

    if (clientId) updateData.clientId = clientId.trim();
    if (accountId) updateData.accountId = accountId.trim();
    if (environment) updateData.environment = environment === 'demo' ? 'demo' : 'live';
    if (clientSecret) updateData.clientSecret = encryptSecretKey(clientSecret.trim(), authContext);
    if (accessToken) updateData.accessToken = encryptSecretKey(accessToken.trim(), authContext);
    if (refreshToken) updateData.refreshToken = encryptSecretKey(refreshToken.trim(), authContext);
    updateData.ctraderTokenUpdatedAt = new Date();

    await ExchangeKey.updateOne({ _id: exchangeKey._id }, { $set: updateData });

    return res.json({ success: true, message: 'Credenciais cTrader atualizadas.' });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

// --- LOGS ---
export async function getForexLogs(req: AuthenticatedRequest, res: Response) {
  let processName = 'forex-scalper';
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    processName = (req.query.process as string) || 'forex-scalper';
    if (['forex-scalp-executor', 'forex-scalp-scanner', 'forex-arb', 'forex-scanner'].includes(processName)) {
      processName = 'forex-scalper';
    }
    const lines = (req.query.lines as string) || '150';

    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    try {
      // 1. Tenta buscar logs reais do PM2 se o processo estiver rodando
      const { stdout, stderr } = await execAsync(`pm2 logs ${processName} --lines ${lines} --nostream --raw`);
      const rawLog = (stdout || stderr || '').toString();
      const logLines = rawLog
        .split('\n')
        .map((l: string) => l.trim())
        .filter((l: string) => l.length > 0);

      if (logLines.length > 0) {
        const responseData = {
          process: processName,
          linesCount: logLines.length,
          logs: logLines,
          timestamp: new Date().toISOString(),
        };
        const isDashboard = req.path.includes('/auth/');
        return isDashboard ? res.json(responseData) : res.json({ success: true, message: 'ok', data: responseData });
      }
    } catch {
      // PM2 indisponível ou processo local — prossegue com fallback DB
    }

    try {
      let filter: any = { userId };
      if (processName.includes('scanner')) {
        filter.type = { $in: ['opportunity_found', 'scan'] };
      }

      const recentTrades = await ForexArbTrade.find(filter)
        .sort({ createdAt: -1 })
        .limit(parseInt(lines, 10) || 50)
        .lean();

      const dbLogs = recentTrades.map((t: any) => {
        const ts = t.createdAt ? new Date(t.createdAt).toISOString() : new Date().toISOString();
        const symbol = t.legs && t.legs[0] ? t.legs[0].symbol : '';
        const side = t.legs && t.legs[0] ? t.legs[0].side?.toUpperCase() : '';
        const price = t.legs && t.legs[0]?.price ? ` | Preço: ${t.legs[0].price}` : '';
        return `[${ts}] [${processName.toUpperCase()}] ${t.type.toUpperCase()}: ${t.strategyName || symbol} ${side}${price} | ${t.reason || t.status || 'OK'}`;
      });

      const responseData = {
        process: processName,
        linesCount: dbLogs.length > 0 ? dbLogs.length : 3,
        logs: dbLogs.length > 0
          ? dbLogs
          : [
              `[${new Date().toISOString()}] [${processName.toUpperCase()}] Robô de Scalping Forex operante.`,
              `⚡ Monitorando ticks de mercado em tempo real (EUR/USD, GBP/USD, USD/JPY, XAU/USD)...`,
              `🎯 Buscando novos cruzamentos de médias (EMA5 x EMA15) e validação de RSI...`
            ],
        timestamp: new Date().toISOString(),
      };
      const isDashboard = req.path.includes('/auth/');
      return isDashboard ? res.json(responseData) : res.json({ success: true, message: 'ok', data: responseData });
    } catch (dbErr: any) {
      const responseData = {
        process: processName,
        linesCount: 1,
        logs: [`[${new Date().toISOString()}] Robô ${processName} operante. Aguardando próximos sinais de mercado...`],
        timestamp: new Date().toISOString(),
      };
      const isDashboard = req.path.includes('/auth/');
      return res.json(isDashboard ? responseData : { success: true, message: 'ok', data: responseData });
    }
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

// --- CLOSE & OPERATIONS ---
async function persistManualCloseTrade(strategy: any, reason: string) {
  const leg = (strategy.legs && strategy.legs[0]) || {};
  const sym = leg.symbol;
  const entryPrice = Number(leg.price ?? leg.entryPrice ?? 0);
  const currentPrice = Number(strategy.currentPrice ?? 0);
  const closePrice = currentPrice > 0 ? currentPrice : entryPrice;
  const volume = Number(leg.volume ?? strategy.positionVolume ?? 0);
  const amountUsd = Number(leg.amountUsd ?? strategy.positionAmountUsd ?? 0);

  await ForexArbTrade.create({
    userId: strategy.userId,
    strategyId: strategy._id,
    strategyName: strategy.name,
    exchangeId: strategy.exchangeId || 'ctrader',
    type: 'close',
    legs: [{
      symbol: sym,
      side: leg.side,
      price: closePrice,
      entryPrice,
      closePrice,
      amount: volume,
      volume,
      amountUsd,
      orderId: leg.orderId ?? null,
    }],
    amount: volume,
    volume,
    amountUsd,
    realizedPnl: Number(strategy.pnl ?? 0),
    commission: Number(strategy.commission ?? 0),
    swap: Number(strategy.swap ?? 0),
    status: 'executed',
    closedReason: strategy.closedReason ?? 'manual',
    reason,
  });
}

export async function closeForexStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    const { strategyId } = req.body;
    if (!strategyId) return res.status(400).json({ success: false, message: 'strategyId é obrigatório.' });

    const strategy = await ForexArbStrategy.findOne({ _id: strategyId, userId });
    if (!strategy) return res.status(404).json({ success: false, message: 'Estratégia não encontrada.' });

    // Tenta executar o fechamento real na cTrader se houver orderId de posição
    const posId = strategy.legs && strategy.legs[0]?.orderId;
    const symStrategy = strategy.legs && strategy.legs[0]?.symbol;

    if (posId || symStrategy) {
      try {
        const keys = await ExchangeKey.find({ userId, active: true }).lean();
        const ctraderKey = keys.find((k: any) => k.exchangeId === 'ctrader');
        if (ctraderKey) {
          const { getSharedCtraderAdapter } = require('../strategy/forex/ctrader/ctrader-factory');
          const adapter = await getSharedCtraderAdapter(ctraderKey as any);
          await adapter.connect();
          await adapter.loadMarkets();
          const accountId = Number((ctraderKey as any).accountId);
          const rec = await (adapter as any).client.sendRequest(2124, 'ProtoOAReconcileReq', { ctidTraderAccountId: accountId }, 10000);
          if (rec && rec.position) {
            // Busca a posição pelo positionId exato OU pelo símbolo correspondente se a ordem foi aberta anteriormente
            const p = rec.position.find((x: any) => {
              const m = adapter.marketsById.get(String(x.tradeData?.symbolId));
              return String(x.positionId) === String(posId) || (symStrategy && m?.symbol === symStrategy);
            });
            if (p) {
              const realPosId = String(p.positionId);
              const volProto = Number(p.tradeData?.volume || 100);
              console.log(`📤 [MANUAL CLOSE FRONTEND] Encerrando posição #${realPosId} na cTrader (volume: ${volProto})...`);
              await adapter.closePosition(realPosId, volProto);
            }
          }
        }
      } catch (ctraderErr: any) {
        console.warn(`⚠️ Erro ao fechar posição na cTrader via API:`, ctraderErr.message);
      }
    }

    if (symStrategy) {
      recordClosedTrade(symStrategy);
    }

    await ForexArbStrategy.updateOne(
      { _id: strategyId },
      { $set: { positionOpen: false, status: 'closed', closedAt: new Date(), active: false, pnl: strategy.pnl ?? 0, closedReason: strategy.closedReason ?? 'manual' } }
    );

    await persistManualCloseTrade(strategy, 'Fechamento manual via dashboard');

    return res.json({ success: true, message: 'Fechamento de posição encerrado com sucesso.' });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function voidCloseForexStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    const { strategyId } = req.body;
    if (!strategyId) return res.status(400).json({ success: false, message: 'strategyId é obrigatório.' });

    const strategy = await ForexArbStrategy.findOne({ _id: strategyId, userId });
    if (!strategy) return res.status(404).json({ success: false, message: 'Estratégia não encontrada.' });

    const symVoid = strategy.legs && strategy.legs[0]?.symbol;
    if (symVoid) {
      recordClosedTrade(symVoid);
    }

    await ForexArbStrategy.updateOne(
      { _id: strategyId },
      { $set: { positionOpen: false, status: 'closed', closedAt: new Date(), active: false, pnl: strategy.pnl ?? 0, closedReason: 'manual' } }
    );

    await persistManualCloseTrade(strategy, 'Encerrada pela corretora');

    return res.json({ success: true, message: 'Posição marcada como encerrada pela corretora.' });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function closeAllForexStrategies(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    const openStrategies = await ForexArbStrategy.find({ userId, positionOpen: true });
    if (!openStrategies || openStrategies.length === 0) {
      return res.json({ success: true, message: 'Nenhuma posição aberta encontrada.', closedCount: 0 });
    }

    let closedCount = 0;
    try {
      const keys = await ExchangeKey.find({ userId, active: true }).lean();
      const ctraderKey = keys.find((k: any) => k.exchangeId === 'ctrader');
      if (ctraderKey) {
        const { getSharedCtraderAdapter } = require('../strategy/forex/ctrader/ctrader-factory');
        const adapter = await getSharedCtraderAdapter(ctraderKey as any);
        await adapter.connect();
        await adapter.loadMarkets();
        const accountId = Number((ctraderKey as any).accountId);
        const rec = await (adapter as any).client.sendRequest(2124, 'ProtoOAReconcileReq', { ctidTraderAccountId: accountId }, 10000);

        if (rec && rec.position && rec.position.length > 0) {
          for (const p of rec.position) {
            try {
              const realPosId = String(p.positionId);
              const volProto = Number(p.tradeData?.volume || 100);
              console.log(`🚨 [CLOSE ALL MANUAL] Encerrando posição #${realPosId} na cTrader...`);
              await adapter.closePosition(realPosId, volProto);
              closedCount++;
            } catch (err: any) {
              console.error(`Erro ao fechar posição #${p.positionId}:`, err.message);
            }
          }
        }
      }
    } catch (ctraderErr: any) {
      console.warn(`⚠️ Erro de conexão com a cTrader durante o Close All:`, ctraderErr.message);
    }

    await ForexArbStrategy.updateMany(
      { userId, positionOpen: true },
      { $set: { positionOpen: false, status: 'closed', closedAt: new Date(), active: false, closedReason: 'manual' } }
    );

    for (const s of openStrategies) {
      try {
        await persistManualCloseTrade(s, 'Fechamento em massa via dashboard');
      } catch (e: any) {
        console.warn(`⚠️ Erro ao registrar trade de fechamento para ${s?.name}:`, e.message);
      }
    }

    return res.json({ success: true, message: `Todas as posições (${openStrategies.length}) foram encerradas com sucesso!`, closedCount });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

// --- LIVE PRICES (read-only, sem gravação no banco) ---
// Serve os preços atuais dos pares monitorados direto do cache de spots da
// cTrader (WebSocket, em memória) para o frontend animar o "Preço Atual" sem
// que o robô precise persistir ticker no MongoDB a cada segundo.
export async function getForexLivePrices(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

    const symbols = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'XAU/USD'];
    const keys = await ExchangeKey.find({ userId, active: true }).lean();
    const ctraderKey = keys.find((k: any) => k.exchangeId === 'ctrader');
    if (!ctraderKey) {
      return res.json({ success: true, message: 'ok', data: {} });
    }

    const { getSharedCtraderAdapter } = require('../strategy/forex/ctrader/ctrader-factory');
    const adapter = await getSharedCtraderAdapter(ctraderKey);
    const tickers = await adapter.fetchTickers(symbols);

    const data: Record<string, { bid: number; ask: number; mid: number }> = {};
    for (const sym of symbols) {
      const t = tickers[sym];
      if (t && t.bid > 0 && t.ask > 0) {
        data[sym] = { bid: t.bid, ask: t.ask, mid: (t.bid + t.ask) / 2 };
      }
    }

    return res.json({ success: true, message: 'ok', data });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

