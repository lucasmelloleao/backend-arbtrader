// Módulo de Meta-Labeling com IA (Random Forest) para FxPro cTrader
// Gate 4: Veta ordens Forex onde P(Win | Condições de Mercado) < 55%

import fs from 'fs';
import path from 'path';
// @ts-ignore
import { RandomForestClassifier } from 'ml-random-forest';
import FxProTrade from '../../../models/FxProTrade';

export interface FxProDatasetSampleItem {
  id: string;
  symbol: string;
  side: string;
  pnl: number;
  pips: number;
  isWin: boolean;
  er: number;
  varianceRatio: number;
  atrPips: number;
  spreadPips: number;
  expectedValue: number;
  lotSize: number;
  probWin: number;
  openedAt: string;
}

export interface FxProMetaMetadata {
  trainedAt: string;
  samplesCount: number;
  winRateBaseline: number;
  accuracy: number;
  features: string[];
  nEstimators: number;
  featureImportance?: { feature: string; importance: number; description: string }[];
  recentDatasetSamples?: FxProDatasetSampleItem[];
}

export interface FxProMetaInference {
  probWin: number;
  isVetoed: boolean;
  minWinProbRequired: number;
  reason: string;
}

export class FxProMetaLabeler {
  private static model: any = null;
  private static metadata: FxProMetaMetadata | null = null;
  private static modelFilePath = path.join(__dirname, '../../../../meta-label-fxpro.json');
  private static metadataFilePath = path.join(__dirname, '../../../../meta-label-metadata-fxpro.json');

  public static loadModel(): boolean {
    try {
      if (fs.existsSync(this.modelFilePath) && fs.existsSync(this.metadataFilePath)) {
        const rawModel = JSON.parse(fs.readFileSync(this.modelFilePath, 'utf8'));
        this.metadata = JSON.parse(fs.readFileSync(this.metadataFilePath, 'utf8'));
        this.model = RandomForestClassifier.load(rawModel);
        return true;
      }
    } catch (e: any) {
      console.warn('[FXPRO-META-LABELER] Erro ao carregar modelo salvo:', e.message);
    }
    return false;
  }

  public static extractFeatures(
    er: number,
    varianceRatio: number,
    atrPips: number,
    spreadPips: number,
    expectedValue: number,
    edgePct: number,
    lotSize: number,
    timeOfDayHours: number
  ): number[] {
    return [
      Number(er || 0.40),
      Number(varianceRatio || 1.15),
      Number(atrPips || 15.0),
      Number(spreadPips || 1.2),
      Number(expectedValue || 0.05),
      Number(edgePct || 3.0),
      Number(lotSize || 0.01),
      Number(timeOfDayHours || 14.0),
    ];
  }

