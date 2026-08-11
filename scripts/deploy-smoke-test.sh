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

echo
if (( FAILURES == 0 )); then
  printf '\033[32m✔\033[0m deploy smoke: tudo verde\n'
else
  printf '\033[31m✖\033[0m deploy smoke: %d verificação(ões) falharam\n' "$FAILURES"
  exit 1
fi
