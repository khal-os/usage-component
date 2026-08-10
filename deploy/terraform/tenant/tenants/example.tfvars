# One file per tenant — this IS the tenant's declared identity + capacity
# (decision 139: no defaults for any of it). Copy per client and commit:
# tfvars hold no secrets (those live in Secrets Manager).

region       = "us-east-1"
state_bucket = "namastex-usage-tfstate-648426765611"

client_name         = "example"
client_timezone     = "America/Sao_Paulo"
mongo_usage_db_name = "example_usage"

# The SHA of the images this tenant runs (build-images tags; later deploys
# move it via `make aws-deploy`, terraform ignores the drift).
image_sha = "<git sha>"

# LangWatch burst-hardening (decision 139) — dev-shaped shown; size per
# client's traffic tier, then prove it at the 1000 traces/s gate.
langwatch_instance_type    = "t3.large"
langwatch_volume_gb        = 100
langwatch_workers_replicas = 2
langwatch_memory_limit     = "2g"
lw_redis_memory_limit      = "1g"
lw_clickhouse_memory_limit = "3g"
lw_clickhouse_cpu_limit    = "1.5"
