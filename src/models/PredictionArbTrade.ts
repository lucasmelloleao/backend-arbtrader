import mongoose from 'mongoose';

const PredictionArbTradeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  strategyId: { type: mongoose.Schema.Types.ObjectId, ref: 'PredictionArbStrategy', index: true },
  openTradeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PredictionArbTrade', index: true },
  marketId: { type: String },
  slug: { type: String },
  question: { type: String },
  type: {
    type: String,
    enum: ['open_pair', 'close_pair', 'trade', 'fee', 'rebalance', 'voided', 'mm_quote'],
    required: true,
  },
  status: {
    type: String,
    enum: ['detected', 'executed', 'simulated', 'failed', 'voided', 'open'],
    default: 'detected',
  },
  side: { type: String, enum: ['YES', 'NO'], default: null },
  yesPrice: { type: Number },
  noPrice: { type: Number },
  yesExitPrice: { type: Number },
  noExitPrice: { type: Number },
  amount: { type: Number },
  yesShares: { type: Number },
  noShares: { type: Number },
  pnl: { type: Number, default: 0 },
  investedUsd: { type: Number, default: 0 },
  realizedUsd: { type: Number, default: 0 },
  spreadPct: { type: Number },
  reason: { type: String },
  errorMessage: { type: String },
  orderIds: { type: [String], default: [] },
  openedAt: { type: Date },
  createdAt: { type: Date, default: Date.now, index: true },
});

PredictionArbTradeSchema.index({ strategyId: 1, createdAt: -1 });

export default mongoose.models.PredictionArbTrade || mongoose.model('PredictionArbTrade', PredictionArbTradeSchema);
