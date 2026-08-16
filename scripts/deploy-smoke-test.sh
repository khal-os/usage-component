#!/usr/bin/env bash
#
# Docker-free smoke test of the deploy scripts: `make deploy-smoke`.
#
# It exercises the two things that only break on a FRESH client — the state
# no manual re-run ever reproduces, which is why both defects survived two
# fix waves:
#
#   A. step 4 must complete for a client that has never had fixtures.
#      `make up` creates demo-data/<cliente>/ EMPTY, and that directory is
#      the dev discriminator `make seed-prices` gates on (decision 74), so
#      generating the fixtures as a side effect of the --traces block made
#      the --prices block abort every first-ever deploy.
#   B. every URL the scripts build must survive the ports being OMITTED
#      from the env file — the env contract explicitly invites that on a
#      dedicated host, and "http://localhost:/api/v1" is a port-80 request
#      that can never answer 401 (the auth fail-closed check then blamed
#      auth forwarding for a URL bug).
#
# Real Makefile, real step-4 script, real deploy-lib. Only `docker` is
# stubbed (nothing here should reach a container), so the ordering and the
# guards under test are the production ones.
#
# Cases C and D guard the OTHER half of the deploy surface — the prose the
# operator and the integrator actually execute (README §Production
# deployment, OpenAPI/Postman, the decision log). Nothing in the test suite
# fails when a documented PROCEDURE is wrong, and both defects of iteration
# 3 lived exactly there: a documented deploy that never migrates, and a
# published contract promising a total the code stopped delivering.

set -euo pipefail
cd "$(dirname "$0")/.."

SLUG="deploy-smoke-test"
ENVFILE="clients/${SLUG}.env"
FIXTURES="demo-data/${SLUG}"
STUBS=""
FAILURES=0

if [[ -e "$ENVFILE" || -e "$FIXTURES" ]]; then
  echo "abortado: ${ENVFILE} ou ${FIXTURES} já existe — remova antes de rodar o smoke" >&2
  exit 1
fi

cleanup() {
  rm -rf "$ENVFILE" "$FIXTURES" "${STUBS:-/nonexistent-stub-dir}"
}
trap cleanup EXIT

ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✖\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
case_() { printf '\n\033[36m▸\033[0m \033[1m%s\033[0m\n' "$1"; }

# `docker` is the ONLY stub: the jobs it would run need a live stack, and
# what is under test is which command runs FIRST, not what the job does.
STUBS="$(mktemp -d)"
printf '#!/bin/sh\nexit 0\n' > "${STUBS}/docker"
chmod +x "${STUBS}/docker"

# The minimal env file the contract sanctions: identity + the required
# client clock (decision 130) + the required browser-visible LangWatch URL
# (compose refuses to interpolate without it). No API_PORT,
# no LANGWATCH_PORT — exactly the "dedicated host, omit them"
# case of clients/example.production.env.
cat > "$ENVFILE" <<EOF
COMPOSE_PROJECT_NAME=${SLUG}
CLIENT_NAME=${SLUG}
CLIENT_TIMEZONE=America/Sao_Paulo
LANGWATCH_PUBLIC_URL=http://localhost:5560
EOF

# ---------------------------------------------------------------------------
case_ "A · fresh client: step 4 --prices completes with an EMPTY demo-data/"
# ---------------------------------------------------------------------------
# This is precisely what step 2 leaves behind (Makefile `up`: mkdir -p only).
mkdir -p "$FIXTURES"

if PATH="${STUBS}:${PATH}" ./scripts/4-seed-demo-data.sh "$SLUG" --prices \
     > "${STUBS}/step4.log" 2>&1; then
  ok "./scripts/4-seed-demo-data.sh ${SLUG} --prices saiu 0"
else
  bad "step 4 abortou (exit $?) — as fixtures ainda são geradas depois do bloco de preços?"
  sed 's/^/    | /' "${STUBS}/step4.log" | tail -20
fi

if compgen -G "${FIXTURES}/*.json" > /dev/null; then
  ok "as fixtures do discriminador DEV existem em ${FIXTURES}/"
else
  bad "nenhum ${FIXTURES}/*.json — o gerador não rodou antes da guarda de seed-prices"
fi

