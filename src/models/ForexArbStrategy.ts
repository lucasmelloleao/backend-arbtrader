import mongoose from 'mongoose';

const ForexLegSchema = new mongoose.Schema({
  symbol: { type: String, required: true }, // ex: 'EUR/USD' ou 'BTC/USDT'
  side: { type: String, required: true },   // 'buy' | 'sell'
  price: { type: Number, default: null },   // preço de execução
  amount: { type: Number, default: null },  // quantidade na moeda base
  orderId: { type: String, default: null },
}, { _id: false });

const ForexArbStrategySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  exchangeKeyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExchangeKey' },
  name: { type: String, required: true },               // ex: 'Forex-EUR/USD/GBP'
  exchangeId: { type: String, default: null },          // corretora onde opera (ctrader, pepperstone, mexc, etc)
  settingsId: { type: mongoose.Schema.Types.ObjectId, ref: 'ForexArbSettings', default: null },
  type: { type: String, default: 'simple' },            // 'simple' | 'triangular'
  legs: { type: [ForexLegSchema], default: [] },        // pernas da arbitragem
  tradeSize: { type: Number, required: true },          // valor em USDT/USD da operação
  expectedProfitPct: { type: Number, default: 0 },      // retorno líquido esperado na abertura
  minProfitPct: { type: Number, default: 0.05 },
  maxSlippagePct: { type: Number, default: 0.1 },
  autoExecute: { type: Boolean, default: true },
  isAutoCreated: { type: Boolean, default: false },
  active: { type: Boolean, default: true },

  // ─── Risk management ─────────────────────────────────────────────────────
  maxDailyLoss: { type: Number, default: 0 },
  dailyLossAccum: { type: Number, default: 0 },
  lastLossAt: { type: Date, default: null },
  cooldownAfterLossMs: { type: Number, default: 3600000 },

  // ─── Position tracking ───────────────────────────────────────────────────
  positionOpen: { type: Boolean, default: false },
  positionOpenedAt: { type: Date, default: null },
  positionSize: { type: Number, default: 0 },
  status: { type: String, default: 'open' },            // 'open' | 'closed' | 'failed'
  pnl: { type: Number, default: 0 },
  closedAt: { type: Date, default: null },
  peakProfitPct: { type: Number, default: 0 },
  lastLegPrices: { type: Map, of: Number, default: {} }, // symbol -> último preço visto
}, { timestamps: true, collection: 'forexarbstrategies' });

export default mongoose.models.ForexArbStrategy || mongoose.model('ForexArbStrategy', ForexArbStrategySchema);
