#!/usr/bin/env bash
#
# STEP 3 — onboard: automatic LangWatch onboarding for one client.
# Registers admin@<name>.com with a random password (persisted as a
# comment in the env file BEFORE any fallible step — a crash never loses
# the password of a created user), creates organization + project via the
# instance's own tRPC API, stamps the PROJECT ID into the env file and
# re-applies the stack — the id is what turns ingestion on (the
# trace-ingestion-worker's ClickHouse gate keys on it, decisão 127). The
# project API KEY never touches the env file: no container reads it, the
# demo push fetches it from LangWatch's Postgres at push time, and a real
# client copies it from the LangWatch UI for the platform vault.
#
#   ./scripts/3-onboard-langwatch.sh <name>
#
# Idempotent: PROJECT_ID already in the env is a no-op; a project already
# in LangWatch (manual onboarding via the UI) is backfilled from Postgres.
# If the automatic flow fails, onboard manually in the LangWatch UI and
# re-run this script — it backfills the id.

cd "$(dirname "$0")/.."
source scripts/deploy-lib.sh

require_name "${1:-}"
require_envfile
banner 3 "onboarding LangWatch — admin · org · projeto · project id"

# The browser-visible URL (clients/<name>.env, required — the same value
# compose feeds LangWatch as NEXTAUTH_URL): auth validates Host/Origin
# against it, so onboarding MUST talk to this exact URL. Workstation:
# http://localhost:<port>. Public deploy: the reverse-proxy URL — which
# therefore must be up BEFORE this step (deploy/RUNBOOK-VM.md).
BASE="$(get LANGWATCH_PUBLIC_URL)"
[[ -n "$BASE" ]] || die "LANGWATCH_PUBLIC_URL ausente em ${ENVFILE} — defina a URL do LangWatch visível no navegador (local: http://localhost:$(host_port LANGWATCH_PORT); público: https://langwatch.<host>)"

# sed_escape: the replacement side treats & \ | as metacharacters.
stamp_project_id() {
  if grep -q '^LANGWATCH_PROJECT_ID=' "$ENVFILE"; then
    sed -i "s|^LANGWATCH_PROJECT_ID=.*|LANGWATCH_PROJECT_ID=$(sed_escape "$1")|" "$ENVFILE"
  else
    append_env_line "LANGWATCH_PROJECT_ID=$1"
  fi
}

if [[ -n "$(get LANGWATCH_PROJECT_ID)" ]]; then
  step "onboarding: LANGWATCH_PROJECT_ID já presente no env — nada a fazer"
  summary_credentials
  exit 0
fi

# A project already in LangWatch's Postgres (manual UI onboarding) only
# needs the id backfilled — and since the id is what ENABLES ingestion,
# the backfill must re-apply the stack.
PROJECT_ID="$(lw_project_id || true)"
if [[ -n "$PROJECT_ID" ]]; then
  stamp_project_id "$PROJECT_ID"
  step "onboarding: projeto já existia — project id backfilled (${PROJECT_ID}); recriando o worker"
  make -s up "CLIENT=${NAME}"
  summary_credentials
  exit 0
fi

lw_ready "$BASE" || die "LangWatch não responde em ${BASE} — rode ./scripts/2-provision-client-stack.sh ${NAME} antes; se LANGWATCH_PUBLIC_URL aponta para um reverse proxy, ele também precisa estar no ar"

trpc_ok() { # $1 = tRPC batch response; fails if it carries an error
  python3 -c 'import json,sys; body=json.loads(sys.argv[1]); sys.exit(1 if "error" in body[0] else 0)' "$1"
}

LW_ADMIN_EMAIL="admin@${NAME}.com"

