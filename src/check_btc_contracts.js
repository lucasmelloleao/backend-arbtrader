const mongoose = require('mongoose');
require('dotenv').config();
const { DerivWsClient } = require('./dist/strategy/deriv/helpers/deriv-ws');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/arbtrader');
  const DerivSettingsModel = mongoose.model('DerivSettings', new mongoose.Schema({}, { strict: false }));
  const settings = await DerivSettingsModel.findOne({}).lean();
  const token = settings.demoApiToken || settings.apiToken;
  
  const client = new DerivWsClient(settings.appId || '1089', token, 'demo');
  await client.connect();
  
  const contracts = await client.getContractsFor('cryBTCUSD');
  console.log('CONTRATOS DISPONÍVEIS PARA cryBTCUSD:', contracts.length);
  for (const c of contracts) {
    console.log(`Tipo: ${c.contract_type} (${c.contract_display}) | Min: ${c.min_contract_duration} | Max: ${c.max_contract_duration}`);
  }
  
  client.close();
  process.exit(0);
}
run();
