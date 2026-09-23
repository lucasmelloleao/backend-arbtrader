# 🛡️ FXPRO CTRADER BOT — DOCUMENTAÇÃO DE REGRAS E ARQUITETURA QUANTITATIVA

Documento normativo e operacional do **Robô FxPro cTrader**, operando em regime de alta precisão estatística nos mercados Forex, Metais (XAU/USD) e Índices/Crypto, totalmente desacoplado de outras corretoras.

---

## 1. Conectividade e Execução (cTrader Open API)
- **Protocolo**: WebSocket com Google Protocol Buffers (Open API v2 / v3).
- **Contas Suportadas**: Demo e Live Hedging (ex: conta `10650441`).
- **Alavancagem Máxima Suportada**: até 1:10.000 (calibrada por Fractional Kelly).
- **Tipos de Ordem**: Market Order com Stop Loss e Take Profit embutidos no disparo.

---

## 2. Os 4 Gates de Proteção e Validação Matemática

```
┌────────────────────────────────────────────────────────┐
│               FLUXO DE DECISÃO FXPRO BOT               │
├────────────────────────────────────────────────────────┤
│  1. Gate 1: Lo-MacKinlay Variance Ratio (VR >= 1.08)   │
│     -> Veto de Random Walk / Ruído Estocástico         │
│                                                        │
│  2. Gate 2: Kaufman Efficiency Ratio (ER >= 0.35)      │
│     -> Exigência de Tendência Direcional Limpa         │
│                                                        │
│  3. Gate 3: Microstructure & Spread Guard              │
│     -> Bloqueio em Alargamento de Spread               │
│                                                        │
│  4. Gate 4: IA Meta-Labeling Random Forest (100 Trees) │
│     -> Veto Preditivo se P(Win) < 55%                  │
│                                                        │
│  5. Dimensionamento de Lotes (Fractional Kelly)        │
│     -> Disparo de Ordem na cTrader + Gestão em MKT     │
└────────────────────────────────────────────────────────┘
```

### Gate 1: Lo-MacKinlay Variance Ratio (Random Walk Filter)
- **Fórmula**:
  $$\text{VR}(k) = \frac{\sigma^2(k)}{k \cdot \sigma^2(1)}$$
- **Critério**: Se $\text{VR} < 1.08$, o par está em ruído browniano (passeio aleatório sem memória). O trade é vetado para evitar entradas sem persistência de momentum.

### Gate 2: Kaufman Efficiency Ratio ($ER$)
- **Fórmula**:
  $$ER = \frac{|\text{Preço}_t - \text{Preço}_{t-n}|}{\sum_{i=1}^n |\text{Preço}_i - \text{Preço}_{i-1}|}$$
- **Critério**: $ER \ge 0.35$. Filtra consolidações laterais "chicote".

### Gate 3: Spread Guard Dinâmico
- **Critério**: $\text{Spread} \le 2.5\text{ pips}$ (ou valor customizado pelo usuário). Impede execução em aberturas de sessão com spread inflado.

### Gate 4: IA Meta-Labeling Random Forest (100 Árvores)
- **Classificador**: Random Forest não-linear com bootstrapping.
- **Features Extraídas no Instante de Entrada**:
  1. Kaufman $ER$ (Eficiência de Tendência)
  2. Lo-MacKinlay $\text{VR}$ (Persistência vs Random Walk)
  3. $\text{ATR}(14)$ em Pips (Volatilidade Atual)
  4. Spread Atual da FxPro
  5. Expected Value ($EV$) Estimado
  6. Edge Estatístico (%)
  7. Horário da Sessão (Londres, NY, Tóquio)
  8. Lote Operado
- **Ação**: Se $P(\text{Win} \mid \text{Condições}) < 55\%$, a ordem é sumariamente vetada.

---

## 3. Dimensionamento de Capital (Fractional Kelly)
- O lote ótimo é calculado dinamicamente:
  $$f^* = \frac{b \cdot p - q}{b} \times \text{Fração (25\%)}$$
- Margem alocada proporcional à probabilidade estimada pela IA.

---

## 4. API Endpoints (Swagger / REST)

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/v1/fxpro/strategies` | Listar estratégias FxPro configuradas |
| `POST` | `/api/v1/fxpro/strategies` | Criar nova estratégia Forex/CFD |
| `PUT` | `/api/v1/fxpro/strategies/:id` | Atualizar parâmetros (TP, SL, Lote, Gates) |
| `DELETE` | `/api/v1/fxpro/strategies/:id` | Excluir estratégia |
| `POST` | `/api/v1/fxpro/strategies/:id/toggle` | Alternar status (Ligar/Pausar) |
| `GET` | `/api/v1/fxpro/trades` | Histórico de trades com filtro por período |
| `GET` | `/api/v1/fxpro/bot/status` | Status do motor de execução |
| `POST` | `/api/v1/fxpro/bot/start` | Iniciar ciclo contínuo do robô |
| `POST` | `/api/v1/fxpro/bot/stop` | Pausar ciclo do robô |
| `GET` | `/api/v1/fxpro/meta-model/status` | Status da IA e pesos de features |
| `POST` | `/api/v1/fxpro/meta-model/train` | Retreinar o modelo Random Forest |
