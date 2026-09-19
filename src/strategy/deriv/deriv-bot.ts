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
        // Em contratos de 15s, a operação expira rapidamente no vencimento natural
        const profitPct = buyPrice > 0 ? (currentProfit / buyPrice) * 100 : 0;
        const durationSec = Number(settings.contractDurationSec || 15);

        // Se o contrato for maior que 30s, permite TP/Stop antecipado; para 15s deixa expirar naturalmente
        if (durationSec > 30) {
          const tradeAgeSec = trade.openedAt ? (Date.now() - new Date(trade.openedAt).getTime()) / 1000 : 0;
          const minHoldPeriodSec = Math.min(30, durationSec * 0.25);

          if (profitPct >= Math.max(Number(settings.minTakeProfitPct || 10.0), 10.0)) {
            log.info(`🎯 [${trade.symbol}] TAKE PROFIT ANTECIPADO: Lucro de +${profitPct.toFixed(2)}% ($${currentProfit.toFixed(2)}). Vendendo contrato...`);
            await client.sellContract(trade.contractId, 0).catch(() => {});
          } else if (tradeAgeSec >= minHoldPeriodSec && profitPct <= -(Math.max(Number(settings.emergencyStopPct || 50.0), 50.0))) {
            log.warn(`🚨 [${trade.symbol}] EMERGENCY STOP OUT (${tradeAgeSec.toFixed(0)}s decorridos): Prejuízo de ${profitPct.toFixed(2)}%. Vendendo contrato...`);
            await client.sellContract(trade.contractId, 0).catch(() => {});
          }
        }
      } catch (e: any) {
        log.warn(`⚠️ Erro ao monitorar contrato ${trade.contractId}: ${e.message}`);
      }
    }

    // 2. Verificar se podemos abrir novas posições (Regra: Apenas 1 operação por vez)
    if (!settings.allowLiveTrading) {
      client.close();
      return;
    }

    const maxConcurrent = Math.min(Number(settings.maxOpenContracts || 1), 1);
    const openCount = await DerivTrade.countDocuments({ userId: settings.userId, status: 'open' });
    if (openCount >= maxConcurrent) {
      client.close();
      return;
    }

    const symbols = settings.allowedSymbols && settings.allowedSymbols.length > 0
      ? settings.allowedSymbols
      : ['1HZ10V', 'R_10', 'R_100', 'R_50', 'frxBTCUSD', 'frxETHUSD'];

    const minCertainty = Number(settings.minHighCertaintyProb || 0.75);

    for (const sym of symbols) {
      try {
        // Busca 50 ticks para análise rápida de momentum + indicadores em tempo real
        const ticks = await client.getTicksHistory(sym, 50).catch(() => []);
        if (!ticks || ticks.length < 30) continue;

        const latestPrice = ticks[ticks.length - 1];

        // 1. EMA 5 (Rápida) e EMA 13 (Média)
        const calcEma = (data: number[], period: number) => {
          const k = 2 / (period + 1);
          let ema = data[0];
          for (let i = 1; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
          }
          return ema;
        };

        const emaFast = calcEma(ticks, 5);
        const emaSlow = calcEma(ticks, 13);

        // 2. RSI de 10 períodos
        let gains = 0;
        let losses = 0;
        const rsiPeriod = 10;
        const recentPrices = ticks.slice(-(rsiPeriod + 1));
        for (let i = 1; i < recentPrices.length; i++) {
          const diff = recentPrices[i] - recentPrices[i - 1];
          if (diff > 0) gains += diff;
          else losses += Math.abs(diff);
        }
        const avgGain = gains / rsiPeriod;
        const avgLoss = losses / rsiPeriod || 0.00001;
        const rs = avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));

        // 3. Estocástico Rápido (14 períodos %K e %D)
        const stochPeriod = 14;
        const stochSlice = ticks.slice(-stochPeriod);
        const highestHigh = Math.max(...stochSlice);
        const lowestLow = Math.min(...stochSlice);
        const range = highestHigh - lowestLow || 0.0001;
        const stochK = ((latestPrice - lowestLow) / range) * 100;

        // 4. Momentum dos últimos 8 ticks
        const last8 = ticks.slice(-8);
        let upTicks = 0;
        let downTicks = 0;
        for (let i = 1; i < last8.length; i++) {
          if (last8[i] > last8[i - 1]) upTicks++;
          else if (last8[i] < last8[i - 1]) downTicks++;
        }
        const tickMomentumUp = upTicks / (last8.length - 1);
        const tickMomentumDown = downTicks / (last8.length - 1);

        let decidedType: 'CALL' | 'PUT' | null = null;
        let calculatedProb = 0;

        // Condições para MERCADO EM ALTA (Comprar HIGHER com barreira -1):
        // - Preço > EMA5 > EMA13
        // - RSI apontando pra cima (> 50 e < 75)
        // - Estocástico > 40 e apontando pra cima
        // - Micro-ticks com dominância compradora >= 60%
        if (latestPrice >= emaFast && emaFast > emaSlow && rsi >= 50 && rsi <= 75 && stochK >= 40 && tickMomentumUp >= 0.60) {
          decidedType = 'CALL';
          const rsiScore = (rsi - 50) / 100;
          const stochScore = (stochK - 40) / 200;
          calculatedProb = Number(Math.min(0.72 + (tickMomentumUp * 0.15) + rsiScore + stochScore, 0.98).toFixed(3));
        }
        // Condições para MERCADO EM BAIXA (Comprar LOWER com barreira +1):
        // - Preço < EMA5 < EMA13
        // - RSI apontando pra baixo (< 50 e > 25)
        // - Estocástico < 60 e apontando pra baixo
        // - Micro-ticks com dominância vendedora >= 60%
        else if (latestPrice <= emaFast && emaFast < emaSlow && rsi <= 50 && rsi >= 25 && stochK <= 60 && tickMomentumDown >= 0.60) {
          decidedType = 'PUT';
          const rsiScore = (50 - rsi) / 100;
          const stochScore = (60 - stochK) / 200;
          calculatedProb = Number(Math.min(0.72 + (tickMomentumDown * 0.15) + rsiScore + stochScore, 0.98).toFixed(3));
        }

        // Filtro de Probabilidade Mínima
        if (!decidedType || calculatedProb < minCertainty) {
          const probMsg = calculatedProb > 0 ? `${(calculatedProb * 100).toFixed(1)}%` : '0% (Sem confluência)';
          log.info(`🔍 [${sym}] Certeza: ${probMsg} (Min: ${(minCertainty * 100).toFixed(0)}%) | RSI: ${rsi.toFixed(1)} | Stoch: ${stochK.toFixed(1)}% | EMA F/S: ${emaFast.toFixed(2)}/${emaSlow.toFixed(2)} | Ticks: ↑${(tickMomentumUp * 100).toFixed(0)}% ↓${(tickMomentumDown * 100).toFixed(0)}%.`);
          continue;
        }

        // Barreira: -1 para HIGHER (Mercado em alta) / +1 para LOWER (Mercado em baixa)
        let contractType = 'HIGHER';
        let barrierValue = '-1';

        if (decidedType === 'PUT') {
          contractType = 'LOWER';
          barrierValue = '+1';
        }

        const tradeDuration = Number(settings.contractDurationSec || 15);
        const tradeStake = Number(settings.tradeSize || 2);

        // 3. Requisita proposta EXCLUSIVAMENTE Higher / Lower na Deriv (15s, Barreira ±1)
        const proposal = await client.getProposal({
          symbol: sym,
          contract_type: contractType,
          amount: tradeStake,
          duration: tradeDuration,
          duration_unit: 's',
          barrier: barrierValue,
        }).catch((err: any) => {
          log.warn(`⚠️ [${sym}] Erro ao cotar ${contractType} com barreira ${barrierValue}: ${err.message}`);
          return null;
        });

        if (!proposal || !proposal.id) {
          log.info(`⏳ [${sym}] Contrato ${contractType} com barreira ${barrierValue} indisponível no momento. Entrada ignorada.`);
          continue;
        }

        if (proposal && proposal.id) {
          const bought = await client.buyContract(proposal.id, proposal.ask_price).catch(() => null);
          if (bought && bought.contract_id) {
            const displayType = contractType;
            const displayBarrier = proposal.barrier ? ` [Barreira: ${proposal.barrier}]` : ` [Barreira: ${barrierValue}]`;

            await DerivTrade.create({
              userId: settings.userId,
              contractId: String(bought.contract_id),
              symbol: sym,
              question: `Opção ${sym} (${displayType}${displayBarrier} ${(calculatedProb * 100).toFixed(0)}% Certeza)`,
              contractType: displayType,
              status: 'open',
              buyPrice: Number(bought.buy_price || tradeStake),
              investedUsd: Number(bought.buy_price || tradeStake),
              reason: `Higher/Lower 15s (RSI: ${rsi.toFixed(0)} | Stoch: ${stochK.toFixed(0)}% | Certeza: ${(calculatedProb * 100).toFixed(0)}%)`,
              openedAt: new Date(),
            });
            log.info(`🚀 [${sym}] Operação ${displayType}${displayBarrier} executada com $${tradeStake} por ${tradeDuration}s! ID: ${bought.contract_id}`);
            break; // Apenas 1 operação por ciclo
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

