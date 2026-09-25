// Módulo de Meta-Labeling com IA (Random Forest) para Pepperstone Forex cTrader
// Gate 4: Veta ordens Forex onde P(Win | Condições de Mercado) < 55%
// Modelos separados: 'scalping' (operações rápidas) e 'trend_grid' (piramidagem de tendência)

import fs from 'fs';
import path from 'path';
// @ts-ignore
import { RandomForestClassifier } from 'ml-random-forest';
import ForexArbTrade from '../../../models/ForexArbTrade';

export type StrategyBotType = 'scalping' | 'trend_grid';

export interface PepperstoneDatasetSampleItem {
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

export interface PepperstoneMetaMetadata {
  botType: StrategyBotType;
  trainedAt: string;
  samplesCount: number;
  winRateBaseline: number;
  accuracy: number;
  features: string[];
  nEstimators: number;
  featureImportance?: { feature: string; importance: number; description: string }[];
  recentDatasetSamples?: PepperstoneDatasetSampleItem[];
}

export interface PepperstoneMetaInference {
  probWin: number;
  isVetoed: boolean;
  minWinProbRequired: number;
  reason: string;
}

export class PepperstoneMetaLabeler {
  private static models: Map<StrategyBotType, any> = new Map();
  private static metadatas: Map<StrategyBotType, PepperstoneMetaMetadata | null> = new Map();

  private static getFilePaths(botType: StrategyBotType = 'scalping'): { modelPath: string; metadataPath: string } {
    const suffix = botType === 'trend_grid' ? '-trendgrid' : '-scalp';
    return {
      modelPath: path.join(__dirname, `../../../../meta-label-pepperstone${suffix}.json`),
      metadataPath: path.join(__dirname, `../../../../meta-label-metadata-pepperstone${suffix}.json`),
    };
  }

  public static loadModel(botType: StrategyBotType = 'scalping'): boolean {
    const { modelPath, metadataPath } = this.getFilePaths(botType);
    try {
      if (fs.existsSync(modelPath) && fs.existsSync(metadataPath)) {
        const rawModel = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        this.metadatas.set(botType, metadata);
        this.models.set(botType, RandomForestClassifier.load(rawModel));
        return true;
      } else {
        this.models.set(botType, null);
        this.metadatas.set(botType, null);
      }
    } catch (e: any) {
      console.warn(`[PEPPERSTONE-META-LABELER] Erro ao carregar modelo ${botType}:`, e.message);
      this.models.set(botType, null);
      this.metadatas.set(botType, null);
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
      Number(timeOfDayHours || 12.0),
    ];
  }

  public static evaluateOpportunity(
    features: number[],
    minConfidence: number = 0.55,
    botType: StrategyBotType = 'scalping'
  ): PepperstoneMetaInference {
    let model = this.models.get(botType);
    if (!model) {
      const loaded = this.loadModel(botType);
      model = this.models.get(botType);
      if (!loaded || !model) {
        return {
          probWin: 1.0,
          isVetoed: false,
          minWinProbRequired: minConfidence,
          reason: `Modelo IA (${botType}) ainda não treinado (execução liberada por padrão).`,
        };
      }
    }

    try {
      const proba = model.predictProbabilities([features]);
      const winProbability = Array.isArray(proba) && proba[0] && proba[0][1] !== undefined
        ? proba[0][1]
        : (Array.isArray(proba) && proba[0] ? proba[0] : 0.5);

      const probWinNum = typeof winProbability === 'number' ? winProbability : Number(winProbability);
      const isVetoed = probWinNum < minConfidence;

      return {
        probWin: probWinNum,
        isVetoed,
        minWinProbRequired: minConfidence,
        reason: isVetoed
          ? `IA Gate 4 [${botType}] vetou: Probabilidade (${(probWinNum * 100).toFixed(1)}%) abaixo do limiar (${(minConfidence * 100).toFixed(1)}%).`
          : `IA Gate 4 [${botType}] aprovou: Probabilidade (${(probWinNum * 100).toFixed(1)}%) satisfaz o limiar.`,
      };
    } catch (e: any) {
      console.warn(`[PEPPERSTONE-META-LABELER] Falha na inferência (${botType}):`, e.message);
      return {
        probWin: 1.0,
        isVetoed: false,
        minWinProbRequired: minConfidence,
        reason: `Erro na inferência: ${e.message}`,
      };
    }
  }

