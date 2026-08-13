#!/usr/bin/env bash
# ADR-103 path migration (step A) — one-time value copy, idempotent.
#
# Splits the legacy tenant JSON secret usage/<client> into the three canonical
# family secrets khal/<client>/<env>/usage/{mongo,langwatch,basic-auth},
# renaming the LW_* keys to LANGWATCH_* on the way, and copies the legacy
# langwatch-project-id SSM value to the canonical path. A family secret that
# already holds keys is left untouched (re-runs are safe); values never touch
# stdout. Run AFTER `terraform apply` created the canonical shells and BEFORE
# relying on the new task definitions:
#
#   CLIENT=namastex ./deploy/scripts/migrate-adr103.sh
set -euo pipefail

: "${CLIENT:?export CLIENT first (client slug)}"
ENV="${ENV:-production}"
BASE="khal/${CLIENT}/${ENV}/usage"

legacy_json=$(aws secretsmanager get-secret-value --secret-id "usage/${CLIENT}" \
  --query 'SecretString' --output text 2>/dev/null || echo "")
[ -n "$legacy_json" ] || { echo "no legacy secret usage/${CLIENT} — nothing to migrate"; exit 0; }

fill_family() { # family-name  python-projection
  local sid="${BASE}/$1" now
  now=$(aws secretsmanager get-secret-value --secret-id "$sid" \
    --query 'SecretString' --output text 2>/dev/null || echo "{}")
  if [ "$now" != "{}" ] && [ -n "$now" ]; then
    echo "≡ $sid already has keys — keeping"; return 0
  fi
  local value
  value=$(printf '%s' "$legacy_json" | python3 -c "$2") || { echo "✗ $sid: projection failed"; return 1; }
  if [ "$value" = "{}" ]; then echo "≡ $sid: no source keys in the legacy JSON — skipped"; return 0; fi
  aws secretsmanager put-secret-value --secret-id "$sid" --secret-string "$value" >/dev/null
  echo "✓ $sid filled from the legacy JSON"
}

fill_family mongo '
import json,sys
c=json.load(sys.stdin)
print(json.dumps({k:c[k] for k in ("MONGO_DB_HOST","MONGO_DB_USER","MONGO_DB_PASSWORD") if k in c}))'

# LW_* -> LANGWATCH_* rename happens here; the ClickHouse password (plaintext
# in the old task def, never in the old JSON) gets its documented default —
# rotate it afterwards if desired.
fill_family langwatch '
import json,sys
c=json.load(sys.stdin)
m={"LW_NEXTAUTH_SECRET":"LANGWATCH_NEXTAUTH_SECRET",
   "LW_API_TOKEN_JWT_SECRET":"LANGWATCH_API_TOKEN_JWT_SECRET",
   "LW_CREDENTIALS_SECRET":"LANGWATCH_CREDENTIALS_SECRET"}
out={new:c[old] for old,new in m.items() if old in c}
if out: out["LANGWATCH_CLICKHOUSE_PASSWORD"]=c.get("LANGWATCH_CLICKHOUSE_PASSWORD","langwatch")
print(json.dumps(out))'

fill_family basic-auth '
import json,sys
c=json.load(sys.stdin)
print(json.dumps({k:c[k] for k in ("BASIC_AUTH_USER","BASIC_AUTH_PASSWORD") if k in c}))'

# langwatch-project-id: copy the legacy SSM value if the canonical is empty.
new_pid=$(aws ssm get-parameter --name "/khal/${CLIENT}/${ENV}/usage/langwatch-project-id" \
  --query 'Parameter.Value' --output text 2>/dev/null || echo " ")
old_pid=$(aws ssm get-parameter --name "/usage/${CLIENT}/langwatch-project-id" \
  --query 'Parameter.Value' --output text 2>/dev/null || echo " ")
if [ "$(echo "$new_pid" | tr -d ' ')" = "" ] && [ "$(echo "$old_pid" | tr -d ' ')" != "" ]; then
  aws ssm put-parameter --name "/khal/${CLIENT}/${ENV}/usage/langwatch-project-id" \
    --type String --value "$old_pid" --overwrite >/dev/null
  echo "✓ langwatch-project-id copied to the canonical path"
else
  echo "≡ langwatch-project-id already migrated (or no legacy value)"
fi

echo "done — apply/redeploy the tenant so the task defs pick the canonical sources"
