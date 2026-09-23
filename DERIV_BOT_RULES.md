# Regras e Arquitetura Operacional do Robô Deriv (Modelo Quantitativo Institucional)

## 1. Visão Geral
O robô opera de forma quantitativa e automatizada na API da **Deriv**, analisando séries temporais de ticks em tempo real. A arquitetura adota um **Pipeline de Decisão em 3 Gates Ortogonais**, **Asset Rotation (Roteamento Dinâmico de Liquidez)**, **Filtro CUSUM**, **Teste de Razão de Variância (Lo-MacKinlay)**, **Otimizador Dinâmico de Barreira**, **Gestão Rigorosa de EV & Kelly** e **Gravação de Telemetria/Snapshot de Métricas no Banco de Dados**.

Contratos suportados:
- **Higher / Lower (Com Barreira Dinâmica Otimizada)**: Índices sintéticos (`1HZ75V`, `1HZ25V`, `1HZ50V`, `1HZ10V`, `1HZ100V`), duração padrão de **15 segundos**.
- **Multipliers (MULTUP / MULTDOWN)**: Criptoativos (`cryBTCUSD`), duração padrão de **120 segundos**.

---

## 2. Roteamento Dinâmico de Liquidez (Asset Rotation)

Em vez de fixar o capital em um único índice sintético, o robô monitora todos os ativos configurados simultaneamente a cada ciclo:
1. **Coleta de Ticks**: Consulta o fluxo recente de todos os índices candidatos.
2. **Cálculo do Regime Score**:
   $$\text{Regime Score} = (0.50 \times ER) + (0.50 \times R^2)$$
3. **Classificação & Priorização**: Ordena todos os ativos pelo Regime Score e direciona o capital **exclusivamente para o ativo que apresentar a tendência mais limpa e previsível** naquele segundo.

---

## 3. Pipeline de 3 Gates Ortogonais & Filtros Estruturais

```
[Fluxo Multi-Ativos em Tempo Real]
                │
                ▼
┌────────────────────────────────────────────────────────┐
│ 1. Gatekeeper Estrutural & Regime                      │ ──(Falha / Anomalia)──► [Quarentena / Descarte]
│    • Spike Filter (Salto <= 3σ)                        │
│    • CUSUM Anomaly Check (Sem quebra de fase)          │
│    • Lo-MacKinlay Variance Ratio (VR >= 1.08)          │
│    • Kaufman ER >= 0.28 + OLS R² >= 0.35               │
└────────────────────────────────────────────────────────┘
                │ (Aprovado: Regime Persistente e Estável)
                ▼
┌────────────────────────────────────────────────────────┐
│ 2. Vetor Direcional (Macro)                            │ ──(Determina Lado: CALL / PUT)
│    EMA 9/21 + Inclinação OLS (Slope)                   │
└────────────────────────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────────┐
│ 3. Gatilho de Micro-Timing (Imbalance)                 │ ──(Score de Entrada: 0.0 a 1.0)
│    Tick Imbalance (últimos 10 ticks)                   │
└────────────────────────────────────────────────────────┘
```

### Detalhamento dos Filtros do Gatekeeper:
- **Filtro CUSUM (Cumulative Sum)**: Detecta viradas bruscas no algoritmo da Deriv. Se a soma acumulada de desvios ultrapassar o limiar $h = 4.5\sigma$, o ativo entra em **Quarentena Preventiva de 5 minutos (300s)**.
- **Teste de Razão de Variância (Lo-MacKinlay com $q = 10$)**:
  $$VR = \frac{\text{Var}(r_{10})}{10 \times \text{Var}(r_1)}$$
  - Se $VR < 1.08$: O mercado é classificado como **Random Walk Puro (Passeio Aleatório / Cassino)** e o robô rejeita a operação.
  - Se $VR \ge 1.08$: Mercado com persistência direcional comprovada (Efeito Manada).
