#!/usr/bin/env bash
# O GATE. Depois que o pin foi empurrado, este script e a UNICA prova de que o
# conjunto de digests que esta no git virou container rodando.
#
#   uso: deploy/verify-argo.sh <application> <dev|hml|prod> <pin-sha-40hex> <epoch-do-push>
#
# NAO EXISTE RAMO DE SKIP. Nenhum `exit 0` por falta de credencial, por 401, por
# timeout ou por "o Argo aplica quando puder". Um gate que passa quando nao
# consegue medir nada nao e um gate — e um carimbo. Sem ARGOCD_CI_TOKEN a lane
# fica VERMELHA ate alguem cadastrar o token.
#
# O que e exigido, tudo junto, dentro de um deadline duro:
#   1. .status.sync.status   == Synced
#   2. .status.health.status == Healthy   (Synced != Healthy: Synced diz que o
#      cluster recebeu o manifesto, nao que o pod subiu)
#   3. .status.sync.revision == o SHA do commit de pin
#   4. TODOS os repo@digest de workload de POD PERMANENTE (Deployment,
#      StatefulSet, DaemonSet) aparecem em .status.summary.images (estado VIVO).
#      Conjunto, nao amostra: este repo tem 3 imagens e 5 workloads; conferir
#      uma so deixaria o worker no digest velho passar.
#      NAO entra no criterio a imagem que so nasce em CronJob/Job: o campo
#      `.status.summary.images` e um retrato dos PODS da arvore de recursos, e um
#      CronJob '0 7 * * *' nao tem pod nenhum no instante do sync. Exigi-la ali
#      REPROVARIA, depois de queimar o deadline inteiro, um deploy que deu certo
#      — que e o modo de falha classico de gate por amostra de pods. Essas
#      imagens sao conferidas como DECLARADAS (o render prova que o CronJob
#      carrega o digest pinado) e reportadas em separado na evidencia; a
#      existencia real delas no registry ja e provada pela lane, no probe
#      autenticado do ECR que precede o pin.
#   5. .status.reconciledAt ESTRITAMENTE posterior ao instante do push
#   6. .status.operationState, quando nao-null, em Succeeded
#
# O conjunto esperado e LIDO DO ARQUIVO DO COMMIT PINADO, nunca de variavel do
# workflow: o script extrai `deploy/` daquele commit e roda `helm template` nele.
# A imagem esperada e, literalmente, o que o Argo vai renderizar. Passar o digest
# por parametro tornaria o gate capaz de aprovar um estado que o git nao
# descreve.
#
# Por que a API do Argo e nao um curl no ALB: o runner do GitHub nao tem rota
# garantida para o ALB (SG fechado), e um timeout de SG e indistinguivel de app
# fora do ar. https://argo.namastex.io passa pela Cloudflare.
set -Eeuo pipefail

APP="${1:?uso: verify-argo.sh <application> <dev|hml|prod> <pin-sha> <epoch-do-push>}"
AMBIENTE="${2:?uso: verify-argo.sh <application> <dev|hml|prod> <pin-sha> <epoch-do-push>}"
PIN_SHA="${3:?uso: verify-argo.sh <application> <dev|hml|prod> <pin-sha> <epoch-do-push>}"
PUSHED_AT="${4:?uso: verify-argo.sh <application> <dev|hml|prod> <pin-sha> <epoch-do-push>}"

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"

ARGOCD_SERVER="${ARGOCD_SERVER:-https://argo.namastex.io}"
DEADLINE_SECONDS="${ARGOCD_VERIFY_DEADLINE_SECONDS:-900}"
INTERVAL_SECONDS="${ARGOCD_VERIFY_INTERVAL_SECONDS:-10}"

erro()  { echo "::error::verify-argo: $*" >&2; }
morre() { erro "$*"; exit 1; }

case "$AMBIENTE" in dev | hml | prod) ;; *) morre "ambiente invalido: '${AMBIENTE}'" ;; esac
[[ "$PIN_SHA"   =~ ^[0-9a-f]{40}$ ]] || morre "pin-sha precisa ser 40 hex minusculos, recebi: '${PIN_SHA}'"
[[ "$PUSHED_AT" =~ ^[0-9]{9,11}$  ]] || morre "epoch-do-push invalido: '${PUSHED_AT}'"
[[ "$DEADLINE_SECONDS" =~ ^[0-9]+$ ]] && [ "$DEADLINE_SECONDS" -gt 0 ] || morre "deadline invalido: '${DEADLINE_SECONDS}'"

