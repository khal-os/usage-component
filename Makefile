# Single-tenant operations. The Makefile knows NO client: every target takes
# CLIENT=<name>, which selects clients/<name>.env (the env contract —
# see clients/example.production.env; dev shape in example.development.env). Deploying a new client = writing its env file.
#
#   make build                                  # build the module+connector+ui images locally
#   make up CLIENT=hapvida                      # dev form (build block + demo fixtures)
#   make up-prod CLIENT=hapvida                 # production form (image ref only)
#   make migrate CLIENT=hapvida
#   make migrate-up CLIENT=hapvida              # mongo -> migrate -> stack: índices ANTES do primeiro writer (G-2)
#   make seed-prices CLIENT=hapvida             # DEV ONLY: PoC demo price table
#   make sync CLIENT=claro FROM=2026-07-01 TO=2026-07-22
#   make price CLIENT=vivo ARGS='--model ... --token-type ... --price-brl ... --effective-from 2026-07-01'
#   make billing-close CLIENT=vivo YEAR=2026 MONTH=6   # T6: fecha o mês (snapshot)
#   make billing-reopen CLIENT=vivo YEAR=2026 MONTH=6 REASON='...'
#     (auto-close opt-in: COMPOSE_PROFILES=billing-auto-close no env do
#     cliente sobe o sidecar billing-close-scheduler — decisão 131; `make
#     logs` o inclui quando ativo)
#   make logs CLIENT=vivo
#   make backup CLIENT=vivo                     # mongodump of the permanent archive -> backups/
#   make down CLIENT=claro                      # stop one client (volumes preserved)
#   make ps                                     # all compose projects on this host
#   make deploy-smoke                           # regressão dos scripts de deploy (sem docker)
#   make test                                   # as três suítes (core+module+connector) + typecheck
#
# Continuous ingestion: once LANGWATCH_PROJECT_ID is set in the client env
# (scripts/3-onboard-langwatch.sh writes it), the trace-ingestion-worker
# sidecar syncs automatically via direct ClickHouse reads — the ONLY real
# source (decision 127; the HTTP ingestion path no longer exists).
# `make sync` remains for manual backfills (same ClickHouse source, no
# window cap) and for offline fixture demos, which require the EXPLICIT
# TRACE_SOURCE=fixtures in the client env — without a source, sync
# crashes instead of guessing.

.DEFAULT_GOAL := help

ENVFILE = clients/$(CLIENT).env
# `env -u`: compose interpolation ranks the OS environment ABOVE --env-file,
# so an exported LANGWATCH_PROJECT_ID (e.g. from onboarding a LangWatch
# instance) would leak into every stack — and an exported
# COMPOSE_PROJECT_NAME would collapse two clients into one project. The
# env file is the only source of truth for these.
# EVERY variable a compose file interpolates must be listed here — a var
# that escapes the scrub silently overrides all client env files at once.
SCRUB = env -u COMPOSE_PROJECT_NAME -u CLIENT_NAME -u CLIENT_TIMEZONE -u API_PORT \
          -u LANGWATCH_PORT -u LANGWATCH_PUBLIC_URL -u LANGWATCH_PROJECT_ID -u TRACE_SOURCE \
          -u API_BIND -u LANGWATCH_BIND -u UI_BIND \
          -u KHAL_DISCOVERY_URL -u KHAL_TENANT -u KHAL_CLIENT_ID -u KHAL_CLIENT_SECRET \
          -u CORS_ALLOWED_ORIGINS \
          -u MONGO_DB_HOST -u MONGO_DB_PORT -u MONGO_MEMORY_LIMIT \
          -u MONGO_DB_USER -u MONGO_DB_PASSWORD -u MONGO_HOST_PORT -u MONGO_DB_ATLAS \
          -u MONGO_DB_NAME \
          -u MODULE_IMAGE -u CONNECTOR_IMAGE -u UI_IMAGE -u UI_PORT \
          -u LW_NEXTAUTH_SECRET -u LW_API_TOKEN_JWT_SECRET -u LW_CREDENTIALS_SECRET \
          -u TRACE_INGESTION_INTERVAL_SECONDS -u TRACE_INGESTION_BATCH_SIZE \
          -u TRACE_INGESTION_QUIET_PERIOD_SECONDS -u REPROCESS_INTERVAL_SECONDS \
          -u LOG_LEVEL -u LOG_FORMAT \
          -u COMPOSE_PROFILES -u BILLING_AUTO_CLOSE_DELAY_MINUTES \
          -u BILLING_AUTO_CLOSE_CHECK_INTERVAL_SECONDS \
          -u LANGWATCH_WORKERS_REPLICAS -u LANGWATCH_MEMORY_LIMIT \
          -u LANGWATCH_WORKERS_MEMORY_LIMIT -u LW_POSTGRES_MEMORY_LIMIT \
          -u LW_REDIS_MEMORY_LIMIT -u LW_CLICKHOUSE_MEMORY_LIMIT \
          -u LW_CLICKHOUSE_CPU_LIMIT
