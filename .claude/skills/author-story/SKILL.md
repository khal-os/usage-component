---
name: author-story
description: Draft a new tech story (T<n>) or user story (US<n>) for the backlog in the house format — épico placement, acceptance criteria bullets, cross-references. Use when new scope is being specified ("write a story for…", "spec out…", "add to the backlog…").
---

# Author a story (T / US)

## Discovery

1. `BACKLOG=$(ls docs/produto/backlog-*.md | sort -V | tail -1)`
2. Next id = max existing + 1 per kind:
   `grep -oE '^### (T|US)[0-9]+' "$BACKLOG" | grep -oE '[0-9]+' | sort -n | tail -1`
   (scan T and US separately — they are independent sequences).
3. Read 2–3 neighboring stories in the target épico to absorb voice,
   granularity, and the table's language.

## House format

Place under the right `## Épico` (or propose a new épico with an
`**Objetivo.**` paragraph if none fits):

```
### T<n> — <imperative capability title>

<one short paragraph: what exists after this story and why>

- <acceptance bullet — testable, concrete; bold-lead when it names a
  named test, e.g. **Teste de aceite de X:** …>
- <bullet citing governing decisions/QAs by number where they constrain
  the design>

*Habilita: <stories/épicos this unblocks>.*
```

User stories additionally OPEN with the persona line, always italic:
`*Como <persona>, quero <capability>, para <outcome>.*`

Rules:
- Acceptance bullets are the definition of done — each must be checkable
  by a test, a demo step, or an inspection; no aspirational bullets.
- Scope cut during drafting goes to the épico's `**Adiado:**` footer (and
  the consolidated post-v1 table if long-lived), never silently dropped.
- A question the story cannot answer becomes a NEW QA row (next QA id by
  max-scan) in the open-questions registry, and the bullet cites it
  (`— pendente QA<n>`).
- Decisions embedded in the story ("we will X, not Y") belong in the
  decision log too — run `append-decision` and cite the number.

## Verify

- Ids strictly max+1; story renders correctly (heading level, italics).
- Every cited decision/QA number exists: `node scripts/spec-check.mjs`.
- The implementation, when it starts, goes through `feature-slice` with
  these bullets as its input.
