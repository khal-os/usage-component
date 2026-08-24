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

# doc_de <kind> <metadata.name> — recorta UM documento do render (stdin). O awk
# por `kind:` + primeiro `---` nao serve aqui: precisamos do ExternalSecret do
# `migrations`, que nao e o primeiro da lista.
doc_de() {
  awk -v k="$1" -v n="$2" '
    function fecha() { if (kind && nome) { printf "%s", buf; achou=1; exit } buf=""; kind=0; nome=0 }
    /^---$/ { fecha(); next }
    { buf = buf $0 "\n" }
    $0 == "kind: " k     { kind = 1 }
    $0 == "  name: " n   { nome = 1 }
    END { fecha() }
  '
}

# wave_de <documento> — le a sync-wave (com ou sem aspas) das annotations
wave_de() { sed -n 's/.*argocd\.argoproj\.io\/sync-wave: *"\{0,1\}\(-\{0,1\}[0-9]\{1,\}\)"\{0,1\}.*/\1/p' <<<"$1" | head -1; }

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
# um servico HABILITADO que chega ao render com o placeholder derruba o render.
#
# O estado "branch nunca buildada" e CONSTRUIDO aqui, nao lido de
# deploy/values-<env>.yaml. Ler dali funciona so enquanto nenhuma lane pinou:
# no khal-platform, o primeiro pin de `eks/dev` (2026-08-23, commit d6bfcc1)
# deixou o guard equivalente REPROVANDO UM REPO CORRETO — sem placeholder no
# values, o render sai, e a assercao "tem de falhar" falha. Seis assercoes
# vermelhas e o eks-ci barrando todo push. Aqui a lane ainda nao rodou; a
# armadilha e a mesma, e fecha antes de disparar.
OVERLAY_PH="$(mktemp)"; trap 'rm -f "$OVERLAY_PH"' EXIT
python3 - deploy/chart/values.yaml deploy/values.yaml deploy/values-dev.yaml > "$OVERLAY_PH" <<'PYPH'
import sys, yaml
ph = None
for arq in sys.argv[1:]:
    v = yaml.safe_load(open(arq)) or {}
    ph = v.get("placeholderDigest", ph)
    pins = v.get("pins") or {}
    if pins:
        nomes = list(pins)
assert ph, "placeholderDigest nao declarado em nenhum values"
yaml.safe_dump(
    {"pins": {n: {"digest": ph, "gitSha": "0" * 40} for n in nomes}},
    sys.stdout, default_flow_style=False,
)
PYPH
for env in dev hml prod; do
  if OUT="$(render "$env" -f "$OVERLAY_PH")"; then
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

titulo "opt-out otel exatamente nos workloads ATRAS DE UM SERVICE"
# O addon EKS `amazon-cloudwatch-observability` (v6.3.0, default da frota) MUTA o
# pod template de todo Deployment do cluster e o webhook injeta 4 init-containers
# otel por pod. Custo medido em 2026-08-23 no hapvida-dev: OOMKill (137) do
# langwatch-langevals e 4 recursos do hv-kos-langwatch-hml em drift OutOfSync
# permanente. O operador RESPEITA annotation ja declarada no workload — e o unico
# opt-out por git, e por isso ele mora no CHART e nao no addon (addon e
# componente compartilhado da frota).
# A assercao exige a STRING "false": annotation e map[string]string, e um `false`
# YAML nu vira booleano e quebra o render.
for env in dev hml prod; do
  # O render vai por ARQUIVO, nao por stdin: `python3 - <<script <<<dados` tem
  # DUAS redirecoes de stdin e a ultima vence — o python leria o YAML como se
  # fosse o script, e a assercao passaria sempre (falso verde comprovado).
  ALVO="$(mktemp)"; printf '%s' "${RENDER[$env]}" > "$ALVO"
  RUIM="$(python3 - "$ALVO" <<'PYOTEL'
