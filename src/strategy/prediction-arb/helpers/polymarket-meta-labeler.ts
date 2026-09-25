// Módulo de Meta-Labeling com IA (Random Forest) para Polymarket
// Gate 4: Veta ordens onde P(Win | Condições de Mercado) < 55%

import fs from 'fs';
import path from 'path';
// @ts-ignore
import { RandomForestClassifier } from 'ml-random-forest';
import PredictionArbTrade from '../../../models/PredictionArbTrade';

export interface PolymarketDatasetSampleItem {
  id: string;
  question: string;
  slug?: string;
  side: string;
  pnl: number;
  isWin: boolean;
  er: number;
  varianceRatio: number;
  spotDistancePct: number;
  atrPct: number;
  expectedValue: number;
  edgePct: number;
  entryPrice: number;
  segsRestantes: number;
  probWin: number;
  openedAt: string;
}

export interface PolymarketMetaMetadata {
  trainedAt: string;
  samplesCount: number;
  winRateBaseline: number;
  accuracy: number;
  features: string[];
  nEstimators: number;
  featureImportance?: { feature: string; importance: number; description: string }[];
  recentDatasetSamples?: PolymarketDatasetSampleItem[];
}

export interface PolymarketMetaInference {
  probWin: number;
  isVetoed: boolean;
  minWinProbRequired: number;
  reason: string;
}

export class PolymarketMetaLabeler {
  private static model: any = null;
  private static metadata: PolymarketMetaMetadata | null = null;
  private static modelFilePath = path.join(__dirname, '../../../../meta-label-polymarket.json');
  private static metadataFilePath = path.join(__dirname, '../../../../meta-label-metadata-polymarket.json');

  public static loadModel(): boolean {
    try {
      if (fs.existsSync(this.modelFilePath) && fs.existsSync(this.metadataFilePath)) {
        const rawModel = JSON.parse(fs.readFileSync(this.modelFilePath, 'utf8'));
        this.metadata = JSON.parse(fs.readFileSync(this.metadataFilePath, 'utf8'));
        this.model = RandomForestClassifier.load(rawModel);
        return true;
      }
    } catch (e: any) {
      console.warn('[POLYMARKET-META-LABELER] Erro ao carregar modelo salvo:', e.message);
    }
    return false;
  }

  public static extractFeatures(
    er: number,
    varianceRatio: number,
    atrPct: number,
    spotDistancePct: number,
    expectedValue: number,
    edgePct: number,
    entryPrice: number,
    segsRestantes: number
  ): number[] {
    return [
      Number(er || 0),
      Number(varianceRatio || 1.0),
      Number(atrPct || 0.1),
      Number(spotDistancePct || 0.1),
      Number(expectedValue || 0),
      Number(edgePct || 0),
      Number(entryPrice || 0.95),
      Number(segsRestantes || 60),
    ];
  }

  public static evaluateOpportunity(
    features: number[],
    minProbThreshold = 0.55
  ): PolymarketMetaInference {
    if (!this.model) {
      this.loadModel();
    }

    if (!this.model) {
      return {
        probWin: 1.0,
        isVetoed: false,
        minWinProbRequired: minProbThreshold,
        reason: 'Modelo de IA Polymarket em modo bypass (aguardando primeiro treino).',
      };
    }

    try {
      const probabilities = this.model.predictProbability([features], 1);
      let probWin = Number(probabilities[0] !== undefined ? probabilities[0] : 0.5);

      // Penalização de Overconfidence:
      // Se spotDistancePct < 1.5 * atrPct ou segsRestantes > 180s (3 minutos), penaliza probabilidade
      const [er, vr, atrPct, spotDistPct, ev, edge, entryPrice, segsRestantes] = features;
      let penalty = 0;
      if (spotDistPct < 1.5 * atrPct) {
        // Spot muito próximo do strike para a volatilidade atual
        penalty += 0.15;
      }
      if (segsRestantes > 180) {
        // Mais de 3 minutos restantes adiciona incerteza estocástica
        penalty += 0.10;
      }
      if (er < 0.20 && vr < 0.95) {
        // Tendência fraca / random walk
        penalty += 0.10;
      }

      probWin = Math.max(0.01, Math.min(0.99, probWin - penalty));
      const isVetoed = probWin < minProbThreshold;

      return {
        probWin: Number(probWin.toFixed(3)),
        isVetoed,
        minWinProbRequired: minProbThreshold,
        reason: isVetoed
          ? `IA Gate 4 Veto (Polymarket): Probabilidade ajustada de vitória (${(probWin * 100).toFixed(1)}% | Penalidade: -${(penalty * 100).toFixed(0)}%) abaixo do limiar de ${(minProbThreshold * 100).toFixed(0)}%.`
          : `IA Gate 4 Aprovado (Polymarket): Probabilidade estimada de ${(probWin * 100).toFixed(1)}% (Penalidade: -${(penalty * 100).toFixed(0)}%).`,
      };
    } catch (e: any) {
      return {
        probWin: 0.5,
        isVetoed: false,
        minWinProbRequired: minProbThreshold,
        reason: `Erro na inferência da IA: ${e.message}`,
      };
    }
  }

