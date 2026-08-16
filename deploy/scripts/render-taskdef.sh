#!/usr/bin/env bash
# Render one ECS task definition from deploy/taskdefs/<family>.json for a
# tenant at an image SHA, to stdout (decision 151).
#
#   bash deploy/scripts/render-taskdef.sh <client> <family> <image-sha>
#
# RENDERED, NEVER CLONED. The old deploy read the CURRENT revision and
# swapped the image tag, which meant a service that infra had created on a
# placeholder task definition would carry that placeholder's container
# config into every future revision, silently, forever. Rendering from
# source makes ordering with infra harmless instead of enforced: worst case
# they create services on a placeholder and our next deploy overwrites it.
#
# Every reference is computed from naming.sh + the tenant file. No ARN
# lookups, no state, no Terraform outputs — so this runs with the CD role's
# permissions, which include no read of Secrets Manager or SSM at all.
set -euo pipefail

CLIENT="${1:?usage: render-taskdef.sh <client> <family> <image-sha>}"
FAMILY_KEY="${2:?usage: render-taskdef.sh <client> <family> <image-sha>}"
SHA="${3:?usage: render-taskdef.sh <client> <family> <image-sha>}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/scripts/naming.sh
source "${HERE}/naming.sh"
TASKDEF_DIR="${TASKDEF_DIR:-${HERE}/../taskdefs}"

case "${FAMILY_KEY}" in
  api | connector | scheduler | backup) ;;
  *)
    echo "render-taskdef: unknown family '${FAMILY_KEY}' (api|connector|scheduler|backup)" >&2
    exit 1
    ;;
esac

# The tag is an identity too: a non-SHA tag would make "rollback = redeploy
# an older SHA" a lie, and immutable ECR tags depend on it.
[[ "${SHA}" =~ ^[0-9a-f]{40}$ ]] || {
  echo "render-taskdef: invalid image sha '${SHA}' (need the full 40-hex git sha)" >&2
  exit 1
}

tenant_load "${CLIENT}"

TEMPLATE="${TASKDEF_DIR}/${FAMILY_KEY}.json"
[ -f "${TEMPLATE}" ] || { echo "render-taskdef: missing template ${TEMPLATE}" >&2; exit 1; }

# ── the substitution set ────────────────────────────────────────────────────
# Namespaced TD_* so a template can never reach a stray environment
# variable: the renderer passes exactly this map and nothing else.
ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role"

export TD_FAMILY TD_CPU TD_MEMORY TD_IMAGE TD_LOG_GROUP
export TD_EXECUTION_ROLE_ARN="${ROLE_ARN}/$(name_role execution)"
export TD_TASK_ROLE_ARN="${ROLE_ARN}/$(name_role task)"
export TD_BACKUP_TASK_ROLE_ARN="${ROLE_ARN}/$(name_role backup-task)"
export TD_AWS_REGION="${TENANT_REGION}"
export TD_CLIENT_NAME="${CLIENT_NAME}"
export TD_ENV_WORD="$(env_word)"
export TD_CLIENT_TIMEZONE="$(tget CLIENT_TIMEZONE)"
export TD_MONGO_USAGE_DB_NAME="$(tget MONGO_USAGE_DB_NAME)"
export TD_LOG_LEVEL="$(tget LOG_LEVEL)"
export TD_LOG_FORMAT="$(tget LOG_FORMAT)"
export TD_MONGO_SECRET_ARN="$(tget MONGO_SECRET_ARN)"
export TD_LANGWATCH_SECRET_ARN="$(tget LANGWATCH_SECRET_ARN)"
export TD_SSM_PROJECT_ID_ARN="$(ssm_param_arn langwatch-project-id)"
export TD_KHAL_AUTH_URL="$(tget KHAL_AUTH_URL)"
export TD_KHAL_TOKEN_AUDIENCE="$(tget KHAL_TOKEN_AUDIENCE)"
export TD_TRACE_INGESTION_INTERVAL_SECONDS="$(tget TRACE_INGESTION_INTERVAL_SECONDS)"
export TD_TRACE_INGESTION_BATCH_SIZE="$(tget TRACE_INGESTION_BATCH_SIZE)"
export TD_TRACE_INGESTION_QUIET_PERIOD_SECONDS="$(tget TRACE_INGESTION_QUIET_PERIOD_SECONDS)"
export TD_REPROCESS_INTERVAL_SECONDS="$(tget REPROCESS_INTERVAL_SECONDS)"
export TD_LANGWATCH_CLICKHOUSE_URL="$(tget LANGWATCH_CLICKHOUSE_URL)"
export TD_BILLING_AUTO_CLOSE_DELAY_MINUTES="$(tget BILLING_AUTO_CLOSE_DELAY_MINUTES)"
export TD_BILLING_AUTO_CLOSE_CHECK_INTERVAL_SECONDS="$(tget BILLING_AUTO_CLOSE_CHECK_INTERVAL_SECONDS)"
export TD_BACKUP_BUCKET="$(bucket_backups)"

