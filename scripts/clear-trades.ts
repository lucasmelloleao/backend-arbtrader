import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import FxProTrade from '../src/models/FxProTrade';
import FxProStrategy from '../src/models/FxProStrategy';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || '');
  console.log('✅ Conectado ao MongoDB:', mongoose.connection.name);

  const d = await FxProTrade.deleteMany({});
  console.log(`🗑️ Trades deletados de FxProTrade: ${d.deletedCount}`);

  const u = await FxProStrategy.updateMany(
    {},
    {
      $unset: { currentPositionId: 1, currentSide: 1 },
      $set: { currentPnlUsd: 0, entryPrice: 0 },
    }
  );
  console.log(`✨ Estratégias resetadas (sem posições fantasmas): ${u.modifiedCount}`);

  await mongoose.disconnect();
  console.log('✅ Limpeza concluída com sucesso.');
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
