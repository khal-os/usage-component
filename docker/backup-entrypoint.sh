#!/bin/bash
# mongodump → S3, streaming (no local disk). Env contract (task definition):
#   MONGO_DB_HOST / MONGO_DB_USER / MONGO_DB_PASSWORD  (tenant secret)
#   MONGO_USAGE_DB_NAME                                 (decision 139)
#   BACKUP_BUCKET / BACKUP_PREFIX
# pipefail is the whole point: a failed dump must fail the task, never
# upload a truncated archive as if it were a backup.
set -euo pipefail

: "${MONGO_DB_HOST:?}" "${MONGO_DB_USER:?}" "${MONGO_DB_PASSWORD:?}"
: "${MONGO_USAGE_DB_NAME:?}" "${BACKUP_BUCKET:?}" "${BACKUP_PREFIX:?}"

STAMP=$(date -u +%Y-%m-%dT%H%MZ)
DEST="s3://${BACKUP_BUCKET}/${BACKUP_PREFIX}/${STAMP}.archive.gz"

echo "backup: dumping ${MONGO_USAGE_DB_NAME} -> ${DEST}"

mongodump \
  --uri "mongodb+srv://${MONGO_DB_HOST}/" \
  --username "${MONGO_DB_USER}" \
  --password "${MONGO_DB_PASSWORD}" \
  --db "${MONGO_USAGE_DB_NAME}" \
  --archive --gzip \
  | aws s3 cp - "${DEST}" --expected-size 1073741824

echo "backup: done ${DEST}"