# The guard itself must now be satisfied — asserted through the REAL recipe.
if make -n seed-prices "CLIENT=${SLUG}" 2>&1 | grep -q 'test -n "demo-data/'"${SLUG}"'/'; then
  ok "a guarda DEV do make seed-prices enxerga as fixtures"
else
  bad "a guarda DEV do make seed-prices continua vazia"
fi

# ---------------------------------------------------------------------------
case_ "B · portas omitidas: toda URL construída continua bem-formada"
# ---------------------------------------------------------------------------
(
  # shellcheck source=scripts/deploy-lib.sh
  source scripts/deploy-lib.sh
  NAME="$SLUG"
  ENVFILE="clients/${SLUG}.env"

  [[ "$(host_port API_PORT)"       == "3000" ]] || { echo "API_PORT sem default"; exit 1; }
  [[ "$(host_port LANGWATCH_PORT)" == "5560" ]] || { echo "LANGWATCH_PORT sem default"; exit 1; }

  # The exact URL the auth fail-closed check curls (5-verify-client.sh).
  url="http://localhost:$(host_port API_PORT)/api/v1/traces"
  [[ "$url" == "http://localhost:3000/api/v1/traces" ]] || { echo "URL malformada: ${url}"; exit 1; }

  summary_access | grep -q 'http://localhost:/' && { echo "summary_access ainda imprime porta vazia"; exit 1; }
  exit 0
) && ok "host_port aplica os defaults do compose (3000/5560/8080) e as URLs fecham" \
  || bad "URLs quebram quando as portas são omitidas do env file"

# A port var that IS set must still win over the default.
printf 'API_PORT=3007\n' >> "$ENVFILE"
(
  source scripts/deploy-lib.sh
  NAME="$SLUG"; ENVFILE="clients/${SLUG}.env"
  [[ "$(host_port API_PORT)" == "3007" ]]
) && ok "um API_PORT explícito vence o default" \
  || bad "host_port ignora o valor do env file"

# A port-less env file must also reach the module-register: register-module.sh
# read API_PORT with its own grep|cut and ABORTED when the var was absent —
# stack healthy on 3000, módulo nunca registrado (Farol não descobre).
# NO `| head -1` here: the dry run prints the manifest after the endpoint
# line, and head closing the pipe early SIGPIPEs the script — under
# pipefail that reads as a failure of the script under test.
register_dry() { CLIENT="$SLUG" DRY_RUN=1 ./scripts/register-module.sh 2>&1 || echo "(saiu $?)"; }

out="$(register_dry)"
if [[ "$out" == *"http://localhost:3007"* ]]; then
  ok "register-module.sh resolve o endpoint pelo env file (API_PORT=3007)"
else
  bad "register-module.sh não resolveu o endpoint: $(head -1 <<< "$out")"
fi

# ...and with the ports omitted entirely, the sanctioned shape.
sed -i '/^API_PORT=/d' "$ENVFILE"
out="$(register_dry)"
if [[ "$out" == *"http://localhost:3000"* ]]; then
  ok "register-module.sh aplica o default do compose com API_PORT omitido"
else
  bad "register-module.sh aborta/erra com um env file sem portas: $(head -1 <<< "$out")"
fi

