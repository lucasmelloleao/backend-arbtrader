const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/arbtrader');
  const DerivTrade = mongoose.model('DerivTrade', new mongoose.Schema({}, { strict: false }));
  
  const trades = await DerivTrade.find({}).sort({ closedAt: -1 }).limit(20).lean();
  
  console.log("TOTAL TRADES ENCONTRADOS:", trades.length);
  for (const t of trades) {
    console.log(`[${t.closedAt ? new Date(t.closedAt).toLocaleTimeString('pt-BR') : 'N/A'}] Symbol: ${t.symbol} | Dir: ${t.contractType} | Buy: $${t.buyPrice} | Sell: $${t.sellPrice} | PnL: $${t.pnl} | Reason: ${t.reason} | ContractId: ${t.contractId}`);
  }
  process.exit(0);
}
run();
