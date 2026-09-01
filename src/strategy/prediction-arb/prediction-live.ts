// Modo de operação do robô PredictionArb: LIVE (ordens reais) vs DRY-RUN.
// O controle vem do banco (PredictionArbSettings.allowLiveTrading), alternado
// pelo botão "Iniciar Colheita" no frontend — não usa mais variável de ambiente.
import PredictionArbSettings from '../../models/PredictionArbSettings';

const CACHE_TTL_MS = 5_000;

let cache: { value: boolean; at: number } | null = null;

/** true = pode operar com ordens REAIS; false = dry-run (simulação). */
export async function isPredictionLiveAllowed(): Promise<boolean> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  try {
    const settings = await PredictionArbSettings.findOne().lean();
    const value = settings ? (settings as any).allowLiveTrading === true : false;
    cache = { value, at: Date.now() };
    return value;
  } catch {
    return false; // em caso de erro, nunca opera live por segurança
  }
}

/** Invalida o cache após alternar o modo pelo dashboard. */
export function invalidatePredictionLiveCache(): void {
  cache = null;
}
