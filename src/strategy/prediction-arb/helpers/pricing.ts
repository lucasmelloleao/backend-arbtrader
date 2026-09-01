// Núcleo de cálculo da estratégia de prediction markets.
// Completeness arbitrage: comprar os dois lados de um mercado binário
// quando preço(YES) + preço(NO) < 1 garante retorno no vencimento.

export interface PairPrices {
  yes: number;
  no: number;
}

/** Spread de completude: 1 - (yes + no). Positivo = arbitragem disponível. */
export function completenessSpread(p: PairPrices): number {
  return 1 - (p.yes + p.no);
}

/** Retorna o spread em % (ex: 0.01 → 1). */
export function completenessSpreadPct(p: PairPrices): number {
  return completenessSpread(p) * 100;
}

/**
 * Fee estimado da Polymarket para uma ordem (fórmula oficial):
 * fee = feeRate * shares * price * (1 - price)
 */
export function estimateFee(feeRate: number, shares: number, price: number): number {
  return feeRate * shares * price * (1 - price);
}

/** Custo total para montar o par (comprar YES + NO). */
export function pairCost(p: PairPrices, sharesYes: number, sharesNo: number, feeRate: number): number {
  const buyYes = sharesYes * p.yes;
  const buyNo = sharesNo * p.no;
  const feeYes = estimateFee(feeRate, sharesYes, p.yes);
  const feeNo = estimateFee(feeRate, sharesNo, p.no);
  return buyYes + buyNo + feeYes + feeNo;
}

/** Retorno garantido no vencimento para um par completo (notional $1/share). */
export function guaranteedReturn(sharesYes: number, sharesNo: number): number {
  return Math.max(sharesYes, sharesNo);
}

/** Retorno líquido do par completo em $. */
export function netPairReturn(p: PairPrices, shares: number, feeRate: number): number {
  return guaranteedReturn(shares, shares) - pairCost(p, shares, shares, feeRate);
}

/** Retorno líquido em % sobre o capital alocado. */
export function netReturnPct(p: PairPrices, shares: number, feeRate: number): number {
  const cost = pairCost(p, shares, shares, feeRate);
  if (cost <= 0) return 0;
  return (netPairReturn(p, shares, feeRate) / cost) * 100;
}

/**
 * Preços de entrada maker para os dois lados, garantindo soma < 1
 * com uma margem (spread alvo). Ex: yes@0.47, no@0.52.
 */
export function makerEntryPrices(
  bestBidYes: number,
  bestBidNo: number,
  targetSpreadPct: number
): PairPrices | null {
  if (bestBidYes <= 0 || bestBidNo <= 0) return null;
  // Soma alvo = 1 - spread alvo
  const targetSum = 1 - targetSpreadPct / 100;
  const yes = Math.min(bestBidYes, targetSum - bestBidNo);
  const no = Math.min(bestBidNo, targetSum - yes);
  if (yes <= 0 || no <= 0) return null;
  if (yes + no >= 1) return null;
  return { yes, no };
}

/** PnL de saída: vender o par ao preço atual (ou resolver no vencimento). */
export function pairExitPnl(
  entry: PairPrices,
  exit: PairPrices,
  shares: number,
  feeRate: number
): number {
  const buyCost = pairCost(entry, shares, shares, feeRate);
  const sellProceeds = shares * exit.yes + shares * exit.no;
  const sellFee = estimateFee(feeRate, shares, exit.yes) + estimateFee(feeRate, shares, exit.no);
  return sellProceeds - sellFee - buyCost;
}
