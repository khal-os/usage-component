#!/usr/bin/env bash
# (Re-)registers the LangWatch OTLP connector in the khal Connector Catalog,
# so the agent can resolve `monitoring.trace`/`write` against the real
# catalog instead of any mock. (Moved here from martino-agent — the connector
# is provisioned by this module's stack, so its scripts live with it.)
#
# The manifest's `version` is read from scripts/connector/version — bump with
# scripts/connector/bump-version.sh and re-run this.
#
# Auth is identity-only (valid token + right tenant) — there are NO scopes in
# the M2M model. Token precedence:
#   1. TOKEN                     — explicit token, used as-is
#   2. KHAL_CLIENT_ID/SECRET     — with KHAL_AUTH_SYSTEM_URL: a session is
#                                  requested from the M2M Auth System
#                                  (client_credentials; sessions expire — each
#                                  run requests a fresh one, there is no renew)
#   3. dev claims token          — minted below (base64url JSON, no scopes)
#
# The local catalog stores manifests IN MEMORY — run this again after every
# dev-server restart. Idempotent: an existing connector is updated in place
# (ETag/If-Match handled automatically).
#
# For the resolved credential to be REAL (not dev-secret-*), start the catalog
# with the vault seed (see khal-platform docs/platform/connector-register/sops.md):
#   VAULT_CREDENTIALS_JSON='{"workos-vault://langwatch":"<api key>"}' \
#     pnpm --filter @khal/connector-register dev
#
# Env overrides (all optional):
#   KHAL_CONNECTOR_CATALOG_URL  default http://127.0.0.1:7103 (the Connector Catalog)
#   CONNECTOR_ID   default langwatch
#   OTLP_ENDPOINT  default http://localhost:5562/api/otel/v1/traces
#   CREDENTIAL_REF default workos-vault://<CONNECTOR_ID> — MUST match a key of
#                  the catalog's VAULT_CREDENTIALS_JSON for the resolved
#                  credential to be real
#   VERSION        default: contents of scripts/connector/version
#   KHAL_TENANT    tenant slug (default acme)
#   KHAL_AUTH_SYSTEM_URL  the M2M Auth System base URL (enables the session path)
#   KHAL_CLIENT_ID     the connector's M2M credential id
#   KHAL_CLIENT_SECRET the connector's credential secret
#   TOKEN          explicit token for the PUT (wins over everything)
set -euo pipefail

# Canonical khal spellings only (ADR-103 URL family — discovery is gone,
# the explicit catalog/auth URLs are the only inputs).
TENANT="${KHAL_TENANT:-acme}"
KHAL_CLIENT_ID="${KHAL_CLIENT_ID:-}"
KHAL_CLIENT_SECRET="${KHAL_CLIENT_SECRET:-}"
KHAL_CONNECTOR_CATALOG_URL="${KHAL_CONNECTOR_CATALOG_URL:-http://127.0.0.1:7103}"
CONNECTOR_ID="${CONNECTOR_ID:-langwatch}"
OTLP_ENDPOINT="${OTLP_ENDPOINT:-http://localhost:5562/api/otel/v1/traces}"
CREDENTIAL_REF="${CREDENTIAL_REF:-workos-vault://${CONNECTOR_ID}}"
VERSION="${VERSION:-$(tr -d '[:space:]' <"$(dirname "$0")/version")}"

# Empty shell expansions produce silent garbage (id "langwatch-", endpoint
# "http://localhost:/..." ) — refuse them loudly instead of registering it.
[[ "$CONNECTOR_ID" =~ ^[a-z0-9][a-z0-9-]*[a-z0-9]$ ]] \
  || { echo "ERROR: CONNECTOR_ID '$CONNECTOR_ID' looks like an empty expansion (export CLIENT?)"; exit 1; }
[[ "$OTLP_ENDPOINT" =~ ^https?://[^/:]+(:[0-9]+)?/ ]] \
  || { echo "ERROR: OTLP_ENDPOINT '$OTLP_ENDPOINT' is malformed (empty \$LANGWATCH_PORT?)"; exit 1; }

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
claims = {'tenant': sys.argv[1], 'client_id': 'connector-register.sh'}
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

# `protocolVersion` completes the capability tuple (signal, operation,
# transport, protocol, protocol version, encoding) — the agent's intent sends
# the same value, and the catalog only matches bindings that declare it.
BASE_URL="${OTLP_ENDPOINT%/api/otel/v1/traces}"
MANIFEST=$(cat <<EOF
{
  "id": "${CONNECTOR_ID}",
  "manifestVersion": "1.0.0",
  "version": "${VERSION}",
  "type": "otlp-stream",
  "connectsTo": "monitoring",
  "capabilities": [
    {
      "signal": "monitoring.trace",
      "operation": "write",
      "bindings": [
        {
          "transport": "http",
          "protocol": "otlp",
          "protocolVersion": "1.0",
          "encoding": "protobuf",
          "endpoint": "${OTLP_ENDPOINT}",
          "auth": { "placement": "header", "name": "authorization", "scheme": "Bearer" }
        }
      ]
    }
  ],
  "baseUrl": "${BASE_URL}",
  "credentialRef": "${CREDENTIAL_REF}",
  "lifecycle": "active"
}
EOF
)

# One registration attempt with the given token; prints the body, returns the
# HTTP status via the global CODE. Existing connector → ETag satisfies If-Match.
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT
attempt() {
  local token="$1"
  local etag
  etag=$(curl -s -o /dev/null -w '%{header_json}' \
    -H "Authorization: Bearer ${token}" \
    "${KHAL_CONNECTOR_CATALOG_URL}/connectors/${CONNECTOR_ID}" \
    | python3 -c "import json,sys;h=json.load(sys.stdin);print((h.get('etag') or [''])[0])")
  local args=(-sS -X PUT "${KHAL_CONNECTOR_CATALOG_URL}/connectors/${CONNECTOR_ID}"
    -H "Authorization: Bearer ${token}" -H 'content-type: application/json'
    -o "$BODY_FILE" -w '%{http_code}' -d "${MANIFEST}")
  [[ -n "$etag" ]] && args+=(-H "If-Match: ${etag}")
  CODE=$(curl "${args[@]}")
}

attempt "$TOKEN"

cat "$BODY_FILE"; echo
echo "HTTP ${CODE}"
[[ "$CODE" =~ ^2 ]] || { echo "ERROR: registration failed"; exit 1; }
echo "connector '${CONNECTOR_ID}' v${VERSION} registered at ${KHAL_CONNECTOR_CATALOG_URL} (tenant ${TENANT}) → ${OTLP_ENDPOINT}"
