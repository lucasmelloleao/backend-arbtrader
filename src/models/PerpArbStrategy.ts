import mongoose from 'mongoose';

const PerpArbStrategySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  exchangeKeyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExchangeKey' },
  perpExchangeKeyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExchangeKey' },
  spotExchangeKeyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExchangeKey' },
  name: { type: String, required: true },
  perpSymbol: { type: String, required: true }, // e.g. 'BTC/USDT:USDT' or 'BTC/USDT' depending on exchange
  spotSymbol: { type: String, required: true }, // e.g. 'BTC/USDT'
  exchangeId: { type: String, default: null }, // corretora onde opera (mexc, gateio, binance...)
  settingsId: { type: mongoose.Schema.Types.ObjectId, ref: 'PerpArbSettings', default: null }, // PerpArbSettings vinculado
  tradeSize: { type: Number, required: true }, // amount in quote currency (USDT)
  minFundingRatePct: { type: Number, default: 0.001 }, // minimum funding rate (in percent) to consider
  maxSlippagePct: { type: Number, default: 0.5 }, // max allowed spread between perp and spot price
  autoExecute: { type: Boolean, default: false },
  isAutoCreated: { type: Boolean, default: false },
  active: { type: Boolean, default: true },

  // ─── Risk management ─────────────────────────────────────────────────────
  maxDailyLoss: { type: Number, default: 0 }, // max daily loss in USDT before auto-disable
  dailyLossAccum: { type: Number, default: 0 }, // accumulated daily loss
  lastLossAt: { type: Date, default: null }, // timestamp of last loss
  cooldownAfterLossMs: { type: Number, default: 3600000 }, // 1h cooldown after a loss

  // ─── Position tracking ───────────────────────────────────────────────────
  currentFundingRate: { type: Number, default: null }, // last known funding rate (percent)
  lastSpotPrice: { type: Number, default: null }, // latest observed spot market price
  lastSpotBid: { type: Number, default: null }, // latest spot best bid (venda)
  lastSpotAsk: { type: Number, default: null }, // latest spot best ask (compra)
  lastPerpPrice: { type: Number, default: null }, // latest observed perp market price
  lastPerpBid: { type: Number, default: null }, // latest perp best bid (venda)
  lastPerpAsk: { type: Number, default: null }, // latest perp best ask (compra)
  positionOpen: { type: Boolean, default: false }, // whether a hedge position is currently open
  positionOpenedAt: { type: Date, default: null },
  positionSize: { type: Number, default: 0 }, // current hedge size in USDT
  fundingCollected: { type: Number, default: 0 }, // cumulative funding collected
  fundingCount: { type: Number, default: 0 }, // number of funding payments collected
  peakProfitPct: { type: Number, default: 0 }, // pico máximo de retorno líquido (trailing stop)
  fundingHistory: [{
    amount: { type: Number },
    timestamp: { type: Date },
    fundingRate: { type: Number }
  }],

  // ─── Auto-close configuration ───────────────────────────────────────────
  autoClose: { type: Boolean, default: true }, // auto-close position when target reached
  fundingTargetPct: { type: Number, default: 0.05 }, // close when funding collected >= this % of position size
  maxHoldHours: { type: Number, default: 24 }, // max hours to hold position before forced close
  closeThresholdPct: { type: Number, default: 0.01 }, // min profit % to close position

  // ─── Multi-exchange support ─────────────────────────────────────────────
  exchanges: [{
    exchangeId: { type: String, required: true }, // e.g. 'gateio', 'binance', 'bybit'
    apiKey: { type: String, required: true },
    apiSecret: { type: String, required: true },
    name: { type: String, required: true },
    isDefault: { type: Boolean, default: false },
  }],
}, { timestamps: true, collection: 'perparbstrategies' });

// Validation: ensure at least one exchange key reference exists
PerpArbStrategySchema.pre('validate', function (this: any, next: any) {
  if (!this.perpExchangeKeyId && !this.exchangeKeyId) {
    next(new Error('Strategy must have perpExchangeKeyId or exchangeKeyId'));
  } else {
    next();
  }
});

export default mongoose.models.PerpArbStrategy || mongoose.model('PerpArbStrategy', PerpArbStrategySchema);
