const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/arbtrader');
  const DerivStrategy = mongoose.model('DerivStrategy', new mongoose.Schema({}, { strict: false }));
  const strategies = await DerivStrategy.find({}).lean();
  
  console.log('=== ESTRATÉGIAS NO BANCO DE DADOS ===');
  for (const s of strategies) {
    const probPct = Math.round(Number(s.minCertaintyProb || 0.75) * 100);
    console.log(`Ativo: ${s.symbol.padEnd(10)} | Certeza: ${probPct}% | Modo: ${s.contractType || 'BOTH_HL'} | Duração: ${s.durationSec}s | Aporte: $${s.tradeSize} | Barreira: ${s.barrier}`);
  }
  process.exit(0);
}
run();
