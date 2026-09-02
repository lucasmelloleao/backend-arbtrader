import mongoose from 'mongoose';

const PredictionArbSettingsSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  isScanningEnabled: { type: Boolean, default: false },
  // Permite ordens REAIS na Polymarket (botão "Iniciar Colheita" no frontend).
  // false = dry-run (apenas simula). Armazenado no banco, não no .env.
  allowLiveTrading: { type: Boolean, default: false },
  lastScannedAt: { type: Date, default: null },
  // Capital por lado (perna) — $ por mercado
  tradeSize: { type: Number, default: 100 },
  // Spread mínimo (soma < 1) para entrar, em %
  minSpreadPct: { type: Number, default: 0.3 },
  // Volume mínimo 24h (USD) para o scanner considerar um mercado — piso para
  // filtrar mercados mortos/finos (as maiores perdas vieram de book fino).
  minVolume24hUSD: { type: Number, default: 5000 },
  maxStrategiesPerScan: { type: Number, default: 5 },
  maxPortfolioCapUSD: { type: Number, default: 1000 },
  // Máximo de pares (posições reais) simultâneos — controla quantas posições
  // o robô pode abrir ao mesmo tempo na Polymarket.
  maxOpenPairs: { type: Number, default: 3 },
  maxDailyLoss: { type: Number, default: 10 },
  // Só ordens passivas (maker) — evita taker fee
  makerOnly: { type: Boolean, default: true },
  makerRebatePct: { type: Number, default: 0 },
  maxSlippagePct: { type: Number, default: 0.1 },
  // Fecha o par quando a soma dos preços >= 1
  closeWhenComplete: { type: Boolean, default: true },
  targetProfitPct: { type: Number, default: 1.0 },
  // Slugs opcionais para restringir o scan
  allowedMarkets: { type: [String], default: [] },
  // Filtro por termo no slug (ex: 'btc') — monitora só mercados que contêm o termo
  marketFilter: { type: String, default: '' },
  // Moedas voláteis para monitorar mercados updown (ex: ['btc','eth','sol','doge','xrp'])
  marketCoins: { type: [String], default: [] },
  scanIntervalMs: { type: Number, default: 60000 },
}, { timestamps: true });

export default mongoose.models.PredictionArbSettings || mongoose.model('PredictionArbSettings', PredictionArbSettingsSchema);
