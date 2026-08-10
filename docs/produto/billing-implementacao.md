# Billing — implementação dos épicos 5–8 (T6–T9, US5–US17)

> Documento de trabalho da implementação overnight de 30→31/07/2026.
> Fonte das histórias: `Traces, Sessions, Billing (1).xlsx` (abas Backlog e
> Log de Decisões). Referência visual: protótipo `khal-creditos-prototype`
> (index.html). Tudo aqui está numerado como decisão (87+) para o log em
> `backlog-v2.3.md` — revisar no alinhamento.

> **Errata (01/08/2026):** os alvos de runbook chamam-se `make billing-close`
> / `make billing-reopen` (não `billing:close` — o dois-pontos ficou só nos
> npm scripts internos); a seção de séries antecede a decisão 97 (lente
> diária + segmentos empilhados por tipo de token) e a 109 (motor
> `statement-engine/2`, shares em BigInt); os dois endpoints de export foram
> consolidados em `GET /billing/statement?format=csv|html` (decisão 98).
> O log de decisões do backlog é o canônico.

## 1 · A regra central: carimbado vs. computado

A intuição do usuário ("running month computed, closed months stamped, same
logic as tokens") está correta e vira arquitetura assim:

- **Mês corrente (e meses passados ainda abertos)**: o extrato é COMPUTADO
  ao vivo, sempre a partir dos carimbos imutáveis dos traces (invariantes
  1/3 — nunca uma segunda conta).
- **Mês fechado**: o fechamento roda o MESMO motor sobre os mesmos carimbos
  e congela entrada + saída num snapshot imutável. A partir daí o extrato é
  SERVIDO do snapshot — nunca recalculado (T7).
- O paralelo com os tokens é exato: o carimbo de preço acontece na escrita
  do trace; o "carimbo do mês" acontece no fechamento. Entre um e outro, o
  número que o gestor vê é sempre rotulado parcial/em andamento (US6).

**Um único motor** (`statement-engine.ts`, função pura): tanto o caminho ao
vivo quanto o fechamento chamam `buildStatement(usageRecords)`. Igualdade
fechado ≡ ao-vivo-no-instante-do-fechamento e o teste de reprodutibilidade
(T6) saem de graça, por construção.

## 2 · Mapa protótipo → histórias

| Tela do protótipo | Uso aqui |
|---|---|
| `s-visao` (KPIs: consumo no mês, projeção; gráfico; lista de agentes) | KPIs do extrato (US7), card de projeção (US12), quebra por agente (US7) |
| `s-relatorio` (tabela de linhas + botões CSV/Excel/PDF) | Drill-down do extrato (US8) e exportação (US17) |
| `s-faturas` (lista de faturas com status colorido) | Lista de meses com status Final / Em andamento (US6) — sem pagamentos |
| Drawer do agente (donut "Por modelo" + KPIs) | Mix de modelos (US15) |
| `s-estados` (skeleton/banners/vazios) | Padrões de estado já existentes na UI |
| `s-carteira`, `s-pagamentos`, modal Koins | **FORA** — carteira/koins/pagamento não existem nas histórias |
| Modal "Transparência de preço" (USD, câmbio, markup) | **PROIBIDA** — viola invariante 4 (cliente só vê R$; US$/PTAX/markup ausentes por construção). A ideia de "mostrar a conta" sobrevive em US8, mas só com preço contratado em R$/milhão |

O protótipo é de um produto de CRÉDITOS (Koins pré-pagos, carteira,
faturas a pagar). Nosso módulo é pós-pago por consumo; aproveitei o
vocabulário visual (status pills, tabela de linhas, donut, KPIs), não o
modelo de negócio.

## 3 · Modelo de dados (Mongo)

### `billing_periods` (novo)
Um doc por mês que já sofreu ação de ciclo de vida. Ausência de doc =
aberto (implícito).

```
{ year, month, status: 'open'|'closed',
  closedAt?, snapshotVersion?,            // versão corrente
  audit: [{ at, action: 'close'|'reopen', trigger: 'runbook',
            reason?, snapshotVersion }] }
```

### `billing_snapshots` (novo)
Imutável; um doc por (year, month, version). Versões antigas preservadas
(reabertura → novo version no re-fechamento).

```
{ year, month, version, createdAt, trigger,
  ingestionWatermark,                      // max ingestedAt dos traces do mês
  logicVersion,                            // versão do motor (string)
  roundingRule,                            // texto da regra (auditoria)
  statement: <StatementProjection>,        // SAÍDA client-facing congelada
  exceptions: [],                          // sem preço/excluídos (v1: vazio — fechamento bloqueia com pendência)
  priceVersionsApplied: [{model, tokenType, priceMicrocentsPerMillion, effectiveFrom}],
  usageRecordCount }
```

### `billing_snapshot_usage` (novo)
ENTRADA do motor, congelada — um doc por trace (evita limite de 16MB do
snapshot único). `{ snapshotId, traceId, startedAt, agent, model, tokens,
stampedCosts, totalCostMicrocents }`.

### Traces (campo novo, opcional)
`billingQuarantine: { reason: 'period_closed', quarantinedAt }` — trace
datado dentro de mês fechado que chegou depois. O trace É armazenado
(invariante 6, arquivo permanente) mas fica fora de agregação de billing e
do carimbo de pendentes. Visível ao admin (contagem na lista de meses).

## 4 · Ciclo de vida (T6)

- **Fechar**: job runbook `make billing:close CLIENT=x YEAR=y MONTH=m`
  (+ `npm run billing:close`). QA4 respondida: gatilho é ADMIN/runbook,
  sem automático na v1 (decisão 87). *[Refinada pela decisão 131
  (04/08/2026): o gatilho automático existe como OPT-IN — sidecar
  `billing-close-scheduler` atrás do perfil compose `billing-auto-close`,
  mesmo use case com `trigger: 'scheduled'` auditado; bloqueado re-tenta a
  cada ciclo (QA5 respondida: a fatura espera) e mês REABERTO nunca
  re-fecha sozinho — reabertura é território do runbook.]* Regras:
  - só mês-calendário completamente no passado (UTC);
  - **bloqueado se existir trace `pending_price` no mês** (critério T6) —
    o job lista os modelos sem preço e sai com erro;
  - lê todos os traces do mês (sem payloads/spans), monta usage records,
    roda o motor, grava snapshot (inputs + outputs), marca período fechado.
- **Reabrir**: `make billing:reopen ... REASON="..."` — auditada (reason
  obrigatório), snapshot anterior preservado; próximo fechamento grava
  version+1. Só runbook (critério T6).
- **Pós-fechamento**:
  - ingestão de trace datado no mês fechado → quarentena (acima);
  - `reprocess:pending` PULA traces de meses fechados (guard novo;
    contador `blockedClosedMonth` no relatório do job);
  - reagregação: não existe caminho de reagregação de mês fechado — a
    leitura é do snapshot.
- **US5 (visibilidade admin)**: saída do job (fechado com total R$ X /
  bloqueado com motivo) + endpoints de leitura. Alertas/notificações estão
  FORA do escopo v1 pela própria planilha (decisão 89).

## 5 · Camada de leitura (T7) — endpoints

Evoluídos EM LUGAR (sem endpoint paralelo — uma verdade só):

- `GET /api/v1/bills` → agora com `status`: `closed` ("Fechada — final"),
  `open` ("Aberta — aguardando fechamento", mês passado não fechado),
  `in_progress` ("Em andamento — dados parciais"); watermark de ingestão;
  contagem de quarentena; meses fechados servidos do snapshot.
- `GET /api/v1/billing/summary?year&month` (o EXTRATO) → mês fechado:
  projeção do snapshot, com `closed_at`, `snapshot_version`, nota de
  auditoria de reabertura se houver; mês aberto: computado ao vivo e
  rotulado. Ganha (aditivo):
  - `agents[].percent_of_total` (US7; largest-remainder — as partes fecham
    com 100 e com o total exibido);
  - linhas de drill-down com **preço unitário aplicado** (R$/milhão) e
    `quantidade × preço = custo` (US8). Linhas agrupam por agente ×
    versão × modelo × tipo de token × preço aplicado — troca de preço no
    meio do mês gera linhas separadas, a soma continua exata (decisão 90);
  - `comparison` vs mês anterior: Δ absoluto e % no total e por agente
    (US10; informativo);
  - `model_mix` (T9/US15): share de custo e tokens por modelo (total e por
    agente), Δ p.p. vs mês anterior, R$ médio/milhão (blended) por agente;
  - `cache_savings` (T9/QA7): contrafactual "cache read a preço de input"
    vs custo real de cache read, `savings`, custo de **cache write
    explícito** e `net_savings` (decisão 91);
  - `period_status` + `watermark_display` (US2/US6).
- `GET /api/v1/billing/series?months=N` (T8/US11): série mensal — total e
  por agente (e por modelo), um total por mês; meses fechados do snapshot,
  corrente ao vivo e marcado `in_progress`. Cada série vem com geometria
  de barra pré-computada (`height_percent`) — a UI continua camada burra
  de render (convenção do app.js).
- `GET /api/v1/billing/projection` (T8/US12): run-rate linear documentado:
  `acumulado ÷ dias UTC completos × dias do mês`. Só responde para o mês
  corrente; `<3 dias completos → insufficient`; `basis_text` em palavras
  simples; NUNCA persistida, some no fechamento (decisão 93).
- `GET /api/v1/billing/statement?year&month&format=csv|html` (US17,
  decisão 98 — um recurso, representação por parâmetro): `csv` = linhas do
  drill-down em CSV (abre em Excel); cabeçalho com mês, status e
  timestamp; mês em andamento → coluna/marca "PARCIAL" (QA13 respondida:
  permitido com marca d'água — decisão 94).
- `format=html`: HTML standalone
  imprimível (Ctrl+P → PDF), renderizado do snapshot quando fechado, com
  status "final" + timestamp; marca d'água "PARCIAL" quando em andamento.
  XLSX/PDF binários adiados (política de zero dependências novas).

Schema de fio: R$ apenas; sem US$/PTAX/markup; campos internos do snapshot
(exceções, watermark bruto) não entram na projeção — por construção.

## 6 · Motor (application/useCases/billingStatement/statement-engine.ts)

Função pura; entrada = `BillingUsageRecord[]` (traceId, startedAt, agent
{id,version}, model, stampedCosts[{tokenType, tokens, preço aplicado,
custo}], totalCostMicrocents); saída = `StatementProjection` (total,
agentes ordenados por custo com %, linhas com preço unitário, mix,
cache_savings, contagens). Dinheiro: µ¢ inteiros + helpers existentes
(`money.ts`); exibição half-up 2 casas com reconciliação largest-remainder
já existente. `LOGIC_VERSION` exportada e gravada no snapshot.

Contrafactual de cache (decisão 91): cache_read tokens somados por preço
de INPUT aplicado no mesmo trace → `costMicrocents(Σtokens, inputPrice)`.
Traces sem preço de input carimbado ficam fora e são contados
(`unpriceable_cache_read_traces`) — honestidade sobre a base da conta.

Teste de aceite de reprodutibilidade (T6): specs fecham um mês sintético,
releem `billing_snapshot_usage`, rodam o motor de novo e exigem igualdade
EXATA (ao centavo e ao µ¢) com `snapshot.statement`.

## 7 · UI (packages/ui — vanilla, mesmas convenções)

Aba "Faturas" vira "Billing" completo, telas referenciadas no protótipo:

1. **Lista de meses** (ref: s-faturas): status pill Final/Em andamento/
   Aberta, total, pendências, quarentena. Continua a porta de entrada.
2. **Extrato do mês** (painel; ref: s-visao + s-relatorio): hero com total
   + status + watermark; projeção (card, só mês corrente, rotulada
   estimativa); comparação vs mês anterior (US10); quebra por agente com %
   e barra (US7); drill-down por modelo × tipo de token com qtd, R$/M e
   custo de linha (US8); donut de mix de modelos + blended R$/M (US15);
   card de economia de cache; botões CSV / Imprimir (US17).
3. **Evolução** (ref: gráfico do s-visao, mensal): barras mensais com
   série total e por agente ligáveis (chips), mês corrente tracejado
   "em andamento", tabela mensal embaixo (US11).

Sem Carteira/Koins/pagamentos; sem tela de transparência USD (invariante 4).

## 8 · Resultado da noite (31/07/2026, ~03h) — TUDO IMPLEMENTADO

Backend + UI entregues e verificados; nada foi commitado (sua instrução).
`git status` mostra o diff completo para revisão.

**Código novo (API)**: `statement-engine.ts` (o motor único + spec com 11
casos), modelos `billing-period-model`/`billing-snapshot-model`, use cases
de fechamento/reabertura (+ spec com o TESTE DE REPRODUTIBILIDADE),
summary/bills reescritos (snapshot-first), série + projeção (+ specs),
repositórios Mongo novos (+ teste de integração que reproduz o snapshot a
partir do storage REAL), migração 017 (indexes-only), guards de quarentena
(ingestor) e de mês fechado (reprocess), jobs `billing:close`/`billing:reopen`
+ targets make, 4 endpoints novos + 2 evoluídos, OpenAPI + Postman
atualizados. **UI**: aba Faturas completa (projeção, evolução com séries
ligáveis, status pills, extrato com %, drill-down com preço unitário,
comparação, donut de mix, card de cache, exports).

**Suíte**: 49 suites / 337 testes verdes; tsc limpo.

**Verificação ao vivo (stack hapvida, imagens rebuildadas)**:
1. Demo: 48 traces de julho (LangWatch→worker) + 9 de junho (backfill via
   fixtures) + preços seed.
2. `make billing-close YEAR=2026 MONTH=6` → **BLOQUEADO**: "2 trace(s) com
   preço pendente (meta/llama-4-scout)" ✔ (critério T6)
3. Preço registrado via `make price` (reprocessa na hora, decisão 57) →
   close ok: "Mês 2026-06 FECHADO — total final R$ 0.20 (9 execuções,
   snapshot v1)" ✔
4. Re-sync de junho depois do fechamento → extrato IMUTÁVEL (R$ 0,20,
   snapshot v1) ✔
5. /bills: junho "Fechado — final" + julho "Em andamento — parcial" ✔;
   extrato de junho servido do snapshot com %, linhas com preço unitário
   (conta refazível: 5.000 × R$16,50/M = R$0,0825 ✔), mix, cache,
   comparação vs maio ✔; julho ao vivo comparando com junho FECHADO ✔
6. /billing/series (jun fechado + jul parcial, alturas pré-computadas) ✔;
   /billing/projection (29 dias completos → R$ 472,73, basis em palavras) ✔
7. CSV (BOM, filename PARCIAL p/ julho) + print view (status final /
   marca d'água) ✔; UI verificada no navegador (screenshots na sessão).

## 9 · Para alinhar amanhã

- **Sua intuição da noite estava certa** e virou a decisão 88: mês corrente
  COMPUTADO ao vivo, mês fechado CARIMBADO (snapshot), mesma lógica dos
  tokens — e com UM motor só, a igualdade é por construção.
- ~~QA19 segue aberta~~ **RESOLVIDA (decisão 138, 09/08/2026)**: preço
  vigente na data do trace — o fechamento COPIA os carimbos, não
  re-precifica; nada aqui mudou com a resposta.
- ~~Fronteira de mês em UTC~~ **RESOLVIDO (decisão 130, 04/08/2026)**: a
  fronteira é a meia-noite do CLIENTE, do knob obrigatório
  `CLIENT_TIMEZONE` (IANA) — fronteira de faturamento ≡ fuso de exibição,
  por construção. (A nota original dizia que a mudança tocaria
  "`monthWindowUtc` e nada mais" — errado: tocou a janela [renomeada
  `monthWindow`], os dois `$dateTrunc` [rollup diário + rebuild do cubo],
  `monthKeyOf`/quarentena, `resolvePeriodStatus`, a projeção, a escada do
  daily lens, o pager do fechamento, o dia do cubo de facetas e os
  formatters de exibição. O snapshot grava o fuso; re-close sob fuso
  diferente é recusado — mudança de fuso é forward-only.)
- Exportação nativa XLSX/PDF (hoje: CSV + print view). **Confirmar se basta.**
- US9/US13/US14/US16 não existem na planilha recebida (numeração pula) —
  nada implementado para elas.
- Alerta/notificação de fechamento (US5) = saída de job + endpoint; sem
  e-mail/push (fora do escopo v1 na planilha).
- Escala: o motor materializa os usage records do mês em memória no
  fechamento e no extrato ao vivo. OK para a escala PoC/demo; o caminho de
  evolução (agregação incremental no Mongo) está anotado no código.
