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

variable "vpc_cidr" {
  description = "CIDR of the shared VPC."
  type        = string
  default     = "10.80.0.0/16"
}

variable "github_oidc_subjects" {
  description = <<-EOT
    GitHub OIDC subject claims allowed to assume the CI role. Default:
    pushes to main of this repo only.
  EOT
  type        = list(string)
  default     = ["repo:khal-os/usage-component:ref:refs/heads/main"]
}
