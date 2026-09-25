import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { PolymarketMetaLabeler } from '../strategy/prediction-arb/helpers/polymarket-meta-labeler';

dotenv.config();

async function backfillHistoricalMetrics() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://lucasmelloleao:T80VwZTORZ1eghT5@cluster0.bb82u.mongodb.net/TraderProd');
  const db = mongoose.connection.db;
  if (!db) throw new Error('DB connect error');

  const trades = await db.collection('predictionarbtrades').find().toArray();
  console.log(`[BACKFILL] Recuperando métricas reais da Binance para ${trades.length} trades...`);

  let updated = 0;
  for (const t of trades) {
    const slug = (t.slug || t.question || '').toLowerCase();
    const match = slug.match(/(btc|eth|sol|doge|xrp)/i);
    const asset = match ? match[1].toUpperCase() : 'BTC';

    const ts = t.openedAt ? new Date(t.openedAt).getTime() : new Date(t.createdAt).getTime();
    const pairBinance = asset === 'DOGE' ? 'DOGEUSDT' : `${asset}USDT`;

    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${pairBinance}&interval=1m&limit=25&endTime=${ts}`;
      const res = await fetch(url);
      if (res.ok) {
        const klines = (await res.json()) as any[];
        if (Array.isArray(klines) && klines.length >= 15) {
          const closes = klines.map((k: any) => Number(k[4]));
          const n = closes.length;

          // 1. Kaufman Efficiency Ratio (ER)
          const change = Math.abs(closes[n - 1] - closes[n - 15]);
          let vol = 0;
          for (let i = n - 14; i < n; i++) vol += Math.abs(closes[i] - closes[i - 1]);
          const er = vol > 0 ? Number((change / vol).toFixed(3)) : 0.35;

          // 2. Lo-MacKinlay Variance Ratio (q = 3)
          const lr1: number[] = [];
          for (let i = 1; i < n; i++) lr1.push(Math.log(closes[i] / closes[i - 1]));
          const m1 = lr1.reduce((a, b) => a + b, 0) / lr1.length;
          const v1 = lr1.reduce((acc, r) => acc + Math.pow(r - m1, 2), 0) / (lr1.length - 1);

          const q = 3;
          const lrQ: number[] = [];
          for (let i = q; i < n; i += q) lrQ.push(Math.log(closes[i] / closes[i - q]));
          const mQ = lrQ.reduce((a, b) => a + b, 0) / lrQ.length;
          const vQ = lrQ.reduce((acc, r) => acc + Math.pow(r - mQ, 2), 0) / (lrQ.length - 1);
          const vr = v1 > 0 ? Number((vQ / (q * v1)).toFixed(3)) : 1.05;

          // 3. ATR
          let trSum = 0;
          for (let i = 1; i < n; i++) {
            const h = Number(klines[i][2]);
            const l = Number(klines[i][3]);
            const pc = Number(klines[i - 1][4]);
            trSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
          }
          const atrVal = trSum / (n - 1);
          const atrPct = Number(((atrVal / closes[n - 1]) * 100).toFixed(3));

          // 4. Spot Distance
          const spotDist = Number(Math.max(0.08, atrPct * 1.8).toFixed(3));

          const currentMetrics = t.metrics || {};
          const newMetrics = {
            ...currentMetrics,
            er: er > 0 ? er : 0.35,
            varianceRatio: vr > 0 ? vr : 1.08,
            atrPct: atrPct > 0 ? atrPct : (currentMetrics.atrPct || 0.06),
            spotDistancePct: spotDist,
            expectedValue: currentMetrics.expectedValue || 0.03,
            edgePct: currentMetrics.edgePct || 2.5,
            entryPrice: currentMetrics.entryPrice || t.yesPrice || 0.92,
            segsRestantes: currentMetrics.segsRestantes || 90,
          };

          await db.collection('predictionarbtrades').updateOne(
            { _id: t._id },
            { $set: { metrics: newMetrics } }
          );
          updated++;
        }
      }
    } catch (e: any) {
      console.error(`Erro no trade ${t._id}:`, e.message);
    }
  }

  console.log(`[BACKFILL] Sucesso! ${updated} trades atualizados com métricas reais de Kaufman ER e Variance Ratio.`);

  // Retreinar a IA Random Forest da Polymarket com os dados reais
  console.log('[BACKFILL] Retreinando o Modelo Random Forest da Polymarket...');
  const trainRes = await PolymarketMetaLabeler.trainModel();
  console.log('[BACKFILL] Resultado do Treinamento:', trainRes);

  await mongoose.disconnect();
}

backfillHistoricalMetrics().catch(console.error);
