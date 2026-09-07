require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const trades = await db.collection('perparbtrades').find({
    type: { $in: ['open_hedge', 'close_hedge', 'funding_fee_accumulated'] }
  }).sort({ createdAt: -1 }).limit(50).toArray();

  console.log(`Encontrados ${trades.length} trades para enriquecimento...`);

  let updatedCount = 0;
  for (const t of trades) {
    const amt = Number(t.amount || 0);
    if (amt <= 0) continue;

    // Estima fees baseadas em 0.08% taker no perp e 0.1% no spot se não existirem
    const spotFee = amt * 0.0010;
    const perpFee = amt * 0.0008;

    let tradingFees = Number(t.tradingFees || 0);
    let netPnl = t.netPnl;

    if (t.type === 'open_hedge') {
      if (!t.tradingFees || t.tradingFees === 0) {
        tradingFees = Number((spotFee + perpFee).toFixed(4));
      }
      await db.collection('perparbtrades').updateOne(
        { _id: t._id },
        {
          $set: {
            tradingFees,
            feeDetails: t.feeDetails || {
              spotOpenFee: Number(spotFee.toFixed(4)),
              perpOpenFee: Number(perpFee.toFixed(4)),
              spotCloseFee: 0,
              perpCloseFee: 0
            }
          }
        }
      );
      updatedCount++;
    } else if (t.type === 'close_hedge') {
      const grossPnl = Number(t.pnl || 0);
      const totalFees = Number((spotFee * 2 + perpFee * 2).toFixed(4));
      const calculatedNetPnl = Number((grossPnl - totalFees).toFixed(4));

      await db.collection('perparbtrades').updateOne(
        { _id: t._id },
        {
          $set: {
            tradingFees: t.tradingFees || totalFees,
            netPnl: t.netPnl !== undefined && t.netPnl !== null ? t.netPnl : calculatedNetPnl,
            feeDetails: t.feeDetails || {
              spotOpenFee: Number(spotFee.toFixed(4)),
              perpOpenFee: Number(perpFee.toFixed(4)),
              spotCloseFee: Number(spotFee.toFixed(4)),
              perpCloseFee: Number(perpFee.toFixed(4))
            }
          }
        }
      );
      updatedCount++;
    }
  }

  console.log(`✅ ${updatedCount} trades anteriores atualizados com sucesso com o calculo retroativo de taxas!`);
  process.exit(0);
}
main();
