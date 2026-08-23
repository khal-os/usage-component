# Stream C — `usage-component` na esteira EKS (surface `kos`, grupo `components`)

Branch local: **`eks/dev`** (a partir de `origin/main`). **Nenhum push foi feito.**
Nenhum arquivo pre-existente foi modificado ou removido — o teste
`deploy/__tests__/lanes.test.sh` prova isso comparando o working tree com
`origin/main` (CONTRATO §0.1).

---

## 1. O que foi entregue

```
deploy/
  chart/                        chart `kos-components` 0.1.0 (generico, forma do Padrao §5)
    Chart.yaml
    values.yaml                 defaults do chart (presets, ESO, borda) — a FORMA vive fora
    values.schema.json          o contrato executavel dos values
    templates/
      _helpers.tpl              imagem (so digest), gitSha, presets, env, paths de secret, probes
      deployment.yaml           Deployment por servico (probes, Reloader, envFrom, non-root, tmpDir)
      service.yaml              ClusterIP so para quem expoe porta
      serviceaccount.yaml       SA por workload; annotation IRSA quando declarado
      externalsecret.yaml       1 ExternalSecret por workload, N `extract`, defaults do CRD explicitos
      ingress.yaml              1 Ingress por host, IngressGroup do ambiente, SEM certificate-arn
      networkpolicy.yaml        borda (ipBlock das subnets do ALB) + egress (DNS/443/extraEgress)
      pdb.yaml                  PDB quando replicas>1 ou strategy Recreate
      job-migrations.yaml       Job hook PreSync, backoffLimit 0, activeDeadlineSeconds
      cronjob.yaml              CronJob com timeZone explicito
      hpa.yaml                  opcional, desligado; recusa HPA em servico Recreate
      NOTES.txt
  values.yaml                   FORMA, 100% comentada (servicos, envs, secrets, imagens)
  values-dev.yaml               pins + hosts + replicas + envOverride de DEV
  values-hml.yaml               idem HML
  values-prod.yaml              idem PROD
  values.schema.json            symlink -> chart/values.schema.json (ver Decisao D2)
  services.sh                   a lista: images / matrix / repos / workloads (+ guard de coerencia)
  gitops-pin.sh                 escreve o BLOCO de pins e commita (1 arquivo, guards de render)
  verify-argo.sh                o gate: Synced+Healthy+revision+CONJUNTO de digests, sem skip
  bootstrap-eks-repo.sh         branches eks/*, vars, Environment prod-eks, auditoria (dry-run)
  __tests__/                    5 suites, 186 asserces (run-all.sh)
    fixtures/                   pins validos + 6 fixtures INVALIDAS (uma por forma de errar)
.github/workflows/
  eks-ci.yml                    contrato do chart + scripts + actionlint + gitleaks
  eks-deploy-dev.yml            UNICA lane que builda (matrix de 3 imagens) -> pin -> gate
  eks-deploy-homolog.yml        promove de eks/dev por digest, 5 guards, retag hml-
  eks-deploy-main.yml           promove de eks/homolog, duplo gate + environment prod-eks
```

### Os cinco workloads (CONTRATO §5, PLANO §3.2)

| workload | kind | imagem | replicas | strategy | probes | grace | outros |
|---|---|---|---|---|---|---|---|
| `api` | Deployment | `usage-module` | 1 dev/hml, **2 prod** | RollingUpdate (surge 1 / unavail 0) | http `/api/v1/docs/openapi.json` | 30 s | Ingress `api-<env>.hapvida.khal.ai`, preset M, PDB em prod |
| `trace-ingestion-worker` | Deployment | `usage-connector` | 1 | **Recreate** | exec `stat /tmp/trace-ingestion-heartbeat` | 60 s | PDB `maxUnavailable: 0`, egress 8123 -> `kos-langwatch-<hml\|prod>` |
| `billing-close-scheduler` | Deployment | `usage-module` | 1 | **Recreate** | exec `stat /tmp/billing-close-heartbeat` | 60 s | **`enabled: false`** por padrao (decisao 131 e opt-in) |
| `migrations` | Job (hook **PreSync**) | `usage-module` | — | — | exit 0 | 30 s | `backoffLimit: 0`, `activeDeadlineSeconds: 600` |
| `backup` | CronJob | `usage-db-backup` | — | — | exit 0 | — | `0 7 * * *` tz `America/Sao_Paulo`, `restartPolicy: Never`, IRSA `hv-kos-usage-backup-<env>` |

