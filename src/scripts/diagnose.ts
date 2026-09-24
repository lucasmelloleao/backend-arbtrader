import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import IcMarketsTrade from '../models/IcMarketsTrade';
import IcMarketsStrategy from '../models/IcMarketsStrategy';
import { IcMarketsBot } from '../strategy/icmarkets/icmarkets-bot';

async function diagnose() {
  const uri = process.env.MONGODB_URI || 'mongodb+srv://lucasmelloleao:T80VwZTORZ1eghT5@cluster0.bb82u.mongodb.net/TraderProd';
  await mongoose.connect(uri);

  console.log('--- EXECUTANDO SYNCALLPOSITIONS ---');
  await IcMarketsBot.syncAllPositions();

  const allTrades = await IcMarketsTrade.find().lean();
  console.log(`Total trades no banco: ${allTrades.length}`);
  const openTrades = allTrades.filter(t => t.status === 'open');
  const closedTrades = allTrades.filter(t => t.status === 'closed');
  console.log(`Trades status open: ${openTrades.length}`);
  console.log(`Trades status closed: ${closedTrades.length}`);

  const allStrats = await IcMarketsStrategy.find().lean();
  console.log(`Total strategies no banco: ${allStrats.length}`);
  const withPos = allStrats.filter(s => s.currentPositionId);
  console.log(`Strategies com currentPositionId: ${withPos.length}`);

  console.log('\n--- TRADES STATUS: "closed" NO BANCO ---');
  for (const t of closedTrades) {
    console.log(`Trade CLOSED: posId=${t.positionId} | ${t.symbol} | ${t.side} | ${t.openedAt} | closeReason=${t.closeReason}`);
  }

  console.log('\n--- TRADES STATUS: "open" NO BANCO ---');
  for (const t of openTrades) {
    console.log(`Trade OPEN: posId=${t.positionId} | ${t.symbol} | ${t.side} | entryPrice=${t.entryPrice}`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

diagnose().catch(e => {
  console.error(e);
  process.exit(1);
});
