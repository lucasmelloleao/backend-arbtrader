import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { IcMarketsBot } from '../strategy/icmarkets/icmarkets-bot';

async function run() {
  const uri = process.env.MONGODB_URI || 'mongodb+srv://lucasmelloleao:T80VwZTORZ1eghT5@cluster0.bb82u.mongodb.net/TraderProd';
  console.log('Conectando ao MongoDB...');
  await mongoose.connect(uri);
  console.log('Conectado! Sincronizando posições IC Markets cTrader com o banco...');
  await IcMarketsBot.syncAllPositions();
  console.log('✅ Sincronização concluída com sucesso!');
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('❌ Erro na sincronização:', err);
  process.exit(1);
});
