import DerivSettings from '../../models/DerivSettings';
import DerivTrade from '../../models/DerivTrade';
import DerivStrategy from '../../models/DerivStrategy';
import { DerivWsClient } from './helpers/deriv-ws';

const inMemoryDerivLogs: string[] = [];
const MAX_BUFFER = 500;

export function addDerivLog(msg: string) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [DERIV-BOT] ${msg}`;
  inMemoryDerivLogs.unshift(entry);
  if (inMemoryDerivLogs.length > MAX_BUFFER) {
    inMemoryDerivLogs.pop();
  }
}

export function getDerivLogBuffer(): string[] {
  return [...inMemoryDerivLogs];
}

const log = {
  info: (msg: string, ...args: any[]) => {
    addDerivLog(`💡 ${msg}`);
    console.log(`[DERIV-BOT] ${msg}`, ...args);
  },
  warn: (msg: string, ...args: any[]) => {
    addDerivLog(`⚠️ ${msg}`);
    console.warn(`[DERIV-BOT] ${msg}`, ...args);
  },
  error: (msg: string, ...args: any[]) => {
    addDerivLog(`❌ ${msg}`);
    console.error(`[DERIV-BOT] ${msg}`, ...args);
  },
};

export async function runDerivCycle(): Promise<void> {
  const allSettings = await DerivSettings.find().lean();
  if (!allSettings || allSettings.length === 0) {
    log.info('⏳ Aguardando salvar primeira configuração no painel Deriv...');
    return;
  }

  for (const settings of allSettings) {
    if (!settings.isScanningEnabled) {
      log.info('⏸️ Scanner WebSocket desativado. Marque "Scanner WebSocket Ativo" no painel.');
      continue;
    }

    const activeToken = settings.accountType === 'real'
      ? (settings.realApiToken || settings.apiToken)
      : (settings.demoApiToken || settings.apiToken);

    if (!activeToken) {
      log.warn(`⚠️ Token de API não informado para o ambiente ${settings.accountType === 'real' ? 'REAL' : 'DEMO'}.`);
      continue;
    }

    const client = new DerivWsClient(
      settings.appId || '1089',
      activeToken,
      settings.accountType === 'real' ? 'real' : 'demo'
    );

  try {
    await client.connect();
    const accountInfo = await client.authorize().catch(() => null);

    if (!accountInfo) {
      log.warn('⚠️ Falha ao autorizar conta Deriv. Verifique o API Token.');
      client.close();
      return;
    }

    const isVirtual = Boolean(accountInfo.is_virtual);
    const loginId = accountInfo.loginid || 'Desconhecido';
    const envLabel = isVirtual ? 'DEMO (Virtual)' : 'PRODUÇÃO (Conta Real)';

    log.info(`💡 Conectado na Deriv [Ambiente: ${envLabel} | ID: ${loginId}]. Ciclo de varredura executado.`);

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
        const tradeAgeSec = trade.openedAt ? (Date.now() - new Date(trade.openedAt).getTime()) / 1000 : 0;

        // Evitar stop imediato por oscilação normal de spread nos primeiros 60 segundos
        const minHoldPeriodSec = Math.min(60, (settings.contractDurationSec || 300) * 0.25);

        // Take Profit Antecipado (ganho real considerável >= minTakeProfitPct, mínimo 25%)
        const targetTakeProfit = Math.max(Number(settings.minTakeProfitPct || 2.0), 25.0);
        if (profitPct >= targetTakeProfit) {
          log.info(`🎯 [${trade.symbol}] TAKE PROFIT ANTECIPADO: Lucro de +${profitPct.toFixed(2)}% ($${currentProfit.toFixed(2)}). Vendendo contrato...`);
          await client.sellContract(trade.contractId, 0).catch(() => {});
        }
        // Emergency Stop Out (só aciona após carência de maturação para evitar ruído de spread)
        else if (tradeAgeSec >= minHoldPeriodSec && profitPct <= -(Math.max(Number(settings.emergencyStopPct || 20.0), 50.0))) {
          log.warn(`🚨 [${trade.symbol}] EMERGENCY STOP OUT (${tradeAgeSec.toFixed(0)}s decorridos): Prejuízo de ${profitPct.toFixed(2)}%. Vendendo contrato...`);
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

    const symbols = settings.allowedSymbols && settings.allowedSymbols.length > 0
      ? settings.allowedSymbols
      : ['frxBTCUSD', 'frxETHUSD', 'R_100', 'R_50'];

    const minCertainty = Number(settings.minHighCertaintyProb || 0.80);

    for (const sym of symbols) {
      try {
        // Análise multi-timeframe: 60 velas de 1 minuto para contratos de 5m (300s)
        const candles = await client.getCandlesHistory(sym, 60, 60).catch(() => []);
        const prices = candles.length >= 30 
          ? candles.map((c: any) => c.close)
          : await client.getTicksHistory(sym, 60).catch(() => []);

        if (!prices || prices.length < 30) continue;

        const latestPrice = prices[prices.length - 1];

        // EMA 9 (Rápida) e EMA 21 (Lenta)
        const calcEma = (data: number[], period: number) => {
          const k = 2 / (period + 1);
          let ema = data[0];
          for (let i = 1; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
          }
          return ema;
        };

        const emaFast = calcEma(prices, 9);
        const emaSlow = calcEma(prices, 21);

        // RSI de 14 períodos
        let gains = 0;
        let losses = 0;
        const rsiPeriod = 14;
        const recentPrices = prices.slice(-(rsiPeriod + 1));
        for (let i = 1; i < recentPrices.length; i++) {
          const diff = recentPrices[i] - recentPrices[i - 1];
          if (diff > 0) gains += diff;
          else losses += Math.abs(diff);
        }
        const avgGain = gains / rsiPeriod;
        const avgLoss = losses / rsiPeriod || 0.00001;
        const rs = avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));

        // Consistência das últimas 5 velas/períodos
        const last5 = prices.slice(-5);
        let upBars = 0;
        let downBars = 0;
        for (let i = 1; i < last5.length; i++) {
          if (last5[i] > last5[i - 1]) upBars++;
          else if (last5[i] < last5[i - 1]) downBars++;
        }
        const barTrendUp = upBars / (last5.length - 1);
        const barTrendDown = downBars / (last5.length - 1);

        let decidedType: 'CALL' | 'PUT' | null = null;
        let calculatedProb = 0;

        // Condições de Alta Probabilidade (CALL)
        // 1. Tendência definida: Preço > EMA9 > EMA21
        // 2. Momentum saudável: RSI entre 52 e 68 (não sobrecomprado)
        // 3. Pelo menos 75% das barras recentes apontando para cima
        if (latestPrice > emaFast && emaFast > emaSlow && rsi >= 52 && rsi <= 68 && barTrendUp >= 0.75) {
          decidedType = 'CALL';
          const trendStrength = Math.min(((emaFast - emaSlow) / emaSlow) * 1000, 0.10);
          const rsiBonus = ((rsi - 50) / 100) * 0.10;
          calculatedProb = Number(Math.min(0.70 + (barTrendUp * 0.15) + trendStrength + rsiBonus, 0.96).toFixed(3));
        }
        // Condições de Alta Probabilidade (PUT)
        // 1. Tendência definida: Preço < EMA9 < EMA21
        // 2. Momentum saudável de baixa: RSI entre 32 e 48 (não sobrevendido)
        // 3. Pelo menos 75% das barras recentes apontando para baixo
        else if (latestPrice < emaFast && emaFast < emaSlow && rsi >= 32 && rsi <= 48 && barTrendDown >= 0.75) {
          decidedType = 'PUT';
          const trendStrength = Math.min(((emaSlow - emaFast) / emaSlow) * 1000, 0.10);
          const rsiBonus = ((50 - rsi) / 100) * 0.10;
          calculatedProb = Number(Math.min(0.70 + (barTrendDown * 0.15) + trendStrength + rsiBonus, 0.96).toFixed(3));
        }

        // Filtro de Probabilidade Mínima
        if (!decidedType || calculatedProb < minCertainty) {
          const probMsg = calculatedProb > 0 ? `${(calculatedProb * 100).toFixed(1)}%` : '0% (Sem alinhamento)';
          log.info(`🔍 [${sym}] Certeza calculada: ${probMsg} | Mínima exigida: ${(minCertainty * 100).toFixed(1)}% | RSI: ${rsi.toFixed(1)} | EMA Fast/Slow: ${emaFast.toFixed(2)}/${emaSlow.toFixed(2)}. Entrada descartada.`);
          continue;
        }

        // Cálculo da Barreira Protetora (Margem de Segurança)
        // Para HIGHER: Barreira negativa (ex: -0.3% a -0.5% abaixo do preço), garantindo alta probabilidade
        // Para LOWER: Barreira positiva (ex: +0.3% a +0.5% acima do preço), garantindo alta probabilidade
        const isForexOrCrypto = sym.startsWith('frx');
        const barrierOffsetPct = 0.003; // 0.3% de margem de proteção
        const barrierOffset = isForexOrCrypto 
          ? (latestPrice * barrierOffsetPct).toFixed(2)
          : (latestPrice * barrierOffsetPct).toFixed(1);

        let contractType = 'HIGHER';
        let barrierValue = `-${barrierOffset}`;

        if (decidedType === 'PUT') {
          contractType = 'LOWER';
          barrierValue = `+${barrierOffset}`;
        }

        // 3. Requisita proposta HIGHER / LOWER com barreira de margem
        let proposal = await client.getProposal({
          symbol: sym,
          contract_type: contractType,
          amount: settings.tradeSize || 5,
          duration: settings.contractDurationSec || 300,
          duration_unit: 's',
          barrier: barrierValue,
        }).catch(() => null);

        // Fallback para CALL / PUT caso o ativo não suporte barreira no momento
        if (!proposal || !proposal.id) {
          contractType = decidedType === 'CALL' ? 'CALL' : 'PUT';
          proposal = await client.getProposal({
            symbol: sym,
            contract_type: contractType,
            amount: settings.tradeSize || 5,
            duration: settings.contractDurationSec || 300,
            duration_unit: 's',
          }).catch(() => null);
        }

        if (proposal && proposal.id) {
          const bought = await client.buyContract(proposal.id, proposal.ask_price).catch(() => null);
          if (bought && bought.contract_id) {
            const displayType = contractType === 'HIGHER' ? 'HIGHER' : contractType === 'LOWER' ? 'LOWER' : decidedType === 'CALL' ? 'RISE' : 'FALL';
            const displayBarrier = proposal.barrier ? ` [Barreira: ${proposal.barrier}]` : '';

            await DerivTrade.create({
              userId: settings.userId,
              contractId: String(bought.contract_id),
              symbol: sym,
              question: `Opção ${sym} (${displayType}${displayBarrier} ${(calculatedProb * 100).toFixed(0)}% Certeza)`,
              contractType: displayType,
              status: 'open',
              buyPrice: Number(bought.buy_price || settings.tradeSize || 5),
              investedUsd: Number(bought.buy_price || settings.tradeSize || 5),
              reason: `Entrada Higher/Lower (${(calculatedProb * 100).toFixed(1)}% Certeza)`,
              openedAt: new Date(),
            });
            log.info(`🚀 [${sym}] Contrato de ALTA CERTEZA (${displayType}${displayBarrier} | ${(calculatedProb * 100).toFixed(1)}%) executado! ID: ${bought.contract_id}`);
            break; // Abre 1 contrato por ciclo para manter gerenciamento de risco
          }
        }
      } catch (errSym: any) {
        log.warn(`⚠️ [${sym}] Erro ao analisar ativo: ${errSym.message}`);
      }
    }
  } catch (e: any) {
    log.error(`❌ Erro no ciclo do robô Deriv: ${e.message}`);
  } finally {
    client.close();
  }
  }
}

