// Adaptador FIX API (cTrader/Pepperstone) com interface compatível com o CCXT,
// no mesmo formato do CtraderAdapter (Open API):
//   loadMarkets() / fetchTickers(pairs) / fetchTicker(symbol)
//   createMarketOrder(symbol, side, amount)
//   getPositionsPnL() / fetchAccountInfo()
// Símbolos: a Security List expõe SymbolName (ex: "EURUSD", sem "/") e o
// Symbol (id numérico). Internamente normalizamos para "EUR/USD".
import { FixClient, FixCredentials } from './fix-client';
import { FixMessage, SOH } from './fix-protocol';

const log = {
  info: (...args: any[]) => console.log('[FIX-ADAPTER]', ...args),
  warn: (...args: any[]) => console.warn('[FIX-ADAPTER]', ...args),
  error: (...args: any[]) => console.error('[FIX-ADAPTER]', ...args),
};

const VOLUME_DIVISOR = 100; // volume FIX em 1/100 de unidade (0.01 lote -> 1)

export type FixTicker = {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  quoteVolume: number;
  timestamp: number;
};

export type FixMarket = {
  id: string;          // symbolId numérico (FIX tag 55)
  symbol: string;      // "EUR/USD" normalizado
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

export class FixAdapter {
  private client: FixClient;
  private marketsBySymbol = new Map<string, FixMarket>();
  private marketsById = new Map<string, FixMarket>();
  private tickers = new Map<string, FixTicker>();
  private subscribed = new Set<string>();
  private mdReqId: string | null = null;

  constructor(private creds: FixCredentials) {
    this.client = new FixClient(creds, {
      onQuote: (msg) => this.handleQuote(msg),
    });
  }

  async connect() {
    await this.client.connect();
  }

  // ─── Markets ──────────────────────────────────────────────────────────────────

  async loadMarkets(): Promise<Record<string, FixMarket>> {
    if (this.marketsBySymbol.size > 0) return this.toMarketsRecord();
    await this.client.connect();
    const sec = await this.client.requestSecurityList();
    if (sec.body['560'] !== '0') {
      throw new Error(`FIX: Security List falhou (result=${sec.body['560']})`);
    }
    // Parse do repeating group: 146=N, depois pares (55,1007,1008) repetidos
    const raw = sec.raw;
    const bodyPart = raw.slice(raw.indexOf('146='));
    const fields = bodyPart.split(SOH).filter(Boolean);
    const symCount = Number(fields[0].split('=')[1] || 0);
    let idx = 1;
    for (let i = 0; i < symCount && idx < fields.length; i++) {
      let symbolId = '', name = '', digits = '5';
      while (idx < fields.length) {
        const f = fields[idx];
        const [tag, val] = f.split('=');
        if (tag === '55') { symbolId = val; idx++; continue; }
        if (tag === '1007') { name = val; idx++; continue; }
        if (tag === '1008') { digits = val; idx++; continue; }
        break; // fim do grupo
      }
      if (symbolId && name) {
        const symbol = normalizeSymbol(name);
        const [base, quote] = symbol.split('/');
        const market: FixMarket = {
          id: symbolId,
          symbol,
          base: base || symbol,
          quote: quote || '',
          digits: Number(digits || 5),
          minVolume: 0.01,
          maxVolume: Infinity,
          stepVolume: 0.01,
          lotSize: 100000, // FIX não expõe lotSize; padrão FX
          taker: 0.00004,
          enabled: true,
        };
        this.marketsBySymbol.set(symbol, market);
        this.marketsById.set(symbolId, market);
      }
    }
    log.info(`📈 FixAdapter: ${this.marketsBySymbol.size} símbolos carregados (ex: ${Array.from(this.marketsBySymbol.keys()).slice(0, 8).join(', ')}...)`);
    return this.toMarketsRecord();
  }

  private toMarketsRecord(): Record<string, FixMarket> {
    const rec: Record<string, FixMarket> = {};
    for (const [symbol, m] of this.marketsBySymbol) rec[symbol] = m;
    return rec;
  }

  resolveSymbol(symbol: string): FixMarket | null {
    let key = normalizeSymbol(symbol);
    return this.marketsBySymbol.get(key) || null;
  }

  // ─── Tickers ──────────────────────────────────────────────────────────────────

  private handleQuote(msg: FixMessage) {
    // W = Snapshot, X = Incremental. Parse das entradas de preço.
    const entries = parseMdEntries(msg);
    for (const e of entries) {
      const market = this.marketsById.get(e.symbolId);
      if (!market) continue;
      const prev = this.tickers.get(market.symbol) || { bid: 0, ask: 0, last: 0, quoteVolume: 0, timestamp: Date.now(), symbol: market.symbol };
      const next = { ...prev };
      if (e.type === '0') next.bid = e.price;
      if (e.type === '1') next.ask = e.price;
      next.last = next.bid > 0 && next.ask > 0 ? (next.bid + next.ask) / 2 : (next.bid || next.ask);
      next.timestamp = Date.now();
      this.tickers.set(market.symbol, next);
    }
  }

  private async ensureSpots(symbols: string[]) {
    const toSubscribe: number[] = [];
    for (const sym of symbols) {
      const market = this.resolveSymbol(sym);
      if (!market || this.subscribed.has(market.id)) continue;
      toSubscribe.push(Number(market.id));
    }
    if (!toSubscribe.length) return;
    this.mdReqId = `md_${Date.now()}`;
    await this.client.subscribeMarketData(toSubscribe, this.mdReqId);
    for (const id of toSubscribe) this.subscribed.add(String(id));
  }

  async fetchTickers(pairs: string[]): Promise<Record<string, FixTicker>> {
    await this.connect();
    await this.ensureSpots(pairs);
    await this.waitForTicks(pairs, 4000);
    const out: Record<string, FixTicker> = {};
    for (const sym of pairs) {
      const t = this.tickers.get(sym);
      if (t && (t.bid > 0 || t.ask > 0)) out[sym] = t;
    }
    return out;
  }

  async fetchTicker(symbol: string): Promise<FixTicker> {
    await this.connect();
    await this.ensureSpots([symbol]);
    const existing = this.tickers.get(symbol);
    if (existing && (existing.bid > 0 || existing.ask > 0)) return existing;
    await this.waitForTicks([symbol], 5000);
    const t = this.tickers.get(symbol);
    if (!t || (t.bid <= 0 && t.ask <= 0)) {
      throw new Error(`FixAdapter: sem preço para ${symbol}`);
    }
    return t;
  }

  private async waitForTicks(symbols: string[], timeoutMs: number) {
    const missing = new Set(symbols.filter((s) => {
      const t = this.tickers.get(s);
      return !t || (t.bid <= 0 && t.ask <= 0);
    }));
    if (!missing.size) return;
    const deadline = Date.now() + timeoutMs;
    const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 150));
    while (Date.now() < deadline && missing.size > 0) {
      await wait();
      for (const s of Array.from(missing)) {
        const t = this.tickers.get(s);
        if (t && (t.bid > 0 || t.ask > 0)) missing.delete(s);
      }
    }
  }

  // ─── Ordens ───────────────────────────────────────────────────────────────────

  async createMarketOrder(symbol: string, side: 'buy' | 'sell', amount: number): Promise<any> {
    await this.connect();
    const market = this.resolveSymbol(symbol);
    if (!market) throw new Error(`FixAdapter: símbolo desconhecido: ${symbol}`);
    // amount é em unidades base; FIX espera volume em 1/100 de lote (0.01 lote -> 1)
    const volumeProtocol = Math.max(1, Math.round((amount / market.lotSize) * VOLUME_DIVISOR));
    const msg = await this.client.sendMarketOrder(market.id, side, volumeProtocol);
    // ExecType F = Trade (fill), 0 = New (aceito), 8 = Rejected
    const execType = msg.body['150'] || '';
    if (execType === '8' || msg.body['39'] === '8') {
      throw new Error(`FixAdapter: ordem rejeitada: ${msg.body['58'] || ''}`);
    }
    return {
      id: msg.body['37'] || msg.body['11'],
      clientOrderId: msg.body['11'],
      symbol,
      price: Number(msg.body['6'] || 0),
      amount: Number(msg.body['32'] || msg.body['38'] || 0) / VOLUME_DIVISOR,
      positionId: msg.body['721'],
      side,
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
    const reports = await this.client.requestPositions();
    for (const r of reports) {
      const symbolId = r.body['55'];
      const market = this.marketsById.get(symbolId);
      const symbol = market?.symbol || symbolId;
      const longQty = Number(r.body['704'] || 0);
      const shortQty = Number(r.body['705'] || 0);
      const volume = Math.max(longQty, shortQty) / VOLUME_DIVISOR;
      const side = longQty > 0 ? 'buy' : (shortQty > 0 ? 'sell' : '');
      if (!side) continue;
      // FIX Position Report não traz PnL — o PnL é calculado vs. preço atual
      const ticker = this.tickers.get(symbol);
      const avgPrice = Number(r.body['730'] || 0);
      let netPnl = 0;
      if (ticker && avgPrice > 0) {
        const px = side === 'buy' ? ticker.bid : ticker.ask;
        const qty = volume * market!.lotSize; // unidades base
        netPnl = side === 'buy' ? (px - avgPrice) * qty : (avgPrice - px) * qty;
      }
      out.set(symbol, { positionId: r.body['721'], netPnl, grossPnl: netPnl, volume, side });
    }
    return out;
  }

  async fetchAccountInfo(): Promise<any> {
    // FIX não expõe saldo via Position Report; retorna estrutura vazia (o executor
    // usa apenas para o limite de margem, que aqui fica desabilitado).
    return { balance: 0, equity: 0, leverage: 0, currency: '', moneyDigits: 8 };
  }

  async fetchDeals(fromTs: number, toTs: number, maxRows = 100): Promise<any[]> {
    // FIX não tem consulta histórica de deals simples; usa Execution Reports em tempo real.
    log.warn('⚠️ FixAdapter: histórico de deals via FIX não suportado (use Open API).');
    return [];
  }

  async destroy() {
    this.client.destroy();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function normalizeSymbol(name: string): string {
  const n = name.toUpperCase().trim();
  if (n.includes('/')) return n;
  const m = n.match(/^([A-Z]{2,4})(USD|EUR|GBP|JPY|CHF|AUD|CAD|NZD|XAU|XAG|TRY|BRL)$/);
  if (m) return `${m[1]}/${m[2]}`;
  return n;
}

function parseMdEntries(msg: FixMessage): Array<{ symbolId: string; type: '0' | '1'; price: number }> {
  const out: Array<{ symbolId: string; type: '0' | '1'; price: number }> = [];
  const fields = msg.raw.split(SOH).filter(Boolean);
  const count = Number(msg.body['268'] || 0);

  if (msg.msgType === 'W') {
    // Snapshot: 55=symbol, 268=N, depois (269,270,271) repetidos
    const symbolId = msg.body['55'];
    let seen = 0;
    for (let i = 0; i < fields.length && seen < count; i++) {
      const [tag, val] = fields[i].split('=');
      if (tag === '269') {
        const type = val as '0' | '1';
        // 270 (price) deve vir logo após (com 271 size depois)
        for (let j = i + 1; j < Math.min(i + 4, fields.length); j++) {
          const [t2, v2] = fields[j].split('=');
          if (t2 === '270') {
            out.push({ symbolId, type, price: Number(v2) });
            seen++;
            break;
          }
        }
      }
    }
  } else if (msg.msgType === 'X') {
    // Incremental: 268=N, depois (279,269,278,55,270,271) repetidos
    let seen = 0;
    for (let i = 0; i < fields.length && seen < count; i++) {
      const [tag, val] = fields[i].split('=');
      if (tag === '269') {
        const type = val as '0' | '1';
        let symbolId = '';
        let price = 0;
        for (let j = i + 1; j < Math.min(i + 8, fields.length); j++) {
          const [t2, v2] = fields[j].split('=');
          if (t2 === '55') symbolId = v2;
          if (t2 === '270' && price === 0) price = Number(v2);
        }
        if (symbolId && price > 0) {
          out.push({ symbolId, type, price });
          seen++;
        }
      }
    }
  }
  return out;
}