import sys, yaml
CHAVES = [f'instrumentation.opentelemetry.io/inject-{l}' for l in ('java', 'nodejs', 'python', 'dotnet')] \
       + [f'cloudwatch.aws.amazon.com/auto-annotate-{l}' for l in ('java', 'nodejs', 'python', 'dotnet')]
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
# O conjunto de validade do opt-out: workload ATRAS DE UM SERVICE. Calculado do
# proprio render (Service cujo seletor casa os labels do pod template), nao de
# uma lista de nomes que envelhece.
selectores = [s['spec'].get('selector') or {} for s in docs if s.get('kind') == 'Service']
ruim, n = [], 0
for d in docs:
    if d.get('kind') != 'Deployment':
        continue
    n += 1
    nome = d['metadata']['name']
    labels = d['spec']['template']['metadata'].get('labels') or {}
    ann = (d['spec']['template']['metadata'].get('annotations') or {})
    atras_de_service = any(sel and all(labels.get(k) == v for k, v in sel.items()) for sel in selectores)
    if atras_de_service:
        faltando = [k for k in CHAVES if ann.get(k) != 'false']
        if faltando:
            ruim.append(f"{nome} (com Service): faltam {faltando}")
    else:
        # FORA do conjunto declarar e PIOR que nao declarar: o addon remove as
        # chaves na admissao e a Application fica OutOfSync para sempre.
        sobrando = [k for k in CHAVES if k in ann]
        if sobrando:
            ruim.append(f"{nome} (SEM Service): declara {sobrando} — vira drift permanente")
if n == 0:
    ruim.append('nenhum Deployment no render')
print('; '.join(ruim))
PYOTEL
)"
  rm -f "$ALVO"
  verifica "${env}: as 8 annotations exatamente onde valem" "" "$RUIM"
  # A mesma coisa lida CRUA do YAML: se o merge global x por servico quebrar,
  # esta linha some do render.
  N_SVC="$(grep -c '^kind: Service$' <<<"${RENDER[$env]}")"
  N_PY="$(grep -c 'instrumentation.opentelemetry.io/inject-python: "false"' <<<"${RENDER[$env]}")"
  verifica "${env}: inject-python \"false\" em um pod template por Service" "$N_SVC" "$N_PY"
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
for f in bad-secret-literal bad-no-health bad-preset-and-resources bad-digest bad-repository bad-cert-arn bad-recreate-replicas; do
  if render dev -f "$PINS" -f "${FIX}/${f}.yaml" >/dev/null 2>&1; then
    falha "${f}.yaml PASSOU (deveria ser reprovado pela values.schema.json)"
  else
    ok "${f}.yaml reprovado"
  fi
done

titulo "singletons: Recreate + 1 replica, e a schema e quem garante o 1"
DEV="${RENDER[dev]}"
BLOCO_WORKER="$(awk '/^kind: Deployment$/{d=1} d&&/name: trace-ingestion-worker$/{p=1} p; p&&/^---$/{exit}' <<<"$DEV")"
contem "worker: strategy Recreate" "type: Recreate" "$BLOCO_WORKER"
contem "worker: 1 replica"         "replicas: 1"    "$BLOCO_WORKER"

titulo "PDB nunca proibe eviction para sempre (PLANO §7 risco 3)"
# `maxUnavailable: 0` com 1 replica e `minAvailable: 1` com outro nome: o drain
# de no, o upgrade de nodegroup e a consolidacao do Auto Mode ficam pendurados
# sem que ninguem seja avisado. (O filtro por documento e necessario: o mesmo
# `maxUnavailable: 0` do rollingUpdate dos Deployments e legitimo e desejado.)
docs_de_kind() { # docs_de_kind <kind> <render>
  awk -v alvo="$1" '/^---$/ { if (guarda) printf "%s", buf; kind = ""; buf = ""; guarda = 0; next }
                    /^kind: / { kind = $2; if (kind == alvo) guarda = 1 }
                    { buf = buf $0 "\n" }
                    END { if (guarda) printf "%s", buf }' <<<"$2"
}
for env in dev hml prod; do
  nao_contem "${env}: nenhum PDB com maxUnavailable 0" "maxUnavailable: 0" "$(docs_de_kind PodDisruptionBudget "${RENDER[$env]}")"
  contem "${env}: todo PDB com maxUnavailable 1" "maxUnavailable: 1" "$(docs_de_kind PodDisruptionBudget "${RENDER[$env]}")"
done
BLOCO_PDB="$(docs_de_kind PodDisruptionBudget "$DEV")"
contem "worker: PDB do singleton existe" "name: trace-ingestion-worker" "$BLOCO_PDB"

titulo "replicas > 1 com Recreate e REPROVADO (nao renderizado em silencio)"
# O contrato do singleton nao vale se a unica coisa que o sustenta for um
# comentario. Este caso e o do PLANO §7 risco 3 ("duplica traces e a fatura").
SAIDA="$(render dev -f "$PINS" -f "${FIX}/bad-recreate-replicas.yaml" 2>&1 || true)"
contem "a schema cita o servico" "services.trace-ingestion-worker" "$SAIDA"
contem "a schema cita replicas"  "replicas"                        "$SAIDA"

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

