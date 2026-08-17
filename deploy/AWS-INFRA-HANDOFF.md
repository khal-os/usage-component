# AWS infra handoff — what infra creates, what CD only references

**The standard:** CD creates nothing but container images, task-definition
revisions and config artifacts. Every other AWS resource is created by infra,
once per client account, and on our side is only ever *asserted* — by
`deploy/scripts/preflight-aws.sh`, never created.

This document is the generic contract. **For a specific client, generate the
filled-in list** — every name computed, every setting spelled out, with a
status column:

```
/aws-bootstrap <client> <prod|hml>
```

`deploy/AWS-BOOTSTRAP-hapvida.md` is a worked example.

Every name below is a **contract, not a suggestion**: the deploy script, the
task-definition templates and the app config resolve resources by exact name,
so a different name breaks the pipeline silently.

---

## The naming formula

Four axes, always all four. The redundancy is deliberate: even with one AWS
account per client, an ARN, an S3 key or a metric dimension read in isolation
still says whose it is.

```
org=khal · client=<slug> · env=prod|hml · component=usage

client level      khal-<client>-<env>-<thing>            three axes
component level   khal-<client>-<env>-<component>-<thing>  four axes

resource names   khal-<client>-<env>-usage[-<thing>]     hyphens, flat
store paths      khal/<client>/<env>/usage/<thing>       slashes
S3 key prefixes  backups/<client>/  ·  config/<client>/
metric dimension Tenant=<client>
```

`prod` and `hml` are the only environments on AWS — development is local
compose and has no AWS names. The full words `production`/`homolog` appear
in exactly one place, and it is not an AWS name: the container's own
`ENVIRONMENT` variable, mapped by the task-def renderer.

**Two levels, and the difference is ownership** (decision 167). The network
is shared by every app and API the client runs — it is not the usage
component's. So VPC, subnets, IGW, NAT, route tables, endpoints, security
groups, the ALB and the ACM certificate take **three axes**,
`khal-<client>-<env>-<thing>`, with no component: there is none to name, and
a filler like `shared` would invent one. Everything a single component owns
alone — cluster, ECR, services, task definitions, secrets, SSM, log groups,
alarms, its IAM roles, its buckets — takes four.

Target groups stay at component level (`khal-<client>-<env>-usage-api` points
at the usage api), so the 32-char cap and the slug limit below are unchanged.

⚠ Getting this wrong is not cosmetic: a VPC named for a component invites
someone to create a SECOND VPC later, because "that one is the usage one".

**Client slugs are capped at 12 characters.** The binding constraint is the
api target group, `khal-<slug>-prod-usage-api` = 20 + slug, against AWS's
32-char cap on ALB and target-group names. `naming.sh` refuses a longer slug
rather than truncating — a truncated name can end in `-` or collide two
clients.

The single formula lives in `deploy/scripts/naming.sh`. To see any computed
name without reading the file:

```bash
bash deploy/scripts/naming.sh <client> name_service api
```

---

## What infra creates, per account

Counts are the hapvida reference build. The generated per-client report
carries each row with its exact settings; this is the shape.

| Group | Resources |
|---|---|
| **Account** | ECS cluster (= `BASE`) · 3 ECR repos · S3 backups bucket · SNS alerts topic · GitHub OIDC provider · CD role `-github-ci` · audit role `-audit` · Chatbot channel config · ACM certificate · Route53 public zone |
| **Network** | VPC · IGW · 2 public + 2 private subnets · NAT + EIP · route tables · **S3 gateway endpoint** · 5 security groups · (Atlas PrivateLink endpoint + its SG) |
| **Edge** | ALB · :80 redirect listener · :443 listener with a **fixed-404 default** · target groups `-api` and `-lw` · host-header rules · A-alias records |
| **IAM (workload)** | `-execution` · `-task` · `-backup-task` · `-backup-schedule` · `-langwatch` + instance profile · `-dlm` |
| **Config stores** | 2 Secrets Manager secrets (`…/mongo`, `…/langwatch`), created EMPTY · 2 SSM parameters · 4 log groups |
| **LangWatch host** | EC2 instance (user-data supplied by us) · private hosted zone `<client>.internal.usage` + `clickhouse` record · TG attachment · DLM policy · **root volume ENCRYPTED**, tagged for DLM |
| **Workloads** | 3 ECS services · EventBridge Scheduler for the nightly backup · 2 alarms · 1 EventBridge failure rule |

### Settings that are not defaults, and why

