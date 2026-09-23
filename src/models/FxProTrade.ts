import mongoose from 'mongoose';

export interface IFxProTrade extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  strategyId?: mongoose.Types.ObjectId;
  exchangeKeyId?: mongoose.Types.ObjectId;
  positionId: string;
  orderId?: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  lotSize: number;
  entryPrice: number;
  exitPrice?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  pnlUsd: number;
  pips: number;
  commissionUsd: number;
  swapUsd: number;
  status: 'open' | 'closed' | 'cancelled' | 'rejected';
  closeReason?: 'tp' | 'sl' | 'trailing' | 'manual' | 'ai_veto' | 'emergency';
  metrics: {
    er: number;
    varianceRatio: number;
    atrPct: number;
    spreadPips: number;
    expectedValue: number;
    edgePct: number;
    aiProbWin?: number;
  };
  openedAt: Date;
  closedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const FxProTradeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    strategyId: { type: mongoose.Schema.Types.ObjectId, ref: 'FxProStrategy', required: false, index: true },
    exchangeKeyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExchangeKey' },
    positionId: { type: String, required: true, index: true },
    orderId: { type: String },
    symbol: { type: String, required: true, uppercase: true },
    side: { type: String, enum: ['BUY', 'SELL'], required: true },
    lotSize: { type: Number, required: true },
    entryPrice: { type: Number, required: true },
    exitPrice: { type: Number },
    stopLossPrice: { type: Number },
    takeProfitPrice: { type: Number },
    pnlUsd: { type: Number, default: 0 },
    pips: { type: Number, default: 0 },
    commissionUsd: { type: Number, default: 0 },
    swapUsd: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['open', 'closed', 'cancelled', 'rejected'],
      default: 'open',
      index: true,
    },
    closeReason: {
      type: String,
      enum: ['tp', 'sl', 'trailing', 'manual', 'ai_veto', 'emergency'],
    },
    metrics: {
      er: { type: Number, default: 0 },
      varianceRatio: { type: Number, default: 1.0 },
      atrPct: { type: Number, default: 0 },
      spreadPips: { type: Number, default: 0 },
      expectedValue: { type: Number, default: 0 },
      edgePct: { type: Number, default: 0 },
      aiProbWin: { type: Number, default: 0.5 },
    },
    openedAt: { type: Date, default: Date.now },
    closedAt: { type: Date },
  },
  { timestamps: true }
);

FxProTradeSchema.index({ strategyId: 1, closedAt: -1 });
FxProTradeSchema.index({ userId: 1, symbol: 1, status: 1 });

export default mongoose.models.FxProTrade || mongoose.model<IFxProTrade>('FxProTrade', FxProTradeSchema);
