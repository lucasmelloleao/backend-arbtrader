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

  // Teste 1: com limit_order
  try {
    const res1 = await client.send({
      proposal: 1,
      amount: 5,
      basis: 'stake',
      contract_type: 'MULTDOWN',
      currency: 'USD',
      underlying_symbol: 'cryBTCUSD',
      multiplier: 100,
      limit_order: {
        take_profit: 0.5,
        stop_loss: 3.5
      }
    });
    console.log("TESTE 1 (limit_order) SUCESSO:", res1.proposal?.id);
  } catch (e) {
    console.log("TESTE 1 ERRO:", e.message);
  }

  // Teste 2: sem limit_order / limpo
  try {
    const res2 = await client.send({
      proposal: 1,
      amount: 5,
      basis: 'stake',
      contract_type: 'MULTDOWN',
      currency: 'USD',
      underlying_symbol: 'cryBTCUSD',
      multiplier: 100
    });
    console.log("TESTE 2 (limpo) SUCESSO:", res2.proposal?.id);
  } catch (e) {
    console.log("TESTE 2 ERRO:", e.message);
  }

  client.close();
  process.exit(0);
}
run();
