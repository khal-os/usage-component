---
name: resolve-qa
description: Mark an open question in the backlog QA registry as resolved when a decision, spike, or user ruling answers it. Use when the user answers a pending QA, when a new decision settles one, or when asked to "resolve QA<n>".
---

# Resolve an open question (QA registry)

Unlike the decision log, the QA registry IS edited in place — but only in
the house resolution format, which preserves the original question.

## Discovery

1. `BACKLOG=$(ls docs/produto/backlog-*.md | sort -V | tail -1)`
2. Find the registry table by its ID column pattern (rows matching
   `| QA[0-9]+ |`, or the local equivalent ID prefix).
3. **Precondition**: the answering decision row must already exist in the
   decision log. If it doesn't, run `append-decision` FIRST and come back
   with its number.

## Edit the row (study a resolved row first, e.g. one containing RESOLVIDA)

1. Strike through the original question verbatim: `~~<original text>~~`
2. Immediately after, append:
   `**RESOLVIDA (<dd/mm/yyyy>, decisão <N>)**: <the answer, one-two lines>`
   (match the table's language — use the resolved rows as the exemplar).
3. Rewrite the "why it matters" column to past tense / outcome — what the
   answer settled, not why it used to be open.
4. If the resolution only PARTIALLY answers (refinement), keep the QA open
   and add an inline `*[**Refinada pela decisão <N>**: …]*` annotation
   instead — mirror how existing partially-resolved rows read.

## Code markers

Add `// QA<n>:` comments at the code paths the answer now governs — the
marker flips meaning from "pending question" to "this is where the answer
lives". Find candidates: `grep -rn "QA<n>" packages/`.

## Verify

- Every remaining `QA<n>` reference (docs + code) reads consistently with
  the resolved state: `grep -rn "QA<n>" packages/ docs/`
- `node scripts/spec-check.mjs` passes (the RESOLVIDA reference must cite
  an existing decision number).
