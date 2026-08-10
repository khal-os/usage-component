# Fail-fast throughout (decision 139): identity and capacity have NO
# defaults — a tenant tfvars declares every one of them.

variable "region" {
  type = string
}

variable "state_bucket" {
  description = "The shared Terraform state bucket (foundation remote state lives there)."
  type        = string
}

variable "client_name" {
  description = "Tenant slug — hostnames, resource names, backup prefix."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.client_name))
    error_message = "client_name must be a lowercase slug (hostnames and resource names derive from it)."
  }
}

variable "client_timezone" {
  description = "Decision 130: the client's billing boundary = display zone (IANA)."
  type        = string
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

variable "lw_redis_memory_limit" {
  type = string
}

variable "lw_clickhouse_memory_limit" {
  type = string
}

variable "lw_clickhouse_cpu_limit" {
  type = string
}

# ── Module API ───────────────────────────────────────────────────────────────

variable "api_autoscale_max" {
  description = "Upper bound for module API task autoscaling (min is 1)."
  type        = number
  default     = 4
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

# ── Scheduler (decision 131 — auto-close ON in the factory) ──────────────────

variable "billing_auto_close_delay_minutes" {
  type    = number
  default = 60
}

variable "billing_auto_close_check_interval_seconds" {
  type    = number
  default = 900
}