# ── modo de teste: costura EXPLICITA, recusada quando a lane exige medida real ─
# ARGOCD_FETCH_CMD substitui o curl por um comando que imprime o JSON da
# Application; existe para deploy/__tests__/verify-argo.test.sh poder provar que
# o gate REPROVA. A polaridade e deliberada: quem PRODUZ deploy declara
# ARGOCD_VERIFY_REQUIRE_LIVE=1 e a costura passa a ser recusada. Um flag que
# DESLIGA protecao pode ficar esquecido ligado; um que a EXIGE nao pode ser
# esquecido sem a lane inteira parar de medir — e isso se ve na hora.
MODO_TESTE=0
if [ -n "${ARGOCD_FETCH_CMD:-}" ]; then
  if [ "${ARGOCD_VERIFY_REQUIRE_LIVE:-0}" = "1" ]; then
    morre "ARGOCD_FETCH_CMD foi definido numa execucao com ARGOCD_VERIFY_REQUIRE_LIVE=1 — o gate so aceita a API real aqui."
  fi
  MODO_TESTE=1
  echo "::warning::verify-argo: MODO DE TESTE — a Application vem de ARGOCD_FETCH_CMD, nao da API do Argo." >&2
fi

if [ "$MODO_TESTE" = "0" ] && [ -z "${ARGOCD_CI_TOKEN:-}" ]; then
  morre "ARGOCD_CI_TOKEN nao esta cadastrado. O gate NAO pula por falta de credencial: cadastre o token da conta de CI do Argo (ci-kos-verify, RBAC read-only no AppProject kos-hapvida) no secret ARGOCD_CI_TOKEN e re-execute."
fi

for bin in jq helm git python3; do command -v "$bin" >/dev/null || morre "'${bin}' nao encontrado"; done

# ── o conjunto esperado sai do ARQUIVO do commit pinado ─────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git cat-file -e "${PIN_SHA}^{commit}" 2>/dev/null \
  || morre "commit de pin ${PIN_SHA} nao existe neste clone (falta 'fetch-depth: 0' no checkout?)"

git archive "$PIN_SHA" deploy | tar -x -C "$TMP" \
  || morre "nao consegui extrair deploy/ do commit ${PIN_SHA}"

VALUES_BASE="${TMP}/deploy/values.yaml"
VALUES_ENV="${TMP}/deploy/values-${AMBIENTE}.yaml"
[ -f "$VALUES_BASE" ] || morre "o commit ${PIN_SHA} nao carrega deploy/values.yaml"
[ -f "$VALUES_ENV" ]  || morre "o commit ${PIN_SHA} nao carrega deploy/values-${AMBIENTE}.yaml"

NS_RENDER="kos-components"
[ "$AMBIENTE" = "prod" ] || NS_RENDER="kos-components-${AMBIENTE}"

if ! helm template kos-components "${TMP}/deploy/chart" --namespace "$NS_RENDER" \
      -f "$VALUES_BASE" -f "$VALUES_ENV" > "${TMP}/render.yaml" 2> "${TMP}/render.err"; then
  erro "o chart do commit ${PIN_SHA} nao renderiza com values-${AMBIENTE}.yaml — o Argo tambem nao vai conseguir. Saida do helm:"
  sed -e 's/^/  /' "${TMP}/render.err" >&2
  exit 1
fi

