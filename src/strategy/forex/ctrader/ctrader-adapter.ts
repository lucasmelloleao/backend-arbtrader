// Adaptador cTrader Open API com interface compatível com o CCXT
// (subconjunto usado pelo scanner e executor da arbitragem forex):
//   loadMarkets() -> Record<symbol, market>
//   fetchTickers(pairs) -> Record<symbol, {bid,ask,last,quoteVolume,timestamp}>
//   fetchTicker(symbol) -> {bid,ask,last,...}
//   createMarketOrder(symbol, side, amount) -> {id, price, amount}
//   destroy()
// Conversões:
//   - símbolo: a Open API expõe "EUR/USD" (ProtoOALightSymbol.symbolName) — mantemos com '/'
//   - volume: o executor trabalha em unidades base (ex: 100 EUR); a Open API usa
//     volume int64 em 1/100 de unidade (ex: 0.01 lote -> 1). Conversão no createMarketOrder.
//   - preço: bid/ask em 1/100000 de unidade.
import axios from 'axios';
import { CtraderClient, CtraderCredentials, CtraderTokenExpiredError, PAYLOAD_TYPE, ORDER_TYPE, TRADE_SIDE, EXECUTION_TYPE, CTRADER_TOKEN_URL } from './ctrader-client';

const log = {
  info: (...args: any[]) => console.log('[CTRADER-ADAPTER]', ...args),
  warn: (...args: any[]) => console.warn('[CTRADER-ADAPTER]', ...args),
  error: (...args: any[]) => console.error('[CTRADER-ADAPTER]', ...args),
};

const PRICE_DIVISOR = 100000;   // 1/100000 de unidade
const VOLUME_DIVISOR = 100;     // 1/100 de unidade

export type CtraderTicker = {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  quoteVolume: number;
  timestamp: number;
};

export type CtraderMarket = {
  id: string;          // symbolId
  symbol: string;      // "EUR/USD"
  base: string;
  quote: string;
  digits: number;
  minVolume: number;   // em unidades (ex: 0.01)
  maxVolume: number;
  stepVolume: number;
  lotSize: number;     // em unidades base por lote (ex: 100000)
  taker: number;       // comissão estimada (fração)
  enabled: boolean;
};

export type OnTokenRefresh = (accessToken: string, refreshToken: string) => Promise<void>;

export class CtraderAdapter {
  private client: CtraderClient;
  private marketsBySymbol = new Map<string, CtraderMarket>();
  private marketsById = new Map<string, CtraderMarket>();
  private tickers = new Map<string, CtraderTicker>();
  private subscribed = new Set<string>(); // symbolIds já assinados
  private onTokenRefresh: OnTokenRefresh | null = null;
  private connecting: Promise<void> | null = null;

  constructor(
    private creds: CtraderCredentials,
    private opts: { onTokenRefresh?: OnTokenRefresh } = {},
  ) {
    this.onTokenRefresh = opts.onTokenRefresh || null;
    this.client = new CtraderClient(creds, {
      onSpot: (evt) => this.handleSpot(evt),
      // Quando a conexão cai, as assinaturas de spot são perdidas na cTrader.
      // Limpa o cache para que o próximo fetchTickers re-assine do zero.
      onDisconnect: () => {
        this.subscribed.clear();
        this.tickers.clear();
        log.warn('⚠️ CtraderAdapter: conexão caiu. Assinaturas de spot serão refeitas no próximo fetch.');
      },
    });
  }

  // ─── Conexão ─────────────────────────────────────────────────────────────────

