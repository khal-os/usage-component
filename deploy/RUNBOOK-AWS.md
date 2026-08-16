# RUNBOOK — AWS tenant factory (decision 140, reworked by 149–155)

Supersedes `RUNBOOK-VM.md` for production. The VM runbook remains only as
history of the retired Hetzner PoC. Principles that replace its rules:
**no rsync anywhere** (code = immutable ECR images; config = Secrets
Manager/SSM; deploys only change image tags — the clobber class is dead),
and **fail fast** (decision 139: capacity/identity are declared per
tenant, nothing defaults).

## Who creates what

**One AWS account per client**, and **CD creates nothing but container
images, task-definition revisions and config artifacts.** Every other
resource is created by infra, once per account, from
`AWS-INFRA-HANDOFF.md` (or the per-client report `/aws-bootstrap
<client> <env>` generates). On our side those resources are *asserted*,
never created — `deploy/scripts/preflight-aws.sh` is the single checker.

There is no Terraform in this repo (decision 155). What crosses into the
client's account:

| Artifact | Where it lands | Shipped by |
|---|---|---|
| Container images | ECR `khal-<client>-<env>-usage-{module,connector,db-backup}` | `build-images` |
| Task-definition revisions (4 families) | ECS | `deploy-tenant.sh`, **rendered from `deploy/taskdefs/*.json` every deploy** |
| LangWatch config bundle | `s3://<backups-bucket>/config/<client>/` | `deploy-tenant.sh` |
| LangWatch capacity JSON | SSM `/khal/<client>/<env>/usage/langwatch-capacity` | `deploy-tenant.sh` |
| EC2 user-data | infra creates the instance with it | `make aws-user-data`, handed over once |

Every AWS name comes from ONE formula, `deploy/scripts/naming.sh`, applied
to `deploy/tenants/<client>.env`. Nothing else computes a name.

## Naming, in one screen

```
khal-<client>-<env>-usage[-<thing>]     resource names   (env ∈ prod|hml)
khal/<client>/<env>/usage/<thing>       Secrets Manager, SSM, log groups
backups/<client>/  ·  config/<client>/  S3 key prefixes
```

Print any of them: `bash deploy/scripts/naming.sh <client> name_service api`.

## Onboard a tenant

0. **Write `deploy/tenants/<client>.env`** — copy `example.env`. Everything
   downstream reads it, so this is the tenant's identity: slug ≤ 12 chars,
   `ENVIRONMENT=prod|hml`, account, region, `BASE_DOMAIN`, the two secret
   ARNs, timezone, db name, capacity. Leave `IMAGES_ENABLED=false` until the
   account's ECR push role works — a tenant committed before its account
   exists must not turn `build-images` red on every push to main.
1. **Infra creates the account's resources** from the handoff list. Hand
   them the LangWatch user-data with `make aws-user-data CLIENT=<client>`.
   **Not before the domain resolves:** cloud-init runs user-data once per
   instance and bakes `LANGWATCH_PUBLIC_URL` into `/opt/langwatch/tenant.conf`.
2. **Atlas (manual, once per client):** project + cluster, a db user, and
   either PrivateLink or an allowlist entry for THIS tenant's NAT egress IP
   (decision 142 gives every tenant its own; `make aws-preflight` prints it).
3. **Fill the tenant secrets.** Infra creates the SHELLS; values never
   transit git, a pipeline, or this repo.
   ```bash
   aws secretsmanager put-secret-value --secret-id khal/<client>/prod/usage/mongo --secret-string '{
     "MONGO_DB_HOST": "<cluster>.mongodb.net",
     "MONGO_DB_USER": "...", "MONGO_DB_PASSWORD": "..."
   }'
   ```
   ```bash
   aws secretsmanager put-secret-value --secret-id khal/<client>/prod/usage/langwatch --secret-string '{
     "LANGWATCH_NEXTAUTH_SECRET": "<openssl rand -base64 32>",
     "LANGWATCH_API_TOKEN_JWT_SECRET": "<openssl rand -base64 32>",
     "LANGWATCH_CREDENTIALS_SECRET": "<openssl rand -base64 32>",
     "LANGWATCH_CLICKHOUSE_PASSWORD": "<openssl rand -base64 24>"
   }'
   ```
   **`LANGWATCH_CREDENTIALS_SECRET` must NEVER change after first boot** —
   stored credentials become undecryptable. Mark the secret non-rotatable.
   `LANGWATCH_CLICKHOUSE_PASSWORD` is now a real password on both sides
   (decision 156 closed the split-brain); on a box that booted before that
   fix, rotate it and restart the bootstrap service.
   API auth is session-JWT (khal-auth) and holds no secret at all: set
   `KHAL_AUTH_URL` in the tenant file and the api task gets it plus
   `KHAL_TENANT`. Empty = API OPEN, a declared posture, warned at boot.
   The EC2 needs nothing: `langwatch-bootstrap.service` retries every 30s
   until the secret exists, then brings the stack up itself.
