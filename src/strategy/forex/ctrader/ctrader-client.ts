// Cliente WebSocket da cTrader Open API (protobuf).
// Conecta a wss://<live|demo>.ctraderapi.com:5035 e gerencia:
//  - handshake (ApplicationAuth -> AccountAuth)
//  - heartbeat (ProtoHeartbeatEvent a cada 10s)
//  - correlação requisição/resposta (clientMsgId -> resolver)
//  - reconexão com backoff exponencial (padrão ws-client.ts) + re-auth
//  - eventos (spot, execution, orderError) via callbacks
import WebSocket from 'ws';
import protobuf from 'protobufjs';
import * as path from 'path';

const log = {
  info: (...args: any[]) => console.log('[CTRADER-CLIENT]', ...args),
  warn: (...args: any[]) => console.warn('[CTRADER-CLIENT]', ...args),
  error: (...args: any[]) => console.error('[CTRADER-CLIENT]', ...args),
};

export const CTRADER_HOSTS = {
  live: 'wss://live.ctraderapi.com:5035',
  demo: 'wss://demo.ctraderapi.com:5035',
} as const;

export const CTRADER_TOKEN_URL = 'https://openapi.ctrader.com/apps/token';

export type CtraderCredentials = {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken?: string;
  accountId: string;      // ctidTraderAccountId
  environment?: 'live' | 'demo';
};

export type CtraderHandlers = {
  onSpot?: (evt: any) => void;               // ProtoOASpotEvent decodificado
  onExecution?: (evt: any) => void;          // ProtoOAExecutionEvent decodificado
  onOrderError?: (evt: any) => void;         // ProtoOAOrderErrorEvent
  onDisconnect?: (reason?: string) => void;
};

// Payload types (enum ProtoOAPayloadType) que usamos.
export const PAYLOAD_TYPE = {
  PROTO_OA_APPLICATION_AUTH_REQ: 2100,
  PROTO_OA_APPLICATION_AUTH_RES: 2101,
  PROTO_OA_ACCOUNT_AUTH_REQ: 2102,
  PROTO_OA_ACCOUNT_AUTH_RES: 2103,
  PROTO_OA_NEW_ORDER_REQ: 2106,
  PROTO_OA_CLOSE_POSITION_REQ: 2111,
  PROTO_OA_ASSET_LIST_REQ: 2112,
  PROTO_OA_ASSET_LIST_RES: 2113,
  PROTO_OA_SYMBOLS_LIST_REQ: 2114,
  PROTO_OA_SYMBOLS_LIST_RES: 2115,
  PROTO_OA_SYMBOL_BY_ID_REQ: 2116,
  PROTO_OA_SYMBOL_BY_ID_RES: 2117,
  PROTO_OA_TRADER_REQ: 2121,
  PROTO_OA_TRADER_RES: 2122,
  PROTO_OA_RECONCILE_REQ: 2124,
  PROTO_OA_RECONCILE_RES: 2125,
  PROTO_OA_EXECUTION_EVENT: 2126,
  PROTO_OA_SUBSCRIBE_SPOTS_REQ: 2127,
  PROTO_OA_SUBSCRIBE_SPOTS_RES: 2128,
  PROTO_OA_UNSUBSCRIBE_SPOTS_REQ: 2129,
  PROTO_OA_UNSUBSCRIBE_SPOTS_RES: 2130,
  PROTO_OA_SPOT_EVENT: 2131,
  PROTO_OA_ORDER_ERROR_EVENT: 2132,
  PROTO_OA_DEAL_LIST_REQ: 2133,
  PROTO_OA_DEAL_LIST_RES: 2134,
  PROTO_OA_EXPECTED_MARGIN_REQ: 2139,
  PROTO_OA_EXPECTED_MARGIN_RES: 2140,
  PROTO_OA_ERROR_RES: 2142,
  PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ: 2149,
  PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_RES: 2150,
  PROTO_OA_ACCOUNTS_TOKEN_INVALIDATED_EVENT: 2147,
  PROTO_OA_ACCOUNT_LOGOUT_REQ: 2162,
  PROTO_OA_ACCOUNT_LOGOUT_RES: 2163,
  PROTO_OA_REFRESH_TOKEN_REQ: 2173,
  PROTO_OA_REFRESH_TOKEN_RES: 2174,
  PROTO_OA_GET_POSITION_UNREALIZED_PNL_REQ: 2187,
  PROTO_OA_GET_POSITION_UNREALIZED_PNL_RES: 2188,
} as const;

