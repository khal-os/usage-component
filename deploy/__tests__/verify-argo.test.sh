#!/usr/bin/env bash
# TESTE DO GATE — deploy/verify-argo.sh e a UNICA prova de que o digest que esta
# no git virou container rodando. Um gate so vale se REPROVAR; por isso a maioria
# dos casos abaixo e de reprovacao, e um deles prova que a propria costura de
# teste e recusada quando a lane exige medida real.
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
cd "$RAIZ"

for bin in git helm python3 jq; do command -v "$bin" >/dev/null || { echo "FALTA: $bin"; exit 1; }; done

TRAB="$(mktemp -d)"; trap 'rm -rf "$TRAB"' EXIT
D_MOD="sha256:$(printf 'a%.0s' $(seq 64))"
D_CON="sha256:$(printf 'b%.0s' $(seq 64))"
D_BAK="sha256:$(printf 'c%.0s' $(seq 64))"
SHA1="$(printf 'd%.0s' $(seq 40))"
BLOCO="{\"usage-module\":\"${D_MOD}\",\"usage-connector\":\"${D_CON}\",\"usage-db-backup\":\"${D_BAK}\"}"
REG="278522730053.dkr.ecr.sa-east-1.amazonaws.com/kos"

# ── repo de trabalho com um commit de pin de verdade ────────────────────────
W="${TRAB}/work"
mkdir -p "$W/deploy"
git init -q --bare "${TRAB}/remote"
cp -R deploy/chart "$W/deploy/chart"
cp deploy/values.yaml deploy/values-*.yaml deploy/services.sh deploy/gitops-pin.sh deploy/verify-argo.sh "$W/deploy/"
( cd "$W" && git init -q -b eks/dev . && git config user.email t@t && git config user.name teste \
    && git add -A && git commit -q -m init && git remote add origin "${TRAB}/remote" )
( cd "$W" && GITOPS_PIN_SKIP_PUSH=1 ./deploy/gitops-pin.sh dev "$BLOCO" "$SHA1" >/dev/null 2>&1 ) \
  || { echo "nao consegui preparar o commit de pin"; exit 1; }
PIN_SHA="$( (cd "$W" && git rev-parse HEAD) )"
PUSH_EPOCH=1700000000

app_json() { # app_json <sync> <health> <revision> <reconciled> <opphase> <imagens...>
  local sync="$1" health="$2" rev="$3" rec="$4" op="$5"; shift 5
  local imgs; imgs="$(printf '%s\n' "$@" | jq -R . | jq -s .)"
  local opjson='null'
  [ "$op" = "-" ] || opjson="{\"phase\":\"${op}\",\"syncResult\":{\"revision\":\"${rev}\"}}"
  jq -n --arg s "$sync" --arg h "$health" --arg r "$rev" --arg rc "$rec" \
        --argjson imgs "$imgs" --argjson op "$opjson" \
    '{status:{sync:{status:$s,revision:$r},health:{status:$h},reconciledAt:$rc,summary:{images:$imgs},operationState:$op}}'
}

# Application MULTI-SOURCE, como o CONTRATO §3 declara: uma source e ESTE repo
# (`path: deploy/chart`) e a outra e o khal-deploy, entrando so como `ref` de
# values. Nesse formato o Argo deixa `.status.sync.revision` VAZIO e publica uma
# revisao por source em `.status.sync.revisions[]`, na ordem de `.spec.sources[]`.
SRC_REPO='{"repoURL":"https://github.com/khal-os/usage-component.git","path":"deploy/chart","targetRevision":"eks/dev"}'
SRC_VALUES='{"repoURL":"https://github.com/khal-os/khal-deploy.git","targetRevision":"dev","ref":"values"}'