# Source-level: no deploy script may read a port var outside host_port() —
# that is the bug, and it is invisible on any host whose env file happens to
# set the ports. The pattern covers BOTH shapes seen in the wild: an inline
# `$(get API_PORT)` and an assignment from any other command substitution
# (register-module.sh's `API_PORT=$(grep '^API_PORT=' … | cut …)` slipped
# past the get()-only check for a whole wave). `1-init-client-env.sh` is the
# env file's WRITER — it allocates ports with next_free and builds no URL.
RAW_PORT_READS="$(grep -rnE '\$\(get (API_PORT|LANGWATCH_PORT)\)|(API_PORT|LANGWATCH_PORT)="?\$\(' \
  --exclude=deploy-smoke-test.sh scripts/ deploy-demo-client.sh \
  | grep -v 'host_port\|next_free' || true)"
if [[ -n "$RAW_PORT_READS" ]]; then
  bad "porta lida fora do host_port() — URL vira http://localhost:/…"
  sed 's/^/    | /' <<< "$RAW_PORT_READS"
else
  ok "nenhum script lê porta fora do host_port()"
fi

# ---------------------------------------------------------------------------
case_ "C · runbook publicado: o deploy de produção migra"
# ---------------------------------------------------------------------------
# Nada migra sozinho — nenhuma imagem, entrypoint ou serviço roda
# runMigrations; `make migrate` é a única porta. Uma stack subida
# EXATAMENTE como o README documenta ficava sem índice nenhum, e os índices
# carregam correção: o insert-once do ingestor É o índice único de traceId
# e o 409 de preço duplicado É o E11000 do índice de (model, tokenType,
# effectiveFrom). Por isso a seção de produção do README é verificada aqui.
prod_section="$(sed -n '/^## Production deployment$/,/^## /p' README.md)"
if grep -q 'run-migrations.js\|make migrate' <<< "$prod_section"; then
  ok "README §Production deployment traz o passo de migração"
else
  bad "README §Production deployment não migra — stack documentada sobe sem índices"
fi
if grep -q '^make migrate CLIENT=' README.md; then
  ok "o bloco Day-2 do README lista make migrate"
else
  bad "make migrate sumiu do bloco Day-2 do README"
fi

# ---------------------------------------------------------------------------
case_ "D · contrato publicado do teto de contagem == comportamento do código"
# ---------------------------------------------------------------------------
# A iteração 2 passou a limitar o total TAMBÉM sem filtros (decisão 116) e
# não mexeu em nenhuma superfície que o cliente lê. Nada no código quebra
# quando a prosa mente — por isso a checagem é aqui, cruzando as duas.
CAP_LINE='packages/core/src/infrastructure/database/mongodb/trace/mongodb-trace-query-repository.ts'
if grep -q '^\s*const totalCapped = rawTotal > TOTAL_CAP;$' "$CAP_LINE"; then
  ok "o código limita o total nas DUAS metades (com e sem filtros)"
else
  bad "o teto de contagem mudou de forma — reveja OpenAPI/Postman/decisão 116 junto"
fi

STALE_EXACTNESS="$(grep -rn 'Sem filtros o total é exato\|sem filtros o total é exato' \
  packages/module/src/main/docs/openapi.ts docs/observability-api.postman_collection.json || true)"
if [[ -z "$STALE_EXACTNESS" ]]; then
  ok "OpenAPI e Postman não prometem mais total exato sem filtros"
else
  bad "contrato publicado promete exatidão que o código não entrega"
  sed 's/^/    | /' <<< "$STALE_EXACTNESS"
fi

if grep -q 'emendada pela decisão 116' docs/produto/backlog-v2.3.md; then
  ok "a decisão 77(b) carrega a emenda do teto (decisão 116)"
else
  bad "o log de decisões ainda afirma o comportamento anterior ao teto único"
fi

# Byte NUL em fonte torna o arquivo BINÁRIO para o git: o diff some e a
# revisão passa a ser impossível — foi o que aconteceu com o motor de
# extrato, a UNA conta de billing, por seis versões (decisão 122). O
# sentinela de nulo continua sendo U+0000; o que se exige é que venha
# ESCAPADO no fonte. Feito em python de propósito: o grep desta máquina
# (ugrep) dá falso-negativo justamente em NUL — a busca era metade do bug.
NUL_FILES="$(python3 - <<'PY'
import pathlib
roots = [pathlib.Path('packages')]
hits = [
    str(path)
    for root in roots
    for path in root.rglob('*')
    if path.is_file()
    and path.suffix in {'.ts', '.js', '.mjs', '.json', '.md', '.html', '.css'}
    and 'node_modules' not in path.parts
    and 'dist' not in path.parts
    and 'coverage' not in path.parts
    and b'\x00' in path.read_bytes()
]
print('\n'.join(hits))
PY
)"
if [[ -z "$NUL_FILES" ]]; then
  ok "nenhum fonte com byte NUL cru (git trataria como binário)"
else
  bad "fonte com NUL cru — git vai tratar como binário e o diff some"
  sed 's/^/    | /' <<< "$NUL_FILES"
fi

# ---------- E · o portão de teste existe (E-1 da auditoria pós-split) ----------
# O split apagou o único comando que rodava a suíte inteira: `npm test` na
# raiz respondia "Missing script" — erro de USO, que lê como ruído de
# ferramenta, então uma mudança no core quebrava 37 suítes do module sem
# ninguém rodá-las. Este check falha se o portão sumir de novo.
case_ "E · npm test/typecheck existem na raiz e cobrem os workspaces"
ROOT_SCRIPTS="$(node -e '
const s = require("./package.json").scripts ?? {};
const need = { test: "--workspaces", typecheck: "--workspaces", "test:ci": "packaging-check" };
const missing = Object.entries(need)
  .filter(([name, marker]) => !(s[name] ?? "").includes(marker))
  .map(([name]) => name);