// Ordem: MARKET=1, LIMIT=2, STOP=3
export const ORDER_TYPE = { MARKET: 1, LIMIT: 2, STOP: 3 } as const;
// TradeSide: BUY=1, SELL=2
export const TRADE_SIDE = { BUY: 1, SELL: 2 } as const;
// ExecutionType: ORDER_FILLED=3
export const EXECUTION_TYPE = { ORDER_ACCEPTED: 2, ORDER_FILLED: 3, ORDER_REJECTED: 7 } as const;

let _rootPromise: Promise<protobuf.Root> | null = null;
function getRoot(): Promise<protobuf.Root> {
  if (!_rootPromise) {
    const protoDir = path.join(__dirname, 'proto');
    _rootPromise = protobuf.load([
      path.join(protoDir, 'OpenApiCommonModelMessages.proto'),
      path.join(protoDir, 'OpenApiCommonMessages.proto'),
      path.join(protoDir, 'OpenApiModelMessages.proto'),
      path.join(protoDir, 'OpenApiMessages.proto'),
    ]);
  }
  return _rootPromise!;
}

function messageType(root: protobuf.Root, name: string): protobuf.Type {
  const t = root.lookupType(name);
  if (!t) throw new Error(`Tipo protobuf não encontrado: ${name}`);
  return t;
}

let _msgId = 0;
function nextClientMsgId(prefix = 'fa'): string {
  _msgId = (_msgId + 1) % 100000;
  return `${prefix}${Date.now()}_${_msgId}`;
}

export class CtraderClient {
  private creds: CtraderCredentials;
  private handlers: CtraderHandlers;
  private ws: WebSocket | null = null;
  private closeFn: (() => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private accountAuthed = false;
  private appAuthed = false;
  private lastSpotBySymbol = new Map<string, any>();
  private connecting: Promise<void> | null = null;
  private destroyed = false;
  private executionHandlers = new Set<(evt: any) => void>();

  constructor(creds: CtraderCredentials, handlers: CtraderHandlers = {}) {
    this.creds = creds;
    this.handlers = handlers;
  }

  get environment(): 'live' | 'demo' {
    return this.creds.environment === 'demo' ? 'demo' : 'live';
  }

  /** Abre a conexão e autentica (app + account). Idempotente. */
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.accountAuthed) return;

