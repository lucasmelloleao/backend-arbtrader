const mongoose = require('mongoose');
require('dotenv').config();
const WebSocket = require('ws');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/arbtrader');
  const DerivTrade = mongoose.model('DerivTrade', new mongoose.Schema({}, { strict: false }));
  const DerivSettings = mongoose.model('DerivSettings', new mongoose.Schema({}, { strict: false }));
  
  const settings = await DerivSettings.findOne({}).lean();
  const token = settings.demoApiToken || settings.apiToken;
  
  const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${settings.appId || '1089'}`);
  
  await new Promise((resolve) => ws.on('open', resolve));

  const send = (payload) => new Promise((resolve) => {
    const handler = (data) => {
      const json = JSON.parse(data.toString());
      if (json.msg_type === payload.authorize ? 'authorize' : Object.keys(payload)[0]) {
        ws.off('message', handler);
        resolve(json);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify(payload));
  });

  await send({ authorize: token });

  const stopContractIds = ['14017773919', '14017564479', '14017190179', '14017051179', '14016409659'];

  for (const cid of stopContractIds) {
    const trade = await DerivTrade.findOne({ contractId: cid }).lean();
    console.log(`\n--- CONTRATO ${cid} (${trade?.symbol} ${trade?.contractType}) ---`);
    console.log(`Entrada: ${trade?.openedAt} | Saída: ${trade?.closedAt} | PnL realizado: $${trade?.pnl}`);

    const res = await new Promise((resolve) => {
      const handler = (data) => {
        const json = JSON.parse(data.toString());
        if (json.proposal_open_contract) {
          ws.off('message', handler);
          resolve(json.proposal_open_contract);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: cid }));
    });

    console.log(`Status Deriv: ${res.status}`);
    console.log(`Entry Spot: ${res.entry_spot} | Barrier: ${res.barrier} | Exit Spot: ${res.exit_tick || res.current_spot}`);
    console.log(`Is Expired: ${res.is_expired} | Is Valid To Sell: ${res.is_valid_to_sell}`);
    console.log(`Preço final de liquidação / Payout final da Deriv: $${res.payout} | Profit potencial se expirasse: $${res.profit}`);
    console.log(`Tick stream length: ${(res.tick_stream || []).length} ticks`);
    if (res.tick_stream && res.tick_stream.length > 0) {
      const lastTick = res.tick_stream[res.tick_stream.length - 1];
      console.log(`Último tick gravado no contrato: Epoch ${lastTick.epoch} | Tick: ${lastTick.tick}`);
    }
  }

  ws.close();
  process.exit(0);
}
run();
