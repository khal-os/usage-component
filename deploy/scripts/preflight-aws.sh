#!/usr/bin/env bash
# Read-only checker of the AWS handoff contract (decision 152). Infra
# creates every resource; this asserts they exist AND carry the settings
# the pipeline and the data depend on. Nothing here creates, updates or
# deletes anything.
#
#   preflight-aws.sh --gate <client>   CD-role-visible subset, run on every deploy
#   preflight-aws.sh <client>          full audit — the onboarding gate
#   preflight-aws.sh --fleet           every tenant, through its audit role
#
# WHY A SCRIPT AND NOT `terraform plan`: the checks that matter most are
# invisible to a data source. `data "aws_ecs_service"` exposes no
# deploymentConfiguration, so the 0/100 singleton rule — the one standing
# between us and double-counted traces — cannot be asserted there at all;
# Scheduler schedules, alarms, DLM and autoscaling targets have no data
# source whatsoever. Preflight sees all of it, so it is the ONE checker: a
# second would only need keeping in agreement with this.
#
# STYLE is a deliberate hybrid: deploy-tenant.sh's AWS conventions (English,
# ${1:?usage}, --query/--output text, python3 never jq) over
# deploy-smoke-test.sh's accumulating ok/bad counter. It does NOT source
# scripts/deploy-lib.sh — that library is Portuguese, compose-world, and
# dies on first failure; an audit must report EVERY violation in one pass.
#
# `set -e` is deliberately absent for that same reason.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/scripts/naming.sh
source "${HERE}/naming.sh"
TENANT_DIR="${TENANT_DIR:-${HERE}/../tenants}"

FAILURES=0
WARNINGS=0

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_WARN=$'\033[33m'; C_H=$'\033[36m'; C_B=$'\033[1m'; C_R=$'\033[0m'
else
  C_OK='' C_BAD='' C_WARN='' C_H='' C_B='' C_R=''
fi

ok()   { printf '  %s✔%s %s\n' "${C_OK}" "${C_R}" "$1"; }
bad()  { printf '  %s✖%s %s\n' "${C_BAD}" "${C_R}" "$1"; FAILURES=$((FAILURES + 1)); }
warn() { printf '  %s!%s %s\n' "${C_WARN}" "${C_R}" "$1"; WARNINGS=$((WARNINGS + 1)); }
# Empty notes are dropped: an AWS error with nothing on stderr would
# otherwise print a blank line under every failure.
note() { [ -n "$1" ] && printf '    %s\n' "$1"; return 0; }
sect() { printf '\n%s▸%s %s%s%s\n' "${C_H}" "${C_R}" "${C_B}" "$1" "${C_R}"; }

# ── the AccessDenied discipline ─────────────────────────────────────────────
# A permission gap that reads as "resource missing" sends the operator
# hunting in the wrong place — so every check distinguishes the two, and
# "cannot verify" is its own failure, never a pass.
AWS_OUT=""
AWS_ERR=""
aws_try() { # 0 = ok · 1 = absent/other error · 2 = denied · 3 = CLI too old
  local errfile rc=0
  errfile="$(mktemp)"
  AWS_OUT="$(aws "$@" 2>"${errfile}")" || rc=1
  AWS_ERR="$(cat "${errfile}")"
  rm -f "${errfile}"
  if [ "${rc}" -ne 0 ] && printf '%s' "${AWS_ERR}" | grep -qiE 'accessdenied|not authorized|unauthorizedoperation|explicit deny'; then
    return 2
  fi
  # A CLI that predates the service answers with its usage banner, not with
  # an API error — and that read as "the resource does not exist". Third
  # incarnation of the same defect: after permissions and after parsing,
  # this is the tool being too old to ask (decision 166). It cost a real
  # false negative: an EventBridge Scheduler schedule that existed, was
  # ENABLED, and was reported absent by a CLI from 2021.
  if [ "${rc}" -ne 0 ] && printf '%s' "${AWS_ERR}" | grep -qiE "argument (command|operation): Invalid choice|Invalid choice, valid choices are"; then
    return 3
  fi
  return "${rc}"
}

# Run a check whose "absent" and "denied" outcomes read differently.
# usage: probe "<label>" <aws args…>; then inspect $AWS_OUT on success.
probe() {
  local label="$1"; shift
  local rc=0
  aws_try "$@" || rc=$?
  case "${rc}" in
    0) return 0 ;;
    2) bad "cannot verify ${label} — the credentials lack the permission"
       note "$(printf '%s' "${AWS_ERR}" | head -1)"
       return 2 ;;
    3) bad "cannot verify ${label} — this aws CLI is too old to know that service"
       note "installed: $(aws --version 2>&1 | head -1) — upgrade and re-run"
       return 3 ;;
    *) bad "${label}: absent or unreadable"
       note "$(printf '%s' "${AWS_ERR}" | head -1)"
       return 1 ;;
  esac
}

