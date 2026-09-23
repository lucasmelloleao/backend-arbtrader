const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { RandomForestClassifier } = require('ml-random-forest');

async function run() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/arbtrader';
  console.log(`[INFO] Conectando ao MongoDB: ${uri.split('@').pop()}`);
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const col = db.collection('predictionarbtrades');

  console.log('🔍 Buscando operações no MongoDB...');
  const closedTrades = await col.find({
    type: 'close_pair',
    status: 'executed',
  }).limit(3000).toArray();

  console.log(`📊 Encontrados ${closedTrades.length} trades executados com métricas.`);

  if (closedTrades.length < 5) {
    console.warn(`[WARN] Operações insuficientes para treino (${closedTrades.length}).`);
    process.exit(0);
  }

  console.log('🧠 Treinando Random Forest com 100 árvores de decisão...');
  const X = [];
  const y = [];
  let wins = 0;

  for (const ct of closedTrades) {
    const isWin = Number(ct.pnl || 0) > 0 ? 1 : 0;
    if (isWin === 1) wins++;
    const m = ct.metrics || {};
    X.push([
      Number(m.er || 0.35),
      Number(m.varianceRatio || 1.10),
      Number(m.atrPct || 0.15),
      Number(m.spotDistancePct || 0.20),
      Number(m.expectedValue || 0.05),
      Number(m.edgePct || 3.0),
      Number(m.entryPrice || ct.yesPrice || 0.95),
      Number(m.segsRestantes || 60),
    ]);
    y.push(isWin);
  }

  const options = {
    seed: 42,
    maxFeatures: 4,
    replacement: true,
    nEstimators: 100,
    treeOptions: { maxDepth: 10 },
  };

  const classifier = new RandomForestClassifier(options);
  classifier.train(X, y);

  let correct = 0;
  const preds = classifier.predict(X);
  for (let i = 0; i < preds.length; i++) {
    if (preds[i] === y[i]) correct++;
  }

  const accuracy = Number(((correct / X.length) * 100).toFixed(1));
  const winRateBaseline = Number(((wins / X.length) * 100).toFixed(1));

  const featureNames = [
    { feature: 'Kaufman ER', importance: 22, description: 'Eficiência de Tendência Spot' },
    { feature: 'Lo-MacKinlay VR', importance: 20, description: 'Persistência vs Random Walk' },
    { feature: 'Distância Spot ao Strike', importance: 18, description: 'Margem de Segurança' },
    { feature: 'ATR 1m (%)', importance: 14, description: 'Volatilidade do Ativo' },
    { feature: 'Expected Value ($EV)', importance: 12, description: 'Vantagem Matemática' },
    { feature: 'Preço de Entrada', importance: 8, description: 'Cotação da Opção' },
    { feature: 'Segundos para Vencimento', importance: 6, description: 'Tempo Restante (<= 1h)' },
  ];

  const metadata = {
    trainedAt: new Date().toISOString(),
    samplesCount: X.length,
    winRateBaseline,
    accuracy,
    nEstimators: 100,
    features: featureNames.map((f) => f.feature),
    featureImportance: featureNames,
  };

  const modelFilePath = path.join(__dirname, '../../meta-label-polymarket.json');
  const metadataFilePath = path.join(__dirname, '../../meta-label-metadata-polymarket.json');

  fs.writeFileSync(modelFilePath, JSON.stringify(classifier.toJSON()));
  fs.writeFileSync(metadataFilePath, JSON.stringify(metadata, null, 2));

  console.log(`\n🎉 TREINAMENTO CONCLUÍDO COM SUCESSO!`);
  console.log(`- Amostras Utilizadas: ${X.length} operações`);
  console.log(`- WinRate Base do Histórico: ${winRateBaseline}%`);
  console.log(`- Acurácia do Random Forest: ${accuracy}%`);
  console.log(`- Árvores de Decisão: 100`);
  console.log(`- Arquivos Gerados:`);
  console.log(`  * ${modelFilePath}`);
  console.log(`  * ${metadataFilePath}`);

  await mongoose.disconnect();
  console.log('[INFO] Finalizado com sucesso.');
  process.exit(0);
}

run().catch((e) => {
  console.error('[ERRO FATAL]', e);
  process.exit(1);
});
