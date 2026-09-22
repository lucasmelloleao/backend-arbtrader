const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/arbtrader');
  const DerivTrade = mongoose.model('DerivTrade', new mongoose.Schema({}, { strict: false }));
  
  const now = Date.now();
  const h1 = new Date(now - 1 * 3600 * 1000);
  const h3 = new Date(now - 3 * 3600 * 1000);
  const h24 = new Date(now - 24 * 3600 * 1000);

  async function getStats(sinceDate, label) {
    const trades = await DerivTrade.find({ closedAt: { $gte: sinceDate }, status: 'executed' }).lean();
    const total = trades.length;
    const wins = trades.filter(t => (t.pnl || 0) > 0);
    const losses = trades.filter(t => (t.pnl || 0) <= 0);
    const pnl = trades.reduce((acc, t) => acc + (t.pnl || 0), 0);
    const tpCount = trades.filter(t => (t.reason || '').includes('Take Profit')).length;
    const stopCount = trades.filter(t => (t.reason || '').includes('Emergency Stop')).length;
    const winRate = total > 0 ? ((wins.length / total) * 100).toFixed(1) : '0.0';
    
    console.log(`\n=== PERÍODO: ${label} ===`);
    console.log(`Total Trades: ${total} | Wins: ${wins.length} (${winRate}%) | Losses: ${losses.length}`);
    console.log(`PnL Total: $${pnl.toFixed(2)}`);
    console.log(`Saídas Antecipadas com Take Profit: ${tpCount}`);
    console.log(`Saídas Antecipadas com Emergency Stop: ${stopCount}`);
  }

  await getStats(h1, 'ÚLTIMA 1 HORA (Pós-ajustes Take Profit / 600ms)');
  await getStats(h3, 'ÚLTIMAS 3 HORAS');
  await getStats(h24, 'ÚLTIMAS 24 HORAS');

  process.exit(0);
}
run();
