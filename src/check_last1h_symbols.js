const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/arbtrader');
  const DerivTrade = mongoose.model('DerivTrade', new mongoose.Schema({}, { strict: false }));
  
  const h1 = new Date(Date.now() - 3600 * 1000);
  const trades = await DerivTrade.find({ closedAt: { $gte: h1 }, status: 'executed' }).lean();
  
  const bySymbol = {};
  for (const t of trades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { count: 0, wins: 0, losses: 0, pnl: 0, invested: 0 };
    bySymbol[t.symbol].count++;
    if ((t.pnl || 0) > 0) bySymbol[t.symbol].wins++;
    else bySymbol[t.symbol].losses++;
    bySymbol[t.symbol].pnl += (t.pnl || 0);
    bySymbol[t.symbol].invested += (t.buyPrice || t.investedUsd || 0);
  }

  console.log('--- PERFORMANCE POR ATIVO NA ÚLTIMA 1 HORA ---');
  for (const [sym, st] of Object.entries(bySymbol)) {
    const wr = ((st.wins / st.count) * 100).toFixed(1);
    console.log(`${sym}: ${st.count} ops | ${st.wins}W / ${st.losses}L (${wr}%) | PnL: $${st.pnl.toFixed(2)} | Inv: $${st.invested.toFixed(2)}`);
  }
  process.exit(0);
}
run();
