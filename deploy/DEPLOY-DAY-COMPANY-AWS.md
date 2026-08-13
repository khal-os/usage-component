# Deploy day — company AWS account (one-shot runbook)

Goal: stand up the usage-component tenant factory (decision 140) in
Namastex's AWS account and deploy **namastex** as tenant #1, reusing the
existing Atlas M0 database `usage_db`. Everything below is a replay of
what was already validated on 2026-08-10 in a personal account — the
gotchas are marked ⚠ so nothing gets rediscovered the hard way.

Permanent ops reference: `deploy/RUNBOOK-AWS.md`. This file is the
one-shot bootstrap order.

---

## 0 · Bring to the table (decisions & access)

- [ ] **Company AWS credentials** with admin (or IAM+VPC+ECS+EC2+Route53+
      ACM+S3+SNS+Scheduler+SecretsManager+SSM rights). SSO session creds
      work but expire mid-day — an IAM user for terraform is steadier.
- [ ] **Region** (previous run: `us-east-1`).
- [ ] **State bucket name** (previous run pattern:
      `namastex-usage-tfstate-<account-id>`).
- [ ] **Domain decision** — one of:
      a. company domain subdomain (e.g. `usage.namastex.ai`): needs whoever
         controls the company DNS to paste ONE NS record set (values come
         out of step 4);
      b. transfer `khal-usage.com` from Matheus's personal account 648426765611
         (`aws route53domains transfer-domain-to-another-aws-account`);
      c. keep `khal-usage.com` registered in the personal account and just
         recreate its ZONE in the company account, then point the domain's
         nameservers at it (fastest, fine for the presentation).
- [ ] Atlas M0 credentials — already known: host
      `platformkhal.pkr8kc.mongodb.net`, user `namastex_machine_db_user`,
      db `usage_db`; password readable on the Hetzner VM:
      `ssh root@87.99.156.174 "grep MONGO /opt/usage-billing-component/clients/namastex.env"`
      (Atlas network access is 0.0.0.0/0 — no allowlist step needed).
- [ ] ⚠ The `khal-usage.com` ICANN verification email (matheus.martino@)
      must be clicked regardless, or the domain suspends ~15 days after
      registration.

## 1 · Credentials on the laptop

```bash
aws configure --profile company        # or paste SSO creds into ~/.aws/credentials
export AWS_PROFILE=company AWS_DEFAULT_REGION=<region>
aws sts get-caller-identity            # confirm the RIGHT account id
```

⚠ Terraform ≥ 1.10 required (`use_lockfile`) — `~/.local/bin/terraform`
is 1.12.2: `export PATH=$PATH:~/.local/bin`.

## 2 · Bootstrap the state bucket (once, by hand)

