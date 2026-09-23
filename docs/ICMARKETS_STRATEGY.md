# Estratégia IC Markets (ic.com) cTrader Quant & IA

## 1. Visão Geral
A estratégia **IC Markets cTrader** é um sistema autônomo de alta frequência (HFT) e scalping quantitativo projetado para operar contas **Raw Spread / Standard** da corretora [IC Markets](https://www.icmarkets.com) através do protocolo binário **cTrader Open API Protobuf**.

### Características da Conta Configurada:
- **Broker / Server:** IC Markets / `cTrader demo`
- **Account ID:** `10102182`
- **Tipo de Conta:** `Demo` / `Live` (Raw Spread)
- **Moeda Base:** `USD`

---

## 2. Arquitetura em 4 Gates Quantitativos

A execução de qualquer ordem no robô IC Markets é rigorosamente condicionada pela aprovação sequencial de 4 filtros matemáticos e probabilísticos:

```
[ Mercado / Ticks cTrader ]
           │
           ▼
┌────────────────────────────────────────┐
│ Gate 1: Lo-MacKinlay Variance Ratio    │  VR > 1.08 (Rejeita Random Walk)
└────────────────────────────────────────┘
           │ (Aprovado)
           ▼
┌────────────────────────────────────────┐
│ Gate 2: Kaufman Efficiency Ratio (ER)  │  ER >= 0.35 (Filtro de Ruído)
└────────────────────────────────────────┘
           │ (Aprovado)
           ▼
┌────────────────────────────────────────┐
│ Gate 3: Spread & Fricção Raw           │  Spread <= 2.5 pips
└────────────────────────────────────────┘
           │ (Aprovado)
           ▼
┌────────────────────────────────────────┐
│ Gate 4: IA Meta-Labeling Random Forest │  P(Win | X_t) >= 55%
└────────────────────────────────────────┘
           │ (Aprovado)
           ▼
[ Disparo de Ordem a Mercado cTrader ]
```

### Detalhamento dos Gates:
1. **Gate 1 - Lo-MacKinlay Variance Ratio ($VR$):**
   $$VR(k) = \frac{\sigma^2(k)}{k \cdot \sigma^2(1)}$$
   Identifica se os retornos intraminuto possuem inércia direcional ($VR > 1.08$) ou se o mercado está em regime aleatório ($VR \approx 1.0$).
2. **Gate 2 - Kaufman Efficiency Ratio ($ER$):**
   $$ER = \frac{|\Delta P_{total}|}{\sum |\Delta P_i|}$$
   Mede a velocidade limpa do preço em relação à volatilidade intrínseca.
3. **Gate 3 - Fricção e Spread:**
   Garante que o custo de transação da IC Markets Raw Spread não comprometa a expectativa matemática do trade.
4. **Gate 4 - IA Meta-Labeling (Random Forest):**
   Baseado na metodologia de *Marcos López de Prado (Advances in Financial Machine Learning)*, o classificador prediz a probabilidade $P(\text{Win} \mid X_t)$. Se $P(\text{Win}) < 55\%$, a entrada é vetada.

---

## 3. Gestão de Risco e Dimensionamento de Lote
- **Critério de Kelly Fracionário (Half Kelly):**
  $$f^* = \frac{p \cdot b - q}{b} \times 0.5$$
- **Take Profit / Stop Loss / Trailing Stop Dinâmico:** Gestão por pips e dólares em tempo real via reconexão WebSocket e sincronização cTrader Reconcile.
