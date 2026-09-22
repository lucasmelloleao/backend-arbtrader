import mongoose from 'mongoose';

const DerivStrategySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, default: '' },
  symbol: { type: String, required: true }, // ex: 1HZ10V, R_100, frxBTCUSD
  contractType: { 
    type: String, 
    enum: ['BOTH_HL', 'HIGHER', 'LOWER', 'BOTH_RF', 'RISE', 'FALL', 'BOTH_MULT', 'MULTUP', 'MULTDOWN'], 
    default: 'BOTH_HL' 
  },
  barrier: { type: String, default: '-1' }, // Offset da barreira (ex: -1, +1, -0.57)
  barrierLower: { type: String, default: '+1' }, // Offset caso opere ambos Higher/Lower
  tradeSize: { type: Number, default: 2 }, // Aporte em USD
  durationSec: { type: Number, default: 15 }, // Duração em segundos
  minCertaintyProb: { type: Number, default: 0.75 }, // Certeza mínima exigida (0.70 a 0.98)
  active: { type: Boolean, default: true },
  contractId: { type: String, default: null },
  positionOpen: { type: Boolean, default: false },
  buyPrice: { type: Number, default: 0 },
  currentPrice: { type: Number, default: 0 },
  pnl: { type: Number, default: 0 },
  lastCheckAt: { type: Date, default: Date.now },
  lastTradeAt: { type: Date, default: null },
}, { timestamps: true });

DerivStrategySchema.index({ userId: 1, symbol: 1 });

export default mongoose.models.DerivStrategy || mongoose.model('DerivStrategy', DerivStrategySchema);
