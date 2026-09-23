import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import FxProStrategy from '../models/FxProStrategy';
import FxProTrade from '../models/FxProTrade';
import { FxProBot } from '../strategy/fxpro/fxpro-bot';
import { FxProMetaLabeler } from '../strategy/fxpro/helpers/fxpro-meta-labeler';

/**
 * @swagger
 * tags:
 *   name: FxPro
 *   description: Endpoints para gerenciamento do Robô FxPro cTrader e IA Meta-Labeling
 */

/**
 * Listar estratégias FxPro do usuário autenticado.
 */
export async function getFxProStrategies(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const strategies = await FxProStrategy.find({ userId }).sort({ createdAt: -1 }).lean();
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

    res.status(201).json({ ok: true, strategy: strat });
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

    const strat = await FxProStrategy.findOneAndUpdate(
      { _id: id, userId },
      { $set: body },
      { new: true }
    );

    if (!strat) {
      res.status(404).json({ ok: false, error: 'Estratégia não encontrada.' });
      return;
    }

    res.json({ ok: true, strategy: strat });
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

    const strat = await FxProStrategy.findOneAndDelete({ _id: id, userId });
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

    const strat = await FxProStrategy.findOne({ _id: id, userId });
    if (!strat) {
      res.status(404).json({ ok: false, error: 'Estratégia não encontrada.' });
      return;
    }

    strat.active = !strat.active;
    strat.status = strat.active ? 'running' : 'paused';
    await strat.save();

    res.json({ ok: true, strategy: strat });
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