Secrets (ESO, `dataFrom.extract`, "point, don't copy"):
`/hapvida/<env>/kos/components/{app,mongo,langwatch}` — `mongo` e referenciado por
cinco ExternalSecrets e existe UMA vez no Secrets Manager.

Envs por ambiente (`envOverride` em `values-<env>.yaml`):

| chave | dev | hml | prod |
|---|---|---|---|
| `ENVIRONMENT` | `homolog` | `homolog` | `production` |
| `KHAL_AUTH_URL` | `https://auth-dev.hapvida.khal.ai` | `https://auth-hml.hapvida.khal.ai` | `https://auth.hapvida.khal.ai` |
| `LANGWATCH_CLICKHOUSE_URL` | `http://clickhouse.kos-langwatch-hml.svc.cluster.local:8123` | idem | `http://clickhouse.kos-langwatch.svc.cluster.local:8123` |
| `CORS_ALLOWED_ORIGINS` | `https://hapvida-dev.khal.ai,https://*.hapvida.khal.ai` | `https://hapvida-hml.khal.ai,…` | `https://hapvida.khal.ai,…` |
| `MONGO_USAGE_DB_NAME` | `hapvida_dev` | `hapvida_hml` | `hapvida` |
| `BACKUP_BUCKET` | `hv-kos-usage-backup-dev` | `-hml` | `-prod` |

`CLIENT_TIMEZONE=America/Sao_Paulo`, `CLIENT_NAME=hapvida`, `KHAL_TENANT=hapvida`,
`KHAL_TOKEN_AUDIENCE=tracing,billing`, `MONGO_DB_ATLAS=true`, `LOG_LEVEL/FORMAT`
sao iguais em todo ambiente e vivem em `deploy/values.yaml`.

---

## 2. Decisoes (e por que)

**D1 — non-root pelo chart, Dockerfiles intactos.**
Os tres Dockerfiles (`docker/module.Dockerfile`, `docker/connector.Dockerfile`,
`docker/usage-db-backup.Dockerfile`) nao declaram `USER`. As duas saidas eram
criar `deploy/docker/*.Dockerfile` novos com `USER 1000` ou por
`securityContext` no chart. **Escolhi o chart** por tres razoes: (a) o proprio
enunciado da esteira manda a lane buildar EXATAMENTE esses tres arquivos, entao
um Dockerfile paralelo nasceria orfao e um dos dois envelheceria sem ninguem
notar; (b) duplicar um Dockerfile de 60 linhas com comentarios de auditoria
(vendor-leak G-5) e duplicar a auditoria junto; (c) o `runAsUser`/`runAsGroup`/
`fsGroup: 1000` + `runAsNonRoot: true` no pod ja garante o mesmo efeito
observavel, e vale para as imagens de hoje E para as futuras. Os workloads que
precisam escrever tem `readOnlyRootFilesystem: true` + `emptyDir` em `/tmp`; o
backup ganha `HOME=/tmp` porque a aws-cli quer HOME gravavel (o `mongodump`
escreve o archive em stdout, nunca em disco).
**Follow-up registrado**: acrescentar `USER 1000` aos tres Dockerfiles no
cutover, quando o time do app puder tocar neles.

**D2 — `deploy/values.schema.json` e um symlink para `chart/values.schema.json`.**
O CONTRATO §5 pede o arquivo em `deploy/`; o Helm so aplica a schema quando ela
esta na RAIZ DO CHART. Manter duas copias seria garantir que uma envelheca.
O arquivo real esta em `deploy/chart/values.schema.json` (onde o Helm — e o Argo
— a aplicam de verdade) e `deploy/values.schema.json` aponta para ele.

**D3 — o pin e um bloco `pins:` por NOME DE IMAGEM, nao um campo por servico.**
Cinco workloads compartilham tres imagens. Se o pin fosse `services.<n>.image.digest`,
`values-<env>.yaml` repetiria o mesmo digest tres vezes e um re-pin parcial
deixaria a api nova falando com o schema velho. O chart resolve
`services.<n>.image.name -> pins[name]`, com override por servico ainda
disponivel (nao usado). `gitops-pin.sh` recusa bloco PARCIAL: o pin e do conjunto.

**D4 — `env:` (lista) na forma, `envOverride:` (mapa) no ambiente.**
O Helm SUBSTITUI listas em vez de mesclar. Se o ambiente tivesse de redeclarar a
lista inteira para trocar uma URL, um dia alguem esqueceria metade dela e o pod
subiria com defaults invisiveis. A saida do template sai ordenada por nome —
render nao-deterministico transforma todo diff do Argo em ruido.

