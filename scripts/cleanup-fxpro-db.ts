import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import FxProTrade from '../src/models/FxProTrade';
import FxProStrategy from '../src/models/FxProStrategy';
import ExchangeKey from '../src/models/ExchangeKey';
import { getSharedCtraderAdapter } from '../src/strategy/forex/ctrader/ctrader-factory';

async function main() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/TraderProd';
  await mongoose.connect(uri);
  console.log('✅ Conectado ao MongoDB:', mongoose.connection.name);

  // 1. Obter chave da cTrader
  const key = await ExchangeKey.findOne({
    exchangeId: { $in: ['fxpro', 'fxpro-ctrader', 'ctrader', 'pepperstone'] },
    active: true,
  }).lean();

  const livePositionIds = new Set<string>();

  if (key) {
    try {
      console.log('🔄 Consultando cTrader Open API para posições ativas...');
      const adapter = await getSharedCtraderAdapter(key);
      const posMap = await adapter.getPositionsPnL();
      for (const [posId, data] of posMap.entries()) {
        if (/^\d+$/.test(posId)) {
          livePositionIds.add(posId);
          console.log(`📌 Posição ativa na cTrader: #${posId} (${data.symbol} ${data.side} ${data.volume} lotes)`);
        }
      }
    } catch (e: any) {
      console.error('⚠️ Erro ao consultar cTrader:', e.message);
    }
  } else {
    console.warn('⚠️ Nenhuma ExchangeKey cTrader ativa encontrada.');
  }

  console.log(`\n🔍 Total de posições ativas na cTrader: ${livePositionIds.size}`);

  // 2. Deletar trades que não estão na cTrader
  const allTrades = await FxProTrade.find({}).lean();
  console.log(`📊 Total de trades registrados em FxProTrade: ${allTrades.length}`);

  let deletedCount = 0;
  for (const t of allTrades) {
    if (!livePositionIds.has(String(t.positionId))) {
      await FxProTrade.findByIdAndDelete(t._id);
      deletedCount++;
    }
  }
  console.log(`🗑️ Trades deletados do Mongo: ${deletedCount}`);

  // 3. Limpar currentPositionId das estratégias se a posição não estiver na cTrader
  const allStrategies = await FxProStrategy.find({});
  let clearedStrats = 0;
  for (const s of allStrategies) {
    if (s.currentPositionId && !livePositionIds.has(String(s.currentPositionId))) {
      console.log(`🧹 Limpando posição fantasma #${s.currentPositionId} da estratégia "${s.name}" (${s.symbol})`);
      s.currentPositionId = undefined as any;
      s.currentSide = null as any;
      s.entryPrice = 0;
      s.currentPnlUsd = 0;
      await s.save();
      clearedStrats++;
    }
  }
  console.log(`✨ Estratégias limpas: ${clearedStrats}`);

  await mongoose.disconnect();
  console.log('✅ Concluído com sucesso!');
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ Falha:', e);
  process.exit(1);
});