# app_multi <indice-da-source-do-repo:0|1> <revisao-do-repo> <revisao-do-khal-deploy> <opphase|-> <imagens...>
app_multi() {
  local idx="$1" rev_repo="$2" rev_values="$3" op="$4"; shift 4
  local imgs; imgs="$(printf '%s\n' "$@" | jq -R . | jq -s .)"
  local sources revisions
  if [ "$idx" = "0" ]; then
    sources="[${SRC_REPO},${SRC_VALUES}]"; revisions="[\"${rev_repo}\",\"${rev_values}\"]"
  else
    sources="[${SRC_VALUES},${SRC_REPO}]"; revisions="[\"${rev_values}\",\"${rev_repo}\"]"
  fi
  local opjson='null'
  [ "$op" = "-" ] || opjson="{\"phase\":\"${op}\",\"syncResult\":{\"revisions\":${revisions}}}"
  jq -n --argjson sources "$sources" --argjson revisions "$revisions" \
        --argjson imgs "$imgs" --argjson op "$opjson" --arg rc "$DEPOIS" \
    '{spec:{sources:$sources},
      status:{sync:{status:"Synced",revision:"",revisions:$revisions},
              health:{status:"Healthy"},reconciledAt:$rc,
              summary:{images:$imgs},operationState:$op}}'
}

gate() { # gate <arquivo-json> [extra env...]
  ( cd "$W" \
    && ARGOCD_FETCH_CMD="cat ${1}" \
       ARGOCD_VERIFY_DEADLINE_SECONDS=1 ARGOCD_VERIFY_INTERVAL_SECONDS=1 \
       ./deploy/verify-argo.sh hv-kos-components-dev dev "$PIN_SHA" "$PUSH_EPOCH" 2>&1 )
}

TODAS=("${REG}/usage-module@${D_MOD}" "${REG}/usage-connector@${D_CON}" "${REG}/usage-db-backup@${D_BAK}")
DEPOIS="2023-11-14T22:15:00Z"   # > 1700000000
ANTES="2023-11-14T21:00:00Z"    # < 1700000000

titulo "aprova quando TUDO bate"
app_json Synced Healthy "$PIN_SHA" "$DEPOIS" Succeeded "${TODAS[@]}" > "${TRAB}/ok.json"
SAIDA="$(gate "${TRAB}/ok.json")"
contem "aprovado" "APROVADO" "$SAIDA"
contem "le a revisao do formato single-source" "Application single-source" "$SAIDA"
contem "conta as tres imagens" "3 imagem(ns) esperada(s)" "$SAIDA"
contem "exige VIVAS so as de pod permanente" "2 EXIGIDA(S) VIVA(S)" "$SAIDA"
contem "separa a imagem so de CronJob"       "1 imagem(ns) so em CronJob/Job" "$SAIDA"

titulo "reprova cada criterio, um de cada vez"
app_json OutOfSync Healthy "$PIN_SHA" "$DEPOIS" Succeeded "${TODAS[@]}" > "${TRAB}/1.json"
contem "sync != Synced"      "sync.status=OutOfSync"  "$(gate "${TRAB}/1.json")"
app_json Synced Degraded "$PIN_SHA" "$DEPOIS" Succeeded "${TODAS[@]}" > "${TRAB}/2.json"
contem "health != Healthy"   "health.status=Degraded" "$(gate "${TRAB}/2.json")"
app_json Synced Healthy "$(printf '9%.0s' $(seq 40))" "$DEPOIS" Succeeded "${TODAS[@]}" > "${TRAB}/3.json"
contem "revisao diferente"   "sync.revision="         "$(gate "${TRAB}/3.json")"
app_json Synced Healthy "$PIN_SHA" "$ANTES" Succeeded "${TODAS[@]}" > "${TRAB}/4.json"
contem "reconciledAt anterior ao push" "nao e posterior ao push" "$(gate "${TRAB}/4.json")"
app_json Synced Healthy "$PIN_SHA" "$DEPOIS" Running "${TODAS[@]}" > "${TRAB}/5.json"
contem "operacao ainda rodando" "operationState.phase=Running" "$(gate "${TRAB}/5.json")"
app_json Synced Healthy "$PIN_SHA" "$DEPOIS" Failed "${TODAS[@]}" > "${TRAB}/6.json"
contem "operacao falhada no pin" "operationState.phase=Failed" "$(gate "${TRAB}/6.json")"

titulo "a imagem que FALTA e a que reprova (conjunto, nao amostra)"
# Este e o caso que uma verificacao de uma imagem so deixaria passar: a api
# converge, o worker fica no digest anterior, e o cluster mistura duas versoes.
app_json Synced Healthy "$PIN_SHA" "$DEPOIS" Succeeded \
  "${REG}/usage-module@${D_MOD}" "${REG}/usage-db-backup@${D_BAK}" > "${TRAB}/7.json"