# Role files (decision 65): module (api+ui) + connector (LangWatch +
# trace-ingestion-worker) + database (mongo) merge into ONE project per
# client. Couplings live in the file that introduces them, so dropping a
# role (e.g. external mongo) is a change of THIS list + the client env.
# MONGO_DB_ATLAS=true in the client env IS that drop for the database
# role: the mongo container would just idle unused next to Atlas. The drop
# covers BOTH mongo fragments — the role file and its dev override
# (compose.mongodb.dev.yml): an overlay naming a dropped service would
# invalidate the whole project ("neither an image nor a build context").
ATLAS_MODE = $(shell grep -sqx 'MONGO_DB_ATLAS=true' $(ENVFILE) && echo y)
COMPOSE_FILES = -f compose.module.yml -f compose.connector.yml \
          $(if $(ATLAS_MODE),,-f compose.mongodb.yml)
COMPOSE_PROD = $(SCRUB) docker compose $(COMPOSE_FILES) --env-file $(ENVFILE)
COMPOSE_DEV  = $(SCRUB) docker compose $(COMPOSE_FILES) -f compose.dev.yml \
          $(if $(ATLAS_MODE),,-f compose.mongodb.dev.yml) --env-file $(ENVFILE)
# One-off jobs run in the PROD form — none of them read demo fixtures, and
# the dev overlay would auto-create a root-owned demo-data/<client> dir.
# --no-deps: without it, `run` reconciles the mongo service against THIS
# form's config and recreates a dev-form mongo (dropping its Compass port).
# Jobs therefore require the stack to be up (`make up` first).
JOB = $(COMPOSE_PROD) run --rm --no-deps api node
# sync is the exception: the fixture-backed fake client (explicit
# TRACE_SOURCE=fixtures, decision 127) needs this client's demo fixtures
# mounted — use the dev form exactly when generated fixtures exist, the
# prod form otherwise.
SYNC_COMPOSE = $(if $(wildcard demo-data/$(CLIENT)/*.json),$(COMPOSE_DEV),$(COMPOSE_PROD))

.PHONY: help build test up up-prod down logs ps backup migrate migrate-up seed-prices sync price reprocess rebuild-filter-counters rebuild-session-summaries billing-close billing-reopen deploy-smoke require-client

help:
	@grep -E '^#( |$$)' Makefile | sed 's/^# \?//'

# Docker-free regression test of the deploy scripts (no CLIENT — it mints
# and cleans up its own throwaway one). Covers what only a FRESH client
# exercises: step 4 completing with an empty demo-data/ (the dev
# discriminator of decision 74) and every URL staying well-formed when the
# port vars are omitted from the env file, as the contract invites.
deploy-smoke:
	@./scripts/deploy-smoke-test.sh

# The whole gate, one door (audit E-1): every workspace suite plus the
# typecheck the jest source-mapping cannot replace.
test:
	npm run typecheck
	npm run test

require-client:
	@test "$(origin CLIENT)" = "command line" || { echo "pass CLIENT=<name> explicitly on the make command line (env file: clients/<name>.env)"; exit 1; }
	@test -f "$(ENVFILE)" || { echo "missing $(ENVFILE) — copy clients/example.production.env (or example.development.env locally) and fill it in"; exit 1; }
	@grep -qx "CLIENT_NAME=$(CLIENT)" "$(ENVFILE)" || { echo "$(ENVFILE) must contain exactly CLIENT_NAME=$(CLIENT) — a mismatch would split the stack across two identities (e.g. \`make up\` pre-creates demo-data/$(CLIENT) while compose mounts demo-data/\$${CLIENT_NAME})"; exit 1; }
	@grep -qx "COMPOSE_PROJECT_NAME=$(CLIENT)" "$(ENVFILE)" || { echo "$(ENVFILE) must contain exactly COMPOSE_PROJECT_NAME=$(CLIENT) — otherwise this client's containers land in another compose project"; exit 1; }

build:
	docker build -f docker/module.Dockerfile -t platform-module:local .
	docker build -f docker/connector.Dockerfile -t platform-connector:local .
	docker build -f docker/ui.Dockerfile -t platform-ui:local .

# --remove-orphans: a renamed service (e.g. sync-worker →
# trace-ingestion-worker) would otherwise leave the old container running
# alongside the new one — two ingestors racing the same watermark cursor.
# All containers of a project come from the role files, so orphans are
# always leftovers, never wanted.
up: require-client
	@mkdir -p demo-data/$(CLIENT) # user-owned before docker can root-create it via the bind mount
	$(COMPOSE_DEV) up -d --remove-orphans

up-prod: require-client
	$(COMPOSE_PROD) up -d --remove-orphans

# --remove-orphans on the way DOWN too: after a service rename, plain
# `down` would leave the old container running — a second ingestor.
down: require-client
	$(COMPOSE_PROD) down --remove-orphans

logs: require-client
	$(COMPOSE_PROD) logs -f

ps:
	@docker compose ls

# Backup of the permanent archive (invariant 6: this store is the archive —
# LangWatch only retains ~49 days). mongodump streamed out of the client's
# mongo container into backups/<client>-<timestamp>.gz; auth flags expand
# inside the container from its own MONGO_INITDB_ROOT_* env, so this works
# with or without mongo credentials. Run it before any `down -v`.
# Restore into a running stack — --drop replaces existing collections, so
# this restores into an EMPTY database or overwrites (audit G-4: without
# --drop, mongorestore merges and a re-run silently double-inserts):
#   docker exec -i <client>-mongo sh -c 'mongorestore --archive --gzip --drop \
#     ${MONGO_INITDB_ROOT_USERNAME:+-u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin}' \
#     < backups/<file>.gz
# then `make rebuild-filter-counters` + `make rebuild-session-summaries`.
backup: require-client
	@mkdir -p backups
	@out="backups/$(CLIENT)-$$(date +%Y%m%dT%H%M%S).gz"; \
	if docker exec $(CLIENT)-mongo sh -c 'mongodump --archive --gzip $${MONGO_INITDB_ROOT_USERNAME:+-u "$$MONGO_INITDB_ROOT_USERNAME" -p "$$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin}' > "$$out"; then \
	  echo "backup: $$out ($$(du -h "$$out" | cut -f1))"; \
	else \
	  rm -f "$$out"; echo "backup falhou — a stack do cliente está no ar? (make up CLIENT=$(CLIENT))"; exit 1; \
	fi

# ---- one-off jobs ----

migrate: require-client
	$(JOB) dist/main/jobs/run-migrations.js

# The deploy order that cannot double-count (audit G-2): the ingestor's
# insert-once IS the unique traceId index, so the worker must never start
# against an unmigrated store. mongo first, migrate against it, THEN the
# full stack. (The writers also assert the index at startup and refuse to
# run — this target is the order that never trips that guard.)
migrate-up: require-client
	$(COMPOSE_PROD) up -d mongo
	$(JOB) dist/main/jobs/run-migrations.js
	$(COMPOSE_PROD) up -d --remove-orphans

# DEV ONLY (decision 74): seeds the PoC demo price table (formerly migration
# 002). Gated on the same dev discriminator as `make sync` (demo-data/
# fixtures present) — prod prices are registered exclusively via `make price`
# (invariant 9).
seed-prices: require-client
	@test -n "$(wildcard demo-data/$(CLIENT)/*.json)" || { echo "seed-prices é DEV ONLY — '$(CLIENT)' não tem demo-data/ (preços de produção: make price)"; exit 1; }
	$(JOB) dist/main/jobs/seed-poc-prices.js

sync: require-client
	@test -n "$(FROM)" -a -n "$(TO)" || { echo "usage: make sync CLIENT=<name> FROM=YYYY-MM-DD TO=YYYY-MM-DD"; exit 1; }
	$(SYNC_COMPOSE) run --rm --no-deps trace-ingestion-worker node dist/main/jobs/run-sync.js --from $(FROM) --to $(TO)

# --effective-from is spelled the SAME way POST /prices spells it (C-2 —
# the two doors cannot diverge): YYYY-MM-DD reads as UTC midnight, and a
# datetime MUST carry Z or an offset. Anything else is refused instead of
# guessed: "01/07/2026" used to parse as 7 January and stamp six months of
# pending traces with a price nobody contracted (invariant 1 — immutable).
price: require-client
	@test -n "$(ARGS)" || { echo "usage: make price CLIENT=<name> ARGS='--model <provider/id> --token-type <input|output|cache_read|cache_write> --price-brl <e.g. 2.75> --effective-from <YYYY-MM-DD | 2026-07-01T00:00:00Z>'"; exit 1; }
	$(JOB) dist/main/jobs/insert-price-version.js $(ARGS)

reprocess: require-client
	$(JOB) dist/main/jobs/reprocess-pending.js

# T6 runbook (decision 87): the ONLY month-close trigger in v1. Blocked
# while any pending_price trace exists in the month; the job output is the
# admin's notification (US5).
billing-close: require-client
	@test -n "$(YEAR)" -a -n "$(MONTH)" || { echo "usage: make billing-close CLIENT=<name> YEAR=YYYY MONTH=1-12"; exit 1; }
	$(JOB) dist/main/jobs/close-billing-period.js --year $(YEAR) --month $(MONTH)

# Audited reopen (T6): REASON is mandatory and lands in the period's audit
# trail. Prior snapshots stay; the next close writes version+1. Interactive
# confirmation (reopening a closed month is the exceptional flow) — pass
# FORCE=1 to skip it in automation.
billing-reopen: require-client
	@test -n "$(YEAR)" -a -n "$(MONTH)" -a -n "$(REASON)" || { echo "usage: make billing-reopen CLIENT=<name> YEAR=YYYY MONTH=1-12 REASON='<motivo>' [FORCE=1]"; exit 1; }
	@test -n "$(FORCE)" || { printf 'Reabrir %s-%s de %s? [y/N] ' "$(YEAR)" "$(MONTH)" "$(CLIENT)"; read ans; case "$$ans" in [yY]) ;; *) echo "abortado (FORCE=1 pula a confirmação)"; exit 1;; esac; }
	$(JOB) dist/main/jobs/reopen-billing-period.js --year $(YEAR) --month $(MONTH) --reason "$(REASON)"

# Recompute the facet cube (decision 77) from the traces collection —
# one-time after restoring pre-existing data; anytime to repair drift.
# STOP the ingestion worker first (audit F-1): the $out swap discards any
# write the worker makes mid-rebuild — the job refuses to finish if it
# detects concurrent ingestion.
#   docker compose ... stop trace-ingestion-worker
rebuild-filter-counters: require-client
	$(JOB) dist/main/jobs/rebuild-filter-counters.js

# Recompute the sessions read-model (decision 80) from the traces
# collection — one-time after restoring pre-existing data; ingestion
# maintains it by recompute-on-touch from then on. STOP the worker first
# (audit F-1) — see rebuild-filter-counters.
rebuild-session-summaries: require-client
	$(JOB) dist/main/jobs/rebuild-session-summaries.js
