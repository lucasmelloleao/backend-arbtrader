const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/arbtrader');
  const DerivTrade = mongoose.model('DerivTrade', new mongoose.Schema({}, { strict: false }));
  
  const h12 = new Date(Date.now() - 12 * 3600 * 1000);
  const trades = await DerivTrade.find({ closedAt: { $gte: h12 }, status: 'executed' }).sort({ closedAt: 1 }).lean();

  console.log(`=== SIMULAÇÃO MULTI-CENÁRIOS (ÚLTIMAS 12 HORAS - ${trades.length} TRADES REAIS) ===\n`);

  // Extrai certeza e dados de cada trade
  const parsedTrades = trades.map(t => {
    const match = (t.question || '').match(/(\d+)%\s*Certeza/i);
    const certainty = match ? parseInt(match[1], 10) : 75;
    const durSec = t.openedAt && t.closedAt ? Math.round((new Date(t.closedAt).getTime() - new Date(t.openedAt).getTime()) / 1000) : 0;
    return {
      symbol: t.symbol,
      contractType: t.contractType,
      buyPrice: Number(t.buyPrice || t.investedUsd || 0),
      sellPrice: Number(t.sellPrice || 0),
      pnl: Number(t.pnl || 0),
      reason: t.reason || '',
      certainty: certainty,
      duration: durSec,
      isWin: Number(t.pnl || 0) > 0,
      isTp: (t.reason || '').includes('Take Profit'),
      isStop: (t.reason || '').includes('Emergency Stop'),
    };
  });

  function evaluate(filterFn, label) {
    const subset = parsedTrades.filter(filterFn);
    const total = subset.length;
    if (total === 0) {
      console.log(`[${label}] Sem trades qualificados.`);
      return;
    }
    const wins = subset.filter(t => t.isWin).length;
    const losses = total - wins;
    const pnl = subset.reduce((acc, t) => acc + t.pnl, 0);
    const winRate = ((wins / total) * 100).toFixed(1);
    const tpCount = subset.filter(t => t.isTp).length;
    const stopCount = subset.filter(t => t.isStop).length;

    console.log(`📌 ${label.padEnd(55)} | ${total.toString().padStart(3)} trades | ${wins}W/${losses}L (${winRate}%) | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2).padStart(6)} | TP: ${tpCount} / Stop: ${stopCount}`);
  }

  console.log('--- CENÁRIOS POR FILTRO DE CERTEZA ---');
  evaluate(t => true, 'Cenário 0: Real Base (Sem filtro)');
  evaluate(t => t.certainty >= 80, 'Cenário 1: Certeza >= 80%');
  evaluate(t => t.certainty >= 85, 'Cenário 2: Certeza >= 85%');
  evaluate(t => t.certainty >= 88, 'Cenário 3: Certeza >= 88%');
  evaluate(t => t.certainty >= 90, 'Cenário 4: Certeza >= 90%');
  evaluate(t => t.certainty >= 92, 'Cenário 5: Certeza >= 92%');

  console.log('\n--- CENÁRIOS POR SELEÇÃO DE ATIVOS (Top Performers) ---');
  evaluate(t => ['1HZ75V', '1HZ25V'].includes(t.symbol), 'Cenário 6: Apenas 1HZ75V e 1HZ25V (Certeza Real)');
  evaluate(t => ['1HZ75V', '1HZ25V'].includes(t.symbol) && t.certainty >= 86, 'Cenário 7: Apenas 1HZ75V e 1HZ25V (Certeza >= 86%)');
  evaluate(t => ['1HZ75V', '1HZ25V'].includes(t.symbol) && t.certainty >= 90, 'Cenário 8: Apenas 1HZ75V e 1HZ25V (Certeza >= 90%)');

  console.log('\n--- CENÁRIOS EXCLUINDO DETRATORES (Exclui 1HZ10V e 1HZ100V) ---');
  evaluate(t => !['1HZ10V', '1HZ100V'].includes(t.symbol), 'Cenário 9: Sem 10V e Sem 100V (Certeza Real)');
  evaluate(t => !['1HZ10V', '1HZ100V'].includes(t.symbol) && t.certainty >= 88, 'Cenário 10: Sem 10V/100V + Certeza >= 88%');
  evaluate(t => !['1HZ10V', '1HZ100V'].includes(t.symbol) && t.certainty >= 90, 'Cenário 11: Sem 10V/100V + Certeza >= 90%');

  console.log('\n--- CENÁRIOS DE SAÍDA ANTECIPADA (Foco em Take Profit Rápido) ---');
  evaluate(t => t.isTp || (t.isWin && t.duration <= 35), 'Cenário 12: Apenas Saídas Rápidas (<= 35s ou TP)');
  evaluate(t => ['1HZ75V', '1HZ25V', '1HZ50V'].includes(t.symbol) && t.certainty >= 88 && (t.isTp || t.duration <= 35), 'Cenário 13: Top 3 Ativos + Certeza >= 88% + Saída Rápida');

  process.exit(0);
}
run();
