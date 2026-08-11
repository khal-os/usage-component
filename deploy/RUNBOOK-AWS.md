# RUNBOOK — AWS tenant factory (decision 140)

Supersedes `RUNBOOK-VM.md` for production. The VM runbook remains only as
history of the retired Hetzner PoC. Principles that replace its rules:
**no rsync anywhere** (code = immutable ECR images; config = Secrets
Manager/SSM; deploys only change image tags — the clobber class is dead),
and **fail fast** (decision 139: capacity/identity are declared per
tenant, nothing defaults).

## Layout

- Foundation (once): `deploy/terraform/foundation` — ECS cluster
  `usage-main`, ECR, wildcard cert, Route53 zone, CI role, backups bucket,
  `usage-alerts` SNS topic. NO network (decision 142).
- Tenant (per client): `deploy/terraform/tenant` — its OWN VPC/NAT/ALB
  (complete isolation, per-client egress IP for the Atlas allowlist —
  decision 142), api/connector/scheduler Fargate services, nightly backup
  task, LangWatch EC2, secret shell, hostnames `<client>-api.<domain>` /
  `<client>-langwatch.<domain>`.

## Onboard a tenant

1. **Atlas (manual, once per client):** create project + cluster (Flex to
   start; M10+PrivateLink is the posture upgrade), a db user, and allowlist
   THIS tenant's NAT egress IP (tenant output `nat_egress_ip` — per-client,
   decision 142; available only after the tenant apply, so allowlist then).
2. **Terraform:**
   ```bash
   cd deploy/terraform/tenant
   cp backend.hcl.example backend.hcl   # key = usage-component/tenants/<client>.tfstate
   terraform init -backend-config=backend.hcl
   terraform apply -var-file=tenants/<client>.tfvars
   ```
3. **Fill the tenant secret** (value never touches git/state):
   ```bash
   aws secretsmanager put-secret-value --secret-id usage/<client> --secret-string '{
     "MONGO_DB_HOST": "<cluster>.mongodb.net",
     "MONGO_DB_USER": "...", "MONGO_DB_PASSWORD": "...",
     "LW_NEXTAUTH_SECRET": "<openssl rand -base64 32>",
     "LW_API_TOKEN_JWT_SECRET": "<openssl rand -base64 32>",
     "LW_CREDENTIALS_SECRET": "<openssl rand -base64 32 — NEVER change after first boot>",
     "BASIC_AUTH_USER": "<client slug is fine>",
     "BASIC_AUTH_PASSWORD": "<openssl rand -base64 24 — decision 141; drop the pair (and set enable_basic_auth=false) only when the KHAL quartet takes over>"
   }'
   ```
   The EC2 needs NOTHING: `langwatch-bootstrap.service` retries every 30s
   until the secret exists, then brings the stack up itself. Just force new
   deployments of the ECS services (or let the first deploy roll them).
4. **First deploy:** `make aws-deploy CLIENT=<client> SHA=<git sha>` (or the
   deploy-tenant workflow button).
5. **Prices BEFORE traffic** (pending_price self-heals, but don't rely on
   it): run the price:insert one-off — see Jobs below.
6. **LangWatch onboarding:** create the project in the LangWatch UI, then
   write the project id (the connector is in a deliberate restart loop
   until this exists — audit G-1):
   ```bash
   aws ssm put-parameter --overwrite --name /usage/<client>/langwatch-project-id --value <project_...>
   aws ecs update-service --cluster usage-main --service usage-<client>-connector --force-new-deployment
   ```
   Hand the client's agent platform the OTLP base `https://<client>-langwatch.<domain>`.
7. **Verify (the per-tenant acceptance list):** one trace flows end-to-end
   and lands STAMPED with a real R$; `GET /billing/summary` ≡ Σ stamped
   costs; a backup object appears in S3 after the next 07:00 UTC run (or
   run one now — Jobs below); the alarm fires on a forced failure.

## Deploys & rollback

```bash
make aws-deploy CLIENT=<client> SHA=<git-sha>   # migrations gate, then roll
make aws-deploy CLIENT=<client> SHA=<older-sha> # rollback = same command
```
Images are built by `build-images` on every push to main, tagged by SHA,
immutable.

## Jobs (runbook one-offs — same vocabulary, new engine)

Run any module job as a one-off task on the api task definition:
```bash
aws ecs run-task --cluster usage-main \
  --task-definition usage-<client>-api --launch-type FARGATE \
  --network-configuration "$(aws ecs describe-services --cluster usage-main \
      --services usage-<client>-connector --query 'services[0].networkConfiguration' --output json)" \
  --overrides '{"containerOverrides":[{"name":"api","command":["node","dist/main/jobs/<job>.js", "<args...>"]}]}'
```
`<job>` ∈ insert-price-version · close-billing-period · reopen-billing-period ·
reprocess-pending · rebuild-filter-counters · rebuild-session-summaries ·
run-migrations. Backup on demand: same shape with `usage-<client>-backup`
and no overrides.

## LangWatch EC2 operations

- Shell: `aws ssm start-session --target <instance-id>` (no SSH, no keys).
- Stack lives in `/opt/langwatch` (compose.yml + generated .env), driven by
  `langwatch-bootstrap.service`: on EVERY service start it re-fetches the
  compose file + bootstrap from S3, the LW secrets from Secrets Manager and
  the capacity knobs from SSM, regenerates .env, and `compose up`s. The
  .env is DISPOSABLE output — never hand-edit it as a source of truth.
- Capacity retune (incl. load-testing): edit tfvars → `terraform apply`
  (updates the SSM capacity parameter — NO instance replacement) → restart:
  `aws ssm send-command --document-name AWS-RunShellScript \
     --instance-ids <id> --parameters commands='systemctl restart langwatch-bootstrap'`
  (or reboot the instance). Secret rotation propagates the same way.
- Queue metric/alarm: `Usage/LangWatch RedisUsedMemoryPercent{Tenant}` —
  alarm at 80% for 5 min; missing data BREACHES (a dead metric was the
  original failure mode).

## Alerts

One topic: `usage-alerts`. Subscribe operators:
```bash
aws sns subscribe --topic-arn <alerts_topic_arn> --protocol email --notification-endpoint ops@namastex.ai
```
Publishers: backup-failure rules + queue alarms (tenant-tagged).

## Backups & restore

- `s3://usage-backups-<account>/<client>/<timestamp>.archive.gz`, 35 days
  hot → Glacier, expire ~13 months; bucket versioned.
- Restore drill: `mongorestore --uri ... --archive --gzip < file` into a
  scratch db, then `GET /billing/summary` on it must equal the live month
  (statements are reproducible by construction — T6).
