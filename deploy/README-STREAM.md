# Stream C — `usage-component` na esteira EKS (surface `kos`, grupo `components`)

Branch local: **`eks/dev`** (a partir de `origin/main`). **Nenhum push foi feito.**
Nenhum arquivo pre-existente foi modificado ou removido — o teste
`deploy/__tests__/lanes.test.sh` prova isso comparando o working tree com
`origin/main` (CONTRATO §0.1).

**Passe de correcao (revisao de 2026-08-23)** — o que mudou depois da revisao,
com o "porque" em D10-D13 e os follow-ups em PENDENTE-10/11/12:

| achado | onde | correcao |
| --- | --- | --- |
| gate exigia VIVA a imagem que so existe no CronJob de backup → REPROVARIA todo primeiro sync | `deploy/verify-argo.sh` | exige vivas so `Deployment`/`StatefulSet`/`DaemonSet`; `Job`/`CronJob` viram evidencia declarada (D10) |
| PDB `maxUnavailable: 0` proibia eviction para sempre (contra PLANO §7 risco 3) | `deploy/chart/templates/pdb.yaml` | sempre `maxUnavailable: 1` (D11) |
| nada reprovava `replicas > 1` com `strategy: Recreate` | `deploy/chart/values.schema.json` | `definitions.singleton` + fixture `bad-recreate-replicas.yaml` (D11) |
| `eks-ci` em `deploy/**` levava o guard §0.1 para PRs da esteira ECS | `.github/workflows/eks-ci.yml`, `deploy/__tests__/lanes.test.sh` | gatilho estreitado + guard medido so em `eks/**` (D12) |
| `HOLD` so era lido depois do build/retag | as 3 lanes de deploy | primeiro passo de cada lane, antes do OIDC (D13) |
| `envFrom` sem guarda: servico sem `secrets:` ficava em `CreateContainerConfigError` | `deployment.yaml`, `job-migrations.yaml`, `cronjob.yaml` | `envFrom` e annotation do Reloader sob `if .secrets` + fixture `svc-sem-secrets.yaml` |
| dependencia do worker no LangWatch reprovava um deploy correto da api | `deploy/values.yaml`, `deploy/values-dev.yaml` | ordem declarada como pre-requisito BLOQUEANTE (PENDENTE-10) |
| referencia cruzada errada (`PENDENTE-4` no lugar de `PENDENTE-5`) | `deploy/values.yaml` | corrigida |

**Segundo passe de correcao (2026-08-23, tarde)** — dois achados de ORDEM, o
"porque" em D14-D15, e as premissas de nome reunidas na secao 3:

