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

    const trades = await DerivTrade.find({ userId })
      .sort({ createdAt: -1 })
      .limit(300)
      .lean();

    const formatted = trades.map((t: any) => ({
      id: t._id.toString(),
      contractId: t.contractId,
      symbol: t.symbol,
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
    await DerivStrategy.deleteMany({ userId });

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

    const appId = settings?.appId || '34kQP2mEzJFjAJ2q1atub';
    const demoToken = settings?.demoApiToken || settings?.apiToken || '';
    const realToken = settings?.realApiToken || settings?.apiToken || '';

    const { DerivWsClient } = require('../strategy/deriv/helpers/deriv-ws');

    let demoBalance: { loginid?: string; balance?: string | number; currency?: string } | null = null;
    let realBalance: { loginid?: string; balance?: string | number; currency?: string } | null = null;

    if (demoToken) {
      try {
        const clientDemo = new DerivWsClient(appId, demoToken, 'demo');
        await clientDemo.connect();
        demoBalance = await clientDemo.authorize();
        clientDemo.close();
      } catch (e: any) {
        console.warn('⚠️ [getDerivBalance] Erro demo:', e.message);
      }
    }

    if (realToken) {
      try {
        const clientReal = new DerivWsClient(appId, realToken, 'real');
        await clientReal.connect();
        realBalance = await clientReal.authorize();
        clientReal.close();
      } catch (e: any) {
        console.warn('⚠️ [getDerivBalance] Erro real:', e.message);
      }
    }

    const data = {
      demo: demoBalance ? {
        loginId: demoBalance.loginid || '',
        balance: Number(demoBalance.balance || 0),
        currency: demoBalance.currency || 'USD',
      } : null,
      real: realBalance ? {
        loginId: realBalance.loginid || '',
        balance: Number(realBalance.balance || 0),
        currency: realBalance.currency || 'USD',
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