**D5 — `secrets: [app, mongo]` relativo + `secretsPathPrefix` por ambiente.**
Mesma razao: evita repetir os tres paths completos em tres arquivos.

**D6 — readiness da api = `/api/v1/docs/openapi.json`.**
`/api/v1/docs` (sem barra) responde **301**; o kubelet aceita 3xx mas o ALB so
aceita 200 por padrao, entao os dois lados apontam para o `openapi.json`, que
responde 200 e continua ABERTO com o gate de sessao ligado. Liveness aponta para
o mesmo path DE PROPOSITO: ele nao toca o Mongo, entao uma queda do banco nao
reinicia os pods em laco. Ver PENDENTE-1.

**D7 — `CORS_ALLOWED_ORIGINS` = apex + wildcard de um label.**
O parser do app (`packages/module/src/main/server/middlewares/cors.ts`) aceita
`https://*.<dominio>` casando EXATAMENTE um label (como DNS/ACM) e RECUSA `*` nu
e `http://`. O apex do desktop (`hapvida-dev.khal.ai`) esta fora de
`*.hapvida.khal.ai`, dai as duas entradas.

**D8 — `namespace` fica vazio no chart e nos values.**
Quem manda e o `destination.namespace` da Application. Para renderizar local,
use `--namespace kos-components-<env>` (prod: `kos-components`). O teste
`chart-contract` reprova qualquer `namespace: kos-components…` hardcodado nos
templates.

**D9 — placeholder de digest falha FECHADO.**
`values-<env>.yaml` nasce com `sha256:` + 64 zeros. O chart RECUSA renderizar
com ele, dizendo que a branch nunca foi buildada. E por isso que o CI renderiza
com a fixture `deploy/__tests__/fixtures/pins-valid.yaml`, e por isso que o
proprio CI prova que sem a fixture o render falha.

---

## 3. Como validar (nenhum comando toca nuvem)

```bash
cd ~/Deploy/Platform/repos/usage-component

# a suite inteira (o mesmo comando que o eks-ci roda)
bash deploy/__tests__/run-all.sh

# chart, isolado
helm lint deploy/chart -f deploy/values.yaml -f deploy/values-dev.yaml \
                       -f deploy/__tests__/fixtures/pins-valid.yaml
helm template kos-components deploy/chart --namespace kos-components-dev \
  -f deploy/values.yaml -f deploy/values-dev.yaml \
  -f deploy/__tests__/fixtures/pins-valid.yaml

# prova de que o placeholder falha fechado (SEM a fixture)
helm template kos-components deploy/chart --namespace kos-components-dev \
  -f deploy/values.yaml -f deploy/values-dev.yaml    # -> erro "PLACEHOLDER"

# lanes e segredos
actionlint .github/workflows/eks-*.yml
gitleaks detect --no-banner --redact --exit-code 1

# a lista que as lanes usam
deploy/services.sh images
deploy/services.sh workloads

# bootstrap (DRY-RUN; so faz leitura no GitHub)
deploy/bootstrap-eks-repo.sh khal-os/usage-component
```

### Evidencia (rodado em 2026-08-23)

Ferramentas: `helm v3.16.3`, `node v22.22.3`, `actionlint 1.7.12`,
`gitleaks 8.21.2`, `python3 3.12.3 + PyYAML 6.0.1`, `jq 1.7`.

```
$ bash deploy/__tests__/run-all.sh
############ services ############
-- services: 15 ok, 0 falha(s)
############ chart-contract ############
-- chart-contract: 57 ok, 0 falha(s)
############ gitops-pin ############
-- gitops-pin: 27 ok, 0 falha(s)
############ verify-argo ############
-- verify-argo: 15 ok, 0 falha(s)
############ lanes ############
-- lanes: 72 ok, 0 falha(s)
TODAS as suites passaram.                       (186 asserces)

$ helm lint deploy/chart -f deploy/values.yaml -f deploy/values-dev.yaml -f deploy/__tests__/fixtures/pins-valid.yaml
==> Linting deploy/chart
[INFO] Chart.yaml: icon is recommended
1 chart(s) linted, 0 chart(s) failed

$ helm template … (objetos renderizados por ambiente)
dev :  1 CronJob  2 Deployment  4 ExternalSecret  1 Ingress  1 Job  5 NetworkPolicy  1 PDB  1 Service  4 ServiceAccount
hml :  1 CronJob  2 Deployment  4 ExternalSecret  1 Ingress  1 Job  5 NetworkPolicy  1 PDB  1 Service  4 ServiceAccount
prod:  1 CronJob  2 Deployment  4 ExternalSecret  1 Ingress  1 Job  5 NetworkPolicy  2 PDB  1 Service  4 ServiceAccount
  (0 `kind: Secret`, 0 `imagePullSecrets` nos tres — asserido pelo teste)

$ helm template … sem a fixture de pins        # prova de fail-closed
Error: execution error at (kos-components/templates/job-migrations.yaml:…):
servico/carga 'migrations': digest e o PLACEHOLDER (sha256:0000…0000).
Esta branch nunca foi buildada; a lane dev tem de rodar antes.

$ actionlint .github/workflows/eks-ci.yml .github/workflows/eks-deploy-dev.yml \
             .github/workflows/eks-deploy-homolog.yml .github/workflows/eks-deploy-main.yml
(sem saida — 0 achados)

$ gitleaks detect --no-banner --redact --exit-code 1
INF 303 commits scanned.
INF no leaks found

$ bash deploy/scripts/check-config-secrets.sh      # gate de pre-commit do repo
config-secrets: clean (8 files)

$ git diff --name-status origin/main -- . | awk '$1 != "A"'
(vazio — nada pre-existente foi modificado ou removido)
```

