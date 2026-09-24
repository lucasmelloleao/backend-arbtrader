import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://lucasmelloleao:T80VwZTORZ1eghT5@cluster0.bb82u.mongodb.net/TraderProd');
  const db = mongoose.connection.db;
  if (!db) throw new Error('DB connection failed');

  // 1. Limpar todas as operações do histórico da IC Markets
  const delTrades = await db.collection('icmarketstrades').deleteMany({});
  console.log(`Operações da IC Markets deletadas: ${delTrades.deletedCount}`);

  // 2. Resetar contadores das estratégias da IC Markets
  const resetStrat = await db.collection('icmarketsstrategies').updateMany(
    {},
    {
      $set: {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalProfitUsd: 0,
        currentPnlUsd: 0,
        entryPrice: 0,
      },
      $unset: {
        currentPositionId: 1,
        currentSide: 1,
        lastError: 1,
      }
    }
  );
  console.log(`Estratégias IC Markets resetadas: ${resetStrat.modifiedCount}`);

  // 3. Deletar arquivos salvos do treinamento da IA da IC Markets
  const rootDir = path.resolve(__dirname, '../../');
  const modelFile = path.join(rootDir, 'meta-label-icmarkets.json');
  const metaFile = path.join(rootDir, 'meta-label-metadata-icmarkets.json');

  if (fs.existsSync(modelFile)) {
    fs.unlinkSync(modelFile);
    console.log(`Arquivo do modelo removido: ${modelFile}`);
  }
  if (fs.existsSync(metaFile)) {
    fs.unlinkSync(metaFile);
    console.log(`Arquivo de metadados removido: ${metaFile}`);
  }

  console.log('✅ Base de dados e treinamento da IA para a IC Markets resetados com sucesso.');
  await mongoose.disconnect();
}

main().catch(console.error);
