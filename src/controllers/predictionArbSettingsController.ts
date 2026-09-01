import { Response } from 'express';
import mongoose from 'mongoose';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import PredictionArbSettings from '../models/PredictionArbSettings';
import BotStatus from '../models/BotStatus';
import { invalidatePredictionLiveCache } from '../strategy/prediction-arb/prediction-live';

const isDashboard = (req: AuthenticatedRequest) => req.path.includes('/auth/');

export async function getPredictionArbSettings(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;

    let settings = await PredictionArbSettings.findOne({ userId: userObjId });
    if (!settings) {
      settings = await PredictionArbSettings.create({ userId: userObjId });
    }

    if (isDashboard(req)) return res.json(settings);
    return res.json({ success: true, message: 'ok', data: settings });
  } catch (e: any) {
    console.error('❌ [GET PredictionArbSettings] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function updatePredictionArbSettings(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const userObjId = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
    const body = { ...req.body };
    delete body._id;
    delete body.userId;

    const settings = await PredictionArbSettings.findOneAndUpdate(
      { userId: userObjId },
      { $set: body },
      { new: true, upsert: true }
    );

    // Se o modo live foi alterado, invalida o cache usado pelo robô/controllers
    if (body.allowLiveTrading !== undefined) invalidatePredictionLiveCache();

    if (isDashboard(req)) return res.json(settings);
    return res.json({ success: true, message: 'Configurações salvas com sucesso.', data: settings });
  } catch (e: any) {
    console.error('❌ [POST PredictionArbSettings] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}

export async function getPredictionBotStatus(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(isDashboard(req) ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });

    const settings = await PredictionArbSettings.findOne({ userId }).lean()
      || await PredictionArbSettings.findOne().lean();
    const isScanningEnabled = settings ? (settings as any).isScanningEnabled === true : false;
    const allowLiveTrading = settings ? (settings as any).allowLiveTrading === true : false;

    const botStatusDoc = await (BotStatus as any).findOne({ botName: 'prediction-arb' }).lean()
      || await (BotStatus as any).findOne({ userId: String(userId), botName: 'prediction-arb' }).lean();

    let isOnline = false;
    if (botStatusDoc?.lastHeartbeat) {
      isOnline = Date.now() - new Date(botStatusDoc.lastHeartbeat).getTime() < 3 * 60 * 1000;
    }

    const data = { isScanningEnabled, allowLiveTrading, isOnline, lastHeartbeat: botStatusDoc?.lastHeartbeat || null, botName: 'prediction-arb' };
    if (isDashboard(req)) return res.json(data);
    return res.json({ success: true, message: 'ok', data });
  } catch (e: any) {
    console.error('❌ [GET PredictionBotStatus] Error:', e.message);
    return res.status(500).json(isDashboard(req) ? { error: e.message } : { success: false, message: e.message });
  }
}