```bash
aws s3api create-bucket --bucket <state-bucket> --region <region> \
  $([ "<region>" != "us-east-1" ] && echo --create-bucket-configuration LocationConstraint=<region>)
aws s3api put-bucket-versioning --bucket <state-bucket> --versioning-configuration Status=Enabled
aws s3api put-public-access-block --bucket <state-bucket> --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

## 3 · Foundation apply

```bash
cd deploy/terraform/foundation
cp backend.hcl.example backend.hcl     # bucket=<state-bucket>, key unchanged, region=<region>
terraform init -backend-config=backend.hcl
terraform apply -var region=<region> -var base_domain=<domain>
```

- Creates (decision 142 — NO network here, each tenant builds its own
  VPC/NAT/ALB): ECS cluster `usage-main`, 3 ECR repos, wildcard ACM cert,
  Route53 zone, backups bucket, `usage-alerts` SNS, CI role.
- ⚠ The apply BLOCKS on cert validation until DNS delegation (step 4) is
  live — start it, do step 4 while it waits.
- ⚠ If an apply is ever killed: delete the stale
  `.tflock` object in the state bucket, re-plan, and `terraform import`
  any orphan the plan says "already exists" for (happened once with the ALB).
- Note outputs: `github_ci_role_arn`, `route53_name_servers`,
  `alerts_topic_arn`. (`nat_egress_ip` is now a TENANT output — per-client
  egress, decision 142.)

## 4 · Wire the domain

- Option (a) company subdomain: hand `route53_name_servers` (4 values) to
  the DNS owner → they add an NS record set named `usage` at the parent.
- Option (c) khal-usage.com zone-only: from the PERSONAL account run
  `aws route53domains update-domain-nameservers --region us-east-1 \
   --domain-name khal-usage.com --nameservers Name=<ns1> ... Name=<ns4>`
  with the company zone's NS values.
- Validation completes itself; foundation apply finishes.

(The TLS/404 sanity check moved to AFTER step 6 — the ALB is the
tenant's own now, decision 142.)

## 5 · Point GitHub CI at the company account

```bash
gh variable set AWS_DEPLOY_ROLE_ARN --repo khal-os/usage-component --body <github_ci_role_arn output>
gh variable set AWS_REGION --repo khal-os/usage-component --body <region>
gh workflow run build-images --repo khal-os/usage-component   # or rerun latest main run
```

- ⚠ OIDC gotcha (cost an hour): this repo's OIDC `sub` claim is
  ID-STAMPED — `repo:khal-os@273177925/usage-component@1315313963:ref:...`.
  The foundation's trust policy already accepts both spellings; if
  Assume fails anyway, compare the trust policy with
  `gh api repos/khal-os/usage-component/actions/oidc/customization/sub`.
- Wait for green; note the main SHA — it's the image tag:
  `git rev-parse origin/main`.

## 6 · Stamp tenant #1 (namastex)

```bash
cd deploy/terraform/tenant
cp backend.hcl.example backend.hcl     # key = usage-component/tenants/namastex.tfstate
# edit tenants/namastex.tfvars: state_bucket + region + image_sha=<main SHA>
terraform init -backend-config=backend.hcl
terraform apply -var-file=tenants/namastex.tfvars
```

- tfvars already sized to the cost floor (t3a.large, ~$90/mo tenant slice;
  ⚠ load-test gate deferred — MUST rerun at 1000 traces/s with upsized
  knobs before real client traffic, decision 140).
- Expected: ~65 resources (includes the tenant's OWN VPC/NAT/ALB —
  decision 142). Services crash-loop until step 7 — that is the fail-fast
  working, not a problem.
- Sanity after apply: `curl https://namastex-api.<domain>/api/v1/docs`
  (may 503 until step 8's deploy; TLS must already verify) and note the
  `nat_egress_ip` output — it is THIS client's Atlas allowlist address
  (namastex M0 is 0.0.0.0/0, so no action for tenant #1).

## 7 · Fill the tenant secret

```bash
aws secretsmanager put-secret-value --secret-id usage/namastex --secret-string '{
  "MONGO_DB_HOST": "platformkhal.pkr8kc.mongodb.net",
  "MONGO_DB_USER": "namastex_machine_db_user",
  "MONGO_DB_PASSWORD": "<from the VM env — step 0>",
  "LANGWATCH_NEXTAUTH_SECRET": "'"$(openssl rand -base64 32)"'",
  "LANGWATCH_API_TOKEN_JWT_SECRET": "'"$(openssl rand -base64 32)"'",
  "LANGWATCH_CREDENTIALS_SECRET": "'"$(openssl rand -base64 32)"'"
}'
```

- API auth is session-JWT now (khal-auth via `khal_auth_url` in tfvars) —
  no auth keys in the secret. (The deploy-day BASIC_AUTH pair was retired
  with decision 141; the old basic-auth secret is deletable.)
- ⚠ LANGWATCH_CREDENTIALS_SECRET must NEVER change after LangWatch's first boot.
- The EC2 self-heals: `langwatch-bootstrap.service` retries every 30s until
  the secret exists, then brings the stack up — no reboot, no action.

## 8 · First deploy

```bash
make aws-deploy CLIENT=namastex SHA=<main SHA>
```

Runs: task-def revisions → migrations gate → rolls api/connector/scheduler.
Connector stays in a restart loop until step 10 — expected (audit G-1).

## 9 · Prices (BEFORE traffic)

Haiku 4.5 R$/MTok (PTAX≈5.12, effective 2026-08-01) — same one-off shape
for each of the four rows (model `claude-haiku-4-5-20251001`):
input 5.12 · output 25.60 · cache_read 0.51 · cache_write 6.40.
Run via `aws ecs run-task` one-off with command
`["node","dist/main/jobs/insert-price-version.js", ...]` — exact
invocation shape in `deploy/RUNBOOK-AWS.md` §Jobs. (pending_price
self-heals if traffic beats you to it, but don't rely on it.)

## 10 · LangWatch onboarding

1. Open `https://namastex-langwatch.<domain>` → sign up (first user) →
   create the project → copy the `project_...` id from the URL.
2. ```bash
   aws ssm put-parameter --overwrite --name /usage/namastex/langwatch-project-id --value <project_id>
   aws ecs update-service --cluster usage-main --service usage-namastex-connector --force-new-deployment
   ```
3. Copy the project's API key — the martino-agent needs it with the new
   OTLP endpoint.

## 11 · Repoint the agent (Hetzner VM, stays alive)

On the VM's `/opt/martino-agent` env: OTLP endpoint →
`https://namastex-langwatch.<domain>` + the new API key from step 10;
restart the agent. From then on new traces flow into the AWS LangWatch.

## 12 · Verify (the acceptance list)

- [ ] `https://namastex-api.<domain>/api/v1/docs` answers WITHOUT auth (healthcheck, decision 103).
- [ ] `GET /api/v1/traces` answers 401 without Basic, 200 with it.
- [ ] Send one agent message → trace appears in LangWatch → connector logs
      show ingestion (`aws logs tail /usage/namastex/connector --follow`)
      → trace in `GET /traces` with a REAL R$ stamp (not pending_price).
- [ ] `GET /billing/summary` ≡ Σ stamped costs (invariant 3).
- [ ] Force a backup: `run-task` on `usage-namastex-backup` → object lands
      in `s3://usage-backups-<account>/backups/namastex/`.
- [ ] Subscribe ops email to alerts:
      `aws sns subscribe --topic-arn <alerts_topic_arn> --protocol email --notification-endpoint <email>` (+ confirm click).
- [ ] Scheduler heartbeat in `aws logs tail /usage/namastex/scheduler`.

## 13 · Afterwards (same day if possible)

- [ ] Tear down the PERSONAL account foundation (≈$1.70/day meanwhile):
      `AWS_PROFILE=usage-terraform terraform destroy` in foundation/ —
      ⚠ only AFTER the domain question is settled (the zone may be serving).
- [ ] Delete `/home/matheus/rootkey.csv` (key already deactivated).
- [ ] Commit: `tenants/namastex.tfvars`, this runbook's inevitable
      corrections, and append the "deployed to company account" decision
      row (append-decision skill).
- [ ] Hetzner usage stack: decommission whenever (Phase 5) — full VM only
      after the agent has a home.

## Known costs (cheapest configuration)

≈ $140–145/mo for tenant #1: EC2 t3a.large ~$55 · 3 Fargate tasks ~$27 ·
its own NAT ~$33 + own ALB ~$18 (decision 142) · storage/logs ~$8. The
shared foundation is now ~free (cluster/zone/bucket/topic). Each
additional tenant adds its FULL ~$140 slice — complete isolation means no
shared-network rateio. Load-test-ready sizing (t3.xlarge) adds ~$65/mo
when the gate runs.

---

## Appendix — every env var & secret: where it comes from, where it goes

### A · Deployment inputs (you supply these)

| Name | Value comes from | You put it in |
|---|---|---|
| AWS credentials (company) | company admin / SSO portal | `~/.aws/credentials` profile `company` |
| `region` | decision (prev.: us-east-1) | `backend.hcl` (both stacks) + `-var region` + tfvars |
| state bucket name | decision | `backend.hcl` (both stacks) + `state_bucket` in tfvars |
| `base_domain` | domain decision (step 0) | foundation `-var base_domain` |
| `AWS_DEPLOY_ROLE_ARN` | foundation output `github_ci_role_arn` | GitHub repo variable (`gh variable set`) |
| `AWS_REGION` | same as region | GitHub repo variable |
| `image_sha` | `git rev-parse origin/main` after build-images is green | `tenants/namastex.tfvars` |

### B · Tenant secret — ONE JSON in Secrets Manager `usage/namastex` (step 7)

| JSON key | Value comes from | Notes |
|---|---|---|
| `MONGO_DB_HOST` | `platformkhal.pkr8kc.mongodb.net` (VM env, confirmed) | Atlas M0 SRV host |
| `MONGO_DB_USER` | `namastex_machine_db_user` (VM env, confirmed) | |
| `MONGO_DB_PASSWORD` | `ssh root@87.99.156.174 "grep MONGO_DB_PASSWORD /opt/usage-billing-component/clients/namastex.env"` | never in git/tfvars |
| `LANGWATCH_NEXTAUTH_SECRET` | generate: `openssl rand -base64 32` | fresh — new LangWatch |
| `LANGWATCH_API_TOKEN_JWT_SECRET` | generate: `openssl rand -base64 32` | fresh |
| `LANGWATCH_CREDENTIALS_SECRET` | generate ONCE: `openssl rand -base64 32` | ⚠ NEVER change after LangWatch's first boot |

Who reads this secret: the api task (mongo keys), connector/
scheduler/backup tasks (mongo keys), and the LangWatch EC2's bootstrap
service (LW_ keys → regenerated `/opt/langwatch/.env` on every service
start). After EDITING the secret: `systemctl restart langwatch-bootstrap`
on the instance (via SSM) and `--force-new-deployment` the ECS services —
tasks read it at start only.

### C · Post-onboarding parameter (step 10)

| Name | Value comes from | You put it in |
|---|---|---|
| `/usage/namastex/langwatch-project-id` (SSM) | LangWatch UI → create project → `project_...` id in the URL | `aws ssm put-parameter --overwrite` + force-new-deployment of the connector |

### D · Agent side (Hetzner VM, step 11)

| Name | Value comes from | You put it in |
|---|---|---|
| OTLP endpoint | `https://namastex-langwatch.<domain>` | `/opt/martino-agent` env, then restart agent |
| `LANGWATCH_API_KEY` | LangWatch UI → project settings → API key | same VM env |

### E · Set automatically — no action, listed so nothing feels missing

| Where set | Vars |
|---|---|
| tfvars → task definitions | `CLIENT_NAME` `CLIENT_TIMEZONE` `MONGO_USAGE_DB_NAME` `MONGO_DB_ATLAS=true` `SERVER_PORT` `CORS_ALLOWED_ORIGINS` `KHAL_AUTH_URL` `KHAL_TENANT` `TRACE_INGESTION_*` `BILLING_AUTO_CLOSE_*` |
| terraform (from EC2/foundation refs) | `LANGWATCH_CLICKHOUSE_URL/USER/PASSWORD/DATABASE` (stack-internal `default`/`langwatch`) |
| tfvars → EC2 user-data → compose env | `LANGWATCH_PUBLIC_URL` + the five capacity knobs (`LANGWATCH_WORKERS_REPLICAS`, `LANGWATCH_MEMORY_LIMIT`, `LANGWATCH_REDIS_MEMORY_LIMIT`, `LANGWATCH_CLICKHOUSE_MEMORY_LIMIT`, `LANGWATCH_CLICKHOUSE_CPU_LIMIT`) |
| defaults in code | `LOG_LEVEL` (info) `LOG_FORMAT` (json) |
| session auth | `khal_auth_url` in `tenants/namastex.tfvars` → `KHAL_AUTH_URL` + `KHAL_TENANT` in the api task; empty = API open (PoC). The interim BASIC_AUTH pair (decision 141) is retired |
