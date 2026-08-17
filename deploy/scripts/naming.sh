#!/usr/bin/env bash
# THE naming formula (decision 149) — the ONE place a khal-* AWS resource
# name or a khal/* store path is computed. Sourced by deploy-tenant.sh,
# preflight-aws.sh and render-taskdef.sh; no second copy exists anywhere
# (that is the point: a rename is one file, not a grep-and-pray).
#
# Four axes, always all four (redundancy on purpose — an ARN, an S3 key or
# a metric dimension read in isolation still says whose it is, even though
# each client has its own AWS account):
#
#   org=khal · client=<slug> · envcode=prod|hml · component=usage
#
#   resource names  khal-<client>-<envcode>-usage[-<thing>]   hyphens, flat
#   store paths     khal/<client>/<envcode>/usage/<thing>     slashes
#
# Hyphens for names, slashes for the hierarchical stores (Secrets Manager,
# SSM, log groups) whose hierarchy is FUNCTIONAL — get-parameters-by-path,
# IAM prefix policies. ECR's is not, so ECR is flat like every other name.
#
# Usage — sourced:
#   source deploy/scripts/naming.sh
#   tenant_load hapvida
#   echo "$(name_base)"  "$(name_service api)"  "$(log_group connector)"
#
# Usage — one-shot (this is what the smoke test asserts against):
#   bash deploy/scripts/naming.sh hapvida name_service api
#
# Fail-fast throughout (decision 139): a missing tenant file, a slug that
# does not match its filename, an environment that is not prod|hml, or a
# computed name over an AWS length cap all DIE. Nothing is defaulted,
# truncated or guessed — a silently truncated name is how two tenants end
# up sharing a target group.

# Not `set -e` here: this file is sourced into scripts that set their own
# options. Every failure path below calls _naming_die explicitly.

KHAL_ORG="khal"
# The component axis of THIS repo (CLAUDE.md: the observability COMPONENT
# of Khal OS, deployed as the "usage" component). One repo, one value.
KHAL_COMPONENT="usage"

_naming_self="${BASH_SOURCE[0]}"
NAMING_DIR="$(cd "$(dirname "${_naming_self}")" && pwd)"
# Overridable so the smoke test can point at a fixture directory.
TENANT_DIR="${TENANT_DIR:-${NAMING_DIR}/../tenants}"

_naming_die() { printf 'naming: %s\n' "$*" >&2; exit 1; }

# ── the tenant file ─────────────────────────────────────────────────────────
# Same reader convention as the compose world's clients/<name>.env
# (`get()` in scripts/deploy-lib.sh): KEY=value, first match wins, absent
# answers empty. `|| true` because the caller runs under `set -o pipefail`
# and a missing key is a normal answer here — the REQUIRED ones are
# checked explicitly in tenant_load.
tget() { grep -oP "(?<=^$1=).*" "${TENANT_FILE}" | head -1 || true; }

