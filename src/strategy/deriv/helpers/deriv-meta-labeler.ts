// Módulo de Meta-Labeling com Random Forest (López de Prado) para o Robô Deriv
// IA Treinada para prever P(Win | Condições de Mercado) no Gate 4

import fs from 'fs';
import path from 'path';
// @ts-ignore
import { RandomForestClassifier } from 'ml-random-forest';
import DerivTrade from '../../../models/DerivTrade';

export interface MetaModelMetadata {
  trainedAt: string;
  samplesCount: number;
  winRateBaseline: number;
  accuracy: number;
  features: string[];
  nEstimators: number;
}

export interface MetaLabelInference {
  probWin: number;
  isVetoed: boolean;
  minWinProbRequired: number;
  reason: string;
}

export class DerivMetaLabeler {
  private static model: any = null;
  private static metadata: MetaModelMetadata | null = null;
  private static modelFilePath = path.join(__dirname, '../../../../meta-label-deriv.json');
  private static metadataFilePath = path.join(__dirname, '../../../../meta-label-metadata.json');

  /**
   * Carrega o modelo treinado do disco
   */
  public static loadModel(): boolean {
    try {
      if (fs.existsSync(this.modelFilePath) && fs.existsSync(this.metadataFilePath)) {
        const rawModel = JSON.parse(fs.readFileSync(this.modelFilePath, 'utf8'));
        this.metadata = JSON.parse(fs.readFileSync(this.metadataFilePath, 'utf8'));
        this.model = RandomForestClassifier.load(rawModel);
        return true;
      }
    } catch (e: any) {
      console.warn('[META-LABELER] Erro ao carregar modelo salvo:', e.message);
    }
    return false;
  }

  /**
   * Extrai vetor de features a partir dos indicadores
   */
  public static extractFeatures(
    er: number,
    r2: number,
    slope: number,
    imbalance: number,
    varianceRatio: number,
    tickVolatility: number,
    payoutRatio: number,
    hourUtc?: number
  ): number[] {
    const hour = hourUtc !== undefined ? hourUtc : new Date().getUTCHours();
    return [
      Number(er || 0),
      Number(r2 || 0),
      Number(slope || 0),
      Number(imbalance || 0),
      Number(varianceRatio || 1.0),
      Number(tickVolatility || 0.01),
      Number(payoutRatio || 0.50),
      Number(hour)
    ];
  }

  /**
   * Avalia uma oportunidade pelo Gate 4 (Meta-Labeling)
   */
  public static evaluateOpportunity(
    features: number[],
    minProbThreshold = 0.55
  ): MetaLabelInference {
    if (!this.model) {
      this.loadModel();
    }

    if (!this.model) {
      return {
        probWin: 1.0,
        isVetoed: false,
        minWinProbRequired: minProbThreshold,
        reason: 'Modelo de IA ainda não treinado (Gate 4 em modo bypass).'
      };
    }

    try {
      // Previsão de probabilidades para as classes [0 (Loss), 1 (Win)]
      const probabilities = this.model.predictProbability([features], 1);
      const probWin = Number(probabilities[0] !== undefined ? probabilities[0] : 0.5);
      const isVetoed = probWin < minProbThreshold;

      return {
        probWin: Number(probWin.toFixed(3)),
        isVetoed,
        minWinProbRequired: minProbThreshold,
        reason: isVetoed
          ? `IA Veto: Probabilidade estimada de sucesso (${(probWin * 100).toFixed(1)}%) abaixo do limiar de ${(minProbThreshold * 100).toFixed(0)}%.`
          : `IA Aprovado: Probabilidade de vitória de ${(probWin * 100).toFixed(1)}%.`
      };
    } catch (e: any) {
      return {
        probWin: 0.5,
        isVetoed: false,
        minWinProbRequired: minProbThreshold,
        reason: `Erro na inferência da IA: ${e.message}`
      };
    }
  }

  /**
   * Treina a Random Forest com a base de dados histórica do MongoDB
   */
  public static async trainModel(userId?: string): Promise<{ success: boolean; message: string; metadata?: MetaModelMetadata }> {
    try {
      const query: any = { status: 'executed' };
      if (userId) query.userId = userId;

      const trades = await DerivTrade.find(query).sort({ closedAt: -1 }).limit(5000).lean();

      if (!trades || trades.length < 15) {
        return {
          success: false,
          message: `Amostragem insuficiente no banco (${trades?.length || 0}/15 operações necessárias). Realize mais operações para treinar a IA.`
        };
      }

      const X: number[][] = [];
      const y: number[] = [];
      let winCount = 0;

      for (const t of trades) {
        const isWin = Number(t.pnl || 0) > 0 ? 1 : 0;
        if (isWin === 1) winCount++;

        const openedHour = t.openedAt ? new Date(t.openedAt).getUTCHours() : 12;
        const m = t.metrics || {};

        const featureVector = this.extractFeatures(
          m.er || 0.35,
          m.r2 || 0.40,
          m.slope || 0.001,
          m.imbalance || 0.5,
          m.varianceRatio || 1.10,
          m.tickVolatility || 0.05,
          m.payoutRatio || 0.55,
          openedHour
        );

        X.push(featureVector);
        y.push(isWin);
      }

      const options = {
        seed: 42,
        maxFeatures: 4,
        replacement: true,
        nEstimators: 100,
        treeOptions: {
          maxDepth: 10
        }
      };

      const classifier = new RandomForestClassifier(options);
      classifier.train(X, y);

      // Avaliação de Acurácia In-Sample
      let correct = 0;
      const preds = classifier.predict(X);
      for (let i = 0; i < preds.length; i++) {
        if (preds[i] === y[i]) correct++;
      }
      const accuracy = Number(((correct / X.length) * 100).toFixed(1));
      const winRateBaseline = Number(((winCount / X.length) * 100).toFixed(1));

      const metadata: MetaModelMetadata = {
        trainedAt: new Date().toISOString(),
        samplesCount: X.length,
        winRateBaseline,
        accuracy,
        nEstimators: 100,
        features: [
          'Kaufman ER',
          'OLS R²',
          'OLS Slope',
          'Tick Imbalance',
          'Variance Ratio (Lo-MacKinlay)',
          'Tick Volatility (σ)',
          'Payout Ratio (R)',
          'UTC Hour of Day'
        ]
      };

      // Salva em disco
      const jsonModel = classifier.toJSON();
      fs.writeFileSync(this.modelFilePath, JSON.stringify(jsonModel));
      fs.writeFileSync(this.metadataFilePath, JSON.stringify(metadata, null, 2));

      this.model = classifier;
      this.metadata = metadata;

      return {
        success: true,
        message: `Modelo de IA treinado com sucesso com ${X.length} operações! Acurácia: ${accuracy}% (WinRate Histórico: ${winRateBaseline}%).`,
        metadata
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Erro ao treinar modelo: ${err.message}`
      };
    }
  }

  public static getMetadata(): MetaModelMetadata | null {
    if (!this.metadata) this.loadModel();
    return this.metadata;
  }
}