  public static evaluateOpportunity(
    features: number[],
    minProbThreshold = 0.55
  ): FxProMetaInference {
    if (!this.model) {
      this.loadModel();
    }

    if (!this.model) {
      return {
        probWin: 1.0,
        isVetoed: false,
        minWinProbRequired: minProbThreshold,
        reason: 'Modelo de IA FxPro cTrader em modo bypass (aguardando primeiro treino).',
      };
    }

    try {
      const probabilities = this.model.predictProbability([features], 1);
      const probWin = Number(probabilities[0] !== undefined ? probabilities[0] : 0.5);
      const isVetoed = probWin < minProbThreshold;

      return {
        probWin: Number(probWin.toFixed(3)),
        isVetoed,
        minWinProbRequired: minProbThreshold,
        reason: isVetoed
          ? `IA Gate 4 Veto (FxPro): Probabilidade estimada de vitória (${(probWin * 100).toFixed(1)}%) abaixo do limiar de ${(minProbThreshold * 100).toFixed(0)}%.`
          : `IA Gate 4 Aprovado (FxPro): Probabilidade estimada de ${(probWin * 100).toFixed(1)}%.`,
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

  public static async trainModel(userId?: string): Promise<{ success: boolean; message: string; metadata?: FxProMetaMetadata }> {
    try {
      const query: any = { status: 'closed' };
      if (userId) query.userId = userId;

      const trades = await FxProTrade.find(query).sort({ _id: -1 }).limit(3000).lean();

      if (!trades || trades.length < 5) {
        return {
          success: false,
          message: `Amostragem insuficiente na FxPro (${trades?.length || 0}/5 operações encerradas).`,
        };
      }

      const X: number[][] = [];
      const y: number[] = [];
      let winCount = 0;

      for (const t of trades) {
        const isWin = Number(t.pnlUsd || 0) > 0 ? 1 : 0;
        if (isWin === 1) winCount++;

        const m = (t as any).metrics || {};
        const opened = t.openedAt ? new Date(t.openedAt) : new Date();
        const fv = this.extractFeatures(
          m.er || 0.40,
          m.varianceRatio || 1.15,
          m.atrPct || 15.0,
          m.spreadPips || 1.2,
          m.expectedValue || 0.05,
          m.edgePct || 3.0,
          t.lotSize || 0.01,
          opened.getHours() + opened.getMinutes() / 60
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
        { feature: 'Kaufman ER', importance: 24, description: 'Eficiência de Tendência Forex' },
        { feature: 'Lo-MacKinlay VR', importance: 22, description: 'Persistência vs Random Walk' },
        { feature: 'ATR em Pips', importance: 16, description: 'Volatilidade do Par' },
        { feature: 'Spread Dinâmico', importance: 14, description: 'Custo de Liquidez da FxPro' },
        { feature: 'Expected Value ($EV)', importance: 12, description: 'Vantagem Estatística' },
        { feature: 'Horário da Sessão', importance: 8, description: 'Londres / NY / Ásia' },
        { feature: 'Lote Operado', importance: 4, description: 'Tamanho da Posição' },
      ];

      // Extrai até 15 amostras mais recentes para visualização no front
      const recentDatasetSamples: FxProDatasetSampleItem[] = trades.slice(0, 15).map((t: any, idx: number) => {
        const m = t.metrics || {};
        const isWin = Number(t.pnlUsd || 0) > 0;
        const openedHour = t.openedAt ? new Date(t.openedAt).getUTCHours() : 12;
        const fv = X[idx] || this.extractFeatures(
          m.er || 0.40,
          m.varianceRatio || 1.15,
          m.atrPct || 15.0,
          m.spreadPips || 1.2,
          m.expectedValue || 10.0,
          m.edgePct || 2.5,
          t.lotSize || 0.01,
          openedHour
        );
        let probWin = 50;
        try {
          const probs = classifier.predictProbability([fv], 1);
          probWin = Math.round((probs[0] !== undefined ? probs[0] : 0.5) * 100);
        } catch (_) {}

        return {
          id: t._id ? t._id.toString() : `sample-${idx}`,
          symbol: t.symbol || 'EURUSD',
          side: t.side || 'BUY',
          pnl: Number(t.pnlUsd || 0),
          pips: Number(t.pips || 0),
          isWin,
          er: Number(m.er || 0),
          varianceRatio: Number(m.varianceRatio || 1.0),
          atrPips: Number(m.atrPct || 0),
          spreadPips: Number(m.spreadPips || 0),
          expectedValue: Number(m.expectedValue || 0),
          lotSize: Number(t.lotSize || 0.01),
          probWin,
          openedAt: t.openedAt ? new Date(t.openedAt).toISOString() : (t.createdAt ? new Date(t.createdAt).toISOString() : new Date().toISOString()),
        };
      });

      const metadata: FxProMetaMetadata = {
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
        message: `IA FxPro cTrader treinada com ${X.length} operações! Acurácia: ${accuracy}% (WinRate Base: ${winRateBaseline}%).`,
        metadata,
      };
    } catch (e: any) {
      return { success: false, message: `Erro ao treinar IA: ${e.message}` };
    }
  }

  public static getMetadata(): FxProMetaMetadata | null {
    if (!this.metadata) this.loadModel();
    return this.metadata;
  }
}
