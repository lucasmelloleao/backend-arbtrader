import { loadEnv } from '../src/utils/env-loader';
loadEnv();

import { connectToDatabase } from '../src/config/db';
import ExchangeKey from '../src/models/ExchangeKey';
import { getSharedCtraderAdapter } from '../src/strategy/forex/ctrader/ctrader-factory';

async function main() {
  await connectToDatabase();
  const posIds = process.argv.slice(2);
  const keys = await ExchangeKey.find({ active: true }).lean();
  const ctraderKey = keys.find((k: any) => k.exchangeId === 'ctrader');
  if (!ctraderKey) { console.log('sem chave ctrader'); process.exit(1); }

  const adapter: any = await getSharedCtraderAdapter(ctraderKey);
  await adapter.loadMarkets();

  for (const posId of posIds) {
    console.log(`\n=== Pos #${posId} ===`);
    try {
      const deals = await adapter.fetchPositionDeals(posId);
      console.log('total deals:', deals.length);
      for (const d of deals) {
        console.log(JSON.stringify({ dealId: d.dealId, side: d.side, price: d.price, hasCloseDetail: d.hasCloseDetail, realizedPnl: d.realizedPnl, commission: d.commission, executedAt: d.executedAt }));
      }
    } catch (e: any) {
      console.log('erro:', e.message);
    }
  }

  await adapter.destroy().catch(() => {});
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
