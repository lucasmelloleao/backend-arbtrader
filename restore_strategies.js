const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/arbtrader');
  const DerivStrategy = mongoose.model('DerivStrategy', new mongoose.Schema({}, { strict: false }));
  const DerivSettings = mongoose.model('DerivSettings', new mongoose.Schema({}, { strict: false }));
  
  const settings = await DerivSettings.findOne({}).lean();
  const userId = settings?.userId || new mongoose.Types.ObjectId('6a58ee588440982aa9f36913');

  // Estratégias recomendadas e otimizadas
  const defaultStrategies = [
    {
      userId: userId,
      name: '1HZ75V',
      symbol: '1HZ75V',
      contractType: 'BOTH_HL',
      barrier: '-0.80',
      barrierLower: '+0.80',
      tradeSize: 2,
      durationSec: 15,
      minCertaintyProb: 0.90,
      minTakeProfitPct: 15,
      emergencyStopPct: 70,
      active: true,
      positionOpen: false,
    },
    {
      userId: userId,
      name: '1HZ25V',
      symbol: '1HZ25V',
      contractType: 'BOTH_HL',
      barrier: '-0.80',
      barrierLower: '+0.80',
      tradeSize: 2,
      durationSec: 15,
      minCertaintyProb: 0.90,
      minTakeProfitPct: 15,
      emergencyStopPct: 70,
      active: true,
      positionOpen: false,
    },
    {
      userId: userId,
      name: '1HZ50V',
      symbol: '1HZ50V',
      contractType: 'BOTH_HL',
      barrier: '-0.80',
      barrierLower: '+0.80',
      tradeSize: 1,
      durationSec: 15,
      minCertaintyProb: 0.90,
      minTakeProfitPct: 15,
      emergencyStopPct: 70,
      active: true,
      positionOpen: false,
    },
    {
      userId: userId,
      name: '1HZ10V',
      symbol: '1HZ10V',
      contractType: 'BOTH_HL',
      barrier: '-0.80',
      barrierLower: '+0.80',
      tradeSize: 2,
      durationSec: 15,
      minCertaintyProb: 0.92,
      minTakeProfitPct: 15,
      emergencyStopPct: 70,
      active: true,
      positionOpen: false,
    },
    {
      userId: userId,
      name: '1HZ100V',
      symbol: '1HZ100V',
      contractType: 'BOTH_HL',
      barrier: '-0.80',
      barrierLower: '+0.80',
      tradeSize: 1,
      durationSec: 15,
      minCertaintyProb: 0.92,
      minTakeProfitPct: 15,
      emergencyStopPct: 70,
      active: true,
      positionOpen: false,
    },
    {
      userId: userId,
      name: 'cryBTCUSD',
      symbol: 'cryBTCUSD',
      contractType: 'BOTH_MULT',
      barrier: '-1.00',
      barrierLower: '+1.00',
      tradeSize: 2,
      durationSec: 120,
      minCertaintyProb: 0.90,
      minTakeProfitPct: 15,
      emergencyStopPct: 70,
      active: true,
      positionOpen: false,
    }
  ];

  await DerivStrategy.deleteMany({ userId: userId });
  const result = await DerivStrategy.insertMany(defaultStrategies);
  
  console.log(`✅ SUCESSO! ${result.length} estratégias recriadas e restauradas no banco de dados!`);
  for (const s of result) {
    console.log(`- [${s.symbol}] Certeza: ${(s.minCertaintyProb * 100).toFixed(0)}% | Modo: ${s.contractType} | Duração: ${s.durationSec}s | TP: +${s.minTakeProfitPct}% | Stop: -${s.emergencyStopPct}%`);
  }

  process.exit(0);
}
run();
