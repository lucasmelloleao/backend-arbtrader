// Análise retrospectiva assistida por IA (DeepSeek ou Gemini) da estratégia Deriv.
// Separa a lógica pura (métricas + prompt) da chamada de rede, para ser testável.

import axios from 'axios';

const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';
const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

const SYSTEM_PROMPT =
  'Você é um analista quantitativo de trading. Responda em português, de forma direta e acionável.';

export type AiProvider = 'gemini' | 'deepseek';

function somar(items: any[], campo: string): number {
  return items.reduce((acc, t) => acc + Number(t[campo] || 0), 0);
}

interface LinhaAgregada {
  chave: string;
  trades: number;
  vitorias: number;
  derrotas: number;
  winRatePct: number;
  pnl: number;
}

function agregar(trades: any[], chave: (t: any) => string): LinhaAgregada[] {
  const mapa = new Map<string, { trades: number; vitorias: number; derrotas: number; pnl: number }>();

  for (const t of trades) {
    const k = chave(t) || 'Outros';
    const atual = mapa.get(k) ?? { trades: 0, vitorias: 0, derrotas: 0, pnl: 0 };
    const pnl = Number(t.pnl || 0);
    atual.trades += 1;
    if (pnl > 0) atual.vitorias += 1;
    else if (pnl < 0) atual.derrotas += 1;
    atual.pnl += pnl;
    mapa.set(k, atual);
  }

  return Array.from(mapa.entries())
    .map(([chave, v]) => ({
      chave,
      trades: v.trades,
      vitorias: v.vitorias,
      derrotas: v.derrotas,
      winRatePct: v.trades > 0 ? Number(((v.vitorias / v.trades) * 100).toFixed(1)) : 0,
      pnl: Number(v.pnl.toFixed(2)),
    }))
    .sort((a, b) => b.pnl - a.pnl);
}

export function buildDerivMetrics(trades: any[]): any {
  const executados = (trades || []).filter((t) => t.status === 'executed');
  const vitorias = executados.filter((t) => Number(t.pnl || 0) > 0);
  const derrotas = executados.filter((t) => Number(t.pnl || 0) < 0);

  const totalPnl = somar(executados, 'pnl');
  const totalInvestido = somar(executados, 'investedUsd') || somar(executados, 'buyPrice');
  const totalRealizado = somar(executados, 'realizedUsd');

  const lucroBruto = somar(vitorias, 'pnl');
  const prejuizoBruto = Math.abs(somar(derrotas, 'pnl'));

  return {
    totalTrades: executados.length,
    wins: vitorias.length,
    losses: derrotas.length,
    winRatePct: executados.length > 0 ? Number(((vitorias.length / executados.length) * 100).toFixed(1)) : 0,
    totalPnl: Number(totalPnl.toFixed(2)),
    totalInvestido: Number(totalInvestido.toFixed(2)),
    totalRealizado: Number(totalRealizado.toFixed(2)),
    avgWin: vitorias.length > 0 ? Number((lucroBruto / vitorias.length).toFixed(2)) : 0,
    avgLoss: derrotas.length > 0 ? Number((prejuizoBruto / derrotas.length).toFixed(2)) : 0,
    profitFactor: prejuizoBruto > 0 ? Number((lucroBruto / prejuizoBruto).toFixed(2)) : (lucroBruto > 0 ? 999 : 0),
    porSimbolo: agregar(executados, (t) => t.symbol),
    porTipoContrato: agregar(executados, (t) => t.contractType),
    porEstrategia: agregar(executados, (t) => t.strategyName || t.symbol),
    porHora: agregar(executados, (t) => {
      const d = t.openedAt ? new Date(t.openedAt) : null;
      return d && !isNaN(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}h` : 'Desconhecida';
    }),
  };
}

export function buildAnalysisPrompt(metrics: any): string {
  return [
    'Você é um analista quantitativo sênior especializado em opções binárias na plataforma Deriv.',
    '',
    'Analise as métricas de desempenho abaixo do robô de opções digitais e recomende ajustes CONCRETOS de parâmetros para aumentar a assertividade (taxa de acerto) e a lucratividade.',
    '',
    'Dados agregados (JSON):',
    JSON.stringify(metrics, null, 2),
    '',
    'Contexto do robô:',
    '- Sinal por confluência de EMA 9/21/34, Canal de Donchian, RSI 14, Estocástico 14 e momentum de ticks.',
    '- Parâmetros ajustáveis: minCertaintyProb (certeza mínima, 0.65-0.98), minPayoutPct (payout líquido mínimo, %), símbolos ativos, duração do contrato (15s-900s), tradeSize, cooldown pós-loss (150s) e stop diário (maxDailyLoss).',
    '',
    'Responda em português, de forma direta e acionável, com:',
    '1. Diagnóstico: onde o robô está ganhando e perdendo dinheiro (símbolos, tipos de contrato, horários).',
    '2. Recomendações concretas de parâmetros (ex: "aumentar minCertaintyProb para 0.80", "pausar o símbolo X", "evitar contratos LOWER em Y").',
    '3. Alertas de risco (ex: sequência de perdas, símbolo com expectativa negativa).',
    '',
    'Se houver poucos dados (menos de 30 trades), deixe claro que a amostra é insuficiente para conclusões fortes.',
  ].join('\n');
}

export async function callDeepSeek(apiKey: string, prompt: string, model = DEFAULT_DEEPSEEK_MODEL): Promise<string> {
  const response = await axios.post(
    DEEPSEEK_ENDPOINT,
    {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 4000,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );

  const conteudo = response.data?.choices?.[0]?.message?.content;
  if (!conteudo) {
    throw new Error('A DeepSeek não retornou conteúdo na resposta.');
  }
  return String(conteudo);
}

export async function callGemini(apiKey: string, prompt: string, model = DEFAULT_GEMINI_MODEL): Promise<string> {
  const response = await axios.post(
    `${GEMINI_ENDPOINT}/${model}:generateContent`,
    {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ parts: [{ text: prompt }] }],
    },
    {
      params: { key: apiKey },
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
    }
  );

  const texto = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!texto) {
    throw new Error('O Gemini não retornou conteúdo na resposta.');
  }
export async function callAiAnalysis(
  provider: AiProvider,
  apiKey: string,
  prompt: string,
  model: string
): Promise<string> {
  try {
    if (provider === 'gemini') {
      return await callGemini(apiKey, prompt, model);
    } else {
      return await callDeepSeek(apiKey, prompt, model);
    }
  } catch (err: any) {
    // Se o Gemini falhar e houver chave da DeepSeek, tenta fallback automático
    if (provider === 'gemini' && process.env.DEEPSEEK_API_KEY) {
      console.warn(`[AI-ANALYSIS] Falha no Gemini (${err?.message}). Tentando fallback para DeepSeek...`);
      return await callDeepSeek(process.env.DEEPSEEK_API_KEY, prompt, process.env.DEEPSEEK_MODEL || 'deepseek-chat');
    }
    throw err;
  }
}
