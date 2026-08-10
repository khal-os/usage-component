# Terraform — the tenant factory (decision 140)

Two layers, applied in order:

- `foundation/` — built ONCE: VPC (2 AZ, 1 NAT), ECS cluster, the two ECR
  repos, ALB + wildcard ACM cert, Route53 zone, GitHub-OIDC CI role.
- `tenant/` (Phase 2) — the per-client module, instantiated once per tenant
  with a tfvars file; reads the foundation via `terraform_remote_state`.

## 1 · One-time bootstrap (by hand, before any terraform)

```bash
aws s3api create-bucket --bucket <state-bucket-name> --region <region> \
  $([ "<region>" != "us-east-1" ] && echo --create-bucket-configuration LocationConstraint=<region>)
aws s3api put-bucket-versioning --bucket <state-bucket-name> \
  --versioning-configuration Status=Enabled
```

## 2 · Foundation

```bash
cd deploy/terraform/foundation
cp backend.hcl.example backend.hcl   # fill in bucket + region (gitignored)
terraform init -backend-config=backend.hcl
terraform apply \
  -var region=<region> \
  -var base_domain=<the platform domain>
```

Then two manual follow-ups the outputs feed:

1. **Registrar** → point the domain's NS records at `route53_name_servers`
   (the ACM cert only validates after this).
2. **GitHub** → repository variables `AWS_DEPLOY_ROLE_ARN` =
   `github_ci_role_arn` output, `AWS_REGION` = the region. The
   `build-images` workflow then pushes `platform-module` /
   `platform-connector` images tagged by git SHA on every push to main.

## Notes

- **Fail fast**: `region` and `base_domain` have no defaults — deployment
  identity is declared, never defaulted (decision 139's convention).
- The NAT gateway's `nat_egress_ip` output is the address Atlas
  network-access lists must allowlist (until PrivateLink, decision 140).
- The HTTPS listener's default action is an explicit 404: a hostname with
  no tenant rule is visibly absent, never served by another tenant.
- ALB access logs are off (cost); revisit if audit needs arrive.