console.log(missing.join(" "));
')"
if [[ -z "$ROOT_SCRIPTS" ]]; then
  ok "raiz tem test/typecheck em --workspaces e test:ci passa pelo packaging-check"
else
  bad "scripts da raiz ausentes/errados: $ROOT_SCRIPTS"
fi
if [[ -f scripts/packaging-check.mjs ]] && node --check scripts/packaging-check.mjs 2>/dev/null; then
  ok "packaging-check.mjs presente e sintaticamente válido"
else
  bad "scripts/packaging-check.mjs ausente ou inválido"
fi

# ═══════════════════════════════════════════════════════════════════════════
# F-I · a fábrica AWS. Tudo abaixo roda SEM conta nenhuma: `aws` é um stub
# no PATH. É de propósito — o que se prova aqui é que o portão RECUSA um
# contrato quebrado, e nenhuma conta de verdade fica quebrada de propósito
# para servir de fixture. As três violações testadas (0/100, desiredCount,
# família ausente) são exatamente as que não geram erro nenhum em produção.
# ═══════════════════════════════════════════════════════════════════════════

TDIR="${STUBS}/tenants"
AWSFIX="${STUBS}/awsfix"
mkdir -p "$TDIR" "$AWSFIX"

# O stub do `aws`: despacha por "<serviço> <operação>", responde com o
# arquivo de fixture correspondente e registra TODA chamada, para que os
# testes possam afirmar o que foi (e o que não foi) chamado.
cat > "${STUBS}/aws" <<'AWSSTUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$AWS_STUB_LOG"
key="${1}_${2}"
[ -f "${AWS_STUB_DIR}/${key}.deny" ] && {
  echo "An error occurred (AccessDeniedException) when calling the ${2} operation: not authorized to perform ${1}:${2}" >&2
  exit 254
}
[ -f "${AWS_STUB_DIR}/${key}.txt" ]  && { cat "${AWS_STUB_DIR}/${key}.txt";  exit 0; }
[ -f "${AWS_STUB_DIR}/${key}.json" ] && { cat "${AWS_STUB_DIR}/${key}.json"; exit 0; }
echo "An error occurred (ResourceNotFoundException) when calling the ${2} operation" >&2
exit 254
AWSSTUB
chmod +x "${STUBS}/aws"

tenant_file() { # <slug> [<linha extra>…] — o restante vem do example.env
  local slug="$1"; shift
  sed -e "s/^CLIENT_NAME=.*/CLIENT_NAME=${slug}/" \
      -e "s/^AWS_ACCOUNT_ID=.*/AWS_ACCOUNT_ID=111122223333/" \
      -e "s#^MONGO_SECRET_ARN=.*#MONGO_SECRET_ARN=arn:aws:secretsmanager:sa-east-1:111122223333:secret:khal/${slug}/prod/usage/mongo-AbCdEf#" \
      -e "s#^LANGWATCH_SECRET_ARN=.*#LANGWATCH_SECRET_ARN=arn:aws:secretsmanager:sa-east-1:111122223333:secret:khal/${slug}/prod/usage/langwatch-AbCdEf#" \
      -e "s/^BASE_DOMAIN=.*/BASE_DOMAIN=${slug}.khal.ai/" \
      -e "s/^IMAGE_SHA=.*/IMAGE_SHA=/" \
      deploy/tenants/example.env > "${TDIR}/${slug}.env"
  local extra
  for extra in "$@"; do printf '%s\n' "$extra" >> "${TDIR}/${slug}.env"; done
}

naming() { TENANT_DIR="$TDIR" bash deploy/scripts/naming.sh "$@" 2>&1; }

