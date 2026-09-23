const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/arbtrader');
  const DerivTrade = mongoose.model('DerivTrade', new mongoose.Schema({}, { strict: false }));
  
  const h24 = new Date(Date.now() - 24 * 3600 * 1000);
  const trades = await DerivTrade.find({ symbol: '1HZ75V', closedAt: { $gte: h24 }, status: 'executed' }).sort({ closedAt: 1 }).lean();

  console.log(`=== ANÁLISE 1HZ75V EM JANELAS DE 30 MINUTOS (ÚLTIMAS 24H) - TOTAL: ${trades.length} TRADES ===\n`);

  const intervals = {};

  for (const t of trades) {
    if (!t.closedAt) continue;
    const dt = new Date(t.closedAt);
    const year = dt.getFullYear();
    const month = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    const hours = String(dt.getHours()).padStart(2, '0');
    const minBucket = dt.getMinutes() < 30 ? '00' : '30';
    const key = `${day}/${month} ${hours}:${minBucket}`;

    if (!intervals[key]) {
      intervals[key] = { count: 0, wins: 0, losses: 0, pnl: 0, invested: 0, higherCount: 0, lowerCount: 0, tpCount: 0, stopCount: 0, expireCount: 0 };
    }
    const b = intervals[key];
    b.count++;
    const pnl = Number(t.pnl || 0);
    if (pnl > 0) b.wins++;
    else b.losses++;
    b.pnl += pnl;
    b.invested += (t.buyPrice || t.investedUsd || 0);
    
    if (t.contractType === 'HIGHER' || t.contractType === 'CALL') b.higherCount++;
    else b.lowerCount++;

    if ((t.reason || '').includes('Take Profit')) b.tpCount++;
    else if ((t.reason || '').includes('Emergency Stop')) b.stopCount++;
    else b.expireCount++;
  }

  let cumulativePnl = 0;
  for (const [window, b] of Object.entries(intervals)) {
    cumulativePnl += b.pnl;
    const wr = ((b.wins / b.count) * 100).toFixed(1);
    console.log(`[${window}] ${b.count.toString().padStart(2)} ops | ${b.wins}W / ${b.losses}L (${wr}%) | PnL: ${b.pnl >= 0 ? '+' : ''}$${b.pnl.toFixed(2).padStart(6)} | Acum: ${cumulativePnl >= 0 ? '+' : ''}$${cumulativePnl.toFixed(2).padStart(6)} | H/L: ${b.higherCount}↑ ${b.lowerCount}↓ | TP: ${b.tpCount}, Stop: ${b.stopCount}`);
  }

  process.exit(0);
}
run();
