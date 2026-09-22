const path = require('path');
const { DerivWsClient } = require(path.join(__dirname, 'dist', 'strategy', 'deriv', 'helpers', 'deriv-ws'));
const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/arbtrader');
  const DerivSettingsModel = mongoose.model('DerivSettings', new mongoose.Schema({}, { strict: false }));
  const settings = await DerivSettingsModel.findOne({}).lean();
  const token = settings.demoApiToken || settings.apiToken;
  const client = new DerivWsClient(settings.appId || '1089', token, 'demo');
  await client.connect();

  const payload = {
    proposal: 1,
    amount: 10,
    basis: 'stake',
    contract_type: 'MULTUP',
    currency: 'USD',
    underlying_symbol: 'cryBTCUSD',
    multiplier: 100,
  };

  try {
    const res = await client.send(payload);
    console.log("PROPOSTA MULTUP COM underlying_symbol RESULT:", JSON.stringify(res, null, 2));
  } catch (err) {
    console.log("ERRO MULTUP:", err.message);
  }

  client.close();
  process.exit(0);
}
run();