# ---------------------------------------------------------------------------
case_ "F · naming.sh: UMA fórmula, e recusa em vez de truncar"
# ---------------------------------------------------------------------------
# O log group errado sobreviveu meses porque nada compara o nome calculado
# com o esperado; é isso que esta lista literal faz. Roda contra o
# example.env de verdade, no diretório de verdade.
expect_example() { # <função+args> <esperado>
  local got
  # shellcheck disable=SC2086 # $1 carrega função + argumentos, é para dividir
  got="$(bash deploy/scripts/naming.sh example $1 2>&1)" || true
  if [[ "$got" == "$2" ]]; then ok "example: $1 → $2"; else bad "example: $1 → '$got' (esperado '$2')"; fi
}
expect_example "name_base"                "khal-example-prod-usage"
expect_example "name_service api"         "khal-example-prod-usage-api"
expect_example "name_service connector"   "khal-example-prod-usage-connector"
expect_example "name_role execution"      "khal-example-prod-usage-execution"
expect_example "name_sg workers"          "khal-example-prod-usage-workers"
expect_example "ecr_repo module"          "khal-example-prod-usage-module"
expect_example "ecr_repo db-backup"       "khal-example-prod-usage-db-backup"
expect_example "secret_id mongo"          "khal/example/prod/usage/mongo"
expect_example "ssm_param langwatch-capacity" "/khal/example/prod/usage/langwatch-capacity"
expect_example "log_group api"            "/khal/example/prod/usage/api"
expect_example "hostname_api"             "api.example.khal.ai"
expect_example "env_word"                 "production"

# As quatro recusas. Cada uma já custou (ou custaria) um deploy na conta
# errada, um nome truncado num '-' final, ou duas identidades no mesmo
# arquivo.
refuses() { # <descrição> <cliente> <padrão esperado no erro>
  local out rc=0
  out="$(naming "$2" name_base)" || rc=$?
  if [[ $rc -ne 0 && "$out" == *"$3"* ]]; then ok "recusa: $1"
  else bad "NÃO recusou: $1 (saída: ${out:0:120})"; fi
}

tenant_file thirteenchars   # 13 caracteres — khal-…-prod-usage-api daria 33
refuses "slug de 13 caracteres" thirteenchars "2-12 chars"
tenant_file mismatch
sed -i 's/^CLIENT_NAME=.*/CLIENT_NAME=outrocliente/' "${TDIR}/mismatch.env"
refuses "CLIENT_NAME diferente do nome do arquivo" mismatch "but the file is"
tenant_file noenv
sed -i '/^ENVIRONMENT=/d' "${TDIR}/noenv.env"
refuses "ENVIRONMENT ausente" noenv "declares no ENVIRONMENT"
tenant_file wordyenv
sed -i 's/^ENVIRONMENT=.*/ENVIRONMENT=production/' "${TDIR}/wordyenv.env"
refuses "ENVIRONMENT=production (a grafia do CONTAINER, não da AWS)" wordyenv "use prod or hml"
refuses "tenant inexistente" naoexiste "no tenant file"

# ---------------------------------------------------------------------------
case_ "G · task definitions: renderizadas do template, nunca clonadas"
# ---------------------------------------------------------------------------
tenant_file smoke
SMOKE_SHA=$(printf 'a%.0s' {1..40})
render() { TENANT_DIR="$TDIR" bash deploy/scripts/render-taskdef.sh smoke "$1" "$SMOKE_SHA" 2>&1 || true; }

for fam in api connector scheduler backup; do
  out="$(render "$fam")"
  if python3 -c "import json,sys; json.loads(sys.stdin.read())" <<< "$out" 2>/dev/null; then
    ok "template ${fam} renderiza JSON válido"
  else
    bad "template ${fam} não renderiza JSON válido: $(head -2 <<< "$out")"
    continue
  fi
  CHECK="$out" python3 - "$fam" <<'PY' || bad "conteúdo do template inesperado"
import json, os, sys
fam = sys.argv[1]
d = json.loads(os.environ["CHECK"])
c = d["containerDefinitions"][0]
want_name = {"api": "api", "connector": "connector", "scheduler": "scheduler", "backup": "backup"}[fam]
want_repo = {"api": "module", "connector": "connector", "scheduler": "module", "backup": "db-backup"}[fam]
assert d["family"] == f"khal-smoke-prod-usage-{fam}", d["family"]
assert c["name"] == want_name, c["name"]
assert c["image"].endswith(f"khal-smoke-prod-usage-{want_repo}:" + "a" * 40), c["image"]
assert c["logConfiguration"]["options"]["awslogs-group"] == f"/khal/smoke/prod/usage/{fam}", c
assert all(s["valueFrom"].startswith("arn:aws:") for s in c["secrets"]), c["secrets"]
# O que cada família carrega de específico e ninguém percebe se sumir.
if fam == "connector":
    assert c["stopTimeout"] == 60, "sem stopTimeout: um lote é morto no meio"
    assert any(s["name"] == "LANGWATCH_PROJECT_ID" for s in c["secrets"])
