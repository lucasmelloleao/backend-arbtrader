// Adaptador Dukascopy (via ponte JForex SDK em Java) com interface compatível
// com o CCXT, no mesmo formato do CtraderAdapter/FixAdapter:
//   loadMarkets() / fetchTickers(pairs) / fetchTicker(symbol)
//   createMarketOrder(symbol, side, amount)
//   getPositionsPnL() / fetchAccountInfo()
// A ponte Java expõe HTTP em 127.0.0.1:9100 e fala com o JForex SDK.
import axios from 'axios';

const log = {
  info: (...args: any[]) => console.log('[DUKASCOPY-ADAPTER]', ...args),
  warn: (...args: any[]) => console.warn('[DUKASCOPY-ADAPTER]', ...args),
  error: (...args: any[]) => console.error('[DUKASCOPY-ADAPTER]', ...args),
};

const BRIDGE_URL = process.env.DUKASCOPY_BRIDGE_URL || 'http://127.0.0.1:9100';

export type DukascopyCredentials = {
  jnlpUrl?: string;    // ex: http://platform.dukascopy.com/demo_3/jforex_3.jnlp
  username: string;
  password: string;
};

export type DukascopyTicker = {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  quoteVolume: number;
  timestamp: number;
};

export type DukascopyMarket = {
  id: string;          // símbolo (ex: EUR/USD)
  symbol: string;
  base: string;
  quote: string;
  digits: number;
  minVolume: number;
  maxVolume: number;
  stepVolume: number;
  lotSize: number;
  taker: number;
  enabled: boolean;
};

export class DukascopyAdapter {
  private marketsBySymbol = new Map<string, DukascopyMarket>();
  private connected = false;

  constructor(private creds: DukascopyCredentials) {}

  private get baseUrl() {
    return BRIDGE_URL;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    try {
      const res = await axios.post(`${this.baseUrl}/connect`, {
        jnlpUrl: this.creds.jnlpUrl || 'http://platform.dukascopy.com/demo_3/jforex_3.jnlp',
        username: this.creds.username,
        password: this.creds.password,
      }, { timeout: 45000 });
      if (!res.data?.success) {
        throw new Error(`DukascopyBridge connect falhou: ${res.data?.error || 'erro'}`);
      }
      this.connected = true;
      log.info('✅ DukascopyAdapter: conectado à ponte JForex.');
    } catch (e: any) {
      // Se já está conectado na ponte, /connect retorna ok; senão propaga
      if (e?.response?.data?.success) { this.connected = true; return; }
      // health check: se a ponte já está conectada, aceita
      const health = await axios.get(`${this.baseUrl}/health`, { timeout: 5000 }).catch(() => null);
      if (health?.data?.health?.connected) { this.connected = true; return; }
      throw new Error(`DukascopyBridge indisponível (${this.baseUrl}): ${e.message}. Inicie a ponte: run-bridge.bat`);
    }
  }

  // ─── Markets ──────────────────────────────────────────────────────────────────

  async loadMarkets(): Promise<Record<string, DukascopyMarket>> {
    if (this.marketsBySymbol.size > 0) return this.toMarketsRecord();
    await this.connect();
    const res = await axios.get(`${this.baseUrl}/markets`, { timeout: 15000 });
    const list = res.data?.markets || [];
    for (const m of list) {
      const market: DukascopyMarket = {
        id: m.symbol,
        symbol: m.symbol,
        base: m.base,
        quote: m.quote,
        digits: Number(m.digits || 5),
        minVolume: 0.01,
        maxVolume: Infinity,
        stepVolume: 0.01,
        lotSize: Number(m.contractSize || 100000),
        taker: 0.00002, // comissão ECN Dukascopy (~$2/milhão por lado)
        enabled: true,
      };
      this.marketsBySymbol.set(m.symbol, market);
    }
    log.info(`📈 DukascopyAdapter: ${this.marketsBySymbol.size} símbolos carregados (ex: ${Array.from(this.marketsBySymbol.keys()).slice(0, 8).join(', ')}...)`);
    return this.toMarketsRecord();
  }

  private toMarketsRecord(): Record<string, DukascopyMarket> {
    const rec: Record<string, DukascopyMarket> = {};
    for (const [symbol, m] of this.marketsBySymbol) rec[symbol] = m;
    return rec;
  }

