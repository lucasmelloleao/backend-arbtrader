import DerivSettings from '../../models/DerivSettings';
import DerivTrade from '../../models/DerivTrade';
import DerivStrategy from '../../models/DerivStrategy';
import { DerivWsClient } from './helpers/deriv-ws';

const log = {
  info: (msg: string, ...args: any[]) => console.log(`[DERIV-BOT] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[DERIV-BOT] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[DERIV-BOT] ${msg}`, ...args),
};

export async function runDerivCycle(): Promise<void> {
  const settings = await DerivSettings.findOne().lean();
  if (!settings || !settings.isScanningEnabled || !settings.apiToken) {
    return;
  }

  const client = new DerivWsClient(settings.appId || '1089', settings.apiToken);

  try {
    await client.connect();
    const accountInfo = await client.authorize().catch(() => null);

    if (!accountInfo) {
      log.warn('⚠️ Falha ao autorizar conta Deriv. Verifique o API Token.');
      client.close();
      return;
    }

    log.info('🔍 Ciclo de varredura Deriv WebSocket executado com sucesso.');

    // 1. Monitorar posições abertas
    const openTrades = await DerivTrade.find({ userId: settings.userId, status: 'open' }).lean();

    for (const trade of openTrades) {
      try {
        const contractInfo = await client.getOpenContract(trade.contractId).catch(() => null);
        if (!contractInfo) continue;

        const isSold = Boolean(contractInfo.is_sold);
        const currentProfit = Number(contractInfo.profit || 0);
        const buyPrice = Number(trade.buyPrice || trade.investedUsd || 0);
        const currentPayout = Number(contractInfo.bid_price || 0);

        // A. Se o contrato já foi encerrado/expirou na Deriv
        if (isSold || contractInfo.is_expired) {
          const finalProfit = Number(contractInfo.profit || 0);
          const sellPrice = Number(contractInfo.sell_price || currentPayout || 0);
          await DerivTrade.updateOne(
            { _id: trade._id },
            {
              status: 'executed',
              sellPrice: sellPrice,
              realizedUsd: buyPrice + finalProfit,
              pnl: finalProfit,
              reason: finalProfit >= 0 ? 'Vencimento (Lucro)' : 'Vencimento (Perda)',
              closedAt: new Date(),
            }
          );
          log.info(`✅ [${trade.symbol}] Contrato ${trade.contractId} finalizado no vencimento. PnL: $${finalProfit.toFixed(2)}`);
          continue;
        }

        // B. Saída Antecipada (Take Profit ou Emergency Stop)
        const profitPct = buyPrice > 0 ? (currentProfit / buyPrice) * 100 : 0;

        // Take Profit Antecipado (ganho % >= minTakeProfitPct)
        if (profitPct >= (settings.minTakeProfitPct || 2.0)) {
          log.info(`🎯 [${trade.symbol}] TAKE PROFIT ANTECIPADO: Lucro de +${profitPct.toFixed(2)}% ($${currentProfit.toFixed(2)}). Vendendo contrato...`);
          await client.sellContract(trade.contractId, 0).catch(() => {});
        }
        // Emergency Stop Out (perda % >= emergencyStopPct)
        else if (profitPct <= -(settings.emergencyStopPct || 20.0)) {
          log.warn(`🚨 [${trade.symbol}] EMERGENCY STOP OUT: Prejuízo de ${profitPct.toFixed(2)}%. Vendendo contrato...`);
          await client.sellContract(trade.contractId, 0).catch(() => {});
        }
      } catch (e: any) {
        log.warn(`⚠️ Erro ao monitorar contrato ${trade.contractId}: ${e.message}`);
      }
    }

    // 2. Verificar se podemos abrir novas posições
    if (!settings.allowLiveTrading) {
      client.close();
      return;
    }

    const openCount = await DerivTrade.countDocuments({ userId: settings.userId, status: 'open' });
    if (openCount >= (settings.maxOpenContracts || 3)) {
      client.close();
      return;
    }

    // Exemplo de abertura estratégica rápida em um dos símbolos permitidos
    const symbols = settings.allowedSymbols || ['frxBTCUSD', 'frxETHUSD', 'R_100'];
    const selectedSymbol = symbols[Math.floor(Math.random() * symbols.length)];

    // Requisita proposta para um contrato RISE (Call) de 5 minutos
    const proposal = await client.getProposal({
      symbol: selectedSymbol,
      contract_type: 'CALL',
      amount: settings.tradeSize || 5,
      duration: settings.contractDurationSec || 300,
      duration_unit: 's',
    }).catch(() => null);

    if (proposal && proposal.id) {
      const bought = await client.buyContract(proposal.id, proposal.ask_price).catch(() => null);
      if (bought && bought.contract_id) {
        await DerivTrade.create({
          userId: settings.userId,
          contractId: String(bought.contract_id),
          symbol: selectedSymbol,
          question: `Opção ${selectedSymbol} (RISE 5m)`,
          contractType: 'RISE',
          status: 'open',
          buyPrice: Number(bought.buy_price || settings.tradeSize || 5),
          investedUsd: Number(bought.buy_price || settings.tradeSize || 5),
          reason: 'Entrada automática via scanner WebSocket Deriv',
          openedAt: new Date(),
        });
        log.info(`🚀 [${selectedSymbol}] Novo contrato comprado na Deriv ID: ${bought.contract_id}`);
      }
    }
  } catch (e: any) {
    log.error(`❌ Erro no ciclo do robô Deriv: ${e.message}`);
  } finally {
    client.close();
  }
}