if fam == "scheduler":
    assert c["command"] == ["node", "dist/main/jobs/run-billing-close-scheduler.js"], c.get("command")
if fam == "backup":
    assert d["taskRoleArn"].endswith("khal-smoke-prod-usage-backup-task"), d["taskRoleArn"]
PY
done
ok "quatro famílias renderizadas com nome, repo, log group e valueFrom esperados"

# CORS vazio no tenant file vira o domínio do próprio cliente — derivado,
# nunca uma lista mantida à mão.
if render api | grep -q '"value": "https://\*\.smoke\.khal\.ai"'; then
  ok "CORS_ALLOWED_ORIGINS vazio deriva https://*.<BASE_DOMAIN>"
else
  bad "CORS vazio não derivou o domínio do cliente"
fi

# Um valor obrigatório em branco é recusado — não renderizado vazio.
tenant_file blanktz
sed -i 's/^CLIENT_TIMEZONE=.*/CLIENT_TIMEZONE=/' "${TDIR}/blanktz.env"
if TENANT_DIR="$TDIR" bash deploy/scripts/render-taskdef.sh blanktz api "$SMOKE_SHA" >/dev/null 2>&1; then
  bad "renderizou com CLIENT_TIMEZONE em branco"
else
  ok "recusa renderizar com um valor obrigatório em branco"
fi

# ---------------------------------------------------------------------------
case_ "H · preflight --gate: pega o que a AWS não reclama"
# ---------------------------------------------------------------------------
export AWS_STUB_DIR="$AWSFIX" AWS_STUB_LOG="${STUBS}/aws-calls.log"
: > "$AWS_STUB_LOG"

services_json() { # <min> <max> <desired> — os três do connector
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
minp, maxp, desired = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
def svc(name, dc, count, extra=None):
    s = {"serviceName": f"khal-smoke-prod-usage-{name}", "status": "ACTIVE",
         "desiredCount": count, "deploymentConfiguration": dc,
         "networkConfiguration": {"awsvpcConfiguration": {"subnets": ["subnet-a", "subnet-b"]}},
         "loadBalancers": []}
    if extra:
        s.update(extra)
    return s
api_dc = {"minimumHealthyPercent": 100, "maximumPercent": 200,
          "deploymentCircuitBreaker": {"enable": True, "rollback": True}}
worker_dc = {"minimumHealthyPercent": minp, "maximumPercent": maxp}
print(json.dumps({"services": [
    svc("api", api_dc, 1, {"loadBalancers": [{"targetGroupArn": "arn:aws:elasticloadbalancing:::x"}]}),
    svc("connector", worker_dc, desired),
    svc("scheduler", {"minimumHealthyPercent": 0, "maximumPercent": 100}, 1),
], "failures": []}))
PY
}
printf '{"taskDefinition":{"status":"ACTIVE","containerDefinitions":[{"image":"x:%s"}]}}\n' "$SMOKE_SHA" \
  > "${AWSFIX}/ecs_describe-task-definition.json"

gate() { TENANT_DIR="$TDIR" PATH="${STUBS}:${PATH}" bash deploy/scripts/preflight-aws.sh --gate smoke 2>&1; }

services_json 0 100 1 > "${AWSFIX}/ecs_describe-services.json"
if out="$(gate)"; then ok "conta conforme: o portão sai 0"; else bad "conta conforme reprovada: $(grep '✖' <<< "$out" | head -3)"; fi

# ESTE é o teste. 100/200 é o DEFAULT da AWS, não gera erro nenhum, e põe
# dois connectors vivos ao mesmo tempo — dois leitores do mesmo watermark,
# que não tem lease. Os traces da janela entram duplicados no arquivo
# permanente e nada, em lugar nenhum, reclama.
services_json 100 200 1 > "${AWSFIX}/ecs_describe-services.json"
out="$(gate)" && bad "connector em 100/200 PASSOU no portão" || {
  if grep -q 'MUST be 0/100' <<< "$out"; then ok "connector em 100/200 reprova e o erro nomeia o singleton"
  else bad "reprovou, mas sem nomear a violação de singleton"; fi
}

