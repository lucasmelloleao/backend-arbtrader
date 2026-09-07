require('dotenv').config();
const mongoose = require('mongoose');

async function fixCnpyTrade() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const closeId = new mongoose.Types.ObjectId('6a9f1270dd1aa9b18ddca528');

  // Valores reais consultados na MEXC:
  // Open Spot: 2019.96 CNPY comprados por $450.00 (avg $0.222776)
  // Close Spot: 2019.96 CNPY vendidos por $387.064 (avg $0.191619) -> Spot PnL = -$62.936 USDT
  // Open Perp Short: 2007 contratos @ $0.223937 -> notional = $449.443 USDT
  // Close Perp Buy: 2007 contratos @ $0.193104 -> notional = $387.559 USDT -> Perp PnL = +$61.884 USDT
  // Funding Coletado: +$0.26028 USDT
  // PnL Bruto Real = -62.936 + 61.884 + 0.26028 = -$0.7917 USDT
  // Taxas Totais MEXC = $1.5067 USDT
  // PnL Liquido Real = -0.7917 - 1.5067 = -$2.2984 USDT (Perda Real de -$2.30 USDT)

  const realSpotPnL = -62.936;
  const realPerpPnL = 61.884;
  const realFunding = 0.26028;
  const realGrossPnL = -0.7917;
  const realFees = 1.5067;
  const realNetPnL = -2.2984;

  await db.collection('perparbtrades').updateOne(
    { _id: closeId },
    {
      $set: {
        spotPrice: 0.222776,
        spotExitPrice: 0.191619,
        perpPrice: 0.223937,
        perpExitPrice: 0.193104,
        spotPnl: realSpotPnL,
        perpPnl: realPerpPnL,
        fundingCollected: realFunding,
        pnl: realGrossPnL,
        tradingFees: realFees,
        netPnl: realNetPnL,
        feeDetails: {
          spotOpenFee: 0.45,
          perpOpenFee: 0.3596,
          spotCloseFee: 0.3871,
          perpCloseFee: 0.3100
        }
      }
    }
  );

  console.log('✅ Trade CNPY corrigido no banco com os valores exatos de executados na MEXC!');
  console.log(`PnL Bruto: $${realGrossPnL} USDT | Taxas: $${realFees} USDT | PnL Liquido Real: $${realNetPnL} USDT`);
  process.exit(0);
}
fixCnpyTrade();