- **`connector` and `scheduler`: `desiredCount = 1`, deployment
  `minimumHealthyPercent = 0`, `maximumPercent = 100`, and NO autoscaling
  target.** This is the one setting whose violation produces no error
  anywhere. The sync watermark has no lease, so two live connectors read the
  same window and every trace in it is counted twice — in the permanent
  archive. AWS's default (100/200) starts the new task before stopping the
  old one, i.e. produces exactly that overlap on every deploy. The scheduler
  is the same rule: a reopened month must never race two closers.
- **`api`: deployment circuit breaker enabled WITH rollback.** Otherwise a
  broken image sits half-deployed.
- **Backups bucket lifecycle rule scoped to the `backups/` prefix.**
  Unfiltered, it also ages out `config/<client>/`, which the LangWatch box
  re-fetches on every service start — the box stops booting days later, with
  nothing linking cause to effect.
- **Every alarm: `treat missing data = breaching`.** The failure mode of a
  nightly backup is NO datapoint, not a bad one. Expect the alarms to sit in
  ALARM until the first metric flows; that is correct, do not "fix" it.
- **Backup schedule targets the REVISION-LESS task-definition ARN**, and its
  role allows `ecs:RunTask` on **both** that ARN and `…:*` — IAM matches the
  ARN as called, so `family:*` alone AccessDenies every fire, silently.
- **ECR tags IMMUTABLE.** Rollback is "redeploy an older SHA"; a mutable tag
  makes that a lie.
- **Chatbot channel guardrail `AWSDenyAll`.** Chatbot otherwise lets channel
  members run AWS CLI commands in the account. `ReadOnlyAccess` is not benign
  there — it includes `s3:GetObject` on the backup dumps.
- **Secret shells created EMPTY (`{}`).** Values are put in by the operator
  and never transit git, a pipeline, or any document.
  `LANGWATCH_CREDENTIALS_SECRET` must never change after first boot — stored
  credentials become undecryptable. Mark it non-rotatable.
- **The LangWatch root volume is encrypted, and its private zone carries the
  client** (`<client>.internal.usage`). The volume holds every trace with full
  unmasked content, and EBS cannot be encrypted after creation — the fix is
  snapshot, copy, restore, swap, on a live box. The zone is scoped by VPC
  association rather than by name, so a shared `internal.usage` leaves N
  identically-named zones in one account: associate the wrong one and a
  client's connector resolves another client's ClickHouse.
- **The api target group's health path is `/api/v1/docs`.** It is the one
  route that stays open with session auth on (decision 103); any other path
  401s and targets never go healthy.

---

## The two IAM roles infra creates for us

### CD role — `khal-<client>-<env>-usage-github-ci`

Trusted by the GitHub OIDC provider for this repository's `main` ref.
**Zero `Create*` on infrastructure.** Every action is push, register, update,
or put-into-an-existing-store:

```
ECR    GetAuthorizationToken                                   *
       DescribeImages BatchCheckLayerAvailability InitiateLayerUpload
       UploadLayerPart CompleteLayerUpload PutImage BatchGetImage
       GetDownloadUrlForLayer                        → the 3 repos only
ECS    DescribeTaskDefinition RegisterTaskDefinition DescribeServices
       DescribeTasks ListTasks                       *  (not scopable)
       UpdateService RunTask                         *  cond ecs:cluster = BASE
IAM    PassRole            role/khal-<client>-<env>-usage-*
                           cond iam:PassedToService = ecs-tasks.amazonaws.com
LOGS   DescribeLogGroups                             *  (not scopable)
       DescribeLogStreams FilterLogEvents GetLogEvents
                           log-group:/khal/<client>/<env>/usage/*:*
S3     PutObject           <bucket>/config/<client>/*      (NOT backups/)
SSM    PutParameter        /khal/<client>/<env>/usage/langwatch-capacity
```

Notes on what is deliberately **absent**:

- No `ecs:DescribeClusters`. `describe-services` against a missing cluster
  already answers `ClusterNotFoundException`, so cluster existence is
  inferred for free — and requiring a permission the role lacks would block
  every deploy until it was granted.
- No `secretsmanager:*` at all. The task-definition templates reference
  secrets by ARN read from `deploy/tenants/<client>.env`; the pipeline never
  reads a secret. The ARNs are verified against the live secrets by
  preflight, which runs on operator or audit credentials.
- The `logs:` read grant is what the failure path needs to tail a failed
  migration. It never existed before, so that path printed nothing.

### Audit role — `khal-<client>-<env>-usage-audit`

