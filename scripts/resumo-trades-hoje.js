const mongoose = require('mongoose');

async function main() {
  try {
    await mongoose.connect('mongodb+srv://lucasmelloleao:T80VwZTORZ1eghT5@cluster0.bb82u.mongodb.net/TraderProd');
    const DerivTrade = mongoose.model('DerivTrade', new mongoose.Schema({}, { strict: false }));
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const trades = await DerivTrade.find({ createdAt: { $gte: startOfDay } }).sort({ createdAt: -1 }).lean();
    
    const executed = trades.filter(t => t.status === 'executed');
    const open = trades.filter(t => t.status === 'open');
    
    const totalTrades = executed.length;
    const wins = executed.filter(t => (t.pnl || 0) > 0).length;
    const losses = executed.filter(t => (t.pnl || 0) <= 0).length;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const totalInvested = executed.reduce((acc, t) => acc + (t.investedUsd || t.buyPrice || 0), 0);
    const totalPnl = executed.reduce((acc, t) => acc + (t.pnl || 0), 0);
    const totalRealized = executed.reduce((acc, t) => acc + (t.realizedUsd || t.sellPrice || 0), 0);

    // Group by symbol
    const bySymbol = {};
    // Group by strategy
    const byStrategy = {};
    // Group by contractType
    const byType = {};

    executed.forEach(t => {
      const sym = t.symbol || 'N/A';
      const strat = t.strategyName || (t.reason?.match(/Estratégia "([^"]+)"/)?.[1] ?? sym);
      const type = t.contractType || 'N/A';
      const pnl = Number(t.pnl || 0);
      const isWin = pnl > 0;

      // Symbol
      if (!bySymbol[sym]) bySymbol[sym] = { count: 0, wins: 0, losses: 0, pnl: 0, invested: 0 };
      bySymbol[sym].count++;
      if (isWin) bySymbol[sym].wins++; else bySymbol[sym].losses++;
      bySymbol[sym].pnl += pnl;
      bySymbol[sym].invested += (t.investedUsd || t.buyPrice || 0);

      // Strategy
      if (!byStrategy[strat]) byStrategy[strat] = { count: 0, wins: 0, losses: 0, pnl: 0, invested: 0 };
      byStrategy[strat].count++;
      if (isWin) byStrategy[strat].wins++; else byStrategy[strat].losses++;
      byStrategy[strat].pnl += pnl;
      byStrategy[strat].invested += (t.investedUsd || t.buyPrice || 0);

      // Type
      if (!byType[type]) byType[type] = { count: 0, wins: 0, losses: 0, pnl: 0, invested: 0 };
      byType[type].count++;
      if (isWin) byType[type].wins++; else byType[type].losses++;
      byType[type].pnl += pnl;
      byType[type].invested += (t.investedUsd || t.buyPrice || 0);
    });

    console.log(JSON.stringify({
      totalTrades,
      wins,
      losses,
      winRate: winRate.toFixed(2),
      totalInvested: totalInvested.toFixed(2),
      totalPnl: totalPnl.toFixed(2),
      totalRealized: totalRealized.toFixed(2),
      openCount: open.length,
      bySymbol,
      byStrategy,
      byType,
      sampleTrades: trades.slice(0, 15).map(t => ({
        time: t.openedAt ? new Date(t.openedAt).toLocaleTimeString('pt-BR') : '',
        symbol: t.symbol,
        strategy: t.strategyName || (t.reason?.match(/Estratégia "([^"]+)"/)?.[1] ?? t.symbol),
        type: t.contractType,
        buyPrice: t.buyPrice,
        sellPrice: t.sellPrice,
        pnl: t.pnl,
        status: t.status,
        reason: t.reason
      }))
    }, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

main();
