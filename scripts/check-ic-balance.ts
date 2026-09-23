import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import ExchangeKey from './src/models/ExchangeKey';
import IcMarketsSettings from './src/models/IcMarketsSettings';
import { getSharedCtraderAdapter } from './src/strategy/forex/ctrader/ctrader-factory';

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/atbtrader';
  await mongoose.connect(uri);
  const key = await ExchangeKey.findOne({
    exchangeId: { $in: ['icmarkets', 'icmarkets-ctrader', 'ic', 'ctrader'] },
    active: true,
  }).lean();
  const settings = await IcMarketsSettings.findOne().lean();
  console.log('KEY:', key ? { id: key._id, exchangeId: key.exchangeId, accountId: key.accountId } : null);
  console.log('SETTINGS:', settings ? { accountId: settings.accountId, accountType: settings.accountType } : null);
  if (key) {
    const targetAccountId = settings?.accountId || key.accountId || '10102182';
    const env = (settings?.accountType === 'real' || settings?.accountType === 'live') ? 'live' : 'demo';
    const adapter = await getSharedCtraderAdapter(key, { accountId: targetAccountId, environment: env });
    const info = await adapter.fetchAccountInfo();
    console.log('ACCOUNT_INFO:', JSON.stringify(info, null, 2));
    await adapter.destroy();
  }
  await mongoose.disconnect();
}
main().catch(err => { console.error('ERROR:', err); process.exit(1); });
