#!/bin/bash
# LangWatch per-boot bootstrap (decision 142 review fixes). Served from S3
# and re-fetched by langwatch-bootstrap.service on EVERY start — the env
# file is disposable output, regenerated from Secrets Manager + the SSM
# capacity parameter each time. Fails hard on anything missing; systemd
# Restart=on-failure retries until the operator fills the secret (first
# boot races the runbook's put-secret-value on purpose — the retry loop IS
# the self-heal).
set -euo pipefail

# Written once by user-data: CLIENT_NAME, REGION, SECRET_ARN,
# CAPACITY_PARAM, COMPOSE_S3_URI, LANGWATCH_PUBLIC_URL
source /opt/langwatch/tenant.conf

cd /opt/langwatch

aws s3 cp "$COMPOSE_S3_URI" compose.yml --region "$REGION"

SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_ARN" --region "$REGION" \
  --query SecretString --output text)

CAPACITY_JSON=$(aws ssm get-parameter \
  --name "$CAPACITY_PARAM" --region "$REGION" \
  --query Parameter.Value --output text)

# jq -er: a MISSING key aborts the boot (jq -r would emit the literal
# string "null" — and a "null" CREDENTIALS_SECRET is unrecoverable after
# first boot).
jq_secret() { echo "$SECRET_JSON" | jq -er ".$1"; }
jq_cap() { echo "$CAPACITY_JSON" | jq -er ".$1"; }

cat > .env <<ENV_EOF
CLIENT_NAME=$CLIENT_NAME
LANGWATCH_PUBLIC_URL=$LANGWATCH_PUBLIC_URL
LW_NEXTAUTH_SECRET=$(jq_secret LW_NEXTAUTH_SECRET)
LW_API_TOKEN_JWT_SECRET=$(jq_secret LW_API_TOKEN_JWT_SECRET)
LW_CREDENTIALS_SECRET=$(jq_secret LW_CREDENTIALS_SECRET)
LANGWATCH_WORKERS_REPLICAS=$(jq_cap LANGWATCH_WORKERS_REPLICAS)
LANGWATCH_MEMORY_LIMIT=$(jq_cap LANGWATCH_MEMORY_LIMIT)
LW_REDIS_MEMORY_LIMIT=$(jq_cap LW_REDIS_MEMORY_LIMIT)
LW_CLICKHOUSE_MEMORY_LIMIT=$(jq_cap LW_CLICKHOUSE_MEMORY_LIMIT)
LW_CLICKHOUSE_CPU_LIMIT=$(jq_cap LW_CLICKHOUSE_CPU_LIMIT)
ENV_EOF
chmod 600 .env

docker compose --env-file .env up -d --remove-orphans
echo "langwatch-bootstrap: stack up for $CLIENT_NAME"
