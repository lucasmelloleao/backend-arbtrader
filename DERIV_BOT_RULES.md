# Regras e Arquitetura Operacional do Robô Deriv (Modelo Quantitativo Institucional com Meta-Labeling IA)

## 1. Visão Geral
O robô opera de forma quantitativa e automatizada na API da **Deriv**, analisando séries temporais de ticks em tempo real. A arquitetura adota um **Pipeline de Decisão em 4 Gates Ortogonais**, **Asset Rotation (Roteamento Dinâmico de Liquidez)**, **Filtro CUSUM**, **Teste de Razão de Variância (Lo-MacKinlay)**, **Otimizador Dinâmico de Barreira com EV Positivo** e **Meta-Labeling com IA (Random Forest de 100 Árvores no Gate 4)**.

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

## 3. Pipeline de 4 Gates com IA Meta-Labeling

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
                │ (Score >= 0.72 + EV > 0 Validado)
                ▼
┌────────────────────────────────────────────────────────┐
│ 4. Gate 4: Meta-Labeling AI (Random Forest)            │ ──(P(Win) < 55%)──► [AI VETO: Bloqueio Preventivo]
│    Avalia 8 Features Não-Lineares (López de Prado)     │
└────────────────────────────────────────────────────────┘
                │ (P(Win) >= 55% Aprovado)
                ▼
    [Disparo da Ordem BUY na Deriv]
```

### Detalhamento dos 4 Gates:
- **Gate 1 (Regime & Filtros Estruturais)**:
  - **Filtro CUSUM**: Se a soma acumulada de desvios ultrapassar $h = 4.5\sigma$, o ativo entra em **Quarentena Preventiva de 5 minutos**.
  - **Razão de Variância Lo-MacKinlay ($q = 10$)**: Rejeita $VR < 1.08$ (Random Walk puro/ruído de cassino).
  - **Filtro de Spike**: Salto $> 3\sigma_{\text{tick}}$ aborta a entrada.
  - **Kaufman ER $\ge 0.28$ & OLS $R^2 \ge 0.35$**.
- **Gate 2 (Vetor Direcional Macro)**: $EMA_9$, $EMA_{21}$ e $Slope$.
- **Gate 3 (Micro-Order Flow Proxy)**: $\text{Tick Imbalance} \ge 0.50$ e $\text{Confiança} \ge 0.72$.
- **Gate 4 (Meta-Labeling com Random Forest)**:
  - IA treinada diretamente nos snapshots de mercado do MongoDB.
  - Avalia se o robô vai vencer ou perder dadas 8 features combinadas: ER, $R^2$, Slope, Imbalance, $VR$, $\sigma_{\text{tick}}$, Payout Ratio ($R$) e Hora UTC.
  - Se $P(\text{Win}) < 55\%$, veta a operação prevenindo armadilhas não-lineares da corretora.

---

## 4. Otimizador de Barreira, Validação de $EV$ e Kelly Blindado

### 4.1. Offset Dinâmico de Barreira
$$\sigma_{15\text{s}} = \sigma_{\text{tick}} \times \sqrt{15}$$
$$\text{Offset Alvo } (\Delta) = \pm (0.30 \times \sigma_{15\text{s}})$$

### 4.2. Critério de Expectativa Matemática ($EV > 0$)
1. **Faixa Sweet Spot**: $40\% \le R \le 85\%$.
2. **Edge Matemático**: $\text{Edge} = P_{\text{modelo}} - P_{\text{Deriv}} \ge \text{Edge Mínimo}$ (Base: $4\%$).
3. **Valor Esperado**: $EV = (P_{\text{modelo}} \times R) - (1 - P_{\text{modelo}}) > 0$.

### 4.3. Dimensionamento com Hard Cap de Kelly
$$f^* = \frac{P_{\text{modelo}} \times (R + 1) - 1}{R}$$
$$\text{Stake Final} = \min(\text{Base Stake} \times (1 + 0.25 \times f^*), \, \text{Base Stake} \times 1.5)$$

### 4.4. Tolerância a Slippage e Compensação de Latência
- Compara preço real executado com o cotado no `proposal`.
- Se 3 derrapagens consecutivas corromperem o $EV$ para $\le 0$, eleva o Edge Mínimo de $4\%$ para $6\%$.

---

## 5. Telemetria e Treinamento da IA Meta-Labeling

A aba **"IA Meta-Labeling (Gate 4)"** no frontend permite:
- Visualizar a acurácia do modelo, winrate baseline histórico e quantidade de amostras.
- Treinar o cérebro da Random Forest em 1 clique com os dados do MongoDB.
- Acompanhar os vetos e aprovações inteligentes em tempo real.