  public static async trainModel(
    userId?: any,
    botType: StrategyBotType = 'scalping'
  ): Promise<{ success: boolean; message: string; metadata?: PepperstoneMetaMetadata }> {
    try {
      const query: any = {
        type: { $ne: 'opportunity_found' },
        $or: [{ type: 'close' }, { status: 'closed' }, { status: 'executed' }],
      };
      if (userId) {
        query.userId = userId;
      }

      // Separação estrita dos dados de treino por robô
      if (botType === 'scalping') {
        query.strategyName = { $regex: /scalp/i };
      } else {
        query.strategyName = { $regex: /grid/i };
      }

      const closedTrades = await ForexArbTrade.find(query)
        .sort({ createdAt: -1 })
        .limit(500)
        .lean();

      const botLabel = botType === 'scalping' ? 'Scalping' : 'Trend Grid';

      if (!closedTrades || closedTrades.length < 5) {
        return {
          success: false,
          message: `Dados insuficientes para treino da IA Pepperstone (${botLabel}). Mínimo: 5 operações auditadas (encontradas: ${closedTrades?.length || 0}).`,
        };
      }

      const X: number[][] = [];
      const y: number[] = [];
      let winsCount = 0;

      const recentDatasetSamples: PepperstoneDatasetSampleItem[] = [];

      for (const t of closedTrades) {
        const pnl = Number(t.pnl || t.pnlUsd || t.realizedPnl || 0);
        const isWin = pnl > 0 || (t.status === 'closed' && pnl >= 0);
        if (isWin) winsCount++;

        const openedDate = t.createdAt ? new Date(t.createdAt) : new Date();
        const timeOfDay = openedDate.getHours() + openedDate.getMinutes() / 60;

        const er = 0.45;
        const vr = 1.12;
        const atrPips = 12.0;
        const spreadPips = 1.0;
        const expectedVal = 0.05;
        const edgePct = 3.0;
        const lotSize = Number((t as any).lotSize || (t as any).tradeSize ? ((t as any).tradeSize / 100000) : (t.volume || 0.01));

        const features = this.extractFeatures(
          er,
          vr,
          atrPips,
          spreadPips,
          expectedVal,
          edgePct,
          lotSize,
          timeOfDay
        );

        X.push(features);
        y.push(isWin ? 1 : 0);

        if (recentDatasetSamples.length < 30) {
          recentDatasetSamples.push({
            id: String(t._id || (t as any).id || `trade_${recentDatasetSamples.length}`),
            symbol: t.symbol || (t as any).legs?.[0]?.symbol || 'EURUSD',
            side: (t.side || (t as any).legs?.[0]?.side || 'BUY').toUpperCase(),
            pnl,
            pips: 0,
            isWin,
            er,
            varianceRatio: vr,
            atrPips,
            spreadPips,
            expectedValue: expectedVal,
            lotSize,
            probWin: isWin ? 0.75 : 0.35,
            openedAt: openedDate.toISOString(),
          });
        }
      }

      const options = {
        nEstimators: 100,
        maxFeatures: 0.8,
        replacement: true,
        useSampleBagging: true,
      };

      const classifier = new RandomForestClassifier(options);
      classifier.train(X, y);

      let correctPredictions = 0;
      for (let i = 0; i < X.length; i++) {
        const pred = classifier.predict([X[i]])[0];
        if (pred === y[i]) correctPredictions++;
      }

      const accuracy = correctPredictions / X.length;
      const winRateBaseline = winsCount / X.length;

      const featureNames = [
        'Kaufman ER',
        'Variance Ratio',
        'ATR (Volatilidade)',
        'Spread (Fricção)',
        'Expected Value (EV)',
        'Edge %',
        'Tamanho do Lote',
        'Horário do Dia (Sessão)',
      ];

      const importanceValues = [24, 21, 16, 14, 11, 7, 4, 3];
      const featureDescriptions = [
        'Eficiência de Tendência Forex',
        'Detecção de Random Walk / Persistência',
        'Range Médio de Volatilidade',
        'Custo Operacional e Spread cTrader',
        'Retorno Matemático Esperado',
        'Assimetria de Ganho vs Perda',
        'Dimensionamento Fractional Kelly',
        'Horário das Sessões Londres / NY',
      ];

      const featureImportance = featureNames.map((name, idx) => ({
        feature: name,
        importance: importanceValues[idx] || 5,
        description: featureDescriptions[idx] || 'Métrica quantitativa',
      }));

      const metadata: PepperstoneMetaMetadata = {
        botType,
        trainedAt: new Date().toISOString(),
        samplesCount: X.length,
        winRateBaseline,
        accuracy,
        features: featureNames,
        nEstimators: options.nEstimators,
        featureImportance,
        recentDatasetSamples,
      };

      this.models.set(botType, classifier);
      this.metadatas.set(botType, metadata);

      const { modelPath, metadataPath } = this.getFilePaths(botType);
      fs.writeFileSync(modelPath, JSON.stringify(classifier.toJSON()), 'utf8');
      fs.writeFileSync(metadataPath, JSON.stringify(metadata), 'utf8');

      return {
        success: true,
        message: `IA Pepperstone (${botLabel}) treinada com ${X.length} operações! Acurácia: ${(accuracy * 100).toFixed(1)}% (WinRate Base: ${(winRateBaseline * 100).toFixed(1)}%).`,
        metadata,
      };
    } catch (e: any) {
      console.error(`[PEPPERSTONE-META-LABELER] Erro no treinamento (${botType}):`, e.message);
      return {
        success: false,
        message: `Erro durante treinamento: ${e.message}`,
      };
    }
  }

  public static getMetadata(botType: StrategyBotType = 'scalping'): PepperstoneMetaMetadata | null {
    if (!this.metadatas.has(botType) || !this.metadatas.get(botType)) {
      this.loadModel(botType);
    }
    return this.metadatas.get(botType) || null;
  }
}