SAIDA="$(gate "${TRAB}/7.json")"
contem "reprova por imagem faltante" "faltam em .status.summary.images" "$SAIDA"
contem "diz QUAL faltou"             "usage-connector@${D_CON}"          "$SAIDA"

titulo "a imagem que so existe em CronJob NAO e criterio de vivacidade"
# `.status.summary.images` e um retrato dos PODS da arvore de recursos. O CronJob
# de backup roda 07:00: no instante do sync ele nao tem pod nenhum, e o digest
# dele nao aparece ali. Exigi-lo transformava TODO primeiro deploy (e toda
# promocao que mude o digest do backup) em 900s de espera seguidos de reprovacao
# de um deploy que deu certo. Aqui o gate tem de APROVAR — e dizer, na evidencia,
# que aquela imagem esta DECLARADA e nao foi medida viva.
app_json Synced Healthy "$PIN_SHA" "$DEPOIS" Succeeded \
  "${REG}/usage-module@${D_MOD}" "${REG}/usage-connector@${D_CON}" > "${TRAB}/8.json"
SAIDA="$(gate "${TRAB}/8.json")"
contem "aprova sem o digest do CronJob" "APROVADO" "$SAIDA"
contem "registra o digest do CronJob como sem pod agora" "sem pod agora: \`${REG}/usage-db-backup@${D_BAK}\`" "$SAIDA"
nao_contem "nao reprova por causa do CronJob" "REPROVADO" "$SAIDA"

titulo "a evidencia distingue declarada-com-pod de declarada-sem-pod"
# Quando o pod do backup existe (a janela em que o Job da noite ainda esta na
# arvore), a mesma imagem aparece do outro lado da evidencia.
SAIDA="$(gate "${TRAB}/ok.json")"
contem "ja com pod cita o backup" "ja com pod: \`${REG}/usage-db-backup@${D_BAK}\`" "$SAIDA"

titulo "MULTI-SOURCE: a revisao vem de revisions[<indice da source do repo>]"
# O bug que este bloco fecha: com duas sources o Argo deixa `.status.sync.revision`
# VAZIO. Lendo aquele campo o gate nunca via o pin, queimava os 900 s do deadline
# e REPROVAVA um deploy correto — a pior forma de falso vermelho, porque parece
# problema de cluster.
VIVAS=("${REG}/usage-module@${D_MOD}" "${REG}/usage-connector@${D_CON}")
app_multi 1 "$PIN_SHA" "$(printf '7%.0s' $(seq 40))" Succeeded "${VIVAS[@]}" > "${TRAB}/m1.json"
SAIDA="$(gate "${TRAB}/m1.json")"
contem "aprova com revision vazio e revisions[1] == pin" "APROVADO" "$SAIDA"
contem "diz que a Application e multi-source"  "Application MULTI-SOURCE (2 sources)" "$SAIDA"
contem "nomeia o campo lido"                   "sync.revisions[1]"                    "$SAIDA"
contem "nomeia a source casada"                "usage-component"                      "$SAIDA"
nao_contem "nao reprova"                       "REPROVADO"                            "$SAIDA"

titulo "MULTI-SOURCE: a ordem das sources nao e assumida"
# `path: deploy/chart` primeiro, `ref: values` depois — o indice muda, e o gate
# tem de casar pelo repoURL, nao pela posicao.
app_multi 0 "$PIN_SHA" "$(printf '7%.0s' $(seq 40))" Succeeded "${VIVAS[@]}" > "${TRAB}/m2.json"
SAIDA="$(gate "${TRAB}/m2.json")"
contem "aprova com a source do repo no indice 0" "APROVADO"          "$SAIDA"
contem "e le revisions[0]"                       "sync.revisions[0]" "$SAIDA"

titulo "MULTI-SOURCE: a revisao da OUTRA source nao serve de aprovacao"
# Este e o caso que uma leitura "pega a primeira revisao que bater" deixaria
# passar: o khal-deploy pode estar no commit do pin por coincidencia (mesmo
# repo de values para varios apps), e o CHART continuar na revisao anterior.
app_multi 1 "$(printf '8%.0s' $(seq 40))" "$PIN_SHA" Succeeded "${VIVAS[@]}" > "${TRAB}/m3.json"
SAIDA="$(gate "${TRAB}/m3.json")"
contem "reprova quando so a source de values casa o pin" "REPROVADO"         "$SAIDA"
contem "e diz de qual campo leu"                         "sync.revisions[1]" "$SAIDA"

