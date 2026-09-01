// Loop principal da Arbitragem Forex: monitora estratégias abertas (take-profit
// e trailing) e dispara execução automática das oportunidades. Espelha o padrão
// de perpetuals/funding-arb.ts.
import { loadEnv } from '../../utils/env-loader';
loadEnv();
import mongoose from 'mongoose';
import Redis from 'ioredis';
import { connectToDatabase } from '../../config/db';
import ForexArbStrategy from '../../models/ForexArbStrategy';
import ForexArbSettings from '../../models/ForexArbSettings';
import ExchangeKey from '../../models/ExchangeKey';
import { isCtraderExchange } from './scanner';
import { getSharedCtraderAdapter } from './ctrader/ctrader-factory';
import { isFixExchange, getSharedFixAdapter } from './fix/fix-factory';
import { isDukascopyExchange, getSharedDukascopyAdapter } from './dukascopy/dukascopy-factory';

const getTs = () => `[${new Date().toISOString()}]`;
const log = {
  info: (...args: any[]) => console.log(getTs(), '[FOREX-ARB]', ...args),
  warn: (...args: any[]) => console.warn(getTs(), '[FOREX-ARB]', ...args),
  error: (...args: any[]) => console.error(getTs(), '[FOREX-ARB]', ...args),
};

// ─── Redis control channel ─────────────────────────────────────────────────────

let _redis: Redis | null = null;

