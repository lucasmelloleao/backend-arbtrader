import mongoose from 'mongoose';

const PredictionArbStrategySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  exchangeKeyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExchangeKey' },
  marketId: { type: String, required: true },
  slug: { type: String, required: true },
  question: { type: String },
  // Identificadores CLOB
  conditionId: { type: String },
  tokenIdYes: { type: String },
  tokenIdNo: { type: String },
  // Preços e spread
  yesPrice: { type: Number, default: 0 },
  noPrice: { type: Number, default: 0 },
  spreadPct: { type: Number, default: 0 },
  endDate: { type: Date, default: null },
  // Configuração
  tradeSize: { type: Number, default: 100 },
  active: { type: Boolean, default: true },
  autoExecute: { type: Boolean, default: false },
  isAutoCreated: { type: Boolean, default: false },
  // Posição real (CLOB)
  positionOpen: { type: Boolean, default: false },
  positionSize: { type: Number, default: 0 },
  yesShares: { type: Number, default: 0 },
  noShares: { type: Number, default: 0 },
  avgYesPrice: { type: Number, default: 0 },
  avgNoPrice: { type: Number, default: 0 },
  // Market making com inventário
  mmActive: { type: Boolean, default: false },
  openOrderIds: { type: [String], default: [] },
  maxInventoryPairs: { type: Number, default: 10 },
  quoteStep: { type: Number, default: 0.005 },
  // Controle de risco
  maxDailyLoss: { type: Number, default: 10 },
  dailyLossAccum: { type: Number, default: 0 },
  lastLossAt: { type: Date, default: null },
  cooldownAfterLossMs: { type: Number, default: 3600000 },
  targetProfitPct: { type: Number, default: 1.0 },
  peakProfitPct: { type: Number, default: 0 },
  lastCheckAt: { type: Date, default: null },
  errorMessage: { type: String },
}, { timestamps: true });

PredictionArbStrategySchema.index({ userId: 1, marketId: 1 }, { unique: true });
PredictionArbStrategySchema.index({ userId: 1, active: 1 });

export default mongoose.models.PredictionArbStrategy || mongoose.model('PredictionArbStrategy', PredictionArbStrategySchema);
