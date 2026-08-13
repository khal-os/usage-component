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

# Each key resolves as a STANDALONE command (audit round 2): a command
# substitution inside a heredoc never trips set -e, and `jq -e` still
# PRINTS "null" for a missing key — the old shape wrote the literal
# string "null" as CREDENTIALS_SECRET, which is unrecoverable after
# first boot. As standalone assignments, jq -e's non-zero DOES abort.
jq_secret() { echo "$SECRET_JSON" | jq -er ".$1"; }
jq_cap() { echo "$CAPACITY_JSON" | jq -er ".$1"; }

V_NEXTAUTH=$(jq_secret LW_NEXTAUTH_SECRET)
V_JWT=$(jq_secret LW_API_TOKEN_JWT_SECRET)
V_CREDENTIALS=$(jq_secret LW_CREDENTIALS_SECRET)
V_REPLICAS=$(jq_cap LANGWATCH_WORKERS_REPLICAS)
V_LW_MEM=$(jq_cap LANGWATCH_MEMORY_LIMIT)
V_REDIS_MEM=$(jq_cap LANGWATCH_REDIS_MEMORY_LIMIT)
V_CH_MEM=$(jq_cap LANGWATCH_CLICKHOUSE_MEMORY_LIMIT)
V_CH_CPU=$(jq_cap LANGWATCH_CLICKHOUSE_CPU_LIMIT)

cat > .env <<ENV_EOF
CLIENT_NAME=$CLIENT_NAME
LANGWATCH_PUBLIC_URL=$LANGWATCH_PUBLIC_URL
LANGWATCH_NEXTAUTH_SECRET=$V_NEXTAUTH
LANGWATCH_API_TOKEN_JWT_SECRET=$V_JWT
LANGWATCH_CREDENTIALS_SECRET=$V_CREDENTIALS
LANGWATCH_WORKERS_REPLICAS=$V_REPLICAS
LANGWATCH_MEMORY_LIMIT=$V_LW_MEM
LANGWATCH_REDIS_MEMORY_LIMIT=$V_REDIS_MEM
LANGWATCH_CLICKHOUSE_MEMORY_LIMIT=$V_CH_MEM
LANGWATCH_CLICKHOUSE_CPU_LIMIT=$V_CH_CPU
ENV_EOF
chmod 600 .env

docker compose --env-file .env up -d --remove-orphans
echo "langwatch-bootstrap: stack up for $CLIENT_NAME"
