import mongoose from 'mongoose';

const LatencyArbTradeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  strategyName: { type: String, default: 'Latency Arb cTrader -> MEXC' },
  symbol: { type: String, required: true },
  fastBroker: { type: String, default: 'Pepperstone (cTrader)' },
  slowBroker: { type: String, default: 'MEXC Crypto Spot' },
  side: { type: String, enum: ['BUY', 'SELL'], required: true },
  fastPrice: { type: Number, required: true }, // Preço do broker líder na hora do disparo
  slowPrice: { type: Number, required: true }, // Preço do broker lento
  exitPrice: { type: Number, default: null }, // Preço de saída no broker lento
  lagMs: { type: Number, required: true }, // Latência calculada (ms)
  displacementPips: { type: Number, required: true }, // Deslocamento em Pips
  amount: { type: Number, required: true },
  status: { type: String, default: 'detected' }, // detected, processing, executed, failed, closed, voided
  pnl: { type: Number, default: 0 },
  netPnl: { type: Number, default: 0 },
  tradingFees: { type: Number, default: 0 },
  reason: { type: String },
  closedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, index: true },
});

LatencyArbTradeSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.models.LatencyArbTrade || mongoose.model('LatencyArbTrade', LatencyArbTradeSchema);
