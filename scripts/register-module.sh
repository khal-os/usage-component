#!/usr/bin/env bash
# (Re-)registers this module in the khal Module Catalog, so apps (Farol) can
# discover it by id. The catalog is the source of truth for the deployed
# module VERSION — the manifest's `version` is read from package.json
# automatically, so run this after every bump/deploy (scripts/bump-version.sh).
#
# This is the "CD acting as the module" step of the platform flow: in CI the
# pipeline holds the module's M2M credential and updates the module's own
# manifest with it. Auth is identity-only (valid token + right tenant) —
# there are NO scopes in the M2M model (the manifest declares
# `auth.requiredScopes: []` accordingly).
#
# Lifecycle: the module registers DESATIVADO and only enters listing/
# resolution after activation (deploy flow: deploy → health → activate).
# This script activates right after a successful PUT — it plays the whole
# CD role locally; SKIP_ACTIVATE=1 leaves the module deactivated.
#
# FIRST registration returns the module's M2M credential ONCE
# (clientId + clientSecret + secretDeliveredOnce) — save it; it never
# reappears.
#
# Token precedence:
#   1. TOKEN                     — explicit token, used as-is
#   2. KHAL_CLIENT_ID/SECRET     — with KHAL_AUTH_SYSTEM_URL: a session is
#                                  requested from the M2M Auth System
#                                  (client_credentials; sessions expire — each
#                                  run requests a fresh one, there is no renew)
#   3. dev claims token          — minted below (base64url JSON, no scopes)
#
# The local catalog stores manifests IN MEMORY — run this again after every
# dev-server restart. Idempotent: an existing module is updated in place
# (ETag/If-Match handled automatically).
#
# Env:
#   CLIENT        REQUIRED — client slug; tenant AND source of API_PORT
#                 (read from clients/$CLIENT.env unless API_PORT is set;
#                 absent there, the compose default applies — see host_port)
#   KHAL_TENANT   tenant slug (default: $CLIENT)
#   KHAL_MODULE_CATALOG_URL  default http://127.0.0.1:7102 (the Module Catalog)
#   MODULE_ID     default tracing
#   ENDPOINT      default http://localhost:${API_PORT}
#   KHAL_AUTH_SYSTEM_URL  the M2M Auth System base URL (enables the session path)
#   KHAL_CLIENT_ID     the module's M2M credential id
#   KHAL_CLIENT_SECRET the module's M2M credential secret
#   TOKEN         explicit token for the PUT (wins over everything)
#   SKIP_ACTIVATE any value → register only; skip the activation POST
#   DRY_RUN       any value → print the resolved endpoint + manifest and stop
#                 before touching the catalog (how `make deploy-smoke`
#                 exercises the port resolution offline).
set -euo pipefail

: "${CLIENT:?export CLIENT first (client slug = tenant)}"
MODULE_ID="${MODULE_ID:-tracing}"
# Canonical khal spellings only (ADR-103 URL family — discovery is gone,
# the explicit catalog/auth URLs are the only inputs).
TENANT="${KHAL_TENANT:-$CLIENT}"
KHAL_CLIENT_ID="${KHAL_CLIENT_ID:-}"
KHAL_CLIENT_SECRET="${KHAL_CLIENT_SECRET:-}"
KHAL_MODULE_CATALOG_URL="${KHAL_MODULE_CATALOG_URL:-http://127.0.0.1:7102}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/deploy-lib.sh
source "$ROOT/scripts/deploy-lib.sh"

# The port goes through deploy-lib's host_port, exactly like every deploy
# step: the env contract EXPLICITLY invites omitting API_PORT on a dedicated
# host (clients/example.production.env), so reading the var rawly made a contract-legal
# env file abort registration — stack healthy on the compose default 3000,
# module never registered, Farol unable to discover it, and the operator told
# to set a variable the contract told him to leave out. An explicit
# API_PORT (or ENDPOINT) still wins.
ENVFILE="$ROOT/clients/$CLIENT.env"
if [[ -z "${ENDPOINT:-}" ]]; then
  if [[ -z "${API_PORT:-}" ]]; then
    [[ -f "$ENVFILE" ]] \
      || { echo "ERROR: missing $ENVFILE — pass API_PORT=<port> or ENDPOINT=<url> to register without it"; exit 1; }
    API_PORT="$(host_port API_PORT)"
  fi
  ENDPOINT="http://localhost:${API_PORT}"
fi

VERSION=$(node -p "require('$ROOT/package.json').version")

