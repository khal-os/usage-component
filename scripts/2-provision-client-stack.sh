#!/usr/bin/env bash
#
# STEP 2 — provision: images (built only if missing) → stack up (8
# containers, dev form) → API health → migrations → LangWatch health.
# Idempotent: a stack already up is a fast no-op pass. First LangWatch
# boot runs its own migrations and takes a few minutes.
#
#   ./scripts/2-provision-client-stack.sh <name>
#
# Exits 0 with LangWatch still booting (warns) — onboarding can be
# re-run later; everything else failing is fatal.

cd "$(dirname "$0")/.."
source scripts/deploy-lib.sh

require_name "${1:-}"
require_envfile
banner 2 "provisão — imagens · stack · migrações"

API_PORT="$(host_port API_PORT)"; LANGWATCH_PORT="$(host_port LANGWATCH_PORT)"

# ---------- images ----------
docker image inspect "$(get MODULE_IMAGE)" > /dev/null 2>&1 \
  && docker image inspect "$(get CONNECTOR_IMAGE)" > /dev/null 2>&1 \
  || { step "buildando imagens (module + connector)"; live make build || die "build falhou"; }

# ---------- stack ----------
# SEM `live` de propósito: atrás de um pipe o compose degrada para linhas
# planas — direto no terminal ele mantém o renderer nativo animado
# (spinner, Created → Started → Healthy in-place).
step "subindo a stack (9 contêineres)"
make -s up "CLIENT=${NAME}" || die "compose up falhou"

# ---------- health: api (implies mongo healthy via depends_on) ----------
check_api() { curl -sf -o /dev/null -m 3 "http://localhost:${API_PORT}/api/v1/docs/openapi.json"; }
wait_live "aguardando API" "http://localhost:${API_PORT}/api/v1" check_api 30 4 \
  || die "API não respondeu em http://localhost:${API_PORT} — veja: make logs CLIENT=${NAME}"

# ---------- migrations (idempotent) ----------
step "rodando migrações"
live make migrate "CLIENT=${NAME}" || die "migrações falharam"

# ---------- health: langwatch (first boot runs its own migrations, be patient) ----------
check_lw() { lw_ready "http://localhost:${LANGWATCH_PORT}"; }
if ! wait_live "aguardando LangWatch (primeiro boot roda migrações — paciência)" \
     "http://localhost:${LANGWATCH_PORT}" check_lw 60 5; then
  info "${YLW}LangWatch AINDA SUBINDO — re-rode o onboarding depois (make logs CLIENT=${NAME})${RST}"
fi

summary_operation