titulo "ES de workload comum: sem hook, sem wave, creationPolicy Owner"
ES_API="$(doc_de ExternalSecret api-env <<<"$DEV")"
contem "api-env existe"            "name: api-env"     "$ES_API"
contem "api-env com Owner"         "creationPolicy: Owner" "$ES_API"
nao_contem "api-env sem hook"      "argocd.argoproj.io/hook" "$ES_API"

titulo "ORDEM PreSync: o ES do Job de migracao e hook numa wave ANTERIOR a do Job"
# A regressao que este bloco fecha: com o ES como recurso COMUM, ele so era
# aplicado na fase SYNC — que nunca comeca, porque a fase PreSync esta parada
# esperando o Job que precisa justamente daquele Secret. No primeiro sync de cada
# ambiente o pod do hook ficava em CreateContainerConfigError ate os 600 s do
# activeDeadlineSeconds e derrubava o sync inteiro. Deadlock de fase, nao flake.
for env in dev hml prod; do
  ES_MIG="$(doc_de ExternalSecret migrations-env <<<"${RENDER[$env]}")"
  JOB_MIG="$(doc_de Job migrations <<<"${RENDER[$env]}")"
  contem "${env}: ES do migrations e hook PreSync" "argocd.argoproj.io/hook: PreSync" "$ES_MIG"
  contem "${env}: ES do migrations nao e apagado antes da hora" \
    "argocd.argoproj.io/hook-delete-policy: BeforeHookCreation" "$ES_MIG"
  # `Orphan` e o que impede o hook-delete-policy de levar o SECRET junto: com
  # `Owner` o ESO poe ownerReference, e apagar o ES apagaria o Secret que o Job
  # le. Ver o comentario do template.
  contem "${env}: ES do migrations com creationPolicy Orphan" "creationPolicy: Orphan"  "$ES_MIG"
  contem "${env}: ES do migrations com deletionPolicy Retain" "deletionPolicy: Retain"  "$ES_MIG"
  W_ES="$(wave_de "$ES_MIG")"; W_JOB="$(wave_de "$JOB_MIG")"
  verifica "${env}: wave do ES do migrations" "-1" "$W_ES"
  verifica "${env}: wave do Job de migracao"   "0" "$W_JOB"
  if [ -n "$W_ES" ] && [ -n "$W_JOB" ] && [ "$W_ES" -lt "$W_JOB" ]; then
    ok "${env}: o Secret nasce numa wave ANTES do hook que o consome"
  else
    falha "${env}: wave do ES (${W_ES:-<vazia>}) nao e menor que a do Job (${W_JOB:-<vazia>})"
  fi
  contem "${env}: o Job consome mesmo esse Secret" "name: migrations-env" "$JOB_MIG"
done

titulo "o chart RECUSA ES do Job na mesma wave (ou depois) do Job"
if OUT="$(render dev -f "$PINS" -f "${FIX}/bad-es-wave.yaml" 2>&1)"; then
  falha "bad-es-wave.yaml renderizou (deveria falhar: ES e Job na mesma wave)"
else
  contem "a mensagem explica a ordem" "tem de ser MENOR que a do Job" "$OUT"
  contem "e cita o sintoma real"      "CreateContainerConfigError"    "$OUT"
fi

titulo "servico SEM secrets nao falha ABERTO"
# Sem `secrets:` nao ha ExternalSecret; um `envFrom` (ou uma annotation de
# Reloader) para o `<svc>-env` inexistente prenderia o pod em
# CreateContainerConfigError para sempre. Nenhum dos 5 workloads deste repo cai
# no caso — o chart, porem, e o generico do Padrao (CONTRATO §5).
SEM_SECRETS="$(render dev -f "$PINS" -f "${FIX}/svc-sem-secrets.yaml")"
nao_contem "nenhuma referencia a probe-sem-secrets-env" "probe-sem-secrets-env" "$SEM_SECRETS"
contem "mas o Deployment do servico existe" "name: probe-sem-secrets" "$SEM_SECRETS"
verifica "e continua havendo 4 ExternalSecrets (um por workload COM secrets)" "4" \
  "$(grep -c '^kind: ExternalSecret$' <<<"$SEM_SECRETS")"

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
