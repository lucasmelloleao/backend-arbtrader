import mongoose from 'mongoose';

const ForexLegSchema = new mongoose.Schema({
  symbol: { type: String, required: true },
  side: { type: String, required: true },   // 'buy' | 'sell'
  price: { type: Number, default: null },
  amount: { type: Number, default: null },
  orderId: { type: String, default: null },
}, { _id: false });

const ForexArbTradeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  strategyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ForexArbStrategy', index: true },
  strategyName: { type: String },
  exchangeId: { type: String },
  type: { type: String, required: true },  // 'opportunity_found' | 'execution' | 'close' | 'error'
  legs: { type: [ForexLegSchema], default: [] },
  amount: { type: Number },
  expectedProfitPct: { type: Number },
  realizedPnl: { type: Number, default: 0 },
  commission: { type: Number, default: 0 },
  swap: { type: Number, default: 0 },
  status: { type: String, default: 'detected' }, // 'detected' | 'executed' | 'simulated' | 'failed' | 'skipped'
  reason: { type: String },
  errorMessage: { type: String },
  createdAt: { type: Date, default: Date.now, index: true },
});

ForexArbTradeSchema.index({ strategyId: 1, createdAt: -1 });

export default mongoose.models.ForexArbTrade || mongoose.model('ForexArbTrade', ForexArbTradeSchema);
