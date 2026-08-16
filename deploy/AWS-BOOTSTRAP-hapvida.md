# AWS bootstrap — client `hapvida`, environment `prod`

Everything infra creates in **Hapvida's own AWS account** so that our CD can
ship images, task-definition revisions and config into it without creating a
single resource itself. Names below are the computed values of the naming
standard — copy them exactly; our pipeline resolves resources by these names.

**Base name:** `khal-hapvida-prod-usage` · **path base:** `khal/hapvida/prod/usage`

Placeholders you fill: `<account>` (Hapvida's AWS account id) · `<region>` ·
`<domain>` (Hapvida's domain — the zone is theirs; we never create it).
`hml` is the same list with `prod → hml` everywhere, if/when a homolog silo
is wanted (`khal-hapvida-hml-usage-*`, `khal/hapvida/hml/usage/…`).

Name-length check done: api target group `khal-hapvida-prod-usage-api` = 27
chars, `-lw` = 26, ALB = 23 — all under the 32-char cap.

---

## 0 · Order of operations

1. §A account-level, §B network, §C edge, §D IAM, §E config stores, §F LangWatch host.
2. **Hand over to us:** account id, region, NAT egress IP, ALB DNS name, confirmation that the two secrets and the SSM params exist.
3. **We run** `deploy-tenant.sh --register-only hapvida` — registers revision 1 of the four task-definition families (our templates), publishes the LangWatch config bundle to S3 and the capacity JSON to SSM.
4. §G workloads — services, schedule, alarms (they reference the families from step 3; if you must create services before step 3, use any placeholder task def — our next deploy overwrites it).
5. We fill the two secrets, run `preflight-aws.sh hapvida` (green = handover complete), then the load test, then LangWatch onboarding.

---

## A · Account-level (once per account)

| # | Resource | Name | Settings |
|---|---|---|---|
| A1 | ECS cluster | `khal-hapvida-prod-usage` | capacity provider `FARGATE`; Container Insights **enabled** |
| A2 | ECR repository | `khal-hapvida-prod-usage-module` | `imageTagMutability=IMMUTABLE`, `scanOnPush=true`, lifecycle: expire beyond **200** images (any tag status) |
| A3 | ECR repository | `khal-hapvida-prod-usage-connector` | same |
| A4 | ECR repository | `khal-hapvida-prod-usage-db-backup` | same |
| A5 | S3 bucket | `khal-hapvida-prod-usage-backups-<account>` | versioning **Enabled**; all four public-access blocks **true**; lifecycle rule **filtered to prefix `backups/`** — 35 d → GLACIER, expire 400 d, noncurrent 35 d, abort incomplete MPU 7 d. **Never an unfiltered rule** — `config/hapvida/*` in the same bucket is refetched by the LangWatch box on every service start; expiring it bricks the box. Prefixes used: `backups/hapvida/`, `config/hapvida/` |
| A6 | SNS topic | `khal-hapvida-prod-usage-alerts` | topic policy: allow `sns:Publish` from `events.amazonaws.com` and `cloudwatch.amazonaws.com` **with condition `aws:SourceAccount = <account>`**; **≥ 1 confirmed email subscription** (ops) — preflight fails without one |
| A7 | IAM OIDC provider | `https://token.actions.githubusercontent.com` | audience `sts.amazonaws.com` |
| A8 | IAM role — CD | `khal-hapvida-prod-usage-github-ci` | trust + policy in §A8 below |
| A9 | IAM role — read-only audit | `khal-hapvida-prod-usage-audit` | trust + policy in §A9 below (used by the nightly fleet heartbeat) |
| A10 | ACM certificate | `<domain>` + SAN `*.<domain>` | DNS-validated, status **ISSUED**, in `<region>`. Zone is Hapvida's; if their DNS team owns it, they paste the validation CNAME |

### A8 — `khal-hapvida-prod-usage-github-ci` (the only role CD assumes)

Trust: `sts:AssumeRoleWithWebIdentity` from A7, condition
`token.actions.githubusercontent.com:aud = sts.amazonaws.com` and
`:sub` in **both** spellings:
`repo:khal-os/usage-component:ref:refs/heads/main` and
`repo:khal-os@273177925/usage-component@1315313963:ref:refs/heads/main`
(the second is what GitHub sends for this repo today).

Policy:
```
ECR    GetAuthorizationToken                                   *
       DescribeImages BatchCheckLayerAvailability InitiateLayerUpload
       UploadLayerPart CompleteLayerUpload PutImage BatchGetImage
       GetDownloadUrlForLayer                                  → the 3 repos A2–A4
ECS    DescribeTaskDefinition RegisterTaskDefinition DescribeServices
       DescribeTasks ListTasks                                 *   (not scopable)
       UpdateService RunTask                                   *   cond ecs:cluster = <A1 ARN>
IAM    PassRole                                               arn:aws:iam::<account>:role/khal-hapvida-prod-usage-*
                                                              cond iam:PassedToService = ecs-tasks.amazonaws.com
LOGS   DescribeLogGroups DescribeLogStreams FilterLogEvents GetLogEvents
                                                              /khal/hapvida/prod/usage/*
S3     PutObject                                              <A5>/config/hapvida/*     (LangWatch config bundle)
SSM    PutParameter                                           /khal/hapvida/prod/usage/langwatch-capacity
```
No `Create*` on anything — by design.

### A9 — `khal-hapvida-prod-usage-audit` (read-only, fleet heartbeat)

Trust: same as A8. Policy: `ecs:Describe*/List*`, `ecr:Describe*/List*`,
`elasticloadbalancing:Describe*`, `ec2:Describe*`, `iam:Get*/List*`,
`secretsmanager:DescribeSecret ListSecrets` (**NOT** `GetSecretValue`),
`ssm:GetParameter DescribeParameters`, `logs:Describe*`, `s3:GetBucket*
ListBucket GetLifecycleConfiguration GetBucketVersioning
GetPublicAccessBlock`, `sns:GetTopicAttributes ListSubscriptionsByTopic`,
`scheduler:GetSchedule`, `cloudwatch:DescribeAlarms`, `events:DescribeRule`,
`dlm:GetLifecyclePolicies`, `application-autoscaling:DescribeScalableTargets`,
`route53:ListResourceRecordSets ListHostedZonesByName`, `acm:List* Describe*`.

---

## B · Network (decision 142 — the client's own VPC/NAT/ALB)

| # | Resource | Name / setting |
|---|---|---|
| B1 | VPC | `khal-hapvida-prod-usage` — CIDR `10.80.0.0/16`, DNS support + DNS hostnames **on** |
| B2 | Internet gateway | attached to B1 |
| B3 | Public subnets ×2 | `10.80.0.0/24`, `10.80.1.0/24` — two AZs, `map_public_ip_on_launch=true`; Name `khal-hapvida-prod-usage-public-<az>` |
| B4 | Private subnets ×2 | `10.80.10.0/24`, `10.80.11.0/24` — same two AZs; Name `khal-hapvida-prod-usage-private-<az>` |
| B5 | Elastic IP | Name `khal-hapvida-prod-usage-nat` — **hand this IP to us: it goes on Hapvida's Atlas network-access allowlist** |
| B6 | NAT gateway | `khal-hapvida-prod-usage` in public subnet [0], EIP B5 |
| B7 | Route tables | public → IGW; private → NAT; 4 associations |
| B8 | Security group `alb` | `khal-hapvida-prod-usage-alb` — ingress 80 + 443 from `0.0.0.0/0`; egress all |
| B9 | Security group `api` | `khal-hapvida-prod-usage-api` — ingress **3000 from B8 only**; egress all |
| B10 | Security group `workers` | `khal-hapvida-prod-usage-workers` — no ingress; egress all |
| B11 | Security group `langwatch` | `khal-hapvida-prod-usage-langwatch` — ingress **5560 from B8**, **8123 from B10**; egress all |

Cross-SG rules as standalone rule resources (not inline).

---

## C · Edge

| # | Resource | Name / setting |
|---|---|---|
| C1 | ALB | `khal-hapvida-prod-usage` — internet-facing, subnets B3, SG B8 |
| C2 | Listener :80 | redirect → 443, HTTP 301 |
| C3 | Listener :443 | cert A10, SSL policy `ELBSecurityPolicy-TLS13-1-2-2021-06`, **default action = fixed response 404**, content-type `application/json`, body `{"error":"unknown host"}` |
| C4 | Target group | `khal-hapvida-prod-usage-api` — HTTP :3000, `target_type=ip`, VPC B1, health path `/api/v1/docs` matcher 200-399, deregistration delay 30 |
| C5 | Target group | `khal-hapvida-prod-usage-lw` — HTTP :5560, `target_type=instance`, health `/` matcher 200-399 |
| C6 | Listener rule prio **100** | host-header `hapvida-api.<domain>` → C4 |
| C7 | Listener rule prio **101** | host-header `hapvida-langwatch.<domain>` → C5 |
| C8 | Route53 A (alias) | `hapvida-api.<domain>` → C1 |
| C9 | Route53 A (alias) | `hapvida-langwatch.<domain>` → C1 |

If Hapvida's DNS team owns the zone, C8/C9 are two records we hand them
(name, type A/alias or CNAME to the ALB DNS name).

---

## D · IAM — workload roles (all `khal-hapvida-prod-usage-*`)

| # | Role | Trust | Policy |
|---|---|---|---|
| D1 | `…-execution` | `ecs-tasks.amazonaws.com` | managed `AmazonECSTaskExecutionRolePolicy` + `secretsmanager:GetSecretValue` on E1, E2 + `ssm:GetParameters` on E3 |
| D2 | `…-task` | `ecs-tasks` | **empty on purpose** (app tasks only talk Mongo/ClickHouse over the network) |
| D3 | `…-backup-task` | `ecs-tasks` | `s3:PutObject GetObject DeleteObject AbortMultipartUpload GetObjectTagging PutObjectTagging` on `<A5>/backups/hapvida/*`; `cloudwatch:PutMetricData` cond `cloudwatch:namespace = Usage/Backup` |
| D4 | `…-backup-schedule` | `scheduler.amazonaws.com` | `ecs:RunTask` on **both** `arn:…:task-definition/khal-hapvida-prod-usage-backup` and `…-backup:*`; `iam:PassRole` on D1 + D3 cond `iam:PassedToService = ecs-tasks.amazonaws.com` |
| D5 | `…-langwatch` **+ instance profile of the same name** | `ec2.amazonaws.com` | managed `AmazonSSMManagedInstanceCore` + `secretsmanager:GetSecretValue` on E2 + `ssm:GetParameter` on E4 + `s3:GetObject` on `<A5>/config/hapvida/*` + `cloudwatch:PutMetricData` cond namespace `Usage/LangWatch` |
| D6 | `…-dlm` | `dlm.amazonaws.com` | managed `AWSDataLifecycleManagerServiceRole` |

---

## E · Config stores (create empty — we fill)

| # | Resource | Name | Initial value |
|---|---|---|---|
| E1 | Secrets Manager secret | `khal/hapvida/prod/usage/mongo` | `{}` — we set `MONGO_DB_HOST`, `MONGO_DB_USER`, `MONGO_DB_PASSWORD` |
| E2 | Secrets Manager secret | `khal/hapvida/prod/usage/langwatch` | `{}` — we set `LANGWATCH_NEXTAUTH_SECRET`, `LANGWATCH_API_TOKEN_JWT_SECRET`, `LANGWATCH_CREDENTIALS_SECRET`, `LANGWATCH_CLICKHOUSE_PASSWORD` |
| E3 | SSM parameter (String) | `/khal/hapvida/prod/usage/langwatch-project-id` | a single space `" "` (deliberate placeholder — connector restart-loops visibly until onboarding writes the real id) |
| E4 | SSM parameter (String) | `/khal/hapvida/prod/usage/langwatch-capacity` | `{}` — our deploy writes the JSON |
| E5 | CloudWatch log group | `/khal/hapvida/prod/usage/api` | retention **90** days |
| E6 | CloudWatch log group | `/khal/hapvida/prod/usage/connector` | 90 |
| E7 | CloudWatch log group | `/khal/hapvida/prod/usage/scheduler` | 90 |
| E8 | CloudWatch log group | `/khal/hapvida/prod/usage/backup` | 90 |

Secret **values never** go through infra, git or any pipeline — operator only.

---

## F · LangWatch host

| # | Resource | Setting |
|---|---|---|
| F1 | EC2 instance | Name `khal-hapvida-prod-usage-langwatch`; AMI latest **AL2023 x86_64**; type **`t3.xlarge`** (load-test sizing — decision B6); subnet = private [0]; SG B11; instance profile D5; root gp3 **50 GB** tagged `Name=khal-hapvida-prod-usage-langwatch`, `DlmSnapshots=khal-hapvida-prod-usage`; **user-data = the file we hand you** (rendered `langwatch-user-data.sh` — writes `/opt/langwatch/tenant.conf` and the systemd units); **must be created after B6/B7 exist** (first boot installs docker over the NAT); no public IP; no SSH key (SSM Session Manager) |
| F2 | Route53 **private** hosted zone | `internal.usage`, associated with VPC B1 |
| F3 | Route53 A record | `clickhouse.internal.usage` → F1 private IP, TTL 60 |
| F4 | Target-group attachment | C5 ← F1 on port 5560 |
| F5 | DLM lifecycle policy | resource type VOLUME, target tag `DlmSnapshots=khal-hapvida-prod-usage`, daily at 06:00, retain 7; role D6 |

If F1 is ever resized: stop → change type → start (x86 only); EBS and private
IP survive, F3 keeps resolving.

---

## G · Workloads (after our `--register-only`, or on a placeholder task def)

| # | Resource | Name / setting |
|---|---|---|
| G1 | Task-def families | `khal-hapvida-prod-usage-api`, `…-connector`, `…-scheduler`, `…-backup` — **registered by our pipeline** from templates; you only need them to exist to create G2–G4 |
| G2 | ECS service | `khal-hapvida-prod-usage-api` — cluster A1, Fargate, desired **1**, private subnets B4, SG B9, load balancer → C4 container `api` port 3000, **min-healthy 100 / max 200**, **deployment circuit breaker enable + rollback** |
| G3 | ECS service | `khal-hapvida-prod-usage-connector` — desired **1**, subnets B4, SG B10, **min-healthy 0 / max 100** (strict singleton — never two), no load balancer |
| G4 | ECS service | `khal-hapvida-prod-usage-scheduler` — desired **1**, subnets B4, SG B10, **0 / 100** (singleton), no load balancer |
| G5 | Application Auto Scaling | on G2 only: `ecs:service:DesiredCount` min 1 max 4, target-tracking `ECSServiceAverageCPUUtilization` = 60. **None on G3/G4** |
| G6 | EventBridge Scheduler schedule | `khal-hapvida-prod-usage-backup` — `cron(0 7 * * ? *)`, flexible window OFF, target = cluster A1, task-definition ARN **revision-less** `…:task-definition/khal-hapvida-prod-usage-backup`, Fargate, subnets B4, SG B10, role D4 |
| G7 | CloudWatch alarm | `khal-hapvida-prod-usage-backup-missing` — ns `Usage/Backup`, metric `Succeeded`, dim `Tenant=hapvida`, Sum, period 86400, 1 eval, `< 1`, **treat missing data = breaching**; alarm + OK actions → A6 |
| G8 | CloudWatch alarm | `khal-hapvida-prod-usage-langwatch-queue-backlog` — ns `Usage/LangWatch`, metric `RedisUsedMemoryPercent`, dim `Tenant=hapvida`, Maximum, 60 s × 5, `> 80`, **missing = breaching**; → A6 |
| G9 | EventBridge rule + target | `khal-hapvida-prod-usage-backup-failed` — pattern: source `aws.ecs`, detail-type `ECS Task State Change`, `lastStatus=STOPPED`, `group=family:khal-hapvida-prod-usage-backup`, `containers.exitCode anything-but 0`; target A6 with input transformer `"BACKUP FAILED <group>: <reason> (tenant hapvida)"` |

---

## H · Not AWS, but on the critical path

| Item | Who |
|---|---|
| MongoDB Atlas project + **M10** cluster (Cloud Backup ON), database `hapvida`, user; network-access allowlist ← **B5 EIP** | us / Hapvida DBA |
| Repo file `deploy/tenants/hapvida.env` (`CLIENT_NAME=hapvida`, `ENVIRONMENT=prod`, `AWS_ACCOUNT_ID`, `AWS_REGION`, `BASE_DOMAIN`, sizing…) | us |
| Slack webhook `FLEET_HEARTBEAT_SLACK_WEBHOOK` (repo secret, once for the fleet) | us |
| LangWatch onboarding → write E3 | us, after first deploy |

---

## What we need back from infra

`<account>` · `<region>` · **B5 NAT EIP** · C1 ALB DNS name (only if the
zone is not in this account) · confirmation that A6 has a confirmed
subscriber · the ACM status (ISSUED, or PENDING_VALIDATION + the CNAME to
forward to Hapvida's DNS team).

Handover is complete when `preflight-aws.sh hapvida` is green.