# python3, never jq (repo convention). Reads JSON on stdin, prints the
# expression's value.
#
# A failing expression must NOT look like an empty answer: swallowing the
# exception is how a KeyError became "the certificate does not exist" and
# "every lifecycle rule is scoped". stdout stays empty so callers behave,
# but the reason goes to stderr where it is impossible to miss.
jget() {
  python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print($1)
except Exception as err:
    print('  jget failed — ' + type(err).__name__ + ': ' + str(err), file=sys.stderr)
"
}

# ════════════════════════════════════════════════════════════════════════════
# GATE — exactly what the CD role can already see, so it adds NO permission
# and can run on every deploy.
#
# No DescribeClusters on purpose: describe-services against a missing
# cluster already answers ClusterNotFoundException, so cluster existence is
# inferred for free — and requiring a permission the role does not have
# would block every deploy until infra granted it.
# ════════════════════════════════════════════════════════════════════════════
gate() {
  local cluster services_json
  cluster="$(name_base)"

  sect "gate · ${CLIENT_NAME} (${ENVIRONMENT}) · cluster ${cluster}"

  probe "cluster ${cluster} / its services" \
    ecs describe-services --cluster "${cluster}" \
    --services "$(name_service api)" "$(name_service connector)" "$(name_service scheduler)" \
    --output json || return
  services_json="${AWS_OUT}"

  local missing
  missing="$(printf '%s' "${services_json}" | jget "','.join(f['arn'].split('/')[-1] for f in d.get('failures',[]))")"
  if [ -n "${missing}" ]; then
    bad "services not found on ${cluster}: ${missing}"
    note "infra creates the services; the pipeline only rolls them"
  fi

  # ── per-service properties ────────────────────────────────────────────────
  local svc status minp maxp desired
  for svc in api connector scheduler; do
    local name; name="$(name_service "${svc}")"
    status="$(printf '%s' "${services_json}" | jget "next((s['status'] for s in d['services'] if s['serviceName']=='${name}'),'')")"
    [ "${status}" = "ACTIVE" ] || { bad "service ${name} is '${status:-absent}', not ACTIVE"; continue; }
    ok "service ${name} ACTIVE"
  done

  # THE data-corruption check. The sync watermark has no lease: two live
  # connectors read the same window and every trace in it is counted twice,
  # in the permanent archive, with no error anywhere. Same for the
  # scheduler — a reopened month must never race two closers. AWS's own
  # defaults (100/200, i.e. start-new-before-stopping-old) produce exactly
  # that overlap on every single deploy.
  for svc in connector scheduler; do
    local name; name="$(name_service "${svc}")"
    minp="$(printf '%s' "${services_json}" | jget "next((str(s['deploymentConfiguration']['minimumHealthyPercent']) for s in d['services'] if s['serviceName']=='${name}'),'?')")"
    maxp="$(printf '%s' "${services_json}" | jget "next((str(s['deploymentConfiguration']['maximumPercent']) for s in d['services'] if s['serviceName']=='${name}'),'?')")"
    desired="$(printf '%s' "${services_json}" | jget "next((str(s['desiredCount']) for s in d['services'] if s['serviceName']=='${name}'),'?')")"

    # A service that does not exist was already reported above; repeating
    # the singleton lecture for it would bury the one line that matters.
    [ "${desired}" = "?" ] && continue

    if [ "${minp}/${maxp}" = "0/100" ]; then
      ok "${name} is a strict singleton on deploy (min 0 / max 100)"
    else
      bad "${name} deploys at ${minp}/${maxp} — MUST be 0/100"
      note "at 100/200 the old task and the new one both run: two writers on a watermark that has no lease"
      note "the traces they double-read are counted twice in the permanent archive, silently"
    fi

    if [ "${desired}" = "1" ]; then
      ok "${name} desiredCount = 1"
    else
      bad "${name} desiredCount = ${desired} — MUST be 1"
      note "worse than a bad deploy config: this is two permanent writers, not a seconds-long overlap"
    fi
  done

  # A rolled deploy whose tasks never pass the ALB health check must roll
  # back on its own; without this, a broken image sits half-deployed.
  local cb_enable cb_rollback
  cb_enable="$(printf '%s' "${services_json}" | jget "next((str(s['deploymentConfiguration'].get('deploymentCircuitBreaker',{}).get('enable')) for s in d['services'] if s['serviceName']=='$(name_service api)'),'?')")"
  cb_rollback="$(printf '%s' "${services_json}" | jget "next((str(s['deploymentConfiguration'].get('deploymentCircuitBreaker',{}).get('rollback')) for s in d['services'] if s['serviceName']=='$(name_service api)'),'?')")"
  if [ "${cb_enable}" = "True" ] && [ "${cb_rollback}" = "True" ]; then
    ok "api deployment circuit breaker enabled with rollback"
  else
    bad "api circuit breaker is enable=${cb_enable} rollback=${cb_rollback} — both must be true"
  fi

  local tg_count
  tg_count="$(printf '%s' "${services_json}" | jget "next((str(len(s.get('loadBalancers',[]))) for s in d['services'] if s['serviceName']=='$(name_service api)'),'0')")"
  if [ "${tg_count}" = "0" ]; then
    bad "api service has no target group attached — the ALB has nothing to send to"
  else
    ok "api service is attached to a target group"
  fi

  # deploy-tenant borrows the connector's networkConfiguration for the
  # migrations one-off; without it the gate step cannot run at all.
  local subnets
  subnets="$(printf '%s' "${services_json}" | jget "next((str(len(s.get('networkConfiguration',{}).get('awsvpcConfiguration',{}).get('subnets',[]))) for s in d['services'] if s['serviceName']=='$(name_service connector)'),'0')")"
  if [ "${subnets}" = "0" ]; then
    bad "connector service has no networkConfiguration — the migrations one-off has no network to borrow"
  else
    ok "connector networkConfiguration present (${subnets} subnets)"
  fi

  # All four families must be registrable/ACTIVE before a deploy starts —
  # otherwise the deploy dies halfway with some families rolled and others
  # not, which is the worst state to debug.
  local family
  for family in api connector scheduler backup; do
    local fname; fname="$(name_service "${family}")"
    if probe "task-definition family ${fname}" ecs describe-task-definition --task-definition "${fname}" --output json; then
      local fstatus; fstatus="$(printf '%s' "${AWS_OUT}" | jget "d['taskDefinition']['status']")"
      if [ "${fstatus}" = "ACTIVE" ]; then ok "family ${fname} has an ACTIVE revision"
      else bad "family ${fname} latest revision is ${fstatus}"; fi
    fi
  done
}

