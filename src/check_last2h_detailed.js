const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/arbtrader');
  const DerivTrade = mongoose.model('DerivTrade', new mongoose.Schema({}, { strict: false }));
  
  const h2 = new Date(Date.now() - 2 * 3600 * 1000);
  const trades = await DerivTrade.find({ closedAt: { $gte: h2 }, status: 'executed' }).sort({ closedAt: 1 }).lean();

  console.log(`=== ANÁLISE COMPLETA DAS ÚLTIMAS 2 HORAS (TOTAL: ${trades.length} TRADES) ===\n`);

  const summary = {
    total: trades.length,
    wins: 0,
    losses: 0,
    pnl: 0,
    invested: 0,
    byReason: {},
    bySymbol: {}
  };

  for (const t of trades) {
    const isWin = (t.pnl || 0) > 0;
    if (isWin) summary.wins++;
    else summary.losses++;
    summary.pnl += (t.pnl || 0);
    summary.invested += (t.buyPrice || t.investedUsd || 0);

    // Razão
    const rKey = (t.reason || 'Sem motivo').split(':')[0];
    if (!summary.byReason[rKey]) summary.byReason[rKey] = { count: 0, pnl: 0 };
    summary.byReason[rKey].count++;
    summary.byReason[rKey].pnl += (t.pnl || 0);

    // Símbolo
    if (!summary.bySymbol[t.symbol]) {
      summary.bySymbol[t.symbol] = {
        total: 0, wins: 0, losses: 0, pnl: 0, invested: 0,
        tpCount: 0, stopCount: 0, expireCount: 0
      };
    }
    const s = summary.bySymbol[t.symbol];
    s.total++;
    if (isWin) s.wins++;
    else s.losses++;
    s.pnl += (t.pnl || 0);
    s.invested += (t.buyPrice || t.investedUsd || 0);
    if ((t.reason || '').includes('Take Profit')) s.tpCount++;
    else if ((t.reason || '').includes('Emergency Stop')) s.stopCount++;
    else s.expireCount++;
  }

  const winRate = summary.total > 0 ? ((summary.wins / summary.total) * 100).toFixed(1) : 0;
  console.log(`RESUMO GERAL:`);
  console.log(`Total: ${summary.total} | Wins: ${summary.wins} (${winRate}%) | Losses: ${summary.losses}`);
  console.log(`Volume: $${summary.invested.toFixed(2)} | PnL Líquido: $${summary.pnl.toFixed(2)}\n`);

  console.log(`DESEMPENHO POR TIPO DE SAÍDA:`);
  for (const [r, data] of Object.entries(summary.byReason)) {
    console.log(`- ${r}: ${data.count} ops | PnL Total: $${data.pnl.toFixed(2)}`);
  }

  console.log(`\nDESEMPENHO DETALHADO POR ATIVO:`);
  for (const [sym, s] of Object.entries(summary.bySymbol)) {
    const wr = ((s.wins / s.total) * 100).toFixed(1);
    console.log(`--------------------------------------------------`);
    console.log(`📊 ${sym}: ${s.total} trades | ${s.wins}W / ${s.losses}L (WinRate: ${wr}%)`);
    console.log(`   Volume: $${s.invested.toFixed(2)} | PnL: $${s.pnl.toFixed(2)}`);
    console.log(`   Saídas: ${s.tpCount} Take Profit | ${s.stopCount} Emergency Stop | ${s.expireCount} Vencimento`);
  }

  process.exit(0);
}
run();
