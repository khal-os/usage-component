---
name: env-knob
description: Add, rename, or remove ANY environment variable / config knob end-to-end. Use for every env var change ("add a LOG_SAMPLING var", "make X configurable", "drop the legacy VAR") — there are 8 stations and forgetting one (especially the Makefile SCRUB list) has shipped real bugs twice.
---

# Env knob — the 8-station checklist

A knob is not "added" until all eight stations are hit. Two production
bugs came from missing station 6 alone. Do not trust memory: follow an
EXISTING knob through the codebase and mirror every place it appears —
`LOG_LEVEL` is a good exemplar for optional knobs, `CLIENT_TIMEZONE` for
required ones (`grep -rn "LOG_LEVEL\|CLIENT_TIMEZONE" --include="*.ts" --include="Makefile" --include="*.yml" .`).

House semantics (encode them, don't reinvent):
- **'' means unset** — compose forwards `${VAR:-}`, so an env file that
  omits the var delivers empty string; it must behave exactly like absent
  (never half-enable a feature).
- **A garbage knob fails the boot loudly** — bounded ints, enums via zod;
  never silently fall back on an invalid value.
- **Required knobs are declared, never inferred** — no fallback default
  when a wrong guess produces wrong behavior.

## Stations

1. **Shared reader in core** (only if more than one package reads it):
   `packages/core/src/common/config/parse-<x>-env.ts` + `.spec.ts` —
   export the triple `{ <x>EnvSchemaShape, to<X>Environment,
   <X>EnvironmentVariables }` (exemplar: `parse-log-env.ts`; rationale:
   one reader, both images — a copied fragment drifts).
2. **Typed interface**: the package's
   `src/infrastructure/configuration/interfaces/*-environment-variables.ts`
   (+ barrel `index.ts`).
3. **Per-package `environment-setup.ts`**: spread the schema shape into
   the zod object; add to the exported `environment` mapping. One setup
   file per consuming package — a knob read by two images must appear in
   BOTH setups.
4. **Consumer/factory**: wire the value where it's used (a `main/factories`
   factory or a common initializer) — config is read at the composition
   root, never deep in a layer.
5. **Compose passthrough**: every compose service whose image reads the
   knob gets a line — `VAR: ${VAR:-}` (optional) or
   `VAR: ${VAR:?<message naming the decision>}` (required). Check ALL
   services of the image (api AND scheduler, not just api).
6. **Makefile SCRUB list** ⚠️ THE HISTORICALLY FORGOTTEN STATION: add
   `-u VAR` to the `SCRUB =` block. Every variable a compose file
   interpolates MUST be listed — a var that escapes the scrub means an
   operator's exported shell var silently overrides EVERY client's
   `--env-file` at once. This was missed twice; `scripts/spec-check.mjs`
   now fails CI on the gap, but fix it at authoring time.
7. **Client + package env templates**: `clients/example.*.env` (commented,
   with the [OPTIONAL]/[REQUIRED] tag style of neighboring entries) and
   `packages/*/.env.example` for each consuming package.
8. **Docs + decision**: README env-contract mention if operator-facing;
   CLAUDE.md if it changes an invariant/agreement; then run
   `append-decision` for the knob's rationale.

## Removal / rename

Same stations in reverse — grep the OLD name across all eight locations
until zero hits remain (`grep -rn "OLD_VAR" . --exclude-dir=node_modules
--exclude-dir=dist --exclude-dir=.git`); renames are remove+add, and the
decision row records the migration story.

## Verify

```bash
grep -rn "VAR_NAME" Makefile compose*.yml clients/ packages/*/.env.example packages/*/src | sort
node scripts/spec-check.mjs   # SCRUB completeness gate
```
Every station present; tests green (`npm run test:unit:ci`).
