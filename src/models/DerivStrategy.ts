import mongoose from 'mongoose';

const DerivStrategySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  symbol: { type: String, required: true },
  contractType: { type: String, enum: ['RISE', 'FALL', 'HIGHER', 'LOWER'], required: true },
  active: { type: Boolean, default: true },
  contractId: { type: String, default: null },
  positionOpen: { type: Boolean, default: false },
  buyPrice: { type: Number, default: 0 },
  currentPrice: { type: Number, default: 0 },
  pnl: { type: Number, default: 0 },
  lastCheckAt: { type: Date, default: Date.now },
}, { timestamps: true });

DerivStrategySchema.index({ userId: 1, symbol: 1 });

export default mongoose.models.DerivStrategy || mongoose.model('DerivStrategy', DerivStrategySchema);
