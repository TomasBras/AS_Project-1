# Roteiro da Apresentação (7-10 minutos)

## 0) Objetivo e enquadramento (20-30s)
Dizer:
"Instrumentei um fluxo real do nopCommerce ponta a ponta com OpenTelemetry: cliente finaliza encomenda (Basket -> Order -> Payment -> Inventory).  
O objetivo foi adicionar observabilidade de forma cirúrgica, provar o comportamento sob carga e justificar as decisões arquiteturais."

## 1) Problema e escolhas de desenho (45-60s)
Dizer:
- "O nopCommerce é em camadas (Presentation, Services, Data, Core), por isso instrumentei sobretudo nas fronteiras para reduzir impacto."
- "Priorizei métricas acionáveis, não contadores genéricos: error rate, p95, motivos de drop-off, falhas de basket e de inventory."
- "Excluí intencionalmente PII das tags de telemetria."

Mostrar rapidamente:
- `ARCHITECTURE.md` (fluxo + racional)
- `CRITIQUE.md` (o que ajudou/dificultou + alterações cirúrgicas)

## 2) Compreensão da arquitetura (60-90s)
Dizer:
- "As dependências seguem Presentation -> Services -> Data/Core."
- "O `IEventPublisher` é eventing in-process; é um bom boundary de observabilidade, mas evitei refatorações largas."
- "Configurei OpenTelemetry uma única vez no arranque da aplicação e concentrei métricas custom num helper para manter nomes/tags consistentes."

Apontar para código:
- `src/Presentation/Nop.Web/Program.cs`
- `src/Presentation/Nop.Web/Infrastructure/Observability/CheckoutTelemetry.cs`
- `src/Presentation/Nop.Web/Controllers/CheckoutController.cs`
- `src/Presentation/Nop.Web/Controllers/ShoppingCartController.cs`

## 3) Checkpoints de setup ao vivo (30-45s)
Antes da demo, manter 3 separadores abertos:
- Grafana: `http://localhost:3000`
- Prometheus: `http://localhost:9090`
- Jaeger: `http://localhost:16686`

Terminal A (app):
```bash
export DOTNET_ROOT=/home/tomasbras/dotnet-sdk-9.0.312-linux-x64
export PATH=$DOTNET_ROOT:$PATH
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 dotnet run --project src/Presentation/Nop.Web/Nop.Web.csproj
```

Terminal B (carga):
```bash
BASE_URL=http://localhost:5000 \
EMAIL=admin@yourStore.com \
PASSWORD='arquiteurasoftware' \
PRODUCT_ID=<id_do_produto_simples> \
INVENTORY_QTY=2000 \
k6 run load-tests/checkout-opc.js
```

## 4) Percurso do dashboard (2-3 min)
Usar esta ordem de painéis:
1. Checkout Attempts (5m)
2. Checkout Error Rate (5m)
3. Checkout p95 Duration (5m)
4. Checkout Drop-off at Confirm Step (5m)
5. Basket Checkout Failures (5m)
6. Inventory Checkout Failures (5m)
7. Payment Attempts / p95 / Failures (contexto)

Dizer:
- "Os attempts sobem com a carga."
- "Error rate e p95 mostram estabilidade e degradação."
- "Os motivos de drop-off localizam o passo com falha."
- "Basket/Inventory failures mostram a causa de domínio."
- "Nos painéis de payment pode aparecer pouco ou nenhum dado neste setup offline/local; é esperado neste ambiente e não falha de instrumentação."

## 5) Evidência no Prometheus (60-90s)
Executar/mostrar estas queries:
```promql
sum by (result) (increase(checkout_attempts_total[5m]))
```
```promql
sum(increase(checkout_attempts_total{result!="success"}[5m])) / sum(increase(checkout_attempts_total[5m]))
```
```promql
histogram_quantile(0.95, sum(rate(checkout_duration_seconds_bucket[5m])) by (le))
```
```promql
sum by (step, reason_code) (increase(checkout_step_dropoff_total[5m]))
```
```promql
sum by (flow, reason_code) (increase(basket_checkout_failures_total[5m]))
```
```promql
sum by (flow, reason_code) (increase(inventory_checkout_failures_total[5m]))
```

Checks opcionais de payment:
```promql
sum by (provider, method, result) (increase(payment_attempts_total[5m]))
sum by (provider, reason_code) (increase(payment_failures_total[5m]))
```

## 5.1) Cenários de load test: o que valida, o que pode falhar e o que fazer
Script: `load-tests/checkout-opc.js`

Cenários e objetivo:
1. `opc_success`
   - Valida caminho de checkout bem-sucedido ponta a ponta.
   - Esperado: subida de `checkout_attempts_total{result="success"}` e métricas de duração.
2. `opc_basket_failure`
   - Força falha por estado inválido do carrinho.
   - Esperado: subida de `basket_checkout_failures_total` e `checkout_step_dropoff_total`.
