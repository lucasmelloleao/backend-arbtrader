import mongoose from 'mongoose';
import redis from './redis';
import PerpArbStrategy from '../models/PerpArbStrategy';
import PerpArbTrade from '../models/PerpArbTrade';
import { exec } from 'child_process';
import { promisify } from 'util';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const execAsync = promisify(exec);
const checkInterval = 60000 * 5; // 5 minutos
const restartThreshold = 5;
const restartCounts = new Map<string, number>();

export async function sendTelegramAlert(
  message: string,
  disableNotification = false,
  targetUserId?: string
): Promise<boolean> {
  let targetToken = BOT_TOKEN;
  let targetChatId = CHAT_ID;

  if (targetUserId) {
    try {
      const User = mongoose.models.User || mongoose.model('User');
      const user = await (User as any).findById(targetUserId).lean();
      if (user?.telegramBotToken && user?.telegramChatId) {
        targetToken = user.telegramBotToken;
        targetChatId = user.telegramChatId;
      }
    } catch { /* fallback silencioso para credenciais globais env */ }
  }

  if (!targetToken || !targetChatId) return false;

  try {
    const res = await fetch(`https://api.telegram.org/bot${targetToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChatId,
        text: message,
        parse_mode: 'Markdown',
        disable_notification: disableNotification
      })
    });
    return res.ok;
  } catch (err: any) {
    console.error('❌ [sendTelegramAlert] Error:', err.message);
    return false;
  }
}

// ─── Polling Loop do Telegram ──────────────────────────────────────────────
let lastUpdateId = 0;
async function pollTelegram() {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`);
    if (!res.ok) {
      setTimeout(pollTelegram, 5000);
      return;
    }
    const data = (await res.json()) as any;
    if (data && data.ok && Array.isArray(data.result)) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        const message = update.message || update.callback_query?.message;
        const query = update.callback_query;
        
        if (message && String(message.chat.id) === String(CHAT_ID)) {
          const text = message.text || '';
          
          if (text.startsWith('/close ')) {
            const symbolArg = text.replace('/close ', '').toUpperCase().trim();
            if (symbolArg) {
              await handleTelegramClose(symbolArg);
            }
          }
          else if (text.startsWith('/status') || text.startsWith('/report') || text.startsWith('/posicoes') || text.startsWith('/positions')) {
            await handleTelegramStatus();
          }
        }
        
        if (query && String(query.message?.chat?.id) === String(CHAT_ID)) {
          const callbackData = query.data || '';
          if (callbackData.startsWith('CLOSE_')) {
            const strategyId = callbackData.replace('CLOSE_', '');
            await handleTelegramCloseById(strategyId);
          }
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: query.id })
          });
        }
      }
    }
    setTimeout(pollTelegram, 500);
  } catch (err: any) {
    console.error('❌ [pollTelegram] Error:', err.message);
    setTimeout(pollTelegram, 5000);
  }
}

async function handleTelegramClose(symbolArg: string) {
  try {
    if (symbolArg === 'ALL' || symbolArg === 'TUDO') {
      await sendTelegramAlert('🚨 *FECHAMENTO GLOBAL DE EMERGÊNCIA*\nIniciando encerramento de TODAS as posições...');
      const openStrats = await PerpArbStrategy.find({ positionOpen: true }).lean();
      if (openStrats.length === 0) {
        await sendTelegramAlert('ℹ️ Nenhuma posição casada aberta no momento.');
        return;
      }
      for (const s of openStrats) {
        if (redis) {
          await redis.publish('perp-arb-control', JSON.stringify({ 
            action: 'CLOSE_STRATEGY', 
            strategyId: String(s._id),
            perpSymbol: s.perpSymbol
          }));
        }
      }
      await sendTelegramAlert('✅ *Fechamento global concluído.* Todas as ordens de saída foram disparadas.');
      return;
    }
    
    const strat = await PerpArbStrategy.findOne({ perpSymbol: symbolArg + ':USDT', positionOpen: true });
    if (!strat) {
      await sendTelegramAlert(`❌ Estratégia ativa para o par *${symbolArg}* não encontrada.`);
      return;
    }

    if (redis) {
      await redis.publish('perp-arb-control', JSON.stringify({ 
        action: 'CLOSE_STRATEGY', 
        strategyId: String(strat._id),
        perpSymbol: strat.perpSymbol
      }));
    }
    await sendTelegramAlert(`✅ Operação de *${symbolArg}* enviada para fechamento!`);
  } catch (err: any) {
    await sendTelegramAlert(`❌ Erro ao fechar: ${err.message}`);
  }
}