# CORS: one list, one name. Empty in the tenant file means "this client's
# own domain", which is derivable and therefore should not be hand-kept;
# a non-empty value is used VERBATIM (explicit beats magic — a client with
# a second custom domain writes both entries itself).
_cors="$(tget CORS_ALLOWED_ORIGINS)"
export TD_CORS_ALLOWED_ORIGINS="${_cors:-https://*.${BASE_DOMAIN}}"

TD_FAMILY="$(name_service "${FAMILY_KEY}")"
TD_LOG_GROUP="$(log_group "${FAMILY_KEY}")"
case "${FAMILY_KEY}" in
  api)
    TD_CPU="$(tget API_CPU)"; TD_MEMORY="$(tget API_MEMORY)"
    TD_IMAGE="$(ecr_image module "${SHA}")"
    ;;
  connector)
    TD_CPU="$(tget CONNECTOR_CPU)"; TD_MEMORY="$(tget CONNECTOR_MEMORY)"
    TD_IMAGE="$(ecr_image connector "${SHA}")"
    ;;
  scheduler)
    # The scheduler is the MODULE image with a different command — one
    # build, two roles (the compose world does the same).
    TD_CPU="$(tget SCHEDULER_CPU)"; TD_MEMORY="$(tget SCHEDULER_MEMORY)"
    TD_IMAGE="$(ecr_image module "${SHA}")"
    ;;
  backup)
    TD_CPU="$(tget BACKUP_CPU)"; TD_MEMORY="$(tget BACKUP_MEMORY)"
    TD_IMAGE="$(ecr_image db-backup "${SHA}")"
    ;;
esac

# ── substitute ──────────────────────────────────────────────────────────────
# python3, never jq (repo convention). Three fail-fast properties:
#   1. a ${PLACEHOLDER} with no TD_ value raises — never renders as empty
#   2. an EMPTY value is refused unless the key is on the may-be-empty list
#      (KHAL_AUTH_URL empty = auth OFF is a real, declared posture; an empty
#      MONGO_USAGE_DB_NAME is a typo that would deploy quietly)
#   3. values are JSON-escaped, and the result must parse as JSON
TEMPLATE="${TEMPLATE}" python3 <<'PY'
import json, os, string, sys

MAY_BE_EMPTY = {"KHAL_AUTH_URL"}

values = {k[3:]: v for k, v in os.environ.items() if k.startswith("TD_")}

blank = sorted(k for k, v in values.items() if v == "" and k not in MAY_BE_EMPTY)
if blank:
    sys.exit(
        "render-taskdef: the tenant file leaves these empty, and a task definition "
        "must not carry a blank where a value was meant: " + ", ".join(blank)
    )

with open(os.environ["TEMPLATE"], encoding="utf-8") as fh:
    template = string.Template(fh.read())

# json.dumps(...)[1:-1] escapes the value for a JSON string context, so a
# quote or a backslash in a tenant value cannot break out of the template.
escaped = {k: json.dumps(v)[1:-1] for k, v in values.items()}

try:
    rendered = template.substitute(escaped)
except KeyError as missing:
    sys.exit(f"render-taskdef: template placeholder {missing} has no value")

try:
    parsed = json.loads(rendered)
except json.JSONDecodeError as err:
    sys.exit(f"render-taskdef: rendered template is not valid JSON: {err}")

json.dump(parsed, sys.stdout, indent=2)
print()
PY
