# AI Agent Platform — PoC (Traces · Sessions · Billing)

One API, three faces — **Billing** (what it cost), **Traces** (the real
executions behind it), **Sessions** (the conversations those executions belong
to). Data source: **LangWatch**. Product context, scope, and the decision log
live in [docs/produto/](docs/produto/) (see `CLAUDE.md` for the invariants).

## Deployment model (single-tenant by construction)

**One client = one compose project, fully self-contained.** The same three
compose role files ([module](compose.module.yml) + [connector](compose.connector.yml) + [mongodb](compose.mongodb.yml)) are applied once per client with that
client's env file — nothing in the images, the compose files, or the
application knows any client:

```
one client deployment (8 containers, own network, own volumes):
┌──────────────────────────────────────────────────────────────┐
│ api (:API_PORT) ─────────────────────────► mongo (own volume) │
│                                              ▲               │
│                     trace-ingestion-worker ──┘               │
│                      │  continuous ingestion: watermark      │
│                      │  loop, price-stamp at write           │
│                      │  (decisions 59-63)                    │
│                      ▼                                       │
│ langwatch (:LANGWATCH_PORT) ── workers                       │
│   ├─ postgres   ├─ redis   └─ clickhouse ◄── (direct read)   │
└──────────────────────────────────────────────────────────────┘
```

Default host ports: API `3000`, LangWatch `5560` — and both
bind to **loopback by default** (decision 105): reachable from the host only
via `localhost` unless the client env sets `API_BIND`/`LANGWATCH_BIND`
explicitly (exposure beyond localhost is a deliberate operator act).

Ingestion is **continuous and automatic**: once the client is onboarded
(`LANGWATCH_PROJECT_ID` set — onboarding writes it), the
`trace-ingestion-worker` sidecar reads new traces straight from the
LangWatch stack's ClickHouse — the ONLY real source (decision 127) —
stamps prices at write time, and stays ~15–16 min behind live (15-min
quiet period so incrementally-built traces settle before their immutable
price stamp — `TRACE_INGESTION_*` knobs in the env contract). Before
onboarding the worker exits and restart-loops **visibly** (audit G-1 — an
idle worker used to read "healthy" while ingesting nothing); onboarding
brings it up for real. Offline demos run `make sync` with the explicit
`TRACE_SOURCE=fixtures` in the client env.

The env file is the whole contract and the client's **deployment state** —
identity, **business timezone** (`CLIENT_TIMEZONE`, required — decision 130:
billing boundary ≡ display zone, forward-only after a close), ports, mongo
credentials, logging knobs (`LOG_LEVEL` trace…fatal|silent, default info;
`LOG_FORMAT` json|pretty, default json — decision 134: structured JSON
lines on stdout, one shared reader for both images), LangWatch project id
+ per-instance secrets, image pin (the LangWatch API key deliberately lives elsewhere —
decision 127: it is the agents' credential, kept in LangWatch's own
Postgres and copied from the UI into the platform vault). [clients/example.production.env](clients/example.production.env)
is the committed full contract ([clients/example.development.env](clients/example.development.env)
is the lean workstation shape); real files are gitignored and treated as the
single source of truth for every operation (lose one and you lose the stack's operational
identity — the LangWatch admin password is only recorded there).
**Back up `clients/*.env` somewhere durable after each deploy** — until a
CI/secret store owns these values, the files are the only copy. In CI, the
pipeline holds the same keys as protected variables and writes the env file
(or exports the vars) before running the same compose command.

## Deploying a demo client (dev tool — NEVER in production)

```bash
./deploy-demo-client.sh <name>
```

One idempotent command does everything: env file with generated secrets and
auto-allocated free ports → images (built if missing) → 9-container stack →
health waits → migrations → **automatic LangWatch onboarding** (registers
`admin@<name>.com` with a random password — printed in the summary and noted
in the env file — creates organization + project via the instance's own API,
stamps the project id into the env, recreates the worker with real sync
enabled) → **demo data** (deterministic traffic generated for this client,
PoC price table via `make seed-prices` + premium-model prices, pushed into
its LangWatch, ingested through the real
sync — every trace priced between R$ 1 and R$ 100). The summary prints the
API, LangWatch and Compass URLs plus the login credentials.

Options: `--api-port/--langwatch-port/--mongo-host-port` to pin
ports, `--mongo-user/--mongo-pass` for an auth-enabled mongo (before first
boot), `--image REF` to pin the MODULE image and `--connector-image REF`
the CONNECTOR image (defaults `platform-module:local` /
`platform-connector:local` — pin BOTH for a released deploy, or the worker
falls back to a local tag that exists on no fresh host and crash-loops
while the api stays healthy). Re-running completes/updates a
deployment — secrets are never regenerated, data is never duplicated.

## Production deployment

