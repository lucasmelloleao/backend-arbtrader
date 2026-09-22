const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/arbtrader');
  const DerivTrade = mongoose.model('DerivTrade', new mongoose.Schema({}, { strict: false }));
  
  const trades = await DerivTrade.find({ symbol: '1HZ100V', status: 'executed' }).sort({ closedAt: -1 }).limit(20).lean();

  console.log("=== ÚLTIMOS 20 TRADES DO 1HZ100V ===");
  for (const t of trades) {
    const durSec = t.openedAt && t.closedAt ? Math.round((new Date(t.closedAt).getTime() - new Date(t.openedAt).getTime()) / 1000) : 0;
    console.log(`[${t.closedAt ? new Date(t.closedAt).toLocaleTimeString('pt-BR') : 'N/A'}] ${t.contractType} | Buy: $${t.buyPrice} | Sell: $${t.sellPrice} | PnL: $${t.pnl} (${t.pnl > 0 ? 'WIN' : 'LOSS'}) | Dur: ${durSec}s | Reason: ${t.reason}`);
  }
  process.exit(0);
}
run();
