require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  console.log('🌾 Iniciando atualização ultra rápida de todos os trades históricos...');

  const closeTrades = await db.collection('perparbtrades').find({
    type: 'close_hedge',
    status: { $in: ['executed', 'simulated', 'voided'] }
  }).toArray();

  console.log(`Encontrados ${closeTrades.length} trades para recalcular...`);

  let updatedCount = 0;

  for (const trade of closeTrades) {
    const amount = Number(trade.amount || 0);

    // Tenta encontrar o trade de abertura correspondente
    const openTrade = await db.collection('perparbtrades').findOne({
      $or: [
        ...(trade.openTradeId ? [{ _id: trade.openTradeId }] : []),
        { strategyId: trade.strategyId, type: 'open_hedge' },
        { perpSymbol: trade.perpSymbol, type: 'open_hedge' }
      ]
    });

    const entrySpotPrice = Number(openTrade?.spotPrice || trade.spotPrice || 0);
    const entryPerpPrice = Number(openTrade?.perpPrice || trade.perpPrice || 0);
    const exitSpotPrice = Number(trade.spotExitPrice || trade.spotPrice || 0);
    const exitPerpPrice = Number(trade.perpExitPrice || trade.perpPrice || 0);

    let spotPnL = Number(trade.spotPnl || 0);
    let perpPnL = Number(trade.perpPnl || 0);

    if (spotPnL === 0 && entrySpotPrice > 0 && exitSpotPrice > 0) {
      spotPnL = ((exitSpotPrice - entrySpotPrice) / entrySpotPrice) * amount;
    }
    if (perpPnL === 0 && entryPerpPrice > 0 && exitPerpPrice > 0) {
      perpPnL = ((entryPerpPrice - exitPerpPrice) / entryPerpPrice) * amount;
    }

    const fundingCollected = Number(trade.fundingCollected || 0);
    const grossPnL = Number((spotPnL + perpPnL + fundingCollected).toFixed(4));

    // Estima as 4 taxas de ordem (Spot Buy, Perp Sell, Spot Sell, Perp Buy) se não existirem
    const spotOpenFee = Number(openTrade?.feeDetails?.spotOpenFee ?? (amount * 0.0010));
    const perpOpenFee = Number(openTrade?.feeDetails?.perpOpenFee ?? (amount * 0.0008));
    const spotCloseFee = Number(trade.feeDetails?.spotCloseFee ?? (amount * 0.0010));
    const perpCloseFee = Number(trade.feeDetails?.perpCloseFee ?? (amount * 0.0008));

    const totalFees = Number((spotOpenFee + perpOpenFee + spotCloseFee + perpCloseFee).toFixed(4));
    const netPnL = Number((grossPnL - totalFees).toFixed(4));

    await db.collection('perparbtrades').updateOne(
      { _id: trade._id },
      {
        $set: {
          spotPrice: entrySpotPrice,
          spotExitPrice: exitSpotPrice,
          perpPrice: entryPerpPrice,
          perpExitPrice: exitPerpPrice,
          spotPnl: Number(spotPnL.toFixed(4)),
          perpPnl: Number(perpPnL.toFixed(4)),
          pnl: grossPnL,
          tradingFees: totalFees,
          netPnl: netPnL,
          feeDetails: {
            spotOpenFee: Number(spotOpenFee.toFixed(4)),
            perpOpenFee: Number(perpOpenFee.toFixed(4)),
            spotCloseFee: Number(spotCloseFee.toFixed(4)),
            perpCloseFee: Number(perpCloseFee.toFixed(4)),
          }
        }
      }
    );
    updatedCount++;
  }

  console.log(`✅ Sucesso! Todas as ${updatedCount} operações encerradas foram recalculadas com tarifas reais/estimadas e PnL Líquido!`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
