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

  for (const sym of ['cryBTCUSD', 'cryETHUSD', 'frxEURUSD', 'R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V', 'stpRNG']) {
    const list = await client.getContractsFor(sym);
    const types = list.map(c => c.contract_type).join(', ');
    console.log(sym, '=> Contratos:', types || 'Nenhum');
  }
  client.close();
  process.exit(0);
}
run();
