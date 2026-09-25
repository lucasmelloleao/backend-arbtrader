import DerivSettings from '../../models/DerivSettings';
import DerivTrade from '../../models/DerivTrade';
import DerivStrategy from '../../models/DerivStrategy';
import { DerivWsClient } from './helpers/deriv-ws';
import { evaluateSignal, streakStakeMultiplier } from './helpers/deriv-signal';
import { DerivBarrierOptimizer } from './helpers/deriv-barrier';
import { DerivMetaLabeler } from './helpers/deriv-meta-labeler';

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

// Rastreamento de Slippage e Adaptação de Latência
let consecutiveSlippageWarnings = 0;
let dynamicMinEdgeBonus = 0;

// Quarentena Preventiva CUSUM por ativo (5 minutos = 300s)
const cusumQuarantineMap = new Map<string, number>();

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


let derivCycleRunning = false;

export async function runDerivCycle(): Promise<void> {
  if (derivCycleRunning) return;
  derivCycleRunning = true;
  try {
    await executeDerivCycle();
  } catch (err: any) {
    log.error(`❌ Erro no ciclo do robô Deriv: ${err.message}`);
  } finally {
    derivCycleRunning = false;
  }
}

async function executeDerivCycle(): Promise<void> {
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
        if (!contractInfo) {
          const ageSec = trade.openedAt ? (Date.now() - new Date(trade.openedAt).getTime()) / 1000 : 0;
          const staleAfterSec = Number(settings.contractDurationSec || 15) * 3 + 30;
          if (ageSec > staleAfterSec) {
            await DerivTrade.updateOne({ _id: trade._id }, { status: 'executed', reason: 'Expiração não resolvida (stale)', closedAt: new Date() });
            log.warn(`🧹 [${trade.symbol}] Trade ${trade.contractId} preso em 'open' por ${ageSec.toFixed(0)}s. Marcado como encerrado para liberar novas entradas.`);
          }
          continue;
        }

        const isSold = Boolean(contractInfo.is_sold);
        const currentProfit = Number(contractInfo.profit || 0);
        const buyPrice = Number(trade.buyPrice || trade.investedUsd || 0);
        const currentPayout = Number(contractInfo.bid_price || 0);

        // A. Se o contrato já foi encerrado/expirou na Deriv
        if (isSold || contractInfo.is_expired) {
          const finalProfit = Number(contractInfo.profit || 0);
          const sellPrice = Number(contractInfo.sell_price || currentPayout || 0);
          
          // Preserva motivo de saída antecipada se já tiver sido sinalizado, senão registra vencimento
          let closeReason = trade.reason || '';
          if (!closeReason || closeReason.includes('Estratégia')) {
            closeReason = finalProfit >= 0 ? 'Vencimento (Lucro)' : 'Vencimento (Perda)';
          }

          await DerivTrade.updateOne(
            { _id: trade._id },
            {
              status: 'executed',
              sellPrice: sellPrice,
              realizedUsd: buyPrice + finalProfit,
              pnl: finalProfit,
              reason: closeReason,
              closedAt: new Date(),
            }
          );
          log.info(`✅ [${trade.symbol}] Contrato ${trade.contractId} finalizado. Motivo: ${closeReason}. PnL: $${finalProfit.toFixed(2)}`);
          continue;
        }

        // B. Saída Antecipada / Gestão de Posição
        // Para contratos curtos (<= 30s), a revenda antecipada é desativada devido ao spread negativo do WebSocket
        const isShortBinary = (trade.durationSec && trade.durationSec <= 30) || (!trade.contractType?.includes('MULT') && !trade.symbol?.startsWith('cry'));
        const isValidToSell = Boolean(contractInfo.is_valid_to_sell) && !isShortBinary;
        const profitPct = buyPrice > 0 ? (currentProfit / buyPrice) * 100 : 0;
        
        // Busca estratégia individual do ativo para aplicar seus parâmetros específicos
        const assetStrategy = await DerivStrategy.findOne({ userId: settings.userId, symbol: trade.symbol }).lean();
        const minTakeProfit = Number(assetStrategy?.minTakeProfitPct ?? settings.minTakeProfitPct ?? 25.0);
        const emergencyStop = Number(assetStrategy?.emergencyStopPct ?? settings.emergencyStopPct ?? 70.0);
        const tradeAgeSec = trade.openedAt ? (Date.now() - new Date(trade.openedAt).getTime()) / 1000 : 0;

        if (isValidToSell) {
          // 1. Take Profit Dinâmico / Breakeven (Aplicado principalmente em Multiplicadores/Cripto após +25%)
          if (profitPct >= Math.max(25, minTakeProfit) && currentProfit > 0) {
            const tpReason = `Saída Antecipada (Take Profit: +${profitPct.toFixed(1)}%)`;
            log.info(`🎯 [${trade.symbol}] ${tpReason} ($${currentProfit.toFixed(2)} sobre $${buyPrice.toFixed(2)} | Meta: +${minTakeProfit}%). Vendendo posição com lucro protegido...`);
            await DerivTrade.updateOne({ _id: trade._id }, { reason: tpReason }).catch(() => {});
            await client.sellContract(trade.contractId, 0).catch((err: any) => {
              log.warn(`⚠️ [${trade.symbol}] Falha ao vender contrato antecipadamente: ${err.message}`);
            });
          } 
          // 2. Stop Loss de Emergência (após pelo menos 10s em posições longas)
          else if (tradeAgeSec >= 10 && profitPct <= -emergencyStop) {
            const stopReason = `Saída Antecipada (Emergency Stop: ${profitPct.toFixed(1)}%)`;
            log.warn(`🚨 [${trade.symbol}] ${stopReason} (${tradeAgeSec.toFixed(0)}s decorridos | Trava: -${emergencyStop}%). Encerrando posição...`);
            await DerivTrade.updateOne({ _id: trade._id }, { reason: stopReason }).catch(() => {});
            await client.sellContract(trade.contractId, 0).catch((err: any) => {
              log.warn(`⚠️ [${trade.symbol}] Falha no emergency stop: ${err.message}`);
            });
          }
        }
      } catch (e: any) {
        log.warn(`⚠️ Erro ao monitorar contrato ${trade.contractId}: ${e.message}`);
      }
    }

    // 2. Verificar se podemos abrir novas posições (Regra: Apenas 1 operação por vez)
    if (!settings.allowLiveTrading) {
      return;
    }

    const maxConcurrent = Math.max(1, Number(settings.maxOpenContracts || 1));
    const openCount = await DerivTrade.countDocuments({ userId: settings.userId, status: 'open' });
    if (openCount >= maxConcurrent) {
      return;
    }

    // 3. Stop diário de perda (maxDailyLoss) — interrompe novas entradas no dia
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayExecuted = await DerivTrade.find({ userId: settings.userId, status: 'executed', closedAt: { $gte: startOfToday } }).select('pnl').lean();
    const todayPnl = todayExecuted.reduce((acc: number, t: any) => acc + Number(t.pnl || 0), 0);
    const maxDailyLoss = Number(settings.maxDailyLoss ?? 20);
    if (todayPnl <= -maxDailyLoss) {
      log.warn(`🛑 [STOP DIÁRIO] Perda do dia ($${todayPnl.toFixed(2)}) atingiu o limite de -$${maxDailyLoss.toFixed(2)}. Nenhuma nova entrada até o próximo dia.`);
      return;
    }

    // 4. Gestão de risco por sequência (anti-martingale): reduz stake ou pausa temporariamente por 10 min
    const recentExecuted = await DerivTrade.find({ userId: settings.userId, status: 'executed' }).sort({ closedAt: -1 }).limit(10).lean();
    let consecutiveLosses = 0;
    let lastLossDate: Date | null = null;
    for (const t of recentExecuted) {
      if (Number(t.pnl || 0) < 0) {
        consecutiveLosses++;
        if (!lastLossDate && t.closedAt) lastLossDate = new Date(t.closedAt);
      } else {
        break;
      }
    }
    const streak = streakStakeMultiplier(consecutiveLosses);
    if (streak.blocked) {
      const cooldownSec = 180; // 180 segundos (3 minutos) de pausa após 3 perdas consecutivas
      const elapsedSec = lastLossDate ? (Date.now() - lastLossDate.getTime()) / 1000 : Infinity;
      if (elapsedSec < cooldownSec) {
        const remainingSec = Math.ceil(cooldownSec - elapsedSec);
        log.warn(`🛑 [RISCO] ${consecutiveLosses} perdas consecutivas. Em pausa de proteção (${remainingSec}s restantes).`);
        return;
      }
      log.info(`🔄 [RISCO] Pausa de proteção concluída. Retomando operações com stake reduzido (25%).`);
    }
    if (consecutiveLosses === 2) {
      log.info(`📉 [RISCO] Sequência de 2 perdas. Stake reduzido para 50%.`);
    }

    // 4.1 Dynamic Asset Allocator (Proteção de Curva e Regime de Ativos)
    try {
      const { evaluateAndAllocateDerivAssets } = await import('../common/dynamic-asset-allocator');
      const regimes = await evaluateAndAllocateDerivAssets(String(settings.userId));
      const paused = regimes.filter((r) => r.shouldPause);
      if (paused.length > 0) {
        log.warn(`🛡️ [DYNAMIC-ALLOCATOR] Circuit breaker acionado para ativos em declínio: ${paused.map((p) => `${p.symbol} (${p.reason})`).join(', ')}`);
      }
    } catch {}

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
      minTakeProfitPct?: number;
      emergencyStopPct?: number;
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
          minCertaintyProb: Number(st.minCertaintyProb) || 0.72,
          minTakeProfitPct: st.minTakeProfitPct !== undefined ? Number(st.minTakeProfitPct) : undefined,
          emergencyStopPct: st.emergencyStopPct !== undefined ? Number(st.emergencyStopPct) : undefined,
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
          minCertaintyProb: Number(settings.minHighCertaintyProb || 0.72),
        });
      }
    }

    // --- ASSET ROTATION & GATHERING CANDIDATES ---
    // Analisa todos os ativos candidatos em paralelo, calcula Regime Score e ordena pelo melhor ambiente
    const evaluatedCandidates: Array<{
      target: any;
      ticks: number[];
      signal: any;
      regimeScore: number;
    }> = [];

    for (const target of activeTargets) {
      const sym = target.symbol;
      try {
        // 1. Quarentena Preventiva CUSUM (5 minutos = 300s)
        const cusumQuarantineUntil = cusumQuarantineMap.get(sym) || 0;
        if (Date.now() < cusumQuarantineUntil) {
          const remainingSec = Math.ceil((cusumQuarantineUntil - Date.now()) / 1000);
          log.info(`🛡️ [${sym} (${target.name})] Em Quarentena Preventiva CUSUM (${remainingSec}s restantes).`);
          continue;
        }

        // 2. Veto Dinâmico por Regime (Kill-Switch por Ativo):
        // 2.1 - Trava de 3 Losses Consecutivos no Ativo (Pausa de 30 min)
        const recentTradesAsset = await DerivTrade.find({
          userId: settings.userId,
          symbol: sym,
          status: 'executed',
        }).sort({ closedAt: -1 }).limit(10).lean();

        let consecutiveLosses = 0;
        for (const t of recentTradesAsset) {
          if ((t.pnl || 0) < 0) {
            consecutiveLosses++;
          } else {
            break;
          }
        }

        if (consecutiveLosses >= 3) {
          const lastLossTime = recentTradesAsset[0]?.closedAt ? new Date(recentTradesAsset[0].closedAt).getTime() : 0;
          const pauseMs = 30 * 60 * 1000; // 30 minutos de pausa
          if (Date.now() - lastLossTime < pauseMs) {
            const minRest = Math.ceil((pauseMs - (Date.now() - lastLossTime)) / 60000);
            log.warn(`🛑 [KILL-SWITCH ATIVO: ${sym}] 3 losses consecutivos detectados. Ativo suspenso por mais ${minRest}m.`);
            continue;
          }
        }

        // 2.2 - Trava de Win Rate < 55% nas últimas 2 horas (mínimo 5 trades)
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const tradesLast2h = await DerivTrade.find({
          userId: settings.userId,
          symbol: sym,
          status: 'executed',
          closedAt: { $gte: twoHoursAgo },
        }).select('pnl').lean();

        if (tradesLast2h.length >= 5) {
          const wins2h = tradesLast2h.filter((t: any) => (t.pnl || 0) > 0).length;
          const wr2h = (wins2h / tradesLast2h.length) * 100;
          if (wr2h < 55.0) {
            log.warn(`🛑 [KILL-SWITCH ATIVO: ${sym}] Win Rate de ${wr2h.toFixed(1)}% nas últimas 2h (< 55% em ${tradesLast2h.length} trades). Ativo vetado temporariamente.`);
            continue;
          }
        }

        // 2.3 - Cooldown Pós-Loss individual (180s)
        const lastLossTrade = recentTradesAsset[0];
        if (lastLossTrade && (lastLossTrade.pnl || 0) < 0 && lastLossTrade.closedAt) {
          const secondsSinceLoss = (Date.now() - new Date(lastLossTrade.closedAt).getTime()) / 1000;
          if (secondsSinceLoss < 180) {
            log.info(`⏸️ [${sym} (${target.name})] Em cooldown pós-loss (${Math.round(180 - secondsSinceLoss)}s restantes).`);
            continue;
          }
        }

        // Busca 60 ticks para cálculo de regime e sinal
        const ticks = await client.getTicksHistory(sym, 60).catch((err: any) => {
          log.warn(`⚠️ [${sym}] Falha ao buscar histórico de cotações: ${err?.message || err}`);
          return [];
        });

        if (!ticks || ticks.length < 40) {
          log.info(`⏳ [${sym} (${target.name})] Histórico insuficiente de ticks (${ticks?.length || 0}/40).`);
          continue;
        }

        const signal = evaluateSignal(ticks);
        const { indicators } = signal;

        // Verifica se o filtro CUSUM detectou quebra estrutural
        if (indicators.cusumExceeded) {
          cusumQuarantineMap.set(sym, Date.now() + 60000); // 60 segundos de quarentena
          log.warn(`🚨 [${sym}] Alerta CUSUM de Choque Estrutural! Ativo em quarentena preventiva de 60 segundos.`);
          continue;
        }

        // Verifica Teste de Razão de Variância (Lo-MacKinlay)
        if (indicators.varianceRatio < 1.08) {
          log.info(`🎲 [${sym}] Random Walk Detectado (VR: ${indicators.varianceRatio} < 1.08). Ativo ignorado no momento.`);
          continue;
        }

        evaluatedCandidates.push({
          target,
          ticks,
          signal,
          regimeScore: indicators.regimeScore || 0,
        });
      } catch (errEval: any) {
        log.warn(`⚠️ [${sym}] Erro ao pré-avaliar ativo: ${errEval.message}`);
      }
    }

    // Ordena os ativos pelo Ranking de Qualidade (Regime Score: maior ER + R²)
    evaluatedCandidates.sort((a, b) => b.regimeScore - a.regimeScore);

    if (evaluatedCandidates.length > 0) {
      const topAsset = evaluatedCandidates[0];
      log.info(`🏆 [ASSET ROTATION] Ativo de Maior Qualidade: ${topAsset.target.symbol} (Regime Score: ${topAsset.regimeScore} | Candidatos: ${evaluatedCandidates.length}).`);
    }

    for (const candidate of evaluatedCandidates) {
      const { target, ticks, signal } = candidate;
      const sym = target.symbol;
      try {
        const { direction: decidedDirection, confidence: calculatedProb, indicators } = signal;
        const { er, r2, slope, imbalance, varianceRatio } = indicators;

        // Filtro de Probabilidade Mínima da Estratégia
        if (!decidedDirection || calculatedProb < target.minCertaintyProb) {
          const probMsg = calculatedProb > 0 ? `${(calculatedProb * 100).toFixed(1)}%` : '0% (Ruído/Chop)';
          log.info(`🔍 [${sym} (${target.name})] Confiança: ${probMsg} (Min: ${(target.minCertaintyProb * 100).toFixed(0)}%) | ER: ${er.toFixed(2)} | R²: ${r2.toFixed(2)} | VR: ${varianceRatio} | Imbalance: ${(imbalance * 100).toFixed(0)}%.`);
          continue;
        }

        log.info(`🎯 [${sym} (${target.name})] GATES QUANTITATIVOS APROVADOS: Direção ${decidedDirection} com ${(calculatedProb * 100).toFixed(1)}% de Confiança (Mín: ${(target.minCertaintyProb * 100).toFixed(0)}% | ER: ${er.toFixed(2)} | R²: ${r2.toFixed(2)} | VR: ${varianceRatio} | Imb: ${(imbalance * 100).toFixed(0)}%).`);

        // Determina o tipo de contrato e a barreira a partir das configurações específicas da estratégia
        let contractType = 'HIGHER';
        let rawBarrier: string | undefined = target.barrier;

        // Determina a barreira dinâmica pelo otimizador de volatilidade (se não for Multiplier)
        const tickVol = DerivBarrierOptimizer.calculateTickVolatility(ticks);
        // Para 1HZ75V, usa offsetFactor mais agressivo (0.15 sigmas em vez de 0.30) para aproximar a barreira e gerar payout de 75-80%
        const offsetFactor = sym === '1HZ75V' ? 0.15 : 0.30;
        const dynamicBarrierOffset = DerivBarrierOptimizer.getTargetOffset(decidedDirection, tickVol, offsetFactor);

        if (target.contractType === 'HIGHER') {
          if (decidedDirection !== 'CALL') continue;
          contractType = 'HIGHER';
          rawBarrier = target.barrier && target.barrier !== '-1' ? target.barrier : dynamicBarrierOffset;
        } else if (target.contractType === 'LOWER') {
          if (decidedDirection !== 'PUT') continue;
          contractType = 'LOWER';
          rawBarrier = target.barrierLower && target.barrierLower !== '+1' ? target.barrierLower : dynamicBarrierOffset;
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
        } else if (target.contractType === 'MULTUP') {
          if (decidedDirection !== 'CALL') continue;
          contractType = 'MULTUP';
          rawBarrier = undefined;
        } else if (target.contractType === 'MULTDOWN') {
          if (decidedDirection !== 'PUT') continue;
          contractType = 'MULTDOWN';
          rawBarrier = undefined;
        } else if (target.contractType === 'BOTH_MULT' || sym.startsWith('cry')) {
          contractType = decidedDirection === 'CALL' ? 'MULTUP' : 'MULTDOWN';
          rawBarrier = undefined;
        } else {
          // BOTH_HL (Higher/Lower com Barreira Otimizada Dinamicamente)
          if (decidedDirection === 'CALL') {
            contractType = 'HIGHER';
            rawBarrier = target.barrier && target.barrier !== '-1' ? target.barrier : dynamicBarrierOffset;
          } else {
            contractType = 'LOWER';
            rawBarrier = target.barrierLower && target.barrierLower !== '+1' ? target.barrierLower : dynamicBarrierOffset;
          }
        }

        const isMultiplier = contractType === 'MULTUP' || contractType === 'MULTDOWN';

        // Normalização e sanitização da barreira
        let barrierValue = rawBarrier ? String(rawBarrier).trim().replace(',', '.') : undefined;

        const activeMultiplier = streak.multiplier > 0 ? streak.multiplier : 0.25;
        let tradeStake = Math.max(1, Math.round(target.tradeSize * activeMultiplier * 100) / 100);
        let tradeDuration = target.durationSec;
        let durationUnit = 's';

        // Validação dinâmica de limites de duração por contrato na Deriv
        const isForex = sym.startsWith('frx');
        if (!isMultiplier && (contractType === 'HIGHER' || contractType === 'LOWER')) {
          if (isForex && tradeDuration < 300) {
            tradeDuration = 5;
            durationUnit = 'm'; // Pares forex na Deriv exigem duração mínima em minutos (5m) para Higher/Lower
          } else if (tradeDuration < 15) {
            tradeDuration = 15;
          }
        }

        // Requisita proposta para a Deriv
        let proposalParams: any = {
          symbol: sym,
          contract_type: contractType,
          amount: tradeStake,
        };

        if (isMultiplier) {
          proposalParams.multiplier = 100;
          const minTp = Number(target.minTakeProfitPct ?? settings.minTakeProfitPct ?? 15.0);
          const stopLoss = Number(target.emergencyStopPct ?? settings.emergencyStopPct ?? 70.0);
          proposalParams.take_profit = Math.max(0.1, Math.round((tradeStake * (minTp / 100)) * 100) / 100);
          proposalParams.stop_loss = Math.max(0.35, Math.round((tradeStake * (stopLoss / 100)) * 100) / 100);
        } else {
          proposalParams.duration = tradeDuration;
          proposalParams.duration_unit = durationUnit;
          if (barrierValue) {
            proposalParams.barrier = barrierValue;
          }
        }

        let proposal = await client.getProposal(proposalParams).catch((err: any) => {
          return { error: err.message };
        });

        // Se a Deriv rejeitar a duração, tenta negociar durações superiores suportadas (60s -> 5m -> 15m)
        if (!isMultiplier && proposal?.error && (proposal.error.includes('duration') || proposal.error.includes('Trading is not offered'))) {
          const durationFallbacks = isForex 
            ? [{ d: 5, u: 'm' }, { d: 15, u: 'm' }, { d: 1, u: 'h' }]
            : [{ d: 60, u: 's' }, { d: 2, u: 'm' }, { d: 5, u: 'm' }];

          for (const fb of durationFallbacks) {
            if (proposalParams.duration === fb.d && proposalParams.duration_unit === fb.u) continue;
            proposalParams.duration = fb.d;
            proposalParams.duration_unit = fb.u;
            proposal = await client.getProposal(proposalParams).catch((err: any) => ({ error: err.message }));
            if (proposal && !proposal.error && proposal.id) {
              tradeDuration = fb.d;
              durationUnit = fb.u;
              log.info(`🔄 [${sym}] Duração ajustada com sucesso para ${fb.d}${fb.u}.`);
              break;
            }
          }
        } 
        
        // Fallback dinâmico para erro de barreira (ajusta offset mais conservador se rejeitado pela API)
        if (!isMultiplier && proposal?.error && (proposal.error.includes('barrier') || proposal.error.includes('Input validation failed'))) {
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
          log.info(`⏳ [${sym}] Contrato ${contractType}${barrierValue ? ` [${barrierValue}]` : ''} indisponível. Entrada ignorada.`);
          continue;
        }

        // Validação Quantitativa de EV e Edge com Otimizador de Barreira (para opções digitais)
        let evCheckResult: any = null;
        if (!isMultiplier) {
          const payout = Number(proposal.payout || 0);
          const askPrice = Number(proposal.ask_price || tradeStake);
          const currentMinEdge = 0.04 + dynamicMinEdgeBonus;
          
          const minPayoutRatioRequired = sym === '1HZ75V' ? 0.75 : 0.40;
          const evCheck = DerivBarrierOptimizer.evaluateProposal(
            askPrice,
            payout,
            calculatedProb,
            tradeStake,
            currentMinEdge,
            minPayoutRatioRequired
          );
          evCheckResult = evCheck;

          if (!evCheck.isValid) {
            log.warn(`⚠️ [${sym}] Proposta com EV Negativo, Edge Insuficiente ou Payout Abaixo do Mínimo (${(minPayoutRatioRequired * 100).toFixed(0)}%) (EV: ${evCheck.expectedValue} | Edge: +${(evCheck.edge * 100).toFixed(1)}% | MinEdge: +${(currentMinEdge * 100).toFixed(1)}% | Retorno R: +${(evCheck.payoutRatio * 100).toFixed(1)}% | Prob Deriv: ${(evCheck.brokerProb * 100).toFixed(1)}% vs Modelo: ${(calculatedProb * 100).toFixed(1)}%). Entrada rejeitada.`);
            continue;
          }

          // Ajusta stake ótimo com Kelly fracionário
          tradeStake = evCheck.stake;
          log.info(`📊 [${sym}] Proposta com EV Positivo Validada (EV: +${evCheck.expectedValue} | Edge: +${(evCheck.edge * 100).toFixed(1)}% | Retorno R: +${(evCheck.payoutRatio * 100).toFixed(1)}% | Stake Kelly: $${tradeStake}).`);
        }

        // --- GATE 4: META-LABELING AI VETO (LÓPEZ DE PRADO) ---
        const featureVector = DerivMetaLabeler.extractFeatures(
          er,
          r2,
          slope,
          imbalance,
          varianceRatio,
          tickVol,
          evCheckResult?.payoutRatio || 0.55
        );
        const aiInference = DerivMetaLabeler.evaluateOpportunity(featureVector, 0.55);

        if (aiInference.isVetoed) {
          log.warn(`🤖 [AI GATE 4 VETO] [${sym}] Entrada bloqueada pela IA: ${aiInference.reason} Condições atuais historicamente degradam o EV.`);
          continue;
        } else if (aiInference.probWin < 1.0) {
          log.info(`🤖 [AI GATE 4 APROVADO] [${sym}] Probabilidade estimada de sucesso da estratégia: ${(aiInference.probWin * 100).toFixed(1)}%.`);
        }

        if (proposal && proposal.id) {
          const bought = await client.buyContract(proposal.id, proposal.ask_price).catch(() => null);
          if (bought && bought.contract_id) {
            const displayType = contractType;
            const displayBarrier = proposal.barrier ? ` [Barreira: ${proposal.barrier}]` : (barrierValue ? ` [Barreira: ${barrierValue}]` : '');

            // 3. Verificação de Slippage Pós-Execução
            if (bought.buy_price && proposal.ask_price && bought.buy_price > proposal.ask_price) {
              const slippage = bought.buy_price - proposal.ask_price;
              const postBuyR = (Number(proposal.payout || 0) - bought.buy_price) / bought.buy_price;
              const postBuyEv = (calculatedProb * postBuyR) - (1 - calculatedProb);

              if (postBuyEv <= 0) {
                consecutiveSlippageWarnings++;
                log.warn(`⚠️ [SLIPPAGE_WARNING] Derrapagem de $${slippage.toFixed(2)} corroeu o EV para ${postBuyEv.toFixed(4)}. Alerta #${consecutiveSlippageWarnings}.`);
                if (consecutiveSlippageWarnings >= 3) {
                  dynamicMinEdgeBonus = 0.02; // Aumenta exigência de edge de 4% para 6% para compensar latência
                  log.warn(`🚨 [LATÊNCIA ALTA] 3 alertas seguidos de slippage. Elevando Edge mínimo exigido para 6.0%.`);
                }
              } else {
                consecutiveSlippageWarnings = Math.max(0, consecutiveSlippageWarnings - 1);
              }
            } else {
              consecutiveSlippageWarnings = Math.max(0, consecutiveSlippageWarnings - 1);
            }

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
              reason: `Estratégia "${target.name}" (${(calculatedProb * 100).toFixed(0)}% Confiança | ER: ${er.toFixed(2)} | R²: ${r2.toFixed(2)} | VR: ${varianceRatio} | Imb: ${(imbalance * 100).toFixed(0)}%)`,
              metrics: {
                er,
                r2,
                slope,
                imbalance,
                varianceRatio,
                regimeScore: candidate.regimeScore || 0,
                tickVolatility: tickVol || 0,
                modelConfidence: calculatedProb,
                expectedValue: evCheckResult?.expectedValue || 0,
                edge: evCheckResult?.edge || 0,
                payoutRatio: evCheckResult?.payoutRatio || 0,
                brokerProb: evCheckResult?.brokerProb || 0,
                barrier: proposal.barrier || barrierValue || '',
                spotPrice: ticks[ticks.length - 1] || 0,
              },
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