function getRedisClient(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const c = new Redis(url);
    c.on('error', () => {});
    _redis = c;
  } catch { _redis = null; }
  return _redis;
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI required');
  await connectToDatabase();
  log.info('✅ Connected to MongoDB - Forex Arb');

  if (process.env.REDIS_URL) {
    try {
      const sub = new Redis(process.env.REDIS_URL);
      sub.subscribe('forex-arb-control', (err) => {
        if (!err) log.info('📡 [REDIS] Inscrito no canal forex-arb-control');
      });
      sub.on('message', async (channel, message) => {
        if (channel === 'forex-arb-control') {
          try {
            const data = JSON.parse(message);
            if (data.action === 'CLOSE_STRATEGY' && data.strategyId) {
              log.info(`⚡ [REDIS COMMAND] Encerramento solicitado para: ${data.strategyId}`);
              const exec = await import('./forex-arb-executor');
              await exec.closeArbitrage(String(data.strategyId), { dryRun: false, reason: 'Comando Manual (Dashboard / UI)' });
            }
          } catch (e: any) {
            log.error('❌ Erro ao processar mensagem do Redis:', e.message);
          }
        }
      });
    } catch (e: any) {
      log.warn('⚠️ Não foi possível inicializar Redis subscriber:', e.message);
    }
  }

  log.info('✅ Iniciando loop principal Forex Arb...');

  // Trailing stop em memória: strategyId -> pico de retorno (%)
  const peakProfitMap = new Map<string, number>();

  while (true) {
    try {
      log.info('🔁 [FOREX-ARB] Iniciando ciclo...');
      const settings = await ForexArbSettings.findOne().lean();

      const strategies = await (ForexArbStrategy as any).find({
        $or: [{ active: true }, { positionOpen: true }]
      }).lean();

      if (!strategies.length && settings && settings.isScanningEnabled) {
        log.info('🔍 Nenhuma estratégia ativa. Executando varredura para captura instantânea (sem deixar posição aberta)...');
        const scannerMod = await import('./scanner');
        const keys = await (ExchangeKey as any).find({ userId: settings.userId, active: true }).lean();
        const keyMap = new Map<string, any>();
        for (const k of keys) keyMap.set(k.exchangeId, k);
        // Reusa o adaptador compartilhado (mesmo WebSocket do executor) em vez de
        // criar/destruir uma conexão nova a cada ciclo: evita reconexão + reauth
        // constantes e mantém os spots assinados disponíveis para a captura.
        const sharedAdapter = keyMap.get('ctrader') ? await getSharedCtraderAdapter(keyMap.get('ctrader')) : null;
        const opps = sharedAdapter
          ? await scannerMod.scanForexArbitrage('ctrader', { forceFirstExecution: false }, keyMap.get('ctrader'), sharedAdapter)
          : await scannerMod.scanForexArbitrage('ctrader', { forceFirstExecution: false }, keyMap.get('ctrader'));
        if (opps && opps.length > 0) {
          const opp = opps[0];
          log.info(`🎯 Oportunidade detectada: ${opp.legs.map((l: any) => `${l.symbol}:${l.side}`).join(' -> ')} (net teórico ${opp.expectedProfitPct.toFixed(4)}%). Analisando lucro executável...`);
          try {
            const exec = await import('./forex-arb-executor');
            const result = await exec.executeTriangularCapture(opp, settings, keyMap.get('ctrader'));
            if (result.operated) {
              log.info(`✅ Captura executada com sucesso: +${result.profitPct?.toFixed(4)}% — FLAT, sem posições abertas.`);
            } else {
              log.info(`⏭️ Captura não executada: ${result.reason || 'sem oportunidade lucrativa'}`);
            }
          } catch (e: any) {
            log.error(`❌ Falha na captura instantânea:`, e?.message || e, e?.stack);
          }
        }
      }

      for (const strat of strategies) {
        try {
          log.info(`🔁 Processando estratégia Forex: [${strat.name}] (${strat.type}, ${strat.legs?.length || 0} pernas)`);

          if (strat.positionOpen) {
            // ── Monitora posição aberta ──────────────────────────────────────
            const positionSize = Number(strat.positionSize || strat.tradeSize || 0);
            if (positionSize > 0) {
              // PnL atual: para cTrader usa PnL não realizado real das posições
              // (em % do tamanho da posição); para CCXT mantém o esperado.
              const expectedProfitPct = Number(strat.expectedProfitPct || 0);
              let currentProfitPct = expectedProfitPct;

              if (isCtraderExchange(strat.exchangeId) || isFixExchange(strat.exchangeId) || isDukascopyExchange(strat.exchangeId)) {
                try {
                  const key = await (ExchangeKey as any).findById(strat.exchangeKeyId).lean();
                  if (key) {
                    const adapter = isFixExchange(strat.exchangeId)
                      ? await getSharedFixAdapter(key)
                      : isDukascopyExchange(strat.exchangeId)
                        ? await getSharedDukascopyAdapter(key)
                        : await getSharedCtraderAdapter(key);
                    const positionsPnl = await adapter.getPositionsPnL();
                    let realPnl = 0;
                    for (const leg of strat.legs || []) {
                      const pos = positionsPnl.get(leg.symbol);
                      if (pos) realPnl += pos.netPnl;
                    }
                    if (realPnl !== 0 && positionSize > 0) {
                      currentProfitPct = (realPnl / positionSize) * 100;
                    }
                  } else {
                    log.warn(`⚠️ [MONITOR] [${strat.name}] ExchangeKey ${strat.exchangeKeyId} não encontrada no banco.`);
                  }
                } catch (e: any) {
                  log.warn(`⚠️ [MONITOR] [${strat.name}] Falha ao obter PnL real: ${e.message}. Usando esperado.`);
                }
              }

              const sKey = String(strat._id);
              const peak = Math.max(Number(strat.peakProfitPct || 0), peakProfitMap.get(sKey) || 0);
              if (currentProfitPct > peak) {
                peakProfitMap.set(sKey, currentProfitPct);
                (ForexArbStrategy as any).findByIdAndUpdate(strat._id, { peakProfitPct: currentProfitPct }).catch(() => {});
              }

              log.info(`👀 [MONITOR] [${strat.name}] ABERTA | Tamanho: ${positionSize} USDT | PnL atual: ${currentProfitPct.toFixed(3)}% (esperado ${expectedProfitPct.toFixed(3)}%)`);

              // Take-profit: se o retorno esperado já foi atingido (oportunidade
              // se realizou), fecha. Trailing: se caiu muito do pico, fecha.
              const targetProfitPct = Number(settings?.targetProfitPct ?? 0.5);
              const trailingDropPct = Number(settings?.profitTrailingDropPct ?? 30);

              if (currentProfitPct >= targetProfitPct) {
                log.info(`🎯 [TAKE-PROFIT] [${strat.name}] Retorno ${currentProfitPct.toFixed(2)}% >= alvo ${targetProfitPct}%. Fechando.`);
                peakProfitMap.delete(sKey);
                const exec = await import('./forex-arb-executor');
                exec.closeArbitrage(String(strat._id), { dryRun: false, reason: `Take-Profit (${currentProfitPct.toFixed(2)}%)` }).catch((e: any) => {
                  log.error(`❌ Erro no take-profit [${strat.name}]:`, e.message);
                });
              } else if (peak > 0 && currentProfitPct < peak * (1 - trailingDropPct / 100)) {
                log.info(`🔻 [TRAILING STOP] [${strat.name}] Retorno caiu de ${peak.toFixed(2)}% para ${currentProfitPct.toFixed(2)}%. Fechando.`);
                peakProfitMap.delete(sKey);
                const exec = await import('./forex-arb-executor');
                exec.closeArbitrage(String(strat._id), { dryRun: false, reason: `Trailing Stop (pico ${peak.toFixed(2)}%)` }).catch((e: any) => {
                  log.error(`❌ Erro no trailing [${strat.name}]:`, e.message);
                });
              }
            }
            continue;
          }

            // ── Estratégia fechada: executa se autoExecute e retorno válido ──
          const isAutoExecEnabled = strat.autoExecute !== false;
          const isScanningOn = settings ? settings.isScanningEnabled !== false : true;

          if (!isScanningOn) {
            log.info(`⏸️ [${strat.name}] Scanner pausado. Abertura bloqueada.`);
            continue;
          }

          if (strat.active && isAutoExecEnabled && !strat.positionOpen) {
            const expectedProfitPct = Number(strat.expectedProfitPct || 0);
            const minProfitPct = Number(strat.minProfitPct ?? settings?.minProfitPct ?? 0.05);

            // Se for a primeira execução na subida do robô (forceFirstExecution || primeira subida do bot), ignora o filtro de lucro mínimo
            const isFirstExecution = strat.forceFirstExecution !== false;

            if (!isFirstExecution && expectedProfitPct < minProfitPct) {
              log.info(`ℹ️ [${strat.name}] Retorno esperado ${expectedProfitPct.toFixed(3)}% < mínimo ${minProfitPct}%. Aguardando.`);
              continue;
            }

            if (isFirstExecution && expectedProfitPct < minProfitPct) {
              log.info(`⚡ [${strat.name}] Primeira execução ativada na subida do robô: Forçando operação de arbitragem triangular independente de lucro (${expectedProfitPct.toFixed(3)}%).`);
            }

            log.info(`🔐 Executando arbitragem [${strat.name}] (net ${expectedProfitPct.toFixed(3)}%)...`);
            const exec = await import('./forex-arb-executor');
            await exec.executeArbitrage(String(strat._id), { dryRun: false, forceFirstExecution: isFirstExecution }).catch((e: any) => {
              log.error(`❌ Auto-exec falhou [${strat.name}]:`, e?.message || e, e?.stack);
            });
          }
        } catch (e: any) {
          log.warn(`⚠️ Erro ao processar estratégia Forex "${(strat as any).name}": ${e.message}`);
        }
      }
    } catch (globalErr: any) {
      log.error('❌ Forex arb loop error:', globalErr.message);
    }

    log.info('⏳ [FOREX ARB] Ciclo concluído. Aguardando 2s...');
    await new Promise(res => setTimeout(res, 2000));
  }
}

if (require.main === module) {
  main().catch(err => { log.error(err); process.exit(1); });
}

export default main;