# ════════════════════════════════════════════════════════════════════════════
# FULL AUDIT
# ════════════════════════════════════════════════════════════════════════════

audit_ecr() {
  sect "ECR"
  local image repo
  for image in module connector db-backup; do
    repo="$(ecr_repo "${image}")"
    probe "ECR repo ${repo}" ecr describe-repositories --repository-names "${repo}" --output json || continue
    local mutability scan
    mutability="$(printf '%s' "${AWS_OUT}" | jget "d['repositories'][0]['imageTagMutability']")"
    scan="$(printf '%s' "${AWS_OUT}" | jget "str(d['repositories'][0].get('imageScanningConfiguration',{}).get('scanOnPush'))")"
    if [ "${mutability}" = "IMMUTABLE" ]; then ok "${repo} tags are IMMUTABLE"
    else bad "${repo} tags are ${mutability} — a re-pushed SHA makes 'rollback = redeploy an older SHA' a lie"; fi
    [ "${scan}" = "True" ] && ok "${repo} scanOnPush" || warn "${repo} has no scanOnPush"
  done

  # The rollback horizon of this account: no SHA is ever backfilled into a
  # new account, so it starts at the account's join date. Printed so it is
  # a known property rather than a discovery mid-incident.
  if aws_try ecr list-images --repository-name "$(ecr_repo module)" --filter tagStatus=TAGGED --output json; then
    local count
    count="$(printf '%s' "${AWS_OUT}" | jget "len(d.get('imageIds',[]))")"
    note "deployable SHAs in $(ecr_repo module): ${count} (rollback horizon starts at this account's onboarding — nothing is backfilled)"
  fi
}

audit_s3() {
  sect "S3 backups bucket"
  local bucket; bucket="$(bucket_backups)"

  probe "bucket ${bucket}" s3api get-bucket-versioning --bucket "${bucket}" --output json || return
  [ "$(printf '%s' "${AWS_OUT}" | jget "d.get('Status','')")" = "Enabled" ] \
    && ok "${bucket} versioning enabled" \
    || bad "${bucket} versioning is not Enabled"

  if probe "public access block on ${bucket}" s3api get-public-access-block --bucket "${bucket}" --output json; then
    local blocked
    blocked="$(printf '%s' "${AWS_OUT}" | jget "str(all(d['PublicAccessBlockConfiguration'].values()))")"
    [ "${blocked}" = "True" ] && ok "all four public-access blocks on" || bad "not all public-access blocks are on"
  fi

  # THE chain that bricks a tenant: an unfiltered lifecycle rule also ages
  # out config/, the LangWatch box re-fetches config/ on EVERY service
  # start, and the box then never boots again — days after the rule was
  # written, with nothing linking cause to effect.
  if probe "lifecycle configuration on ${bucket}" s3api get-bucket-lifecycle-configuration --bucket "${bucket}" --output json; then
    local unfiltered
    unfiltered="$(printf '%s' "${AWS_OUT}" | jget "','.join(r.get('ID','<unnamed rule>') for r in d['Rules'] if r.get('Status')=='Enabled' and not (r.get('Filter',{}) or {}).get('Prefix'))")"
    if [ -n "${unfiltered}" ]; then
      bad "lifecycle rule(s) not scoped to a prefix: ${unfiltered}"
      note "an unfiltered rule also expires config/<client>/ — which the LangWatch box refetches on every start, so the box stops booting"
    else
      ok "every enabled lifecycle rule is scoped to a prefix"
    fi
  fi

  # The three config objects the box boots from.
  local obj
  for obj in langwatch-compose.yml langwatch-bootstrap.sh langwatch-caddy.Caddyfile; do
    if aws_try s3api head-object --bucket "${bucket}" --key "$(s3_config_prefix)/${obj}"; then
      ok "config artifact ${obj} published"
    else
      warn "config artifact $(s3_config_prefix)/${obj} not in the bucket — run a deploy (it publishes them)"
    fi
  done
}

