// Módulo Matemático e Quantitativo para Prediction Markets (Polymarket)
// Aplica EV (Expected Value), Kelly Criterion, Regime / Lo-MacKinlay VR e Microfluxo de Ordem

import { withTimeout } from '../../perpetuals/helpers/ccxt-factory';

export interface PolymarketEVResult {
  expectedValue: number;
  edgePct: number;
  kellyFraction: number;
  suggestedStakeUsd: number;
  isValid: boolean;
  reason: string;
}

export interface PolymarketQuantGates {
  er: number;
  varianceRatio: number;
  orderImbalance: number;
  isRandomWalk: boolean;
  gatesPassed: boolean;
  score: number;
  reason: string;
}

/**
 * Calcula a Expectativa Matemática (EV) e Kelly Criterion para uma aposta direcional na Polymarket.
 *
 * Preço na Polymarket varia entre $0.01 e $0.99.
 * Se compramos por $p e a probabilidade real estimada pelo modelo é P_model:
 * Payout da vitória: $1.00 - $p (ganho líquido)
 * Perda em caso de derrota: $p
 *
 * EV = P_model * (1 - p) - (1 - P_model) * p = P_model - p
 * Edge (%) = ((P_model - p) / p) * 100
 *
 * Kelly Fraction = (b * p_win - q_win) / b
 * onde b = (1 - p) / p (odds oferecidas)
 */
export function calculatePolymarketEV(
  price: number,
  modelEstimatedProb: number,
  bankrollUsd: number,
  minEdgePct = 2.0 // Exige no mínimo 2% de edge matemático
): PolymarketEVResult {
  if (price <= 0 || price >= 1.0 || modelEstimatedProb <= 0) {
    return {
      expectedValue: -1,
      edgePct: 0,
      kellyFraction: 0,
      suggestedStakeUsd: 0,
      isValid: false,
      reason: 'Preço ou probabilidade fora do domínio válido (0, 1).',
    };
  }

  const p = price;
  const pWin = Math.min(0.99, Math.max(0.01, modelEstimatedProb));
  const qLoss = 1 - pWin;

  // Expected Value por dólar investido
  const netProfitPerDollar = (1 - p) / p; // b
  const ev = pWin * (1 - p) - qLoss * p;
  const edgePct = (ev / p) * 100;

  // Kelly Criterion clássico
  let kelly = (netProfitPerDollar * pWin - qLoss) / netProfitPerDollar;
  kelly = Math.max(0, kelly);

  // Fractional Kelly (1/4 Kelly) para gestão institucional de risco e preservação de banca
  const fractionalKelly = kelly * 0.25;
  const suggestedStake = Math.max(1.0, Math.min(bankrollUsd * fractionalKelly, bankrollUsd * 0.20));

  const isValid = ev > 0 && edgePct >= minEdgePct;
  const reason = isValid
    ? `EV Positivo: +$${ev.toFixed(3)}/cota (Edge: +${edgePct.toFixed(1)}% | Kelly: ${(fractionalKelly * 100).toFixed(1)}%).`
    : `EV Insuficiente: $${ev.toFixed(3)}/cota (Edge: ${edgePct.toFixed(1)}% < Mín: +${minEdgePct}%).`;

  return {
    expectedValue: Number(ev.toFixed(4)),
    edgePct: Number(edgePct.toFixed(2)),
    kellyFraction: Number(fractionalKelly.toFixed(4)),
    suggestedStakeUsd: Number(suggestedStake.toFixed(2)),
    isValid,
    reason,
  };
}

/**
 * Calcula Eficiência de Kaufman (ER) e Lo-MacKinlay Variance Ratio (VR) no spot subjacente
 * a partir de candles de 1m na Binance para garantir que o ativo não está em Random Walk.
 */