# Classifica cada `image:` pelo KIND do documento em que ela aparece — `kind:` na
# coluna 0 e sempre o do recurso (os `kind:` aninhados, como o do secretStoreRef,
# vem indentados). A classificacao e o que separa "tem de estar VIVA agora" de
# "esta DECLARADA no manifesto"; ver a nota (4) do cabecalho.
CLASSIFICADAS="$(awk '
  /^---$/        { kind = "" }
  /^kind: /      { kind = $2 }
  $1 == "image:" { gsub(/"/, "", $2); print kind "\t" $2 }
' "${TMP}/render.yaml" | sort -u)"

IMAGENS_ESPERADAS="$(cut -f2 <<<"$CLASSIFICADAS" | sort -u)"
[ -n "$IMAGENS_ESPERADAS" ] || morre "o commit ${PIN_SHA} nao renderiza nenhuma imagem"

# Pod permanente = o kind cujo sync JA cria pod. Job entra como "sem pod" de
# proposito: com hook-delete-policy o Job da rodada anterior some, e um Job com
# ttlSecondsAfterFinished leva o pod junto — depender dele seria o mesmo erro do
# CronJob, so que intermitente.
IMAGENS_VIVAS_ESPERADAS="$(awk -F'\t' '
  $1 == "Deployment" || $1 == "StatefulSet" || $1 == "DaemonSet" { print $2 }
' <<<"$CLASSIFICADAS" | sort -u)"
IMAGENS_SEM_POD="$(awk -F'\t' '
  { todas[$2] = 1 }
  $1 == "Deployment" || $1 == "StatefulSet" || $1 == "DaemonSet" { vivas[$2] = 1 }
  END { for (i in todas) if (!(i in vivas)) print i }
' <<<"$CLASSIFICADAS" | sort -u)"

[ -n "$IMAGENS_VIVAS_ESPERADAS" ] \
  || morre "o commit ${PIN_SHA} nao renderiza nenhum workload de pod permanente (Deployment/StatefulSet/DaemonSet). Sem isso nao ha o que medir VIVO — o gate se recusa a aprovar por ausencia de criterio."
while read -r img; do
  [[ "$img" =~ ^([^@[:space:]]+)@(sha256:[0-9a-f]{64})$ ]] \
    || morre "o commit ${PIN_SHA} renderiza '${img}', que nao esta pinado por digest"
  if [ -n "${EXPECTED_IMAGE_PREFIX:-}" ] && [[ "${BASH_REMATCH[1]}" != "${EXPECTED_IMAGE_PREFIX}"* ]]; then
    morre "o commit ${PIN_SHA} renderiza o repositorio '${BASH_REMATCH[1]}', fora do prefixo esperado '${EXPECTED_IMAGE_PREFIX}'"
  fi
done <<<"$IMAGENS_ESPERADAS"

QTD_ESPERADAS="$(printf '%s\n' "$IMAGENS_ESPERADAS" | wc -l | tr -d ' ')"
QTD_VIVAS="$(printf '%s\n' "$IMAGENS_VIVAS_ESPERADAS" | wc -l | tr -d ' ')"
QTD_SEM_POD=0
[ -z "$IMAGENS_SEM_POD" ] || QTD_SEM_POD="$(printf '%s\n' "$IMAGENS_SEM_POD" | wc -l | tr -d ' ')"

echo "verify-argo: application=${APP} ambiente=${AMBIENTE} pin=${PIN_SHA}"
echo "verify-argo: ${QTD_ESPERADAS} imagem(ns) esperada(s), lidas de deploy/values-${AMBIENTE}.yaml no commit ${PIN_SHA}."
echo "verify-argo: ${QTD_VIVAS} EXIGIDA(S) VIVA(S) em .status.summary.images (pod permanente):"
# shellcheck disable=SC2086  # word splitting DELIBERADO: uma linha por imagem
printf '  · %s\n' $IMAGENS_VIVAS_ESPERADAS
if [ "$QTD_SEM_POD" != "0" ]; then
  echo "verify-argo: ${QTD_SEM_POD} imagem(ns) so em CronJob/Job — DECLARADA(S) no manifesto, nao exigida(s) vivas (um CronJob nao cria pod no sync):"
  # shellcheck disable=SC2086
  printf '  · %s\n' $IMAGENS_SEM_POD
fi
echo "verify-argo: deadline=${DEADLINE_SECONDS}s intervalo=${INTERVAL_SECONDS}s"

# ── busca da Application ────────────────────────────────────────────────────
# O token NAO entra em argv: `curl --config -` le o header do stdin, entao ele
# nao aparece num `ps` do runner nem num `set -x` acidental.
HTTP_CODE=""; CORPO=""
busca_app() {
  if [ "$MODO_TESTE" = "1" ]; then
    CORPO="$(eval "$ARGOCD_FETCH_CMD")" || { HTTP_CODE="000"; CORPO=""; return 0; }
    HTTP_CODE="200"; return 0
  fi
  local bruto
  if ! bruto="$(printf 'header = "Authorization: Bearer %s"\n' "$ARGOCD_CI_TOKEN" \
      | curl -sS --config - --max-time 30 -w $'\n%{http_code}' \
             "${ARGOCD_SERVER}/api/v1/applications/${APP}" 2>/dev/null)"; then
    HTTP_CODE="000"; CORPO=""; return 0
  fi
  HTTP_CODE="${bruto##*$'\n'}"
  CORPO="${bruto%$'\n'*}"
}

epoch_de() { # RFC3339 -> epoch; vazio/invalido/null -> 0 (nunca satisfaz o criterio)
  local t="${1:-}"
  if [ -z "$t" ] || [ "$t" = "null" ]; then echo 0; return 0; fi
  date -u -d "$t" +%s 2>/dev/null || echo 0
}

INICIO="$(date -u +%s)"; LIMITE=$(( INICIO + DEADLINE_SECONDS ))
ULTIMO_MOTIVO="nenhuma resposta lida ainda"; RODADA=0
SYNC=""; HEALTH=""; REVISION=""; RECONCILED=""; OP_PHASE=""; OP_REV=""; IMAGENS=""; FALTANDO=""
SEM_POD_VIVAS=""; SEM_POD_AUSENTES=""

while :; do
  RODADA=$(( RODADA + 1 ))
  busca_app

  if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
    # Esperar nao conserta credencial. Falha imediata, com o codigo.
    morre "a API do Argo devolveu HTTP ${HTTP_CODE} para ${APP}. O token da conta de CI e invalido, expirou, ou nao tem 'applications, get' no project kos-hapvida. (Sem credencial o gate REPROVA — nunca pula.)"
  fi

  if [ "$HTTP_CODE" != "200" ] || [ -z "$CORPO" ] || ! jq -e . >/dev/null 2>&1 <<<"$CORPO"; then
    ULTIMO_MOTIVO="a API nao devolveu JSON utilizavel (http=${HTTP_CODE:-000})"
  else
    SYNC="$(jq -r '.status.sync.status      // ""' <<<"$CORPO")"
    HEALTH="$(jq -r '.status.health.status   // ""' <<<"$CORPO")"
    REVISION="$(jq -r '.status.sync.revision  // ""' <<<"$CORPO")"
    RECONCILED="$(jq -r '.status.reconciledAt // ""' <<<"$CORPO")"
    IMAGENS="$(jq -r '.status.summary.images // [] | .[]' <<<"$CORPO")"
    if jq -e '.status.operationState != null' >/dev/null 2>&1 <<<"$CORPO"; then
      OP_PHASE="$(jq -r '.status.operationState.phase // ""' <<<"$CORPO")"
      OP_REV="$(jq -r '.status.operationState.syncResult.revision // .status.operationState.operation.sync.revision // ""' <<<"$CORPO")"
    else
      OP_PHASE=""; OP_REV=""
    fi

    RECONCILED_EPOCH="$(epoch_de "$RECONCILED")"

    FALTANDO=""
    while read -r esperada; do
      [ -z "$esperada" ] && continue
      grep -Fxq "$esperada" <<<"$IMAGENS" || FALTANDO="${FALTANDO}${esperada} "
    done <<<"$IMAGENS_VIVAS_ESPERADAS"

    # As imagens sem pod no sync entram como EVIDENCIA, nunca como criterio.
    SEM_POD_VIVAS=""; SEM_POD_AUSENTES=""
    if [ -n "$IMAGENS_SEM_POD" ]; then
      while read -r declarada; do
        [ -z "$declarada" ] && continue
        if grep -Fxq "$declarada" <<<"$IMAGENS"; then
          SEM_POD_VIVAS="${SEM_POD_VIVAS}${declarada} "
        else
          SEM_POD_AUSENTES="${SEM_POD_AUSENTES}${declarada} "
        fi
      done <<<"$IMAGENS_SEM_POD"
    fi

    # Falha rapida: a operacao DESTE pin terminou em erro. Continuar esperando so
    # queima o deadline para chegar ao mesmo vermelho 15 minutos depois.
    if { [ "$OP_PHASE" = "Failed" ] || [ "$OP_PHASE" = "Error" ]; } && [ "$OP_REV" = "$PIN_SHA" ]; then
      erro "o sync do commit de pin ${PIN_SHA} terminou em operationState.phase=${OP_PHASE}."
      jq -r '.status.operationState.message // "(sem message)"' <<<"$CORPO" | sed -e 's/^/  /' >&2
      ULTIMO_MOTIVO="operationState.phase=${OP_PHASE} para a revisao pinada"
      break
    fi

    if   [ "$SYNC"   != "Synced" ];     then ULTIMO_MOTIVO="sync.status=${SYNC:-<vazio>} (esperado Synced)"
    elif [ "$HEALTH" != "Healthy" ];    then ULTIMO_MOTIVO="health.status=${HEALTH:-<vazio>} (esperado Healthy)"
    elif [ "$REVISION" != "$PIN_SHA" ]; then ULTIMO_MOTIVO="sync.revision=${REVISION:-<vazio>} (esperado o commit de pin ${PIN_SHA})"
    elif [ -n "$FALTANDO" ]; then
      # shellcheck disable=SC2086
      ULTIMO_MOTIVO="faltam em .status.summary.images (workloads de pod permanente): ${FALTANDO}(vivas: $(printf '%s ' $IMAGENS))"
    elif [ "$RECONCILED_EPOCH" -le "$PUSHED_AT" ]; then
      # ESTRITAMENTE posterior, nao ">=": reconciledAt tem granularidade de
      # segundo e o epoch do push e tomado ANTES do pin (render + commit +
      # push). Aceitar a igualdade admitiria um status reconciliado no mesmo
      # segundo do push — possivelmente ANTES de o pin existir.
      ULTIMO_MOTIVO="reconciledAt=${RECONCILED:-<vazio>} (epoch ${RECONCILED_EPOCH}) nao e posterior ao push (${PUSHED_AT}) — este status ainda e o de antes do pin"
    elif [ -n "$OP_PHASE" ] && [ "$OP_PHASE" != "Succeeded" ]; then
      ULTIMO_MOTIVO="operationState.phase=${OP_PHASE} (esperado Succeeded)"
    else
      APROVADO=1; break
    fi
  fi

  AGORA="$(date -u +%s)"
  if [ "$AGORA" -ge "$LIMITE" ]; then
    ULTIMO_MOTIVO="DEADLINE de ${DEADLINE_SECONDS}s estourado — ${ULTIMO_MOTIVO}"
    break
  fi
  echo "  · rodada ${RODADA}, $(( AGORA - INICIO ))s de ${DEADLINE_SECONDS}s: ${ULTIMO_MOTIVO}"
  sleep "$INTERVAL_SECONDS"
done

# ── evidencia ───────────────────────────────────────────────────────────────
resumo() {
  echo "### Gate do Argo CD — \`${APP}\` (${AMBIENTE})"
  echo
  echo "| criterio | esperado | observado |"
  echo "| --- | --- | --- |"
  echo "| \`sync.status\` | \`Synced\` | \`${SYNC:-<vazio>}\` |"
  echo "| \`health.status\` | \`Healthy\` | \`${HEALTH:-<vazio>}\` |"
  echo "| \`sync.revision\` | \`${PIN_SHA}\` | \`${REVISION:-<vazio>}\` |"
  echo "| imagens vivas em \`status.summary.images\` | ${QTD_VIVAS} exigida(s) (pod permanente) | faltando: \`${FALTANDO:-nenhuma}\` |"
  if [ "$QTD_SEM_POD" != "0" ]; then
    # `% ` tira o espaco que a acumulacao deixa no fim — a evidencia e lida por
    # gente e casada por teste; um espaco invisivel quebra os dois.
    local com_pod="${SEM_POD_VIVAS% }" sem_pod="${SEM_POD_AUSENTES% }"
    echo "| imagens so de CronJob/Job | ${QTD_SEM_POD} declarada(s), **nao exigida(s) vivas** | ja com pod: \`${com_pod:-nenhuma}\` · sem pod agora: \`${sem_pod:-nenhuma}\` |"
  fi
  echo "| \`reconciledAt\` | \`> ${PUSHED_AT}\` (epoch do push) | \`${RECONCILED:-<vazio>}\` |"
  echo "| \`operationState.phase\` | \`Succeeded\` ou ausente | \`${OP_PHASE:-<null>}\` |"
  echo
  echo "Conjunto esperado lido de \`deploy/values-${AMBIENTE}.yaml\` **no commit \`${PIN_SHA}\`** (nunca de variavel do workflow):"
  printf '%s\n' "$IMAGENS_ESPERADAS" | sed -e 's/^/- `/' -e 's/$/`/'
  if [ "$QTD_SEM_POD" != "0" ]; then
    echo
    echo "As imagens de CronJob/Job acima estao **declaradas** no manifesto do commit pinado, e nao no criterio de vivacidade: \`.status.summary.images\` retrata os PODS da arvore de recursos, e um CronJob so materializa pod no horario do schedule. A existencia real do digest delas foi provada pela lane, no probe autenticado do ECR que precede o pin."
  fi
  if [ "${APROVADO:-0}" = "1" ]; then
    echo; echo "**APROVADO** em ${RODADA} rodada(s)."
  else
    echo; echo "**REPROVADO**: ${ULTIMO_MOTIVO}"
  fi
}

resumo
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then resumo >> "$GITHUB_STEP_SUMMARY"; fi

if [ "${APROVADO:-0}" = "1" ]; then
  echo "verify-argo: APROVADO — as ${QTD_VIVAS} imagem(ns) de pod permanente estao VIVAS em ${APP}, na revisao ${PIN_SHA} (${QTD_SEM_POD} so de CronJob/Job: declarada(s), nao exigida(s) vivas)."
  exit 0
fi
morre "REPROVADO — ${ULTIMO_MOTIVO}"
