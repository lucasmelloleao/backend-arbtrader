import mongoose from 'mongoose';
import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import FxProSettings from '../models/FxProSettings';
import FxProStrategy from '../models/FxProStrategy';
import FxProTrade from '../models/FxProTrade';
import { FxProBot, getFxProLogBuffer } from '../strategy/fxpro/fxpro-bot';
import { FxProMetaLabeler } from '../strategy/fxpro/helpers/fxpro-meta-labeler';

/**
 * @swagger
 * tags:
 *   name: FxPro
 *   description: Endpoints para gerenciamento do Robô FxPro cTrader e IA Meta-Labeling
 */

/**
 * Obter configurações globais do robô FxPro.
 */
export async function getFxProSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    let settings = await FxProSettings.findOne({ userId });
    if (!settings) {
      settings = await FxProSettings.create({ userId });
    }
    res.json({ ok: true, settings });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Atualizar configurações globais do robô FxPro.
 */
export async function updateFxProSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const body = req.body;

    const settings = await FxProSettings.findOneAndUpdate(
      { userId },
      { $set: body },
      { new: true, upsert: true }
    );

    // Se o usuário ligou/desligou isScanningEnabled, atualiza o motor
    if (body.isScanningEnabled !== undefined) {
      if (body.isScanningEnabled) {
        await FxProBot.start();
      } else {
        await FxProBot.stop();
      }
    }

    res.json({ ok: true, settings });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Helper para formatar estratégia com id serializado
 */
function formatStrategy(s: any): any {
  if (!s) return s;
  const obj = typeof s.toObject === 'function' ? s.toObject() : { ...s };
  return {
    ...obj,
    id: obj._id?.toString() || obj.id,
    _id: obj._id?.toString() || obj.id,
  };
}

/**
 * Listar estratégias FxPro do usuário autenticado.
 */
export async function getFxProStrategies(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    const rawStrategies = await FxProStrategy.find({
      $or: [{ userId }, { userId: userObjId }, { userId: { $exists: false } }],
    }).sort({ createdAt: -1 }).lean();

    for (const strat of rawStrategies) {
      if (strat.currentPositionId) {
        const hasOpenTrade = await FxProTrade.exists({
          strategyId: strat._id,
          status: 'open',
          positionId: strat.currentPositionId,
        });
        if (!hasOpenTrade) {
          await FxProStrategy.findByIdAndUpdate(strat._id, {
            $unset: { currentPositionId: 1, currentSide: 1 },
            $set: { currentPnlUsd: 0, entryPrice: 0 },
          });
          delete strat.currentPositionId;
          delete strat.currentSide;
          strat.currentPnlUsd = 0;
          strat.entryPrice = 0;
        }
      }
    }

    const strategies = rawStrategies.map(formatStrategy);
    res.json({ ok: true, strategies });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Criar nova estratégia FxPro.
 */
export async function createFxProStrategy(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const body = req.body;

    if (!body.symbol || !body.name) {
      res.status(400).json({ ok: false, error: 'Nome e Símbolo são obrigatórios.' });
      return;
    }

    const strat = await FxProStrategy.create({
      userId,
      ...body,
      symbol: String(body.symbol).toUpperCase(),
    });

    res.status(201).json({ ok: true, strategy: formatStrategy(strat) });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Atualizar parâmetros de uma estratégia FxPro.
 */
export async function updateFxProStrategy(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const { id } = req.params;
    const body = req.body;

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    const strat = await FxProStrategy.findOneAndUpdate(
      {
        _id: id,
        $or: [{ userId }, { userId: userObjId }, { userId: { $exists: false } }],
      },
      { $set: body },
      { new: true }
    ) || await FxProStrategy.findByIdAndUpdate(id, { $set: body }, { new: true });

    if (!strat) {
      res.status(404).json({ ok: false, error: 'Estratégia não encontrada.' });
      return;
    }

    res.json({ ok: true, strategy: formatStrategy(strat) });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Deletar estratégia FxPro.
 */
export async function deleteFxProStrategy(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const { id } = req.params;

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    const strat = await FxProStrategy.findOneAndDelete({
      _id: id,
      $or: [{ userId }, { userId: userObjId }, { userId: { $exists: false } }],
    }) || await FxProStrategy.findByIdAndDelete(id);

    if (!strat) {
      res.status(404).json({ ok: false, error: 'Estratégia não encontrada.' });
      return;
    }

    res.json({ ok: true, message: 'Estratégia removida com sucesso.' });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Alternar status (Ligar/Pausar) da estratégia.
 */
export async function toggleFxProStrategy(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const { id } = req.params;

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    let strat = await FxProStrategy.findOne({
      _id: id,
      $or: [{ userId }, { userId: userObjId }, { userId: { $exists: false } }],
    }) || await FxProStrategy.findById(id);

    if (!strat) {
      res.status(404).json({ ok: false, error: 'Estratégia não encontrada.' });
      return;
    }

    strat.active = !strat.active;
    strat.status = strat.active ? 'running' : 'paused';
    await strat.save();

    res.json({ ok: true, strategy: formatStrategy(strat) });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Listar histórico de trades com filtro por período.
 */
export async function getFxProTrades(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const { periodo, symbol, limit } = req.query;

    const query: any = { userId };
    if (symbol) query.symbol = String(symbol).toUpperCase();

    if (periodo === 'today') {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      query.createdAt = { $gte: startOfDay };
    } else if (periodo === '7d') {
      query.createdAt = { $gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) };
    } else if (periodo === '30d') {
      query.createdAt = { $gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) };
    }

    const trades = await FxProTrade.find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit) || 200)
      .lean();

    res.json({ ok: true, trades });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Status do motor FxPro.
 */
export async function getFxProBotStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const status = FxProBot.getStatus();
    res.json({ ok: true, ...status });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Iniciar motor FxPro.
 */
export async function startFxProBot(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    await FxProBot.start();
    res.json({ ok: true, message: 'Motor FxPro cTrader iniciado com sucesso.' });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Parar motor FxPro.
 */
export async function stopFxProBot(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    await FxProBot.stop();
    res.json({ ok: true, message: 'Motor FxPro cTrader pausado.' });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Status da IA Meta-Labeling da FxPro (Gate 4).
 */
export async function getFxProMetaModelStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const metadata = FxProMetaLabeler.getMetadata();
    const totalTrades = await FxProTrade.countDocuments({
      ...(userId ? { userId } : {}),
      status: 'closed',
    });

    res.json({
      ok: true,
      data: {
        isTrained: Boolean(metadata),
        metadata,
        totalExecutedTrades: totalTrades,
        minTradesRequired: 5,
      },
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Disparar treinamento do modelo de IA da FxPro.
 */
export async function trainFxProMetaModel(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const result = await FxProMetaLabeler.trainModel(userId);
    if (result.success) {
      res.json({ ok: true, message: result.message, metadata: result.metadata });
    } else {
      res.status(400).json({ ok: false, error: result.message });
    }
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Obter logs em tempo real do robô FxPro cTrader.
 */
export async function getFxProLogs(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');
    if (!userId) {
      res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
      return;
    }

    const lines = Number(req.query.lines) || 150;
    const memoryLogs: string[] = getFxProLogBuffer();

    const sliced = memoryLogs.slice(-lines);
    const responseData = {
      process: 'fxpro-bot',
      linesCount: sliced.length,
      logs: sliced,
      timestamp: new Date().toISOString(),
    };

    if (isDashboardPath) {
      res.json(responseData);
      return;
    }
    res.json({ success: true, message: 'ok', data: responseData });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