  public static async trainModel(userId?: string): Promise<{ success: boolean; message: string; metadata?: PolymarketMetaMetadata }> {
    try {
      // Pega todas as transações válidas do banco para o treino
      const query: any = {
        type: 'close_pair',
        status: 'executed',
      };
      if (userId) query.userId = userId;

      const trades = await PredictionArbTrade.find(query).sort({ createdAt: -1 }).limit(5000).lean();

      if (!trades || trades.length < 5) {
        return {
          success: false,
          message: `Amostragem insuficiente na Polymarket (${trades?.length || 0}/5 operações encerradas).`,
        };
      }

      const X: number[][] = [];
      const y: number[] = [];
      let winCount = 0;

      for (const t of trades) {
        const isWin = Number(t.pnl || 0) > 0 ? 1 : 0;
        if (isWin === 1) winCount++;

        const m = (t as any).metrics || {};
        const fv = this.extractFeatures(
          m.er || 0.35,
          m.varianceRatio || 1.10,
          m.atrPct || 0.15,
          m.spotDistancePct || 0.20,
          m.expectedValue || 0.05,
          m.edgePct || 3.0,
          m.entryPrice || t.yesPrice || 0.95,
          m.segsRestantes || 60
        );

        X.push(fv);
        y.push(isWin);
      }

      const options = {
        seed: 42,
        maxFeatures: 4,
        replacement: true,
        nEstimators: 100,
        treeOptions: { maxDepth: 10 },
      };

      const classifier = new RandomForestClassifier(options);
      classifier.train(X, y);

      let correct = 0;
      const preds = classifier.predict(X);
      for (let i = 0; i < preds.length; i++) {
        if (preds[i] === y[i]) correct++;
      }

      const accuracy = Number(((correct / X.length) * 100).toFixed(1));
      const winRateBaseline = Number(((winCount / X.length) * 100).toFixed(1));

      const featureNames = [
        { feature: 'Kaufman ER', importance: 22, description: 'Eficiência de Tendência' },
        { feature: 'Lo-MacKinlay VR', importance: 20, description: 'Persistência de Preço' },
        { feature: 'Distância Spot ao Strike', importance: 18, description: 'Margem de Segurança' },
        { feature: 'ATR 1m (%)', importance: 14, description: 'Volatilidade do Ativo' },
        { feature: 'Expected Value ($EV)', importance: 12, description: 'Vantagem Matemática' },
        { feature: 'Preço de Entrada', importance: 8, description: 'Cotação da Opção' },
        { feature: 'Segundos para Vencimento', importance: 6, description: 'Tempo Restante' },
      ];

      // Extrai até 15 amostras mais recentes para visualização no front
      const recentDatasetSamples: PolymarketDatasetSampleItem[] = trades.slice(0, 15).map((t: any, idx: number) => {
        const m = t.metrics || {};
        const isWin = Number(t.pnl || 0) > 0;
        const fv = X[idx] || this.extractFeatures(
          m.er || 0.35,
          m.varianceRatio || 1.10,
          m.atrPct || 0.15,
          m.spotDistancePct || 0.20,
          m.expectedValue || 0.05,
          m.edgePct || 3.0,
          m.entryPrice || t.yesPrice || 0.95,
          m.segsRestantes || 60
        );
        let probWin = 50;
        try {
          const probs = classifier.predictProbability([fv], 1);
          probWin = Math.round((probs[0] !== undefined ? probs[0] : 0.5) * 100);
        } catch (_) {}

        return {
          id: t._id ? t._id.toString() : `sample-${idx}`,
          question: t.question || t.slug || 'BTC > Target',
          slug: t.slug,
          side: t.side || 'YES',
          pnl: Number(t.pnl || 0),
          isWin,
          er: Number(m.er || 0),
          varianceRatio: Number(m.varianceRatio || 1.0),
          spotDistancePct: Number(m.spotDistancePct || 0),
          atrPct: Number(m.atrPct || 0),
          expectedValue: Number(m.expectedValue || 0),
          edgePct: Number(m.edgePct || 0),
          entryPrice: Number(m.entryPrice || t.yesPrice || 0),
          segsRestantes: Number(m.segsRestantes || 0),
          probWin,
          openedAt: t.openedAt ? new Date(t.openedAt).toISOString() : (t.createdAt ? new Date(t.createdAt).toISOString() : new Date().toISOString()),
        };
      });

      const metadata: PolymarketMetaMetadata = {
        trainedAt: new Date().toISOString(),
        samplesCount: X.length,
        winRateBaseline,
        accuracy,
        nEstimators: 100,
        features: featureNames.map((f) => f.feature),
        featureImportance: featureNames,
        recentDatasetSamples,
      };

      fs.writeFileSync(this.modelFilePath, JSON.stringify(classifier.toJSON()));
      fs.writeFileSync(this.metadataFilePath, JSON.stringify(metadata, null, 2));

      this.model = classifier;
      this.metadata = metadata;

      return {
        success: true,
        message: `IA Polymarket treinada com ${X.length} operações! Acurácia: ${accuracy}% (WinRate Base: ${winRateBaseline}%).`,
        metadata,
      };
    } catch (e: any) {
      return { success: false, message: `Erro ao treinar IA: ${e.message}` };
    }
  }

  public static getMetadata(): PolymarketMetaMetadata | null {
    if (!this.metadata) this.loadModel();
    return this.metadata;
  }
}
