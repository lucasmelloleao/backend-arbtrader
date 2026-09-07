require('dotenv').config();
const mongoose = require('mongoose');
const ccxt = require('ccxt');
const { decryptSecretKey } = require('./dist/utils/encryption.js');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const trades = await db.collection('perparbtrades').find({
    type: { $in: ['open_hedge', 'close_hedge', 'funding_fee_accumulated'] }
  }).sort({ createdAt: -1 }).limit(30).toArray();

  const keyDoc = await db.collection('exchangekeys').findOne({ exchangeId: 'mexc', active: true });
  let spotOrders = [], futuresOrders = [];

  if (keyDoc) {
    const key = keyDoc.apiKey;
    let secret = keyDoc.apiSecret;
    try { secret = decryptSecretKey(keyDoc.apiSecret, String(keyDoc.userId) + '-mexc'); } catch (e) { console.log('Decrypt error:', e.message); }
    const spot = new ccxt.mexc({ apiKey: key, secret: secret, options: { defaultType: 'spot' } });
    const futures = new ccxt.mexc({ apiKey: key, secret: secret, options: { defaultType: 'swap' } });

    try { spotOrders = await spot.fetchOrders('CNPY/USDT', undefined, 20); } catch (e) { 
      try { spotOrders = await spot.fetchOrders(undefined, undefined, 20); } catch(err) { spotOrders = [{ error: err.message }]; }
    }
    try { futuresOrders = await futures.fetchOrders('CNPY/USDT:USDT', undefined, 20); } catch (e) { 
      try { futuresOrders = await futures.fetchOrders(undefined, undefined, 20); } catch(err) { futuresOrders = [{ error: err.message }]; }
    }
  }

  console.log(JSON.stringify({ trades, spotOrders, futuresOrders }, null, 2));
  process.exit(0);
}
main();
