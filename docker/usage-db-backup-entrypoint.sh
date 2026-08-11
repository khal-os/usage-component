#!/bin/bash
# mongodump → S3, streaming (no local disk). Env contract (task definition):
#   MONGO_DB_HOST / MONGO_DB_USER / MONGO_DB_PASSWORD  (tenant secret)
#   MONGO_USAGE_DB_NAME                                 (decision 139)
#   BACKUP_BUCKET / BACKUP_PREFIX
# Review-hardened flow: upload to a .tmp key, verify the dump pipeline's
# OWN exit status (PIPESTATUS — `aws s3 cp -` happily completes a
# truncated multipart upload on EOF), rename into place only on success,
# then publish the Succeeded metric the 25h backstop alarm watches.
set -euo pipefail

: "${MONGO_DB_HOST:?}" "${MONGO_DB_USER:?}" "${MONGO_DB_PASSWORD:?}"
: "${MONGO_USAGE_DB_NAME:?}" "${BACKUP_BUCKET:?}" "${BACKUP_PREFIX:?}"

STAMP=$(date -u +%Y-%m-%dT%H%MZ)
# backups/ prefix ON PURPOSE (audit round 2): the bucket's lifecycle rule
# is scoped to backups/* so it can never Glacier/expire the config/
# objects the LangWatch EC2 boots from.
FINAL="s3://${BACKUP_BUCKET}/backups/${BACKUP_PREFIX}/${STAMP}.archive.gz"
TMP="${FINAL}.tmp"

echo "backup: dumping ${MONGO_USAGE_DB_NAME} -> ${TMP}"

set +e
mongodump \
  --uri "mongodb+srv://${MONGO_DB_HOST}/" \
  --username "${MONGO_DB_USER}" \
  --password "${MONGO_DB_PASSWORD}" \
  --authenticationDatabase admin \
  --db "${MONGO_USAGE_DB_NAME}" \
  --archive --gzip \
  | aws s3 cp - "${TMP}" --expected-size 4294967296
# ONE line, atomically (audit round 2): the first assignment is itself a
# command and would reset PIPESTATUS — reading [1] afterwards was an
# unbound-variable abort (exit 127) on EVERY run, after the upload.
STATUSES=("${PIPESTATUS[@]}")
DUMP_STATUS=${STATUSES[0]}
UPLOAD_STATUS=${STATUSES[1]}
set -e

if [ "${DUMP_STATUS}" != "0" ] || [ "${UPLOAD_STATUS}" != "0" ]; then
  echo "backup FAILED (mongodump=${DUMP_STATUS} upload=${UPLOAD_STATUS}) — removing partial object" >&2
  aws s3 rm "${TMP}" || true
  exit 1
fi

aws s3 mv "${TMP}" "${FINAL}"

aws cloudwatch put-metric-data \
  --namespace Usage/Backup \
  --metric-name Succeeded \
  --dimensions Tenant="${BACKUP_PREFIX}" \
  --value 1

echo "backup: done ${FINAL}"
