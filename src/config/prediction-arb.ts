// Configuração centralizada do Prediction Arb Bot
// Todos os thresholds, timeouts, caps e parâmetros de risco em um só lugar.

export const PREDICTION_ARB_CONFIG = {
  // Scan & Discovery
  scan: {
    intervalMs: 60_000,           // Intervalo entre ciclos (1 min)
    minSpreadPct: 0.5,            // Spread mínimo de completude (%)
    minVolume24hUsd: 10_000,      // Volume mínimo 24h (USD)
    maxStrategiesPerScan: 5,      // Máx estratégias criadas por scan
    tradeSize: 100,               // Tamanho do trade por lado (USD)
    maxHorizonMs: 60 * 60 * 1000, // Descarta mercados > 1h para vencer
    minDepthUsdBase: 20,          // Liquidez mínima base por lado (USD)
    depthMultiplier: 4,           // tradeSize * multiplier = minDepthUsd
    minProbability: 0.02,         // Probabilidade mínima (2%) para evitar extremos
  },

  // Risk Management
  risk: {
    maxOpenPairs: 3,              // Máx pares (posições reais) simultâneos
    maxDailyLossUsd: 10,          // Stop diário (USD) - para de ABRIR posições
    maxInventoryPairs: 10,        // Cap de inventário por mercado (lados)
    exposureCapMultiplier: 1.5,   // Teto de exposição = sharesPerQuote * multiplier
    hedgeCompletionThreshold: 0.998, // Não completa hedge se soma média >= 0.998
    minOrderUsd: 1,               // Mínimo por ordem (USD) - regra da Polymarket
    maxOrderInflationMultiplier: 2, // Máx inflar shares para atingir minOrderUsd
  },

  // Market Making
  marketMaking: {
    quoteStep: 0.005,             // Step de progressão do preço (bid → ask)
    orderTimeoutMs: 45_000,       // Timeout para aguardar fills
    minLiquidityUsd: 20,          // Liquidez mínima bid/ask para cotar
    hedgeDebounceMs: 90_000,      // Debounce entre hedges (evita bola de neve)
    takerMargin: 0.002,           // Margem mínima sobre ask para entrada taker (0.2%)
    rebalanceWindowMinutes: 5,    // Só rebalanceia nos últimos 5 min
    singleLegSellWindowMinutes: 15, // Vende perna única se < 15 min p/ vencer
    postOnlyFallback: true,       // Recota no bid se mercado em post-only
  },

  // Exit Conditions
  exit: {
    convergenceThreshold: 1.0,    // Soma YES+NO >= 1 = convergência
    takeProfitPctDefault: 1.0,    // Take-profit padrão (%)
    minRealizableMargin: 0.002,   // Margem mínima sobre custo para fechar (0.2%)
    redeemRetryWindowHours: 1,    // Janela para tentar redeem após vencimento
  },

  // Sync & Monitoring
  sync: {
    historySyncEveryNCycles: 4,   // Sync histórico a cada N ciclos (~2 min)
    heartbeatIntervalMs: 60_000,  // Heartbeat do bot
  },

  // Time Windows (minutes before expiry)
  timeWindows: {
    mmMinMinutesToExpiry: 5,      // MM só abre posição nova entre 5-20 min
    mmMaxMinutesToExpiry: 20,
    hedgeCompletionMaxMinutes: 10, // Completa hedge até 10 min antes
    rebalanceMinutes: 5,          // Rebalance só < 5 min
    singleLegSellMinutes: 15,     // Vende perna única < 15 min
    nearExpiryHoldMinutes: 60,    // Segura par completo < 1h (1h = 60 min)
  },

  // CLOB & Contracts
  clob: {
    baseUrl: process.env.POLYMARKET_CLOB_BASE || 'https://clob.polymarket.com',
    chainId: 137,
    exchangeV2: '0xE111180000d2663C0091e4f400237545B87B996B',
    negRiskExchangeV2: '0xe2222d279d744050d28e00520010520000310F59',
    pusdToken: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
    factoryContract: '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07',
    signatureType: 3, // EIP-1271 (deposit wallet)
    orderType: 'GTC',
    useServerTime: true,
  },

  // RPC Failover
  rpc: {
    primary: process.env.POLYGON_RPC_PRIMARY || 'https://polygon-rpc.com',
    secondary: process.env.POLYGON_RPC_SECONDARY || 'https://rpc.ankr.com/polygon',
    tertiary: process.env.POLYGON_RPC_TERTIARY || 'https://polygon.llamarpc.com',
    publicEndpoints: [
      'https://polygon-bor-rpc.publicnode.com',
      'https://alchemy.com/v2/demo',
      'https://polygon-rpc.com',
      'https://rpc.ankr.com/polygon',
      'https://polygon.llamarpc.com',
      'https://quicknode.com/v2/demo',
    ],
    timeoutMs: 15_000,
  },

  // Relayer
  relayer: {
    baseUrl: process.env.POLYMARKET_RELAYER_BASE,
    timeoutMs: 30_000,
  },

  // Data API
  dataApi: {
    baseUrl: 'https://data-api.polymarket.com',
    positionsLimit: 100,
    activityLimit: 500,
    timeoutMs: 15_000,
  },

  // Telegram
  telegram: {
    enabled: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },

  // Redis Control Channel
  redis: {
    url: process.env.REDIS_URL,
    controlChannel: 'prediction-arb-control',
  },
} as const;

export function getRelayerBaseUrl(): string {
  return String(process.env.POLYMARKET_RELAYER_BASE || '').trim();
}

// Helper para acessar config tipado
export type PredictionArbConfig = typeof PREDICTION_ARB_CONFIG;

// Validação de configuração crítica
export function validateConfig(): void {
  const required = [
    'scan.intervalMs',
    'risk.maxOpenPairs',
    'risk.maxDailyLossUsd',
    'clob.baseUrl',
    'clob.pusdToken',
  ];

  for (const path of required) {
    const value = path.split('.').reduce((obj: any, key) => obj?.[key], PREDICTION_ARB_CONFIG);
    if (value === undefined || value === null) {
      throw new Error(`Configuração obrigatória ausente: ${path}`);
    }
  }
}

export default PREDICTION_ARB_CONFIG;