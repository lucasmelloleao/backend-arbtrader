import DerivSettings from '../../models/DerivSettings';
import DerivTrade from '../../models/DerivTrade';
import DerivStrategy from '../../models/DerivStrategy';
import { DerivWsClient } from './helpers/deriv-ws';

const inMemoryDerivLogs: string[] = [];
const MAX_BUFFER = 500;

export function addDerivLog(msg: string) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [DERIV-BOT] ${msg}`;
  inMemoryDerivLogs.push(entry);
  if (inMemoryDerivLogs.length > MAX_BUFFER) {
    inMemoryDerivLogs.shift();
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

// Pool de conexões WebSocket persistentes indexadas por (userId_accountType)
export const activeDerivClients = new Map<string, { client: DerivWsClient; token: string; accountInfo: any }>();

export async function getOrCreateDerivClient(settings: any, activeToken: string): Promise<{ client: DerivWsClient; accountInfo: any } | null> {

  const clientKey = `${settings.userId || 'default'}_${settings.accountType || 'demo'}`;
  const existing = activeDerivClients.get(clientKey);

  if (existing && existing.token === activeToken && existing.client.isConnected()) {
    return { client: existing.client, accountInfo: existing.accountInfo };
  }

  // Se já existia um client antigo/desconectado ou token trocado, fecha
  if (existing) {
    try {
      existing.client.close();
    } catch {}
    activeDerivClients.delete(clientKey);
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
      client.close();
      return null;
    }
    activeDerivClients.set(clientKey, { client, token: activeToken, accountInfo });
    const isVirtual = Boolean(accountInfo.is_virtual);
    const loginId = accountInfo.loginid || 'Desconhecido';
    const envLabel = isVirtual ? 'DEMO (Virtual)' : 'PRODUÇÃO (Conta Real)';
    log.info(`🔗 Conexão persistente estabelecida com sucesso [${envLabel} | ID: ${loginId}].`);

    // Salva saldo no banco de dados para o frontend consultar via REST puramente do MongoDB
    const balancePayload = {
      loginId: accountInfo.loginid || '',
      balance: Number(accountInfo.balance || 0),
      currency: accountInfo.currency || 'USD',
      updatedAt: new Date(),
    };
    const updateField = settings.accountType === 'real' ? { realBalance: balancePayload } : { demoBalance: balancePayload };
    DerivSettings.updateOne({ _id: settings._id }, { $set: updateField }).catch(() => {});

    return { client, accountInfo };
  } catch (err: any) {
    client.close();
    throw err;
  }
}


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

    let derivSession: { client: DerivWsClient; accountInfo: any } | null = null;
    try {
      derivSession = await getOrCreateDerivClient(settings, activeToken);
    } catch (err: any) {
      log.warn(`⚠️ Falha ao conectar persistentemente na Deriv: ${err?.message || err}`);
      continue;
    }

    if (!derivSession || !derivSession.client) {
      log.warn('⚠️ Falha ao autenticar na Deriv. Verifique o API Token.');
      continue;
    }

    const { client } = derivSession;

    try {
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

    // 2. Buscar estratégias ativas do usuário para operar por ativo
    const userStrategies = await DerivStrategy.find({ userId: settings.userId, active: true }).lean();

    // Se o usuário não tiver estratégias cadastradas, cria/usa lista padrão dos settings
    const activeTargets: Array<{
      symbol: string;
      name: string;
      contractType: string;
      barrier: string;
      barrierLower: string;
      tradeSize: number;
      durationSec: number;
      minCertaintyProb: number;
      strategyId?: any;
    }> = [];

    if (userStrategies && userStrategies.length > 0) {
      for (const st of userStrategies) {
        activeTargets.push({
          symbol: st.symbol,
          name: st.name || st.symbol,
          contractType: st.contractType || 'BOTH_HL',
          barrier: st.barrier || '-1',
          barrierLower: st.barrierLower || '+1',
          tradeSize: Number(st.tradeSize) || 2,
          durationSec: Number(st.durationSec) || 15,
          minCertaintyProb: Number(st.minCertaintyProb) || 0.75,
          strategyId: st._id,
        });
      }
    } else {
      const symbols = settings.allowedSymbols && settings.allowedSymbols.length > 0
        ? settings.allowedSymbols
        : ['1HZ10V', 'R_10', 'R_100', 'R_50', 'frxBTCUSD', 'frxETHUSD'];

      for (const sym of symbols) {
        activeTargets.push({
          symbol: sym,
          name: sym,
          contractType: 'BOTH_HL',
          barrier: '-1',
          barrierLower: '+1',
          tradeSize: Number(settings.tradeSize || 2),
          durationSec: Number(settings.contractDurationSec || 15),
          minCertaintyProb: Number(settings.minHighCertaintyProb || 0.75),
        });
      }
    }

    for (const target of activeTargets) {
      const sym = target.symbol;
      try {
        // Busca 50 ticks para análise rápida de momentum + indicadores em tempo real
        const ticks = await client.getTicksHistory(sym, 50).catch((err: any) => {
          log.warn(`⚠️ [${sym}] Falha ao buscar histórico de cotações: ${err?.message || err}`);
          return [];
        });

        if (!ticks || ticks.length < 30) {
          log.info(`⏳ [${sym} (${target.name})] Histórico insuficiente de ticks (${ticks?.length || 0}/30) na Deriv. Aguardando novo fluxo de cotação...`);
          continue;
        }

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

        let decidedDirection: 'CALL' | 'PUT' | null = null;
        let calculatedProb = 0;

        // Condições para MERCADO EM ALTA (Tendência forte + Confirmação Estocástica & RSI sem sobrecompra extrema)
        if (latestPrice > emaFast && emaFast > emaSlow && rsi >= 55 && rsi <= 80 && stochK >= 50 && tickMomentumUp >= 0.65) {
          decidedDirection = 'CALL';
          const rsiScore = (rsi - 50) / 100;
          const stochScore = (stochK - 40) / 200;
          calculatedProb = Number(Math.min(0.75 + (tickMomentumUp * 0.15) + rsiScore + stochScore, 0.99).toFixed(3));
        }
        // Condições para MERCADO EM BAIXA (Tendência forte + Confirmação Estocástica & RSI sem sobrevenda extrema)
        else if (latestPrice < emaFast && emaFast < emaSlow && rsi <= 45 && rsi >= 20 && stochK <= 50 && tickMomentumDown >= 0.65) {
          decidedDirection = 'PUT';
          const rsiScore = (50 - rsi) / 100;
          const stochScore = (60 - stochK) / 200;
          calculatedProb = Number(Math.min(0.75 + (tickMomentumDown * 0.15) + rsiScore + stochScore, 0.99).toFixed(3));
        }


        // Filtro de Probabilidade Mínima da Estratégia
        if (!decidedDirection || calculatedProb < target.minCertaintyProb) {
          const probMsg = calculatedProb > 0 ? `${(calculatedProb * 100).toFixed(1)}%` : '0% (Sem confluência)';
          log.info(`🔍 [${sym} (${target.name})] Certeza: ${probMsg} (Min: ${(target.minCertaintyProb * 100).toFixed(0)}%) | RSI: ${rsi.toFixed(1)} | Stoch: ${stochK.toFixed(1)}% | Ticks: ↑${(tickMomentumUp * 100).toFixed(0)}% ↓${(tickMomentumDown * 100).toFixed(0)}%.`);
          continue;
        }

        log.info(`🎯 [${sym} (${target.name})] CONFLUÊNCIA APROVADA: Direção ${decidedDirection} com ${(calculatedProb * 100).toFixed(1)}% de Certeza (Mínimo exigido: ${(target.minCertaintyProb * 100).toFixed(0)}%). Iniciando cotação...`);

        // Determina o tipo de contrato e a barreira a partir das configurações específicas da estratégia
        let contractType = 'HIGHER';
        let rawBarrier: string | undefined = target.barrier;

        if (target.contractType === 'HIGHER') {
          if (decidedDirection !== 'CALL') continue;
          contractType = 'HIGHER';
          rawBarrier = target.barrier;
        } else if (target.contractType === 'LOWER') {
          if (decidedDirection !== 'PUT') continue;
          contractType = 'LOWER';
          rawBarrier = target.barrierLower || target.barrier;
        } else if (target.contractType === 'RISE') {
          if (decidedDirection !== 'CALL') continue;
          contractType = 'CALL';
          rawBarrier = undefined;
        } else if (target.contractType === 'FALL') {
          if (decidedDirection !== 'PUT') continue;
          contractType = 'PUT';
          rawBarrier = undefined;
        } else if (target.contractType === 'BOTH_RF') {
          contractType = decidedDirection === 'CALL' ? 'CALL' : 'PUT';
          rawBarrier = undefined;
        } else {
          // BOTH_HL (Higher/Lower automático)
          if (decidedDirection === 'CALL') {
            contractType = 'HIGHER';
            rawBarrier = target.barrier;
          } else {
            contractType = 'LOWER';
            rawBarrier = target.barrierLower || (target.barrier?.startsWith('-') ? `+${target.barrier.slice(1)}` : target.barrier);
          }
        }

        // Normalização e sanitização da barreira para evitar erro na Deriv (ex: troca vírgula por ponto)
        let barrierValue = rawBarrier ? String(rawBarrier).trim().replace(',', '.') : undefined;

        const tradeStake = target.tradeSize;
        let tradeDuration = target.durationSec;
        let durationUnit = 's';

        // Validação dinâmica de limites de duração por contrato na Deriv
        if ((contractType === 'HIGHER' || contractType === 'LOWER') && tradeDuration < 15) {
          tradeDuration = 15;
        }

        // Requisita proposta para a Deriv
        let proposalParams: any = {
          symbol: sym,
          contract_type: contractType,
          amount: tradeStake,
          duration: tradeDuration,
          duration_unit: durationUnit,
        };
        if (barrierValue) {
          proposalParams.barrier = barrierValue;
        }

        let proposal = await client.getProposal(proposalParams).catch((err: any) => {
          return { error: err.message };
        });

        // Se a Deriv rejeitar a unidade em segundos ou a duração exata, tenta ajustar dinamicamente
        if (proposal?.error && proposal.error.includes('duration')) {
          if (tradeDuration < 60) {
            proposalParams.duration = 60;
            proposalParams.duration_unit = 's';
            proposal = await client.getProposal(proposalParams).catch((err: any) => {
              log.warn(`⚠️ [${sym}] Erro ao cotar ${contractType}${barrierValue ? ` [${barrierValue}]` : ''} (ajustado para 60s): ${err.message}`);
              return null;
            });
          } else if (tradeDuration >= 60 && durationUnit === 's') {
            proposalParams.duration = Math.round(tradeDuration / 60);
            proposalParams.duration_unit = 'm';
            proposal = await client.getProposal(proposalParams).catch((err: any) => {
              log.warn(`⚠️ [${sym}] Erro ao cotar ${contractType}${barrierValue ? ` [${barrierValue}]` : ''} (em minutos): ${err.message}`);
              return null;
            });
          }
        } 
        // Fallback dinâmico para erro de barreira (ajusta offset mais conservador se rejeitado pela API)
        else if (proposal?.error && (proposal.error.includes('barrier') || proposal.error.includes('Input validation failed'))) {
          const numBarrier = Number(barrierValue);
          if (!isNaN(numBarrier)) {
            const adjustedBarrier = numBarrier < 0 ? Math.min(numBarrier / 2, -1.0) : Math.max(numBarrier / 2, 1.0);
            barrierValue = adjustedBarrier > 0 ? `+${adjustedBarrier.toFixed(2)}` : `${adjustedBarrier.toFixed(2)}`;
            proposalParams.barrier = barrierValue;
            log.info(`🔄 [${sym}] Reajustando barreira para offset dinâmico ${barrierValue}...`);
            proposal = await client.getProposal(proposalParams).catch((err: any) => {
              log.warn(`⚠️ [${sym}] Falha no retry da barreira ${barrierValue}: ${err.message}`);
              return null;
            });
          }
        } else if (proposal?.error) {
          log.warn(`⚠️ [${sym}] Erro ao cotar ${contractType}${barrierValue ? ` [${barrierValue}]` : ''}: ${proposal.error}`);
          proposal = null;
        }

        if (!proposal || !proposal.id) {
          log.info(`⏳ [${sym}] Contrato ${contractType}${barrierValue ? ` [${barrierValue}]` : ''} indisponível para esta duração (${tradeDuration}${durationUnit}). Entrada ignorada.`);
          continue;
        }

        // Filtro de Payout Mínimo: evita aceitar contratos com retorno assimétrico/centavos
        const payout = Number(proposal.payout || 0);
        const askPrice = Number(proposal.ask_price || tradeStake);
        const netProfitPct = askPrice > 0 ? ((payout - askPrice) / askPrice) * 100 : 0;

        if (netProfitPct < 35) {
          log.warn(`⚠️ [${sym}] Payout líquido insuficiente (+${netProfitPct.toFixed(1)}% | Lucro: $${(payout - askPrice).toFixed(2)} sobre $${askPrice.toFixed(2)}). Entrada ignorada.`);
          continue;
        }

        if (proposal && proposal.id) {
          const bought = await client.buyContract(proposal.id, proposal.ask_price).catch(() => null);
          if (bought && bought.contract_id) {
            const displayType = contractType;
            const displayBarrier = proposal.barrier ? ` [Barreira: ${proposal.barrier}]` : (barrierValue ? ` [Barreira: ${barrierValue}]` : '');

            await DerivTrade.create({
              userId: settings.userId,
              contractId: String(bought.contract_id),
              symbol: sym,
              strategyName: target.name || sym,
              question: `Opção ${sym} (${displayType}${displayBarrier} ${(calculatedProb * 100).toFixed(0)}% Certeza)`,
              contractType: displayType,
              status: 'open',
              buyPrice: Number(bought.buy_price || tradeStake),
              investedUsd: Number(bought.buy_price || tradeStake),
              reason: `Estratégia "${target.name}" (${(calculatedProb * 100).toFixed(0)}% Certeza | RSI: ${rsi.toFixed(0)} | Stoch: ${stochK.toFixed(0)}%)`,
              openedAt: new Date(),
            });

            if (target.strategyId) {
              await DerivStrategy.findByIdAndUpdate(target.strategyId, {
                lastTradeAt: new Date(),
                contractId: String(bought.contract_id),
                positionOpen: true,
                buyPrice: Number(bought.buy_price || tradeStake),
              });
            }

            log.info(`🚀 [${sym}] Estratégia "${target.name}" (${displayType}${displayBarrier}) executada com $${tradeStake} por ${tradeDuration}s! ID: ${bought.contract_id}`);
            break; // Abre 1 contrato por ciclo para gerenciamento de risco
          }
        }
      } catch (errSym: any) {
        log.warn(`⚠️ [${sym}] Erro ao analisar ativo: ${errSym.message}`);
      }
    }
  } catch (e: any) {
    log.error(`❌ Erro no ciclo do robô Deriv: ${e.message}`);
  }
  }
}


