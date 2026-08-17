# Platform CONNECTOR image (@observability/connector + @observability/core) — the trace-source
# side: the continuous ingestion worker (default CMD) and the manual
# run-sync job. Build context = workspace ROOT:
#
#   docker build -f docker/connector.Dockerfile -t platform-connector:local .
#
# Same workspace mechanics as module.Dockerfile (root lockfile, hoisted
# node_modules, package.json next to each dist for ESM, in-image tsc -b).
# Differences that define this image:
# - No HTTP server: the worker is a loop; compose healthchecks the process,
#   not a port. No EXPOSE.
# - The fake LangWatch client fast-globs '**/src/infrastructure/traceSource/
#   fixtures/*.json' from cwd; tsc does not emit JSON, so the fixtures are
#   copied in explicitly to keep offline (fixture-backed) sync working —
#   compose.dev.yml mounts a client's demo fixtures over that directory.

FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/module/package.json packages/module/
COPY packages/connector/package.json packages/connector/
RUN npm ci --workspace=@observability/connector
COPY packages/core/tsconfig.json packages/core/tsconfig.build.json packages/core/
COPY packages/core/src packages/core/src
COPY packages/connector/tsconfig.json packages/connector/tsconfig.build.json packages/connector/
COPY packages/connector/src packages/connector/src
RUN npm run build --workspace=@observability/connector \
  && find packages/core/dist packages/connector/dist \
       \( -name '*.spec.js' -o -name '*.test.js' -o -name '*.map' \) -delete

FROM node:26-alpine AS runtime
ENV NODE_ENV=production \
    DOTENV_CONFIG_QUIET=true
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/module/package.json packages/module/
COPY packages/connector/package.json packages/connector/
# npm/corepack/yarn are install tooling — the container only ever runs
# `node dist/...`. Removing them after the install also removes npm's
# vendored dependencies (tar et al) from the image's CVE surface.
RUN npm ci --workspace=@observability/connector --omit=dev && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
       /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/connector/dist packages/connector/dist
COPY packages/connector/src/infrastructure/traceSource/fixtures \
     packages/connector/src/infrastructure/traceSource/fixtures

# cwd matters: dotenv (.env.<ENVIRONMENT>) and the fixture glob resolve from here.
WORKDIR /app/packages/connector
# The loop finishes its batch on SIGTERM; compose sets init: true and a
# 60s stop grace period. Required env: ENVIRONMENT (+ MONGO_DB_* and the
# LANGWATCH_* source vars to be useful — without a source, the worker idles).
CMD ["node", "dist/main/jobs/run-trace-ingestion-loop.js"]