# Load + validate deploy/tenants/<client>.env. Everything below this line
# assumes tenant_load ran.
tenant_load() {
  local client="${1:?tenant_load <client>}"

  TENANT_FILE="${TENANT_DIR}/${client}.env"
  [ -f "${TENANT_FILE}" ] || _naming_die \
    "no tenant file ${TENANT_FILE} — a tenant is DECLARED before it is deployed; no name is ever guessed"

  # The slug cap is 12, not cosmetic: the binding name is the api target
  # group, khal-<client>-prod-usage-api = 20 + slug, against AWS's 32-char
  # ALB/TG limit. _naming_check_caps re-derives it, this is the early,
  # readable refusal.
  [[ "${client}" =~ ^[a-z][a-z0-9-]{1,11}$ ]] || _naming_die \
    "invalid client slug '${client}' — lowercase, starts with a letter, 2-12 chars (khal-<slug>-prod-usage-api must fit AWS's 32-char name cap)"

  CLIENT_NAME="$(tget CLIENT_NAME)"
  [ -n "${CLIENT_NAME}" ] || _naming_die "${TENANT_FILE} declares no CLIENT_NAME"
  # The same trap require-client guards on the compose side: a file named
  # foo.env holding CLIENT_NAME=bar computes ANOTHER tenant's names, and
  # every call after that lands in the wrong account's resources.
  [ "${CLIENT_NAME}" = "${client}" ] || _naming_die \
    "${TENANT_FILE} says CLIENT_NAME=${CLIENT_NAME} but the file is ${client}.env — a mismatch computes another tenant's names"

  ENVIRONMENT="$(tget ENVIRONMENT)"
  [ -n "${ENVIRONMENT}" ] || _naming_die \
    "${TENANT_FILE} declares no ENVIRONMENT — deployment identity is declared, never defaulted (decision 139)"
  # prod|hml and nothing else. There is NO mapping table: the token in the
  # file is the token in every name and every path. `development` is
  # rejected on purpose — dev is local compose, it has no AWS names.
  case "${ENVIRONMENT}" in
    prod | hml) ;;
    *) _naming_die "ENVIRONMENT=${ENVIRONMENT} is not an AWS environment — use prod or hml (dev is local compose; 'production'/'homolog' are the CONTAINER's spelling, see env_word)" ;;
  esac

  AWS_ACCOUNT_ID="$(tget AWS_ACCOUNT_ID)"
  [[ "${AWS_ACCOUNT_ID}" =~ ^[0-9]{12}$ ]] || _naming_die \
    "${TENANT_FILE}: AWS_ACCOUNT_ID must be 12 digits (got '${AWS_ACCOUNT_ID}')"

  TENANT_REGION="$(tget AWS_REGION)"
  [[ "${TENANT_REGION}" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || _naming_die \
    "${TENANT_FILE}: AWS_REGION must be an AWS region id (got '${TENANT_REGION}')"

  BASE_DOMAIN="$(tget BASE_DOMAIN)"
  [ -n "${BASE_DOMAIN}" ] || _naming_die \
    "${TENANT_FILE} declares no BASE_DOMAIN — the zone is external, looked up and asserted, never created by us, and never assumed"

  _naming_check_caps
  export TENANT_FILE CLIENT_NAME ENVIRONMENT AWS_ACCOUNT_ID TENANT_REGION BASE_DOMAIN
}

# ── two levels, not one (decision 167) ──────────────────────────────────────
# Some resources belong to the CLIENT and not to any component: the network
# is shared by every app and API the client runs, so calling a VPC
# khal-<client>-<env>-usage-vpc claims an ownership that does not exist —
# and the predictable damage is someone creating a SECOND VPC later because
# "that one is the usage one".
#
# Client level takes THREE axes; there is no component to name, and forcing
# a filler value like `shared` or `net` would invent one.
#
#   client level      khal-<client>-<env>-<thing>        VPC, subnets, IGW,
#                                                        NAT, route tables,
#                                                        endpoints, SGs, ALB,
#                                                        the ACM certificate
#   component level   khal-<client>-<env>-usage-<thing>  everything the usage
#                                                        component owns alone
#
# Target groups stay at COMPONENT level — khal-<client>-<env>-usage-api
# points at the usage api — so the 32-char cap and the 12-char slug limit
# are unchanged.

# ── resource names (hyphens) ────────────────────────────────────────────────

# The client's own prefix — three axes, no component.
name_client_base() { printf '%s-%s-%s' "${KHAL_ORG}" "${CLIENT_NAME}" "${ENVIRONMENT}"; }

# Anything the CLIENT owns rather than a component: vpc, alb, nat, igw…
name_client() { printf '%s-%s' "$(name_client_base)" "${1:?name_client <thing>}"; }

# cluster · the prefix of everything the component owns
name_base() { printf '%s-%s-%s-%s' "${KHAL_ORG}" "${CLIENT_NAME}" "${ENVIRONMENT}" "${KHAL_COMPONENT}"; }

# ECS service · task-definition family · target group   (api connector scheduler backup lw)
name_service() { printf '%s-%s' "$(name_base)" "${1:?name_service <svc>}"; }

# IAM role   (execution task backup-task backup-schedule langwatch dlm github-ci audit)
name_role() { printf '%s-%s' "$(name_base)" "${1:?name_role <role>}"; }

# security group   (alb api workers langwatch atlas) — CLIENT level: they
# gate the client's network, and a platform Lambda will want one too.
name_sg() { printf '%s-%s' "$(name_client_base)" "${1:?name_sg <sg>}"; }

# anything else that is just BASE-<thing>: vpc, nat, alarms, the backup
# schedule, the backup-failed rule…
name_thing() { printf '%s-%s' "$(name_base)" "${1:?name_thing <thing>}"; }

# ECR repository   (module connector db-backup) — flat, no slashes
ecr_repo() { printf '%s-%s' "$(name_base)" "${1:?ecr_repo <image>}"; }

ecr_registry() { printf '%s.dkr.ecr.%s.amazonaws.com' "${AWS_ACCOUNT_ID}" "${TENANT_REGION}"; }

ecr_image() { printf '%s/%s:%s' "$(ecr_registry)" "$(ecr_repo "${1:?ecr_image <image> <tag>}")" "${2:?ecr_image <image> <tag>}"; }

# S3 appends the account-regional suffix itself — the full name is the
# prefix plus -<account>-<region>-an (verified against the live bucket).
bucket_backups() { printf '%s-backups-%s-%s-an' "$(name_base)" "${AWS_ACCOUNT_ID}" "${TENANT_REGION}"; }

topic_alerts() { printf '%s-alerts' "$(name_base)"; }

# ── store paths (slashes) ───────────────────────────────────────────────────

_path_base() { printf '%s/%s/%s/%s' "${KHAL_ORG}" "${CLIENT_NAME}" "${ENVIRONMENT}" "${KHAL_COMPONENT}"; }

# Secrets Manager: one JSON object per FAMILY (mongo, langwatch), keys ==
# env var names.
secret_id() { printf '%s/%s' "$(_path_base)" "${1:?secret_id <family>}"; }

# SSM Parameter Store — leading slash.
ssm_param() { printf '/%s/%s' "$(_path_base)" "${1:?ssm_param <param>}"; }

ssm_param_arn() { printf 'arn:aws:ssm:%s:%s:parameter%s' "${TENANT_REGION}" "${AWS_ACCOUNT_ID}" "$(ssm_param "$1")"; }

# CloudWatch log groups — leading slash, one per service.
log_group() { printf '/%s/%s' "$(_path_base)" "${1:?log_group <svc>}"; }

# S3 key prefixes INSIDE the bucket: client only — the bucket name already
# carries client + env.
s3_backups_prefix() { printf 'backups/%s' "${CLIENT_NAME}"; }
s3_config_prefix() { printf 'config/%s' "${CLIENT_NAME}"; }
s3_config_uri() { printf 's3://%s/%s/%s' "$(bucket_backups)" "$(s3_config_prefix)" "${1:?s3_config_uri <file>}"; }

# ── hostnames ───────────────────────────────────────────────────────────────
# No <client>- prefix: the client IS the domain, and DNS has its own
# grammar — the four-axis redundancy is for names that travel as ARNs, S3
# keys and metric dimensions. A tenant that brings its own domain can
# override either hostname outright.

hostname_api() { local o; o="$(tget API_HOSTNAME)"; printf '%s' "${o:-api.${BASE_DOMAIN}}"; }
hostname_langwatch() { local o; o="$(tget LANGWATCH_HOSTNAME)"; printf '%s' "${o:-langwatch.${BASE_DOMAIN}}"; }

# ── the ONE code→word map ───────────────────────────────────────────────────
# Not an AWS name: the container's own ENVIRONMENT variable, whose app
# schema (environment-setup.ts, shared with the compose world) is
# enum('production','homolog','test','development'). This two-line table is
# the only place the full word exists on the AWS side.
env_word() {
  case "${ENVIRONMENT}" in
    prod) printf 'production' ;;
    hml) printf 'homolog' ;;
    *) _naming_die "env_word: unreachable — tenant_load validates ENVIRONMENT" ;;
  esac
}

