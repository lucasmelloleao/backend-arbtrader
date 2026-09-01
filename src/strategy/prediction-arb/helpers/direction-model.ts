// Modelo direcional (fase 2): estima o preço "justo" de um lado usando
// dados externos (ex: Binance perp/spot). Nesta fase é um stub neutro:
// retorna o preço de mercado como fair value.

export interface DirectionInput {
  yesPrice: number;
  noPrice: number;
  symbol?: string; // ex: 'BTC'
  btcPrice?: number;
  fundingRate?: number;
  volatility?: number;
}

export interface DirectionOutput {
  yesFair: number;
  noFair: number;
  confidence: number; // 0..1
  directional: boolean; // true quando o modelo sugere desbalancear
}

/** Stub neutro: fair value = preço de mercado, sem viés direcional. */
export function estimateFairValue(input: DirectionInput): DirectionOutput {
  const sum = input.yesPrice + input.noPrice;
  const yesFair = sum > 0 ? input.yesPrice / sum : 0.5;
  return {
    yesFair,
    noFair: 1 - yesFair,
    confidence: 0,
    directional: false,
  };
}

/**
 * Placeholder para integração futura com Binance perp/spot:
 * calcula probabilidade implícita a partir do preço e funding do perpétuo.
 */
export function estimateFromPerp(symbol: string, perpPrice: number, spotPrice: number, fundingRate: number): DirectionOutput {
  void symbol;
  void perpPrice;
  void spotPrice;
  void fundingRate;
  return { yesFair: 0.5, noFair: 0.5, confidence: 0, directional: false };
}
