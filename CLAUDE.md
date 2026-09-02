# CLAUDE.md — AI Agent Platform (Traces · Sessions · Billing)

This repo implements the **PoC of the platform API**: one API, three faces —
**Billing** (what it cost), **Traces** (the real executions behind it),
**Sessions** (the conversations those executions belong to). Data source:
**LangWatch** (the connector between the agents and this platform).

Full product context lives in `docs/produto/` — treat those files as the
source of truth for scope, acceptance criteria, decisions, and open questions:

- `docs/produto/backlog-v2.3.md` — the whole backlog (épicos, tech stories
  T1–T11, user stories, critérios de pronto, adiados, log de decisões, QAs)
- `docs/produto/poc.md` — exactly what this PoC builds, in what order, and
  what "demo done" means
- `docs/produto/kickoff-prompt.md` — the first-task prompt (already consumed
  if you are reading this mid-project)

## Architecture in one line

LangWatch API → trace-level sync → **price stamping at write time** (each
trace is stored already priced) → own permanent store (traces + spans + full
content) → live views (traces/sessions) + monthly aggregates (billing).

## Package layout (decision 125 — module ⊥ connector)

Ubiquitous language: this repo is the **observability COMPONENT** of Khal
OS; a component = **module + connector** (hence the npm scope
`@observability/`). npm workspaces, one component, one version:

- `packages/core` (`@observability/core`) — the store and its rules: domain models,
  price-stamper, reprocess, ALL MongoDB repositories, migrations, the one
  date rule (`iso-date-rule`). Bottom of the graph — imports no `@observability/*`.
- `packages/module` (`@observability/module`) — the read API (traces/sessions/
  billing), prices, month lifecycle, server. **Vendor-blind by package**:
  no `langwatch` string anywhere; `@observability/connector` is a devDependency for
  test seeding ONLY (route harness + pipeline test), enforced by test.
- `packages/connector` (`@observability/connector`) — the trace-source side:
  the LangWatch ClickHouse adapter + the fixture fake (decision 127 —
  no HTTP adapter; ClickHouse is the only real source), syncTraces/
  syncBatches, ingestion bookkeeping repos, worker loop + `run-sync` job.

Graph: `module → core ← connector` (never module ↔ connector in production
code). Docker mirrors it: `platform-module` (vendor-free by construction)
and `platform-connector` (worker + fixtures) — see `docker/*.Dockerfile`.
Each package has its own `architecture-boundaries.spec.ts`; cross-package
imports count as the layer they name (`@observability/core/<layer>/…`).

## Invariants — never violate these

1. **Price is stamped at ingestion and is immutable.** The stamp uses the
   price version **effective on the trace's date** (as-of at write time —
   confirmed, decision 138). A later price change NEVER re-prices a stored
   trace; it only affects traces ingested afterward.
2. **A trace with no applicable price is stored as `pending_price`** — tokens
   kept, cost open, excluded from R$ totals. It is NEVER valued at R$ 0.00.
   When the price is registered (open month only), pending traces get stamped.
   Corollary (decision 128): a trace with a MODEL but zero measured tokens is
   `no_measured_usage` — cost unknown, not zero; excluded from totals, counted
   on the summary, and it does NOT block month close. A trace with NO model
   and no tokens is genuinely free work and stays stamped at R$ 0.00.
3. **One store, one truth.** Billing aggregates are **sums of stamped trace
   costs** — never an independent calculation path. Session cost = exact sum
   of its traces' costs. An automated consistency check may assert
   `billing aggregate ≡ Σ stamped costs` for open periods; divergence is a
   defect, not a footnote.
4. **Client-facing data is R$ only.** US$, PTAX, markup, and internal cost
   fields must not exist in client-facing projection schemas — absent by
   construction, not hidden by the UI.
5. **Single-tenant.** One client per deployment. No tenant keys in the domain
   model. `domain`/`subdomain` are plain optional strings on traces.
6. **Store everything.** Traces, spans, and full input/output content
   (unmasked — logged decision). LangWatch retains only ~49 days, so this
   store is the permanent archive; the sync is data-loss prevention.
7. **Attribution (agent/metadata) is mutable in open periods; the price stamp
   is not.** Corrections re-aggregate, never re-price.
8. **Billing period = calendar month in the CLIENT's timezone** (decision
   130: the required `CLIENT_TIMEZONE` env knob sets billing boundary ≡
   display zone; snapshots record their zone, changes are forward-only).
   Current month is always partial and
   must be labeled so. A month closes (T6) only when fully past, via the
   audited close flow — the runbook, or the opt-in auto-close sidecar
   (decision 131; both through the ONE use case, `trigger` recorded); a
   closed month is served exclusively from its immutable snapshot — never
   recomputed.
9. **Prices are versioned data** (no admin UI in v1), registered via
   `POST /api/v1/prices` or the `price:insert` runbook job — both share ONE
   use case (canonical model key + immediate reprocess, decisions 82/57/83).
   Versions are immutable — changes are new inserts with `effective_from`;
   duplicates answer 409; the model list is data, not code. How a price's R$
   is RESOLVED is a declared, dispatched property (`pricingType`, decision
   96) — today only `fixed_brl`; an unknown type yields no effective price
   ⇒ `pending_price`, never a guessed cost.
10. **Text-only agents** in v1; every trace carries a `channel` field so voice
    can arrive later without a migration.

## PoC scope (see docs/produto/poc.md for details)

