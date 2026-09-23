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

  console.log("=== VERIFICAÇÃO DO COMPORTAMENTO DOS TICKS PÓS-SINAL (ÚLTIMOS 2 MINUTOS) ===\n");

  // Avalia o que os ticks fizeram nos ativos dos sinais:
  // 1HZ50V às 00:23:44 (Sinal CALL/Alta)
  // 1HZ10V às 00:23:49 (Sinal PUT/Baixa)
  // 1HZ100V às 00:23:47 (Sinal PUT/Baixa)

  for (const sym of ['1HZ50V', '1HZ10V', '1HZ100V', '1HZ75V']) {
    const ticks = await client.getTicksHistory(sym, 60);
    const last15 = ticks.slice(-15);
    const prev15 = ticks.slice(-30, -15);
    const firstPrice = prev15[0];
    const midPrice = prev15[prev15.length - 1];
    const currentPrice = last15[last15.length - 1];
    
    console.log(`📊 Ativo ${sym}:`);
    console.log(`- Preço no momento do sinal: ${firstPrice}`);
    console.log(`- Preço 15s depois: ${midPrice} (${midPrice > firstPrice ? '↑ SUBIU' : '↓ CAIU'})`);
    console.log(`- Preço atual: ${currentPrice} (${currentPrice > firstPrice ? '↑ SUBIU' : '↓ CAIU'})\n`);
  }

  client.close();
  process.exit(0);
}
run();
