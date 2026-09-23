# Regras e Arquitetura Operacional do Robô Deriv (Modelo Ortogonal, EV Positivo & Blindagem de Risco)

## 1. Visão Geral
O robô opera de forma quantitativa e automatizada na API da **Deriv**, analisando séries temporais de ticks em tempo real. A arquitetura adota **3 Gates Ortogonais e Sequenciais**, **Otimizador Dinâmico de Barreira**, **Filtro de Spike por Volatilidade Realizada**, **Teto Rígido (Hard Cap) de Kelly** e **Tolerância Adaptativa a Slippage**.

Contratos suportados:
- **Higher / Lower (Com Barreira Dinâmica Otimizada)**: Índices sintéticos (`1HZ75V`, `1HZ25V`, `1HZ50V`, `1HZ10V`, `1HZ100V`), duração padrão de **15 segundos**.
- **Multipliers (MULTUP / MULTDOWN)**: Criptoativos (`cryBTCUSD`), duração padrão de **120 segundos**.

---

## 2. Estrutura em 3 Gates Ortogonais

```
[Fluxo de Ticks em Tempo Real]
              │
              ▼
┌─────────────────────────────────────────┐
│ 1. Gatekeeper de Regime & Spike Filter  │ ──(Falha / Spike)──► [Sem Operação]
│    Spike <= 3σ + ER >= 0.28 + R² >= 0.35│
└─────────────────────────────────────────┘
              │ (Aprovado: Mercado Direcional e Estável)
              ▼
┌─────────────────────────────────────────┐
│ 2. Vetor Direcional (Macro)             │ ──(Determina Lado: CALL / PUT)
│    EMA 9/21 + Inclinação OLS (Slope)    │
└─────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│ 3. Gatilho de Micro-Timing (Imbalance)  │ ──(Score de Entrada: 0.0 a 1.0)
│    Tick Imbalance (últimos 10 ticks)    │
└─────────────────────────────────────────┘
```

### Camada 1: Gatekeeper de Regime & Filtro de Spike (Cauda Gorda)
1. **Filtro de Spike (Choque de Volatilidade)**:
   - Calcula o desvio padrão dos retornos por tick ($\sigma_{\text{tick}}$).
   - Se a variação absoluta do último tick for superior a $3 \times \sigma_{\text{tick}}$, o movimento é classificado como anomalia estocástica e a entrada é rejeitada.
2. **Kaufman Efficiency Ratio ($ER$) & Regressão Linear ($R^2$)**:
   - **$ER \ge 0.28$**: Eficiência do movimento direcional vs volatilidade do caminho percorrido.
   - **$R^2 \ge 0.35$**: Força do ajuste da reta linear de tendência sobre 40 ticks.
   - Se qualquer um dos dois falhar, o cálculo é abortado antes de avaliar direção.

### Camada 2: Vetor Direcional
- **Direção de Alta (CALL / HIGHER / MULTUP)**: $Preço > EMA_9 > EMA_{21}$, Inclinação OLS ($Slope$) $> 0$ e $Imbalance > 0$.
- **Direção de Baixa (PUT / LOWER / MULTDOWN)**: $Preço < EMA_9 < EMA_{21}$, Inclinação OLS ($Slope$) $< 0$ e $Imbalance < 0$.

### Camada 3: Micro-Fluxo (Order Flow Proxy)
Calcula a pressão compradora vs vendedora nos últimos 10 ticks:
$$\text{Tick Imbalance} = \frac{\text{Ticks de Alta} - \text{Ticks de Baixa}}{\text{Total de Ticks}}$$

---

## 3. Cálculo de Confiança Calibrada

$$\text{Confiança} = (0.35 \times \text{Norm}(ER)) + (0.35 \times R^2) + (0.30 \times \vert{}\text{Tick Imbalance}\vert{})$$

- $\text{Norm}(ER) = \min(1.0, \frac{ER}{0.60})$
- **Gatilho de Execução**: $\text{Confiança} \ge 0.72$ (com todos os Gates 1 e 2 satisfeitos).

---

## 4. Otimizador Dinâmico de Barreira, $EV$ e Gestão de Slippage

### 4.1. Offset Dinâmico de Barreira por Volatilidade
$$\sigma_{15\text{s}} = \sigma_{\text{tick}} \times \sqrt{15}$$
$$\text{Offset Alvo } (\Delta) = \pm (0.30 \times \sigma_{15\text{s}})$$
- **HIGHER**: Barreira deslocada abaixo do preço atual ($-\Delta$).
- **LOWER**: Barreira deslocada acima do preço atual ($+\Delta$).

### 4.2. Critério de Valor Esperado ($EV > 0$) e Edge Operacional
1. **Retorno Líquido ($R$)**: $R = \frac{\text{Payout} - \text{Ask Price}}{\text{Ask Price}}$
2. **Faixa Sweet Spot**: Exige $40\% \le R \le 85\%$ ($0.40 \le R \le 0.85$).
3. **Probabilidade Implícita da Corretora ($P_{\text{Deriv}}$)**: $P_{\text{Deriv}} = \frac{\text{Ask Price}}{\text{Payout}}$
4. **Vantagem Matemática ($\text{Edge}$)**: $\text{Edge} = P_{\text{modelo}} - P_{\text{Deriv}} \ge \text{Edge Mínimo}$ (Base: $4\%$).
5. **Valor Esperado ($EV$)**:
   $$EV = (P_{\text{modelo}} \times R) - (1 - P_{\text{modelo}}) > 0$$

### 4.3. Dimensionamento com Hard Cap de Kelly (Teto de Segurança)
$$f^* = \frac{P_{\text{modelo}} \times (R + 1) - 1}{R}$$
$$\text{Stake Proposto} = \text{Base Stake} \times (1 + 0.25 \times f^*)$$
$$\text{Stake Final} = \min(\text{Stake Proposto}, \, \text{Base Stake} \times 1.5)$$
*(O stake nunca ultrapassa 1.5x o valor base, blindando a conta contra anomalias na API).*

### 4.4. Tolerância a Slippage e Adaptação de Latência
- Ao receber a confirmação de execução (`buy`), compara o preço real executado com o cotado no `proposal`.
- Se o slippage corroer o $EV$ para $\le 0$, registra `SLIPPAGE_WARNING`.
- Se ocorrerem **3 warnings consecutivos**, o robô eleva automaticamente o **Edge Mínimo de $4\%$ para $6\%$** para compensar o atraso de rede.

---

## 5. Gestão de Saída (Take Profit & Stop Loss)

- **Contratos Curtos (15s)**: Saída antecipada desativada. Correm até o vencimento natural para evitar spread negativo.
- **Multiplicadores / Cripto (120s)**: Saída antecipada ativa a partir de $+25\%$ de lucro líquido ou Trailing Stop.

---

## 6. Gestão de Risco e Resfriamento

- **Cooldown Pós-Loss**: Pausa o ativo por **180 segundos (3 minutos)** se o último trade fechou em perda.
- **3 ou mais Perdas Consecutivas**: Stake reduzido para **$25\%$** e pausa global de proteção de **180 segundos**.
- **2 Perdas Consecutivas**: Stake reduzido para **$50\%$**.
- **1 Vitória**: Restaura o stake integral ($100\%$).
- **Stop Diário de Perda (`maxDailyLoss`)**: Bloqueia novas entradas no dia caso atinja o limite.
