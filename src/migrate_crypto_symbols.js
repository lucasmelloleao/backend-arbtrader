const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/arbtrader');
  const DerivStrategy = mongoose.model('DerivStrategy', new mongoose.Schema({}, { strict: false }));
  const DerivSettings = mongoose.model('DerivSettings', new mongoose.Schema({}, { strict: false }));
  
  const r1 = await DerivStrategy.updateMany({ symbol: 'frxBTCUSD' }, { symbol: 'cryBTCUSD', name: 'cryBTCUSD' });
  const r2 = await DerivStrategy.updateMany({ symbol: 'frxETHUSD' }, { symbol: 'cryETHUSD', name: 'cryETHUSD' });
  
  await DerivSettings.updateMany({}, {
    allowedSymbols: ['1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V', 'cryBTCUSD', 'cryETHUSD']
  });

  console.log('Migração concluída com sucesso! Atualizados:', r1.modifiedCount, r2.modifiedCount);
  process.exit(0);
}
run();
