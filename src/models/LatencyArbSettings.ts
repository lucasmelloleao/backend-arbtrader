import mongoose from 'mongoose';

const LatencyArbSettingsSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  isScanningEnabled: { type: Boolean, default: false },
  lastScannedAt: { type: Date, default: null },
  tradeSize: { type: Number, default: 100 },
  minTriggerPips: { type: Number, default: 1.5 }, // Mínimo de deslocamento em Pips no broker rápido (cTrader)
  maxLagMs: { type: Number, default: 500 }, // Máximo de latência (ms) aceitável da MEXC
  minProfitUsd: { type: Number, default: 0.10 }, // Lucro mínimo projetado em USDT
  maxDailyLoss: { type: Number, default: 10 },
  autoExecute: { type: Boolean, default: true },
  takeProfitPct: { type: Number, default: 0.15 },
  stopLossPct: { type: Number, default: 0.10 },
  trailingStopPct: { type: Number, default: 0.02 },
  allowedSymbols: { type: [String], default: ['EUR/USD', 'GBP/USD', 'USD/JPY'] }
}, { timestamps: true });

export default mongoose.models.LatencyArbSettings || mongoose.model('LatencyArbSettings', LatencyArbSettingsSchema);