O que as 6 fixtures invalidas provam que a `values.schema.json` REPROVA:
segredo literal em `envOverride` (`MONGO_DB_PASSWORD`), servico sem
`health.readiness`, `preset` junto de `resources`, "digest" que e uma tag,
repositorio fora de `<conta>.dkr.ecr.<regiao>.amazonaws.com/kos/<nome>`, e
`certificate-arn` nas annotations do Ingress do app.

**Nao rodado, e por que**: `npm run typecheck` / `npm test` — nenhum arquivo de
`packages/**` foi tocado (a esteira nao muda codigo de aplicacao). `tofu` — nao
ha Terraform nesta stream (e da stream A). Nenhum comando `aws`, `kubectl`, `gh`
de escrita foi executado; `gh api` foi usado apenas em LEITURA, para resolver as
tags das actions nos SHAs de 40 hex que os workflows pinam.

---

## 4. PENDENTES

**PENDENTE-1 — health contract do modulo (`/healthz`, `/readyz`, `/api/version`).**
Nao implementado. O CONTRATO §5 permite "usar o que existe e registrar
follow-up", e implementar exigiria editar
`packages/module/src/main/server/app.ts` (registro das rotas), que e arquivo da
esteira ATUAL — proibido nesta fase (§0.1). Efeito hoje: o readiness da api nao
toca o Mongo, entao um pod com banco inacessivel entra no Service e devolve erro
no primeiro request em vez de ficar fora do balanceamento.
*Proposta para quando a janela abrir*: arquivo novo
`packages/module/src/main/server/routes/health.ts` exportando um `Router` com
`/healthz` (200 seco), `/readyz` (`db.admin().ping()` com timeout curto,
fail-closed) e `/api/version` (`{ gitSha: process.env.GIT_SHA }` — o chart ja
injeta `GIT_SHA` em todo workload), mais UMA linha de `app.use(...)`. Depois:
trocar `health.readiness.path` e `ingress.healthcheckPath` em
`deploy/values.yaml` e preencher `health.version`.

**PENDENTE-2 — `LANGWATCH_PROJECT_ID` via SSM ParameterStore.**
O CONTRATO §4 lista `SSM /hapvida/<env>/kos/components/langwatch-project-id`, mas
um `ExternalSecret` com provider ParameterStore exige um **ClusterSecretStore
proprio** (`hapvida-dev`/`hapvida-prod` apontam para o Secrets Manager) e a
policy do ESO precisa de `ssm:GetParameter`. Nenhuma das duas coisas existe, e
criar CSS e da stream A/foundation. **Por ora** `LANGWATCH_PROJECT_ID` entra no
JSON `/hapvida/<env>/kos/components/langwatch`, junto de
`LANGWATCH_CLICKHOUSE_PASSWORD`. Quando o CSS de ParameterStore existir, basta
somar um segundo path a `services.trace-ingestion-worker.secrets` — o chart ja
renderiza N `extract` por workload.
⚠ O parser do connector trata `LANGWATCH_PROJECT_ID` em branco como UNSET (o
placeholder do SSM era `" "`), e sem ele o worker fica **ocioso** em vez de
ingerir errado. O comportamento e seguro; a omissao e visivel no log de boot.