audit_alerts() {
  sect "Alerts"
  local topic_arn="arn:aws:sns:${TENANT_REGION}:${AWS_ACCOUNT_ID}:$(topic_alerts)"

  if probe "SNS topic $(topic_alerts)" sns get-topic-attributes --topic-arn "${topic_arn}" --output json; then
    local policy
    policy="$(printf '%s' "${AWS_OUT}" | jget "d['Attributes'].get('Policy','')")"
    printf '%s' "${policy}" | grep -q 'aws:SourceAccount' \
      && ok "topic policy is fenced with aws:SourceAccount" \
      || bad "topic policy has no aws:SourceAccount condition — any account could publish alerts into this channel"
  fi

  # An alert topic nobody is subscribed to is silence wearing a green
  # badge. Pending confirmations do not count.
  if probe "subscriptions on $(topic_alerts)" sns list-subscriptions-by-topic --topic-arn "${topic_arn}" --output json; then
    local confirmed
    confirmed="$(printf '%s' "${AWS_OUT}" | jget "sum(1 for s in d['Subscriptions'] if 'pending' not in s['SubscriptionArn'].lower())")"
    if [ "${confirmed:-0}" -gt 0 ]; then ok "${confirmed} confirmed subscription(s) on the alert topic"
    else bad "no CONFIRMED subscription on $(topic_alerts) — every alarm in this account fires into nothing"; fi
  fi

  # treat-missing-data=breaching is the whole point: the failure mode of a
  # nightly backup is NO datapoint, not a bad one.
  local alarm
  for alarm in "$(name_thing backup-missing)" "$(name_thing langwatch-queue-backlog)"; do
    if probe "alarm ${alarm}" cloudwatch describe-alarms --alarm-names "${alarm}" --output json; then
      local found tmd
      found="$(printf '%s' "${AWS_OUT}" | jget "len(d['MetricAlarms'])")"
      if [ "${found}" = "0" ]; then bad "alarm ${alarm} does not exist"; continue; fi
      tmd="$(printf '%s' "${AWS_OUT}" | jget "d['MetricAlarms'][0].get('TreatMissingData','')")"
      [ "${tmd}" = "breaching" ] \
        && ok "alarm ${alarm} treats missing data as breaching" \
        || bad "alarm ${alarm} treats missing data as '${tmd}' — silence would read as health"
    fi
  done
}

audit_config_stores() {
  sect "Config stores"

  # The tenant file carries the secret ARNs because Secrets Manager appends
  # a random 6-char suffix that cannot be computed (decision 150). Declared
  # values drift; this is where that drift is caught.
  local family declared live
  for family in mongo langwatch; do
    case "${family}" in
      mongo) declared="$(tget MONGO_SECRET_ARN)" ;;
      langwatch) declared="$(tget LANGWATCH_SECRET_ARN)" ;;
    esac
    if probe "secret $(secret_id "${family}")" secretsmanager describe-secret --secret-id "$(secret_id "${family}")" --output json; then
      live="$(printf '%s' "${AWS_OUT}" | jget "d['ARN']")"
      if [ "${live}" = "${declared}" ]; then
        ok "secret $(secret_id "${family}") exists and its ARN matches the tenant file"
      else
        bad "tenant file's ARN for ${family} does not match the live secret"
        note "declared: ${declared:-<empty>}"
        note "live:     ${live}"
      fi
    fi
  done

  local param
  for param in langwatch-project-id langwatch-capacity; do
    probe "SSM parameter $(ssm_param "${param}")" ssm get-parameter --name "$(ssm_param "${param}")" --output json \
      && ok "SSM $(ssm_param "${param}") exists"
  done

  local svc
  for svc in api connector scheduler backup; do
    local lg; lg="$(log_group "${svc}")"
    if probe "log group ${lg}" logs describe-log-groups --log-group-name-prefix "${lg}" --output json; then
      local exact retention
      exact="$(printf '%s' "${AWS_OUT}" | jget "str(any(g['logGroupName']=='${lg}' for g in d['logGroups']))")"
      if [ "${exact}" != "True" ]; then
        bad "log group ${lg} does not exist"
        note "a task definition naming a missing log group fails to START, with an error that points at the task, not the group"
        continue
      fi
      retention="$(printf '%s' "${AWS_OUT}" | jget "next((str(g.get('retentionInDays','never')) for g in d['logGroups'] if g['logGroupName']=='${lg}'),'')")"
      ok "log group ${lg} (retention: ${retention} days)"
    fi
  done
}

