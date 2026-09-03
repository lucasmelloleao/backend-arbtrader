import mongoose from 'mongoose';

const ExchangeKeySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  exchangeId: { type: String, required: true },
  name: { type: String, required: true },
  apiKey: { type: String, required: true },
  apiSecret: { type: String, required: true },
  active: { type: Boolean, default: true },
  spotUsdt: { type: Number, default: 0 },
  spotUsdc: { type: Number, default: 0 },
  spotTotalEquity: { type: Number, default: 0 },
  futuresUsdt: { type: Number, default: 0 },
  futuresUsdc: { type: Number, default: 0 },
  futuresTotalEquity: { type: Number, default: 0 },
  balancesUpdatedAt: { type: Date },
  // ─── cTrader Open API (Pepperstone) ─────────────────────────────────────────
  clientId: { type: String },
  clientSecret: { type: String },   // criptografado
  accessToken: { type: String },    // criptografado
  refreshToken: { type: String },   // criptografado
  accountId: { type: String },
  environment: { type: String, enum: ['live', 'demo'], default: 'live' },
  ctraderTokenUpdatedAt: { type: Date },
  // ─── FIX API (Pepperstone/cTrader) ──────────────────────────────────────────
  host: { type: String },           // ex: live-us-eqx-01.p.c-trader.com
  quotePort: { type: Number },      // 5211
  tradePort: { type: Number },      // 5212
  senderCompId: { type: String },   // ex: live.pepperstone.1382148
  targetCompId: { type: String, default: 'CSERVER' },
  username: { type: String },       // login numérico da conta
  password: { type: String },       // criptografado
  heartBtInt: { type: Number, default: 30 },
  // ─── Dukascopy (JForex SDK via ponte Java) ──────────────────────────────────
  jnlpUrl: { type: String },        // ex: http://platform.dukascopy.com/demo_3/jforex_3.jnlp
  // ─── Hyperliquid (DEX perpétuos) ────────────────────────────────────────────
  // apiKey = endereço público (0x...), apiSecret = private key criptografada
  // ─── Polymarket (prediction markets) ────────────────────────────────────────
  // apiKey = endereço da wallet EOA (0x...), apiSecret = private key criptografada
  // Credenciais adicionais para trading automatizado:
  relayerApiKey: { type: String },          // Relayer API key (UUID) — deploy wallet + transações gasless
  relayerApiKeyAddress: { type: String },   // Signer address da relayer key
  relayerBaseUrl: { type: String },         // Base URL do relayer proxy (Vercel/self-hosted)
  depositWallet: { type: String },          // Endereço da deposit wallet (proxy) — onde ficam pUSD/tokens
  clobApiKey: { type: String },             // Credencial L2 do CLOB (criada via derive)
  clobSecret: { type: String },             // Credencial L2 do CLOB (criptografada)
  clobPassphrase: { type: String },         // Credencial L2 do CLOB (criptografada)
  pusdBalance: { type: Number, default: 0 },// Saldo pUSD disponível (synced)
  lastSyncAt: { type: Date },               // Última sync de saldo/allowances
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.models.ExchangeKey || mongoose.model('ExchangeKey', ExchangeKeySchema);
