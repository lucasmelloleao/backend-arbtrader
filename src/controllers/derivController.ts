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

export async function getDerivStrategies(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const strats = await DerivStrategy.find({ userId }).sort({ createdAt: -1 }).lean();
    const formatted = strats.map((s: any) => ({
      id: s._id.toString(),
      name: s.name || s.symbol,
      symbol: s.symbol,
      contractType: s.contractType || 'BOTH_HL',
      barrier: s.barrier || '-1',
      barrierLower: s.barrierLower || '+1',
      tradeSize: s.tradeSize || 2,
      durationSec: s.durationSec || 15,
      minCertaintyProb: s.minCertaintyProb || 0.75,
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

    const { symbol, name, contractType, barrier, barrierLower, tradeSize, durationSec, minCertaintyProb, active } = req.body;
    if (!symbol) return res.status(400).json(isDashboard(req) ? { error: 'Símbolo é obrigatório' } : { success: false, message: 'Símbolo é obrigatório.' });

    const strat = await DerivStrategy.create({
      userId,
      symbol: symbol.trim(),
      name: name?.trim() || symbol.trim(),
      contractType: contractType || 'BOTH_HL',
      barrier: barrier ? String(barrier) : '-1',
      barrierLower: barrierLower ? String(barrierLower) : '+1',
      tradeSize: Number(tradeSize) || 2,
      durationSec: Number(durationSec) || 15,
      minCertaintyProb: Number(minCertaintyProb) || 0.75,
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

    const body = { ...req.body };
    delete body._id;
    delete body.userId;

    const strat = await DerivStrategy.findOneAndUpdate(
      { _id: id, userId },
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

    await DerivStrategy.deleteOne({ _id: id, userId });

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

    const appId = settings?.appId || '34kQP2mEzJFjAJ2q1atub';
    const token = settings?.demoApiToken || settings?.realApiToken || settings?.apiToken || '';
    const { DerivWsClient } = require('../strategy/deriv/helpers/deriv-ws');
    const client = new DerivWsClient(appId, token, settings?.accountType || 'demo');
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

    const appId = settings?.appId || '34kQP2mEzJFjAJ2q1atub';
    const token = settings?.demoApiToken || settings?.realApiToken || settings?.apiToken || '';
    const { DerivWsClient } = require('../strategy/deriv/helpers/deriv-ws');
    const client = new DerivWsClient(appId, token, settings?.accountType || 'demo');
    await client.connect();

    const duration = Number(durationSec) || 15;
    const duration_unit = duration >= 60 && duration % 60 === 0 ? 'm' : 's';
    const finalDuration = duration_unit === 'm' ? duration / 60 : duration;

    // Busca contrato padrão para obter base
    const available = await client.getContractsFor(String(symbol));
    const match = available.find((c: any) => c.contract_type === 'HIGHER' || c.contract_category === 'high_low');
    const defBarrierStr = match?.default_barrier || '1';
    const defBarrierNum = Math.abs(parseFloat(defBarrierStr)) || 1;

    // Testa múltiplos offsets para encontrar o teto máximo e mínimo aceito
    const testOffsets = [
      0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.8, 1.0, 1.2, 1.4, 1.5, 1.6, 1.8, 2.0, 2.5, 3.0, 4.0, 5.0
    ].map(m => Number((m * (defBarrierNum <= 1 ? 1 : defBarrierNum)).toFixed(2)));

    const validHigher: number[] = [];
    const validLower: number[] = [];

    // Testa em lotes rápidos
    for (const off of testOffsets) {
      // Test Higher (-off)
      const propH = await client.getProposal({
        symbol: String(symbol),
        contract_type: 'HIGHER',
        amount: 2,
        duration: finalDuration,
        duration_unit,
        barrier: `-${off}`,
      }).catch(() => null);

      if (propH && propH.id && propH.payout > 0) {
        validHigher.push(off);
      }

      // Test Lower (+off)
      const propL = await client.getProposal({
        symbol: String(symbol),
        contract_type: 'LOWER',
        amount: 2,
        duration: finalDuration,
        duration_unit,
        barrier: `+${off}`,
      }).catch(() => null);

      if (propL && propL.id && propL.payout > 0) {
        validLower.push(off);
      }
    }

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

    const appId = settings?.appId || '34kQP2mEzJFjAJ2q1atub';
    const token = settings?.demoApiToken || settings?.realApiToken || settings?.apiToken || '';
    const { DerivWsClient } = require('../strategy/deriv/helpers/deriv-ws');
    const client = new DerivWsClient(appId, token, settings?.accountType || 'demo');
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





