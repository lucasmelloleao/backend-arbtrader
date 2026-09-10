import { loadEnv } from '../src/utils/env-loader';
loadEnv();

import { connectToDatabase } from '../src/config/db';
import ForexArbTrade from '../src/models/ForexArbTrade';
import ExchangeKey from '../src/models/ExchangeKey';
import { getSharedCtraderAdapter } from '../src/strategy/forex/ctrader/ctrader-factory';

function extractPositionId(orderId?: string): string | undefined {
  if (!orderId) return undefined;
  const m = orderId.match(/Pos\s*#?(\d+)/i) || orderId.match(/(\d+)/);
  return m ? m[1] : undefined;
}

async function main() {
  await connectToDatabase();

  const trades = await ForexArbTrade.find({ type: 'close' }).lean();
  console.log(`🔎 ${trades.length} trade(s) do tipo 'close' encontrados.`);

  // Agrupa por userId os trades de fechamento cuja perna de saída ficou sem preço.
  const brokenByUser = new Map<string, { tradeId: any; strategyName: string; entryLeg: any; exitLeg: any; exitIdx: number }[]>();
  for (const t of trades) {
    const legs = t.legs || [];
    if (legs.length < 2) continue;
    const entryLeg = legs[0];
    const exitIdx = legs.length - 1;
    const exitLeg = legs[exitIdx];
    const exitPrice = Number(exitLeg?.price ?? 0);
    if (exitLeg && (!exitPrice || exitPrice <= 0)) {
      const uid = String(t.userId);
      if (!brokenByUser.has(uid)) brokenByUser.set(uid, []);
      brokenByUser.get(uid)!.push({
        tradeId: t._id,
        strategyName: t.strategyName || '',
        entryLeg,
        exitLeg,
        exitIdx,
      });
    }
  }

  const totalBroken = [...brokenByUser.values()].reduce((acc, arr) => acc + arr.length, 0);
  console.log(`⚠️ ${totalBroken} trade(s) de fechamento com preço de saída zerado.`);

  let fixed = 0;
  let skipped = 0;

  for (const [userId, items] of brokenByUser.entries()) {
    const keys = await ExchangeKey.find({ userId, active: true }).lean();
    const ctraderKey = keys.find((k: any) => k.exchangeId === 'ctrader');
    if (!ctraderKey) {
      console.log(`⏭️ Usuário ${userId}: sem ExchangeKey cTrader ativa. Pulando ${items.length} trade(s).`);
      skipped += items.length;
      continue;
    }

    let adapter: any;
    try {
      adapter = await getSharedCtraderAdapter(ctraderKey);
      await adapter.loadMarkets();
    } catch (e: any) {
      console.log(`❌ Usuário ${userId}: falha ao conectar na cTrader (${e.message}). Pulando ${items.length} trade(s).`);
      skipped += items.length;
      continue;
    }

    for (const item of items) {
      const posId = extractPositionId(item.entryLeg?.orderId);
      if (!posId) {
        console.log(`  ⏭️ ${item.strategyName}: orderId sem positionId (${item.entryLeg?.orderId}).`);
        skipped++;
        continue;
      }

      try {
        const deals = await adapter.fetchPositionDeals(posId);
        const closeDeal = deals.find((d: any) => d.hasCloseDetail) || deals[deals.length - 1];
        const closePrice = closeDeal?.price && Number(closeDeal.price) > 0 ? Number(closeDeal.price) : undefined;

        if (!closePrice) {
          console.log(`  ⏭️ ${item.strategyName} (Pos #${posId}): deal de fechamento sem preço.`);
          skipped++;
          continue;
        }

        await ForexArbTrade.updateOne(
          { _id: item.tradeId },
          { $set: { [`legs.${item.exitIdx}.price`]: closePrice } },
        );
        console.log(`  ✅ ${item.strategyName} (Pos #${posId}): preço de saída corrigido para ${closePrice}.`);
        fixed++;
      } catch (e: any) {
        console.log(`  ❌ ${item.strategyName} (Pos #${posId}): ${e.message}`);
        skipped++;
      }
    }

    await adapter.destroy().catch(() => {});
  }

  console.log(`\n✅ Concluído. Corrigidos: ${fixed} | Pulados: ${skipped}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ Erro fatal no script:', e);
  process.exit(1);
});