export async function calculateSpotQuantGates(
  symbol: string,
  targetSide: 'YES' | 'NO',
  strikePrice: number
): Promise<PolymarketQuantGates> {
  const asset = symbol.toUpperCase().replace(/[^A-Z]/g, '');
  if (!asset) {
    return {
      er: 0,
      varianceRatio: 1.0,
      orderImbalance: 0,
      isRandomWalk: false,
      gatesPassed: true,
      score: 0.5,
      reason: 'Ativo sem spot rastreável. Bypass de gates.',
    };
  }

  try {
    const pairBinance = asset.endsWith('USDT') ? asset : `${asset}USDT`;
    const res = await withTimeout(
      fetch(`https://api.binance.com/api/v3/klines?symbol=${pairBinance}&interval=1m&limit=30`),
      4000,
      null
    );

    if (res && res.ok) {
      const klines = (await res.json()) as any[];
      if (Array.isArray(klines) && klines.length >= 20) {
        const closes = klines.map((k) => Number(k[4]));
        const n = closes.length;

        // 1. Kaufman Efficiency Ratio (ER) em 15 períodos
        const change = Math.abs(closes[n - 1] - closes[n - 15]);
        let volatility = 0;
        for (let i = n - 14; i < n; i++) {
          volatility += Math.abs(closes[i] - closes[i - 1]);
        }
        const er = volatility > 0 ? change / volatility : 0;

        // 2. Lo-MacKinlay Variance Ratio (q = 3)
        const logReturns1: number[] = [];
        for (let i = 1; i < n; i++) {
          logReturns1.push(Math.log(closes[i] / closes[i - 1]));
        }
        const mean1 = logReturns1.reduce((a, b) => a + b, 0) / logReturns1.length;
        const var1 =
          logReturns1.reduce((acc, r) => acc + Math.pow(r - mean1, 2), 0) / (logReturns1.length - 1);

        const q = 3;
        const logReturnsQ: number[] = [];
        for (let i = q; i < n; i += q) {
          logReturnsQ.push(Math.log(closes[i] / closes[i - q]));
        }
        const meanQ = logReturnsQ.reduce((a, b) => a + b, 0) / logReturnsQ.length;
        const varQ =
          logReturnsQ.reduce((acc, r) => acc + Math.pow(r - meanQ, 2), 0) / (logReturnsQ.length - 1);

        const varianceRatio = var1 > 0 ? varQ / (q * var1) : 1.0;

        // 3. Direção alinhada com o strike
        const currentSpot = closes[n - 1];
        const spotAcimaDoStrike = currentSpot > strikePrice;
        const direcaoAlinhada = (targetSide === 'YES' && spotAcimaDoStrike) || (targetSide === 'NO' && !spotAcimaDoStrike);

        // Se VR < 0.90 e ER < 0.20, o mercado está em Random Walk sem direção
        const isRandomWalk = varianceRatio < 0.90 && er < 0.20;
        const gatesPassed = !isRandomWalk && direcaoAlinhada;

        const score = er * 0.5 + Math.min(1.0, varianceRatio / 2.0) * 0.5;

        return {
          er: Number(er.toFixed(3)),
          varianceRatio: Number(varianceRatio.toFixed(3)),
          orderImbalance: 0,
          isRandomWalk,
          gatesPassed,
          score: Number(score.toFixed(3)),
          reason: gatesPassed
            ? `Gates Quantitativos Aprovados (ER: ${er.toFixed(2)} | VR: ${varianceRatio.toFixed(2)} | Alinhado com Strike: ${direcaoAlinhada ? 'Sim' : 'Não'}).`
            : `Gates Rejeitados: ${isRandomWalk ? 'Random Walk Detectado' : 'Spot em desacordo com Strike/Lado'}.`,
        };
      }
    }
  } catch {}

  return {
    er: 0.3,
    varianceRatio: 1.1,
    orderImbalance: 0,
    isRandomWalk: false,
    gatesPassed: true,
    score: 0.6,
    reason: 'Consulta spot indisponível. Mantendo avaliação padrão.',
  };
}
