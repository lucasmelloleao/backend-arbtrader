import ccxt from 'ccxt';
import mongoose from 'mongoose';
import PerpArbTrade from '../../models/PerpArbTrade';

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${msg}`, ...args),
};

export const SCANNER_CONFIG = {
  minFundingPct8h: 0.002,
  minVolume24hUSD: 50000,
  targetSpotBuyUSD: 300,
  scanIntervalMs: 2 * 60 * 1000,
  maxStrategiesPerScan: 10,
  reuseExisting: true,
  maxPerpScan: 50,
  minFundingRatePct: 0.001,
};

export type ScannerOpportunity = {
  exchangeId: string;
  symbol: string;
  spotSymbol: string;
  fundingRate: number;
  fundingPct: number;
  spreadPct: number;
  netFundingPct: number;
  totalFeePct: number;
  annualPct: number;
  last: number;
  volume24hUSD: number;
  depth1kUSD: boolean;
};

function annualize(fundingPct8h: number) {
  return fundingPct8h * 3 * 365;
}

function isPerpSymbol(symbol: string) {
  return symbol.endsWith(':USDT');
}

function toSpotSymbol(symbol: string) {
  const base = symbol.split('/')[0];
  const quote = symbol.split('/')[1]?.split(':')[0];
  const spot = quote ? `${base}/${quote}` : symbol.replace(/:.*/, '');
  return spot;
}

export async function scanExchangeFunding(exchangeId: string, config: any): Promise<ScannerOpportunity[]> {
  const t0 = Date.now();
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI!);
  }

  const t1 = Date.now();
  const ccxtId = exchangeId === 'gateio' ? 'gate' : exchangeId;
  const exchange = new (ccxt as any)[ccxtId]({
    enableRateLimit: true,
    timeout: 10000,
    options: {
      fetchCurrencies: false,
    },
  });
  exchange.has = { ...(exchange.has || {}), fetchCurrencies: false };

  const timeout = (ms: number, label: string) =>
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        try { exchange.destroy(); } catch {}
        reject(new Error(`${label} timeout após ${ms}ms`));
      }, ms)
    );

  let markets: any = {};
  try {
    markets = await Promise.race([exchange.loadMarkets(), timeout(20000, 'loadMarkets')]);
  } catch (e: any) {
    log.warn(`⚠️ Scanner [${exchangeId}] abortado em loadMarkets: ${e.message}`);
    try { exchange.destroy(); } catch {}
    return [];
  }
  const t2 = Date.now();
  log.info(`⏱️ Scanner [${exchangeId}]: loadMarkets levou ${t2 - t1}ms`);

  const perpSymbols = Object.keys(markets).filter(isPerpSymbol);

  log.info(`🔍 Scanner [${exchangeId}]: Market carregado. Pares perpétuos para scan: ${perpSymbols.length}`);

  let perpTickers: any = {};
  let spotTickers: any = {};
  try {
    const spotSymbols = Array.from(new Set(perpSymbols.map(toSpotSymbol)))
      .filter(spotSym => markets[spotSym] !== undefined);

    const tFetch0 = Date.now();
    const [pTickers, sTickers] = await Promise.all([
      Promise.race([exchange.fetchTickers(perpSymbols), timeout(20000, `fetchTickers perp(${exchangeId})`)]),
      Promise.race([exchange.fetchTickers(spotSymbols), timeout(20000, `fetchTickers spot(${exchangeId})`)]),
    ]).catch((e: any) => {
      log.warn(`⚠️ Scanner [${exchangeId}] abortado em fetchTickers: ${e.message}`);
      try { exchange.destroy(); } catch {}
      throw e;
    }) as [any, any];
    const tFetch1 = Date.now();
    log.info(`⏱️ Scanner [${exchangeId}]: fetchTickers levou ${tFetch1 - tFetch0}ms`);
    perpTickers = pTickers;
    spotTickers = sTickers;
  } catch (e: any) {
    return [];
  }

  let fundingRatesObj: any = {};
  const tFund0 = Date.now();
  if (exchange.has['fetchFundingRates']) {
    fundingRatesObj = await Promise.race([
      exchange.fetchFundingRates(perpSymbols).catch(() => ({})),
      timeout(20000, `fetchFundingRates(${exchangeId})`).catch(() => ({})),
    ]);
  }
  const tFund1 = Date.now();
  log.info(`⏱️ Scanner [${exchangeId}]: fetchFundingRates levou ${tFund1 - tFund0}ms`);

  const rawOpportunities: ScannerOpportunity[] = [];

  for (const symbol of perpSymbols) {
    let fundingRate: number | undefined;

    if (fundingRatesObj[symbol] && fundingRatesObj[symbol].fundingRate !== undefined) {
      fundingRate = Number(fundingRatesObj[symbol].fundingRate);
    } else {
      const ticker = perpTickers[symbol];
      if (!ticker || !ticker.info) continue;
      const fundingRateStr = ticker.info.fundingRate || ticker.info.funding_rate || ticker.info.lastFundingRate;
      if (fundingRateStr !== undefined) {
        fundingRate = Number(fundingRateStr);
      }
    }

    if (fundingRate === undefined || isNaN(fundingRate)) continue;

    const fundingPct = fundingRate * 100;

    const spotSymbol = toSpotSymbol(symbol);
    const spotMarket = markets[spotSymbol];
    if (!spotMarket) continue;

    const perpTicker = perpTickers[symbol];
    const spotTicker = spotTickers[spotSymbol];
    const volume24hUSD = spotTicker?.quoteVolume || perpTicker?.quoteVolume || 0;

    const perpBid = perpTicker?.bid || perpTicker?.last || 0;
    const spotAsk = spotTicker?.ask || spotTicker?.last || 0;
    const spreadPct = (spotAsk > 0 && perpBid > 0) ? ((perpBid - spotAsk) / spotAsk) * 100 : 0;

    const perpMarket = markets[symbol];

    const spotTakerFee = spotMarket.taker ?? 0.001;
    const perpTakerFee = perpMarket.taker ?? 0.0006;
    const roundTripFeePct = (spotTakerFee + perpTakerFee) * 100;

    const netFundingPct = fundingPct + spreadPct - roundTripFeePct;

    rawOpportunities.push({
      exchangeId,
      symbol,
      spotSymbol,
      fundingRate,
      fundingPct,
      spreadPct,
      netFundingPct,
      totalFeePct: roundTripFeePct,
      annualPct: annualize(fundingPct),
      last: spotTicker?.last || perpTicker?.last || 0,
      volume24hUSD,
      depth1kUSD: false,
    });
  }

  rawOpportunities.sort((a, b) => b.netFundingPct - a.netFundingPct);

  log.info(`\n🏆 TOP 10 Oportunidades Brutas no Mercado [${exchangeId}] (Ordenadas por Lucro Líquido Real):`);
  log.info('\n' + rawOpportunities.slice(0, 10).map((op, i) =>
    `  ${String(i+1).padStart(2)}. ${op.exchangeId.toUpperCase().padEnd(8)} | ${op.symbol.padEnd(16)} | Fund: ${op.fundingPct.toFixed(4)}% | Spread: ${(op as any).spreadPct.toFixed(4)}% | Net: ${op.netFundingPct.toFixed(4)}% | Vol24h: $${Math.round(op.volume24hUSD).toLocaleString()}`
  ).join('\n'));

  const minEntrySpread = config.minEntrySpreadPct ?? 0;
  const profitableOpps = rawOpportunities.filter(op =>
    op.netFundingPct >= config.minFundingRatePct &&
    (op as any).spreadPct >= minEntrySpread
  );

  const bestOpps = profitableOpps.slice(0, config.maxPerpScan || 50);
  const opportunities: ScannerOpportunity[] = [];

  const CHUNK_SIZE = 8;
  const ORDERBOOK_TIMEOUT_MS = 5000;

  for (let i = 0; i < bestOpps.length; i += CHUNK_SIZE) {
    const chunk = bestOpps.slice(i, i + CHUNK_SIZE);

    const books = await Promise.allSettled(
      chunk.map(opp => {
        if (opp.volume24hUSD < config.minVolume24hUSD) return Promise.resolve(null);
        return Promise.race([
          exchange.fetchOrderBook(opp.spotSymbol, 10),
          new Promise<null>((_, reject) =>
            setTimeout(() => reject(new Error(`fetchOrderBook timeout (${opp.spotSymbol})`)), ORDERBOOK_TIMEOUT_MS)
          ),
        ]).catch(() => null);
      })
    );

    for (let j = 0; j < chunk.length; j++) {
      const opp = chunk[j];
      if (opp.volume24hUSD < config.minVolume24hUSD) continue;

      const settled = books[j];
      const orderBook = settled.status === 'fulfilled' ? settled.value : null;

      let depthOk = false;
      if (orderBook && orderBook.asks && orderBook.asks.length) {
        let accumulatedUSD = 0;
        for (const [price, amount] of orderBook.asks) {
          accumulatedUSD += price * amount;
          if (accumulatedUSD >= config.targetSpotBuyUSD) {
            depthOk = true;
            break;
          }
        }
      }

      if (depthOk) {
        opp.depth1kUSD = true;
        opportunities.push(opp);
        if (opportunities.length >= config.maxStrategiesPerScan) break;
      }
    }

    if (opportunities.length >= config.maxStrategiesPerScan) break;
  }

  const tScanTotal = Date.now();
  log.info(`⏱️ Scanner [${exchangeId}]: TOTAL scanExchangeFunding levou ${tScanTotal - t0}ms, oportunidades finais=${opportunities.length}`);

  try { exchange.destroy(); } catch {}

  const g = global as any;
  if (g.gc) {
    g.gc();
  }

  return opportunities;
}

export async function cleanupSkippedTrades(): Promise<void> {
  await PerpArbTrade.deleteMany({ status: { $in: ['skipped', 'failed'] } }).catch(() => null);
}
