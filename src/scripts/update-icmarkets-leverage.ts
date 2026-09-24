import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://lucasmelloleao:T80VwZTORZ1eghT5@cluster0.bb82u.mongodb.net/TraderProd');
  const db = mongoose.connection.db;
  if (!db) throw new Error('DB connection failed');

  const res1 = await db.collection('icmarketssettings').updateMany(
    {},
    { $set: { defaultLeverage: 200 } }
  );
  console.log(`Settings IC Markets atualizadas: ${res1.modifiedCount}`);

  const res2 = await db.collection('icmarketsstrategies').updateMany(
    {},
    { $set: { leverage: 200 } }
  );
  console.log(`Estratégias IC Markets atualizadas: ${res2.modifiedCount}`);

  const docs = await db.collection('icmarketssettings').find({}).toArray();
  console.log('SETTINGS:', docs);

  await mongoose.disconnect();
}

main().catch(console.error);
