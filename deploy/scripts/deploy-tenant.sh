#!/usr/bin/env bash
# Deploy one tenant to a given image SHA (decision 140, reworked by 151/152).
# ONE mechanism for both `make aws-deploy` and the deploy-tenant workflow.
#
#   deploy-tenant.sh <client> <image-sha>      full deploy
#   deploy-tenant.sh --register-only <client> [<image-sha>]
#
# What CROSSES into the client's AWS account is only ever an ARTIFACT put
# into a store infra already created — container images into ECR, task
# definition revisions into ECS, the LangWatch config bundle into an S3
# prefix, the capacity JSON into an SSM parameter. This script creates no
# bucket, parameter, repository, role, service or schedule. That is the
# handoff contract, and preflight-aws.sh is what proves it still holds.
#
# Full deploy, in order:
#   0. preflight --gate — refuse to start against a non-compliant account
#   1. verify the SHA is in all three ECR repos
#   2. render + register revisions for api/connector/scheduler
#   3. run migrations ON the new api revision, WAIT for exit 0
#   4. roll the three services; only then register the backup family (its
#      schedule resolves latest-ACTIVE, so an unproven SHA must never
#      become "latest" before the migrations gate passes)
#   5. publish the LangWatch config bundle + capacity
#   6. wait for what can stabilize, observe what cannot, verify revisions
#
# --register-only is the bootstrap leg: it renders and registers all four
# families and touches no service, so infra can create the services on real
# task definitions. Ordering with infra is HARMLESS either way — nothing is
# ever cloned from an existing revision, so a service created on a
# placeholder is simply overwritten by the next deploy.
#
# Rollback = re-run with yesterday's SHA.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/scripts/naming.sh
source "${HERE}/naming.sh"

REGISTER_ONLY=0
if [ "${1:-}" = "--register-only" ]; then
  REGISTER_ONLY=1
  shift
fi

CLIENT="${1:?usage: deploy-tenant.sh [--register-only] <client> <image-sha>}"
tenant_load "${CLIENT}"

SHA="${2:-}"
if [ -z "${SHA}" ]; then
  # --register-only may fall back to the SHA the tenant file records; a
  # full deploy never guesses which image it is shipping.
  [ "${REGISTER_ONLY}" = "1" ] || { echo "usage: deploy-tenant.sh <client> <image-sha>" >&2; exit 1; }
  SHA="$(tget IMAGE_SHA)"
  [ -n "${SHA}" ] || { echo "no SHA given and ${TENANT_FILE} records no IMAGE_SHA" >&2; exit 1; }