4. **`make aws-preflight CLIENT=<client>`** — the gate. It reports every
   violation in one pass; a "cannot verify" line means the credentials lack
   a permission, NOT that the resource is missing. Do not proceed on red.
5. **`make aws-register CLIENT=<client> SHA=<git-sha>`** — registers the
   four task-definition families so infra can create the services on real
   task definitions rather than a placeholder. Touches no service. Ordering
   with infra is harmless either way: nothing is ever cloned from an
   existing revision, so a service created on a placeholder is simply
   overwritten by the next deploy.
6. **First deploy:** `make aws-deploy CLIENT=<client> SHA=<git-sha>` (or the
   `deploy-tenant` workflow button). Record the SHA back into the tenant
   file — preflight warns on the drift.
7. **Prices BEFORE traffic** (pending_price self-heals, but don't rely on
   it): run the `insert-price-version` one-off — see Jobs below.
8. **LangWatch onboarding:** create the project in the LangWatch UI, then
   write the project id (the connector is in a deliberate restart loop until
   this exists — audit G-1):
   ```bash
   aws ssm put-parameter --overwrite --name /khal/<client>/prod/usage/langwatch-project-id --value <project_...>
   ```
   ```bash
   aws ecs update-service --cluster khal-<client>-prod-usage --service khal-<client>-prod-usage-connector --force-new-deployment
   ```
   Hand the client's agent platform the OTLP base
   `https://langwatch.<BASE_DOMAIN>`.
9. **Load test, once, on this account** (decision 140's 1000 traces/s gate —
   queue grows, drains, ZERO loss). See `loadtest/README.md` and
   `loadtest/watch-pipeline.sh --aws <client>`. Record the pass/fail line.
   The Hetzner PoC died exactly here, and N accounts means N chances to
   repeat it — which is why "once, then trust" was rejected.
10. **Verify (the per-tenant acceptance list):** one trace flows end-to-end
    and lands STAMPED with a real R$; `GET /billing/summary` ≡ Σ stamped
    costs; a backup object appears in S3 after the next 07:00 UTC run (or
    run one now — Jobs below); the alarm fires on a forced failure.
11. **Turn the nightly heartbeat on** — for the FIRST account only; after
    that it already covers every tenant file. The cron in
    `.github/workflows/fleet-heartbeat.yml` ships commented out, because
    before an account is deployed every run would be red for a true reason,
    and a leg that is always red is a leg nobody reads. Two things to do,
    in this order:
    - add the repo secret `FLEET_HEARTBEAT_SLACK_WEBHOOK` (a Slack incoming
      webhook for the channel ops watches), then run the workflow once by
      hand from the Actions tab and confirm the digest arrives;
    - uncomment the `schedule:` block and merge.

    Do not uncomment it first: the run fails without the webhook, by design.

### When someone else owns the DNS zone

Three records are pasted by whoever holds the parent zone — days, not
minutes, and outside anyone's automation. Send them exactly this, then park:
preflight reports `certificate … PENDING_VALIDATION` as a named STATE, not a
failure, so onboarding waits there cleanly.

- the ACM validation CNAME (request the certificate first — ACM only emits
  the record after the request; one record covers the wildcard and the apex)
- `api.<BASE_DOMAIN>` → the ALB
- `langwatch.<BASE_DOMAIN>` → the ALB

**If the zone stays with an external provider** (decision 159), those two are
**CNAMEs, not A records** — only Route 53 can alias an ALB — and there must
be **no NS delegation** for the client label: an NS record shadows every
record the parent zone holds underneath it, so the two models cannot be
mixed. Any proxy/CDN feature stays off while the certificate validates.

The validation record is permanent. ACM re-checks it at every automatic
renewal, so deleting it after issuance fails the renewal silently about
thirteen months later.

`make aws-preflight CLIENT=<client>` resolves both hostnames and compares
them to the ALB, so it is also how you find out the records landed without
asking anyone.

## Deploys & rollback

```bash
make aws-deploy CLIENT=<client> SHA=<git-sha>
```
```bash
make aws-deploy CLIENT=<client> SHA=<older-sha>
```
Rollback is the same command with an older SHA. Images are built by
`build-images` on every push to main, tagged by SHA, immutable.

**The rollback horizon starts at the account's onboarding.** No SHA is ever
backfilled into a new account, so on day one "rollback" means redeploying
the same SHA. `make aws-preflight` prints how many deployable SHAs the
account holds.

## Jobs (runbook one-offs — same vocabulary, new engine)