async function handleTelegramCloseById(strategyId: string) {
  try {
    const strat = await PerpArbStrategy.findById(strategyId);
    if (!strat) {
      await sendTelegramAlert(`❌ Estratégia não encontrada.`);
      return;
    }
    if (redis) {
      await redis.publish('perp-arb-control', JSON.stringify({ 
        action: 'CLOSE_STRATEGY', 
        strategyId: String(strat._id),
        perpSymbol: strat.perpSymbol
      }));
    }
    await sendTelegramAlert(`✅ Operação de *${strat.name}* enviada para fechamento!`);
  } catch (err: any) {
    await sendTelegramAlert(`❌ Erro ao fechar por ID: ${err.message}`);
  }
}

async function handleTelegramStatus() {
  try {
    const openStrats = await PerpArbStrategy.find({ positionOpen: true }).lean();
    if (openStrats.length === 0) {
      await sendTelegramAlert('📊 *Relatório de Posições*\nNenhuma posição casada aberta no momento.');
      return;
    }
    for (const s of openStrats) {
      const size = s.positionSize || s.tradeSize || 0;
      const funding = s.fundingCollected || 0;
      const symbolClean = s.perpSymbol.replace(':USDT', '');
      
      const text = `📊 *POSIÇÃO ABERTA*\n\n` +
        `🔹 *Estratégia:* ${s.name}\n` +
        `🔀 *Par:* \`${s.perpSymbol}\` / \`${s.spotSymbol}\`\n` +
        `💰 *Tamanho:* \`$${size.toFixed(2)} USDT\`\n` +
        `🌾 *Funding Coletado:* \`+$${funding.toFixed(4)} USDT\`\n` +
        `⚡ *Funding Rate Atual:* \`${s.currentFundingRate !== undefined && s.currentFundingRate !== null ? s.currentFundingRate.toFixed(4) + '%' : '—'}\``;

      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: text,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: `🛑 Encerrar ${symbolClean}`, callback_data: `CLOSE_${String(s._id)}` }]
            ]
          }
        })
      });
    }
  } catch (err: any) {
    await sendTelegramAlert(`❌ Erro ao obter status: ${err.message}`);
  }
}

// ─── PM2 Monitor Loop ──────────────────────────────────────────────────────
async function checkPM2() {
  try {
    const { stdout } = await execAsync("pm2 jlist");
    const processes = JSON.parse(stdout);

    for (const proc of processes) {
      const name = proc.name;
      const status = proc.pm2_env?.status;
      const restarts = proc.pm2_env?.restart_time || 0;

      if (status !== "online" && status !== "stopping" && status !== "launching") {
        await sendTelegramAlert(`🚨 *[ALERTA PM2]* O robô \`${name}\` está com status: *${status}*!`);
      }

      const lastRestarts = restartCounts.get(name) || 0;
      if (restarts - lastRestarts >= restartThreshold) {
        await sendTelegramAlert(`⚠️ *[ALERTA PM2]* O robô \`${name}\` reiniciou ${restarts - lastRestarts} vezes nos últimos 5 minutos. Pode estar em Crash Loop!`);
      }
      restartCounts.set(name, restarts);
    }
  } catch (error: any) {
    // Silencia erros normais de falta do PM2 no ambiente de desenvolvimento local
    if (!error.message.includes('pm2: not found') && !error.message.includes('pm2: comando não encontrado')) {
      console.error("Erro ao verificar PM2:", error.message);
    }
  }
}

export function startTelegramBotAndPM2Monitor() {
  if (BOT_TOKEN && CHAT_ID) {
    console.log('✅ Polling do Telegram Bot iniciado centralizado...');
    pollTelegram();
    
    console.log('✅ Monitor do PM2 iniciado...');
    setInterval(checkPM2, checkInterval);
    checkPM2();
  }
}

