// Otimizador Dinâmico de Barreira e Expectativa Matemática (EV) para a Deriv
// Calcula volatilidade realizada, determina offset ótimo e valida Edge com Kelly fracionário

export interface BarrierProposalCheck {
  barrierOffset: string;
  expectedValue: number;
  edge: number;
  isValid: boolean;
  stake: number;
  payoutRatio: number;
  brokerProb: number;
}

export class DerivBarrierOptimizer {
  private static readonly MIN_EDGE = 0.04; // Exige 4% de vantagem matemática mínima
  private static readonly MIN_PAYOUT_RATIO = 0.40; // Retorno mínimo de 40% (R >= 0.40)
  private static readonly MAX_PAYOUT_RATIO = 0.95; // Teto de 95% para acomodar contratos padrão Rise/Fall e Higher/Lower

  /**
   * Calcula o desvio padrão dos retornos por tick (Volatilidade Realizada)
   */
  public static calculateTickVolatility(prices: number[]): number {
    if (prices.length < 2) return 0.01;
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push(prices[i] - prices[i - 1]);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    return Math.sqrt(variance) || 0.01;
  }

  /**
   * Gera o offset de barreira ótimo em função da volatilidade recente (em 15 ticks)
   * @param direction 'HIGHER' | 'LOWER' | 'CALL' | 'PUT'
   * @param tickVol Desvio padrão dos ticks
   */
  public static getTargetOffset(direction: 'HIGHER' | 'LOWER' | 'CALL' | 'PUT', tickVol: number): string {
    // Projeção para 15 ticks: sigma_15 = tickVol * sqrt(15)
    const sigma15 = tickVol * Math.sqrt(15);

    // Offset alvo fixado em ~0.30 sigmas a favor da probabilidade
    const targetDistance = Math.max(0.10, Number((sigma15 * 0.30).toFixed(2)));

    // Para HIGHER/CALL: barreira abaixo do spot (-offset)
    // Para LOWER/PUT: barreira acima do spot (+offset)
    if (direction === 'HIGHER' || direction === 'CALL') {
      return `-${targetDistance.toFixed(2)}`;
    } else {
      return `+${targetDistance.toFixed(2)}`;
    }
  }

  /**
   * Avalia a proposta retornada pela API Deriv (endpoint proposal) calculando EV e Edge
   */
  public static evaluateProposal(
    askPrice: number,
    payout: number,
    modelConfidence: number,
    baseStake: number,
    customMinEdge?: number
  ): BarrierProposalCheck {
    const requiredMinEdge = customMinEdge !== undefined ? customMinEdge : this.MIN_EDGE;

    if (!askPrice || askPrice <= 0 || !payout || payout <= askPrice) {
      return {
        barrierOffset: '0',
        expectedValue: -1,
        edge: 0,
        isValid: false,
        stake: baseStake,
        payoutRatio: 0,
        brokerProb: 1,
      };
    }

    const netReturn = payout - askPrice;
    const R = netReturn / askPrice; // Retorno percentual líquido (ex: 0.55 = 55%)

    // 1. Filtro de Faixa de Retorno (Sweet Spot 40% a 85%)
    if (R < this.MIN_PAYOUT_RATIO || R > this.MAX_PAYOUT_RATIO) {
      return {
        barrierOffset: '0',
        expectedValue: Number(((modelConfidence * R) - (1 - modelConfidence)).toFixed(4)),
        edge: 0,
        isValid: false,
        stake: baseStake,
        payoutRatio: Number(R.toFixed(3)),
        brokerProb: Number((askPrice / payout).toFixed(3)),
      };
    }

    // 2. Probabilidade Implícita da Corretora vs Probabilidade do Modelo
    const brokerProb = askPrice / payout;
    const edge = modelConfidence - brokerProb;

    // 3. Cálculo de EV Líquido por Dólar
    const ev = (modelConfidence * R) - (1 - modelConfidence);

    // 4. Verificação de Viabilidade Matemática com Edge Dinâmico
    const isValid = ev > 0 && edge >= requiredMinEdge;

    // 5. Dimensionamento via Critério de Kelly Fracionário com Hard Cap (Teto de 1.5x)
    let optimalStake = baseStake;
    if (isValid && R > 0) {
      const fullKelly = (modelConfidence * (R + 1) - 1) / R;
      const quarterKelly = Math.max(0, fullKelly * 0.25);
      const proposedStake = baseStake * (1 + quarterKelly);
      optimalStake = Math.min(proposedStake, baseStake * 1.5); // Hard Cap blindado em 1.5x
    }

    return {
      barrierOffset: '',
      expectedValue: Number(ev.toFixed(4)),
      edge: Number(edge.toFixed(4)),
      isValid,
      stake: Number(optimalStake.toFixed(2)),
      payoutRatio: Number(R.toFixed(3)),
      brokerProb: Number(brokerProb.toFixed(3)),
    };
  }
}
