# Fail-fast throughout (decision 139): identity and capacity have NO
# defaults — a tenant tfvars declares every one of them.

variable "region" {
  type = string
}

variable "state_bucket" {
  description = "The shared Terraform state bucket (foundation remote state lives there)."
  type        = string
}

variable "state_bucket_region" {
  description = "Region of the state bucket itself — may differ from var.region (fail-fast: no default)."
  type        = string
}

variable "client_name" {
  description = "Tenant slug — hostnames, resource names, backup prefix."
  type        = string

  validation {
    # ≤ 22 chars so "usage-<name>-api" fits AWS's 32-char ALB/TG name
    # limit WITHOUT truncation (review fix: substr could cut to a
    # trailing '-' or collide two tenants' names).
    condition     = can(regex("^[a-z][a-z0-9-]{1,21}$", var.client_name))
    error_message = "client_name must be a lowercase slug of at most 22 chars (usage-<name>-api must fit AWS's 32-char name limits)."
  }
}

# ADR-103 <env> axis for paths (khal/<client>/<env>/usage/*). The AWS
# deployment of a client is its production by definition; homolog exists for
# staging silos.
variable "environment" {
  type    = string
  default = "production"
  validation {
    condition     = contains(["homolog", "production"], var.environment)
    error_message = "environment must be homolog or production (ADR-103)."
  }
}

variable "client_timezone" {
  description = "Decision 130: the client's billing boundary = display zone (IANA)."
  type        = string
}

variable "vpc_cidr" {
  description = <<-EOT
    This tenant's own VPC (decision 142). The same CIDR across tenants is
    deliberate — tenant VPCs are NEVER peered; if that ever changes,
    re-IP first.
  EOT
  type        = string
  default     = "10.80.0.0/16"
}

variable "image_sha" {
  description = "Git SHA tag of the platform images to run (built by build-images)."
  type        = string
}

variable "mongo_usage_db_name" {
  description = "Decision 139: the usage store's database name — declared, never inferred."
  type        = string
}

# ── LangWatch EC2 sizing (burst-hardening, decisions 139/140) ────────────────

variable "langwatch_instance_type" {
  description = "EC2 instance type for the LangWatch stack (e.g. t3.large, t3.xlarge)."
  type        = string
}

variable "langwatch_volume_gb" {
  description = "Root EBS volume (holds ClickHouse + Postgres docker volumes)."
  type        = number
}

variable "langwatch_workers_replicas" {
  type = number
}

variable "langwatch_memory_limit" {
  type = string
}

variable "langwatch_redis_memory_limit" {
  type = string
}

variable "langwatch_clickhouse_memory_limit" {
  type = string
}

variable "langwatch_clickhouse_cpu_limit" {
  type = string
}

# ── Module API ───────────────────────────────────────────────────────────────

variable "api_autoscale_max" {
  description = "Upper bound for module API task autoscaling (min is 1)."
  type        = number
  default     = 4
}

variable "khal_auth_url" {
  description = <<-EOT
    khal-auth base URL — session-JWT gate on /api/v1 (replaces the interim
    Basic gate, decision 141). Empty = auth OFF (the API answers OPEN — a
    deliberate posture for non-khal tenants, warned loudly at boot).
    KHAL_TENANT rides along automatically (var.client_name).
  EOT
  type        = string
  default     = ""
}

variable "cors_allowed_origins" {
  description = "Exact origins, comma-separated; empty = same-origin only (audit D-1)."
  type        = string
  default     = ""
}

# ── Sync worker knobs (defaults mirror the compose contract) ─────────────────

variable "trace_ingestion_interval_seconds" {
  type    = number
  default = 60
}

variable "trace_ingestion_batch_size" {
  type    = number
  default = 1000
}

variable "trace_ingestion_quiet_period_seconds" {
  type    = number
  default = 900
}

# Parity fix (ADR-103 sweep): previously compose-only — its three ingestion
# siblings all had terraform plumbing, this one did not.
variable "reprocess_interval_seconds" {
  type    = number
  default = 3600
}

# ── Logging (parity fix: were compose-only; AWS ran on app defaults) ─────────

variable "log_level" {
  type    = string
  default = "info"
}

variable "log_format" {
  type    = string
  default = "json"
}

# ── Scheduler (decision 131 — auto-close ON in the factory) ──────────────────

variable "billing_auto_close_delay_minutes" {
  type    = number
  default = 60
}

variable "billing_auto_close_check_interval_seconds" {
  type    = number
  default = 900
}
