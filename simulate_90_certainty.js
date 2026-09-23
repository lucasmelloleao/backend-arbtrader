const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/arbtrader');
  const DerivTrade = mongoose.model('DerivTrade', new mongoose.Schema({}, { strict: false }));
  
  // Trades fechados hoje após as 12:00
  const d12 = new Date();
  d12.setHours(12, 0, 0, 0);

  const trades = await DerivTrade.find({ closedAt: { $gte: d12 }, status: 'executed' }).sort({ closedAt: 1 }).lean();

  console.log(`=== ANÁLISE DE TRADES PÓS-12:00 (TOTAL REAL: ${trades.length} TRADES) ===\n`);

  let realPnl = 0;
  let realWins = 0;
  let realLosses = 0;

  // Extrair certeza gravada na pergunta: "Opção 1HZ10V (HIGHER [Barreira: -0.80] 92% Certeza)"
  let sim90Pnl = 0;
  let sim90Wins = 0;
  let sim90Losses = 0;
  let sim90Total = 0;

  const bySymbolReal = {};
  const bySymbolSim90 = {};

  for (const t of trades) {
    const pnl = Number(t.pnl || 0);
    const isWin = pnl > 0;
    
    realPnl += pnl;
    if (isWin) realWins++;
    else realLosses++;

    if (!bySymbolReal[t.symbol]) bySymbolReal[t.symbol] = { total: 0, wins: 0, losses: 0, pnl: 0 };
    bySymbolReal[t.symbol].total++;
    if (isWin) bySymbolReal[t.symbol].wins++;
    else bySymbolReal[t.symbol].losses++;
    bySymbolReal[t.symbol].pnl += pnl;

    // Extrai o percentual de certeza da string `question`
    const match = (t.question || '').match(/(\d+)%\s*Certeza/i);
    const certainty = match ? parseInt(match[1], 10) : 0;

    // Se a certeza foi >= 90%
    if (certainty >= 90) {
      sim90Total++;
      sim90Pnl += pnl;
      if (isWin) sim90Wins++;
      else sim90Losses++;

      if (!bySymbolSim90[t.symbol]) bySymbolSim90[t.symbol] = { total: 0, wins: 0, losses: 0, pnl: 0 };
      bySymbolSim90[t.symbol].total++;
      if (isWin) bySymbolSim90[t.symbol].wins++;
      else bySymbolSim90[t.symbol].losses++;
      bySymbolSim90[t.symbol].pnl += pnl;
    }
  }

  console.log(`1. RESULTADO REAL (Executado com parâmetros variados):`);
  console.log(`- Total Trades: ${trades.length}`);
  console.log(`- Vitórias: ${realWins} (${((realWins / trades.length) * 100).toFixed(1)}%) | Derrotas: ${realLosses}`);
  console.log(`- PnL Líquido Real: ${realPnl >= 0 ? '+' : ''}$${realPnl.toFixed(2)}\n`);

  console.log(`2. SIMULAÇÃO FILTRANDO APENAS ENTRADAS COM CERTEZA >= 90%:`);
  console.log(`- Total Trades Filtrados: ${sim90Total}`);
  if (sim90Total > 0) {
    console.log(`- Vitórias: ${sim90Wins} (${((sim90Wins / sim90Total) * 100).toFixed(1)}%) | Derrotas: ${sim90Losses}`);
    console.log(`- PnL Líquido com Certeza >= 90%: ${sim90Pnl >= 0 ? '+' : ''}$${sim90Pnl.toFixed(2)}`);
  }

  console.log(`\n3. DETALHAMENTO POR ATIVO COM CERTEZA >= 90%:`);
  for (const [sym, s] of Object.entries(bySymbolSim90)) {
    const wr = ((s.wins / s.total) * 100).toFixed(1);
    console.log(`- ${sym.padEnd(8)}: ${s.total} trades | ${s.wins}W / ${s.losses}L (${wr}%) | PnL: ${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}`);
  }

  process.exit(0);
}
run();
