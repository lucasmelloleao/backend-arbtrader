import { Response } from 'express';
import LatencyArbSettings from '../models/LatencyArbSettings';
import LatencyArbTrade from '../models/LatencyArbTrade';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

export async function getLatencySettings(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    let settings = await LatencyArbSettings.findOne({ userId }).lean();
    if (!settings) {
      settings = await LatencyArbSettings.create({ userId });
    }
    return res.json(settings);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
}

export async function updateLatencySettings(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const body = req.body;
    const settings = await LatencyArbSettings.findOneAndUpdate(
      { userId },
      { $set: body },
      { new: true, upsert: true }
    ).lean();

    return res.json(settings);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
}

export async function getLatencyTrades(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const trades = await LatencyArbTrade.find({ userId })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return res.json(trades);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
}

export async function closeLatencyTrade(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Trade ID required' });

    const trade = await LatencyArbTrade.findOneAndUpdate(
      { _id: id, userId },
      { $set: { status: 'closed', closedAt: new Date(), reason: 'Fechamento Manual (Dashboard)' } },
      { new: true }
    ).lean();

    return res.json({ success: true, data: trade });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
}