  resolveSymbol(symbol: string): DukascopyMarket | null {
    return this.marketsBySymbol.get(symbol.toUpperCase()) || null;
  }

  // ─── Tickers ──────────────────────────────────────────────────────────────────

  async fetchTickers(pairs: string[]): Promise<Record<string, DukascopyTicker>> {
    await this.connect();
    const symbols = pairs.join(',');
    const res = await axios.get(`${this.baseUrl}/tickers`, { params: { symbols }, timeout: 15000 });
    const out: Record<string, DukascopyTicker> = {};
    for (const t of res.data?.tickers || []) {
      out[t.symbol] = {
        symbol: t.symbol,
        bid: Number(t.bid || 0),
        ask: Number(t.ask || 0),
        last: Number(t.last || 0),
        quoteVolume: 0,
        timestamp: Number(t.timestamp || Date.now()),
      };
    }
    return out;
  }

  async fetchTicker(symbol: string): Promise<DukascopyTicker> {
    await this.connect();
    const res = await axios.get(`${this.baseUrl}/ticker`, { params: { symbol }, timeout: 10000 });
    const t = res.data?.ticker;
    if (!t) throw new Error(`DukascopyAdapter: sem preço para ${symbol}`);
    return {
      symbol: t.symbol,
      bid: Number(t.bid || 0),
      ask: Number(t.ask || 0),
      last: Number(t.last || 0),
      quoteVolume: 0,
      timestamp: Number(t.timestamp || Date.now()),
    };
  }

  // ─── Ordens ───────────────────────────────────────────────────────────────────

  async createMarketOrder(symbol: string, side: 'buy' | 'sell', amount: number): Promise<any> {
    await this.connect();
    const market = this.resolveSymbol(symbol);
    if (!market) throw new Error(`DukascopyAdapter: símbolo desconhecido: ${symbol}`);
    // JForex usa "amount" em unidades base (ex: 1000 = 0.01 lote de EUR/USD).
    // O executor passa amount em unidades base via computeLegAmounts — ok.
    const res = await axios.post(`${this.baseUrl}/order`, {
      symbol: market.symbol,
      side,
      amount,
    }, { timeout: 20000 });
    const o = res.data?.order;
    if (!o) throw new Error(`DukascopyAdapter: ordem falhou: ${res.data?.error || 'erro'}`);
    return {
      id: String(o.id || o.label || ''),
      clientOrderId: String(o.label || ''),
      symbol,
      price: Number(o.price || 0),
      amount: Number(o.amount || amount),
      side,
      positionId: String(o.id || ''),
    };
  }

  async fetchOrderBook(symbol: string, limit = 1): Promise<any> {
    const t = await this.fetchTicker(symbol);
    return {
      bids: t.bid > 0 ? [[t.bid, 0]] : [],
      asks: t.ask > 0 ? [[t.ask, 0]] : [],
    };
  }

  // ─── Posições / PnL ───────────────────────────────────────────────────────────

  async getPositionsPnL(): Promise<Map<string, { positionId: string; netPnl: number; grossPnl: number; volume: number; side: string }>> {
    const out = new Map<string, { positionId: string; netPnl: number; grossPnl: number; volume: number; side: string }>();
    const res = await axios.get(`${this.baseUrl}/positions`, { timeout: 10000 });
    for (const p of res.data?.positions || []) {
      out.set(p.symbol, {
        positionId: String(p.id || ''),
        netPnl: Number(p.profitLoss || 0),
        grossPnl: Number(p.profitLoss || 0),
        volume: Number(p.amount || 0),
        side: p.side || 'buy',
      });
    }
    return out;
  }

  async fetchAccountInfo(): Promise<any> {
    const res = await axios.get(`${this.baseUrl}/account`, { timeout: 10000 });
    const a = res.data?.account || {};
    return {
      balance: Number(a.balance || 0),
      equity: Number(a.equity || 0),
      leverage: Number(a.leverage || 0),
      currency: a.currency || '',
      moneyDigits: 8,
    };
  }

  async fetchDeals(fromTs: number, toTs: number, maxRows = 100): Promise<any[]> {
    // A ponte não expõe histórico de deals; a Dukascopy cobriria via IHistory.
    log.warn('⚠️ DukascopyAdapter: histórico de deals não exposto pela ponte (use positions/account).');
    return [];
  }

  async destroy() {
    this.connected = false;
    // A ponte Java mantém a conexão; não desconectamos (evita reconexão cara).
  }
}
