import mongoose from 'mongoose';

const DerivTradeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  contractId: { type: String, required: true },
  symbol: { type: String, required: true },
  strategyName: { type: String, default: '' },
  question: { type: String },
  contractType: { type: String, required: true }, // RISE, FALL, HIGHER, LOWER
  status: { type: String, enum: ['open', 'executed', 'cancelled', 'simulated'], default: 'open' },
  buyPrice: { type: Number, required: true },
  sellPrice: { type: Number, default: 0 },
  pnl: { type: Number, default: 0 },
  investedUsd: { type: Number, required: true },
  realizedUsd: { type: Number, default: 0 },
  reason: { type: String, default: '' },
  openedAt: { type: Date, default: Date.now },
  closedAt: { type: Date, default: null },
}, { timestamps: true });

DerivTradeSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.models.DerivTrade || mongoose.model('DerivTrade', DerivTradeSchema);