# Session from the M2M Auth System (the target platform flow): credentials in,
# short-lived session out. No scopes are requested — identity only.
m2m_session() {
  curl -sS -X POST "${KHAL_AUTH_SYSTEM_URL%/}/oauth/token" \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=client_credentials' \
    --data-urlencode "client_id=${KHAL_CLIENT_ID}" \
    --data-urlencode "client_secret=${KHAL_CLIENT_SECRET}" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['access_token'])"
}

# Dev claims token (base64url JSON read verbatim by the local catalog).
# No scopes — the M2M model is identity-only (valid token + right tenant).
dev_token() {
  python3 -c "
import base64, json, sys
claims = {'tenant': sys.argv[1], 'client_id': 'register-module.sh'}
print(base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('='))" "$TENANT"
}

if [[ -z "${TOKEN:-}" ]]; then
  if [[ -n "${KHAL_AUTH_SYSTEM_URL:-}" && -n "${KHAL_CLIENT_ID:-}" && -n "${KHAL_CLIENT_SECRET:-}" ]]; then
    TOKEN="$(m2m_session)"
    echo "session obtained from the M2M Auth System (${KHAL_AUTH_SYSTEM_URL})"
  else
    TOKEN="$(dev_token)"
  fi
fi

# The manifest declares what the module OFFERS — the full capability tuple
# (signal, operation, transport, protocol, protocol version, encoding). The
# module serves traces/sessions/billing reads over its REST API (/api/v1).
# `capability` must exist in the tenant vocabulary (dev seed: billing.ledger,
# tracing.sessions — 422 UNKNOWN_VOCABULARY_REF otherwise); the tuple fields
# ride along as tolerant-reader extras until the platform models them.
MANIFEST=$(cat <<EOF
{
  "id": "${MODULE_ID}",
  "manifestVersion": "1.0.0",
  "version": "${VERSION}",
  "info": {
    "name": { "pt-BR": "Módulo de Observabilidade (Tracing)" },
    "protocol": "rest"
  },
  "connection": { "endpoint": "${ENDPOINT}", "health": "/api/v1/docs/openapi.json" },
  "auth": { "requiredScopes": [] },
  "capabilities": [
    {
      "capability": "tracing.sessions",
      "signal": "monitoring.trace",
      "operation": "read",
      "bindings": [
        {
          "transport": "http",
          "protocol": "rest",
          "protocolVersion": "v1",
          "encoding": "json"
        }
      ]
    }
  ]
}
EOF
)

if [[ -n "${DRY_RUN:-}" ]]; then
  echo "DRY_RUN: module '${MODULE_ID}' v${VERSION} (tenant ${TENANT}) → ${ENDPOINT}"
  echo "${MANIFEST}"
  exit 0
fi

# One registration attempt with the given token; prints the body, returns the
# HTTP status via the global CODE. Existing module → ETag satisfies If-Match.
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT
attempt() {
  local token="$1"
  local etag
  etag=$(curl -s -o /dev/null -w '%{header_json}' \
    -H "Authorization: Bearer ${token}" \
    "${KHAL_MODULE_CATALOG_URL}/modules/${MODULE_ID}" \
    | python3 -c "import json,sys;h=json.load(sys.stdin);print((h.get('etag') or [''])[0])")
  local args=(-sS -X PUT "${KHAL_MODULE_CATALOG_URL}/modules/${MODULE_ID}"
    -H "Authorization: Bearer ${token}" -H 'content-type: application/json'
    -o "$BODY_FILE" -w '%{http_code}' -d "${MANIFEST}")
  [[ -n "$etag" ]] && args+=(-H "If-Match: ${etag}")
  CODE=$(curl "${args[@]}")
}

attempt "$TOKEN"

cat "$BODY_FILE"; echo
echo "HTTP ${CODE}"
[[ "$CODE" =~ ^2 ]] || { echo "ERROR: registration failed"; exit 1; }
echo "module '${MODULE_ID}' v${VERSION} registered at ${KHAL_MODULE_CATALOG_URL} (tenant ${TENANT}) → ${ENDPOINT}"

# Fluxo Deploy, passo final: o manifesto nasce desativado — sem esta ativação
# o module não entra em lista/resolução (Farol não o descobre).
if [[ -z "${SKIP_ACTIVATE:-}" ]]; then
  ACT=$(curl -sS -X POST "${KHAL_MODULE_CATALOG_URL}/modules/${MODULE_ID}/activate" \
    -H "Authorization: Bearer ${TOKEN}" -o "$BODY_FILE" -w '%{http_code}')
  [[ "$ACT" =~ ^2 ]] \
    || { cat "$BODY_FILE"; echo; echo "ERROR: activation failed (HTTP ${ACT})"; exit 1; }
  echo "module '${MODULE_ID}' activated (state=ativo)"
fi
