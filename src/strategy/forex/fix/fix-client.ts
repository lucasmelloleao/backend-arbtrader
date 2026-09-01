// Cliente FIX da cTrader/Pepperstone: gerencia as sessões QUOTE (preços) e
// TRADE (ordens), com reconexão exponencial e requisições correlacionadas.
import { FixSession, FixSessionConfig, FixMessage, SOH, nowUtc } from './fix-protocol';

const log = {
  info: (...args: any[]) => console.log('[FIX-CLIENT]', ...args),
  warn: (...args: any[]) => console.warn('[FIX-CLIENT]', ...args),
  error: (...args: any[]) => console.error('[FIX-CLIENT]', ...args),
};

export type FixCredentials = {
  host: string;             // ex: live-us-eqx-01.p.c-trader.com
  quotePort?: number;       // 5211 (SSL)
  tradePort?: number;       // 5212 (SSL)
  senderCompId: string;     // ex: live.pepperstone.1382148
  targetCompId?: string;    // CSERVER
  username: string;         // login numérico
  password: string;
  heartBtInt?: number;
};

export type FixHandlers = {
  onQuote?: (msg: FixMessage) => void;      // MarketData Snapshot/Incremental (W/X)
  onExecution?: (msg: FixMessage) => void;   // Execution Report (8)
  onPosition?: (msg: FixMessage) => void;    // Position Report (AP)
  onSecurity?: (msg: FixMessage) => void;    // Security List (y)
  onReject?: (msg: FixMessage) => void;      // Business Reject (j) / Reject (3)
};

const DEFAULT_QUOTE_PORT = 5211;
const DEFAULT_TRADE_PORT = 5212;