**PENDENTE-3 — nomes de bucket e de role de IRSA a confirmar com a stream A.**
`BACKUP_BUCKET=hv-kos-usage-backup-<env>` foi ASSUMIDO (o CONTRATO §8 nomeia a
role `hv-kos-usage-backup-<env>` mas nao o bucket). Se o modulo
`kos-client-foundation` batizar diferente, muda uma linha em cada
`values-<env>.yaml`.

**PENDENTE-4 — `MONGO_USAGE_DB_NAME` por ambiente.**
`hapvida_dev` / `hapvida_hml` / `hapvida` foi ASSUMIDO: dev e hml compartilham o
cluster Atlas de hml (PLANO §4.3), entao os bancos precisam diferir. Confirmar
com o modulo `atlas-usage` (stream A) — a decisao 139 exige o nome DECLARADO, e
um nome errado nao falha: ele arquiva no lugar errado.

**PENDENTE-5 — probe de heartbeat mede EXISTENCIA, nao FRESCOR.**
O compose compara a idade do arquivo contra `2x intervalo + 120s`. Aqui o probe
e `stat` puro: um worker que travou DEPOIS do primeiro batch continua "vivo"
para o kubelet. Aritmetica de data dentro de `sh -c` num probe e fragil de ler e
de manter, e a alternativa boa e a mesma do PENDENTE-1 (um `/readyz` honesto no
proprio processo). Ate la, a deteccao real de stall continua sendo o alarme de
ingestao, nao o kubelet.

**PENDENTE-6 — `valueFiles` do Argo apontam para fora do `path` do chart.**
O chart esta em `deploy/chart` e os values em `deploy/values*.yaml`, como o
CONTRATO §5 manda. A Application (stream E) precisa referenciar
`../values.yaml` e `../values-<env>.yaml` — ou usar uma source `ref` do proprio
repo. Se a versao do Argo CD recusar o caminho relativo para fora do `path`, a
correcao mais barata e mover o `path` da source para `deploy/` e passar
`helm.chartPath`/`valueFiles` a partir dali. Precisa ser exercitado por quem
aplica a Application.

**PENDENTE-7 — Node 26 x Node 22.**
`.nvmrc` diz `26`, `package.json` diz `engines.node >= 22`, e os Dockerfiles
usam `node:26-alpine`. Validei com o Node disponivel (`v22.22.3`), o que e
suficiente porque **nenhum codigo de aplicacao foi tocado nem compilado** nesta
stream. As lanes tambem nao instalam Node: elas so buildam a imagem, onde a
versao vem do proprio Dockerfile.

**PENDENTE-8 — `USER 1000` nos tres Dockerfiles.**
Ver D1. Hoje o non-root vem do `securityContext`; a imagem em si ainda roda como
root se alguem a executar fora deste chart.

**PENDENTE-9 — `bootstrap-eks-repo.sh` nunca foi executado.**
Nem em dry-run: qualquer execucao faz chamadas ao GitHub, e esta fase e de
mutacao externa ZERO. So passou por `bash -n`. A primeira execucao deve ser
`deploy/bootstrap-eks-repo.sh khal-os/usage-component` (sem `--apply`).

---

## 5. Ordem de armar (quando a fase de publicacao abrir)

1. Stream A cria os tres repositorios ECR em `278522730053` (IMMUTABLE,
   scanOnPush, repository policy de pull para `701016785827` e `652197205677`) e
   a role `gha-kos-usage-component-ecr-push`.
2. `deploy/bootstrap-eks-repo.sh khal-os/usage-component --reviewers <a>,<b>`
   (dry-run) e depois `--apply`. **Sem `--arm`.**
3. Secrets Manager: `/hapvida/dev/kos/components/{app,mongo,langwatch}` (JSON por
   servico; `langwatch` carrega `LANGWATCH_CLICKHOUSE_PASSWORD` e, por ora,
   `LANGWATCH_PROJECT_ID`). Policy do ESO e `conditions.namespaces` do
   ClusterSecretStore recebem `kos-components-dev` — **aditivo, lendo o vivo**.
4. Reloader `--namespaces` += `kos-components-dev` (aditivo, lendo o vivo).
5. Stream E aplica AppProject `kos-hapvida` e a Application
   `hv-kos-components-dev`; conta `ci-kos-verify` no Argo -> `ARGOCD_CI_TOKEN`.
6. `gh variable set KOS_EKS_PUBLISH_ENABLED true` -> primeiro run por
   `workflow_dispatch` na `eks/dev` (o placeholder faz a Application ficar
   OutOfSync ate o primeiro pin, o que e o comportamento desejado).
7. So depois: `eks/homolog`, e por ultimo `KOS_EKS_PROD_ENABLED` + `eks/main`.
