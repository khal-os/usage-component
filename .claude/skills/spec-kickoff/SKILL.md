---
name: spec-kickoff
description: Onboard into this repo's spec system before starting a work phase — read order, planning discipline, marker conventions. Use at the start of a substantial task, when joining the project fresh, or when asked to "get up to speed" / "kickoff".
---

# Spec kickoff — how work starts here

## Read order (before any code)

1. `CLAUDE.md` — the constitution: package layout, the numbered
   invariants, working agreements. Invariants are non-negotiable.
2. `docs/produto/poc.md` (or the current scope doc) — what "done" means.
3. `BACKLOG=$(ls docs/produto/backlog-*.md | sort -V | tail -1)` — the
   story being worked; then the TAIL of the decision log (last ~10 rows:
   the freshest constraints) and the open-questions registry (what is
   deliberately unresolved).
4. `docs/audit/` — if working near a subsystem with an audit, its
   findings explain the scars (`audit X-N` code comments resolve here).

## Working discipline

- **Plan before code**: map the story's acceptance bullets to the files
  you intend to create/change, in dependency order. Surface conflicts
  between the plan and the invariants BEFORE implementing, not after.
- **Decisions are law until superseded**: code contradicting a decision
  row is a bug or requires `append-decision` (with supersession
  annotation) first — never a silent divergence.
- **Open questions stay visible in code**: where an implementation choice
  depends on an unresolved QA, mark it `// QA<n>:` and follow the
  documented default; when answered, `resolve-qa` flips the markers.
- **New decisions made mid-implementation** go straight to the log via
  `append-decision` — an undocumented decision is implicit scope drift.
- Follow the existing conventions (structure, naming, error handling,
  testing style) — never introduce a parallel style. When unsure, find
  the nearest exemplar and mirror it.
- Money is never a float. Suffix rules are load-bearing
  (`*.spec.ts` unit / `*.test.ts` integration). Logging goes through the
  injected Logger port; console only in `main/jobs/**` one-shot CLIs.

## The companion skills

| Doing | Skill |
|---|---|
| Recording a decision | `append-decision` |
| Answering an open question | `resolve-qa` |
| New endpoint/capability | `feature-slice` |
| Any env var change | `env-knob` |
| Operator job / daemon | `runbook-job` |
| Declaring work done | `spec-review` |
| Specifying new scope | `author-story` |

## Gate

`node scripts/spec-check.mjs` + `npm run lint` + the package test suites
must be green before AND after your work — a red baseline is a finding,
not a starting point.
