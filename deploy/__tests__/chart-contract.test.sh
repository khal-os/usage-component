#!/usr/bin/env bash
# TESTE DO CHART — as invariantes que, quando quebram, quebram em producao.
#
#   uso: bash deploy/__tests__/chart-contract.test.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
cd "$RAIZ"

for bin in helm python3 awk; do command -v "$bin" >/dev/null || { echo "FALTA: $bin"; exit 1; }; done

FIX="deploy/__tests__/fixtures"
PINS="${FIX}/pins-valid.yaml"

ns_de() { case "$1" in prod) echo kos-components ;; *) echo "kos-components-$1" ;; esac; }

render() { # render <env> [values extra...]
  local env="$1"; shift
  helm template kos-components deploy/chart --namespace "$(ns_de "$env")" \
    -f deploy/values.yaml -f "deploy/values-${env}.yaml" "$@" 2>&1
}

titulo "helm lint"
SAIDA="$(helm lint deploy/chart -f deploy/values.yaml -f deploy/values-dev.yaml -f "$PINS" 2>&1)"
if [ $? -eq 0 ]; then ok "helm lint passa com values de dev + pins validos"; else falha "helm lint: $SAIDA"; fi

titulo "render dos tres ambientes com pins validos"
declare -A RENDER
for env in dev hml prod; do
  if OUT="$(render "$env" -f "$PINS")"; then
    RENDER["$env"]="$OUT"
    ok "render de ${env}"
  else
    falha "render de ${env}: $(head -3 <<<"$OUT")"
    RENDER["$env"]=""
  fi
done

titulo "fail-closed: placeholder de branch nunca buildada"
# Esta e a invariante que impede um deploy de subir 'do nada' com imagem errada:
# enquanto a lane dev nao pinar, o chart NAO renderiza.
for env in dev hml prod; do
  if OUT="$(render "$env")"; then
    falha "${env}: renderizou com o placeholder (deveria falhar fechado)"
  else
    contem "${env}: falha fechada cita o PLACEHOLDER" "PLACEHOLDER" "$OUT"
  fi
done

titulo "o chart nunca renderiza segredo nem pull secret"
for env in dev hml prod; do
  nao_contem "${env}: sem 'kind: Secret'"    "kind: Secret"      "${RENDER[$env]}"
  nao_contem "${env}: sem imagePullSecrets"  "imagePullSecrets"  "${RENDER[$env]}"
done

titulo "toda imagem e <registry>/kos/<nome>@sha256:<64hex>"
for env in dev hml prod; do
  MAS=""
  while read -r img; do
    [ -z "$img" ] && continue
    [[ "$img" =~ ^278522730053\.dkr\.ecr\.sa-east-1\.amazonaws\.com/kos/[a-z0-9-]+@sha256:[0-9a-f]{64}$ ]] || MAS="${MAS}${img} "
  done <<<"$(awk '$1 == "image:" { gsub(/"/, "", $2); print $2 }' <<<"${RENDER[$env]}" | sort -u)"
  verifica "${env}: nenhuma imagem fora do molde" "" "$MAS"
done

titulo "conjunto renderizado == conjunto declarado (workloads habilitados)"
REPOS="$(deploy/services.sh repos)"
for env in dev hml prod; do
  ESPERADO="$(deploy/services.sh workloads | awk -F'\t' '$4 == "true" { print $3 }' | sort -u \
    | while read -r n; do python3 -c "import json,sys;print(json.load(sys.stdin)['$n'])" <<<"$REPOS"; done | sort -u)"
  ENCONTRADO="$(awk '$1 == "image:" { gsub(/"/, "", $2); sub(/@.*/, "", $2); print $2 }' <<<"${RENDER[$env]}" | sort -u)"
  verifica "${env}: repositorios renderizados == declarados" "$ESPERADO" "$ENCONTRADO"
done

titulo "schema reprova as formas conhecidas de errar"
for f in bad-secret-literal bad-no-health bad-preset-and-resources bad-digest bad-repository bad-cert-arn; do
  if render dev -f "$PINS" -f "${FIX}/${f}.yaml" >/dev/null 2>&1; then
    falha "${f}.yaml PASSOU (deveria ser reprovado pela values.schema.json)"
  else
    ok "${f}.yaml reprovado"
  fi
done

