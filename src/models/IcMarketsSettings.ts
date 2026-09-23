import mongoose from 'mongoose';

export interface IIcMarketsSettings extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  accountType: 'demo' | 'real';
  accountId: string; // Ex: '10102182'
  isScanningEnabled: boolean; // Liga/Desliga o robô globalmente
  allowLiveTrading: boolean; // Permitir execução real
  maxOpenPositions: number; // Limite global de posições abertas simultâneas (ex: 3)
  maxDailyLoss: number; // Stop loss diário em USD (ex: 50)
  maxDailyProfit: number; // Meta diária de lucro em USD (ex: 100)
  defaultLotSize: number; // Lote padrão global (ex: 0.01)
  defaultLeverage: number; // Alavancagem padrão (ex: 500)
  globalTrailingStop: boolean; // Ativa trailing stop global
  useAiMetaLabeling: boolean; // Gate 4 (IA Meta-Labeling Random Forest)
  minAiConfidence: number; // Limiar de confiança da IA (ex: 0.55 = 55%)
  allowedSymbols: string[]; // Pares autorizados para escanear/operar
  demoBalance?: any;
  realBalance?: any;
  createdAt: Date;
  updatedAt: Date;
}

const IcMarketsSettingsSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    accountType: { type: String, enum: ['demo', 'real'], default: 'demo' },
    accountId: { type: String, default: '10102182' },
    isScanningEnabled: { type: Boolean, default: false },
    allowLiveTrading: { type: Boolean, default: false },
    maxOpenPositions: { type: Number, default: 3 },
    maxDailyLoss: { type: Number, default: 50 },
    maxDailyProfit: { type: Number, default: 100 },
    defaultLotSize: { type: Number, default: 0.01 },
    defaultLeverage: { type: Number, default: 500 },
    globalTrailingStop: { type: Boolean, default: true },
    useAiMetaLabeling: { type: Boolean, default: true },
    minAiConfidence: { type: Number, default: 0.55 },
    allowedSymbols: {
      type: [String],
      default: ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSD'],
    },
    demoBalance: { type: mongoose.Schema.Types.Mixed, default: null },
    realBalance: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

export default mongoose.models.IcMarketsSettings || mongoose.model<IIcMarketsSettings>('IcMarketsSettings', IcMarketsSettingsSchema);
