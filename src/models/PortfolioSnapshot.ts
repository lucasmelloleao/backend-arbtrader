import mongoose from 'mongoose';

const AssetBalanceSchema = new mongoose.Schema({
    asset: {
        type: String,
        required: true
    },
    free: {
        type: Number,
        required: true,
        default: 0
    },
    used: {
        type: Number,
        required: true,
        default: 0
    },
    total: {
        type: Number,
        required: true,
        default: 0
    },
    usdValue: {
        type: Number,
        required: true,
        default: 0
    },
    avgCostPrice: {
        type: Number,
        default: null
    },
    investedValue: {
        type: Number,
        default: 0
    },
    totalQty: {
        type: Number,
        default: 0
    },
    pnl: {
        type: Number,
        default: 0
    },
    pnlPct: {
        type: Number,
        default: null
    }
}, { _id: false });

const FuturesPositionSchema = new mongoose.Schema({
    symbol: {
        type: String,
        required: true
    },
    side: {
        type: String,
        required: true
    },
    contracts: {
        type: Number,
        required: true,
        default: 0
    },
    contractSize: {
        type: Number,
        default: 1
    },
    notional: {
        type: Number,
        required: true,
        default: 0
    },
    entryPrice: {
        type: Number,
        default: null
    },
    markPrice: {
        type: Number,
        default: null
    },
    liquidationPrice: {
        type: Number,
        default: null
    },
    leverage: {
        type: Number,
        default: 1
    },
    unrealizedPnl: {
        type: Number,
        required: true,
        default: 0
    },
    unrealizedPnlPct: {
        type: Number,
        default: 0
    },
    margin: {
        type: Number,
        default: 0
    },
    strategyName: {
        type: String,
        default: null
    }
}, { _id: false });

const PortfolioSnapshotSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    exchange: {
        type: String,
        required: true
    },
    totalUsdValue: {
        type: Number,
        required: true,
        default: 0
    },
    balances: [AssetBalanceSchema],
    positions: [FuturesPositionSchema],
    spotTotalUsd: {
        type: Number,
        default: 0
    },
    futuresTotalUsd: {
        type: Number,
        default: 0
    },
    futuresUnrealizedPnl: {
        type: Number,
        default: 0
    },
    timestamp: {
        type: Date,
        default: Date.now,
        index: true
    }
}, { timestamps: true });

PortfolioSnapshotSchema.index({ userId: 1, exchange: 1, timestamp: -1 });

export default mongoose.models.PortfolioSnapshot || mongoose.model('PortfolioSnapshot', PortfolioSnapshotSchema);
