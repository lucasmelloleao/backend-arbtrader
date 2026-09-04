import mongoose from 'mongoose';

const ForexArbSettingsSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  isScanningEnabled: { type: Boolean, default: false },
  lastScannedAt: { type: Date, default: null },
  tradeSize: { type: Number, default: 100 },
  minProfitPct: { type: Number, default: 0.05 }, // retorno líquido mínimo (%) para executar a arbitragem
  minVolume24hUSD: { type: Number, default: 50000 },
  maxStrategiesPerScan: { type: Number, default: 5 },
  scanIntervalMs: { type: Number, default: 60000 },
  maxDailyLoss: { type: Number, default: 10 },
  maxSlippagePct: { type: Number, default: 0.1 },
  autoExecute: { type: Boolean, default: true },
  simpleEnabled: { type: Boolean, default: true },
  triangularEnabled: { type: Boolean, default: true },
  takeProfitPct: { type: Number, default: 0.10 },
  stopLossPct: { type: Number, default: 0.10 },
  trailingStopPct: { type: Number, default: 0.01 },
}, { timestamps: true });

export default mongoose.models.ForexArbSettings || mongoose.model('ForexArbSettings', ForexArbSettingsSchema);