fi
[[ "${SHA}" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid sha (need full 40-hex git sha): ${SHA}" >&2; exit 1; }

# The region is the tenant's, from the tenant file — never the ambient
# profile's. A deploy that silently targets another region finds nothing
# and says so in the least useful way possible. The account guard matters
# more here than in the audit, because this path WRITES.
export AWS_REGION="${TENANT_REGION}"
assert_account

CLUSTER="$(name_base)"
say() { echo "==> $*"; }

# ── 0 · the gate ────────────────────────────────────────────────────────────
# Uses only permissions the CD role already has, so it costs nothing to run
# on every deploy — and it is the only thing standing between a renamed or
# mis-configured account and a deploy that dies halfway through.
if [ "${REGISTER_ONLY}" = "0" ]; then
  say "preflight gate"
  bash "${HERE}/preflight-aws.sh" --gate "${CLIENT}" \
    || { echo "preflight gate FAILED — nothing deployed" >&2; exit 1; }
fi

# ── 1 · the images ──────────────────────────────────────────────────────────
say "verifying ${SHA} exists in ECR (all three repos)"
for image in module connector db-backup; do
  repo="$(ecr_repo "${image}")"
  aws ecr describe-images --repository-name "${repo}" \
    --image-ids imageTag="${SHA}" >/dev/null 2>&1 \
    || { echo "image ${repo}:${SHA} NOT in this account's ECR — did build-images finish on main, and is IMAGES_ENABLED=true for ${CLIENT}?" >&2; exit 1; }
done

TASKDEF_TMP="$(mktemp)"
trap 'rm -f "${TASKDEF_TMP}"' EXIT

# RENDER, never clone. The old shape read the CURRENT revision and swapped
# the image tag, which silently propagated whatever a placeholder revision
# happened to contain into every future revision.
new_revision() { # family-key → registers a revision at $SHA, echoes its arn
  bash "${HERE}/render-taskdef.sh" "${CLIENT}" "$1" "${SHA}" > "${TASKDEF_TMP}"
  aws ecs register-task-definition --cli-input-json "file://${TASKDEF_TMP}" \
    --query 'taskDefinition.taskDefinitionArn' --output text
}

# ── 2 · the revisions ───────────────────────────────────────────────────────
say "registering revisions at ${SHA}"
API_ARN="$(new_revision api)"
CONN_ARN="$(new_revision connector)"
SCHED_ARN="$(new_revision scheduler)"
say "api=${API_ARN##*/} connector=${CONN_ARN##*/} scheduler=${SCHED_ARN##*/}"

if [ "${REGISTER_ONLY}" = "1" ]; then
  BACKUP_ARN="$(new_revision backup)"
  say "backup=${BACKUP_ARN##*/}"
  say "registered 4 families for ${CLIENT} at ${SHA} — no service was touched"
  exit 0
fi

# ── 3 · the migrations gate ─────────────────────────────────────────────────
# Index bootstrap only (decision 74) — but the ORDERING lives in the
# pipeline, not in anyone's memory: no service sees the new code until this
# exits 0.
say "running migrations"
NETCONF="$(aws ecs describe-services --cluster "${CLUSTER}" \
  --services "$(name_service connector)" \
  --query 'services[0].networkConfiguration' --output json)"
RUN_OUT="$(aws ecs run-task --cluster "${CLUSTER}" \
  --task-definition "${API_ARN}" \
  --launch-type FARGATE \
  --network-configuration "${NETCONF}" \
  --overrides '{"containerOverrides":[{"name":"api","command":["node","dist/main/jobs/run-migrations.js"]}]}' \
  --output json)"
TASK_ARN="$(echo "${RUN_OUT}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['tasks'][0]['taskArn'] if d.get('tasks') else '')")"
if [ -z "${TASK_ARN}" ]; then
  echo "run-task returned no task — failures:" >&2
  echo "${RUN_OUT}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('failures'))" >&2
  exit 1
fi
aws ecs wait tasks-stopped --cluster "${CLUSTER}" --tasks "${TASK_ARN}"
EXIT_CODE="$(aws ecs describe-tasks --cluster "${CLUSTER}" --tasks "${TASK_ARN}" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
if [ "${EXIT_CODE}" != "0" ]; then
  echo "MIGRATIONS FAILED (exit ${EXIT_CODE}) — nothing rolled (backup untouched too)" >&2
  aws ecs describe-tasks --cluster "${CLUSTER}" --tasks "${TASK_ARN}" \
    --query 'tasks[0].{stopped:stoppedReason,container:containers[0].reason}' --output json >&2 || true
  # The failure path's whole value is these lines. It tailed /usage/<client>/api
  # for months — a path that has not existed since the ADR-103 sweep — under
  # a `|| true`, so a failed migration printed NOTHING and looked like a
  # silent hang.
  aws logs tail "$(log_group api)" --since 10m >&2 || true
  exit 1
fi
say "migrations ok"

# ── 4 · roll ────────────────────────────────────────────────────────────────
say "rolling services"
for svc in api connector scheduler; do
  case "${svc}" in
    api) ARN="${API_ARN}" ;;
    connector) ARN="${CONN_ARN}" ;;
    scheduler) ARN="${SCHED_ARN}" ;;
  esac
  aws ecs update-service --cluster "${CLUSTER}" \
    --service "$(name_service "${svc}")" \
    --task-definition "${ARN}" >/dev/null
done

say "registering backup revision"
BACKUP_ARN="$(new_revision backup)"
say "backup=${BACKUP_ARN##*/}"

# ── 5 · config artifacts ────────────────────────────────────────────────────
# Objects into a bucket prefix and a value into a parameter — both created
# by infra, both written here so a config change is a deploy and not a
# console visit. The box re-fetches all of it on every service start.
say "publishing the LangWatch config bundle"
BUCKET="$(bucket_backups)"
CONFIG_PREFIX="$(s3_config_prefix)"
LANGWATCH_DIR="${HERE}/../langwatch"

EMBED_ORIGIN="$(tget LANGWATCH_EMBED_ORIGIN)"
CADDY_TMP="$(mktemp)"
trap 'rm -f "${TASKDEF_TMP}" "${CADDY_TMP}"' EXIT
# Same default rule as CORS: empty means this client's own domain, which is
# derivable; a set value is used verbatim. NEVER "*" — this is a
# frame-ancestors list and a wildcard there is a clickjacking hole.
TMPL_EMBED_ORIGIN="${EMBED_ORIGIN:-https://*.${BASE_DOMAIN}}" \
  python3 -c '
import os, string, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    print(string.Template(fh.read()).substitute(embed_origin=os.environ["TMPL_EMBED_ORIGIN"]), end="")
' "${LANGWATCH_DIR}/langwatch-caddy.Caddyfile.tmpl" > "${CADDY_TMP}"

