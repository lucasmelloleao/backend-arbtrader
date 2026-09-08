import { Response } from 'express';
import LatencyArbSettings from '../models/LatencyArbSettings';
import LatencyArbTrade from '../models/LatencyArbTrade';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

export async function getLatencySettings(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    let settings = await LatencyArbSettings.findOne({ userId }).lean();
    if (!settings) {
      settings = await LatencyArbSettings.create({ userId });
    }
    return res.json({ success: true, data: settings });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function updateLatencySettings(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const body = req.body;
    const settings = await LatencyArbSettings.findOneAndUpdate(
      { userId },
      { $set: body },
      { new: true, upsert: true }
    ).lean();

    return res.json({ success: true, data: settings });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function getLatencyTrades(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const trades = await LatencyArbTrade.find({ userId })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return res.json({ success: true, data: trades });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
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
export async function getLatencyLogs(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const now = new Date();
    const timeStr = now.toLocaleTimeString('pt-BR');

    const mockLogs = [
      `[${timeStr}] [INFO] WebSocket Binance connected: wss://stream.binance.com/ws/btcusdt@trade`,
      `[${timeStr}] [INFO] MEXC REST Ticker sync: Poll interval 150ms active`,
      `[${timeStr}] [INFO] Symbol: BTC/USDT | Fast Feed: Binance | Target: MEXC Spot`,
      `[${timeStr}] [INFO] Monitorando deslocamento de preço em tempo real...`,
      `[${timeStr}] [SCAN] Binance BTC/USDT: $94,818.50 | MEXC Spot: $94,812.20 | Delta: $6.30 (310ms lag)`,
    ];

    return res.json({ success: true, logs: mockLogs, data: { logs: mockLogs } });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
}
