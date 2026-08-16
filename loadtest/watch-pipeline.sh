#!/usr/bin/env bash
# Watches every stage of the write path while a load run is in flight — one
# line every INTERVAL seconds with counts and rates, so you can see WHICH
# stage saturates:
#
#   LangWatch app → redis (bullmq queues) → workers → ClickHouse
#                                → trace-ingestion-worker → Mongo
#
# Read-only: queries containers, writes nothing.
#
# Usage:  CLIENT=<client slug> ./loadtest/watch-pipeline.sh [INTERVAL]
#         ./loadtest/watch-pipeline.sh --aws <client> [INTERVAL]
#
# --aws runs the SAME queries against a deployed tenant (decision 157): the
# bullmq llen/zcard on redis and the trace_summaries/stored_spans counts on
# ClickHouse, executed on the LangWatch instance through `ssm send-command`
# instead of a local `docker exec`, and the Mongo count read from the module
# API's `GET /traces` total instead of mongosh. Same columns, same verdict
# rules, so a pass on AWS means what a pass on compose meant — which matters,
# because the 1000 traces/s gate (decision 140) is a per-ACCOUNT onboarding
# step and proving the shape locally proves nothing about the account.
#
# The interval widens to ~10s in AWS mode: a send-command round trip costs a
# few seconds, and that is irrelevant over a 60s burst.
#
# Needs `ssm:SendCommand` on the operator's credentials and nothing new on
# the box — the SSM agent is already there for Session Manager. If the API
# has session auth on, export USAGE_API_TOKEN with a bearer token.
set -euo pipefail

MODE="local"
if [ "${1:-}" = "--aws" ]; then
  MODE="aws"
  shift
  CLIENT="${1:?usage: watch-pipeline.sh --aws <client> [INTERVAL]}"
  shift
fi

: "${CLIENT:?export CLIENT first (the loadtest client slug)}"

if [ "$MODE" = "local" ]; then
  INTERVAL="${1:-2}"

  REDIS="${CLIENT}-langwatch-redis"
  CH="${CLIENT}-langwatch-clickhouse"
  MONGO="${CLIENT}-mongo"

  for c in "$REDIS" "$CH" "$MONGO"; do
    docker inspect "$c" >/dev/null 2>&1 || { echo "ERROR: container '$c' not running"; exit 1; }
  done

  # bullmq backlog: wait/active are lists, delayed is a zset. Sum across queues.
  redis_depth() {
    docker exec "$REDIS" sh -c '
      total=0
      for key in $(redis-cli --scan --pattern "bull:*:wait" ; redis-cli --scan --pattern "bull:*:active"); do
        n=$(redis-cli llen "$key"); total=$((total + n))
      done
      for key in $(redis-cli --scan --pattern "bull:*:delayed"); do
        n=$(redis-cli zcard "$key"); total=$((total + n))
      done
      echo $total' 2>/dev/null || echo "?"
  }

  ch_counts() {
    docker exec "$CH" clickhouse-client --user default --password "${LANGWATCH_CLICKHOUSE_PASSWORD:-langwatch}" --query \
      "SELECT (SELECT count() FROM langwatch.trace_summaries), (SELECT count() FROM langwatch.stored_spans) FORMAT TSV" 2>/dev/null \
      || printf '?\t?'
  }

  mongo_count() {
    docker exec "$MONGO" mongosh --quiet --eval \
      "db.getSiblingDB('${CLIENT}').traces.countDocuments({})" 2>/dev/null || echo "?"
  }
else
  INTERVAL="${1:-10}"

  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck source=deploy/scripts/naming.sh
  source "${HERE}/../deploy/scripts/naming.sh"
  tenant_load "$CLIENT"
  export AWS_REGION="${TENANT_REGION}"

  INSTANCE_ID="$(aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=$(name_thing langwatch)" "Name=instance-state-name,Values=running" \
    --query 'Reservations[0].Instances[0].InstanceId' --output text)"
  [ -n "$INSTANCE_ID" ] && [ "$INSTANCE_ID" != "None" ] \
    || { echo "ERROR: no running instance tagged $(name_thing langwatch)"; exit 1; }

  API_BASE="https://$(hostname_api)"
  echo "watching ${CLIENT} on ${INSTANCE_ID} (api: ${API_BASE})"

  # ONE round trip per interval: both probes run in the same document.
  # The output is the same TSV shape the local mode produces, so the loop
  # below is untouched.
  BOX_PROBE='
