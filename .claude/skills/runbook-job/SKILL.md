---
name: runbook-job
description: Add an operator-run job to the Day-2 runbook surface (one-shot CLI or long-running daemon under main/jobs). Use when creating maintenance jobs, backfills, schedulers, or any "make <something>" operational command.
---

# Runbook job — the operator surface

Jobs live in `packages/<pkg>/src/main/jobs/` and come in two kinds with
DIFFERENT logging rules (this distinction is codified in ESLint):

- **One-shot runbook CLI** (close/reopen, price insert, rebuilds): human
  at a terminal — `console.log`/`console.error` is CORRECT here (usage
  hints, ✖ errors, report lines). Exemplar:
  `packages/module/src/main/jobs/close-billing-period.ts`.
- **Long-running daemon** (worker loops, schedulers): container logs —
  MUST use the injected `Logger` port (structured JSON), never console.
  Exemplar: `run-billing-close-scheduler.ts` (graceful shutdown flag,
  interruptible sleep, backoff, progress heartbeat).

## File set

1. **Job entry**: `main/jobs/<verb-noun>.ts`. Compose everything through
   `main/factories/*` (never deep-import infrastructure); daemons create
   their logger via `makeLogger({ component: '<job-name>' })`, echo their
   resolved knobs in the first log lines, and beat a PROGRESS heartbeat
   only after completed cycles (error paths deliberately don't beat).
2. **Wiring spec**: `main/jobs/<verb-noun>-wiring.spec.ts` — asserts the
   composition (right use case, right trigger/knobs), following the
   existing `*-wiring.spec.ts` files as exemplars.
3. **Makefile target**: follows the house idiom —
   `<target>: require-client` + the `$(JOB)`/compose invocation (which is
   already SCRUB-wrapped). New interpolated env vars → `env-knob` skill.
4. **npm script** in the package's `package.json` for the dev loop
   (`tsx src/main/jobs/<x>.ts` shape, mirror neighbors).
5. **README Day-2 entry**: one line in the runbook/Day-2 section saying
   what the job does and when an operator runs it.
6. **Compose service** ONLY for daemons — mirror an existing sidecar
   (profile-gated when opt-in, fixed `container_name`, progress-file
   healthcheck, `stop_grace_period`).

## Verify

```bash
npm run test:unit:ci -w <package>     # wiring spec included
make -n <target> CLIENT=<any>         # dry-run: the command composes
npm run lint                          # console rule: allowed in jobs only
```
If the job changes billing/spec behavior, record it via `append-decision`.
