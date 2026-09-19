import WebSocket from 'ws';

export class DerivWsClient {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private authorized = false;

  constructor(private appId: string, private apiToken: string) {}

  public async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      this.ws = new WebSocket(url);

      this.ws.on('open', async () => {
        if (this.apiToken) {
          try {
            await this.authorize();
          } catch (e) {
            console.warn('⚠️ [DerivWsClient] Falha na autorização do token:', e);
          }
        }
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          const reqId = msg.req_id;
          if (reqId && this.pendingRequests.has(reqId)) {
            const { resolve, reject } = this.pendingRequests.get(reqId)!;
            this.pendingRequests.delete(reqId);
            if (msg.error) {
              reject(new Error(msg.error.message || 'Erro Deriv API'));
            } else {
              resolve(msg);
            }
          }
        } catch {}
      });

      this.ws.on('error', (err) => {
        reject(err);
      });

      this.ws.on('close', () => {
        this.authorized = false;
      });
    });
  }

  public async send(request: any): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    return new Promise((resolve, reject) => {
      const reqId = ++this.reqId;
      const payload = { ...request, req_id: reqId };
      this.pendingRequests.set(reqId, { resolve, reject });
      this.ws!.send(JSON.stringify(payload));

      setTimeout(() => {
        if (this.pendingRequests.has(reqId)) {
          this.pendingRequests.delete(reqId);
          reject(new Error('Timeout na resposta do WebSocket Deriv'));
        }
      }, 15000);
    });
  }

  public async authorize(): Promise<any> {
    const res = await this.send({ authorize: this.apiToken });
    this.authorized = true;
    return res.authorize;
  }

  public async getProposal(params: { symbol: string; contract_type: string; amount: number; duration: number; duration_unit: string }): Promise<any> {
    const res = await this.send({
      proposal: 1,
      amount: params.amount,
      basis: 'stake',
      contract_type: params.contract_type,
      currency: 'USD',
      duration: params.duration,
      duration_unit: params.duration_unit,
      symbol: params.symbol,
    });
    return res.proposal;
  }

  public async buyContract(proposalId: string, price: number): Promise<any> {
    const res = await this.send({
      buy: proposalId,
      price: price,
    });
    return res.buy;
  }

  public async sellContract(contractId: string, price = 0): Promise<any> {
    const res = await this.send({
      sell: contractId,
      price: price,
    });
    return res.sell;
  }

  public async getOpenContract(contractId: string): Promise<any> {
    const res = await this.send({
      proposal_open_contract: 1,
      contract_id: contractId,
    });
    return res.proposal_open_contract;
  }

  public close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
