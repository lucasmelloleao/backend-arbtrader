// Protocolo FIX 4.4 (subconjunto cTrader/Pepperstone):
//  - encoding/decoding de mensagens (campos tag=valor separados por SOH)
//  - checksum (tag 10) e BodyLength (tag 9)
//  - construção de header padrão e mensagens de sessão (Logon/Heartbeat/TestRequest/Logout)
//  - gerenciamento de sequência e reconexão
import * as tls from 'tls';

const log = {
  info: (...args: any[]) => console.log('[FIX-PROTOCOL]', ...args),
  warn: (...args: any[]) => console.warn('[FIX-PROTOCOL]', ...args),
  error: (...args: any[]) => console.error('[FIX-PROTOCOL]', ...args),
};

export const SOH = '\u0001';

export type FixSessionConfig = {
  host: string;
  port: number;           // porta SSL (5211/5212)
  senderCompId: string;   // ex: live.pepperstone.1382148
  targetCompId?: string;  // CSERVER
  targetSubId: 'QUOTE' | 'TRADE';
  senderSubId?: string;
  username: string;       // login numérico da conta
  password: string;
  heartBtInt?: number;    // default 30
};

export type FixMessage = {
  msgType: string;        // tag 35
  seqNum: number;         // tag 34
  sendingTime: string;    // tag 52
  body: Record<string, string>; // campos do corpo (sem header)
  raw: string;
};

// ─── Encoding ──────────────────────────────────────────────────────────────────

export function encodeFix(header: Record<string, string>, body: Record<string, string>): string {
  const parts: string[] = [];
  // Header padrão (ordem exigida: 8, 9, 35, 49, 56, 34, 52, 57, 50)
  const ordered = [
    ['8', 'FIX.4.4'],
    ['9', '__BODY_LENGTH__'],
    ['35', header['35'] || ''],
    ['49', header['49'] || ''],
    ['56', header['56'] || ''],
    ['34', header['34'] || '1'],
    ['52', header['52'] || nowUtc()],
    ...(header['57'] ? [['57', header['57']]] : []),
    ...(header['50'] ? [['50', header['50']]] : []),
  ];
  // Corpo
  const bodyParts = Object.entries(body).map(([k, v]) => `${k}=${v}`);
  const bodyLen = ordered.filter(([, v]) => v !== '__BODY_LENGTH__').reduce((acc, [k, v]) => acc + `${k}=${v}${SOH}`.length, 0)
    + bodyParts.reduce((acc, p) => acc + `${p}${SOH}`.length, 0);

  let msg = '';
  for (const [k, v] of ordered) {
    if (k === '9') {
      msg += `9=${bodyLen}${SOH}`;
    } else {
      msg += `${k}=${v}${SOH}`;
    }
  }
  msg += bodyParts.join(SOH) + (bodyParts.length ? SOH : '');
  const checksum = computeChecksum(msg);
  msg += `10=${checksum}${SOH}`;
  return msg;
}

/** Variante que aceita um corpo bruto (para repeating groups: "55=1|55=2|269=0|269=1"). */
export function encodeFixWithRawBody(header: Record<string, string>, body: Record<string, string>, rawBody: string): string {
  const ordered = [
    ['8', 'FIX.4.4'],
    ['9', '__BODY_LENGTH__'],
    ['35', header['35'] || ''],
    ['49', header['49'] || ''],
    ['56', header['56'] || ''],
    ['34', header['34'] || '1'],
    ['52', header['52'] || nowUtc()],
    ...(header['57'] ? [['57', header['57']]] : []),
    ...(header['50'] ? [['50', header['50']]] : []),
  ];
  const bodyParts = Object.entries(body).map(([k, v]) => `${k}=${v}`);
  const rawParts = rawBody.split(SOH).filter(Boolean);
  const bodyLen = ordered.filter(([, v]) => v !== '__BODY_LENGTH__').reduce((acc, [k, v]) => acc + `${k}=${v}${SOH}`.length, 0)
    + bodyParts.reduce((acc, p) => acc + `${p}${SOH}`.length, 0)
    + rawParts.reduce((acc, p) => acc + `${p}${SOH}`.length, 0);

  let msg = '';
  for (const [k, v] of ordered) {
    if (k === '9') {
      msg += `9=${bodyLen}${SOH}`;
    } else {
      msg += `${k}=${v}${SOH}`;
    }
  }
  msg += bodyParts.join(SOH) + (bodyParts.length ? SOH : '');
  msg += rawParts.join(SOH) + (rawParts.length ? SOH : '');
  const checksum = computeChecksum(msg);
  msg += `10=${checksum}${SOH}`;
  return msg;
}

