# One file per tenant — this IS the tenant's declared identity + capacity
# (decision 139: no defaults for any of it). Copy per client and commit:
# tfvars hold no secrets (those live in Secrets Manager).

region              = "sa-east-1"
state_bucket        = "namastex-usage-tfstate-504557607647"
state_bucket_region = "sa-east-1"

client_name         = "example"
client_timezone     = "America/Sao_Paulo"
mongo_usage_db_name = "example_usage"

# Session auth: point at this tenant's khal-auth to gate /api/v1 with
# session JWTs; empty (the default) = API OPEN — a declared decision for
# non-khal tenants, never an omission.
# khal_auth_url = "https://auth.<tenant-domain>"

# Accepted `aud` claims of the session JWT (comma-separated, ANY matches).
# The default already admits both apps that read the module's data —
# override only to narrow.
# khal_token_audience = "tracing,billing"

# The SHA of the images this tenant runs (build-images tags; later deploys
# move it via `make aws-deploy`, terraform ignores the drift).
image_sha = "<git sha>"

# LangWatch burst-hardening (decision 139) — dev-shaped shown; size per
# client's traffic tier, then prove it at the 1000 traces/s gate.
langwatch_instance_type           = "t3.large"
langwatch_volume_gb               = 100
langwatch_workers_replicas        = 2
langwatch_memory_limit            = "2g"
langwatch_redis_memory_limit      = "1g"
langwatch_clickhouse_memory_limit = "3g"
langwatch_clickhouse_cpu_limit    = "1.5"
