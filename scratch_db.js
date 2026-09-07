require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const trades = await db.collection('perparbtrades').find({
    type: { $in: ['open_hedge', 'close_hedge', 'funding_fee_accumulated'] }
  }).sort({ createdAt: -1 }).limit(30).toArray();

  console.log('--- RECENT TRADES ---');
  for (const t of trades) {
    console.log(JSON.stringify({
      id: t._id,
      date: t.createdAt,
      type: t.type,
      status: t.status,
      name: t.strategyName,
      perpSymbol: t.perpSymbol,
      amount: t.amount,
      pnl: t.pnl,
      spotPnl: t.spotPnl,
      perpPnl: t.perpPnl,
      fundingCollected: t.fundingCollected,
      spotPrice: t.spotPrice,
      spotExitPrice: t.spotExitPrice,
      perpPrice: t.perpPrice,
      perpExitPrice: t.perpExitPrice,
      reason: t.reason
    }));
  }
  process.exit(0);
}
main();