# Secret KEY presence. Operator credentials ONLY — the audit role has no
# GetSecretValue by design, and the fleet run skips this whole function.
# The value is read to test the key and never printed, never kept.
audit_secret_keys() {
  sect "Secret keys (values are read to test presence, never printed)"
  set +x
  local family keys key blob missing
  for family in mongo langwatch; do
    case "${family}" in
      mongo) keys="MONGO_DB_HOST MONGO_DB_USER MONGO_DB_PASSWORD" ;;
      langwatch) keys="LANGWATCH_NEXTAUTH_SECRET LANGWATCH_API_TOKEN_JWT_SECRET LANGWATCH_CREDENTIALS_SECRET LANGWATCH_CLICKHOUSE_PASSWORD" ;;
    esac
    if ! probe "secret value of $(secret_id "${family}")" secretsmanager get-secret-value --secret-id "$(secret_id "${family}")" --query SecretString --output text; then
      continue
    fi
    blob="${AWS_OUT}"
    missing=""
    for key in ${keys}; do
      # Only the NAME of a missing/blank key is ever printed.
      if [ "$(printf '%s' "${blob}" | jget "str(bool((d.get('${key}') or '').strip()))")" != "True" ]; then
        missing="${missing} ${key}"
      fi
    done
    blob=""
    if [ -n "${missing}" ]; then
      bad "$(secret_id "${family}") is missing or blank:${missing}"
    else
      ok "$(secret_id "${family}") has every expected key filled"
    fi
  done
  note "LANGWATCH_CREDENTIALS_SECRET must NEVER be rotated after first boot — stored credentials become undecryptable"
}

audit_network_edge() {
  sect "Network and edge"

  # NEVER filter by CIDR: tenant VPCs deliberately share 10.80.0.0/16
  # (decision 142), so a CIDR filter silently returns another tenant's
  # network. Name tag is the only safe selector here.
  # The network is CLIENT level (decision 167). hapvida was built before that
  # and still carries the component in its tags, so both spellings are
  # accepted until those tags are corrected — a tag rename is free, but it is
  # not this script's job to force the window.
  if probe "VPC $(name_client vpc)" ec2 describe-vpcs \
      --filters "Name=tag:Name,Values=$(name_client vpc),$(name_base)-vpc" --output json; then
    local vpc_id vpc_name
    vpc_id="$(printf '%s' "${AWS_OUT}" | jget "d['Vpcs'][0]['VpcId'] if d['Vpcs'] else ''")"
    vpc_name="$(printf '%s' "${AWS_OUT}" | jget "next((t['Value'] for v in d['Vpcs'] for t in v.get('Tags',[]) if t['Key']=='Name'),'')")"
    if [ "${vpc_name}" = "$(name_base)-vpc" ]; then
      warn "VPC is tagged ${vpc_name} — the network belongs to the CLIENT, not to a component (decision 167)"
      note "rename the Name tag to $(name_client vpc); tags are free to change, unlike SG and ALB names"
    fi
    if [ -z "${vpc_id}" ]; then
      bad "no VPC tagged Name=$(name_client vpc)"
    else
      ok "VPC ${vpc_id}"
      # The tenant's stable egress address — what the client's Atlas
      # network-access allowlist admits.
      if aws_try ec2 describe-nat-gateways --filter "Name=vpc-id,Values=${vpc_id}" "Name=state,Values=available" --output json; then
        local eip
        eip="$(printf '%s' "${AWS_OUT}" | jget "','.join(a['PublicIp'] for g in d['NatGateways'] for a in g['NatGatewayAddresses'] if a.get('PublicIp'))")"
        [ -n "${eip}" ] && note "NAT egress IP (the Atlas allowlist address): ${eip}" || warn "no NAT gateway in ${vpc_id}"
      fi
    fi
  fi

  # Same story for the ALB — client level now, but its name is immutable, so
  # hapvida keeps the old one until someone chooses to recreate it.
  local alb_arn="" alb_name
  alb_name="$(name_client_base)"
  aws_try elbv2 describe-load-balancers --names "${alb_name}" --output json || alb_name="$(name_base)"
  if probe "ALB ${alb_name}" elbv2 describe-load-balancers --names "${alb_name}" --output json; then
    alb_arn="$(printf '%s' "${AWS_OUT}" | jget "d['LoadBalancers'][0]['LoadBalancerArn']")"
    ok "ALB ${alb_name} — $(printf '%s' "${AWS_OUT}" | jget "d['LoadBalancers'][0]['DNSName']")"
  fi

  if [ -n "${alb_arn}" ] && probe "listeners on $(name_base)" elbv2 describe-listeners --load-balancer-arn "${alb_arn}" --output json; then
    local listeners="${AWS_OUT}" has443 default_404
    has443="$(printf '%s' "${listeners}" | jget "str(any(l['Port']==443 for l in d['Listeners']))")"
    if [ "${has443}" = "True" ]; then
      ok "HTTPS listener present"
      # An ALB whose default action forwards instead of 404ing will answer
      # a request for ANY host with some tenant's app.
      default_404="$(printf '%s' "${listeners}" | jget "str(any(l['Port']==443 and l['DefaultActions'][0]['Type']=='fixed-response' for l in d['Listeners']))")"
      [ "${default_404}" = "True" ] \
        && ok "the :443 default action is a fixed response, not a forward" \
        || bad "the :443 default action is not a fixed response — an unknown Host reaches an app instead of a 404"
    else
      warn "no :443 listener yet — the certificate exists but nothing serves TLS"
    fi
    printf '%s' "${listeners}" | grep -q '"Port": 80' && ok "HTTP :80 listener present (redirect)" || warn "no :80 listener"
  fi

  local tg
  for tg in "$(name_service api):/api/v1/docs" "$(name_service lw):/"; do
    local tg_name="${tg%%:*}" want_path="${tg##*:}"
    if probe "target group ${tg_name}" elbv2 describe-target-groups --names "${tg_name}" --output json; then
      local got_path
      got_path="$(printf '%s' "${AWS_OUT}" | jget "d['TargetGroups'][0].get('HealthCheckPath','')")"
      if [ "${got_path}" = "${want_path}" ]; then
        ok "target group ${tg_name} health check ${got_path}"
      else
        bad "target group ${tg_name} health check is '${got_path}', expected '${want_path}'"
        [ "${tg_name}" = "$(name_service api)" ] && note "/api/v1/docs is the one route that stays open with session auth on (decision 103); any other path 401s and targets never go healthy"
      fi
    fi
  done

  # PENDING_VALIDATION is a STATE, not a failure: an externally-held zone
  # means someone else pastes the CNAME, and onboarding parks here for days.
  #
  # Two calls on purpose. list-certificates returns a SUMMARY — on some CLI
  # versions nothing but the ARN and the domain — so reading Status off it
  # raised KeyError, which the checker turned into "no certificate exists".
  # A lookup failure read as an absence is the exact mistake the
  # AccessDenied discipline exists to prevent, so the status now comes from
  # describe-certificate, where the API contract guarantees it.
  if aws_try acm list-certificates --output json; then
    local cert_arn cert_status
    cert_arn="$(printf '%s' "${AWS_OUT}" | jget "next((c['CertificateArn'] for c in d['CertificateSummaryList'] if c.get('DomainName') in ('*.${BASE_DOMAIN}','${BASE_DOMAIN}')),'')")"
    if [ -z "${cert_arn}" ]; then
      bad "no ACM certificate covering ${BASE_DOMAIN} in ${TENANT_REGION}"
    elif probe "certificate ${cert_arn##*/}" acm describe-certificate --certificate-arn "${cert_arn}" --output json; then
      cert_status="$(printf '%s' "${AWS_OUT}" | jget "d['Certificate']['Status']")"
      case "${cert_status}" in
        ISSUED)
          ok "certificate for *.${BASE_DOMAIN} ISSUED"
          note "${cert_arn}"
          ;;
        PENDING_VALIDATION)
          warn "certificate for *.${BASE_DOMAIN} is PENDING_VALIDATION — waiting on the DNS owner, not broken"
          ;;
        *) bad "certificate for *.${BASE_DOMAIN} is ${cert_status}" ;;
      esac
    fi
  fi
}

