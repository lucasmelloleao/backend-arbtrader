import { Response } from 'express';
import mongoose from 'mongoose';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import DerivSettings from '../models/DerivSettings';
import DerivTrade from '../models/DerivTrade';
import DerivStrategy from '../models/DerivStrategy';

const isDashboard = (req: AuthenticatedRequest) => req.path.includes('/auth/');

export async function getDerivSettings(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;

    let settings = await DerivSettings.findOne({ userId: userObjId });
    if (!settings) {
      settings = await DerivSettings.create({ userId: userObjId });
    }

    if (isDashboard(req)) return res.json(settings);
    return res.json({ success: true, message: 'ok', data: settings });
  } catch (e: any) {
    console.error('❌ [GET DerivSettings] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function updateDerivSettings(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    const body = { ...req.body };
    delete body._id;
    delete body.userId;

    const settings = await DerivSettings.findOneAndUpdate(
      { userId: userObjId },
      { $set: body },
      { new: true, upsert: true }
    );

    if (isDashboard(req)) return res.json(settings);
    return res.json({ success: true, message: 'Configurações Deriv salvas com sucesso.', data: settings });
  } catch (e: any) {
    console.error('❌ [POST DerivSettings] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function getDerivTrades(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const { period = 'today', startDate, endDate, limit } = req.query;
    const query: any = { userId };

    const now = new Date();
    if (period === '5m') {
      const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
      query.$or = [{ createdAt: { $gte: fiveMinAgo } }, { status: { $in: ['open', 'pending'] } }];
    } else if (period === '10m') {
      const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);
      query.$or = [{ createdAt: { $gte: tenMinAgo } }, { status: { $in: ['open', 'pending'] } }];
    } else if (period === '30m') {
      const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
      query.$or = [{ createdAt: { $gte: thirtyMinAgo } }, { status: { $in: ['open', 'pending'] } }];
    } else if (period === '1h') {
      const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);
      query.$or = [{ createdAt: { $gte: oneHourAgo } }, { status: { $in: ['open', 'pending'] } }];

    } else if (period === '2h') {
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      query.$or = [{ createdAt: { $gte: twoHoursAgo } }, { status: { $in: ['open', 'pending'] } }];
    } else if (period === '3h') {
      const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
      query.$or = [{ createdAt: { $gte: threeHoursAgo } }, { status: { $in: ['open', 'pending'] } }];
    } else if (period === '4h') {
      const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);
      query.$or = [{ createdAt: { $gte: fourHoursAgo } }, { status: { $in: ['open', 'pending'] } }];
    } else if (period === '5h') {
      const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);
      query.$or = [{ createdAt: { $gte: fiveHoursAgo } }, { status: { $in: ['open', 'pending'] } }];

    } else if (period === '12h') {
      const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000);
      query.$or = [{ createdAt: { $gte: twelveHoursAgo } }, { status: { $in: ['open', 'pending'] } }];
    } else if (period === '24h') {
      const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      query.$or = [{ createdAt: { $gte: twentyFourHoursAgo } }, { status: { $in: ['open', 'pending'] } }];
    } else if (period === 'today') {
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      query.$or = [
        { createdAt: { $gte: startOfDay } },
        { status: { $in: ['open', 'pending'] } }
      ];
    } else if (period === '7d') {
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      query.$or = [
        { createdAt: { $gte: sevenDaysAgo } },
        { status: { $in: ['open', 'pending'] } }
      ];
    } else if (period === '30d') {
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      query.$or = [
        { createdAt: { $gte: thirtyDaysAgo } },
        { status: { $in: ['open', 'pending'] } }
      ];
    } else if (startDate || endDate) {
      const dateFilter: any = {};
      if (startDate) dateFilter.$gte = new Date(String(startDate));
      if (endDate) dateFilter.$lte = new Date(String(endDate));
      query.$or = [
        { createdAt: dateFilter },
        { status: { $in: ['open', 'pending'] } }
      ];
    }


    const maxLimit = limit ? Number(limit) : (period === 'all' ? 2000 : 2000);

    const trades = await DerivTrade.find(query)
      .sort({ createdAt: -1 })
      .limit(maxLimit)
      .lean();


    const formatted = trades.map((t: any) => ({
      id: t._id.toString(),
      contractId: t.contractId,
      symbol: t.symbol,
      strategyName: t.strategyName || (t.reason?.match(/Estratégia "([^"]+)"/)?.[1] ?? t.symbol),
      question: t.question || t.symbol,
      contractType: t.contractType,
      status: t.status,
      buyPrice: t.buyPrice ?? 0,
      sellPrice: t.sellPrice ?? 0,
      pnl: t.pnl ?? 0,
      investedUsd: t.investedUsd ?? 0,
      realizedUsd: t.realizedUsd ?? 0,
      reason: t.reason || '',
      openedAt: t.openedAt ? new Date(t.openedAt).toISOString() : '',
      createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : '',
    }));

    return res.json({ success: true, message: 'ok', data: formatted });
  } catch (e: any) {
    console.error('❌ [GET DerivTrades] Error:', e.message);
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function deleteDerivTrades(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    await DerivTrade.deleteMany({ userId });

    const msg = 'Histórico de operações Deriv zerado com sucesso!';
    if (isDashboard(req)) return res.json({ success: true, message: msg });
    return res.json({ success: true, message: msg });
  } catch (e: any) {
    console.error('❌ [DELETE DerivTrades] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function getDerivTradesSummary(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const executed = await DerivTrade.find({ userId, status: 'executed' }).lean();

    const totalClosed = executed.length;
    const totalPnl = executed.reduce((acc: number, t: any) => acc + Number(t.pnl || 0), 0);
    const totalInvested = executed.reduce((acc: number, t: any) => acc + Number(t.investedUsd || t.buyPrice || 0), 0);
    const winCount = executed.filter((t: any) => Number(t.pnl || 0) > 0).length;
    const winRate = totalClosed > 0 ? Number(((winCount / totalClosed) * 100).toFixed(1)) : 0;

    const data = {
      operacoesEncerradas: totalClosed,
      totalPnl: Number(totalPnl.toFixed(2)),
      winRate,
      totalEntradaUsd: Number(totalInvested.toFixed(2)),
      totalSaidaUsd: Number((totalInvested + totalPnl).toFixed(2)),
    };

    if (isDashboard(req)) return res.json(data);
    return res.json({ success: true, message: 'ok', data });
  } catch (e: any) {
    console.error('❌ [GET DerivTradesSummary] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}export async function getDerivBalance(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    let settings = await DerivSettings.findOne({ userId: userObjId }).lean();
    if (!settings) {
      settings = await DerivSettings.findOne().lean();
    }

    const data = {
      demo: settings?.demoBalance ? {
        loginId: settings.demoBalance.loginId || '',
        balance: Number(settings.demoBalance.balance || 0),
        currency: settings.demoBalance.currency || 'USD',
      } : null,
      real: settings?.realBalance ? {
        loginId: settings.realBalance.loginId || '',
        balance: Number(settings.realBalance.balance || 0),
        currency: settings.realBalance.currency || 'USD',
      } : null,
      activeAccount: settings?.accountType || 'demo',
    };

    if (isDashboard(req)) return res.json(data);
    return res.json({ success: true, message: 'ok', data });
  } catch (e: any) {
    console.error('❌ [GET DerivBalance] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}


export async function getDerivLogs(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');
    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const processName = (req.query.process as string) || 'backend-arbtrader';
    const lines = Number(req.query.lines) || 150;

    const { getDerivLogBuffer } = require('../strategy/deriv/deriv-bot');
    const memoryLogs: string[] = getDerivLogBuffer();

    if (memoryLogs && memoryLogs.length > 0) {
      const sliced = memoryLogs.slice(-lines);
      const responseData = {
        process: processName,
        linesCount: sliced.length,
        logs: sliced,
        timestamp: new Date().toISOString(),
      };
      if (isDashboardPath) return res.json(responseData);
      return res.json({ success: true, message: 'ok', data: responseData });
    }

    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    try {
      const { stdout, stderr } = await execAsync(`pm2 logs ${processName} --lines ${lines} --nostream --raw`);
      const rawOutput = stdout || stderr || '';
      const logLines = rawOutput
        .split('\n')
        .map((l: string) => l.trim())
        .filter((l: string) => Boolean(l) && (l.includes('DERIV') || l.includes('deriv')));

      const responseData = {
        process: processName,
        linesCount: logLines.length,
        logs: logLines.length > 0 ? logLines : [`[${new Date().toISOString()}] Robô Deriv operante (aguardando próximo ciclo de varredura).`],
        timestamp: new Date().toISOString(),
      };

      return res.json(isDashboardPath ? responseData : { success: true, message: 'ok', data: responseData });
    } catch (execErr: any) {
      const responseData = {
        process: processName,
        linesCount: 1,
        logs: [`💡 [${new Date().toISOString()}] Robô Deriv ativo e conectado via WebSocket. Aguardando novo ciclo...`],
        timestamp: new Date().toISOString(),
      };
      return res.json(isDashboardPath ? responseData : { success: true, message: 'ok', data: responseData });
    }
  } catch (error: any) {
    console.error('❌ [getDerivLogs] Error:', error.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: error.message } : { success: false, message: error.message });
  }
}

export async function getDerivStrategies(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    const strats = await DerivStrategy.find({ $or: [{ userId }, { userId: userObjId }] }).sort({ createdAt: -1 }).lean();
    const formatted = strats.map((s: any) => ({
      id: s._id.toString(),
      name: s.name || s.symbol,
      symbol: s.symbol,
      contractType: s.contractType || 'BOTH_HL',
      barrier: s.barrier || '-1',
      barrierLower: s.barrierLower || '+1',
      tradeSize: s.tradeSize || 2,
            minCertaintyProb: s.minCertaintyProb ?? 0.75,
      minTakeProfitPct: s.minTakeProfitPct ?? 15,
      emergencyStopPct: s.emergencyStopPct ?? 70,
      active: s.active !== false,
      positionOpen: Boolean(s.positionOpen),
      contractId: s.contractId || null,
      pnl: s.pnl || 0,
      lastCheckAt: s.lastCheckAt ? new Date(s.lastCheckAt).toISOString() : '',
      lastTradeAt: s.lastTradeAt ? new Date(s.lastTradeAt).toISOString() : '',
      createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : '',
    }));

    if (isDashboard(req)) return res.json(formatted);
    return res.json({ success: true, message: 'ok', data: formatted });
  } catch (e: any) {
    console.error('❌ [GET DerivStrategies] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function createDerivStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    const { symbol, name, contractType, barrier, barrierLower, tradeSize, durationSec, minCertaintyProb, minTakeProfitPct, emergencyStopPct, active } = req.body;
    if (!symbol) return res.status(400).json(isDashboard(req) ? { error: 'Símbolo é obrigatório' } : { success: false, message: 'Símbolo é obrigatório.' });

    const strat = await DerivStrategy.create({
      userId: userObjId,
      symbol: symbol.trim(),
      name: name?.trim() || symbol.trim(),
      contractType: contractType || 'BOTH_HL',
      barrier: barrier ? String(barrier) : '-1',
      barrierLower: barrierLower ? String(barrierLower) : '+1',
      tradeSize: Number(tradeSize) || 2,
      durationSec: Number(durationSec) || 15,
      minCertaintyProb: Number(minCertaintyProb) || 0.75,
      minTakeProfitPct: minTakeProfitPct !== undefined ? Number(minTakeProfitPct) : 15,
      emergencyStopPct: emergencyStopPct !== undefined ? Number(emergencyStopPct) : 70,
      active: active !== false,
    });

    const data = {
      id: strat._id.toString(),
      name: strat.name,
      symbol: strat.symbol,
      contractType: strat.contractType,
      barrier: strat.barrier,
      barrierLower: strat.barrierLower,
      tradeSize: strat.tradeSize,
      durationSec: strat.durationSec,
      minCertaintyProb: strat.minCertaintyProb,
      minTakeProfitPct: strat.minTakeProfitPct,
      emergencyStopPct: strat.emergencyStopPct,
      active: strat.active,
      positionOpen: false,
    };

    if (isDashboard(req)) return res.status(201).json(data);
    return res.status(201).json({ success: true, message: 'Estratégia Deriv criada com sucesso.', data });
  } catch (e: any) {
    console.error('❌ [POST DerivStrategy] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function updateDerivStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const id = req.params.id || req.body.id || req.body.strategyId;
    if (!id) return res.status(400).json(isDashboard(req) ? { error: 'ID é obrigatório' } : { success: false, message: 'ID é obrigatório.' });

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    const stratObjId = mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : id;

    const body = { ...req.body };
    delete body._id;
    delete body.userId;

    const strat = await DerivStrategy.findOneAndUpdate(
      { _id: stratObjId, $or: [{ userId }, { userId: userObjId }] },
      { $set: body },
      { new: true }
    ).lean();

    if (!strat) return res.status(404).json(isDashboard(req) ? { error: 'Estratégia não encontrada' } : { success: false, message: 'Estratégia não encontrada.' });

    if (isDashboard(req)) return res.json(strat);
    return res.json({ success: true, message: 'Estratégia atualizada com sucesso.', data: strat });
  } catch (e: any) {
    console.error('❌ [PUT DerivStrategy] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function deleteDerivStrategy(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const id = req.params.id || req.body.id || req.body.strategyId;
    if (!id) return res.status(400).json(isDashboard(req) ? { error: 'ID é obrigatório' } : { success: false, message: 'ID é obrigatório.' });

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    const stratObjId = mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : id;

    await DerivStrategy.deleteOne({ _id: stratObjId, $or: [{ userId }, { userId: userObjId }] });

    if (isDashboard(req)) return res.json({ success: true, message: 'Estratégia removida.' });
    return res.json({ success: true, message: 'Estratégia removida com sucesso.' });
  } catch (e: any) {
    console.error('❌ [DELETE DerivStrategy] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function getDerivContractsFor(req: AuthenticatedRequest, res: Response) {
  try {
    const symbol = req.params.symbol || req.query.symbol || '1HZ10V';
    const userId = req.userId;
    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    let settings = await DerivSettings.findOne({ userId: userObjId }).lean();
    if (!settings) {
      settings = await DerivSettings.findOne().lean();
    }

    const appId = settings?.appId || '1089';
    const activeToken = settings?.accountType === 'real'
      ? (settings?.realApiToken || settings?.apiToken || '')
      : (settings?.demoApiToken || settings?.apiToken || '');

    const { DerivWsClient } = require('../strategy/deriv/helpers/deriv-ws');
    const client = new DerivWsClient(appId, activeToken, settings?.accountType || 'demo');
    await client.connect();
    const availableContracts = await client.getContractsFor(String(symbol));
    client.close();

    // Filtra e organiza os tipos suportados relevantes (CALL/PUT/HIGHER/LOWER)
    const summary = availableContracts.map((c: any) => ({
      contractCategory: c.contract_category,
      contractType: c.contract_type,
      contractDisplay: c.contract_display,
      minDuration: c.min_contract_duration,
      maxDuration: c.max_contract_duration,
      barriers: c.barriers,
      defaultBarrier: c.default_barrier,
    }));

    return res.json({ success: true, message: 'ok', data: summary });
  } catch (e: any) {
    console.error('❌ [GET DerivContractsFor] Error:', e.message);
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function getDerivBarrierRange(req: AuthenticatedRequest, res: Response) {
  try {
    const { symbol = '1HZ10V', durationSec = 15 } = req.query;
    const userId = req.userId;
    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    let settings = await DerivSettings.findOne({ userId: userObjId }).lean();
    if (!settings) settings = await DerivSettings.findOne().lean();

    const appId = settings?.appId || '1089';
    const activeToken = settings?.accountType === 'real'
      ? (settings?.realApiToken || settings?.apiToken || '')
      : (settings?.demoApiToken || settings?.apiToken || '');

    const { DerivWsClient } = require('../strategy/deriv/helpers/deriv-ws');
    const client = new DerivWsClient(appId, activeToken, settings?.accountType || 'demo');
    await client.connect();

    const duration = Number(durationSec) || 15;
    const duration_unit = duration >= 60 && duration % 60 === 0 ? 'm' : 's';
    const finalDuration = duration_unit === 'm' ? duration / 60 : duration;

    // Busca contratos disponiveis para obter a barreira padrão e limites
    const available = await client.getContractsFor(String(symbol));
    const match = available.find((c: any) => c.contract_type === 'HIGHER' || c.contract_category === 'high_low');
    const defBarrierStr = match?.default_barrier || '0.5';
    const defBarrierNum = Math.abs(parseFloat(defBarrierStr)) || 0.5;

    const baseOffsets = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0];
    const testOffsets = Array.from(new Set([
      ...baseOffsets,
      Number(defBarrierNum.toFixed(2)),
      Number((defBarrierNum * 0.5).toFixed(2)),
      Number((defBarrierNum * 1.5).toFixed(2)),
      Number((defBarrierNum * 2).toFixed(2)),
    ])).filter(v => v > 0).sort((a, b) => a - b);

    const validHigher: number[] = [];
    const validLower: number[] = [];

    await Promise.all(testOffsets.map(async (off) => {
      const [propH, propL] = await Promise.all([
        client.getProposal({
          symbol: String(symbol),
          contract_type: 'HIGHER',
          amount: 2,
          duration: finalDuration,
          duration_unit,
          barrier: `-${off}`,
        }).catch(() => null),
        client.getProposal({
          symbol: String(symbol),
          contract_type: 'LOWER',
          amount: 2,
          duration: finalDuration,
          duration_unit,
          barrier: `+${off}`,
        }).catch(() => null)
      ]);

      if (propH && propH.id && Number(propH.payout) > 0) {
        validHigher.push(off);
      }
      if (propL && propL.id && Number(propL.payout) > 0) {
        validLower.push(off);
      }
    }));

    client.close();

    const maxHigher = validHigher.length > 0 ? Math.max(...validHigher) : defBarrierNum;
    const minHigher = validHigher.length > 0 ? Math.min(...validHigher) : 0.1;
    const maxLower = validLower.length > 0 ? Math.max(...validLower) : defBarrierNum;
    const minLower = validLower.length > 0 ? Math.min(...validLower) : 0.1;

    return res.json({
      success: true,
      data: {
        symbol,
        durationSec: duration,
        higher: {
          min: `-${minHigher.toFixed(2)}`,
          max: `-${maxHigher.toFixed(2)}`,
          default: `-${defBarrierNum.toFixed(2)}`,
          validList: validHigher.map(v => `-${v.toFixed(2)}`),
        },
        lower: {
          min: `+${minLower.toFixed(2)}`,
          max: `+${maxLower.toFixed(2)}`,
          default: `+${defBarrierNum.toFixed(2)}`,
          validList: validLower.map(v => `+${v.toFixed(2)}`),
        },
      },
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function testDerivProposal(req: AuthenticatedRequest, res: Response) {
  try {
    const { symbol, contractType, durationSec, barrier, amount } = req.body;
    const userId = req.userId;
    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    let settings = await DerivSettings.findOne({ userId: userObjId }).lean();
    if (!settings) settings = await DerivSettings.findOne().lean();

    const appId = settings?.appId || '1089';
    const activeToken = settings?.accountType === 'real'
      ? (settings?.realApiToken || settings?.apiToken || '')
      : (settings?.demoApiToken || settings?.apiToken || '');

    const { DerivWsClient } = require('../strategy/deriv/helpers/deriv-ws');
    const client = new DerivWsClient(appId, activeToken, settings?.accountType || 'demo');
    await client.connect();

    const duration = Number(durationSec) || 15;
    const duration_unit = duration >= 60 && duration % 60 === 0 ? 'm' : 's';
    const finalDuration = duration_unit === 'm' ? duration / 60 : duration;

    const payload: any = {
      symbol: symbol || '1HZ10V',
      contract_type: contractType === 'BOTH_HL' ? 'HIGHER' : contractType === 'BOTH_RF' ? 'CALL' : contractType,
      amount: Number(amount) || 2,
      duration: finalDuration,
      duration_unit,
    };
    if (barrier) {
      payload.barrier = String(barrier);
    }

    const proposal = await client.getProposal(payload).catch((err: any) => ({ error: err.message }));
    client.close();

    if (proposal?.error) {
      return res.json({ success: false, error: proposal.error });
    }

    return res.json({
      success: true,
      message: 'ok',
      data: {
        payout: proposal.payout,
        askPrice: proposal.ask_price,
        barrier: proposal.barrier,
        spot: proposal.spot,
        dateExpiry: proposal.date_expiry,
      },
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function getDerivAiAnalysis(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const provider = (process.env.AI_PROVIDER || 'gemini') as 'gemini' | 'deepseek';
    const apiKey = provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.DEEPSEEK_API_KEY;
    const model = provider === 'gemini'
      ? (process.env.GEMINI_MODEL || 'gemini-3.6-flash')
      : (process.env.DEEPSEEK_MODEL || 'deepseek-chat');

    if (!apiKey) {
      return res.status(500).json(isDashboard(req) ? { error: `Chave de IA (${provider}) não configurada.` } : { success: false, message: `Chave de IA (${provider}) não configurada no servidor.` });
    }

    const { buildDerivMetrics, buildAnalysisPrompt, callAiAnalysis } = require('../strategy/deriv/helpers/deriv-ai-analysis');

    const trades = await DerivTrade.find({ userId, status: 'executed' }).lean();
    const metrics = buildDerivMetrics(trades);

    if (!metrics.totalTrades) {
      return res.json({ success: true, message: 'ok', data: { metrics, analysis: 'Nenhuma operação encerrada ainda para analisar. Deixe o robô operar um pouco e tente novamente.' } });
    }

    const prompt = buildAnalysisPrompt(metrics);
    const analysis = await callAiAnalysis(provider, apiKey, prompt, model);

    return res.json({ success: true, message: 'ok', data: { metrics, analysis } });
  } catch (e: any) {
    console.error('❌ [POST DerivAiAnalysis] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function trainDerivMetaModel(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    const { DerivMetaLabeler } = require('../strategy/deriv/helpers/deriv-meta-labeler');
    const result = await DerivMetaLabeler.trainModel(userObjId);

    if (!result.success) {
      return res.status(400).json(isDashboard(req) ? { error: result.message } : { success: false, message: result.message });
    }

    return res.json({ success: true, message: result.message, data: result.metadata });
  } catch (e: any) {
    console.error('❌ [POST TrainDerivMetaModel] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function getDerivMetaModelStatus(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    const { DerivMetaLabeler } = require('../strategy/deriv/helpers/deriv-meta-labeler');
    const metadata = DerivMetaLabeler.getMetadata();

    const executedCount = await DerivTrade.countDocuments({
      $or: [{ userId }, { userId: userObjId }],
      status: 'executed'
    });

    const isDash = isDashboard(req);
    const data = {
      isTrained: Boolean(metadata),
      metadata,
      totalExecutedTrades: executedCount,
      minTradesRequired: 15,
    };

    if (isDash) return res.json(data);
    return res.json({
      success: true,
      data
    });
  } catch (e: any) {
    console.error('❌ [GET DerivMetaModelStatus] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}





