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
