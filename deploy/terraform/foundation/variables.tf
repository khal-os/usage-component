variable "region" {
  description = "AWS region for the whole platform (all tenants share it)."
  type        = string
}

variable "base_domain" {
  description = <<-EOT
    The platform's registered domain (e.g. usage.namastex.ai). The zone is
    created here; per-tenant hostnames (<client>-api.<domain>,
    <client>-langwatch.<domain>) are records the tenant module adds.
    Fail-fast: no default — the domain is a decision (decision 140).
  EOT
  type        = string
}

variable "github_oidc_subjects" {
  description = <<-EOT
    GitHub OIDC subject claims allowed to assume the CI role — pushes to
    main of this repo only. TWO spellings because this repo's sub uses
    GitHub's ID-stamped prefix (repo:org@id/name@id:..., verified via
    GET /actions/oidc/customization/sub 2026-08-10) — the classic form is
    kept so a future GitHub flip back doesn't lock CI out.
  EOT
  type        = list(string)
  default = [
    "repo:khal-os/usage-component:ref:refs/heads/main",
    "repo:khal-os@273177925/usage-component@1315313963:ref:refs/heads/main",
  ]
}