Run any module job as a one-off task on the api task definition:
```bash
CLUSTER=$(bash deploy/scripts/naming.sh <client> name_base) \
aws ecs run-task --cluster "$CLUSTER" \
  --task-definition "$(bash deploy/scripts/naming.sh <client> name_service api)" --launch-type FARGATE \
  --network-configuration "$(aws ecs describe-services --cluster "$CLUSTER" \
      --services "$(bash deploy/scripts/naming.sh <client> name_service connector)" \
      --query 'services[0].networkConfiguration' --output json)" \
  --overrides '{"containerOverrides":[{"name":"api","command":["node","dist/main/jobs/<job>.js","<args...>"]}]}'
```
`<job>` ∈ insert-price-version · close-billing-period · reopen-billing-period ·
reprocess-pending · rebuild-filter-counters · rebuild-session-summaries ·
run-migrations. Backup on demand: same shape with the `backup` family and no
overrides.

## LangWatch EC2 operations

- Shell: `aws ssm start-session --target <instance-id>` (no SSH, no keys).
- Stack lives in `/opt/langwatch` (compose.yml + Caddyfile + generated .env),
  driven by `langwatch-bootstrap.service`: on EVERY service start it re-fetches
  the compose file, the bootstrap and the Caddyfile from S3, the LW secrets
  from Secrets Manager and the capacity knobs from SSM, regenerates .env, and
  `compose up`s. The .env is DISPOSABLE output — never hand-edit it as a
  source of truth.
- **Embed proxy** (`langwatch-embed-proxy`, caddy): owns host port 5560 — the
  ALB target — and proxies to the app over the compose network. It exists
  because LangWatch hardcodes `frame-ancestors 'none'` and `SameSite=Lax`
  session cookies, with no configuration for either, which makes it
  unembeddable in the Khal desktop. The proxy rewrites both. To change which
  desktop may frame it, set `LANGWATCH_EMBED_ORIGIN` in the tenant file →
  `make aws-deploy` (which re-publishes the Caddyfile) → restart (below).
  **Never patch the app container by hand:** that is exactly what this
  replaced, and those edits die silently on the next container recreation.
- Capacity retune (incl. load-testing): edit the tenant file →
  `make aws-deploy` (updates the SSM capacity parameter — NO instance
  replacement) → restart:
  ```bash
  aws ssm send-command --document-name AWS-RunShellScript --instance-ids <id> --parameters commands='systemctl restart langwatch-bootstrap'
  ```
  Secret rotation propagates the same way.
- **Resize the box is an INFRA action** — they own the instance: stop →
  modify instance type → start. The EBS root volume and the private IP
  survive, so `clickhouse.internal.usage` keeps resolving and no task
  definition changes. Stay on x86_64: the AMI is x86 and Graviton would be a
  replacement, which wipes LangWatch's ~49-day window. Bump the capacity
  knobs in the tenant file alongside — a bigger box with the same container
  limits gains nothing.
- Queue metric/alarm: `Usage/LangWatch RedisUsedMemoryPercent{Tenant}` —
  alarm at 80% for 5 min; missing data BREACHES (a dead metric was the
  original failure mode).

## Alerts

One topic per account: `khal-<client>-<env>-usage-alerts`, delivered to
Slack through AWS Chatbot. **The channel guardrail must be `AWSDenyAll`** —
Chatbot otherwise lets anyone in the channel run AWS CLI commands in the
account, and `ReadOnlyAccess` is not benign there (it includes
`s3:GetObject` on the backup dumps).

Preflight fails an account whose topic has no CONFIRMED subscription: an
alert topic nobody is subscribed to is silence wearing a green badge.

Across accounts there is no forwarding and no shared topic. Instead the
`fleet-heartbeat` workflow runs `preflight-aws.sh --fleet` nightly, assumes
each account's read-only `…-usage-audit` role, and posts one digest line per
account to Slack. It goes red on any failure, and it fails outright if
`FLEET_HEARTBEAT_SLACK_WEBHOOK` is unset — a heartbeat that cannot reach
anyone is the exact silence it exists to prevent.

## Backups & restore

- `s3://khal-<client>-<env>-usage-backups-<account>-<region>-an/backups/<client>/<timestamp>.archive.gz`
  — Glacier at 35 days, expire ~13 months; bucket versioned. **The lifecycle
  rule MUST be scoped to the `backups/` prefix**: unfiltered it also ages out
  `config/`, which the LangWatch box re-fetches on every service start, and
  the box then stops booting days later with nothing linking cause to effect.
  Preflight checks this.
- Restore drill: `mongorestore --uri ... --archive --gzip < file` into a
  scratch db, then `GET /billing/summary` on it must equal the live month
  (statements are reproducible by construction — T6).