The script above is a workstation tool (it mints secrets locally,
self-onboards LangWatch and injects fake traffic). For a **single-VM
public deploy** (demo-grade real infra: caddy in front, everything else
loopback-bound) follow `deploy/RUNBOOK-VM.md`. A production deploy is
the raw contract, driven by CI: materialize the client's env file from the
protected variable store — including the required `LANGWATCH_PUBLIC_URL`,
the browser-visible LangWatch URL (clients/example.production.env) — then apply the
production form —

```bash
docker compose -f compose.module.yml -f compose.connector.yml -f compose.mongodb.yml --env-file <client>.env up -d mongo
docker compose -f compose.module.yml -f compose.connector.yml -f compose.mongodb.yml --env-file <client>.env run --rm --no-deps api node dist/main/jobs/run-migrations.js
docker compose -f compose.module.yml -f compose.connector.yml -f compose.mongodb.yml --env-file <client>.env up -d
```

(no `compose.dev.yml`, prebuilt registry images via `MODULE_IMAGE`/`CONNECTOR_IMAGE`).
**The order is the contract** (audit G-2): mongo first, migrations against
it, and only then the full stack — starting the ingestion worker before the
unique `traceId` index exists opens a window where a re-read stores the same
trace twice, each with its own immutable price stamp. `make migrate-up
CLIENT=<name>` is exactly this sequence; the writers also assert the index
at startup and refuse to run, so a wrong order crashes loudly instead of
double-counting quietly.

**The migration step is not optional and it is not automatic** — no image,
entrypoint or service runs it (`make migrate` is the only door), so a stack
brought up without it has **no indexes**, and the indexes carry correctness,
not speed: the ingestor's insert-once *is* the unique `traceId` index (without
it the same trace is stored twice, with its own price stamp and its own facet
increment — `make sync` stops being idempotent), and the 409 on a duplicate
price version *is* the E11000 of the unique `(model, tokenType,
effectiveFrom)` index (invariant 9). Run it **on first boot and after every
image upgrade**: the chain is index bootstrap only (decision 74), and a new
image ships new migrations.

## Day-2 operations (client-generic)

Continuous ingestion runs by itself (the `trace-ingestion-worker` container —
`make logs` shows its batch lines); the commands below are for manual
backfills, price registration, and lifecycle:

```bash
make migrate CLIENT=<name>     # index bootstrap — first boot AND after every image upgrade
make sync CLIENT=<name> FROM=2026-07-01 TO=2026-07-22   # manual backfill (idempotent windows)
make price CLIENT=<name> ARGS='--model ... --token-type ... --price-brl ... --effective-from ...'
# ...or over HTTP (same single path — canonical model key + immediate reprocess):
#   POST /api/v1/prices  {"model","token_type","price_brl_per_million","effective_from"}
make reprocess CLIENT=<name>   # re-stamp pending traces now (price registration and the worker also do this)
make logs CLIENT=<name>
make up CLIENT=<name>          # re-apply the stack (dev form)
make up-prod CLIENT=<name>     # production form
make down CLIENT=<name>        # stop (volumes preserved)
make ps
```

**Dead-lettered traces.** A trace that fails ingestion is parked in the
`ingest_failures` collection (the batch continues; the worker logs the
backlog count each cycle when it is non-zero). Each row carries the
traceId, the error, and the `context` the sync was in when it failed — a
window or a cursor position. Recovery is re-running that context:
`make sync CLIENT=<name> FROM=… TO=…` over the window while LangWatch's
~49-day retention still holds the trace, then delete the row (there is no
resolved flag — a row that exists is a trace the archive is still
missing). Rows with `kind: oversized_unstorable` are the exception: the
trace exceeds the document cap even fully clipped, so no re-sync will fix
it and the row stays as the record. Source rows that never became traces
never reach this collection — their trail is `poison_rows`.

Month lifecycle (T6) is runbook-only — no HTTP mutation endpoint:

```bash
make billing-close CLIENT=<name> YEAR=2026 MONTH=6              # close the month: audited, immutable snapshot; blocked while pending_price exists
make billing-reopen CLIENT=<name> YEAR=2026 MONTH=6 REASON='…'  # audited reopen (REASON required); the next close writes snapshot v+1
```

Backup of the permanent archive (invariant 6 — this store is the archive;
LangWatch only keeps ~49 days):

```bash
make backup CLIENT=<name>   # mongodump -> backups/<name>-<timestamp>.gz
# restore: pipe the .gz into `mongorestore --archive --gzip` inside the mongo
# container (exact command in the Makefile), then rebuild the derived read-models:
make rebuild-filter-counters CLIENT=<name>     # facet cube (required after any restore)
make rebuild-session-summaries CLIENT=<name>   # session read-model (required after any restore)
```

Full wipe of one client — **run `make backup` first**, `down -v` deletes the
permanent archive:
`docker compose -f compose.module.yml -f compose.connector.yml -f compose.mongodb.yml --env-file clients/<name>.env down -v`
plus deleting `clients/<name>.env` and `demo-data/<name>/`.