export class FixClient {
  private quoteSession: FixSession | null = null;
  private tradeSession: FixSession | null = null;
  private handlers: FixHandlers;
  private pendingByType = new Map<string, { resolve: (m: FixMessage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; match: (m: FixMessage) => boolean }>();
  private quoteConnected = false;
  private tradeConnected = false;
  private reconnectTimers: ReturnType<typeof setTimeout>[] = [];
  private positionHandler: ((msg: FixMessage) => void) | null = null;

  constructor(private creds: FixCredentials, handlers: FixHandlers = {}) {
    this.handlers = handlers;
  }

  get isConnected(): boolean {
    return this.quoteConnected && this.tradeConnected;
  }

  async connect(): Promise<void> {
    await Promise.all([this.connectQuote(), this.connectTrade()]);
  }

  private connectQuote(): Promise<void> {
    if (this.quoteSession && this.quoteSession.isConnected) return Promise.resolve();
    const cfg: FixSessionConfig = {
      host: this.creds.host,
      port: this.creds.quotePort || DEFAULT_QUOTE_PORT,
      senderCompId: this.creds.senderCompId,
      targetCompId: this.creds.targetCompId || 'CSERVER',
      targetSubId: 'QUOTE',
      senderSubId: 'QUOTE',
      username: this.creds.username,
      password: this.creds.password,
      heartBtInt: this.creds.heartBtInt || 30,
    };
    this.quoteSession = new FixSession(cfg, {
      onMessage: (msg) => this.dispatchQuote(msg),
      onLogon: () => { this.quoteConnected = true; log.info('✅ FIX QUOTE session logada'); },
      onClose: (err) => {
        this.quoteConnected = false;
        if (err) log.error(`❌ FIX QUOTE session fechada: ${err.message}`);
        this.scheduleReconnect('quote');
      },
    });
    return this.quoteSession.connect().catch((e) => {
      log.error(`❌ FIX QUOTE connect falhou: ${e.message}`);
      this.scheduleReconnect('quote');
      throw e;
    });
  }

  private connectTrade(): Promise<void> {
    if (this.tradeSession && this.tradeSession.isConnected) return Promise.resolve();
    const cfg: FixSessionConfig = {
      host: this.creds.host,
      port: this.creds.tradePort || DEFAULT_TRADE_PORT,
      senderCompId: this.creds.senderCompId,
      targetCompId: this.creds.targetCompId || 'CSERVER',
      targetSubId: 'TRADE',
      senderSubId: 'TRADE',
      username: this.creds.username,
      password: this.creds.password,
      heartBtInt: this.creds.heartBtInt || 30,
    };
    this.tradeSession = new FixSession(cfg, {
      onMessage: (msg) => this.dispatchTrade(msg),
      onLogon: () => { this.tradeConnected = true; log.info('✅ FIX TRADE session logada'); },
      onClose: (err) => {
        this.tradeConnected = false;
        if (err) log.error(`❌ FIX TRADE session fechada: ${err.message}`);
        this.scheduleReconnect('trade');
      },
    });
    return this.tradeSession.connect().catch((e) => {
      log.error(`❌ FIX TRADE connect falhou: ${e.message}`);
      this.scheduleReconnect('trade');
      throw e;
    });
  }

  private scheduleReconnect(which: 'quote' | 'trade') {
    const timer = setTimeout(() => {
      this.reconnectTimers = this.reconnectTimers.filter((t) => t !== timer);
      if (which === 'quote') {
        this.connectQuote().catch(() => {});
      } else {
        this.connectTrade().catch(() => {});
      }
    }, 5000);
    this.reconnectTimers.push(timer);
  }

  private dispatchQuote(msg: FixMessage) {
    switch (msg.msgType) {
      case 'W': // Snapshot/Full Refresh
      case 'X': // Incremental Refresh
        this.handlers.onQuote?.(msg);
        break;
      case 'Y': // Market Data Request Reject
        log.warn(`⚠️ FIX QUOTE rejeitou MD request: ${msg.body['58'] || msg.body['281']}`);
        break;
    }
  }

  private dispatchTrade(msg: FixMessage) {
    switch (msg.msgType) {
      case '8': // Execution Report
        this.resolvePending(msg);
        this.handlers.onExecution?.(msg);
        break;
      case 'AP': // Position Report
        this.resolvePending(msg);
        if (this.positionHandler) this.positionHandler(msg);
        this.handlers.onPosition?.(msg);
        break;
      case 'y': // Security List
        this.resolvePending(msg);
        this.handlers.onSecurity?.(msg);
        break;
      case 'j': // Business Message Reject
      case '3': // Reject
      case '9': // Order Cancel Reject
        this.rejectPending(msg);
        this.handlers.onReject?.(msg);
        break;
    }
  }

  private resolvePending(msg: FixMessage) {
    for (const [id, p] of this.pendingByType) {
      if (p.match(msg)) {
        clearTimeout(p.timer);
        this.pendingByType.delete(id);
        p.resolve(msg);
        return;
      }
    }
  }

  private rejectPending(msg: FixMessage) {
    const candidates = [msg.body['11'], msg.body['41'], msg.body['379']];
    for (const refId of candidates) {
      if (refId && this.pendingByType.has(refId)) {
        const p = this.pendingByType.get(refId)!;
        clearTimeout(p.timer);
        this.pendingByType.delete(refId);
        p.reject(new Error(`FIX rejeitou: ${msg.body['58'] || msg.msgType}`));
        return;
      }
    }
  }

  // ─── API de alto nível ───────────────────────────────────────────────────────

  /** Security List Request (35=x) → Security List (35=y). Correlaciona por 320. */
  requestSecurityList(symbolId?: string): Promise<FixMessage> {
    const s = this.tradeSession;
    if (!s || !s.isConnected) return Promise.reject(new Error('FIX TRADE session não conectada'));
    const secReqId = `sec_${Date.now()}`;
    return new Promise<FixMessage>((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingByType.delete(secReqId); reject(new Error('FIX timeout Security List')); }, 15000);
      this.pendingByType.set(secReqId, { resolve, reject, timer, match: (m) => m.body['320'] === secReqId });
      s.send('x', { '320': secReqId, '559': '0', ...(symbolId ? { '55': symbolId } : {}) });
    });
  }

  /** Market Data Request (35=V) — subscribe spots (fire-and-forget, resposta via onQuote). */
  subscribeMarketData(symbolIds: number[], mdReqId: string): Promise<void> {
    const s = this.quoteSession;
    if (!s || !s.isConnected) return Promise.reject(new Error('FIX QUOTE session não conectada'));
    // Repeating groups: 146=N, 55=id (N vezes), 267=2, 269=0, 269=1
    const symGroup = symbolIds.map((id) => `55=${id}`).join(SOH);
    const body: Record<string, string> = {
      '262': mdReqId,
      '263': '1',
      '264': '1',
      '265': '1',
      '146': String(symbolIds.length),
      '267': '2',
      '269': '0',
    };
    const rawBody = `${symGroup}${SOH}269=1`;
    s.send('V', body, rawBody);
    return Promise.resolve();
  }

  /** New Order Single (35=D) — ordem MARKET. Correlaciona por ClOrdID (11). */
  sendMarketOrder(symbolId: string, side: 'buy' | 'sell', qty: number, clOrdId?: string): Promise<FixMessage> {
    const s = this.tradeSession;
    if (!s || !s.isConnected) return Promise.reject(new Error('FIX TRADE session não conectada'));
    const id = clOrdId || `fa_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
    return new Promise<FixMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingByType.delete(id);
        reject(new Error(`FIX timeout aguardando fill da ordem ${id}`));
      }, 15000);
      this.pendingByType.set(id, {
        resolve, reject, timer,
        match: (m) => m.msgType === '8' && m.body['11'] === id,
      });
      s.send('D', {
        '11': id,
        '55': symbolId,
        '54': side === 'buy' ? '1' : '2',
        '60': nowUtc(),
        '38': qty.toFixed(2),
        '40': '1',           // Market
        '59': '3',           // IOC
        '494': 'forex-arb',
      });
    });
  }

  /** Request for Positions (35=AN) → Position Reports (35=AP). Correlaciona por 710. */
  requestPositions(): Promise<FixMessage[]> {
    const s = this.tradeSession;
    if (!s || !s.isConnected) return Promise.reject(new Error('FIX TRADE session não conectada'));
    const posReqId = `pos_${Date.now()}`;
    const reports: FixMessage[] = [];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.positionHandler = prevPositionHandler;
        reject(new Error('FIX timeout aguardando Position Reports'));
      }, 10000);
      const prevPositionHandler = this.positionHandler;
      this.positionHandler = (msg: FixMessage) => {
        if (msg.body['710'] !== posReqId) { prevPositionHandler?.(msg); return; }
        if (msg.body['728'] === '2') { // no positions
          clearTimeout(timer);
          this.positionHandler = prevPositionHandler;
          resolve([]);
          return;
        }
        reports.push(msg);
        const total = Number(msg.body['727'] || 0);
        if (reports.length >= total) {
          clearTimeout(timer);
          this.positionHandler = prevPositionHandler;
          resolve(reports);
        }
      };
      s.send('AN', { '710': posReqId });
    });
  }

  destroy() {
    for (const t of this.reconnectTimers) clearTimeout(t);
    this.reconnectTimers = [];
    for (const [, p] of this.pendingByType) clearTimeout(p.timer);
    this.pendingByType.clear();
    try { this.quoteSession?.disconnect(); } catch {}
    try { this.tradeSession?.disconnect(); } catch {}
    this.quoteSession = null;
    this.tradeSession = null;
    this.quoteConnected = false;
    this.tradeConnected = false;
  }
}