audit_workloads() {
  sect "Workload configuration"

  # Autoscaling on a singleton is the same double-write bug with a
  # different trigger — and it has no data source in Terraform at all.
  if probe "autoscaling targets" application-autoscaling describe-scalable-targets --service-namespace ecs --output json; then
    local scaled svc
    scaled="${AWS_OUT}"
    for svc in connector scheduler; do
      if printf '%s' "${scaled}" | grep -q "service/$(name_base)/$(name_service "${svc}")"; then
        bad "$(name_service "${svc}") has an autoscaling target — a scale-out puts a second writer on the watermark"
      else
        ok "$(name_service "${svc}") has no autoscaling target"
      fi
    done
    printf '%s' "${scaled}" | grep -q "service/$(name_base)/$(name_service api)" \
      && ok "api has an autoscaling target" \
      || warn "api has no autoscaling target — it will never scale past its desired count"
  fi

  # The schedule must point at the REVISION-LESS ARN so a deploy's image
  # bump takes effect without touching the schedule.
  if probe "backup schedule $(name_thing backup)" scheduler get-schedule --name "$(name_thing backup)" --output json; then
    local td_arn state
    td_arn="$(printf '%s' "${AWS_OUT}" | jget "d['Target']['EcsParameters']['TaskDefinitionArn']")"
    state="$(printf '%s' "${AWS_OUT}" | jget "d['State']")"
    [ "${state}" = "ENABLED" ] && ok "backup schedule ENABLED" || bad "backup schedule is ${state}"
    if printf '%s' "${td_arn}" | grep -qE ':[0-9]+$'; then
      bad "backup schedule targets a PINNED revision (${td_arn##*/}) — it will keep running an old image forever"
    else
      ok "backup schedule targets the revision-less family ARN"
    fi
  fi

  probe "backup-failed rule $(name_thing backup-failed)" events describe-rule --name "$(name_thing backup-failed)" --output json \
    && ok "backup-failed EventBridge rule exists"

  # On Atlas M10 the Cloud Backup is primary (decision 145) and this dump
  # is the second copy; either way a snapshot policy that is DISABLED is a
  # backup nobody takes.
  if aws_try dlm get-lifecycle-policies --output json; then
    local dlm_state
    dlm_state="$(printf '%s' "${AWS_OUT}" | jget "next((p['State'] for p in d['Policies'] if '$(name_base)' in p.get('Description','')),'')")"
    case "${dlm_state}" in
      ENABLED) ok "DLM snapshot policy ENABLED" ;;
      "") warn "no DLM policy mentioning $(name_base) (the LangWatch volume has no snapshots)" ;;
      *) bad "DLM policy is ${dlm_state}" ;;
    esac
  fi
}

