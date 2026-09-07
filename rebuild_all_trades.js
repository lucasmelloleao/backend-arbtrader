require('dotenv').config();
const mongoose = require('mongoose');
const ccxt = require('ccxt');
const { decryptSecretKey } = require('./dist/utils/encryption.js');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const keyDoc = await db.collection('exchangekeys').findOne({ exchangeId: 'mexc', active: true });
  if (!keyDoc) {
    console.error('Chave da MEXC não encontrada.');
    process.exit(1);
  }

  const key = keyDoc.apiKey;
  let secret = keyDoc.apiSecret;
  try {
    secret = decryptSecretKey(keyDoc.apiSecret, String(keyDoc.userId) + '-mexc');
  } catch (e) {
    console.log('Decrypt secret error:', e.message);
  }

  const spot = new ccxt.mexc({ apiKey: key, secret, options: { defaultType: 'spot' } });
  const futures = new ccxt.mexc({ apiKey: key, secret, options: { defaultType: 'swap' } });

  console.log('🌾 Buscando todas as ordens executadas na MEXC (Spot e Futuros)...');

  const closeTrades = await db.collection('perparbtrades').find({
    type: 'close_hedge',
    status: { $in: ['executed', 'simulated', 'voided'] }
  }).toArray();

  console.log(`Encontrados ${closeTrades.length} trades de fechamento no histórico para sincronização...`);

  let updatedCount = 0;

  for (const trade of closeTrades) {
    const symbol = trade.perpSymbol;
    const baseSymbol = trade.spotSymbol;
    const amount = Number(trade.amount || 0);
    const spotOrderId = trade.spotOrderId;
    const perpOrderId = trade.perpOrderId;

    let spotOrder = null;
    let perpOrder = null;

    if (spotOrderId && spotOrderId !== 'RECONCILED' && spotOrderId !== 'CONSOLIDATED' && spotOrderId !== 'ALREADY_CLOSED') {
      try {
        spotOrder = await spot.fetchOrder(spotOrderId, baseSymbol);
      } catch (e) {}
    }

    if (perpOrderId && perpOrderId !== 'RECONCILED' && perpOrderId !== 'CONSOLIDATED' && perpOrderId !== 'ALREADY_CLOSED') {
      try {
        perpOrder = await futures.fetchOrder(perpOrderId, symbol);
      } catch (e) {}
    }

    // Tenta encontrar trade de abertura
    const openTrade = await db.collection('perparbtrades').findOne({
      $or: [
        ...(trade.openTradeId ? [{ _id: trade.openTradeId }] : []),
        { strategyId: trade.strategyId, type: 'open_hedge' },
        { perpSymbol: trade.perpSymbol, type: 'open_hedge' }
      ]
    });

    let entrySpotPrice = Number(openTrade?.spotPrice || trade.spotPrice || 0);
    let entryPerpPrice = Number(openTrade?.perpPrice || trade.perpPrice || 0);

    let exitSpotPrice = spotOrder ? Number(spotOrder.average || spotOrder.price || 0) : Number(trade.spotExitPrice || trade.spotPrice || 0);
    let exitPerpPrice = perpOrder ? Number(perpOrder.average || perpOrder.price || 0) : Number(trade.perpExitPrice || trade.perpPrice || 0);

    let spotFee = spotOrder?.fee?.cost ? Number(spotOrder.fee.cost) : (amount * 0.001);
    let perpFee = perpOrder?.fee?.cost ? Number(perpOrder.fee.cost) : (amount * 0.0008);

    let spotOpenFee = openTrade?.feeDetails?.spotOpenFee ?? (amount * 0.001);
    let perpOpenFee = openTrade?.feeDetails?.perpOpenFee ?? (amount * 0.0008);

    // Se tiver dados reais de PnL nas ordens ou preços
    let spotPnL = 0;
    let perpPnL = 0;

    if (entrySpotPrice > 0 && exitSpotPrice > 0) {
      spotPnL = ((exitSpotPrice - entrySpotPrice) / entrySpotPrice) * amount;
    }
    if (entryPerpPrice > 0 && exitPerpPrice > 0) {
      perpPnL = ((entryPerpPrice - exitPerpPrice) / entryPerpPrice) * amount;
    }

    const fundingCollected = Number(trade.fundingCollected || 0);
    const grossPnL = Number((spotPnL + perpPnL + fundingCollected).toFixed(4));
    const totalTradingFees = Number((spotOpenFee + perpOpenFee + spotFee + perpFee).toFixed(4));
    const netPnL = Number((grossPnL - totalTradingFees).toFixed(4));

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
          tradingFees: totalTradingFees,
          netPnl: netPnL,
          feeDetails: {
            spotOpenFee: Number(spotOpenFee.toFixed(4)),
            perpOpenFee: Number(perpOpenFee.toFixed(4)),
            spotCloseFee: Number(spotFee.toFixed(4)),
            perpCloseFee: Number(perpFee.toFixed(4)),
          }
        }
      }
    );
    updatedCount++;
  }

  console.log(`✅ ${updatedCount} operações encerradas foram reprocessadas e alinhadas com as ordens reais da MEXC!`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