titulo "singletons: Recreate + 1 replica + PDB maxUnavailable 0"
DEV="${RENDER[dev]}"
BLOCO_WORKER="$(awk '/^kind: Deployment$/{d=1} d&&/name: trace-ingestion-worker$/{p=1} p; p&&/^---$/{exit}' <<<"$DEV")"
contem "worker: strategy Recreate" "type: Recreate" "$BLOCO_WORKER"
contem "worker: 1 replica"         "replicas: 1"    "$BLOCO_WORKER"
BLOCO_PDB="$(awk '/^kind: PodDisruptionBudget$/{p=1} p; p&&/^---$/{exit}' <<<"$DEV")"
contem "worker: PDB com maxUnavailable 0" "maxUnavailable: 0" "$BLOCO_PDB"

titulo "prod: api com 2 replicas e PDB proprio"
PROD="${RENDER[prod]}"
verifica "prod tem 2 PDBs (api + worker)" "2" "$(grep -c '^kind: PodDisruptionBudget$' <<<"$PROD")"
contem "prod: api com replicas 2" "replicas: 2" "$(awk '/^kind: Deployment$/{d=1} d&&/^  name: api$/{p=1} p; p&&/^---$/{exit}' <<<"$PROD")"

titulo "ExternalSecret com os defaults do CRD explicitos"
ES="$(awk '/^kind: ExternalSecret$/{p=1} p; p&&/^---$/{exit}' <<<"$DEV")"
for chave in "creationPolicy: Owner" "deletionPolicy: Retain" "conversionStrategy: Default" "decodingStrategy: None" "metadataPolicy: None" "kind: ClusterSecretStore" "refreshInterval: \"1m\""; do
  contem "ExternalSecret: ${chave}" "$chave" "$ES"
done
verifica "um ExternalSecret por workload habilitado (4)" "4" "$(grep -c '^kind: ExternalSecret$' <<<"$DEV")"

titulo "Reloader escopado em todo Deployment"
verifica "annotation de reload em todos os Deployments" \
  "$(grep -c '^kind: Deployment$' <<<"$DEV")" \
  "$(grep -c 'secret.reloader.stakater.com/reload:' <<<"$DEV")"
nao_contem "sem reloader.stakater.com/auto" "reloader.stakater.com/auto" "$DEV"

titulo "Ingress: IngressGroup, listen-ports, ssl-redirect e SEM certificate-arn"
ING="$(awk '/^kind: Ingress$/{p=1} p; p&&/^---$/{exit}' <<<"$DEV")"
contem "group.name do ambiente"  "alb.ingress.kubernetes.io/group.name: \"hapvida-dev\"" "$ING"
contem "listen-ports HTTP+HTTPS" 'listen-ports: '"'"'[{"HTTP":80},{"HTTPS":443}]'"'"'' "$ING"
contem "ssl-redirect 443"        'ssl-redirect: "443"' "$ING"
contem "healthcheck-path real"   "healthcheck-path: \"/api/v1/docs/openapi.json\"" "$ING"
nao_contem "sem certificate-arn" "certificate-arn" "$ING"
contem "host de dev"             "host: \"api-dev.hapvida.khal.ai\"" "$ING"

titulo "Job de migracao: hook PreSync, backoffLimit 0, deadline"
JOB="$(awk '/^kind: Job$/{p=1} p; p&&/^---$/{exit}' <<<"$DEV")"
contem "hook PreSync"            "argocd.argoproj.io/hook: PreSync" "$JOB"
contem "backoffLimit 0"          "backoffLimit: 0" "$JOB"
contem "activeDeadlineSeconds"   "activeDeadlineSeconds: 600" "$JOB"
contem "restartPolicy Never"     "restartPolicy: Never" "$JOB"
contem "comando run-migrations"  "dist/main/jobs/run-migrations.js" "$JOB"

titulo "CronJob de backup: timeZone, restartPolicy e IRSA"
CJ="$(awk '/^kind: CronJob$/{p=1} p; p&&/^---$/{exit}' <<<"$DEV")"
contem "schedule 07:00"        'schedule: "0 7 * * *"' "$CJ"
contem "timeZone explicito"    'timeZone: "America/Sao_Paulo"' "$CJ"
contem "restartPolicy Never"   "restartPolicy: Never" "$CJ"
contem "IRSA na SA do backup"  "eks.amazonaws.com/role-arn: \"arn:aws:iam::701016785827:role/hv-kos-usage-backup-dev\"" "$DEV"

titulo "non-root em todo pod"
verifica "runAsNonRoot em todos os pod templates" \
  "$(grep -c 'runAsNonRoot: true' <<<"$DEV")" \
  "$(grep -c 'runAsUser: 1000' <<<"$DEV")"

titulo "nenhum namespace hardcodado no chart"
if grep -rn 'namespace: kos-components' deploy/chart/templates >/dev/null 2>&1; then
  falha "ha namespace hardcodado em deploy/chart/templates"
else
  ok "namespace sempre vem do release/values"
fi

encerra "chart-contract"
