import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import ExchangeKey from '../models/ExchangeKey';
import { getSharedCtraderAdapter } from '../strategy/forex/ctrader/ctrader-factory';
import IcMarketsTrade from '../models/IcMarketsTrade';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI as string);
  const key = await ExchangeKey.findOne({
    active: true,
    exchangeId: { $in: ['icmarkets', 'icmarkets-ctrader', 'ic', 'ctrader'] },
  }).lean();

  if (!key) {
    console.log('No key found');
    process.exit(1);
  }

  const adapter = await getSharedCtraderAdapter(key, { accountId: '10102182', environment: 'demo' });
  const pnlMap = await adapter.getPositionsPnL();
  const ctraderPosIds = new Set<string>();
  for (const [k, v] of pnlMap.entries()) {
    ctraderPosIds.add(v.positionId);
  }
  console.log('REAL CTRADER OPEN POSITION IDS:', Array.from(ctraderPosIds));

  const dbOpenTrades = await IcMarketsTrade.find({ status: 'open' }).lean();
  console.log('DB OPEN TRADES COUNT:', dbOpenTrades.length);
  for (const t of dbOpenTrades) {
    console.log(`DB posId: ${t.positionId}, exists in cTrader? ${ctraderPosIds.has(String(t.positionId))}`);
  }

  const dbClosedTrades = await IcMarketsTrade.find({ status: 'closed' }).lean();
  console.log('DB CLOSED TRADES COUNT:', dbClosedTrades.length);
  for (const t of dbClosedTrades) {
    console.log(`DB CLOSED posId: ${t.positionId}, exists in cTrader? ${ctraderPosIds.has(String(t.positionId))}`);
  }

  process.exit(0);
}

main().catch(console.error);
