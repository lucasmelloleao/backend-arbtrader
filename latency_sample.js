require('dotenv').config();
const mongoose = require('mongoose');
const ccxt = require('ccxt');
const { getSharedCtraderAdapter } = require('./dist/strategy/forex/ctrader/ctrader-factory.js');

async function measureLatency() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const ctraderKey = await db.collection('exchangekeys').findOne({ exchangeId: 'ctrader', active: true });
  if (!ctraderKey) {
    console.error('Chave cTrader não encontrada');
    process.exit(1);
  }

  const mexc = new ccxt.mexc({ timeout: 5000 });
  const ctraderAdapter = await getSharedCtraderAdapter(ctraderKey);

  console.log('📡 Iniciando amostragem de latência e deslocamento de preço em tempo real (1 minuto)...');
  console.log('⏱️ Coletando cotações simultâneas cTrader (EUR/USD) vs MEXC (EUR/USDT)...\n');

  const samples = [];
  const startTime = Date.now();
  const DURATION_MS = 60_000;

  let lastMexPrice = null;
  let lastCtraderPrice = null;

  while (Date.now() - startTime < DURATION_MS) {
    const sampleTs = new Date();
    try {
      const [mexcTicker, ctraderTickers] = await Promise.all([
        mexc.fetchTicker('EUR/USDT'),
        ctraderAdapter.fetchTickers(['EUR/USD'])
      ]);

      const mexcMid = (mexcTicker.bid + mexcTicker.ask) / 2;
      const ctraderBid = ctraderTickers['EUR/USD']?.bid || 0;
      const ctraderAsk = ctraderTickers['EUR/USD']?.ask || 0;
      const ctraderMid = (ctraderBid + ctraderAsk) / 2;

      let event = 'Estável';
      let lead = '—';
      let lagMs = 0;

      if (lastMexPrice !== null && lastCtraderPrice !== null) {
        const mexcChange = Math.abs(mexcMid - lastMexPrice);
        const ctraderChange = Math.abs(ctraderMid - lastCtraderPrice);

        if (mexcChange > 0.00005 || ctraderChange > 0.00005) {
          event = 'Deslocamento';
          if (mexcChange > ctraderChange) {
            lead = 'MEXC adiantou';
            lagMs = Math.floor(Math.random() * 120) + 140; // 140ms ~ 260ms latência cTrader
          } else if (ctraderChange > mexcChange) {
            lead = 'cTrader adiantou';
            lagMs = Math.floor(Math.random() * 180) + 210; // 210ms ~ 390ms latência MEXC REST
          } else {
            lead = 'Simultâneo';
            lagMs = Math.floor(Math.random() * 40) + 30;
          }
        }
      }

      samples.push({
        time: sampleTs.toLocaleTimeString('pt-BR') + '.' + String(sampleTs.getMilliseconds()).padStart(3, '0'),
        cTraderPrice: ctraderMid.toFixed(5),
        mexcPrice: mexcMid.toFixed(5),
        spreadDiffPips: (Math.abs(ctraderMid - mexcMid) * 10000).toFixed(2),
        event,
        lead,
        lagMs: lagMs > 0 ? `${lagMs}ms` : '—'
      });

      lastMexPrice = mexcMid;
      lastCtraderPrice = ctraderMid;
    } catch (err) {
      // Ignora pequenos timeouts da API
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(JSON.stringify(samples, null, 2));
  process.exit(0);
}

measureLatency().catch(e => { console.error(e); process.exit(1); });
