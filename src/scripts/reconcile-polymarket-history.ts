import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://lucasmelloleao:T80VwZTORZ1eghT5@cluster0.bb82u.mongodb.net/TraderProd');
  const db = mongoose.connection.db;
  if (!db) throw new Error('DB connection failed');

  const key = await db.collection('exchangekeys').findOne({ exchangeId: 'polymarket' });
  const dw = key?.depositWallet || key?.apiKey;
  const userId = key?.userId;

  const dataBase = process.env.POLYMARKET_DATA_BASE || 'https://proxy-vercel-lilac.vercel.app/api/proxy/data';
  const minTs = Math.floor((Date.now() - 72 * 3600 * 1000) / 1000);
  const url = `${dataBase}/activity?user=${dw}&limit=500&start_ts=${minTs}`;
  
  const res = await fetch(url);
  const activity = await res.json();
  const events = Array.isArray(activity) ? activity.filter((a: any) => a.type === 'TRADE' || a.type === 'REDEEM') : [];

  const porMercado = new Map<string, any[]>();
  for (const e of events) {
    const cond = String(e.conditionId || '');
    if (!cond) continue;
    if (!porMercado.has(cond)) porMercado.set(cond, []);
    porMercado.get(cond)!.push(e);
  }

  await db.collection('predictionarbtrades').deleteMany({
    reason: /Sincronizado da Polymarket/
  });

  let inseridos = 0;

  for (const [cond, evs] of porMercado) {
    const slug = String(evs[0]?.slug || evs[0]?.title || 'polymarket');
    const question = String(evs[0]?.title || evs[0]?.slug || slug);

    const buys = evs.filter((e: any) => e.type === 'TRADE' && e.side === 'BUY');
    const sells = evs.filter((e: any) => e.type === 'TRADE' && e.side === 'SELL');
    const redeems = evs.filter((e: any) => e.type === 'REDEEM');

    const invested = buys.reduce((acc: number, t: any) => acc + Number(t.usdcSize || 0), 0);
    const realized = sells.reduce((acc: number, t: any) => acc + Number(t.usdcSize || 0), 0) + redeems.reduce((acc: number, t: any) => acc + Number(t.usdcSize || 0), 0);
    const pnl = Number((realized - invested).toFixed(4));

    const isYes = (e: any) => String(e.outcome || '').toLowerCase() === 'up' || String(e.outcome || '').toLowerCase() === 'yes';
    const isNo = (e: any) => String(e.outcome || '').toLowerCase() === 'down' || String(e.outcome || '').toLowerCase() === 'no';
    const buysYes = buys.filter(isYes);
    const buysNo = buys.filter(isNo);
    const yesShares = buysYes.reduce((acc: number, t: any) => acc + Number(t.size || 0), 0);
    const noShares = buysNo.reduce((acc: number, t: any) => acc + Number(t.size || 0), 0);

    const firstTs = Math.min(...evs.map((e: any) => e.timestamp || Math.floor(Date.now() / 1000)));
    const lastTs = Math.max(...evs.map((e: any) => e.timestamp || Math.floor(Date.now() / 1000)));

    const saiu = realized > 0;
    const soRedeem = sells.length === 0 && redeems.length > 0;
    const soVenda = sells.length > 0 && redeems.length === 0;
    const saidaTipo = soRedeem ? 'redeem-vencimento' : (soVenda ? 'venda-antecipada' : 'mista');
    const motivoSaida = saiu ? `Sincronizado da Polymarket [saída: ${saidaTipo}]` : 'Sincronizado da Polymarket';

    await db.collection('predictionarbtrades').insertOne({
      userId,
      marketId: cond,
      slug,
      question,
      yesShares,
      noShares,
      amount: invested,
      investedUsd: invested,
      realizedUsd: realized,
      pnl,
      type: saiu ? 'close_pair' : 'open_pair',
      status: 'executed',
      reason: motivoSaida,
      openedAt: new Date(firstTs * 1000),
      createdAt: new Date(lastTs * 1000),
    });
    inseridos++;
  }

  console.log(`RE-SINCRONIZADO DO ZERO COM SUCESSO: ${inseridos} operações.`);

  const cutoff24 = new Date(Date.now() - 24 * 3600 * 1000);
  const allClosed = await db.collection('predictionarbtrades').find({ type: 'close_pair' }).toArray();
  const trades24 = allClosed.filter((t: any) => new Date(t.createdAt) >= cutoff24);

  let sumPnl24 = 0;
  let wins = 0, losses = 0, inv24 = 0, real24 = 0;
  const byAsset: Record<string, any> = {};

  for (const t of trades24) {
    const p = Number(t.pnl || 0);
    sumPnl24 += p;
    inv24 += Number(t.investedUsd || 0);
    real24 += Number(t.realizedUsd || 0);
    if (p >= 0) wins++; else losses++;

    let asset = 'OUTROS';
    const q = (t.question || t.slug || '').toUpperCase();
    if (q.includes('BITCOIN') || q.includes('BTC')) asset = 'BTC';
    else if (q.includes('ETHEREUM') || q.includes('ETH')) asset = 'ETH';
    else if (q.includes('SOLANA') || q.includes('SOL')) asset = 'SOL';
    else if (q.includes('XRP') || q.includes('RIPPLE')) asset = 'XRP';
    else if (q.includes('DOGE')) asset = 'DOGE';

    if (!byAsset[asset]) byAsset[asset] = { count: 0, wins: 0, losses: 0, pnl: 0, invested: 0, realized: 0 };
    byAsset[asset].count++;
    if (p >= 0) byAsset[asset].wins++; else byAsset[asset].losses++;
    byAsset[asset].pnl += p;
    byAsset[asset].invested += Number(t.investedUsd || 0);
    byAsset[asset].realized += Number(t.realizedUsd || 0);
  }

  console.log('\n--- DADOS RECONCILIADOS EXATOS DAS ÚLTIMAS 24 HORAS ---');
  console.log('Total de Operações Concluídas:', trades24.length);
  console.log('Investido Total ($):', inv24.toFixed(2));
  console.log('Realizado Total ($):', real24.toFixed(2));
  console.log('P/L Líquido Real ($):', sumPnl24.toFixed(2));
  console.log('Wins (Lucro):', wins, '| Losses (Prejuízo):', losses);
  console.log('Taxa de Acerto Real:', ((wins / trades24.length) * 100).toFixed(1) + '%');
  console.log('\nPOR ATIVO (24H RECONCILIADO):');
  console.dir(byAsset, { depth: null });

  await mongoose.disconnect();
}

main().catch(console.error);