3. `opc_payment_failure`
   - Tenta forçar falha no ramo de pagamento.
   - Esperado: atividade em `payment_attempts_total` e possivelmente `payment_failures_total`.
4. `opc_inventory_pressure`
   - Força pressão de quantidade para falha por stock.
   - Esperado: subida de `inventory_checkout_failures_total`.
5. `opc_inventory_race`
   - Gera concorrência para stress no checkout/inventory.
   - Esperado: mais tentativas e, dependendo do produto, mais falhas de stock.

Como ler os checks do k6:
1. `successful flow completed = 0%`
   - O caminho de sucesso não está a fechar no dataset/configuração atual.
   - Ação: confirmar produto simples, sem atributos obrigatórios, e fluxo OPC funcional.
2. `inventory failure signal observed = 0%`
   - Não estás a atingir o caminho de falha por stock.
   - Ação: produto com `Track inventory`, `No backorders`, stock baixo e `PRODUCT_ID` explícito.
3. `add-to-cart responded` baixo/0%
   - Normalmente indica problema de token/fluxo ou produto inadequado para add-to-cart direto.
   - Ação: validar produto, rerun, e confirmar CSRF.

O que verificar durante a demo:
1. `http_req_failed` aceitável (sem falha de infraestrutura).
2. `basket` e `inventory` com leitura > 0.
3. Painéis de payment podem estar 0/"No data" no setup offline/local (explicar explicitamente).
4. Traces no Jaeger coerentes com os picos no Grafana.

Plano rápido se não aparecer sinal:
1. Rever produto no Admin (simples, stock, backorders, buy button, atributos).
2. Reexecutar k6 com `PRODUCT_ID` explícito desse produto.
3. Aumentar time range para `Last 1h`.
4. Confirmar primeiro no Prometheus e só depois no dashboard.

## 6) Evidência de traces no Jaeger (60-90s)
No Jaeger:
- Service: `nop.web`
- Lookback: `Last 1h`
- Filtrar operações POST de checkout

Mostrar 2 traces:
1. Um pedido de checkout com sucesso.
2. Um pedido com falha/drop-off.

Dizer:
- "A evidência ao nível de trace confirma os picos de métricas."
- "Consigo mapear sintomas de latência/erro no Grafana para caminhos concretos no Jaeger."

## 7) Privacidade e alternativas rejeitadas (45-60s)
Dizer:
- "Sem PII nas tags: sem email, nomes, telemóvel, morada ou detalhes de pagamento."
- "Evitei refatorações largas em services e lógica de negócio."
- "Abordagem rejeitada: instrumentar demasiados internals com tags de alta cardinalidade (ruído e custo operacional)."

## 8) Resumo das alterações cirúrgicas (30-45s)
Dizer:
- "As alterações estão localizadas: configuração OTel no startup + helper de telemetria de checkout + hooks pontuais nos controllers."
- "Isto minimiza risco de regressão e aumenta visibilidade operacional."

## 9) Fecho (20-30s)
Dizer:
"A principal conclusão: com alterações pequenas e focadas em boundaries, transformei um fluxo real de negócio num pipeline observável com sinais acionáveis sob carga."

---

## Checklist de demo (antes de apresentar)
- SQL Server, app, collector, Prometheus, Grafana e Jaeger ativos.
- Produto usado no cenário de inventory:
  - Produto simples
  - Track inventory
  - No backorders
  - Stock baixo
  - Buy button ativo
- Time range no Grafana: `Last 15 minutes` (ou `Last 1 hour` se necessário).
- Pelo menos uma leitura > 0 em:
  - `checkout_attempts_total`
  - `checkout_step_dropoff_total`
  - `basket_checkout_failures_total`
  - `inventory_checkout_failures_total`

## Preparação para Q&A (respostas curtas)
- Porque é que os painéis de payment podem ficar sem dados?
  - "Neste ambiente o payment é offline/local; é esperado."
- Porque escolheste estas métricas?
  - "São acionáveis às 2h da manhã: dizem onde e porquê o checkout está a degradar/falhar."
- Porque não refatoraste mais?
  - "O objetivo era mudança cirúrgica; refatoração ampla aumentava risco e scope."
- Como trataste dados sensíveis?
  - "PII excluído por desenho; apenas labels operacionais de baixa cardinalidade."

## Contingência se a demo ao vivo falhar
- Se o dashboard estiver vazio:
  1. Validar no Prometheus `checkout_attempts_total`.
  2. Reexecutar k6 por 1-2 minutos.
  3. Aumentar time range do Grafana para `Last 1h`.
- Se o painel de inventory estiver vazio:
  1. Confirmar configuração do produto (track inventory, no backorders, stock baixo).
  2. Reexecutar com `PRODUCT_ID` explícito e `INVENTORY_QTY=2000`.