aws s3 cp "${LANGWATCH_DIR}/langwatch-compose.yml" "s3://${BUCKET}/${CONFIG_PREFIX}/langwatch-compose.yml" >/dev/null
aws s3 cp "${LANGWATCH_DIR}/langwatch-bootstrap.sh" "s3://${BUCKET}/${CONFIG_PREFIX}/langwatch-bootstrap.sh" >/dev/null
aws s3 cp "${CADDY_TMP}" "s3://${BUCKET}/${CONFIG_PREFIX}/langwatch-caddy.Caddyfile" >/dev/null

say "publishing the LangWatch capacity"
CAPACITY="$(python3 -c '
import json, sys
print(json.dumps(dict(zip(
    ["LANGWATCH_WORKERS_REPLICAS", "LANGWATCH_MEMORY_LIMIT", "LANGWATCH_REDIS_MEMORY_LIMIT",
     "LANGWATCH_CLICKHOUSE_MEMORY_LIMIT", "LANGWATCH_CLICKHOUSE_CPU_LIMIT"],
    sys.argv[1:]))))
' "$(tget LANGWATCH_WORKERS_REPLICAS)" "$(tget LANGWATCH_MEMORY_LIMIT)" \
  "$(tget LANGWATCH_REDIS_MEMORY_LIMIT)" "$(tget LANGWATCH_CLICKHOUSE_MEMORY_LIMIT)" \
  "$(tget LANGWATCH_CLICKHOUSE_CPU_LIMIT)")"
aws ssm put-parameter --name "$(ssm_param langwatch-capacity)" \
  --type String --value "${CAPACITY}" --overwrite >/dev/null
say "capacity: ${CAPACITY}"

# ── 6 · wait, observe, verify ───────────────────────────────────────────────
# NOT the connector. It is DESIGNED to exit 1 in a visible restart loop
# until onboarding writes LANGWATCH_PROJECT_ID (the SSM parameter ships
# seeded with a single space, the connector trims it to unset and refuses
# the ClickHouse source). A service whose task keeps dying never reaches
# steady state, so waiting on it burned the timeout and failed a deploy
# that had succeeded — decision 148's open chip.
say "waiting for api and scheduler to stabilize"
aws ecs wait services-stable --cluster "${CLUSTER}" \
  --services "$(name_service api)" "$(name_service scheduler)"

# Scoping the wait to api-only was the tempting fix and it is wrong: the
# revision check below compares the CONFIGURED task definition, which
# updates the instant update-service returns, so a genuinely broken
# connector image would deploy "successfully". Observe it instead —
# non-blocking, but never silent.
CONN_RUNNING="$(aws ecs describe-services --cluster "${CLUSTER}" \
  --services "$(name_service connector)" \
  --query 'services[0].runningCount' --output text)"
if [ "${CONN_RUNNING}" = "0" ]; then
  echo "WARNING: the connector has no running task." >&2
  echo "  Expected BEFORE onboarding (no LANGWATCH_PROJECT_ID yet); a bug after it." >&2
  LAST_TASK="$(aws ecs list-tasks --cluster "${CLUSTER}" \
    --service-name "$(name_service connector)" --desired-status STOPPED \
    --query 'taskArns[0]' --output text 2>/dev/null || true)"
  if [ -n "${LAST_TASK}" ] && [ "${LAST_TASK}" != "None" ]; then
    aws ecs describe-tasks --cluster "${CLUSTER}" --tasks "${LAST_TASK}" \
      --query 'tasks[0].{stopped:stoppedReason,container:containers[0].reason}' \
      --output json >&2 || true
  fi
fi

# services-stable is ALSO satisfied by a circuit-breaker ROLLBACK — verify
# each service actually landed on the new revision before claiming success.
for svc in api connector scheduler; do
  case "${svc}" in
    api) WANT="${API_ARN}" ;;
    connector) WANT="${CONN_ARN}" ;;
    scheduler) WANT="${SCHED_ARN}" ;;
  esac
  GOT="$(aws ecs describe-services --cluster "${CLUSTER}" \
    --services "$(name_service "${svc}")" \
    --query 'services[0].taskDefinition' --output text)"
  if [ "${GOT}" != "${WANT}" ]; then
    echo "DEPLOY DID NOT TAKE for ${svc}: running ${GOT##*/}, wanted ${WANT##*/}" >&2
    echo "(likely the deployment circuit breaker rolled back — check the service events)" >&2
    exit 1
  fi
done

say "deploy of ${CLIENT} @ ${SHA} complete"
say "REMINDER: set IMAGE_SHA=${SHA} in ${TENANT_FILE} and commit"
say "          (preflight warns on the drift; the file is what --register-only would ship)"
