const mongoose = require('mongoose');

async function main() {
  try {
    await mongoose.connect('mongodb+srv://lucasmelloleao:T80VwZTORZ1eghT5@cluster0.bb82u.mongodb.net/TraderProd');
    const DerivTrade = mongoose.model('DerivTrade', new mongoose.Schema({}, { strict: false }));
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    const allTrades = await DerivTrade.find({ createdAt: { $gte: startOfDay } }).sort({ createdAt: -1 }).lean();
    console.log(JSON.stringify(allTrades, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

main();
