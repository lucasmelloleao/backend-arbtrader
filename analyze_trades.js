require('./dist/utils/env-loader.js').loadEnv();
const { connectToDatabase } = require('./dist/config/db.js');
const ForexArbTrade = require('./dist/models/ForexArbTrade.js').default;

async function analyzeLast30() {
  await connectToDatabase();
  const trades = await ForexArbTrade.find({ type: 'close' }).sort({ createdAt: -1 }).limit(30).lean();
  console.log('=== ULTIMAS OPERACOES FECHADAS ===');
  let totalPnl = 0;
  let totalComm = 0;
  let wins = 0;
  let losses = 0;
  
  for (const t of trades) {
    const pnl = Number(t.realizedPnl || 0);
    const comm = Number(t.commission || 0);
    totalPnl += pnl;
    totalComm += comm;
    if (pnl > 0) wins++;
    else if (pnl < 0) losses++;
    
    const timeStr = new Date(t.createdAt).toISOString().slice(11, 19);
    console.log(`[${timeStr}] ${t.strategyName} | PnL: $${pnl.toFixed(2)} | Comm: $${comm.toFixed(2)} | Motivo: ${t.closedReason} -> ${t.reason}`);
  }
  console.log('------------------------------------------------');
  console.log(`Total PnL Liquid: $${totalPnl.toFixed(2)} | Wins: ${wins} | Losses: ${losses} | Total Comm: $${totalComm.toFixed(2)}`);
  process.exit(0);
}
analyzeLast30().catch(console.error);
