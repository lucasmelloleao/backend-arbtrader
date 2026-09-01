import mongoose from 'mongoose';

const PerpArbSettingsSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  isScanningEnabled: { type: Boolean, default: false },
  lastScannedAt: { type: Date, default: null },
  tradeSize: { type: Number, default: 100 },
  minFundingRatePct: { type: Number, default: 0.002 },
  minVolume24hUSD: { type: Number, default: 50000 },
  maxStrategiesPerScan: { type: Number, default: 5 },
  maxPerpScan: { type: Number, default: 50 },
  scanIntervalMs: { type: Number, default: 120000 },
  targetSpotBuyUSD: { type: Number, default: 1000 },
  maxDailyLoss: { type: Number, default: 10 },
  maxPortfolioCapUSD: { type: Number, default: 500 }, // Limite máximo de exposição da carteira (USD)
  maxSlippagePct: { type: Number, default: 0.1 },
  minEntrySpreadPct: { type: Number, default: 0.0 },
  // ─── Fechamento (saída) ────────────────────────────────────────────────
  // closeWhileFundingPositive=false → NÃO fecha por spread enquanto o funding
  // ainda está positivo (continua colhendo). Só fecha por spread se a
  // deformação for SOCIAL (spreadCloseForcePct), protegendo o hedge.
  closeWhileFundingPositive: { type: Boolean, default: false },
  spreadCloseThresholdPct: { type: Number, default: 0.3 }, // base (usada quando funding <= 0 ou allow)
  spreadCloseForcePct: { type: Number, default: 0.3 },     // severa, vale mesmo com funding positivo
  // ─── Take-Profit Líquido Global (Retorno em %) ─────────────────────
  targetProfitPct: { type: Number, default: 0.7 },          // Take-Profit Global: ativa Trailing se retorno líquido >= 0.7%
  profitTrailingDropPct: { type: Number, default: 10 },      // Recuo de 10% do topo de retorno líquido ativado (preserva 90% do lucro)
  allowedExchanges: { type: [String], default: [] }
}, { timestamps: true });

export default mongoose.models.PerpArbSettings || mongoose.model('PerpArbSettings', PerpArbSettingsSchema);