| achado | onde | correcao |
| --- | --- | --- |
| o gate lia `.status.sync.revision`, que a Application **multi-source** deixa VAZIO: o criterio nunca era satisfeito, o deadline de 900 s queimava e um deploy CORRETO era reprovado | `deploy/verify-argo.sh` | casa o INDICE da source pelo `repoURL` deste repo e le `.status.sync.revisions[i]`; single-source continua no campo antigo (D14) |
| o `ExternalSecret` do Job de migracao era recurso COMUM: fase SYNC so comeca depois do PreSync, entao o hook subia com `envFrom` de um Secret que nunca chegaria — `CreateContainerConfigError` ate os 600 s e sync parado | `deploy/chart/templates/externalsecret.yaml` | o ES do Job vira hook da MESMA fase, uma wave ANTES (`-1` x `0`), `hook-delete-policy: BeforeHookCreation` + `creationPolicy: Orphan` para a delecao do hook nao levar o Secret junto (D15) |
| `default` do sprig trata `0` como vazio: uma `syncWave: 0` declarada a mao virava `-1` em silencio | `deploy/chart/templates/externalsecret.yaml` | leitura por `hasKey`, e o chart REPROVA wave do ES `>=` wave do Job (fixture `bad-es-wave.yaml`) (D15) |
| premissas de nome (bucket, DB, ARN) espalhadas pelos PENDENTES | `deploy/README-STREAM.md` | tabela **assumido vs CONTRATO** (secao 3) — nenhum nome novo foi inventado |

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
      externalsecret.yaml       1 ExternalSecret por workload, N `extract`, defaults do CRD explicitos;
                                o ES de Job de hook e ele proprio hook, uma wave antes do Job (D15)
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
  verify-argo.sh                o gate: Synced+Healthy+revisao da source DESTE repo (multi-source, D14)
                                +CONJUNTO de digests de pod permanente, sem skip (D10)
  bootstrap-eks-repo.sh         branches eks/*, vars, Environment prod-eks, auditoria (dry-run)
  __tests__/                    5 suites, 260 asserces (run-all.sh)
    fixtures/                   pins validos + 8 fixtures INVALIDAS (uma por forma de errar)
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
| `trace-ingestion-worker` | Deployment | `usage-connector` | 1 | **Recreate** | exec `stat /tmp/trace-ingestion-heartbeat` | 60 s | PDB `maxUnavailable: 1` (D11), egress 8123 -> `kos-langwatch-<hml\|prod>`; unicidade garantida por `Recreate` + `replicas: 1` + schema |
| `billing-close-scheduler` | Deployment | `usage-module` | 1 | **Recreate** | exec `stat /tmp/billing-close-heartbeat` | 60 s | **`enabled: false`** por padrao (decisao 131 e opt-in) |
| `migrations` | Job (hook **PreSync**, wave `0`) | `usage-module` | — | — | exit 0 | 30 s | `backoffLimit: 0`, `activeDeadlineSeconds: 600`; o ES dele e hook PreSync wave `-1` (D15) |
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

**D10 — o gate do Argo exige VIVAS so as imagens de pod permanente.**
`.status.summary.images` e um retrato dos **pods** da arvore de recursos da
Application. Um `CronJob` `0 7 * * *` nao tem pod nenhum no instante do sync, e
a imagem `usage-db-backup` so aparece nele. Exigir aquele digest ali fazia o
gate queimar os 900 s e REPROVAR o primeiro deploy de cada ambiente — e toda
promocao que mudasse o digest do backup — sem que nada estivesse errado.
`deploy/verify-argo.sh` agora classifica cada `image:` pelo `kind` do documento
renderizado: `Deployment`/`StatefulSet`/`DaemonSet` sao **exigidas vivas** (o
criterio de conjunto continua inteiro para elas: uma faltando reprova); `Job` e
`CronJob` entram como **declaradas** e aparecem em separado na evidencia do step
summary, com a distincao "ja com pod" / "sem pod agora". O `Job` de migracao
entra do lado declarado de proposito: com `hook-delete-policy` (ou
`ttlSecondsAfterFinished`) o pod dele desaparece, e depender disso seria o mesmo
erro do CronJob, so que intermitente. A existencia real desses digests continua
provada — pelo probe autenticado no ECR que a lane faz ANTES do pin.
Provado por teste nos dois sentidos: aprova sem o digest do CronJob; reprova
quando falta o digest de um Deployment.

**D11 — PDB sempre `maxUnavailable: 1`, tambem no singleton.**
A versao anterior usava `maxUnavailable: 0` quando `replicas: 1`, com a intencao
de "parar o drain e pedir decisao humana". Com uma replica isso e literalmente
`minAvailable: 1`: eviction voluntario proibido PARA SEMPRE — `kubectl drain`,
upgrade de nodegroup e consolidacao do Auto Mode (PLANO §2 D13) ficam pendurados
sem avisar ninguem. E contrariava o PLANO §7 (risco 3), que diz `maxUnavailable:
1`. O nao-overlap do singleton nao dependia do PDB: quem garante e `strategy:
Recreate` + `replicas: 1` — e agora a `values.schema.json`, que **reprova**
`replicas > 1` com `Recreate` (`definitions.singleton`). Teste de contrato nos
tres ambientes: nenhum PDB com `maxUnavailable: 0`.

**D12 — o guard do CONTRATO §0.1 mede as branches `eks/**`, e diz quando nao mede.**
O guard compara a arvore inteira com `origin/main` e exige que tudo seja arquivo
`A`. Isso so significa alguma coisa quando o que esta sendo medido e ESTA stream.
Como `deploy/` no `main` e a casa da esteira ECS que serve producao hoje
(`deploy/taskdefs/*.json`, `deploy/scripts/deploy-tenant.sh`, `deploy/tenants/`),
um PR de manutencao daquela esteira acusaria "modificado" um arquivo que esta
stream nunca tocou — check vermelho impossivel de satisfazer. Duas mudancas: (a)
o gatilho de `pull_request` do `eks-ci` observa a arvore desta esteira, nao
`deploy/**`; (b) o guard so mede em `eks/**` e, fora dali, IMPRIME que nao mediu
(nao inventa aprovacao silenciosa). No cutover, quando esta esteira virar A
esteira, os dois voltam para `deploy/**` — num commit que se ve.

**D13 — `HOLD` e lido no PRIMEIRO passo da lane, nao so no `gitops-pin.sh`.**
O `HOLD` continua checado dentro do `gitops-pin.sh` (cinto para quem o chama
fora da lane), mas ele roda no fim: depois do build e do push na lane dev,
depois do retag no ECR nas de promocao. Com repositorio IMMUTABLE, uma tag
publicada durante um freeze nao se desfaz. Agora cada lane le o `HOLD` antes de
assumir a role de OIDC — asserido por ordem de linha no teste das lanes.

**D14 — o gate le a revisao da SOURCE deste repo, nao `.status.sync.revision`.**
As Applications do CONTRATO §3 sao **multi-source**: source do repo do app
(`path: deploy/chart`) + source do `khal-deploy` (os values, entrando como
`ref`). Nesse formato o Argo **nao preenche** `.status.sync.revision` — ele
publica uma revisao POR SOURCE em `.status.sync.revisions[]`, na mesma ordem de
`.spec.sources[]`. O gate lia o campo singular: string vazia, criterio 3 nunca
satisfeito, 900 s de deadline queimados e REPROVACAO de um deploy que estava
certo. E o pior tipo de falso vermelho, porque parece problema de cluster e
manda o plantao procurar no lugar errado.
Correcao: o script resolve UMA vez o **indice** da source cujo `repoURL` e o
deste repo (regex `ARGOCD_APP_REPO_MATCH`, default `usage-component`, casada em
minusculas e sem o `.git` final) e le `revisions[<i>]`. Casar por indice e o
ponto: a revisao da outra source e um commit do `khal-deploy`, de outro git —
comparar aquilo com o nosso pin seria comparar coisas diferentes e aprovar por
coincidencia (o mesmo repo de values serve varios apps). Quando ha mais de uma
source do mesmo repo, ganha a que NAO e mera `ref` e que carrega chart
(`path`/`chart`) — a que o Argo de fato renderiza. Application single-source
continua caindo em `.status.sync.revision`; a leitura e uma so, com fallback, e
**vazio nunca vale** (nem `null`, nem `""`). Se nenhuma source casar o repo, o
gate FALHA na hora listando os `repoURL` declarados — nao ha aprovacao por
ausencia de criterio. `operationState` recebe o mesmo tratamento
(`syncResult.revisions[i]`), senao a falha-rapida da operacao pinada nunca
dispararia em multi-source.
Provado nos dois formatos: aprova single-source; aprova multi-source com
`revision: ""` e `revisions[i]` correta, com a source do repo no indice 1 **e**
no indice 0; REPROVA quando so a source de values casa o pin; REPROVA quando
`revisions` nem existe; FALHA quando nenhuma source e deste repo.

**D15 — o ExternalSecret de um Job de hook e, ele proprio, um hook.**
O Job de migracao e hook `PreSync` e le `/hapvida/<env>/kos/components/{app,mongo}`
por `envFrom` do Secret `migrations-env`. Esse Secret nasce de um
`ExternalSecret` — que era um recurso **comum**, ou seja, da fase **SYNC**. E a
fase SYNC so comeca depois que os hooks PreSync terminam. No primeiro sync de
cada ambiente o pod do hook subia com `envFrom` de um Secret que ainda nao
existia e — pior — que nunca chegaria: `CreateContainerConfigError` ate os 600 s
de `activeDeadlineSeconds`, Job falhado, fase PreSync reprovada, sync inteiro
parado. Nao e flake nem corrida: e deadlock de fase, deterministico.
*Por que nao (a) ES comum + initContainer esperando o Secret*: o initContainer
esperaria pelo mesmo Secret que a fase SYNC — que nao roda enquanto o PreSync
nao terminar. Troca `CreateContainerConfigError` por `Init:0/1` e mantem o
deadlock inteiro.
*Por que nao (c) backoff maior + retry do Argo*: o retry reinicia a operacao **na
fase PreSync**; o ES continua do outro lado da fronteira. Deadlock igual, so que
repetido — e ainda custaria o `backoffLimit: 0`, que existe para migracao falhada
ser diagnostico e nao ser re-tentada sozinha.
*Escolhido (b), com uma emenda*: o ES do Job entra na MESMA fase do Job
(`argocd.argoproj.io/hook: PreSync`) numa **sync-wave anterior** (ES `-1`, Job
`0`). O Argo so abre a wave seguinte quando a anterior esta saudavel, e o Argo CD
tem health check nativo para `external-secrets.io/ExternalSecret` (condicao
`Ready`) — a wave 0 so abre com o Secret materializado. A emenda e o
`creationPolicy`: com `Owner` o ESO poe `ownerReference` no Secret, e o
`hook-delete-policy: BeforeHookCreation` (que e o padrao, e o que se quer, para
o objeto do sync anterior ficar legivel ate o proximo) apagaria o ES e, por
cascata, o **proprio Secret que o Job precisa ler**. Por isso, e so no ES de
hook, `creationPolicy: Orphan`: a delecao do hook nunca alcanca o Secret, ele
sobrevive entre syncs, o ESO continua atualizando enquanto o ES existe, e o Job
encontra credencial valida mesmo se o ESO estiver indisponivel no instante do
sync. `deletionPolicy: Retain` continua, como manda o CONTRATO §4. Os
ExternalSecrets de Deployment e CronJob **nao mudaram**: sem hook, sem wave,
`creationPolicy: Owner`.
*O preco, declarado*: esse Secret nao e coletado quando a Application e apagada
(sem `ownerReference` nao ha GC) — ele some com o namespace. Registrado em
PENDENTE-13.
*Guarda*: o chart REPROVA `esSyncWave >= syncWave` com a mensagem do sintoma
(fixture `bad-es-wave.yaml`), e a leitura das waves e por `hasKey`, porque o
`default` do sprig trata `0` como vazio e transformava uma wave 0 declarada a
mao em `-1` calado. Teste de render nos tres ambientes: hook, delete-policy,
`Orphan`, `Retain`, wave do ES **estritamente menor** que a do Job, e o Job
apontando para aquele mesmo Secret.

---

## 3. Assumido vs CONTRATO (o que o reconciliador tem de bater)

Nenhum nome novo foi inventado nesta correcao — a tabela e um INVENTARIO do que
ja esta nos `deploy/values-<env>.yaml`, separando o que o CONTRATO fixa do que
esta stream teve de assumir porque o contrato nao nomeia. Os canonicos virao do
reconciliador; enquanto isso os valores atuais ficam.

| chave (onde vive) | assumido aqui — dev / hml / prod | o que o CONTRATO diz | veredito |
| --- | --- | --- | --- |
| `secretsPathPrefix` (`values-<env>.yaml`) | `/hapvida/dev/kos/components` · `/hapvida/hml/kos/components` · `/hapvida/prod/kos/components` | §4: paths `/hapvida/<env>/kos/components/{app,mongo,langwatch}` | **CONFERE** — derivado do contrato, nao assumido |
| `externalSecrets.storeName` (`values-<env>.yaml`) | `hapvida-dev` · `hapvida-dev` · `hapvida-prod` | §1/§4: `ClusterSecretStore hapvida-dev` na conta 701 e `hapvida-prod` na 652; o CSS e por CLUSTER, e hml coabita a 701 | **CONFERE** — hml usar `hapvida-dev` e consequencia da coabitacao (§0.6), nao um nome novo |
| host do Ingress da api (`values-<env>.yaml`) | `api-dev.hapvida.khal.ai` · `api-hml.hapvida.khal.ai` · `api.hapvida.khal.ai` | §3, linha "usage api" da tabela de hosts | **CONFERE** |
| `ingressDefaults.groupName` (`values-<env>.yaml`) | `hapvida-dev` · `hapvida-hml` · `hapvida-prod` | §1/§3: IngressGroups por ambiente | **CONFERE** |
| `cronjobs.backup.serviceAccount.irsaRoleArn` (`values-<env>.yaml`) | `arn:aws:iam::701016785827:role/hv-kos-usage-backup-dev` · `…-hml` · `arn:aws:iam::652197205677:role/hv-kos-usage-backup-prod` | §8 nomeia a **role** `hv-kos-usage-backup-<env>`; §1 da as contas. O ARN completo nunca e escrito no contrato | **ASSUMIDO (composicao)** — a role e criada pelo modulo `kos-client-foundation` (stream A). Se o modulo prefixar/sufixar diferente, muda 1 linha por `values-<env>.yaml`; **falha VISIVEL** (o pod do backup nao assume a role) |
| `BACKUP_BUCKET` (`values-<env>.yaml`) | `hv-kos-usage-backup-dev` · `-hml` · `-prod` | o CONTRATO **nao nomeia** o bucket de backup do usage (so o do LangWatch, `hv-kos-langwatch-<env>-objects`, §9) | **ASSUMIDO** — canonico vem do `kos-client-foundation`. Nome errado **nao falha ruidosamente**: ou o `PutObject` nega, ou o backup arquiva no lugar errado |
| `MONGO_USAGE_DB_NAME` (`values-<env>.yaml`) | `hapvida_dev` · `hapvida_hml` · `hapvida` | o CONTRATO **nao define**; §8 so cita o modulo `atlas-usage`. PLANO §4.3: dev e hml dividem o cluster Atlas de hml, logo os bancos TEM de diferir | **ASSUMIDO** — canonico vem do `atlas-usage`. Nome errado nao falha: **arquiva no banco errado** (a decisao 139 exige o nome DECLARADO justamente por isso) |
| `LANGWATCH_PROJECT_ID` (JSON `/hapvida/<env>/kos/components/langwatch`) | no Secrets Manager, junto de `LANGWATCH_CLICKHOUSE_PASSWORD` | §4 lista o parametro **SSM** `/hapvida/<env>/kos/components/langwatch-project-id` | **DIVERGENCIA DECLARADA** — nao ha CSS de ParameterStore nem `ssm:GetParameter` na policy do ESO (PENDENTE-2); some com uma linha em `secrets:` quando existirem |

Onde cada um aparece, para a troca ser mecanica:
`grep -n "secretsPathPrefix\|storeName\|irsaRoleArn\|BACKUP_BUCKET\|MONGO_USAGE_DB_NAME\|host:" deploy/values-{dev,hml,prod}.yaml`.

---

## 4. Como validar (nenhum comando toca nuvem)

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

# a ordem do hook (D15): o ES do migrations tem de sair na wave -1 e o Job na 0
for e in dev hml prod; do
  ns=kos-components-$e; [ "$e" = prod ] && ns=kos-components
  helm template kos-components deploy/chart --namespace "$ns" \
    -f deploy/values.yaml -f "deploy/values-${e}.yaml" \
    -f deploy/__tests__/fixtures/pins-valid.yaml | grep -c 'sync-wave: "-1"'
done                                                # -> 1, 1, 1

# prova de que o chart RECUSA o ES na mesma wave do Job
helm template kos-components deploy/chart --namespace kos-components-dev \
  -f deploy/values.yaml -f deploy/values-dev.yaml \
  -f deploy/__tests__/fixtures/pins-valid.yaml \
  -f deploy/__tests__/fixtures/bad-es-wave.yaml     # -> erro "MENOR que a do Job"

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
$ bash deploy/__tests__/run-all.sh              # apos o SEGUNDO passe (D14/D15)
############ services ############
-- services: 15 ok, 0 falha(s)
############ chart-contract ############
-- chart-contract: 98 ok, 0 falha(s)
############ gitops-pin ############
-- gitops-pin: 27 ok, 0 falha(s)
############ verify-argo ############
-- verify-argo: 36 ok, 0 falha(s)
############ lanes ############
-- lanes: 84 ok, 0 falha(s)
TODAS as suites passaram.                       (260 asserces)

  · as 15 asserces novas de `verify-argo` cobrem os DOIS formatos de Application:
    single-source (`.status.sync.revision`) e multi-source (`revisions[i]`, com a
    source do repo no indice 1 e no indice 0, reprovando quando so a source de
    values casa o pin, quando `revisions` nem existe, e falhando quando nenhuma
    source e deste repo);
  · as 29 novas de `chart-contract` cobrem a ordem PreSync do ExternalSecret do
    Job nos tres ambientes (hook, wave -1 < wave 0, BeforeHookCreation, Orphan,
    Retain), o ES de workload comum inalterado (sem hook, `Owner`) e a recusa de
    `esSyncWave >= syncWave`.

$ helm lint deploy/chart -f deploy/values.yaml -f deploy/values-dev.yaml -f deploy/__tests__/fixtures/pins-valid.yaml
==> Linting deploy/chart
[INFO] Chart.yaml: icon is recommended
1 chart(s) linted, 0 chart(s) failed

$ helm template … (objetos renderizados por ambiente)
dev :  1 CronJob  2 Deployment  4 ExternalSecret  1 Ingress  1 Job  5 NetworkPolicy  1 PDB  1 Service  4 ServiceAccount
hml :  1 CronJob  2 Deployment  4 ExternalSecret  1 Ingress  1 Job  5 NetworkPolicy  1 PDB  1 Service  4 ServiceAccount
prod:  1 CronJob  2 Deployment  4 ExternalSecret  1 Ingress  1 Job  5 NetworkPolicy  2 PDB  1 Service  4 ServiceAccount
  (0 `kind: Secret`, 0 `imagePullSecrets` nos tres — asserido pelo teste)

$ … | grep -B2 sync-wave        # a ordem do hook, nos tres ambientes
Job/migrations           hook: PreSync  hook-delete-policy: BeforeHookCreation  sync-wave: "0"
ExternalSecret/migrations-env  hook: PreSync  hook-delete-policy: BeforeHookCreation  sync-wave: "-1"
                               target: creationPolicy: Orphan  deletionPolicy: Retain
ExternalSecret/{api,trace-ingestion-worker,backup}-env  sem hook, sem wave, creationPolicy: Owner

$ helm template … -f deploy/__tests__/fixtures/bad-es-wave.yaml   # ES na wave do Job
Error: execution error at (kos-components/templates/externalsecret.yaml:99:4):
job 'migrations': a sync-wave do ExternalSecret (0) tem de ser MENOR que a do Job
(0) — senao o hook sobe antes do Secret existir e o pod trava em
CreateContainerConfigError ate o activeDeadlineSeconds

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

O que as fixtures invalidas provam que a `values.schema.json` REPROVA:
segredo literal em `envOverride` (`MONGO_DB_PASSWORD`), servico sem
`health.readiness`, `preset` junto de `resources`, "digest" que e uma tag,
repositorio fora de `<conta>.dkr.ecr.<regiao>.amazonaws.com/kos/<nome>`,
`certificate-arn` nas annotations do Ingress do app, e — nova — **`replicas > 1`
num servico `strategy: Recreate`** (`bad-recreate-replicas.yaml`), que era o
risco 3 do PLANO §7 passando calado. A oitava, `bad-es-wave.yaml`, e a unica
reprovada pelo CHART e nao pela schema: `esSyncWave` igual a `syncWave` poe o
ExternalSecret e o Job de hook na mesma wave, que e o deadlock de fase de D15.
Ha ainda uma fixture VALIDA, `svc-sem-secrets.yaml`: um servico sem `secrets:`,
usada para provar que o chart nao falha ABERTO nesse caso (sem ExternalSecret
nao pode haver `envFrom` de um Secret que ninguem cria).

**Nao rodado, e por que**: `npm run typecheck` / `npm test` — nenhum arquivo de
`packages/**` foi tocado (a esteira nao muda codigo de aplicacao). `tofu` — nao
ha Terraform nesta stream (e da stream A). Nenhum comando `aws`, `kubectl`, `gh`
de escrita foi executado; `gh api` foi usado apenas em LEITURA, para resolver as
tags das actions nos SHAs de 40 hex que os workflows pinam.

---

## 5. PENDENTES

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
(Linha `BACKUP_BUCKET` e linha do `irsaRoleArn` na tabela da secao 3.)
`BACKUP_BUCKET=hv-kos-usage-backup-<env>` foi ASSUMIDO (o CONTRATO §8 nomeia a
role `hv-kos-usage-backup-<env>` mas nao o bucket). Se o modulo
`kos-client-foundation` batizar diferente, muda uma linha em cada
`values-<env>.yaml`.

**PENDENTE-4 — `MONGO_USAGE_DB_NAME` por ambiente.**
(Linha `MONGO_USAGE_DB_NAME` na tabela da secao 3.)
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

**PENDENTE-10 — ORDEM DE SUBIDA: LangWatch ANTES de `kos-components-<env>`.**
**Bloqueante para a stream E.** O `trace-ingestion-worker` depende do ClickHouse
do LangWatch (`kos-langwatch-hml` para dev **e** hml, `kos-langwatch` para prod,
CONTRATO §3). A dependencia NAO e do probe: sem fonte configurada o processo sai
1 de proposito (`packages/connector/src/main/jobs/run-trace-ingestion-loop.ts`,
audit G-1 — "crash loop VISIVEL em vez de ocioso verde"), e com fonte porem sem
ClickHouse alcancavel `assertCompatibleSchema()` e fatal no boot. Nos dois casos
o Deployment nunca fica `Available`, a Application nunca fica `Healthy` e o gate
(sem ramo de skip, 900 s) REPROVA um deploy da api que estava correto.
Por isso `hv-kos-langwatch-hml` tem de estar `Healthy` **antes** do primeiro sync
de `hv-kos-components-dev` (e o mesmo vale para hml e prod).
*Por que nao "desligar o worker em dev e pronto"*: nao ha meia-volta barata. As
lanes de promocao montam o bloco de digests a partir das imagens RENDERIZADAS na
origem, e o `gitops-pin.sh` recusa bloco parcial (o conjunto de `images:` e o
contrato); desligar so este workload num ambiente faria `usage-connector` sumir
do bloco e a promocao falhar. Desligar na FORMA (`deploy/values.yaml`) exigiria
tirar `usage-connector` de `images:` — o que apaga o build da imagem e o guard de
coerencia do `services.sh`. A ordem e o caminho.

**PENDENTE-11 — `gitSha` da promocao != commit que construiu a imagem.**
Nas lanes de hml/prod, `gitops-pin.sh` grava `$GITHUB_SHA` (o commit da branch de
DESTINO) em `pins.<img>.gitSha`, enquanto a tag aplicada no ECR na mesma execucao
usa o commit de ORIGEM (`hml-<SRC_SHA>`). Os dois identificadores do mesmo digest
discordam, e uma forense precisa traduzir na mao. A correcao NAO e trocar um pelo
outro: o guard de frescor da lane seguinte compara `gitSha` contra a ponta da
branch de origem: trocar por `SRC_SHA` o quebraria. O caminho e um campo
`sourceGitSha` ao lado do `gitSha` (schema + escrita no `gitops-pin.sh` + um
campo a mais na evidencia), fora do escopo desta correcao porque muda a FORMA do
bloco de pins, que o CONTRATO §5 descreve.

**PENDENTE-12 — `extraEgress` libera 1024-65535 para o /16 inteiro da VPC.**
A intencao e alcançar as ENIs do PrivateLink do Atlas (o driver do Mongo abre
27017 e portas altas dos membros do replica set), mas o CNI da AWS da aos pods
IPs dessas mesmas faixas: a policy declarada cobre o cluster inteiro. Hoje e
inocuo (enforcement de NetworkPolicy desligado nos dois clusters), e por isso nao
foi estreitado no escuro — o alvo certo sao os `/32` do VPC endpoint, que a
stream A cria. Quando o PrivateLink existir, e uma linha por `values-<env>.yaml`.

**PENDENTE-13 — o Secret `migrations-env` nao e coletado com a Application.**
Consequencia declarada de D15: o `ExternalSecret` do Job de migracao e hook e usa
`creationPolicy: Orphan`, entao o Secret que ele materializa nao tem
`ownerReference` e sobrevive a delecao da Application. Era o preco a pagar — com
`Owner`, o `hook-delete-policy: BeforeHookCreation` apagaria o Secret junto com o
hook, que e exatamente o bug que D15 conserta. Efeito pratico: apagar
`hv-kos-components-<env>` deixa um Secret com credencial de Mongo no namespace
ate alguem apagar o namespace. *Caminho*: se algum dia isso incomodar, o alvo e
um segundo ES **comum** (`Owner`) para o mesmo path, so para dar dono ao Secret —
custa um objeto a mais e nao muda a ordem; nao vale a pena antes de existir um
procedimento de "desativar ambiente".

---

## 6. Ordem de armar (quando a fase de publicacao abrir)

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
5. **LangWatch primeiro** (PENDENTE-10): `hv-kos-langwatch-hml` `Healthy` ANTES
   do primeiro sync de `hv-kos-components-dev` — dev e hml usam o ClickHouse de
   `kos-langwatch-hml`. Sem ele o `trace-ingestion-worker` sai 1 no boot, a
   Application nunca fica `Healthy` e o gate reprova um deploy correto da api.
6. Stream E aplica AppProject `kos-hapvida` e a Application
   `hv-kos-components-dev`; conta `ci-kos-verify` no Argo -> `ARGOCD_CI_TOKEN`.
7. `gh variable set KOS_EKS_PUBLISH_ENABLED true` -> primeiro run por
   `workflow_dispatch` na `eks/dev` (o placeholder faz a Application ficar
   OutOfSync ate o primeiro pin, o que e o comportamento desejado).
8. So depois: `eks/homolog`, e por ultimo `KOS_EKS_PROD_ENABLED` + `eks/main`.