/**
 * Alertas pré-definidos para eventos do bot
 */
export const alerts = {
  async tradeOpened(
    strategyName: string,
    symbol: string,
    size: number,
    price: number,
    opts: { dryRun?: boolean; spotSymbol?: string; spotPrice?: number; perpPrice?: number; baseAmount?: number; userId?: string } = {}
  ) {
    const modeStr = opts.dryRun ? ' 🧪 (SIMULADO / DRY-RUN)' : ' 🚀 (LIVE)';
    const spotStr = opts.spotSymbol ? ` / ${opts.spotSymbol}` : '';
    const pricesStr = (opts.spotPrice || opts.perpPrice)
      ? `\n📍 Spot: $${(opts.spotPrice || price).toFixed(4)} | Perp: $${(opts.perpPrice || price).toFixed(4)}`
      : `\n📍 Preço: $${price.toFixed(4)}`;
    const baseStr = opts.baseAmount ? ` (${opts.baseAmount.toFixed(4)} base)` : '';

    return sendTelegramAlert(
      `🟢 *OPERAÇÃO DE ENTRADA ABERTA*${modeStr}\n` +
      `📌 *Estratégia:* ${strategyName}\n` +
      `🔀 *Par:* ${symbol}${spotStr}\n` +
      `⚡ *Ação:* Spot LONG + Perp SHORT\n` +
      `💰 *Tamanho da Posição:* $${size.toFixed(2)} USDT${baseStr}` +
      pricesStr,
      false,
      opts.userId
    );
  },

  async tradeClosed(
    strategyName: string,
    symbol: string,
    pnl: number,
    fundingCollected: number,
    opts: { dryRun?: boolean; spotSymbol?: string; reason?: string; size?: number; userId?: string } = {}
  ) {
    const modeStr = opts.dryRun ? ' 🧪 (SIMULADO / DRY-RUN)' : ' 🚀 (LIVE)';
    const spotStr = opts.spotSymbol ? ` / ${opts.spotSymbol}` : '';
    const reasonStr = opts.reason ? `\n💡 *Motivo:* ${opts.reason}` : '';
    const emoji = pnl >= 0 ? '🏁' : '🔴';

    return sendTelegramAlert(
      `${emoji} *OPERAÇÃO DE SAÍDA FECHADA*${modeStr}\n` +
      `📌 *Estratégia:* ${strategyName}\n` +
      `🔀 *Par:* ${symbol}${spotStr}\n` +
      `⚡ *Ação:* Spot SELL + Perp BUY (Fechamento)\n` +
      `💰 *Tamanho da Posição:* $${(opts.size || 0).toFixed(2)} USDT` +
      `\n📊 *PnL:* $${pnl.toFixed(2)}\n` +
      `🌾 *Funding Coletado:* $${fundingCollected.toFixed(4)}` +
      reasonStr,
      false,
      opts.userId
    );
  },

  async tradeFailed(strategyName: string, error: string, userId?: string) {
    return sendTelegramAlert(
      `🔴 *Trade Falhou* - ${strategyName}\n` +
      `Erro: ${error}`,
      true,
      userId
    );
  },

  async dailyLossLimit(strategyName: string, accumulated: number, limit: number, userId?: string) {
    return sendTelegramAlert(
      `⛔ *Limite de Perda Diária Atingido* - ${strategyName}\n` +
      `Perda acumulada: $${accumulated.toFixed(2)}\n` +
      `Limite: $${limit.toFixed(2)}\n` +
      `Estratégia desativada automaticamente.`,
      false,
      userId
    );
  },

  async fundingOpportunity(strategyName: string, symbol: string, fundingPct: number, exchange: string, userId?: string) {
    return sendTelegramAlert(
      `💰 *Oportunidade de Funding* - ${strategyName}\n` +
      `Exchange: ${exchange}\n` +
      `Símbolo: ${symbol}\n` +
      `Funding rate: ${fundingPct.toFixed(4)}%`,
      false,
      userId
    );
  },

  async botHeartbeat(botName: string, status: string, userId?: string) {
    return sendTelegramAlert(
      `💓 *Heartbeat* - ${botName}\nStatus: ${status}`,
      true,
      userId
    );
  },
};

