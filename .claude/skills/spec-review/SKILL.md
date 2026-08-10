---
name: spec-review
description: Review a diff/branch against the spec before declaring a story done — acceptance criteria, invariants, decision traceability, test-suffix correctness. Use before "done", before opening a PR, or when asked to check work against the backlog.
---

# Spec review — diff vs the source of truth

READ-ONLY: this skill produces a verdict table, never edits.

## Gather

1. The diff: `git diff <base>...HEAD` (or the working tree vs HEAD).
2. `BACKLOG=$(ls docs/produto/backlog-*.md | sort -V | tail -1)` — locate
   the story (T<n>/US<n>) this work implements and extract its acceptance
   bullets verbatim.
3. CLAUDE.md invariants + working agreements.

## Check, in order

1. **Acceptance criteria**: for each bullet — met (name the evidence:
   file/test), partially met, or missing. A bullet with no test backing
   is at best "partially met".
2. **Invariants**: list every invariant the diff plausibly touches
   (money, immutability, client-facing projections, tenancy, logging…)
   and state why it holds. Look for violations by construction, e.g. a
   projection schema gaining a forbidden field, a float touching money,
   a re-price of stored stamps.
3. **Traceability**: new/changed behavior that implements a numbered
   decision or answers a QA carries the comment marker
   (`decision NN` / `// QAnn:`). Decisions taken DURING the work must be
   in the log (`append-decision`) — implicit decisions are findings.
4. **Test discipline**: new test files use the right suffix
   (`*.spec.ts` unit / `*.test.ts` integration — check imports: anything
   touching Mongo/harness must be `.test.ts`); unhappy paths covered for
   new endpoints (400 shape, empty results).
5. **Boundaries & gates**: `architecture-boundaries.spec.ts` passes;
   `npm run lint` clean; `node scripts/spec-check.mjs` passes.

## Output

A verdict table — one row per acceptance bullet + one per touched
invariant + one per gate — each PASS / FAIL / PARTIAL with a one-line
evidence pointer. End with the blocking items (anything FAIL) listed
imperatively. No fix is applied from this skill; fixes are follow-up work.