set -e
. /opt/langwatch/tenant.conf
. /opt/langwatch/.env
total=0
for key in $(docker exec ${CLIENT_NAME}-langwatch-redis redis-cli --scan --pattern "bull:*:wait"; docker exec ${CLIENT_NAME}-langwatch-redis redis-cli --scan --pattern "bull:*:active"); do
  n=$(docker exec ${CLIENT_NAME}-langwatch-redis redis-cli llen "$key"); total=$((total + n))
done
for key in $(docker exec ${CLIENT_NAME}-langwatch-redis redis-cli --scan --pattern "bull:*:delayed"); do
  n=$(docker exec ${CLIENT_NAME}-langwatch-redis redis-cli zcard "$key"); total=$((total + n))
done
echo "$total"
docker exec ${CLIENT_NAME}-langwatch-clickhouse clickhouse-client --user default \
  --password "$LANGWATCH_CLICKHOUSE_PASSWORD" --query \
  "SELECT (SELECT count() FROM langwatch.trace_summaries), (SELECT count() FROM langwatch.stored_spans) FORMAT TSV"
'
  BOX_OUT=""
  box_probe() {
    local cmd_id
    cmd_id="$(aws ssm send-command --instance-ids "$INSTANCE_ID" \
      --document-name AWS-RunShellScript \
      --parameters "commands=[$(python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' <<< "$BOX_PROBE")]" \
      --query 'Command.CommandId' --output text 2>/dev/null)" || { BOX_OUT=""; return; }
    aws ssm wait command-executed --command-id "$cmd_id" --instance-id "$INSTANCE_ID" 2>/dev/null || true
    BOX_OUT="$(aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$INSTANCE_ID" \
      --query StandardOutputContent --output text 2>/dev/null || true)"
  }

  redis_depth() { printf '%s' "$(sed -n '1p' <<< "$BOX_OUT")"; }
  ch_counts() {
    local line; line="$(sed -n '2p' <<< "$BOX_OUT")"
    [ -n "$line" ] && printf '%s' "$line" || printf '?\t?'
  }
  # The module's own total — the same number `mongosh countDocuments` gave,
  # read through the door the client uses.
  mongo_count() {
    curl -sS --max-time 15 \
      ${USAGE_API_TOKEN:+-H "Authorization: Bearer ${USAGE_API_TOKEN}"} \
      "${API_BASE}/api/v1/traces?limit=1" 2>/dev/null \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("total","?"))' 2>/dev/null \
      || echo "?"
  }
fi

prev_traces=0
prev_mongo=0
prev_t=$(date +%s)

printf "%-8s %-10s %-12s %-12s %-10s %-10s %-10s\n" \
  "elapsed" "queue" "ch_traces" "ch_spans" "ch_tr/s" "mongo" "mongo/s"

start=$(date +%s)
while true; do
  [ "$MODE" = "aws" ] && box_probe
  q=$(redis_depth)
  IFS=$'\t' read -r ch_traces ch_spans <<< "$(ch_counts)"
  m=$(mongo_count)
  now=$(date +%s)
  dt=$((now - prev_t)); [ "$dt" -eq 0 ] && dt=1
  tr_rate="?"; mg_rate="?"
  [[ "$ch_traces" =~ ^[0-9]+$ ]] && tr_rate=$(( (ch_traces - prev_traces) / dt )) && prev_traces=$ch_traces
  [[ "$m" =~ ^[0-9]+$ ]] && mg_rate=$(( (m - prev_mongo) / dt )) && prev_mongo=$m
  prev_t=$now
  printf "%-8s %-10s %-12s %-12s %-10s %-10s %-10s\n" \
    "$((now - start))s" "${q:-?}" "$ch_traces" "$ch_spans" "$tr_rate" "$m" "$mg_rate"
  sleep "$INTERVAL"
done
