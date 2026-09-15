import mongoose from 'mongoose';
import ForexArbStrategy from './src/models/ForexArbStrategy';
import ForexArbTrade from './src/models/ForexArbTrade';
import BotStatus from './src/models/BotStatus';

mongoose.connect('mongodb+srv://lucasmelloleao:T80VwZTORZ1eghT5@cluster0.bb82u.mongodb.net/TraderProd')
  .then(() => {
    console.log('Connected to MongoDB');
    return Promise.all([
      ForexArbStrategy.find({ positionOpen: true }).lean(),
      ForexArbTrade.find({ type: 'close' }).sort({ createdAt: -1 }).limit(10).lean(),
      BotStatus.find({ botName: 'forex-trend-grid' }).sort({ lastHeartbeat: -1 }).limit(1).lean()
    ]);
  })
  .then(([strategies, trades, botStatus]) => {
    console.log('=== Strategies with positionOpen=true ===');
    console.log('Total:', strategies.length);
    strategies.forEach(s => {
      console.log(' -', s.name, '| type:', s.type, '| isGrid:', s.isGrid, '| gridLevelsCount:', s.gridLevelsCount, '| legs:', s.legs?.length, '| exchangeId:', s.exchangeId);
    });

    console.log('\n=== Recent closed trades ===');
    trades.forEach(t => {
      console.log(' -', t.strategyName, '| type:', t.type, '| realizedPnl:', t.realizedPnl);
    });

    console.log('\n=== Bot Status ===');
    console.log(botStatus);

    mongoose.disconnect();
  })
  .catch(e => console.error('Error:', e));