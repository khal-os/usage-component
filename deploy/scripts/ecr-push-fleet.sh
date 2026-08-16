#!/usr/bin/env bash
# Push ONE already-built local image to every enabled tenant's ECR
# (decision 153).
#
#   ecr-push-fleet.sh <image-key> <local-tag> <sha>
#     image-key   module | connector | db-backup   (the naming.sh axis)
#     local-tag   the tag `docker build` produced in this job
#     sha         the 40-hex git sha every registry gets
#
# BUILD ONCE, TAG N TIMES. Never rebuild per account: the same commit would
# produce different bytes per client and "rollback = redeploy an older SHA"
# would stop being a guarantee.
#
# One OIDC token, N assume-roles. GitHub's configure-aws-credentials action
# is a single step and cannot loop, so the web-identity token is fetched
# once here and exchanged per account against that account's
# khal-<client>-<env>-usage-github-ci role — which is why no per-client
# GitHub variable is ever needed: the role ARN is computed from the tenant
# file's AWS_ACCOUNT_ID.
#
# A failing account does NOT abort the others (matching the workflow's
# fail-fast: false), but the run goes red and the summary names every
# account that did and did not get the image — a partial release that
# reports green is the failure mode this exists to prevent.
set -uo pipefail

IMAGE_KEY="${1:?usage: ecr-push-fleet.sh <image-key> <local-tag> <sha>}"
LOCAL_TAG="${2:?usage: ecr-push-fleet.sh <image-key> <local-tag> <sha>}"
SHA="${3:?usage: ecr-push-fleet.sh <image-key> <local-tag> <sha>}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/scripts/naming.sh
source "${HERE}/naming.sh"
TENANT_DIR="${TENANT_DIR:-${HERE}/../tenants}"

[[ "${SHA}" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid sha: ${SHA}" >&2; exit 1; }

# ── the web identity token, once ────────────────────────────────────────────
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?this script runs in a job with id-token: write}"
: "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?this script runs in a job with id-token: write}"
WEB_IDENTITY_TOKEN="$(curl -sS -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=sts.amazonaws.com" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')"
[ -n "${WEB_IDENTITY_TOKEN}" ] || { echo "could not obtain a GitHub OIDC token" >&2; exit 1; }
TOKEN_FILE="$(mktemp)"
trap 'rm -f "${TOKEN_FILE}"' EXIT
printf '%s' "${WEB_IDENTITY_TOKEN}" > "${TOKEN_FILE}"
chmod 600 "${TOKEN_FILE}"

PUSHED=""
SKIPPED=""
PARKED=""
FAILED=""

for file in "${TENANT_DIR}"/*.env; do
  [ -e "${file}" ] || { echo "no tenant files in ${TENANT_DIR}" >&2; exit 1; }
  client="$(basename "${file}" .env)"
  [ "${client}" = "example" ] && continue

  (
    tenant_load "${client}"
    # A tenant may be committed BEFORE its account is bootstrapped. Without
    # this flag that leg would be red on every push to main, and a leg that
    # is always red is a leg nobody reads.
    [ "$(tget IMAGES_ENABLED)" = "true" ] || exit 3

    export AWS_REGION="${TENANT_REGION}"
    export AWS_ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/$(name_role github-ci)"
    export AWS_WEB_IDENTITY_TOKEN_FILE="${TOKEN_FILE}"
    unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

    repo="$(ecr_repo "${IMAGE_KEY}")"
    target="$(ecr_image "${IMAGE_KEY}" "${SHA}")"

    # Immutable tags: a rerun would be REFUSED, not silently overwritten.
    if aws ecr describe-images --repository-name "${repo}" \
        --image-ids imageTag="${SHA}" >/dev/null 2>&1; then
      echo "${client}: ${repo}:${SHA} already present"
      exit 2
    fi

    aws ecr get-login-password | docker login --username AWS --password-stdin "$(ecr_registry)" >/dev/null
    docker tag "${LOCAL_TAG}" "${target}"
    docker push "${target}"
  )
  case "$?" in
    0) PUSHED="${PUSHED} ${client}" ;;
    2) SKIPPED="${SKIPPED} ${client}" ;;
    3) PARKED="${PARKED} ${client}" ;;
    *) FAILED="${FAILED} ${client}" ;;
  esac
done

summary() {
  printf '### %s @ %s\n\n' "${IMAGE_KEY}" "${SHA:0:12}"
  printf -- '- pushed:%s\n' "${PUSHED:- none}"
  printf -- '- already present:%s\n' "${SKIPPED:- none}"
  printf -- '- parked (IMAGES_ENABLED=false):%s\n' "${PARKED:- none}"
  printf -- '- FAILED:%s\n' "${FAILED:- none}"
}
summary
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && summary >> "${GITHUB_STEP_SUMMARY}"

[ -z "${FAILED}" ] || exit 1
exit 0
