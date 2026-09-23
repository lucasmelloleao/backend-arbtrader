import mongoose from 'mongoose';

export interface IFxProStrategy extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  exchangeKeyId?: mongoose.Types.ObjectId;
  name: string;
  symbol: string; // Ex: EURUSD, GBPUSD, USDJPY, XAUUSD, BTCUSD
  active: boolean;
  status: 'running' | 'stopped' | 'error' | 'paused';
  timeframe: string; // Ex: 1m, 5m, 15m
  lotSize: number; // Ex: 0.01, 0.1, 1.0
  leverage: number; // Ex: 500, 1000, 10000
  takeProfitPips: number; // Ex: 20
  stopLossPips: number; // Ex: 15
  trailingStopPips: number; // Ex: 10
  trailingStepPips: number; // Ex: 5
  maxOpenPositions: number; // Ex: 1
  minVarianceRatio: number; // Ex: 1.08 (Filtro Random Walk)
  minEfficiencyRatio: number; // Ex: 0.35 (Kaufman ER)
  maxSpreadPips: number; // Ex: 2.5
  useAiMetaLabeling: boolean; // Gate 4 (IA Random Forest)
  minAiConfidence: number; // Ex: 0.55 (55%)
  currentPositionId?: string;
  currentSide?: 'BUY' | 'SELL';
  entryPrice?: number;
  currentPnlUsd?: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalProfitUsd: number;
  lastTradeAt?: Date;
  lastSignalAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const FxProStrategySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    exchangeKeyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExchangeKey' },
    name: { type: String, required: true },
    symbol: { type: String, required: true, uppercase: true },
    active: { type: Boolean, default: true, index: true },
    status: {
      type: String,
      enum: ['running', 'stopped', 'error', 'paused'],
      default: 'running',
    },
    timeframe: { type: String, default: '1m' },
    lotSize: { type: Number, default: 0.01, min: 0.01 },
    leverage: { type: Number, default: 1000 },
    takeProfitPips: { type: Number, default: 20 },
    stopLossPips: { type: Number, default: 15 },
    trailingStopPips: { type: Number, default: 10 },
    trailingStepPips: { type: Number, default: 5 },
    maxOpenPositions: { type: Number, default: 1 },
    minVarianceRatio: { type: Number, default: 1.08 },
    minEfficiencyRatio: { type: Number, default: 0.35 },
    maxSpreadPips: { type: Number, default: 2.5 },
    useAiMetaLabeling: { type: Boolean, default: true },
    minAiConfidence: { type: Number, default: 0.55 },
    currentPositionId: { type: String },
    currentSide: { type: String, enum: ['BUY', 'SELL', null], default: null },
    entryPrice: { type: Number, default: 0 },
    currentPnlUsd: { type: Number, default: 0 },
    totalTrades: { type: Number, default: 0 },
    winningTrades: { type: Number, default: 0 },
    losingTrades: { type: Number, default: 0 },
    totalProfitUsd: { type: Number, default: 0 },
    lastTradeAt: { type: Date },
    lastSignalAt: { type: Date },
    lastError: { type: String },
  },
  { timestamps: true }
);

FxProStrategySchema.index({ userId: 1, symbol: 1 });

export default mongoose.models.FxProStrategy || mongoose.model<IFxProStrategy>('FxProStrategy', FxProStrategySchema);
