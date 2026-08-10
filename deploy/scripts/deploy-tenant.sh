#!/bin/bash
# Deploy one tenant to a given image SHA (decision 140). ONE mechanism for
# both `make aws-deploy` and the deploy-tenant workflow:
#   1. register new task-def revisions (api/connector/scheduler/backup)
#      pointing at the SHA
#   2. run the migrations one-off ON the new revision and WAIT for exit 0
#   3. roll the three services (api zero-downtime; connector/scheduler
#      stop-then-start by their service config)
# Rollback = re-run with yesterday's SHA.
set -euo pipefail

CLIENT="${1:?usage: deploy-tenant.sh <client> <image-sha>}"
SHA="${2:?usage: deploy-tenant.sh <client> <image-sha>}"
CLUSTER="usage-main"

say() { echo "==> $*"; }

# Resolve the registry once from the api family's current image.
new_revision() { # family, image-tag → registers revision, echoes revision arn
  local family="$1"
  local def
  def=$(aws ecs describe-task-definition --task-definition "$family" \
    --query taskDefinition --output json)
  echo "$def" | python3 -c "
import json, re, sys
d = json.load(sys.stdin)
for c in d['containerDefinitions']:
    c['image'] = re.sub(r':[^:]+$', ':${SHA}', c['image'])
for k in ['taskDefinitionArn','revision','status','requiresAttributes',
          'compatibilities','registeredAt','registeredBy','deregisteredAt']:
    d.pop(k, None)
json.dump(d, sys.stdout)
" > /tmp/taskdef.json
  aws ecs register-task-definition --cli-input-json file:///tmp/taskdef.json \
    --query 'taskDefinition.taskDefinitionArn' --output text
}

say "registering revisions at ${SHA}"
API_ARN=$(new_revision "usage-${CLIENT}-api")
CONN_ARN=$(new_revision "usage-${CLIENT}-connector")
SCHED_ARN=$(new_revision "usage-${CLIENT}-scheduler")
BACKUP_ARN=$(new_revision "usage-${CLIENT}-backup")
say "api=${API_ARN##*/} connector=${CONN_ARN##*/} scheduler=${SCHED_ARN##*/} backup=${BACKUP_ARN##*/}"

# Migrations BEFORE any service sees the new code (index bootstrap only,
# decision 74 — but the ordering lives in the pipeline, not in memory).
say "running migrations"
NETCONF=$(aws ecs describe-services --cluster "$CLUSTER" \
  --services "usage-${CLIENT}-connector" \
  --query 'services[0].networkConfiguration' --output json)
TASK_ARN=$(aws ecs run-task --cluster "$CLUSTER" \
  --task-definition "$API_ARN" \
  --launch-type FARGATE \
  --network-configuration "$NETCONF" \
  --overrides '{"containerOverrides":[{"name":"api","command":["node","dist/main/jobs/run-migrations.js"]}]}' \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
EXIT_CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)
if [ "$EXIT_CODE" != "0" ]; then
  echo "MIGRATIONS FAILED (exit ${EXIT_CODE}) — services NOT rolled" >&2
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

say "waiting for services to stabilize"
aws ecs wait services-stable --cluster "$CLUSTER" \
  --services "usage-${CLIENT}-api" "usage-${CLIENT}-connector" "usage-${CLIENT}-scheduler"
say "deploy of ${CLIENT} @ ${SHA} complete"
