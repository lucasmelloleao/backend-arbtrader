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
  tradeSize: { type: Number, default: 5 },  // Aporte por contrato (USD)
  maxOpenContracts: { type: Number, default: 3 },
  maxDailyLoss: { type: Number, default: 10 },
  minHighCertaintyProb: { type: Number, default: 0.95 },
  emergencyStopPct: { type: Number, default: 20 }, // Vender se prejuízo atingir 20%
  minTakeProfitPct: { type: Number, default: 2.0 }, // Sair antecipadamente se lucro >= 2%
  allowedSymbols: { type: [String], default: ['frxBTCUSD', 'frxETHUSD', 'R_100', 'R_50'] },
  contractDurationSec: { type: Number, default: 300 }, // Duração do contrato em segundos (5 min)
}, { timestamps: true });

export default mongoose.models.DerivSettings || mongoose.model('DerivSettings', DerivSettingsSchema);
