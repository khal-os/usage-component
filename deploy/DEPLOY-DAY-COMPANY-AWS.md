# Deploy day — RETIRED (superseded by the per-account onboarding)

This file was the one-shot runbook for standing the tenant factory up in
Namastex's own AWS account with Terraform, deploying `namastex` as tenant #1.
Three things retired it:

1. **One AWS account per client** (the full realization of CLAUDE.md
   invariant 5). There is no shared foundation to bootstrap once — every
   account gets the same list, and the list is a handoff to infra, not a
   `terraform apply` by us.
2. **Terraform is gone** (decision 155). CD ships images, task-definition
   revisions and config artifacts into stores infra pre-created;
   `deploy/scripts/preflight-aws.sh` is the single checker. The state bucket,
   the `foundation`/`tenant` split and the `.tfvars` files no longer exist.
3. **`namastex` is not a real client** and is being dropped. Nothing in the
   current flow targets it.

**Use instead:**

- `deploy/RUNBOOK-AWS.md` — the permanent operations reference, whose
  "Onboard a tenant" section is now the deploy-day procedure.
- `deploy/AWS-INFRA-HANDOFF.md` — the contract with infra: what they create,
  what CD may do, and the two IAM roles.
- `/aws-bootstrap <client> <prod|hml>` — generates the filled-in per-client
  resource list. `deploy/AWS-BOOTSTRAP-hapvida.md` is a worked example.

The one section worth keeping is the cost model, because it is what makes
per-tenant isolation a deliberate purchase rather than an accident.

## Known costs, per client account (cheapest configuration)

≈ **$140–145/mo**: EC2 t3a.large ~$55 · 3 Fargate tasks ~$27 · its own NAT
~$33 · its own ALB ~$18 · storage/logs ~$8.

Every client pays the FULL slice — complete isolation means there is no
shared network to prorate. Decision 142's per-tenant VPC/NAT/ALB was
re-examined once the account boundary arrived and KEPT: the account replaces
inter-tenant isolation, but not the NAT's second job, which is giving the
tenant a stable egress IP that the client's Atlas allowlist admits.

Load-test-ready sizing (t3.xlarge, which `deploy/tenants/example.env` ships
at) adds ~$65/mo. That is the price of running decision 140's 1000 traces/s
gate on the account's own sizing before real traffic — the Hetzner PoC died
exactly there, in a silent OOM.

Atlas is on top and depends on the tier (M10 + Cloud Backup is the current
posture, decision 145).
