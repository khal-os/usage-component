---
name: feature-slice
description: Scaffold a new feature end-to-end (API endpoint, read path, use case) across the clean-architecture layers — the ~12-file vertical slice. Use when adding an endpoint or capability that spans domain, application, presentation, infrastructure, and main.
---

# Feature slice — the vertical file set

## Before any code (spec first)

1. `BACKLOG=$(ls docs/produto/backlog-*.md | sort -V | tail -1)` — find
   the T/US story being implemented and LIST ITS ACCEPTANCE BULLETS (the
   unlabeled bullets under the story heading). They are the definition of
   done; restate them in your plan before touching files.
2. Read CLAUDE.md's invariants and package-layout sections — flag any
   bullet that touches an invariant (money handling, client-facing
   projections, immutability rules) and cite the invariant number in the
   relevant code comments.
3. Pick the NEAREST EXISTING SLICE as the exemplar and clone its shapes:
   `ls packages/module/src/application/useCases/` — for a module read
   endpoint, `billingSummary/` is the canonical exemplar; connector-side
   work mirrors `syncTraces/` instead.

## The file manifest (layer order — build bottom-up)

| # | Role | Location pattern |
|---|---|---|
| 1 | Domain contract (use-case interface + models) | `packages/core/src/domain/useCases/<name>-use-case.ts` |
| 2 | Repository port | `packages/core/src/application/interfaces/<name>-repository.ts` |
| 3 | Application protocols barrel (pure re-exports) | `.../application/useCases/<slice>/<slice>-protocols.ts` |
| 4 | Use case impl — args-object ctor of ports, optional `logger` defaulting to nullLogger | `.../<verb>-<noun>-db-use-case.ts` |
| 5 | Use case unit spec | `.../<verb>-<noun>-db-use-case.spec.ts` |
| 6 | Presentation protocols barrel | `.../presentation/controllers/<domain>/<domain>-protocols.ts` |
| 7 | Controller (zod `strictObject` query schema) + spec | `.../controllers/<domain>/<name>-controller.ts` |
| 8 | View model + schemas (the client contract) | `<domain>-view-model.ts`, `<domain>-view-schemas.ts` |
| 9 | Factory — wires concrete repos + `makeLogger({ component })` | `main/factories/<domain>-factory.ts` |
| 10 | Route registration | `main/server/routes/v1/<domain>-routes.ts` |
| 11 | Route integration suite | `<domain>-routes.test.ts` |
| 12 | Mongo repository + integration test | `packages/core/src/infrastructure/database/mongodb/<aggregate>/` |

## Guardrails

- **Client-facing schemas**: snake_case; check CLAUDE.md's invariants for
  fields that must be ABSENT BY CONSTRUCTION from projection schemas (in
  this repo: US$/PTAX/markup/internal-cost — invariant 4). Absence is
  enforced by not defining the field, not by hiding it.
- **Test suffixes are load-bearing**: `*.spec.ts` = unit (no Mongo),
  `*.test.ts` = integration (real Mongo). The jest configs select by
  suffix — a misnamed file silently runs in the wrong suite.
- **Layer direction**: application never imports infrastructure/main;
  presentation only domain (+ its own layer and common). The per-package
  `architecture-boundaries.spec.ts` enforces this — run it early.
- **Logging**: through the injected `Logger` port only (never console);
  production wiring always passes a real logger from the factory.
- **Traceability**: where behavior implements a numbered decision or a
  story rule, say so in a comment (`// decision NN: …`, `// T7: …`).

## Verify (in order)

```bash
npm run test:unit:ci -w <package>          # unit + architecture boundaries
npm test -w <package>                      # + integration (real Mongo)
npm run lint && npm run typecheck
```
Then walk the story's acceptance bullets one by one against the diff —
each bullet either demonstrably holds or is explicitly deferred (and a
deferral belongs in the story's Adiado footer via `author-story`).
