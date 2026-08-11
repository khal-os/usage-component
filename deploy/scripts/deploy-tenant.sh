#!/bin/bash
# Deploy one tenant to a given image SHA (decision 140). ONE mechanism for
# both `make aws-deploy` and the deploy-tenant workflow:
#   0. validate inputs + verify the SHA exists in ALL THREE ECR repos
#   1. register new revisions for api/connector/scheduler at the SHA
#   2. run the migrations one-off ON the new api revision, WAIT for exit 0
#   3. roll the three services; only then register the backup revision
#      (its schedule resolves latest-ACTIVE — an unproven SHA must never
#      become "latest" before the migrations gate passes)
# Rollback = re-run with yesterday's SHA.
set -euo pipefail

CLIENT="${1:?usage: deploy-tenant.sh <client> <image-sha>}"
SHA="${2:?usage: deploy-tenant.sh <client> <image-sha>}"
CLUSTER="usage-main"

# Inputs reach shell/python and IAM-scoped AWS calls — refuse anything odd
# (also the workflow passes these through env, but validate regardless).
# Slug cap matches tenant/variables.tf (22 chars — AWS 32-char name limits).
[[ "$CLIENT" =~ ^[a-z][a-z0-9-]{1,21}$ ]] || { echo "invalid client slug: $CLIENT" >&2; exit 1; }
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid sha (need full 40-hex git sha): $SHA" >&2; exit 1; }

# Fail-fast on region (decision 139's philosophy): CI gets AWS_REGION from
# the credentials action; the Makefile path must not silently depend on an
# ambient default that could target the wrong region.
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
[ -n "$REGION" ] || { echo "no region configured — export AWS_REGION or set a profile region" >&2; exit 1; }
export AWS_REGION="$REGION"

say() { echo "==> $*"; }

say "verifying ${SHA} exists in ECR (all three repos)"
for repo in platform-module platform-connector platform-backup; do
  aws ecr describe-images --repository-name "$repo" \
    --image-ids imageTag="$SHA" >/dev/null 2>&1 \
    || { echo "image ${repo}:${SHA} NOT in ECR — did build-images finish on main?" >&2; exit 1; }
done

TASKDEF_TMP=$(mktemp)
trap 'rm -f "$TASKDEF_TMP"' EXIT

new_revision() { # family → registers revision at $SHA, echoes revision arn
  local family="$1"
  aws ecs describe-task-definition --task-definition "$family" \
    --query taskDefinition --output json \
    | SHA="$SHA" python3 -c "
import json, os, re, sys
d = json.load(sys.stdin)
for c in d['containerDefinitions']:
    c['image'] = re.sub(r':[^:]+$', ':' + os.environ['SHA'], c['image'])
for k in ['taskDefinitionArn','revision','status','requiresAttributes',
          'compatibilities','registeredAt','registeredBy','deregisteredAt']:
    d.pop(k, None)
json.dump(d, sys.stdout)
" > "$TASKDEF_TMP"
  aws ecs register-task-definition --cli-input-json "file://$TASKDEF_TMP" \
    --query 'taskDefinition.taskDefinitionArn' --output text
}

say "registering service revisions at ${SHA}"
API_ARN=$(new_revision "usage-${CLIENT}-api")
CONN_ARN=$(new_revision "usage-${CLIENT}-connector")
SCHED_ARN=$(new_revision "usage-${CLIENT}-scheduler")
say "api=${API_ARN##*/} connector=${CONN_ARN##*/} scheduler=${SCHED_ARN##*/}"

# Migrations BEFORE any service sees the new code (index bootstrap only,
# decision 74 — but the ordering lives in the pipeline, not in memory).
say "running migrations"
NETCONF=$(aws ecs describe-services --cluster "$CLUSTER" \
  --services "usage-${CLIENT}-connector" \
  --query 'services[0].networkConfiguration' --output json)
RUN_OUT=$(aws ecs run-task --cluster "$CLUSTER" \
  --task-definition "$API_ARN" \
  --launch-type FARGATE \
  --network-configuration "$NETCONF" \
  --overrides '{"containerOverrides":[{"name":"api","command":["node","dist/main/jobs/run-migrations.js"]}]}' \
  --output json)
TASK_ARN=$(echo "$RUN_OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['tasks'][0]['taskArn'] if d.get('tasks') else '')")
if [ -z "$TASK_ARN" ]; then
  echo "run-task returned no task — failures:" >&2
  echo "$RUN_OUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('failures'))" >&2
  exit 1
fi
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
EXIT_CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)
if [ "$EXIT_CODE" != "0" ]; then
  echo "MIGRATIONS FAILED (exit ${EXIT_CODE}) — nothing rolled (backup untouched too)" >&2
  aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
    --query 'tasks[0].{stopped:stoppedReason,container:containers[0].reason}' --output json >&2 || true
  aws logs tail "/usage/${CLIENT}/api" --since 10m >&2 || true
  exit 1
fi
say "migrations ok"

say "rolling services"
for svc in api connector scheduler; do
  case "$svc" in
    api) ARN="$API_ARN" ;;
    connector) ARN="$CONN_ARN" ;;
    scheduler) ARN="$SCHED_ARN" ;;
  esac
  aws ecs update-service --cluster "$CLUSTER" \
    --service "usage-${CLIENT}-${svc}" \
    --task-definition "$ARN" >/dev/null
done

# Only after the gate: the backup family (its EventBridge schedule
# resolves latest ACTIVE at fire time).
say "registering backup revision"
BACKUP_ARN=$(new_revision "usage-${CLIENT}-backup")
say "backup=${BACKUP_ARN##*/}"

say "waiting for services to stabilize"
aws ecs wait services-stable --cluster "$CLUSTER" \
  --services "usage-${CLIENT}-api" "usage-${CLIENT}-connector" "usage-${CLIENT}-scheduler"

# services-stable is ALSO satisfied by a circuit-breaker ROLLBACK (audit
# round 2) — verify each service actually landed on the new revision
# before claiming success.
for svc in api connector scheduler; do
  case "$svc" in
    api) WANT="$API_ARN" ;;
    connector) WANT="$CONN_ARN" ;;
    scheduler) WANT="$SCHED_ARN" ;;
  esac
  GOT=$(aws ecs describe-services --cluster "$CLUSTER" \
    --services "usage-${CLIENT}-${svc}" \
    --query 'services[0].taskDefinition' --output text)
  if [ "$GOT" != "$WANT" ]; then
    echo "DEPLOY DID NOT TAKE for ${svc}: running ${GOT##*/}, wanted ${WANT##*/}" >&2
    echo "(likely the deployment circuit breaker rolled back — check the service events)" >&2
    exit 1
  fi
done
say "deploy of ${CLIENT} @ ${SHA} complete"
say "REMINDER: update image_sha in deploy/terraform/tenant/tenants/${CLIENT}.tfvars to ${SHA}"
say "          (a later terraform apply with a stale SHA re-registers task"
say "           definitions at the old image — the backup schedule follows latest ACTIVE)"
