#!/usr/bin/env bash
#
# STEP 1 — env: materialize clients/<name>.env (the client's whole contract
# and deployment state). Creates it once — secrets minted here, ports
# auto-allocated skipping other clients and live listeners — and NEVER
# regenerates secrets on re-run. Idempotent extra that does apply to an
# existing file: --env overrides.
#
#   ./scripts/1-init-client-env.sh <name> [options]
#
#   --api-port N          host port for the API        (default: first free from 3001)
#   --langwatch-port N    host port for LangWatch      (default: first free from 5561)
#   --ui-port N           host port for the client UI  (default: first free from 8081)
#   --mongo-host-port N   dev-only Compass port        (default: first free from 27018)
#   --mongo-user U        enable mongo auth (with --mongo-pass; BEFORE first boot)
#   --mongo-pass P
#   --image REF           module image reference       (default: platform-module:local)
#   --connector-image REF connector image reference    (default: platform-connector:local)
#   --env KEY=VALUE       set/override ANY contract var (repeatable) — e.g.
#                         --env TRACE_INGESTION_QUIET_PERIOD_SECONDS=60 --env TRACE_INGESTION_BATCH_SIZE=200
#                         (see clients/example.production.env for the full contract)

cd "$(dirname "$0")/.."
source scripts/deploy-lib.sh

require_name "${1:-}"; shift || true
banner 1 "env — contrato do cliente"

API_PORT="" LANGWATCH_PORT="" UI_PORT="" MONGO_HOST_PORT="" MONGO_USER="" MONGO_PASS=""
IMAGE="platform-module:local" CONNECTOR_IMAGE_REF="platform-connector:local"
declare -a ENV_OVERRIDES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-port)        API_PORT="$2"; shift 2 ;;
    --langwatch-port)  LANGWATCH_PORT="$2"; shift 2 ;;
    --ui-port)         UI_PORT="$2"; shift 2 ;;
    --mongo-host-port) MONGO_HOST_PORT="$2"; shift 2 ;;
    --mongo-user)      MONGO_USER="$2"; shift 2 ;;
    --mongo-pass)      MONGO_PASS="$2"; shift 2 ;;
    --image)           IMAGE="$2"; shift 2 ;;
    --connector-image) CONNECTOR_IMAGE_REF="$2"; shift 2 ;;
    --env)             [[ "$2" =~ ^[A-Z_]+=.*$ ]] || die "--env espera KEY=VALUE: '$2'"
                       ENV_OVERRIDES+=("$2"); shift 2 ;;
    *) die "opção desconhecida: $1" ;;
  esac
done

[[ -z "$MONGO_USER" || -n "$MONGO_PASS" ]] || die "--mongo-user exige --mongo-pass"

# ---------- port allocation (skip ports used by env files or listeners) ----------
used_ports() {
  grep -hoE '^(API_PORT|LANGWATCH_PORT|UI_PORT|MONGO_HOST_PORT)=[0-9]+' clients/*.env 2>/dev/null | grep -oE '[0-9]+$'
  ss -ltnH 2>/dev/null | awk '{print $4}' | grep -oE '[0-9]+$'
}

next_free() {
  local port=$1
  local used; used="$(used_ports)"
  while grep -qx "$port" <<< "$used"; do port=$((port + 1)); done
  echo "$port"
}

# ---------- env file (create once; never regenerate secrets) ----------
if [[ -f "$ENVFILE" ]]; then
  step "env: reaproveitando ${ENVFILE} (idempotente)"
else
  API_PORT="${API_PORT:-$(next_free 3001)}"
  LANGWATCH_PORT="${LANGWATCH_PORT:-$(next_free 5561)}"
  UI_PORT="${UI_PORT:-$(next_free 8081)}"
  MONGO_HOST_PORT="${MONGO_HOST_PORT:-$(next_free 27018)}"
  step "env: criando ${ENVFILE}"
  info "portas: api ${API_PORT} · ui ${UI_PORT} · langwatch ${LANGWATCH_PORT} · mongo-dev ${MONGO_HOST_PORT}"
  cat > "$ENVFILE" << EOF
# Gerado por 1-init-client-env.sh em $(date -u +%FT%TZ) — contrato: clients/example.production.env
COMPOSE_PROJECT_NAME=${NAME}
CLIENT_NAME=${NAME}

# Decisão 130 (OBRIGATÓRIO): fuso de negócio do cliente (IANA) — fronteira
# de faturamento = fuso de exibição. Forward-only: nunca mude após um mês
# fechado.
CLIENT_TIMEZONE=${CLIENT_TIMEZONE:-America/Sao_Paulo}

API_PORT=${API_PORT}
LANGWATCH_PORT=${LANGWATCH_PORT}
UI_PORT=${UI_PORT}

# OBRIGATÓRIO (compose recusa vazio): URL de LangWatch visível no NAVEGADOR.
# Deploy público: troque pela URL do reverse proxy (deploy/RUNBOOK-VM.md),
# ou já crie o cliente com --env LANGWATCH_PUBLIC_URL=https://langwatch.<host>
LANGWATCH_PUBLIC_URL=http://localhost:${LANGWATCH_PORT}

MONGO_DB_USER=${MONGO_USER}
MONGO_DB_PASSWORD=${MONGO_PASS}

# Decisão 139 (OBRIGATÓRIO): nome do database do usage store — declarado,
# nunca inferido (o fallback CLIENT_NAME foi removido).
MONGO_USAGE_DB_NAME=${NAME}

# Decisão 139 (OBRIGATÓRIO): capacidade do LangWatch é decisão explícita —
# compose recusa subir sem os cinco. Valores DEV; produção dimensiona por
# cliente (example.production.env §9).
LANGWATCH_WORKERS_REPLICAS=1
LANGWATCH_MEMORY_LIMIT=2g
LW_REDIS_MEMORY_LIMIT=512m
LW_CLICKHOUSE_MEMORY_LIMIT=2g
LW_CLICKHOUSE_CPU_LIMIT=1.0


LW_NEXTAUTH_SECRET=$(openssl rand -base64 32)
LW_API_TOKEN_JWT_SECRET=$(openssl rand -base64 32)
LW_CREDENTIALS_SECRET=$(openssl rand -base64 32)

MODULE_IMAGE=${IMAGE}
CONNECTOR_IMAGE=${CONNECTOR_IMAGE_REF}

# Sync-worker DEMO knobs — fast feedback for demo stacks. Production
# defaults are 60/1000/900/3600 (see clients/example.production.env, decision 61).
TRACE_INGESTION_INTERVAL_SECONDS=5
TRACE_INGESTION_BATCH_SIZE=100
TRACE_INGESTION_QUIET_PERIOD_SECONDS=5
REPROCESS_INTERVAL_SECONDS=60

# Dev-only: host port for Compass/mongosh (compose.dev.yml, localhost-bound)
MONGO_HOST_PORT=${MONGO_HOST_PORT}
EOF
  # Secrets live here (LangWatch secrets now, admin password later) —
  # owner-only from the first write.
  chmod 600 "$ENVFILE"
fi

# Apply --env overrides: replace the var's line if present, append otherwise.
for override in "${ENV_OVERRIDES[@]}"; do
  key="${override%%=*}"
  if grep -q "^${key}=" "$ENVFILE"; then
    sed -i "s|^${key}=.*|$(sed_escape "$override")|" "$ENVFILE"
  else
    append_env_line "$override"
  fi
  step "env: ${override}"
done

summary_access