- **Filtro de Spike (Cauda Gorda)**: Rejeita se o salto do último tick for superior a $3 \times \sigma_{\text{tick}}$.
- **Gatekeeper Clássico**: $ER \ge 0.28$ e $R^2 \ge 0.35$.

---

## 4. Confiança Calibrada

$$\text{Confiança} = (0.35 \times \text{Norm}(ER)) + (0.35 \times R^2) + (0.30 \times \vert{}\text{Tick Imbalance}\vert{})$$

- $\text{Norm}(ER) = \min(1.0, \frac{ER}{0.60})$
- **Gatilho de Execução**: $\text{Confiança} \ge 0.72$.

---

## 5. Otimizador de Barreira, Validação de $EV$ e Kelly Blindado

### 5.1. Offset Dinâmico de Barreira
$$\sigma_{15\text{s}} = \sigma_{\text{tick}} \times \sqrt{15}$$
$$\text{Offset Alvo } (\Delta) = \pm (0.30 \times \sigma_{15\text{s}})$$

### 5.2. Critério de Expectativa Matemática ($EV > 0$)
1. **Faixa Sweet Spot**: $40\% \le R \le 85\%$.
2. **Edge Matemático**: $\text{Edge} = P_{\text{modelo}} - P_{\text{Deriv}} \ge \text{Edge Mínimo}$ (Base: $4\%$).
3. **Valor Esperado**: $EV = (P_{\text{modelo}} \times R) - (1 - P_{\text{modelo}}) > 0$.

### 5.3. Dimensionamento com Hard Cap de Kelly
$$f^* = \frac{P_{\text{modelo}} \times (R + 1) - 1}{R}$$
$$\text{Stake Final} = \min(\text{Base Stake} \times (1 + 0.25 \times f^*), \, \text{Base Stake} \times 1.5)$$

### 5.4. Tolerância a Slippage e Compensação de Latência
- Compara preço real executado com o cotado no `proposal`.
- Se 3 derrapagens consecutivas corromperem o $EV$ para $\le 0$, eleva o Edge Mínimo de $4\%$ para $6\%$.

---

## 6. Telemetria e Snapshot de Auditoria no Banco de Dados

A cada trade disparado, o robô salva um snapshot completo no documento `DerivTrade`:
- `metrics.er`: Eficiência de Kaufman no instante do sinal.
- `metrics.r2`: Coeficiente de Determinação da Regressão Linear.
- `metrics.slope`: Inclinação do vetor de tendência.
- `metrics.imbalance`: Desequilíbrio do micro fluxo de ticks.
- `metrics.varianceRatio`: Razão de Variância (Lo-MacKinlay).
- `metrics.regimeScore`: Score de seleção no Asset Rotation.
- `metrics.tickVolatility`: Desvio padrão ($\sigma_{\text{tick}}$).
- `metrics.modelConfidence`: Confiança calculada pelo modelo.
- `metrics.expectedValue`: Valor Esperado ($EV$) líquido.
- `metrics.edge`: Vantagem sobre a probabilidade implícita do broker.
- `metrics.payoutRatio`: Retorno líquido $R$ da proposta.
- `metrics.brokerProb`: Probabilidade implícita da Deriv ($\text{Ask} / \text{Payout}$).
- `metrics.barrier`: Offset e barreira utilizada.
- `metrics.spotPrice`: Preço exato do ativo no instante da entrada.

---

## 7. Gestão de Risco e Resfriamento

- **Quarentena CUSUM**: 5 minutos de bloqueio preventivo no ativo se houver quebra estrutural.
- **Cooldown Pós-Loss**: Pausa de 180 segundos no ativo após operação perdedora.
- **Sequência de Perdas (Anti-Martingale)**:
  - 2 perdas seguidas: Stake reduzido para $50\%$.
  - 3 ou mais perdas: Stake reduzido para $25\%$ e pausa global de 180s.
  - 1 vitória: Restaura $100\%$ do stake nominal.
- **Stop Diário de Perda (`maxDailyLoss`)**: Interrompe o robô no dia caso atinja o limite.
