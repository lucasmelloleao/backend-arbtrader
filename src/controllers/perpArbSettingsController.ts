import { Response } from 'express';
import mongoose from 'mongoose';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import PerpArbSettings from '../models/PerpArbSettings';
import BotStatus from '../models/BotStatus';

export async function getBotStatus(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Não autorizado.' });
    }

    const botName = (req.query.botName as string) || 'funding-arb';

    const settings = await PerpArbSettings.findOne({ userId }).lean()
      || await PerpArbSettings.findOne().lean();

    const isScanningEnabled = settings ? (settings as any).isScanningEnabled === true : false;
    
    // Busca o heartbeat do robo gravado pelo loop-scanner-robot / forex-arb
    const botStatusDoc = await (BotStatus as any).findOne({ botName }).lean()
      || await (BotStatus as any).findOne({ userId: String(userId), botName }).lean();

    let isOnline = false;
    
    if (botStatusDoc && botStatusDoc.lastHeartbeat) {
      const diffMs = Date.now() - new Date(botStatusDoc.lastHeartbeat).getTime();
      // Considera online se o heartbeat ocorreu nos ultimos 3 minutos
      if (diffMs < 3 * 60 * 1000) {
        isOnline = true;
      }
    }

    return res.json({
      success: true,
      isOnline,
      lastHeartbeat: botStatusDoc?.lastHeartbeat || null,
      botName,
      data: {
        isScanningEnabled,
        isOnline,
        lastHeartbeat: botStatusDoc?.lastHeartbeat || null,
        botName
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

export async function getPerpArbSettings(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Não autorizado.' });
    }

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;

    let settings = await PerpArbSettings.findOne({ userId: userObjId });
    if (!settings) {
      settings = await PerpArbSettings.create({ userId: userObjId });
    }

    return res.json({
      success: true,
      message: 'ok',
      data: settings
    });
  } catch (e: any) {
    console.error('❌ [GET PerpArbSettings] Error:', e.message);
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function updatePerpArbSettings(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Não autorizado.' });
    }

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    const body = req.body;

    const updateData = { ...body };
    delete updateData._id;
    delete updateData.userId;

    const settings = await PerpArbSettings.findOneAndUpdate(
      { userId: userObjId },
      { $set: updateData },
      { new: true, upsert: true }
    );

    return res.json({
      success: true,
      message: 'Configurações salvas com sucesso.',
      data: settings
    });
  } catch (e: any) {
    console.error('❌ [POST PerpArbSettings] Error:', e.message);
    return res.status(500).json({ success: false, message: e.message });
  }
}