# ── the account guard ───────────────────────────────────────────────────────
# NOT part of tenant_load: naming.sh must answer offline, and the smoke
# suite runs it with no AWS at all. Callers that are about to touch AWS
# invoke this explicitly.
#
# Every khal-* name is scoped by client and env but NOT by account, so the
# same names can exist in more than one account — and today they do share
# one: the hapvida silo lives beside usage-main and khal-web-desktop in
# 504557607647 (decision 163). A profile pointing at the wrong account
# would therefore either report everything as absent, or in the
# multi-account future find same-named resources belonging to someone else.
# get-caller-identity needs no permission, so this costs nothing.
assert_account() {
  local live
  live="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
  [ -n "${live}" ] || _naming_die "cannot read the current AWS identity — are credentials configured?"
  [ "${live}" = "${AWS_ACCOUNT_ID}" ] || _naming_die \
    "wrong account: credentials are in ${live}, but ${TENANT_FILE} declares ${AWS_ACCOUNT_ID}"
}

# ── length caps ─────────────────────────────────────────────────────────────
# Terraform used substr(…, 0, 32) in three places, which can cut a name to
# a trailing '-' or collide two tenants. There is no truncation here: an
# over-long name is a REFUSAL, at load time, before a single AWS call.
_naming_check_caps() {
  local n
  # ALB is client level now (32); the two target groups stay component
  # level and remain the binding constraint on the slug.
  for n in "$(name_client_base)" "$(name_service api)" "$(name_service lw)"; do
    [ "${#n}" -le 32 ] || _naming_die "computed name '${n}' is ${#n} chars — AWS caps ALB/target-group names at 32"
  done
  # IAM roles (64) — longest is -backup-schedule.
  n="$(name_role backup-schedule)"
  [ "${#n}" -le 64 ] || _naming_die "computed role name '${n}' is ${#n} chars — AWS caps IAM role names at 64"
  # S3 bucket (63), suffix included.
  n="$(bucket_backups)"
  [ "${#n}" -le 63 ] || _naming_die "computed bucket name '${n}' is ${#n} chars — S3 caps bucket names at 63"
}

# ── one-shot mode ───────────────────────────────────────────────────────────
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  _client="${1:?usage: naming.sh <client> <function> [args…]}"
  _fn="${2:?usage: naming.sh <client> <function> [args…]}"
  case "${_fn}" in
    name_* | ecr_* | bucket_* | topic_* | secret_* | ssm_* | log_group | s3_* | hostname_* | env_word | tget | assert_account) ;;
    *) _naming_die "not an exported naming function: ${_fn}" ;;
  esac
  tenant_load "${_client}"
  "${_fn}" "${@:3}"
  echo
fi