IN: T4 price table (seeded via the dev-only `make seed-prices` job — decision
74; migrations carry only index bootstrap) · T2 sync (QA14 RESOLVED; decision
127: direct-ClickHouse reads are the ONLY real source — no client ever
ingests over HTTP, that adapter was removed. The fixture-backed
`FakeTraceSourceClient` serves offline demos/tests behind the EXPLICIT
`TRACE_SOURCE=fixtures` opt-in; with no source configured the sync CRASHES
instead of guessing. Selection composed and logged in the connector's
`sync-factory.ts`) · T5 stamping · T3 store (traces/spans/content) ·
endpoints `GET /traces`, `GET /traces/:id`, `GET /sessions`,
`GET /sessions/:id` (session = derived read-model grouped by `session_id`) ·
one billing aggregate endpoint (month × agent × model) that visibly equals
the sum of stamped costs.

OUT: RBAC, voice, masking/retention, admin UIs, alerts.

Billing épicos 5–8 (added post-PoC, decisions 87–123; the package
layout above is decisions 124–127 —
`docs/produto/billing-implementacao.md` is the working doc): T6 month
lifecycle (open→closed; `make billing-close`/`billing-reopen` runbook, plus
the opt-in auto-close sidecar behind the `billing-auto-close` compose
profile — decision 131; close blocked while pending_price exists (the
scheduler retries every cycle — QA5 resolved: the bill waits); snapshot =
inputs + outputs + audit, all versions kept; reproducibility is an
automated acceptance test) ·
T7 statement read layer (`GET /billing/summary` serves a CLOSED month
exclusively from its snapshot, open months live via the SAME pure engine —
`statement-engine.ts` is the one calculation; `/bills` carries period
status) · T8 series + current-month run-rate projection (estimate only,
never persisted) · T9 composition (model mix, cache savings with explicit
write cost) · US17 exports (CSV + printable HTML; current month watermarked
PARCIAL). Post-close arrivals are archived but `billingQuarantine`-flagged
until the next close adjudicates them (decision 100); reprocess skips closed
months. Runbook vocabulary also includes `make backup` (mongodump of the
permanent archive — run it before any `down -v`).

Auth (added post-PoC): env-gated SESSION auth on `/api/v1` — with
`KHAL_AUTH_URL` set, every request needs a khal-auth session JWT, verified
locally against the JWKS at `${KHAL_AUTH_URL}/.well-known/jwks.json`
(RS256; `iss` == the URL, `aud` matching ANY entry of the comma-separated
`KHAL_TOKEN_AUDIENCE`, default `tracing,billing`; `tenant` claim ==
`KHAL_TENANT`, required with the URL; `exp`
checked) — except `/api/v1/docs*` and `openapi.json`, which stay open as
the container healthcheck and integration surface (decision 103; OPTIONS
preflight also bypasses), and `GET /health`, open by platform convention
(decision 172: liveness for orchestrators and the Catalog Console's
browser probe — registered after CORS, before the gate). Identity-only, no scopes (ADR-95) — the module
holds no scope logic, a platform invariant, not an omission. The retired
names (the discovery quartet, the interim `BASIC_AUTH_*` gate of decision
141) have NO aliases. Nothing configured → API open (PoC behavior, loud
warn at boot).

## Working agreements

- Follow the boilerplate's existing conventions (structure, naming, error
  handling, testing style) — do not introduce a parallel style.
- Logging (decision 134): production code logs through the `Logger` port
  (`@observability/core/common/logging`) injected from the composition
  roots (`makeLogger` per image) — never `console`, enforced by ESLint
  `no-console`. The ONE exception is `main/jobs/**` one-shot runbook CLIs
  (operator-facing terminal output); the long-running daemons in that
  directory still use the Logger. Knobs: `LOG_LEVEL`
  (trace…fatal|silent, default info; silent under test) and `LOG_FORMAT`
  (json|pretty, default json; pretty in development) — one shared reader
  in core (`parse-log-env`). Tests assert logs via the injected
  `RecordingLogger` (logging-test-fakes), never by spying console.
- Gates (decision 135): husky pre-commit (lint-staged), commit-msg
  (commitlint — conventional commits), pre-push (typecheck + lint +
  format:check + unit suites). CI (`.github/workflows/ci.yml`) is the
  authority: lint/format, typecheck, `npm run test:ci` (build +
  packaging-check + unit/integration + coverage ratchet), commitlint.
  `npm run lint` / `npm run format` from the root.
- Money: integer cents (or decimal type) — never floats. Full precision at
  line level; round only displayed totals (half-up, 2 decimals).
- Ingestion must be idempotent: re-running a sync window never double-counts.
- Test suffixes are load-bearing: `*.spec.ts` = unit (no Mongo), `*.test.ts`
  = integration (real Mongo) — the two jest configs select by suffix, so a
  misnamed file silently runs in the wrong suite.
- When a decision is made during implementation, append it to the decision
  log in `docs/produto/backlog-v2.3.md` instead of leaving it implicit.
- Spec workflows are SKILLS, not memory (decision 137): recording decisions
  (`append-decision`), resolving QAs (`resolve-qa`), new endpoints
  (`feature-slice`), env vars (`env-knob`), operator jobs (`runbook-job`),
  done-checks (`spec-review`), new stories (`author-story`), onboarding
  (`spec-kickoff`) — all under `.claude/skills/`. `scripts/spec-check.mjs`
  (CI + pre-push) mechanically enforces decision-log numbering, RESOLVIDA
  references, code decision/QA markers, and Makefile SCRUB completeness.
- Open questions (QA1–QA19) are listed at the end of the backlog doc. QA14
  (LangWatch API fidelity) is RESOLVED (spike 2026-07-20, decision 40) —
  `// QA14:` comments now mark fidelity findings (e.g. the search-cap
  guard), not pending work. QA19 (stamp rule) is RESOLVED too (decision
  138: price effective on the TRACE's date, as-of at write time; price
  `effective_from` stays a UTC-instant comparison) — `// QA19:` comments
  mark where that rule lives, not pending work.