  async connect() {
    if (!this.connecting) {
      this.connecting = this.client.connect().catch((e) => {
        if (e instanceof CtraderTokenExpiredError) {
          log.warn('⚠️ CtraderAdapter: access token expirado na conexão. Tentando refresh...');
          return this.refreshTokenAndReconnect();
        }
        throw e;
      }).finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  private async refreshTokenAndReconnect() {
    const ok = await this.tryRefreshToken();
    if (!ok) throw new Error('CtraderAdapter: não foi possível renovar o access token');
    this.client.destroy().catch(() => {});
    return this.client.connect();
  }

  private async tryRefreshToken(): Promise<boolean> {
    const { clientId, clientSecret, refreshToken, environment } = this.creds;
    if (!refreshToken) {
      log.error('❌ CtraderAdapter: refreshToken ausente — impossível renovar o access token.');
      return false;
    }
    try {
      const res = await axios.get(CTRADER_TOKEN_URL, {
        params: {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        },
        timeout: 15000,
      });
      const data = res.data;
      if (data?.accessToken && data?.refreshToken) {
        this.creds.accessToken = data.accessToken;
        this.creds.refreshToken = data.refreshToken;
        log.info('✅ CtraderAdapter: access token renovado via refresh token.');
        await this.onTokenRefresh?.(data.accessToken, data.refreshToken).catch((e) =>
          log.error('❌ CtraderAdapter: falha ao persistir novo token:', e.message));
        return true;
      }
      log.error('❌ CtraderAdapter: refresh retornou resposta inválida:', data?.errorCode, data?.description);
      return false;
    } catch (e: any) {
      log.error('❌ CtraderAdapter: erro no refresh token:', e?.message);
      return false;
    }
  }

  // ─── Markets ──────────────────────────────────────────────────────────────────

  async loadMarkets(): Promise<Record<string, CtraderMarket>> {
    await this.connect();
    if (this.marketsBySymbol.size > 0) return this.toMarketsRecord();

    const accountId = Number(this.creds.accountId);
    const listRes = await this.client.sendRequest(
      PAYLOAD_TYPE.PROTO_OA_SYMBOLS_LIST_REQ,
      'ProtoOASymbolsListReq',
      { ctidTraderAccountId: accountId },
      15000,
    );
    if (listRes.payloadType === PAYLOAD_TYPE.PROTO_OA_ERROR_RES) {
      throw new Error(`CtraderAdapter: erro ao listar símbolos: ${listRes.errorCode} ${listRes.description || ''}`);
    }

    const light = (listRes.symbol || []) as any[];
    const enabledSymbols = light.filter((s: any) => s.enabled !== false && s.symbolName);
    // Busca detalhes completos (digits, minVolume, lotSize) em lotes de 100
    const symbolIds = enabledSymbols.map((s: any) => Number(s.symbolId));
    const detailMap = new Map<number, any>();
    for (let i = 0; i < symbolIds.length; i += 100) {
      const chunk = symbolIds.slice(i, i + 100);
      const detailRes = await this.client.sendRequest(
        PAYLOAD_TYPE.PROTO_OA_SYMBOL_BY_ID_REQ,
        'ProtoOASymbolByIdReq',
        { ctidTraderAccountId: accountId, symbolId: chunk },
        15000,
      );
      if (detailRes.payloadType === PAYLOAD_TYPE.PROTO_OA_ERROR_RES) {
        log.warn(`⚠️ CtraderAdapter: erro ao buscar detalhes de símbolos: ${detailRes.errorCode}`);
        continue;
      }
      for (const sym of (detailRes.symbol || []) as any[]) {
        detailMap.set(Number(sym.symbolId), sym);
      }
    }

    for (const s of enabledSymbols) {
      const detail = detailMap.get(Number(s.symbolId));
      let symbol = s.symbolName as string; // ex: "EURUSD" ou "EUR/USD"
      if (!symbol.includes('/') && symbol.length >= 6) {
        const m = symbol.match(/^([A-Za-z]{3})([A-Za-z]{3})(?:\..+)?$/);
        if (m) symbol = `${m[1]}/${m[2]}`;
      }
      if (!symbol.includes('/')) continue;
      const [base, quote] = symbol.split('/');
      const minVolume = detail?.minVolume ? Number(detail.minVolume) / VOLUME_DIVISOR : 0.01;
      const market: CtraderMarket = {
        id: String(s.symbolId),
        symbol,
        base: base.toUpperCase(),
        quote: quote.toUpperCase(),
        digits: detail?.digits ?? 5,
        minVolume: minVolume,
        maxVolume: detail?.maxVolume ? Number(detail.maxVolume) / VOLUME_DIVISOR : Infinity,
        stepVolume: detail?.stepVolume ? Number(detail.stepVolume) / VOLUME_DIVISOR : 0.01,
        lotSize: detail?.lotSize ? Number(detail.lotSize) / VOLUME_DIVISOR : 100000,
        // Comissão: símbolos FX normalmente usam USD_PER_MILLION_USD ou 0.
        taker: 0.00004, // estimativa padrão (0.004% / perna) — refinável por símbolo
        enabled: s.enabled !== false,
      };
      this.marketsBySymbol.set(symbol, market);
      this.marketsById.set(String(s.symbolId), market);
    }

    log.info(`📈 CtraderAdapter: ${this.marketsBySymbol.size} símbolos carregados (ex: ${Array.from(this.marketsBySymbol.keys()).slice(0, 8).join(', ')}...)`);
    return this.toMarketsRecord();
  }

  private toMarketsRecord(): Record<string, CtraderMarket> {
    const rec: Record<string, CtraderMarket> = {};
    for (const [symbol, m] of this.marketsBySymbol) rec[symbol] = m;
    return rec;
  }

  resolveSymbol(symbol: string): CtraderMarket | null {
    // Normaliza "EURUSD" -> "EUR/USD", aceita "EUR/USD" direto
    let key = symbol;
    if (!key.includes('/')) {
      const m = key.match(/^([A-Z]{3})([A-Z]{3})$/);
      if (m) key = `${m[1]}/${m[2]}`;
    }
    return this.marketsBySymbol.get(key) || null;
  }

  // ─── Tickers ──────────────────────────────────────────────────────────────────

  private handleSpot(evt: any) {
    const market = this.marketsById.get(String(evt.symbolId));
    if (!market) return;
    const bid = evt.bid ? Number(evt.bid) / PRICE_DIVISOR : 0;
    const ask = evt.ask ? Number(evt.ask) / PRICE_DIVISOR : 0;
    if (bid <= 0 && ask <= 0) return;
    const last = bid > 0 && ask > 0 ? (bid + ask) / 2 : (bid || ask);
    this.tickers.set(market.symbol, {
      symbol: market.symbol,
      bid,
      ask,
      last,
      quoteVolume: 0, // Open API não expõe volume 24h por ticker
      timestamp: evt.timestamp ? Number(evt.timestamp) : Date.now(),
    });
  }

  private async ensureSpots(symbols: string[]) {
    const accountId = Number(this.creds.accountId);
    const toSubscribe: number[] = [];
    for (const sym of symbols) {
      const market = this.resolveSymbol(sym);
      if (!market) continue;
      if (this.subscribed.has(market.id)) continue;
      toSubscribe.push(Number(market.id));
    }
    if (!toSubscribe.length) return;
    try {
      // Assina e aguarda a confirmação (ProtoOASubscribeSpotsRes) antes de
      // marcar como subscribed — assim o waitForTicks não começa antes de a
      // cTrader estar de fato enviando spots para os símbolos.
      const res = await this.client.sendRequest(
        PAYLOAD_TYPE.PROTO_OA_SUBSCRIBE_SPOTS_REQ,
        'ProtoOASubscribeSpotsReq',
        { ctidTraderAccountId: accountId, symbolId: toSubscribe },
        10000,
      );
      if (res.payloadType === PAYLOAD_TYPE.PROTO_OA_ERROR_RES) {
        log.warn(`⚠️ CtraderAdapter: erro ao assinar spots: ${res.errorCode} ${res.description || ''}`);
        return;
      }
      for (const id of toSubscribe) this.subscribed.add(String(id));
    } catch (e: any) {
      log.warn(`⚠️ CtraderAdapter: falha ao assinar spots: ${e.message}`);
    }
  }

  async fetchTickers(pairs: string[]): Promise<Record<string, CtraderTicker>> {
    await this.connect();
    // Garante que os markets estão carregados (necessário para resolveSymbol
    // mapear símbolo → symbolId e assinar os spots corretos).
    if (this.marketsBySymbol.size === 0) {
      await this.loadMarkets();
    }
    await this.ensureSpots(pairs);
    // O primeiro ProtoOASpotEvent chega logo após a assinatura; aguarda um tick
    // de cada par (ou usa o que já tem em cache). 7s dá margem para o primeiro
    // tick de símbolos recém-assinados em conexão nova.
    await this.waitForTicks(pairs, 7000);
    const out: Record<string, CtraderTicker> = {};
    for (const sym of pairs) {
      const t = this.tickers.get(sym);
      if (t && (t.bid > 0 || t.ask > 0)) out[sym] = t;
    }
    return out;
  }

  async fetchTicker(symbol: string): Promise<CtraderTicker> {
    await this.connect();
    if (this.marketsBySymbol.size === 0) {
      await this.loadMarkets();
    }
    await this.ensureSpots([symbol]);
    const existing = this.tickers.get(symbol);
    if (existing && (existing.bid > 0 || existing.ask > 0)) return existing;
    await this.waitForTicks([symbol], 5000);
    const t = this.tickers.get(symbol);
    if (!t || (t.bid <= 0 && t.ask <= 0)) {
      throw new Error(`CtraderAdapter: sem preço para ${symbol}`);
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

  /**
   * Cria uma ordem MARKET. `amount` é a quantidade em unidades base (ex: 100 EUR),
   * ou em "lotes" quando o caller usa o formato de volume da cTrader.
   * A Open API espera volume int64 em 1/100 de unidade (0.01 lote -> 1).
   * Conversão: volumeCents = round(amount / lotSize * 100 * 100) ... na verdade:
   *   unidades = amount (quantidade da base)
   *   volumeProtocol = round(amount / lotSize * VOLUME_DIVISOR)  → nº de 1/100 de lote
   *   (0.01 lote = 1; 1.00 lote = 100)
   */
  async createMarketOrder(symbol: string, side: 'buy' | 'sell', amount: number): Promise<any> {
    await this.connect();
    // Garante que os markets estão carregados (o executor pode chamar
    // createMarketOrder sem passar por loadMarkets antes).
    if (this.marketsBySymbol.size === 0) {
      await this.loadMarkets();
    }
    const market = this.resolveSymbol(symbol);
    if (!market) throw new Error(`CtraderAdapter: símbolo desconhecido: ${symbol}`);
    const accountId = Number(this.creds.accountId);

    // volumeProtocol = quantidade em 1/100 de lote
    // amount é em unidades base; lotSize é unidades base por lote.
    let volumeProtocol = Math.round((amount / market.lotSize) * VOLUME_DIVISOR);
    if (volumeProtocol < 1) volumeProtocol = 1; // mínimo 0.01 lote
    // Respeita limites do símbolo
    const minProto = Math.max(1, Math.round(market.minVolume * VOLUME_DIVISOR));
    const maxProto = Math.round(market.maxVolume * VOLUME_DIVISOR);
    if (volumeProtocol < minProto) volumeProtocol = minProto;
    if (volumeProtocol > maxProto) volumeProtocol = maxProto;

    const clientOrderId = `fa_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    log.info(`📤 [CTRADER-ADAPTER] Enviando ProtoOANewOrderReq para ${symbol} (${side.toUpperCase()} ${volumeProtocol} / 100 de lote)...`);

    // A cTrader Open API NÃO responde ao NewOrderReq com uma resposta
    // correlacionada por clientMsgId: a confirmação chega como
    // ProtoOAExecutionEvent (2126) ecoando o clientOrderId. Por isso:
    //  1) registra o waitForFill ANTES do envio (para não perder o evento);
    //  2) envia a ordem em fire-and-forget.
    const fillPromise = this.waitForFill(clientOrderId, symbol, 15000);
    this.client.sendFireAndForget(
      PAYLOAD_TYPE.PROTO_OA_NEW_ORDER_REQ,
      'ProtoOANewOrderReq',
      {
        ctidTraderAccountId: accountId,
        symbolId: Number(market.id),
        orderType: ORDER_TYPE.MARKET,
        tradeSide: side === 'buy' ? TRADE_SIDE.BUY : TRADE_SIDE.SELL,
        volume: volumeProtocol,
        label: 'forex-arb',
        clientOrderId,
        timeInForce: 3, // IMMEDIATE_OR_CANCEL
      },
    );

    try {
      return await fillPromise;
    } catch (e: any) {
      // Se a rejeição for por token expirado/inválido, renova e reenvia.
      const msg = e?.message || '';
      if (msg.includes('OA_AUTH_TOKEN_EXPIRED') || msg.includes('CH_ACCESS_TOKEN_INVALID')) {
        log.warn('⚠️ CtraderAdapter: token expirado ao enviar ordem. Tentando refresh...');
        await this.refreshTokenAndReconnect();
        return this.createMarketOrder(symbol, side, amount);
      }
      throw e;
    }
  }

  private waitForFill(clientOrderId: string, symbol: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.client.offExecution(handler);
        reject(new Error(`CtraderAdapter: timeout aguardando fill da ordem ${clientOrderId}`));
      }, timeoutMs);

      const handler = (evt: any) => {
        const order = evt.order || {};
        if (order.clientOrderId !== clientOrderId) return;
        if (evt.executionType === EXECUTION_TYPE.ORDER_FILLED) {
          clearTimeout(timer);
          this.client.offExecution(handler);
          const deal = evt.deal || {};
          const price = order.executionPrice != null ? Number(order.executionPrice) : (deal.executionPrice != null ? Number(deal.executionPrice) : 0);
          const filledVolume = deal.filledVolume != null ? Number(deal.filledVolume) : (order.executedVolume != null ? Number(order.executedVolume) : 0);
          resolve({
            id: String(order.orderId || deal.dealId || ''),
            clientOrderId,
            symbol,
            price,
            amount: filledVolume / VOLUME_DIVISOR * 100, // filledVolume é em 1/100 lote; converte p/ unidades
            positionId: evt.position?.positionId != null ? String(evt.position.positionId) : undefined,
            side: order.tradeData?.tradeSide === TRADE_SIDE.BUY ? 'buy' : 'sell',
          });
        } else if (evt.executionType === EXECUTION_TYPE.ORDER_REJECTED || evt.errorCode) {
          clearTimeout(timer);
          this.client.offExecution(handler);
          reject(new Error(`CtraderAdapter: ordem rejeitada (${evt.errorCode || 'ORDER_REJECTED'})`));
        }
      };
      this.client.onExecution(handler);
    });
  }

  /**
   * Fecha uma posição existente pelo positionId com o volume EXATO (em 1/100
   * de unidade), usando ProtoOAClosePositionReq. É a forma correta de encerrar
   * uma posição na cTrader — evita o problema de createMarketOrder forçar o
   * volume mínimo (ex: XAU 1 lote = 100 onças) e abrir posição gigante.
   */
  async closePosition(positionId: string, volumeProtocol: number, timeoutMs = 15000): Promise<any> {
    await this.connect();
    const accountId = Number(this.creds.accountId);

    // O ProtoOAClosePositionReq NÃO carrega clientOrderId — a confirmação
    // chega como ProtoOAExecutionEvent com o positionId da posição fechada.
    // Por isso o waitForFill aqui filtra por positionId (não por clientOrderId).
    const fillPromise = this.waitForCloseFill(positionId, timeoutMs);

    log.info(`📤 [CTRADER-ADAPTER] Enviando ProtoOAClosePositionReq para positionId=${positionId} (volume ${volumeProtocol} / 100)...`);
    this.client.sendFireAndForget(
      PAYLOAD_TYPE.PROTO_OA_CLOSE_POSITION_REQ,
      'ProtoOAClosePositionReq',
      {
        ctidTraderAccountId: accountId,
        positionId: Number(positionId),
        volume: Math.round(volumeProtocol),
      },
    );

    try {
      return await fillPromise;
    } catch (e: any) {
      const msg = e?.message || '';
      if (msg.includes('OA_AUTH_TOKEN_EXPIRED') || msg.includes('CH_ACCESS_TOKEN_INVALID')) {
        log.warn('⚠️ CtraderAdapter: token expirado ao fechar posição. Tentando refresh...');
        await this.refreshTokenAndReconnect();
        return this.closePosition(positionId, volumeProtocol, timeoutMs);
      }
      throw e;
    }
  }

  private waitForCloseFill(positionId: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.client.offExecution(handler);
        reject(new Error(`CtraderAdapter: timeout aguardando fill do fechamento da posição ${positionId}`));
      }, timeoutMs);

      const handler = (evt: any) => {
        const order = evt.order || {};
        const evtPositionId = evt.position?.positionId != null
          ? String(evt.position.positionId)
          : (order.positionId != null ? String(order.positionId) : null);
        if (evtPositionId !== String(positionId)) return;
        if (evt.executionType === EXECUTION_TYPE.ORDER_FILLED) {
          clearTimeout(timer);
          this.client.offExecution(handler);
          const deal = evt.deal || {};
          resolve({
            id: String(order.orderId || deal.dealId || ''),
            positionId,
            price: order.executionPrice != null ? Number(order.executionPrice) : 0,
            amount: Number(deal.filledVolume || 0),
          });
        } else if (evt.executionType === EXECUTION_TYPE.ORDER_REJECTED || evt.errorCode) {
          clearTimeout(timer);
          this.client.offExecution(handler);
          reject(new Error(`CtraderAdapter: fechamento rejeitado (${evt.errorCode || 'ORDER_REJECTED'})`));
        }
      };
      this.client.onExecution(handler);
    });
  }

  async fetchOrderBook(symbol: string, limit = 1): Promise<any> {
    const t = await this.fetchTicker(symbol);
    return {
      bids: t.bid > 0 ? [[t.bid, 0]] : [],
      asks: t.ask > 0 ? [[t.ask, 0]] : [],
    };
  }

  // ─── Conta / PnL / Margem / Histórico ────────────────────────────────────────

  /** Saldo, equity, margem livre e alavancagem da conta. */
  async fetchAccountInfo(): Promise<any> {
    await this.connect();
    const accountId = Number(this.creds.accountId);
    const res = await this.client.sendRequest(
      PAYLOAD_TYPE.PROTO_OA_TRADER_REQ,
      'ProtoOATraderReq',
      { ctidTraderAccountId: accountId },
      10000,
    );
    if (res.payloadType === PAYLOAD_TYPE.PROTO_OA_ERROR_RES) {
      throw new Error(`CtraderAdapter: erro ao obter conta: ${res.errorCode} ${res.description || ''}`);
    }
    const trader = res.trader || {};
    const moneyDigits = trader.moneyDigits != null ? Number(trader.moneyDigits) : 8;
    const div = Math.pow(10, moneyDigits);
    const leverage = trader.leverageInCents != null ? Number(trader.leverageInCents) / 100 : 0;
    return {
      balance: Number(trader.balance || 0) / div,
      equity: Number(trader.balance || 0) / div, // sem equity explícito; balance é o mais próximo disponível via TraderReq
      leverage,
      currency: String(trader.depositAssetId || ''),
      moneyDigits,
    };
  }

  /** Estimativa de margem (em unidades) para um símbolo e volume (1/100 lote). */
  async checkMargin(symbol: string, volumeProtocol: number): Promise<{ ok: boolean; margin: number; error?: string }> {
    await this.connect();
    const market = this.resolveSymbol(symbol);
    if (!market) return { ok: false, margin: 0, error: `Símbolo desconhecido: ${symbol}` };
    const accountId = Number(this.creds.accountId);
    const res = await this.client.sendRequest(
      PAYLOAD_TYPE.PROTO_OA_EXPECTED_MARGIN_REQ,
      'ProtoOAExpectedMarginReq',
      { ctidTraderAccountId: accountId, symbolId: Number(market.id), volume: [volumeProtocol] },
      10000,
    );
    if (res.payloadType === PAYLOAD_TYPE.PROTO_OA_ERROR_RES) {
      return { ok: false, margin: 0, error: `${res.errorCode} ${res.description || ''}` };
    }
    const moneyDigits = res.moneyDigits != null ? Number(res.moneyDigits) : 8;
    const div = Math.pow(10, moneyDigits);
    const marginRow = (res.margin || [])[0];
    // Usa o maior entre buy/sell (conservador)
    const margin = Math.max(Number(marginRow?.buyMargin || 0), Number(marginRow?.sellMargin || 0)) / div;
    return { ok: true, margin };
  }

  /**
   * PnL não realizado em tempo real das posições abertas.
   * Usa ProtoOAReconcileReq para mapear positionId → símbolo e
   * ProtoOAGetPositionUnrealizedPnLReq para o PnL.
   * Retorna: Map<symbol, { positionId, netPnl, grossPnl, volume, side }>
   */
  async getPositionsPnL(): Promise<Map<string, { positionId: string; netPnl: number; grossPnl: number; volume: number; side: string }>> {
    await this.connect();
    const accountId = Number(this.creds.accountId);
    const out = new Map<string, { positionId: string; netPnl: number; grossPnl: number; volume: number; side: string }>();

    // 1. Posições abertas (reconcile) para mapear positionId → symbol/volume/side
    const rec = await this.client.sendRequest(
      PAYLOAD_TYPE.PROTO_OA_RECONCILE_REQ,
      'ProtoOAReconcileReq',
      { ctidTraderAccountId: accountId },
      10000,
    );
    if (rec.payloadType === PAYLOAD_TYPE.PROTO_OA_ERROR_RES) {
      log.warn(`⚠️ CtraderAdapter: erro no reconcile: ${rec.errorCode} ${rec.description || ''}`);
      return out;
    }
    const positionToSymbol = new Map<string, { symbol: string; volume: number; side: string }>();
    for (const pos of (rec.position || []) as any[]) {
      const market = this.marketsById.get(String(pos.tradeData?.symbolId));
      const volume = Number(pos.tradeData?.volume || 0) / VOLUME_DIVISOR;
      positionToSymbol.set(String(pos.positionId), {
        symbol: market?.symbol || String(pos.tradeData?.symbolId || pos.positionId),
        volume,
        side: pos.tradeData?.tradeSide === TRADE_SIDE.BUY ? 'buy' : 'sell',
      });
    }
    if (positionToSymbol.size === 0) return out;

    // 2. PnL não realizado por posição
    const res = await this.client.sendRequest(
      PAYLOAD_TYPE.PROTO_OA_GET_POSITION_UNREALIZED_PNL_REQ,
      'ProtoOAGetPositionUnrealizedPnLReq',
      { ctidTraderAccountId: accountId },
      10000,
    );
    if (res.payloadType === PAYLOAD_TYPE.PROTO_OA_ERROR_RES) {
      log.warn(`⚠️ CtraderAdapter: erro no PnL não realizado: ${res.errorCode} ${res.description || ''}`);
      return out;
    }
    const moneyDigits = res.moneyDigits != null ? Number(res.moneyDigits) : 8;
    const div = Math.pow(10, moneyDigits);
    for (const row of (res.positionUnrealizedPnL || []) as any[]) {
      const meta = positionToSymbol.get(String(row.positionId));
      if (!meta) continue;
      out.set(meta.symbol, {
        positionId: String(row.positionId),
        netPnl: Number(row.netUnrealizedPnL || 0) / div,
        grossPnl: Number(row.grossUnrealizedPnL || 0) / div,
        volume: meta.volume,
        side: meta.side,
      });
    }
    return out;
  }

  /**
   * Lista deals (execuções) de um período. `fromTs`/`toTs` em ms.
   * Cada deal: { dealId, orderId, positionId, symbol, volume, price, side, fee, executedAt }
   */
  async fetchDeals(fromTs: number, toTs: number, maxRows = 100): Promise<any[]> {
    await this.connect();
    const accountId = Number(this.creds.accountId);
    const res = await this.client.sendRequest(
      PAYLOAD_TYPE.PROTO_OA_DEAL_LIST_REQ,
      'ProtoOADealListReq',
      { ctidTraderAccountId: accountId, fromTimestamp: fromTs, toTimestamp: toTs, maxRows },
      15000,
    );
    if (res.payloadType === PAYLOAD_TYPE.PROTO_OA_ERROR_RES) {
      throw new Error(`CtraderAdapter: erro ao listar deals: ${res.errorCode} ${res.description || ''}`);
    }
    const out: any[] = [];
    for (const deal of (res.deal || []) as any[]) {
      const market = this.marketsById.get(String(deal.symbolId));
      const moneyDigits = deal.moneyDigits != null ? Number(deal.moneyDigits) : 8;
      out.push({
        dealId: String(deal.dealId),
        orderId: String(deal.orderId),
        positionId: String(deal.positionId),
        symbol: market?.symbol || String(deal.symbolId),
        volume: Number(deal.filledVolume || 0) / VOLUME_DIVISOR,
        price: Number(deal.executionPrice || 0),
        side: deal.tradeSide === TRADE_SIDE.BUY ? 'buy' : 'sell',
        fee: Number(deal.commission || 0) / Math.pow(10, moneyDigits),
        executedAt: Number(deal.executionTimestamp || 0),
      });
    }
    return out;
  }

  /** PnL realizado recente (últimas N horas) via deals, em moeda da conta. */
  async fetchRecentDealsPnl(hours = 24): Promise<{ pnl: number; count: number }> {
    const toTs = Date.now();
    const fromTs = toTs - hours * 3600 * 1000;
    const deals = await this.fetchDeals(fromTs, toTs, 500);
    // O fechamento de uma posição gera deals que se compensam; o pnl líquido
    // aproximado é a soma das comissões (negativo) + variação de preço das pernas.
    // Para reconciliação, retornamos a soma das comissões e o volume total.
    const totalFee = deals.reduce((acc, d) => acc + (d.fee || 0), 0);
    return { pnl: -totalFee, count: deals.length };
  }

  async destroy() {
    await this.client.destroy().catch(() => {});
    // Limpa a assinatura de spots: numa reconexão futura (novo adaptador ou
    // reconnect), os spots precisam ser re-assinados do zero. Sem isso, o set
    // `subscribed` persistia e o fetchTickers nunca recebia o primeiro tick.
    this.subscribed.clear();
    this.tickers.clear();
  }

  getCreds(): CtraderCredentials {
    return { ...this.creds };
  }
}