    this.connecting = new Promise<void>((resolve, reject) => {
      const url = CTRADER_HOSTS[this.environment];
      let settled = false;
      let t: ReturnType<typeof setTimeout> | null = null;

      const fail = (err: Error) => {
        if (!settled) {
          settled = true;
          if (t) clearTimeout(t);
          reject(err);
        }
      };

      const ws = new WebSocket(url);
      this.ws = ws;

      ws.on('open', () => {
        this.startHeartbeat();
        this.authenticate().then(() => {
          if (!settled) {
            settled = true;
            if (t) clearTimeout(t);
            resolve();
          }
        }).catch(fail);
      });

      ws.on('message', (data: any) => this.handleMessage(data));
      ws.on('error', (err: any) => {
        log.error(`❌ CtraderClient WS error: ${err.message}`);
        fail(err);
      });
      ws.on('close', () => {
        // Conexão caiu: notifica handlers (ex.: adapter limpa assinaturas de spot).
        this.accountAuthed = false;
        this.appAuthed = false;
        this.handlers.onDisconnect?.('WebSocket fechado');
      });

      this.closeFn = () => {
        try { ws.close(); } catch {}
      };

      // Timeout global do handshake (a reconexão tenta de novo)
      t = setTimeout(() => fail(new Error(`CtraderClient: timeout de conexão (${url})`)), 20000);
    });

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendHeartbeat();
      }
    }, 10000);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat() {
    // ProtoHeartbeatEvent: payload com payloadType=51 (HEARTBEAT_EVENT)
    getRoot().then((root) => {
      const hbType = messageType(root, 'ProtoHeartbeatEvent');
      const buf = Buffer.from(hbType.encode(hbType.fromObject({})).finish());
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendRaw(0, buf);
      }
    }).catch((e) => log.error('❌ CtraderClient heartbeat:', e.message));
  }

  private async authenticate() {
    const root = await getRoot();
    const appAuth = messageType(root, 'ProtoOAApplicationAuthReq');
    const accAuth = messageType(root, 'ProtoOAAccountAuthReq');
    const accList = messageType(root, 'ProtoOAGetAccountListByAccessTokenReq');

    // 1. Autentica a aplicação (clientId + clientSecret)
    this.appAuthed = false;
    const appRes = await this.request(
      PAYLOAD_TYPE.PROTO_OA_APPLICATION_AUTH_REQ,
      appAuth,
      { clientId: this.creds.clientId, clientSecret: this.creds.clientSecret },
      10000,
    );
    if (appRes.payloadType === PAYLOAD_TYPE.PROTO_OA_ERROR_RES) {
      throw new Error(`CtraderClient: falha na autenticação do app: ${appRes.errorCode} ${appRes.description || ''}`);
    }
    this.appAuthed = true;
    log.info(`✅ CtraderClient: aplicação autorizada (${this.environment})`);

    // 2. Valida o access token e descobre as contas (se accountId não foi fornecido)
    let accountId = this.creds.accountId;
    if (!accountId) {
      const listRes = await this.request(
        PAYLOAD_TYPE.PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ,
        accList,
        { accessToken: this.creds.accessToken },
        10000,
      );
      if (listRes.payloadType === PAYLOAD_TYPE.PROTO_OA_ERROR_RES) {
        throw new Error(`CtraderClient: token inválido: ${listRes.errorCode} ${listRes.description || ''}`);
      }
      const accounts = listRes.ctidTraderAccount || [];
      log.info('📋 CONTAS CTRADER AUTORIZADAS NO ACCESS TOKEN:', JSON.stringify(accounts));
      if (!accounts.length) throw new Error('CtraderClient: nenhuma conta associada ao access token');
      // Prefere conta do ambiente correto
      const matching = accounts.find((a: any) => this.environment === 'live' ? a.isLive : !a.isLive);
      accountId = String(matching?.ctidTraderAccountId || accounts[0].ctidTraderAccountId);
    }

    // 3. Autentica a conta de trading
    this.accountAuthed = false;
    const accRes = await this.request(
      PAYLOAD_TYPE.PROTO_OA_ACCOUNT_AUTH_REQ,
      accAuth,
      { ctidTraderAccountId: Number(accountId), accessToken: this.creds.accessToken },
      10000,
    );
    if (accRes.payloadType === PAYLOAD_TYPE.PROTO_OA_ERROR_RES) {
      const code = accRes.errorCode;
      if (code === 'OA_AUTH_TOKEN_EXPIRED' || code === 'CH_ACCESS_TOKEN_INVALID') {
        throw new CtraderTokenExpiredError('Access token expirado; necessário refresh');
      }
      throw new Error(`CtraderClient: falha na autenticação da conta: ${code} ${accRes.description || ''}`);
    }
    this.accountAuthed = true;
    this.creds.accountId = String(accountId);
    log.info(`✅ CtraderClient: conta autorizada (accountId=${accountId})`);
  }

  /** Envia um payload protobuf e aguarda a resposta correlacionada por clientMsgId. */
  private request(payloadType: number, type: protobuf.Type, payloadObj: any, timeoutMs = 10000): Promise<any> {
    const clientMsgId = nextClientMsgId();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientMsgId);
        reject(new Error(`CtraderClient: timeout aguardando resposta de payloadType=${payloadType}`));
      }, timeoutMs);
      this.pending.set(clientMsgId, { resolve, reject, timer });
      try {
        this.sendRaw(payloadType, Buffer.from(type.encode(type.fromObject(payloadObj)).finish()), clientMsgId);
      } catch (e: any) {
        clearTimeout(timer);
        this.pending.delete(clientMsgId);
        reject(new Error(`CtraderClient: erro ao serializar payloadType=${payloadType}: ${e.message}`));
      }
    });
  }

  private sendRaw(payloadType: number, payload: Buffer, clientMsgId?: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CtraderClient: WebSocket não está aberto');
    }
    getRoot().then((root) => {
      const protoMessage = messageType(root, 'ProtoMessage');
      const msg: any = { payloadType };
      if (payload.length > 0) msg.payload = payload;
      if (clientMsgId) msg.clientMsgId = clientMsgId;
      const buf = protoMessage.encode(protoMessage.fromObject(msg)).finish();
      this.ws!.send(buf);
    }).catch((e) => log.error('❌ CtraderClient sendRaw:', e.message));
  }

  private handleMessage(data: WebSocket.Data) {
    getRoot().then((root) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : (data as Buffer);
      const protoMessage = messageType(root, 'ProtoMessage');
      let envelope: any;
      try {
        envelope = protoMessage.decode(buf);
      } catch (e: any) {
        log.warn('⚠️ CtraderClient: mensagem protobuf inválida recebida:', e.message);
        return;
      }
      const payloadType = envelope.payloadType;
      const clientMsgId = envelope.clientMsgId;
      const payload = envelope.payload ? envelope.payload : null;

      // ProtoHeartbeatEvent: o server envia payloadType=0 no envelope com o
      // ProtoHeartbeatEvent (payloadType=51) dentro do payload.
      if (payloadType === 0 && payload) {
        try {
          const hb: any = messageType(root, 'ProtoHeartbeatEvent').decode(payload);
          if (hb.payloadType === 51) return; // heartbeat
        } catch { /* não é heartbeat */ }
      }
      if (payloadType === 0 && !payload) return;

      // Se tem clientMsgId, é resposta a uma requisição nossa.
      // Exceção: ProtoOAExecutionEvent é um EVENTO (fill/rejeição da ordem)
      // que a cTrader ecoa com o clientOrderId (não é resposta correlacionada
      // ao clientMsgId) — deve ir para handleEvent, não para o pending.
      if (payloadType !== PAYLOAD_TYPE.PROTO_OA_EXECUTION_EVENT && clientMsgId && this.pending.has(clientMsgId)) {
        const p = this.pending.get(clientMsgId)!;
        this.pending.delete(clientMsgId);
        clearTimeout(p.timer);
        const type = messageType(root, this.typeNameForPayload(payloadType));
        let parsed: any = {};
        try {
          parsed = payload ? type.decode(payload) : {};
          if (payload && type.verify) {
            const err = type.verify(type.toObject(parsed));
            if (err) log.warn('⚠️ CtraderClient verify:', err);
          }
        } catch (e: any) {
          p.reject(new Error(`CtraderClient: erro ao decodificar resposta payloadType=${payloadType}: ${e.message}`));
          return;
        }
        p.resolve(parsed);
        return;
      }

      // Eventos não-correlacionados
      this.handleEvent(payloadType, payload, root);
    }).catch((e) => log.error('❌ CtraderClient handleMessage:', e.message));
  }

  private handleEvent(payloadType: number, payload: Buffer | null, root: protobuf.Root) {
    const decode = (name: string): any => {
      if (!payload) return null;
      try { return messageType(root, name).decode(payload); } catch { return null; }
    };

    switch (payloadType) {
      case PAYLOAD_TYPE.PROTO_OA_SPOT_EVENT: {
        const evt = decode('ProtoOASpotEvent');
        if (evt) {
          this.lastSpotBySymbol.set(String(evt.symbolId), evt);
          this.handlers.onSpot?.(evt);
        }
        break;
      }
      case PAYLOAD_TYPE.PROTO_OA_EXECUTION_EVENT: {
        const evt = decode('ProtoOAExecutionEvent');
        if (evt) {
          for (const h of this.executionHandlers) {
            try { h(evt); } catch (e: any) { log.error('❌ CtraderClient execution handler:', e.message); }
          }
          this.handlers.onExecution?.(evt);
        }
        break;
      }
      case PAYLOAD_TYPE.PROTO_OA_ORDER_ERROR_EVENT:
        this.handlers.onOrderError?.(decode('ProtoOAOrderErrorEvent'));
        break;
      case PAYLOAD_TYPE.PROTO_OA_ACCOUNTS_TOKEN_INVALIDATED_EVENT:
        this.handlers.onDisconnect?.('Access token invalidado');
        break;
      case PAYLOAD_TYPE.PROTO_OA_ERROR_RES: {
        const err = decode('ProtoOAErrorRes');
        if (err?.errorCode === 'OA_AUTH_TOKEN_EXPIRED' || err?.errorCode === 'CH_ACCESS_TOKEN_INVALID') {
          this.handlers.onDisconnect?.(`Token expirado (${err.errorCode})`);
        }
        break;
      }
      default:
        // eventos de heartbeat/outros são ignorados silenciosamente
        break;
    }
  }

  private typeNameForPayload(payloadType: number): string {
    const map: Record<number, string> = {
      [PAYLOAD_TYPE.PROTO_OA_APPLICATION_AUTH_RES]: 'ProtoOAApplicationAuthRes',
      [PAYLOAD_TYPE.PROTO_OA_ACCOUNT_AUTH_RES]: 'ProtoOAAccountAuthRes',
      [PAYLOAD_TYPE.PROTO_OA_ASSET_LIST_RES]: 'ProtoOAAssetListRes',
      [PAYLOAD_TYPE.PROTO_OA_SYMBOLS_LIST_RES]: 'ProtoOASymbolsListRes',
      [PAYLOAD_TYPE.PROTO_OA_SYMBOL_BY_ID_RES]: 'ProtoOASymbolByIdRes',
      [PAYLOAD_TYPE.PROTO_OA_TRADER_RES]: 'ProtoOATraderRes',
      [PAYLOAD_TYPE.PROTO_OA_RECONCILE_RES]: 'ProtoOAReconcileRes',
      [PAYLOAD_TYPE.PROTO_OA_SUBSCRIBE_SPOTS_RES]: 'ProtoOASubscribeSpotsRes',
      [PAYLOAD_TYPE.PROTO_OA_UNSUBSCRIBE_SPOTS_RES]: 'ProtoOAUnsubscribeSpotsRes',
      [PAYLOAD_TYPE.PROTO_OA_DEAL_LIST_RES]: 'ProtoOADealListRes',
      [PAYLOAD_TYPE.PROTO_OA_EXPECTED_MARGIN_RES]: 'ProtoOAExpectedMarginRes',
      [PAYLOAD_TYPE.PROTO_OA_ERROR_RES]: 'ProtoOAErrorRes',
      [PAYLOAD_TYPE.PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_RES]: 'ProtoOAGetAccountListByAccessTokenRes',
      [PAYLOAD_TYPE.PROTO_OA_ACCOUNT_LOGOUT_RES]: 'ProtoOAAccountLogoutRes',
      [PAYLOAD_TYPE.PROTO_OA_REFRESH_TOKEN_RES]: 'ProtoOARefreshTokenRes',
      [PAYLOAD_TYPE.PROTO_OA_GET_POSITION_UNREALIZED_PNL_RES]: 'ProtoOAGetPositionUnrealizedPnLRes',
    };
    return map[payloadType] || 'ProtoMessage';
  }

  /** Acessa o último spot conhecido de um symbolId (sem assinar). */
  getLastSpot(symbolId: number): any {
    return this.lastSpotBySymbol.get(String(symbolId)) || null;
  }

  /** Registra handler de ProtoOAExecutionEvent (fill/rejeição de ordem). */
  onExecution(handler: (evt: any) => void): void {
    this.executionHandlers.add(handler);
  }

  /** Remove handler de execução. */
  offExecution(handler: (evt: any) => void): void {
    this.executionHandlers.delete(handler);
  }

  get isAuthed(): boolean {
    return this.appAuthed && this.accountAuthed;
  }

  get isConnected(): boolean {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN && this.accountAuthed);
  }

  /** Envia um payload protobuf qualquer (usado pelo adapter para requisições com resposta). */
  async sendRequest(payloadType: number, typeName: string, payloadObj: any, timeoutMs = 10000): Promise<any> {
    const root = await getRoot();
    const type = messageType(root, typeName);
    return this.request(payloadType, type, payloadObj, timeoutMs);
  }

  /** Envia um payload sem aguardar resposta (fire-and-forget). */
  async sendFireAndForget(payloadType: number, typeName: string, payloadObj: any) {
    const root = await getRoot();
    const type = messageType(root, typeName);
    this.sendRaw(payloadType, Buffer.from(type.encode(type.fromObject(payloadObj)).finish()), nextClientMsgId());
  }

  async destroy() {
    this.destroyed = true;
    this.stopHeartbeat();
    // Rejeita pendentes
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('CtraderClient: conexão fechada'));
    }
    this.pending.clear();
    // Logout limpo (se autenticado)
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.accountAuthed) {
      try {
        await this.sendRequest(
          PAYLOAD_TYPE.PROTO_OA_ACCOUNT_LOGOUT_REQ,
          'ProtoOAAccountLogoutReq',
          { ctidTraderAccountId: Number(this.creds.accountId) },
          3000,
        );
      } catch { /* ignora */ }
    }
    this.accountAuthed = false;
    this.appAuthed = false;
    this.closeFn?.();
    this.closeFn = null;
    this.ws = null;
  }
}

export class CtraderTokenExpiredError extends Error {
  constructor(msg: string) { super(msg); this.name = 'CtraderTokenExpiredError'; }
}
