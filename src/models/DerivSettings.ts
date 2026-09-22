import mongoose from 'mongoose';

const DerivSettingsSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  appId: { type: String, default: '34kQP2mEzJFjAJ2q1atub' }, // App ID oficial ou personalizado da Deriv
  accountType: { type: String, enum: ['demo', 'real'], default: 'demo' }, // 'demo' ou 'real'
  demoApiToken: { type: String, default: '' }, // Token de API da Conta Demo (DOT... / VRTC...)
  realApiToken: { type: String, default: '' }, // Token de API da Conta Real (ROT... / CR...)
  apiToken: { type: String, default: '' },   // Token padrão / legado
  isScanningEnabled: { type: Boolean, default: false },
  allowLiveTrading: { type: Boolean, default: false },
  tradeSize: { type: Number, default: 10 },  // Aporte por contrato (USD 10)
  maxOpenContracts: { type: Number, default: 1 }, // Apenas 1 operação por vez
  maxDailyLoss: { type: Number, default: 20 },
  minHighCertaintyProb: { type: Number, default: 0.80 },
  emergencyStopPct: { type: Number, default: 50 }, // Vender se prejuízo atingir 50%
  minTakeProfitPct: { type: Number, default: 10.0 }, // Sair antecipadamente se lucro >= 10%
  minPayoutPct: { type: Number, default: 35.0 }, // Payout líquido mínimo exigido para compra (ex: 35%)
  allowedSymbols: { type: [String], default: ['R_100', 'R_50', 'frxBTCUSD', 'frxETHUSD'] },
  contractDurationSec: { type: Number, default: 15 }, // Duração do contrato em segundos (15s)
  demoBalance: { type: mongoose.Schema.Types.Mixed, default: null },
  realBalance: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });


export default mongoose.models.DerivSettings || mongoose.model('DerivSettings', DerivSettingsSchema);