# The zone may not be in this account, or in AWS at all (decision 159), so
# the only portable check is the one a client's browser makes: does the
# hostname resolve to this tenant's load balancer? Uses the resolver, not
# any AWS API, so it works whoever hosts the zone.
audit_dns() {
  sect "Public DNS"
  local alb_dns host
  if ! aws_try elbv2 describe-load-balancers --names "$(name_base)" --query 'LoadBalancers[0].DNSName' --output text; then
    warn "no ALB to compare the hostnames against"
    return
  fi
  alb_dns="${AWS_OUT}"

  for host in "$(hostname_api)" "$(hostname_langwatch)"; do
    local verdict
    verdict="$(HOST="${host}" ALB="${alb_dns}" python3 - <<'PY'
import os, socket
def ips(name):
    try:
        return {r[4][0] for r in socket.getaddrinfo(name, None)}
    except OSError:
        return set()
host, alb = ips(os.environ["HOST"]), ips(os.environ["ALB"])
if not host:
    print("unresolved")
elif host & alb:
    print("ok")
else:
    print("elsewhere " + ",".join(sorted(host)[:3]))
PY
)"
    case "${verdict}" in
      ok) ok "${host} resolves to this tenant's load balancer" ;;
      unresolved)
        bad "${host} does not resolve"
        note "the record is created by whoever holds the zone — with an external DNS provider it is a CNAME to ${alb_dns}, not an A-alias"
        ;;
      *)
        warn "${host} resolves to ${verdict#elsewhere }, not to the ALB"
        note "expected once a proxy/CDN sits in front (Cloudflare orange-cloud); a defect otherwise"
        ;;
    esac
  done
}

# What is deployed is a question ECS answers with authority: the latest
# revision carries the image tag. The tenant file used to carry it too and
# preflight warned when the two diverged — which made a PR mandatory after
# every deploy, and guaranteed the drift it was warning about, because
# people forget. Two sources for one fact always diverge; that is the same
# argument that removed Terraform (decision 165). The tenant file's
# IMAGE_SHA is now only a seed for the first --register-only, when no task
# definition exists yet to be asked.
audit_image_sha() {
  sect "Deployed image"
  local family
  for family in api connector scheduler backup; do
    if probe "task definition $(name_service "${family}")" ecs describe-task-definition --task-definition "$(name_service "${family}")" --output json; then
      local image revision
      image="$(printf '%s' "${AWS_OUT}" | jget "d['taskDefinition']['containerDefinitions'][0]['image'].rsplit(':',1)[-1]")"
      revision="$(printf '%s' "${AWS_OUT}" | jget "str(d['taskDefinition']['revision'])")"
      ok "${family} revision ${revision} runs ${image:0:12}"
    fi
  done
}

# ════════════════════════════════════════════════════════════════════════════
# FLEET — every tenant, through its read-only audit role. A read path only:
# no cross-account publish, no shared write dependency.
#
# The audit role is trusted by the GitHub OIDC provider and by NOTHING ELSE
# (decision 159): with one account per client there is no hub account to
# assume from, and `sts assume-role` is refused by the trust policy no
# matter what the caller is allowed to do. So the fleet run exchanges ONE
# web-identity token per account, exactly as ecr-push-fleet.sh does for the
# push role. There is no bootstrap role and no FLEET_HEARTBEAT_ROLE_ARN.
#
# Run by an operator instead of by CI there is no token, so the only honest
# thing is to audit the account the current credentials are already in, and
# refuse the rest by name rather than reporting them green.
# ════════════════════════════════════════════════════════════════════════════
fleet_token() {
  [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || return 1
  local value
  value="$(curl -sS -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=sts.amazonaws.com" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])' 2>/dev/null)"
  [ -n "${value}" ] || return 1
  FLEET_TOKEN_FILE="$(mktemp)"
  printf '%s' "${value}" > "${FLEET_TOKEN_FILE}"
  chmod 600 "${FLEET_TOKEN_FILE}"
  return 0
}

