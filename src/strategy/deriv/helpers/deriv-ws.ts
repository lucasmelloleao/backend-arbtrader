import WebSocket from 'ws';
import https from 'https';

export class DerivWsClient {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private isPatToken = false;
  private selectedAccount: any = null;

  constructor(
    private appId: string,
    private apiToken: string,
    private accountType: 'demo' | 'real' = 'demo'
  ) {
    this.isPatToken = this.apiToken.startsWith('pat_');
  }

  private async fetchAccounts(): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.derivws.com',
          path: '/trading/v1/options/accounts',
          method: 'GET',
          headers: {
            'Authorization': 'Bearer ' + this.apiToken,
            'Deriv-App-ID': this.appId,
          },
        },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => {
            try {
              const json = JSON.parse(body);
              if (json.data && Array.isArray(json.data)) {
                resolve(json.data);
              } else {
                reject(new Error(json.message || 'Falha ao obter contas Deriv PAT'));
              }
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  private async fetchOtp(accountId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.derivws.com',
          path: `/trading/v1/options/accounts/${accountId}/otp`,
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + this.apiToken,
            'Deriv-App-ID': this.appId,
            'Content-Type': 'application/json',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => {
            try {
              const json = JSON.parse(body);
              const wsUrl = json.data?.url;
              if (wsUrl) {
                resolve(wsUrl);
              } else {
                reject(new Error(json.message || 'Falha ao obter OTP da Deriv'));
              }
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on('error', reject);
      req.write('{}');
      req.end();
    });
  }

  public async connect(): Promise<void> {
    let wsUrl: string;

    if (this.isPatToken) {
      try {
        const accounts = await this.fetchAccounts();
        this.selectedAccount =
          accounts.find((acc) => acc.account_type === this.accountType) ||
          accounts[0];

        if (this.selectedAccount) {
          wsUrl = await this.fetchOtp(this.selectedAccount.account_id);
        } else {
          wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
        }
      } catch (e) {
        // Se a API REST v1 falhar, conecta diretamente no WebSocket padrão
        wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      }
    } else {
      wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
    }

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', async () => {
        if (this.apiToken) {
          try {
            await this.authorize();
          } catch (e) {
            // Se falhar autorização silenciosa, continua
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
        this.selectedAccount = null;
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
    if (this.isPatToken) {
      return {
        loginid: this.selectedAccount?.account_id,
        is_virtual: this.selectedAccount?.account_type === 'demo' ? 1 : 0,
        balance: this.selectedAccount?.balance,
        currency: this.selectedAccount?.currency,
      };
    }
    const res = await this.send({ authorize: this.apiToken });
    return res.authorize;
  }

  public async getProposal(params: {
    symbol: string;
    contract_type: string;
    amount: number;
    duration: number;
    duration_unit: string;
    barrier?: string | number;
  }): Promise<any> {
    const payload: any = {
      proposal: 1,
      amount: params.amount,
      basis: 'stake',
      contract_type: params.contract_type,
      currency: 'USD',
      duration: params.duration,
      duration_unit: params.duration_unit,
    };

    if (params.barrier !== undefined && params.barrier !== null) {
      payload.barrier = String(params.barrier);
    }

    if (this.isPatToken) {
      payload.underlying_symbol = params.symbol;
    } else {
      payload.symbol = params.symbol;
    }

    const res = await this.send(payload);
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

  public async getContractsFor(symbol: string): Promise<any> {
    const res = await this.send({
      contracts_for: symbol,
    });
    return res.contracts_for?.available || [];
  }

  public async getTicksHistory(symbol: string, count = 20): Promise<number[]> {
    const res = await this.send({
      ticks_history: symbol,
      count: count,
      end: 'latest',
      style: 'ticks',
    });
    return res.history?.prices || [];
  }

  public async getCandlesHistory(symbol: string, count = 60, granularity = 60): Promise<Array<{ open: number; high: number; low: number; close: number; epoch: number }>> {
    const res = await this.send({
      ticks_history: symbol,
      count: count,
      end: 'latest',
      style: 'candles',
      granularity: granularity,
    });
    return (res.candles || []).map((c: any) => ({
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      epoch: Number(c.epoch),
    }));
  }

  public close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

