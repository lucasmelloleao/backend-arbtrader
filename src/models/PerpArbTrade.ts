import mongoose from 'mongoose';

const PerpArbTradeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  strategyId: { type: mongoose.Schema.Types.ObjectId, ref: 'PerpArbStrategy', index: true },
  openTradeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PerpArbTrade', index: true },
  strategyName: { type: String },
  perpSymbol: { type: String },
  spotSymbol: { type: String },
  type: {
    type: String,
    required: true,
  },
  spotOrderId: { type: String },
  perpOrderId: { type: String },
  spotPrice: { type: Number },
  spotExitPrice: { type: Number },
  perpPrice: { type: Number },
  perpExitPrice: { type: Number },
  spotPnl: { type: Number },
  perpPnl: { type: Number },
  fundingCollected: { type: Number },
  fundingRate: { type: Number },
  fundingPct: { type: Number },
  amount: { type: Number },
  spotQuantity: { type: Number },
  perpQuantity: { type: Number },
  status: {
    type: String,
    default: 'open',
  },
  pnl: { type: Number, default: 0 },
  fundingCount: { type: Number, default: 0 },
  fundingHistory: [{
    amount: { type: Number },
    timestamp: { type: Date },
    fundingRate: { type: Number }
  }],
  reason: { type: String },
  openedAt: { type: Date },
  errorMessage: { type: String },
  createdAt: { type: Date, default: Date.now, index: true },
});

PerpArbTradeSchema.index({ strategyId: 1, createdAt: -1 });

export default mongoose.models.PerpArbTrade || mongoose.model('PerpArbTrade', PerpArbTradeSchema);