fleet() {
  local digest="" total=0 failing=0 file client
  FLEET_TOKEN_FILE=""
  fleet_token || true
  # shellcheck disable=SC2064
  trap "rm -f '${FLEET_TOKEN_FILE:-/nonexistent}'" EXIT

  local caller_account=""
  if [ -z "${FLEET_TOKEN_FILE}" ]; then
    caller_account="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
  fi

  for file in "${TENANT_DIR}"/*.env; do
    [ -e "${file}" ] || { echo "no tenant files in ${TENANT_DIR}" >&2; exit 1; }
    client="$(basename "${file}" .env)"
    [ "${client}" = "example" ] && continue
    total=$((total + 1))

    ( # subshell: per-account credentials must not leak into the next tenant
      tenant_load "${client}"
      export AWS_REGION="${TENANT_REGION}"
      if [ -n "${FLEET_TOKEN_FILE}" ]; then
        set +u
        unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
        set -u
        export AWS_ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/$(name_role audit)"
        export AWS_WEB_IDENTITY_TOKEN_FILE="${FLEET_TOKEN_FILE}"
        export AWS_ROLE_SESSION_NAME="fleet-heartbeat-${client}"
      elif [ "${caller_account}" != "${AWS_ACCOUNT_ID}" ]; then
        echo "cannot audit ${client}: no GitHub OIDC token, and the current credentials are in account ${caller_account:-<unknown>}, not ${AWS_ACCOUNT_ID}" >&2
        exit 1
      fi
      # NO_SECRET_KEYS: the audit role has no GetSecretValue on purpose —
      # the fleet run checks that secrets EXIST, never their keys.
      NO_SECRET_KEYS=1 exec bash "${HERE}/preflight-aws.sh" "${client}"
    ) > "/tmp/fleet-${client}.$$" 2>&1
    local rc=$?

    if [ "${rc}" -eq 0 ]; then
      digest="${digest}
:white_check_mark: ${client} — green"
    else
      failing=$((failing + 1))
      local reasons
      reasons="$(grep -E '^  ✖' "/tmp/fleet-${client}.$$" | sed 's/^  ✖ //' | head -5 | tr '\n' ';')"
      # A run that died before any check (bad credentials, unreachable
      # account) must say WHY, not report an empty failure.
      [ -n "${reasons}" ] || reasons="$(head -2 "/tmp/fleet-${client}.$$" | tr '\n' ' ')"
      digest="${digest}
:x: ${client} — ${reasons:-run failed before any check}"
    fi
    cat "/tmp/fleet-${client}.$$"
    rm -f "/tmp/fleet-${client}.$$"
  done

  local header="fleet heartbeat — ${total} account(s), ${failing} failing"
  printf '\n%s\n%s\n' "${header}" "${digest}"

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { printf '## %s\n' "${header}"; printf '%s\n' "${digest}"; } >> "${GITHUB_STEP_SUMMARY}"
  fi

  # Fail-fast, decision 139 style: a heartbeat that cannot reach anyone is
  # exactly the silence it exists to prevent. Missing webhook = red run.
  if [ -z "${FLEET_HEARTBEAT_SLACK_WEBHOOK:-}" ]; then
    echo "FLEET_HEARTBEAT_SLACK_WEBHOOK is not set — the heartbeat has nowhere to report" >&2
    exit 1
  fi
  HEADER="${header}" DIGEST="${digest}" python3 -c '
import json, os, urllib.request
body = json.dumps({"text": os.environ["HEADER"] + "\n" + os.environ["DIGEST"]}).encode()
req = urllib.request.Request(os.environ["FLEET_HEARTBEAT_SLACK_WEBHOOK"], data=body,
                             headers={"Content-Type": "application/json"})
urllib.request.urlopen(req, timeout=20).read()
' || { echo "posting the digest to Slack failed" >&2; exit 1; }

  [ "${failing}" -eq 0 ] || exit 1
  exit 0
}

# ════════════════════════════════════════════════════════════════════════════

MODE="full"
case "${1:-}" in
  --gate) MODE="gate"; shift ;;
  --fleet) MODE="fleet"; shift ;;
  -h | --help)
    sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
    exit 0
    ;;
esac

if [ "${MODE}" = "fleet" ]; then
  fleet
fi

CLIENT="${1:?usage: preflight-aws.sh [--gate] <client> | preflight-aws.sh --fleet}"
tenant_load "${CLIENT}"

# The region comes from the tenant file, not from the ambient profile: an
# audit that silently reads another region reports green on nothing. Same
# for the account — khal-* names are scoped by client and env but not by
# account, so the wrong profile reports every resource as absent.
export AWS_REGION="${TENANT_REGION}"
assert_account

if [ "${MODE}" = "gate" ]; then
  gate
else
  printf '%spreflight · %s · %s · account %s · %s%s\n' \
    "${C_B}" "${CLIENT_NAME}" "${ENVIRONMENT}" "${AWS_ACCOUNT_ID}" "${TENANT_REGION}" "${C_R}"
  gate
  audit_ecr
  audit_s3
  audit_alerts
  audit_config_stores
  [ -n "${NO_SECRET_KEYS:-}" ] || audit_secret_keys
  audit_network_edge
  audit_dns
  audit_workloads
  audit_image_sha
fi

printf '\n'
if [ "${FAILURES}" -eq 0 ]; then
  printf '%s✔%s preflight: %d check(s) failed, %d warning(s)\n' "${C_OK}" "${C_R}" "${FAILURES}" "${WARNINGS}"
  exit 0
fi
printf '%s✖%s preflight: %d check(s) failed, %d warning(s)\n' "${C_BAD}" "${C_R}" "${FAILURES}" "${WARNINGS}"
exit 1