services_json 0 100 2 > "${AWSFIX}/ecs_describe-services.json"
out="$(gate)" && bad "connector com desiredCount=2 PASSOU no portão" || {
  grep -q 'desiredCount = 2' <<< "$out" && ok "desiredCount=2 reprova (dois escritores PERMANENTES)" \
    || bad "reprovou sem nomear o desiredCount"
}

services_json 0 100 1 > "${AWSFIX}/ecs_describe-services.json"
rm -f "${AWSFIX}/ecs_describe-task-definition.json"
out="$(gate)" && bad "família de task-def ausente PASSOU no portão" || \
  ok "família ausente reprova ANTES do deploy (em vez de morrer no meio)"
printf '{"taskDefinition":{"status":"ACTIVE","containerDefinitions":[{"image":"x:%s"}]}}\n' "$SMOKE_SHA" \
  > "${AWSFIX}/ecs_describe-task-definition.json"

# AccessDenied != ausente. Um buraco de permissão lido como "recurso não
# existe" manda o operador procurar no lugar errado.
touch "${AWSFIX}/ecs_describe-services.deny"
out="$(gate)" && bad "AccessDenied passou como verde" || {
  grep -q 'cannot verify' <<< "$out" && ok "AccessDenied vira 'cannot verify', não 'ausente'" \
    || bad "AccessDenied relatado como recurso ausente"
}
rm -f "${AWSFIX}/ecs_describe-services.deny"

# ---------------------------------------------------------------------------
case_ "I · --register-only: registra as 4 famílias e não toca em serviço"
# ---------------------------------------------------------------------------
: > "$AWS_STUB_LOG"
echo 'arn:aws:ecs:sa-east-1:111122223333:task-definition/khal-smoke-prod-usage-api:7' \
  > "${AWSFIX}/ecs_register-task-definition.txt"
echo '{"imageDetails":[{}]}' > "${AWSFIX}/ecr_describe-images.json"

if TENANT_DIR="$TDIR" PATH="${STUBS}:${PATH}" \
   bash deploy/scripts/deploy-tenant.sh --register-only smoke "$SMOKE_SHA" > "${STUBS}/register.log" 2>&1; then
  ok "--register-only saiu 0"
else
  bad "--register-only falhou: $(tail -3 "${STUBS}/register.log")"
fi
REG=$(grep -c '^ecs register-task-definition' "$AWS_STUB_LOG" || true)
UPD=$(grep -c '^ecs update-service' "$AWS_STUB_LOG" || true)
[[ "$REG" == "4" ]] && ok "registrou exatamente 4 famílias" || bad "registrou ${REG} famílias (esperado 4)"
[[ "$UPD" == "0" ]] && ok "não chamou update-service nenhuma vez" || bad "chamou update-service ${UPD}x num --register-only"

# Nada é clonado da revisão atual: se fosse, uma task def de placeholder
# criada pela infra se propagaria para sempre.
if grep -q '^ecs describe-task-definition' "$AWS_STUB_LOG"; then
  bad "--register-only leu a revisão atual — o template deixou de ser a fonte"
else
  ok "nenhum describe-task-definition: a revisão vem do template, não do que já está lá"
fi

# ---------------------------------------------------------------------------
case_ "J · --fleet: o dígito nomeia a conta ruim e o webhook ausente reprova"
# ---------------------------------------------------------------------------
# Não é a auditoria completa que se prova aqui (isso exigiria fixture de
# ~20 serviços da AWS): é o CAMINHO do heartbeat — itera os tenants, assume
# o papel de auditoria em cada um, e o dígito carrega a violação de cada
# conta. O POST no Slack em si não é exercitado; o que se pin a é a recusa
# quando o webhook falta (139: heartbeat que não alcança ninguém é o
# silêncio que ele existe para evitar).
# Só ficam os dois tenants VÁLIDOS: os arquivos de recusa do caso F fariam
# o `tenant_load` morrer na primeira iteração, que é o comportamento certo
# mas não é o que se mede aqui. `smoke` é o que casa com a fixture dos
# serviços (100/200); `outra` responde serviço ausente.
tenant_file outra
rm -f "${TDIR}/thirteenchars.env" "${TDIR}/mismatch.env" "${TDIR}/noenv.env" \
      "${TDIR}/wordyenv.env" "${TDIR}/blanktz.env"
