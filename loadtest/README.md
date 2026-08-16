# Write-path load test — 1000 traces/s into LangWatch, end to end

Measures the whole ingestion chain under sustained OTLP write load:

```
otlp-load-gen ──OTLP/protobuf──► LangWatch app ──redis──► workers ──► ClickHouse
                                                                          │
                    module API ◄── Mongo ◄── trace-ingestion-worker ◄─────┘
```

Two independent verdicts come out:
1. **Front door** — can LangWatch *accept* RATE traces/s? (generator report:
   achieved rate, 2xx%, p95/p99, drops)
2. **Drain** — how long until every accepted trace is *queryable in the
   module*? (watcher: queue depth, ClickHouse rate, Mongo rate)

## Files

- `otlp-load-gen.mjs` — rate-paced OTLP/HTTP protobuf generator, agent-shaped
  traces (root AGENT span + LLM/tool children, token counts, unique ids).
  Zero deps. Writes nothing.
- `watch-pipeline.sh` — one line every 2s with per-stage counts/rates.
- `loadtest-1m-traces.archive.gz` — (older, READ-path asset) 1M synthetic
  traces for query-latency tests; not used by this write test.

## Procedure

**0. Sizing (do this yourself — no script edits env files).** Open
`clients/<name>.env` of the throwaway client and set:

```
LANGWATCH_WORKERS_REPLICAS=2
LW_CLICKHOUSE_MEMORY_LIMIT=3g
LW_REDIS_MEMORY_LIMIT=1g
MONGO_MEMORY_LIMIT=4g
```

**1. Provision a throwaway client** (full stack, no demo data):

```bash
./deploy-demo-client.sh loadtest --no-demo-traces --no-demo-prices
```

Note the `LANGWATCH_PORT` and the LangWatch UI login from the summary.

**2. Get the API key.** Open the LangWatch UI in your browser, log in
(credentials from the step-1 summary), copy the project **API key** from the
project settings/setup page. You'll paste it into the commands below —
nothing stores it.

**3. Terminal A — watcher:**

```bash
CLIENT=loadtest ./loadtest/watch-pipeline.sh
```

**4. Terminal B — the run:**

```bash
LANGWATCH_ENDPOINT=http://localhost:<LANGWATCH_PORT> \
LANGWATCH_API_KEY=<paste from the UI> \
RATE=1000 DURATION=60 node loadtest/otlp-load-gen.mjs
```

Start small first (`RATE=100 DURATION=10`) to confirm 2xx before the real run.

**5. Read the verdicts.**

- Generator report → front-door answer. `dropped > 0` or a growing p99 means
  LangWatch (or the host) can't sustain RATE.
- Watcher → drain answer. Healthy: queue hovers near 0 and `ch_tr/s` tracks
  RATE. Queue growing = LangWatch workers behind (raise
  `LANGWATCH_WORKERS_REPLICAS` + store limits). `ch_tr/s` fine but `mongo/s`
  flat/low = the trace-ingestion-worker is the ceiling (it is deliberately
  1 replica per source — the finding is its per-window sync throughput).
- End-to-end completeness — after the queue and rates settle, Mongo count
  should reach the generator's accepted total:

```bash
docker exec loadtest-mongo mongosh --quiet --eval \
  "db.getSiblingDB('loadtest').traces.countDocuments({})"
```

**6. Tear down:**

```bash
docker compose -p loadtest down -v --remove-orphans && rm -f clients/loadtest.env
```

## On a deployed tenant (the per-account onboarding gate)

The compose run above proves the SHAPE of the pipeline. It does not prove
anything about a client's account — and decision 140's gate (queue grows,
drains, **zero loss**) is what stands between believing the stack holds and
having measured it. The Hetzner PoC died exactly here: the ingest queue grew
into an OOM with no signal (decision 139). With one account per client that
is N chances to repeat it, so **every new account runs this once, on its own
sizing, before real traffic**, and the operator records the pass/fail line.

Same generator (`otlp-load-gen.mjs` is endpoint-agnostic — point
`OTLP_ENDPOINT` at `https://langwatch.<BASE_DOMAIN>`), and the same watcher:

```bash
./loadtest/watch-pipeline.sh --aws <client>
```

It runs the SAME queries — the bullmq `llen`/`zcard` on redis and the
`trace_summaries`/`stored_spans` counts on ClickHouse — on the LangWatch
instance through `ssm send-command` rather than a local `docker exec`, and
reads the Mongo count from the module API's `GET /traces` total instead of
mongosh. Same columns, same verdict rules, so the verdict section above stays
valid. The interval widens to ~10s for the send-command round trip, which is
irrelevant over a 60s burst.

Needs `ssm:SendCommand` on the operator's credentials and nothing new on the
box (the SSM agent is already there for Session Manager). Export
`USAGE_API_TOKEN` if the tenant has session auth on.

`deploy/tenants/example.env` ships at **t3.xlarge with 2 workers and 3g
ClickHouse** — the sizing this procedure calls for — precisely so a new
client does not start below the line its own gate requires. Resizing the box
is an infra action (see `deploy/RUNBOOK-AWS.md` § LangWatch EC2 operations);
bump the capacity knobs in the tenant file alongside, or a bigger box with
the same container limits gains nothing.

## Caveats

- Single-host runs are conservative: the generator, LangWatch, ClickHouse and
  Mongo compete for the same CPU. Good for finding *which stage* saturates
  first; absolute numbers will be better on real infra.
- `SPANS_PER_TRACE` (default 5) sets the real write volume: 1000 traces/s ≈
  5000 spans/s. Test the shape your agents actually produce.
- Ingestion is gated by `LANGWATCH_PROJECT_ID` in the client env (set by
  onboarding); if Mongo stays at 0 forever, check it is filled.