export function computeChecksum(msg: string): string {
  // Soma dos bytes de toda a mensagem até (exclusive) o campo 10=
  let sum = 0;
  for (let i = 0; i < msg.length; i++) {
    sum += msg.charCodeAt(i);
  }
  return String(sum % 256).padStart(3, '0');
}

export function nowUtc(): string {
  const d = new Date();
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

// ─── Decoding ──────────────────────────────────────────────────────────────────

export function parseFixMessage(raw: string): FixMessage | null {
  const bodyStart = raw.indexOf(`${SOH}9=`);
  if (bodyStart === -1) return null;
  // Após "8=FIX.4.4|9=<len>|" vem o resto
  const afterBodyLen = raw.indexOf(SOH, bodyStart);
  if (afterBodyLen === -1) return null;
  const headerAndBody = raw.slice(afterBodyLen + 1);
  const checkSumIdx = headerAndBody.lastIndexOf(`${SOH}10=`);
  const bodyPart = checkSumIdx === -1 ? headerAndBody : headerAndBody.slice(0, checkSumIdx);
  const fields = bodyPart.split(SOH).filter(Boolean);
  const map: Record<string, string> = {};
  for (const f of fields) {
    const eq = f.indexOf('=');
    if (eq === -1) continue;
    map[f.slice(0, eq)] = f.slice(eq + 1);
  }
  return {
    msgType: map['35'] || '',
    seqNum: Number(map['34'] || 0),
    sendingTime: map['52'] || '',
    body: map,
    raw,
  };
}

export function verifyChecksum(raw: string): boolean {
  const idx = raw.lastIndexOf(`${SOH}10=`);
  if (idx === -1) return false;
  const msgPart = raw.slice(0, idx + 1); // inclui o SOH antes do 10=
  const actual = raw.slice(idx + 4, idx + 7);
  return computeChecksum(msgPart) === actual;
}

// ─── Sessão ────────────────────────────────────────────────────────────────────

export type FixHandlers = {
  onMessage: (msg: FixMessage) => void;
  onLogon?: () => void;
  onClose?: (err?: Error) => void;
};

export class FixSession {
  private socket: tls.TLSSocket | null = null;
  private outSeq = 1;
  private inSeq = 1;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private testReqTimer: ReturnType<typeof setInterval> | null = null;
  private lastReceivedAt = Date.now();
  private logonSent = false;
  private closed = false;

  constructor(private cfg: FixSessionConfig, private handlers: FixHandlers) {}

  get targetSubId() { return this.cfg.targetSubId; }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { host, port } = this.cfg;
      const onConnect = () => {
        this.logonSent = true;
        this.sendLogon();
        // Aguarda a resposta do logon (resolver no onMessage quando 35=A recebida)
        this.logonResolve = resolve;
        this.logonReject = reject;
        setTimeout(() => {
          if (this.logonResolve) {
            this.logonReject?.(new Error(`FIX logon timeout (${host}:${port}, ${this.cfg.targetSubId})`));
            this.logonResolve = null;
          }
        }, 15000);
      };

      const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
        // 'connect' callback do tls dispara após o handshake TLS
        if (this.logonSent) return; // já conectou
        onConnect();
      });

      socket.on('data', (data: Buffer) => this.handleData(data));
      socket.on('error', (err) => {
        log.error(`❌ FIX ${this.cfg.targetSubId} socket error: ${err.message}`);
        this.handlers.onClose?.(err);
        if (this.logonReject) { this.logonReject(err); this.logonReject = null; }
      });
      socket.on('close', () => {
        this.stopHeartbeat();
        this.handlers.onClose?.();
        if (this.logonReject) { this.logonReject(new Error('FIX socket fechado antes do logon')); this.logonReject = null; }
      });
      this.socket = socket;
    });
  }

  private logonResolve: (() => void) | null = null;
  private logonReject: ((e: Error) => void) | null = null;

  private buffer = '';

  private handleData(data: Buffer) {
    this.lastReceivedAt = Date.now();
    this.buffer += data.toString('utf8');
    // Extrai mensagens completas usando o BodyLength (tag 9)
    let idx = this.buffer.indexOf(`${SOH}9=`);
    while (idx !== -1) {
      const lenEnd = this.buffer.indexOf(SOH, idx + 3);
      if (lenEnd === -1) break;
      const bodyLen = Number(this.buffer.slice(idx + 3, lenEnd));
      if (isNaN(bodyLen)) break;
      // Tamanho total: header (até o fim do 9=...) + bodyLen + trailer (10=xxx<SOH> = 8 bytes)
      const totalLen = lenEnd + 1 + bodyLen + 8;
      if (this.buffer.length < totalLen) break; // aguarda mais dados
      const raw = this.buffer.slice(0, totalLen);
      this.buffer = this.buffer.slice(totalLen);
      this.processRawMessage(raw);
      idx = this.buffer.indexOf(`${SOH}9=`);
    }
  }

  private processRawMessage(raw: string) {
    if (!verifyChecksum(raw)) {
      log.warn(`⚠️ FIX ${this.cfg.targetSubId}: checksum inválido, ignorando mensagem`);
      return;
    }
    const parsed = parseFixMessage(raw);
    if (!parsed) return;
    this.inSeq = Math.max(this.inSeq, parsed.seqNum + 1);
    this.handleMessage(parsed);
  }

  private handleMessage(msg: FixMessage) {
    switch (msg.msgType) {
      case 'A': // Logon
        if (this.logonResolve) {
          this.logonResolve();
          this.logonResolve = null;
        }
        this.handlers.onLogon?.();
        this.startHeartbeat();
        break;
      case '1': // Test Request
        this.sendHeartbeat(msg.body['112'] || '');
        break;
      case '0': // Heartbeat
        break;
      case '2': // Resend Request — responde com Sequence Reset (GapFill)
        this.sendSequenceReset(msg.body['7'] || '1', msg.body['16'] || '0');
        break;
      case '5': // Logout — se estávamos aguardando logon, propaga o erro (ex: senha errada)
        this.stopHeartbeat();
        if (this.logonReject) {
          const reason = msg.body['58'] || 'FIX logon rejeitado (Logout)';
          this.logonReject(new Error(`FIX logon falhou: ${reason}`));
          this.logonReject = null;
          this.logonResolve = null;
        }
        this.handlers.onClose?.();
        break;
      default:
        this.handlers.onMessage(msg);
    }
  }

  send(msgType: string, body: Record<string, string> = {}, rawBody?: string) {
    if (!this.socket || this.socket.destroyed) throw new Error('FIX socket não está aberto');
    const header: Record<string, string> = {
      '35': msgType,
      '49': this.cfg.senderCompId,
      '56': this.cfg.targetCompId || 'CSERVER',
      '34': String(this.outSeq),
      '52': nowUtc(),
    };
    if (this.cfg.targetSubId) header['57'] = this.cfg.targetSubId;
    if (this.cfg.senderSubId) header['50'] = this.cfg.senderSubId;
    const raw = rawBody
      ? encodeFixWithRawBody(header, body, rawBody)
      : encodeFix(header, body);
    this.outSeq++;
    this.socket.write(raw);
  }

  private sendLogon() {
    this.send('A', {
      '98': '0',                       // EncryptMethod: none
      '108': String(this.cfg.heartBtInt || 30),
      '141': 'Y',                      // ResetSeqNumFlag
      '553': this.cfg.username,
      '554': this.cfg.password,
    });
  }

  sendHeartbeat(testReqId?: string) {
    this.send('0', testReqId ? { '112': testReqId } : {});
  }

  private sendSequenceReset(beginSeqNo: string, endSeqNo: string) {
    const newSeq = endSeqNo === '0' ? beginSeqNo : String(Number(endSeqNo) + 1);
    this.send('4', { '123': 'Y', '36': newSeq });
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    const interval = Math.max(10, this.cfg.heartBtInt || 30);
    this.heartbeatTimer = setInterval(() => {
      // Se não recebemos nada há 2x o intervalo, envia Test Request
      if (Date.now() - this.lastReceivedAt > interval * 2000) {
        this.send('1', { '112': `TR${Date.now()}` });
      } else {
        this.sendHeartbeat();
      }
    }, interval * 1000);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.testReqTimer) { clearInterval(this.testReqTimer); this.testReqTimer = null; }
  }

  disconnect() {
    this.closed = true;
    this.stopHeartbeat();
    try { this.send('5', {}); } catch { /* socket já fechado */ }
    setTimeout(() => { try { this.socket?.destroy(); } catch {} }, 500);
  }

  get isConnected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed && this.logonSent);
  }
}