# Sem token OIDC (que é o caso de um operador rodando na mão), o --fleet
# audita a conta em que as credenciais JÁ estão e recusa as outras pelo
# nome. Não existe assume-role aqui de propósito: o papel de auditoria é
# confiado só pelo provedor OIDC, então assumir a partir de outro papel é
# negado pela política de confiança (decisão 159).
printf '111122223333\n' > "${AWSFIX}/sts_get-caller-identity.txt"
services_json 100 200 1 > "${AWSFIX}/ecs_describe-services.json"

FLEET_OUT="$(TENANT_DIR="$TDIR" PATH="${STUBS}:${PATH}" \
  bash deploy/scripts/preflight-aws.sh --fleet 2>&1 || true)"

if grep -q 'fleet heartbeat — 2 account(s)' <<< "$FLEET_OUT"; then
  ok "o dígito cobre as duas contas dos tenant files"
else
  bad "o dígito não iterou os dois tenants: $(grep -c . <<< "$FLEET_OUT") linhas"
fi
if grep -qE '^:x: smoke — .*MUST be 0/100' <<< "$FLEET_OUT"; then
  ok "a linha da conta nomeia a violação (o singleton em 100/200)"
else
  bad "a linha da conta não nomeia a violação: $(grep '^:x:' <<< "$FLEET_OUT" | head -1)"
fi
if grep -q 'nowhere to report' <<< "$FLEET_OUT"; then
  ok "sem FLEET_HEARTBEAT_SLACK_WEBHOOK a rodada FALHA em vez de postar no vazio"
else
  bad "webhook ausente não reprovou a rodada"
fi

# Conta que as credenciais correntes não alcançam tem que ser RECUSADA pelo
# nome — nunca contada como verde. Um dígito que omite a conta que não deu
# pra auditar é exatamente o silêncio que o heartbeat existe para evitar.
tenant_file outraconta
sed -i 's/^AWS_ACCOUNT_ID=.*/AWS_ACCOUNT_ID=999988887777/' "${TDIR}/outraconta.env"
FLEET_OUT2="$(TENANT_DIR="$TDIR" PATH="${STUBS}:${PATH}" \
  bash deploy/scripts/preflight-aws.sh --fleet 2>&1 || true)"
if grep -qE '^:x: outraconta — .*(999988887777|111122223333)' <<< "$FLEET_OUT2"; then
  ok "conta inalcançável aparece no dígito com o motivo, não como verde"
else
  bad "conta inalcançável não foi nomeada: $(grep '^:x: outraconta' <<< "$FLEET_OUT2" | head -1)"
fi
rm -f "${TDIR}/outraconta.env"

# ---------------------------------------------------------------------------
case_ "K · scripts de deploy: sintaxe e nenhum nome literal sobrevivendo"
# ---------------------------------------------------------------------------
for s in deploy/scripts/*.sh deploy/langwatch/langwatch-bootstrap.sh; do
  bash -n "$s" 2>/dev/null || bad "erro de sintaxe em ${s}"
done
ok "bash -n limpo em deploy/scripts/*.sh"

# A fórmula mora em UM arquivo. Um `khal-<algo>` escrito à mão em qualquer
# outro script é a segunda cópia que o naming.sh existe para não ter.
HARDCODED="$(grep -rnE '"khal-[a-z]|khal-\$\{?CLIENT|usage-main|usage-\$\{CLIENT' \
  deploy/scripts/ .github/workflows/ --include='*.sh' --include='*.yml' \
  | grep -v 'naming.sh' || true)"
if [[ -z "$HARDCODED" ]]; then
  ok "nenhum nome de recurso literal fora do naming.sh"
else
  bad "nome de recurso montado fora do naming.sh"
  sed 's/^/    | /' <<< "$HARDCODED"
fi

unset AWS_STUB_DIR AWS_STUB_LOG

echo
if (( FAILURES == 0 )); then
  printf '\033[32m✔\033[0m deploy smoke: tudo verde\n'
else
  printf '\033[31m✖\033[0m deploy smoke: %d verificação(ões) falharam\n' "$FAILURES"
  exit 1
fi
