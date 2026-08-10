---
name: append-decision
description: Record a design/product/architecture decision in the backlog decision log — including superseding, amending, or refining earlier decisions. Use whenever a decision is made during implementation or by the user ("record the decision that…", "add to the decision log", a choice that changes scope/behavior/conventions).
---

# Append a decision to the decision log

The decision log is APPEND-ONLY and strictly sequential. Nothing is ever
edited out; history is corrected by annotation, never by rewrite.

## Discovery (never hardcode)

1. `BACKLOG=$(ls docs/produto/backlog-*.md | sort -V | tail -1)`
2. Find the decision-log table by its header row (a table whose header
   matches `| # |` and a column containing `Decis` or `Decision`).
3. Next number = **max existing number + 1**, computed from the table:
   `grep -oE '^\| [0-9]+ \|' "$BACKLOG" | grep -oE '[0-9]+' | sort -n | tail -1`
   Use the MAX, never the row count.

## Write the row

Append at the END of the table, matching the surrounding rows' language
and style (study the last ~5 rows first):

`| <N> | <Bold thesis sentence> (<dd/mm/yyyy>, <attribution — e.g. "pedido do usuário", "decisão do usuário", "re-auditoria">): <the decision in full — what, why, and the named files/collections it touches> | <Implicação — the consequence, mandatory, never empty> |`

- The Implicação column answers "what does this buy or cost us" — not a
  restatement of the decision.
- Name the exact files/jobs/collections the decision touched, the way
  existing rows do.

## Supersession / refinement (the annotation rule)

If this decision supersedes, amends, or refines earlier material:

1. Locate EVERY affected decision row and story bullet
   (`grep -n "<term>" "$BACKLOG"`).
2. Append an inline annotation INSIDE the affected text — never alter the
   original words: `*[**Superado pela decisão <N> (<data>)**: <one line>]*`
   (or `Emendada`/`Refinada` when partial).
3. Sweep code comments referencing the superseded decision:
   `grep -rn "decision <old-N>\|decisão <old-N>" packages/` — update or
   annotate comments whose guidance the new decision changes.

## Chains

- If this decision RESOLVES an open question in the QA registry, run the
  `resolve-qa` skill next (it requires this row to exist first).
- If the decision introduces/changes an env knob, the `env-knob` skill's
  checklist applies to the implementation side.

## Verify

- `git diff "$BACKLOG"` shows ONLY: the new row (addition at table end)
  and annotation insertions — no deletions, no edits to prior text.
- `node scripts/spec-check.mjs` passes (numbering + reference integrity).