Same trust. Read-only across the preflight surface — `ecs`, `ecr`,
`elasticloadbalancing`, `ec2`, `iam`, `ssm`, `logs`, `s3` bucket-level,
`sns`, `scheduler`, `cloudwatch`, `events`, `dlm`,
`application-autoscaling`, `route53`, `acm`, plus
`secretsmanager:DescribeSecret ListSecrets` — and **never
`secretsmanager:GetSecretValue`**. The nightly fleet heartbeat assumes this
role in every account; it checks that secrets EXIST, never their keys. Key
presence is an operator-credential check only.

Note the ARN quirk: Secrets Manager appends a random 6-char suffix, so an
IAM resource ARN for a secret must end in `-*` or it never matches.
`logs:DescribeLogGroups` cannot be resource-scoped and needs its own
statement with `Resource: "*"`.

---

## What crosses from CD into the account

Only artifacts, into stores infra already created:

| Artifact | Destination | By |
|---|---|---|
| Container images | ECR repos | `build-images` |
| Task-definition revisions (api, connector, scheduler, backup) | ECS | `deploy-tenant.sh`, rendered from `deploy/taskdefs/*.json` |
| LangWatch compose, bootstrap, Caddyfile | `s3://<bucket>/config/<client>/` | `deploy-tenant.sh` |
| LangWatch capacity JSON | the SSM capacity parameter | `deploy-tenant.sh` |

It creates no bucket, parameter, repository, role, service or schedule.

Task definitions are **rendered from repo templates on every deploy, never
cloned from the current revision** — so infra may create the services on a
placeholder task definition and the next deploy simply overwrites it.
Ordering between the two sides is therefore harmless rather than enforced.

---

## What we hand back to infra

1. **The LangWatch user-data**, rendered per tenant:
   `make aws-user-data CLIENT=<client>`. Only after the domain resolves —
   cloud-init runs it once per instance and bakes `LANGWATCH_PUBLIC_URL` in.
2. **The DNS records** — see below. This is the only step gated on another
   team, and it blocks the certificate → the :443 listener → the host rules
   → the entire LangWatch host. Ask for it first.
3. **The GitHub OIDC subject(s)** to trust, in both spellings if this repo's
   subject is ID-stamped.

---

## DNS — two models, never both (decision 159)

The parent zone is external and we never touch it beyond one ask. That ask
takes one of two shapes, and **they are mutually exclusive**: an NS record
delegating `<client>` shadows every record the parent zone holds underneath
it, so creating both silently disables the second.

**A · Delegated to Route 53** — infra adds one NS record set in the parent
zone pointing at the per-client Route 53 zone. After that the account owns
its own validation and A-alias records with zero cross-account access.

**B · Kept in the parent's DNS provider** (Cloudflare, or whatever holds the
zone) — infra creates the records directly and the per-client Route 53 zone
is not used at all. Three records, all with any proxy/CDN feature OFF:

| Type | Name | Value |
|---|---|---|
| CNAME | `_<acm-token>.<client>.<parent>` | the ACM validation target |
| CNAME | `api.<client>.<parent>` | the ALB's DNS name |
| CNAME | `langwatch.<client>.<parent>` | the ALB's DNS name |

**CNAME, not A** in model B: the ALB has no fixed address, and only Route 53
can alias one. The ACM validation record **must never be deleted** — ACM
re-checks it at every automatic renewal, so removing it after issuance fails
the renewal silently about thirteen months later.

Preflight resolves both hostnames and compares them to the ALB, so it
reports a missing or mis-pointed record the same way under either model.

**If a CDN proxy is later switched on** in front of these hostnames: the ALB
still needs a valid certificate (keep ACM, or install the CDN's origin
certificate); the `langwatch.` host carries OTLP trace payloads and will meet
whatever request-body limit the CDN plan imposes; and content-rewriting
features must be off, because the LangWatch embed depends on exact
`Set-Cookie` and CSP headers.

---

## Traps worth stating once

- **Never select a VPC or subnet by CIDR in an account that hosts more than
  one tenant.** Tenant VPCs deliberately share `10.80.0.0/16` (they are never
  peered), so a CIDR filter silently returns another tenant's network.
  Filter by `vpc-id`.
- **A task definition naming a missing log group fails to START**, with an
  error pointing at the task, not the group. Create log groups first.
- **ACM/DNS wildcards match exactly one label.** `*.khal.ai` does NOT cover
  `api.<client>.khal.ai`; the wildcard must sit at the client-domain level,
  which also means one certificate per account.
- **The Atlas PrivateLink security group needs ports 1024-65535, not 27017** —
  Atlas assigns a unique load-balancer port per replica-set node.
- **EC2 security-group descriptions are ASCII-only** — an em-dash or an
  apostrophe is rejected.
- **The S3 account-regional namespace bakes the region into the bucket name**,
  so a bucket created in the wrong region cannot be renamed, only recreated.
