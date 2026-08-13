# Tenant #1 — namastex (decision 140; fresh stand-up, Hetzner PoC retired).
# Reuses the existing Atlas M0 database `usage_db` (user decision
# 2026-08-10) — the permanent archive carries over untouched.

region              = "sa-east-1"
state_bucket        = "namastex-usage-tfstate-504557607647"
state_bucket_region = "sa-east-1"

client_name         = "namastex"
client_timezone     = "America/Sao_Paulo"
mongo_usage_db_name = "usage_db"

image_sha = "3cba43da27c4af6d52b3f20bab8eb4ebb4c6890e"

# Session auth (replaced the interim Basic gate of decision 141): /api/v1
# requires a khal-auth session JWT issued by this khal-auth.
khal_auth_url = "https://auth.khal-usage.com"

# audit D-1: the Tracing app origin (CloudFront) + the desktop shell.
cors_allowed_origins = "https://dtxfram9qv3pw.cloudfront.net,https://desktop.khal-usage.com"

# COST-FLOOR sizing (user decision 2026-08-10: cheapest now, load-test
# gate DEFERRED — upsize these + rerun the 1000/s gate before any real
# client traffic). t3a.large 8GB is the floor: below it the stack can't
# hold the declared limits (~7g) and we'd rebuild the Hetzner incident.
langwatch_instance_type           = "t3a.large"
langwatch_volume_gb               = 50
langwatch_workers_replicas        = 1
langwatch_memory_limit            = "2g"
langwatch_redis_memory_limit      = "1g"
langwatch_clickhouse_memory_limit = "2g"
langwatch_clickhouse_cpu_limit    = "1.0"