Manual `make sync` uses the direct-ClickHouse source — the only real one
(decision 127) — with no window cap. Without a configured source it
refuses to run: there is no HTTP fallback anymore, and the fixture fake
requires the explicit `TRACE_SOURCE=fixtures` (offline demos only).

## API auth (env-gated, off by default)

Set the khal quartet in the client env — `KHAL_DISCOVERY_URL` +
`KHAL_TENANT` (the Auth System URL is resolved at runtime from
`/.well-known/registers`, ADR-97) + `KHAL_CLIENT_ID`/`KHAL_CLIENT_SECRET` —
and every `/api/v1` request must carry `Authorization: Bearer <M2M token>`.
The module validates by **introspection** (RFC 7662): it forwards the token
and reads only `active` — authenticated-or-not, no scope or tenant logic
here (that's the platform's M2M model). Introspection is itself a protected
endpoint, so the module needs its **own** M2M credential (the
`KHAL_CLIENT_*` pair, sent as Basic) — without it, and whenever the Auth
System is unreachable or discovery never resolved, requests answer 401
(fail closed). The `KHAL_*` quartet is the ONLY spelling — the
pre-discovery `AUTH_SYSTEM_*` names were removed before any production
deployment (decision 133). Nothing configured → the API is open,
the original PoC behavior.
`/api/v1/docs` stays open either way (container healthcheck).

## LangWatch (per client, inside the deployment)

Each client's stack carries its own LangWatch (pinned
`langwatch/langwatch:3.5.0` + postgres/redis/clickhouse, mirroring the
official upstream compose). Onboarding is automated by the deploy script;
the manual path still works (sign up in the browser, create org+project,
then re-run `3-onboard-langwatch.sh` — it backfills the project id, which
is what turns ingestion on; decision 127). The API key never enters the
env file: agents get it from the vault, the demo push reads it from
LangWatch's Postgres, and offline fixture demos use the explicit
`TRACE_SOURCE=fixtures` instead.

LangWatch retains ~49 days and serves span detail per its plan window — the
platform's own store is the permanent archive (invariant 6).

**Expected divergence — LangWatch's "Tokens" card vs the platform's token
totals.** LangWatch's dashboard headline sums `prompt + completion` tokens
only; the platform sums **all four billed token types** (input, output,
cache_read, cache_write), because cache tokens carry contracted R$ prices
and the token number must stay consistent with the R$ number next to it
(invariant 3 is computed over all four). A cache-heavy client can show a
much larger platform total than the LangWatch card — that difference is
exactly the cache traffic, not a sync bug. The fatura statement's per-type
token bars show the breakdown.

## Demo data

Generated per client by the deploy script (gitignored `demo-data/<name>/`):
a deterministic profile seeded from the client name — agents, channels,
sessions, durations, spans, error rate, three models — dated over the last
~12 days and sized so every stamped cost lands in **R$ 1–100**. It flows the
honest pipeline: pushed into the client's LangWatch via the collector API,
then ingested by the real sync with prices stamped at write time.

`node packages/connector/scripts/generate-demo-fixtures.mjs` (no args) still
produces the three richer PoC profiles (hapvida/claro/vivo);
`--client <name> [--traces N]` produces any client's generic set.

## Client UI (inside the deployment)

nginx serves `packages/ui` and reverse-proxies `/api` to that client's api
service — same origin, no client selector, no addresses in the UI. The
header shows the deployment's client name via `/client.json`, which nginx
templates from `CLIENT_NAME` at container start (the image stays
client-agnostic).

## Operational notes

- **Mongo**: in-stack, no host port in the production form. Dev form
  publishes `127.0.0.1:<MONGO_HOST_PORT>` for Compass/mongosh
  (`mongodb://localhost:<port>/?directConnection=true`, db = client name).
  Direct access without the port: `docker exec -it <client>-mongo mongosh
  <client>`. Auth is opt-in and must be set before first boot.
- **RAM**: LangWatch is the heavy part (~4–5 GB/client with the configured
  caps). On one dev machine, prefer one or two clients at a time; the first
  boot of a client's LangWatch takes ~1–2 min (its own migrations).
- **Images**: `MODULE_IMAGE`/`CONNECTOR_IMAGE`/`UI_IMAGE` pin the platform
  images per deployment (dev defaults `platform-module:local`/
  `platform-connector:local`/`platform-ui:local`). The module image serves
  the API and is vendor-free by construction; the connector image runs the
  trace-ingestion-worker and `make sync`. Only the ROOT
  `package-lock.json` is authoritative; `tsc` always runs in-image because
  the local `dist/` may be stale.
- **LangWatch secrets** (`LANGWATCH_*`) are per instance; `LANGWATCH_CREDENTIALS_SECRET`
  must never change after first boot.