titulo "MULTI-SOURCE: revisions ausente nao vira aprovacao"
# `revision: ""` + `revisions` ausente = o Argo ainda nao publicou revisao
# nenhuma. Vazio nunca satisfaz o criterio.
jq '.status.sync |= (del(.revisions) | .revision = "")' "${TRAB}/m1.json" > "${TRAB}/m4.json"
SAIDA="$(gate "${TRAB}/m4.json")"
contem "reprova por revisao vazia" "sync.revision=<vazio>" "$SAIDA"
nao_contem "nao aprova"            "APROVADO"              "$SAIDA"

titulo "MULTI-SOURCE: nenhuma source casa este repo"
SAIDA="$( (cd "$W" && ARGOCD_FETCH_CMD="cat ${TRAB}/m1.json" ARGOCD_APP_REPO_MATCH="outro-repo-qualquer" \
  ARGOCD_VERIFY_DEADLINE_SECONDS=1 ARGOCD_VERIFY_INTERVAL_SECONDS=1 \
  ./deploy/verify-argo.sh hv-kos-components-dev dev "$PIN_SHA" "$PUSH_EPOCH" 2>&1) )"
contem "falha dizendo que nao achou a source" "NENHUMA casa" "$SAIDA"
contem "e lista as sources declaradas"        "khal-deploy"  "$SAIDA"

titulo "MULTI-SOURCE: operacao falhada e lida de syncResult.revisions[]"
app_multi 1 "$PIN_SHA" "$(printf '7%.0s' $(seq 40))" Failed "${VIVAS[@]}" > "${TRAB}/m5.json"
SAIDA="$(gate "${TRAB}/m5.json")"
contem "falha rapida pela operacao do pin" "operationState.phase=Failed" "$SAIDA"

titulo "sem credencial o gate REPROVA (nunca pula)"
SAIDA="$( (cd "$W" && ARGOCD_VERIFY_DEADLINE_SECONDS=1 ARGOCD_VERIFY_INTERVAL_SECONDS=1 \
  ./deploy/verify-argo.sh hv-kos-components-dev dev "$PIN_SHA" "$PUSH_EPOCH" 2>&1 ) )"
contem "exige ARGOCD_CI_TOKEN" "ARGOCD_CI_TOKEN nao esta cadastrado" "$SAIDA"

titulo "a costura de teste e recusada quando a lane exige medida real"
SAIDA="$( (cd "$W" && ARGOCD_FETCH_CMD="cat ${TRAB}/ok.json" ARGOCD_VERIFY_REQUIRE_LIVE=1 \
  ARGOCD_VERIFY_DEADLINE_SECONDS=1 ./deploy/verify-argo.sh hv-kos-components-dev dev "$PIN_SHA" "$PUSH_EPOCH" 2>&1 ) )"
contem "REQUIRE_LIVE recusa a costura" "so aceita a API real" "$SAIDA"

titulo "argumentos invalidos"
SAIDA="$( (cd "$W" && ./deploy/verify-argo.sh app producao "$PIN_SHA" "$PUSH_EPOCH" 2>&1) )"
contem "ambiente invalido" "ambiente invalido" "$SAIDA"
SAIDA="$( (cd "$W" && ./deploy/verify-argo.sh app dev sha-curto "$PUSH_EPOCH" 2>&1) )"
contem "pin-sha invalido" "40 hex" "$SAIDA"

titulo "commit de pin inexistente no clone"
SAIDA="$( (cd "$W" && ARGOCD_FETCH_CMD="cat ${TRAB}/ok.json" ARGOCD_VERIFY_DEADLINE_SECONDS=1 \
  ./deploy/verify-argo.sh hv-kos-components-dev dev "$(printf 'f%.0s' $(seq 40))" "$PUSH_EPOCH" 2>&1) )"
contem "avisa clone raso" "nao existe neste clone" "$SAIDA"

encerra "verify-argo"