{
  step "onboarding do LangWatch (admin: ${LW_ADMIN_EMAIL}) — via ${BASE}"
  JAR="$(mktemp)"
  # The jar holds an authenticated session cookie — never leave it in /tmp,
  # success or failure (every die/curl-failure path exits through this trap).
  trap 'rm -f "$JAR"' EXIT

  # Senha persistida no env (gitignored) ANTES de qualquer passo que possa
  # falhar — um crash no meio nunca perde a senha de um usuário já criado.
  STORED_PW="$(grep -oP "(?<=^# LangWatch admin \(gerado pelo deploy\): ${LW_ADMIN_EMAIL} / ).*" "$ENVFILE" | head -1 || true)"
  if [[ -n "$STORED_PW" ]]; then
    LW_ADMIN_PASSWORD="$STORED_PW"
  else
    LW_ADMIN_PASSWORD="$(openssl rand -base64 18)"
    append_env_line "$(printf '# LangWatch admin (gerado pelo deploy): %s / %s' "$LW_ADMIN_EMAIL" "$LW_ADMIN_PASSWORD")"
  fi

  reg=$(curl -s -m 20 -X POST "${BASE}/api/trpc/user.register?batch=1" \
    -H 'Content-Type: application/json' -H "Origin: ${BASE}" \
    -d "{\"0\":{\"json\":{\"name\":\"Admin ${NAME}\",\"email\":\"${LW_ADMIN_EMAIL}\",\"password\":\"${LW_ADMIN_PASSWORD}\"}}}")
  # Usuário já existente não é fatal: o sign-in abaixo decide (senha vem
  # do env quando o registro aconteceu numa execução anterior).
  if trpc_ok "$reg"; then sub "usuário admin criado"; else sub "usuário já existia — sign-in com a senha do env"; fi

  curl -sf -m 20 -c "$JAR" -o /dev/null -X POST "${BASE}/api/auth/sign-in/email" \
    -H 'Content-Type: application/json' -H "Origin: ${BASE}" \
    -d "{\"email\":\"${LW_ADMIN_EMAIL}\",\"password\":\"${LW_ADMIN_PASSWORD}\"}" \
    || die "sign-in do admin falhou — complete o onboarding manualmente em ${BASE} (a UI cria org+projeto) e rode este script de novo: ele backfilla o LANGWATCH_PROJECT_ID do Postgres"
  sub "sessão autenticada"

  org=$(curl -s -m 20 -b "$JAR" -X POST "${BASE}/api/trpc/organization.createAndAssign?batch=1" \
    -H 'Content-Type: application/json' -H "Origin: ${BASE}" \
    -d "{\"0\":{\"json\":{\"orgName\":\"${NAME}\"}}}")
  trpc_ok "$org" || die "criação da organização falhou: ${org:0:200}"
  ORG_ID=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1])[0]["result"]["data"]["json"]; print(d["organization"]["id"])' "$org")
  TEAM_ID=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1])[0]["result"]["data"]["json"]; print(d["team"]["id"])' "$org")
  sub "organização criada (${ORG_ID})"

  proj=$(curl -s -m 20 -b "$JAR" -X POST "${BASE}/api/trpc/project.create?batch=1" \
    -H 'Content-Type: application/json' -H "Origin: ${BASE}" \
    -d "{\"0\":{\"json\":{\"organizationId\":\"${ORG_ID}\",\"teamId\":\"${TEAM_ID}\",\"name\":\"${NAME}\",\"language\":\"other\",\"framework\":\"other\"}}}")
  trpc_ok "$proj" || die "criação do projeto falhou: ${proj:0:200}"
  sub "projeto criado"

}

# Stamp the project id — since decision 127 this is what ENABLES ingestion
# (the worker's ClickHouse gate keys on it), so failing to read it is a
# hard error, not a skip. The API key stays in LangWatch's Postgres only.
PROJECT_ID="$(lw_project_id || true)"
[[ -n "$PROJECT_ID" ]] || die "não consegui ler o project id — sem LANGWATCH_PROJECT_ID a ingestão fica DESLIGADA (decisão 127)"
stamp_project_id "$PROJECT_ID"
sub "project id aplicado (${PROJECT_ID})"

step "onboarding aplicado — recriando a stack (o PROJECT ID liga o trace-ingestion-worker)"
# Direto no terminal (sem `live`): preserva o renderer nativo animado do compose.
make -s up "CLIENT=${NAME}"

summary_credentials
