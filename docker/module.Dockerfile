# Platform MODULE image (@observability/module + @observability/core) — the read API. Build
# context = workspace ROOT (the npm-workspaces root):
#
#   docker build -f docker/module.Dockerfile -t platform-module:local .
#
# Notes that shaped this file (from the pre-dockerization audit + the split):
# - Only the ROOT package-lock.json exists and is authoritative — installs
#   always run from the workspace root (npm workspaces).
# - Runtime deps hoist to the root node_modules, so the image preserves the
#   root/packages nesting and Node resolves imports by walking up from
#   packages/module/dist to /app/node_modules. @observability/core resolves through
#   its workspace symlink + exports map into packages/core/dist.
# - packages/{core,module}/package.json ("type":"module") must sit next to
#   each dist/, or Node parses the ESM output (top-level await) as CommonJS
#   and crashes.
# - The local dist/ is often stale — tsc ALWAYS runs in-image (tsc -b builds
#   core first via project references).
# - This image is VENDOR-FREE BY CONSTRUCTION (audit G-5): the runtime
#   stage copies ONLY packages/{core,module}/dist; packages/connector/
#   receives its package.json but no code, so the workspace symlink npm
#   creates (it does so EVEN under --omit=dev — verified) resolves to a
#   code-less directory. The RUN assertion at the end of the build stage
#   makes this a build failure, not a comment: no connector dist, no
#   vendor string in the module dist.
# - Every workspace package.json must be present for npm ci to resolve the
#   workspace graph, even packages this image never runs.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/module/package.json packages/module/
COPY packages/connector/package.json packages/connector/
COPY packages/ui/package.json packages/ui/
RUN npm ci --workspace=@observability/module
COPY packages/core/tsconfig.json packages/core/tsconfig.build.json packages/core/
COPY packages/core/src packages/core/src
COPY packages/module/tsconfig.json packages/module/tsconfig.build.json packages/module/
COPY packages/module/src packages/module/src
RUN npm run build --workspace=@observability/module \
  && find packages/core/dist packages/module/dist \
       \( -name '*.spec.js' -o -name '*.test.js' -o -name '*.map' \) -delete \
  && test ! -e packages/connector/dist \
  && ! grep -rqiE 'langwatch|clickhouse' packages/module/dist \
  || (echo 'VENDOR LEAK: connector code or a vendor string is in the module image (audit G-5)'; exit 1)

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    DOTENV_CONFIG_QUIET=true
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/module/package.json packages/module/
COPY packages/connector/package.json packages/connector/
COPY packages/ui/package.json packages/ui/
# npm/corepack/yarn are install tooling — the container only ever runs
# `node dist/...`. Removing them after the install also removes npm's
# vendored dependencies (tar et al) from the image's CVE surface.
RUN npm ci --workspace=@observability/module --omit=dev && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
       /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/module/dist packages/module/dist

# cwd matters: dotenv (.env.<ENVIRONMENT>) resolves from here.
WORKDIR /app/packages/module
EXPOSE 3000
# The app handles SIGTERM/SIGINT itself (graceful drain, C-5.4); compose
# still sets init: true — PID-1 zombie reaping, plus a backstop if node is
# ever wrapped in a shell that would swallow signals. Required env:
# ENVIRONMENT, SERVER_PORT (+ MONGO_DB_* to be useful). MONGO_DB_ATLAS takes
# the strings 'true'/'false' (mapped to boolean by environment-setup.ts).
CMD ["node", "dist/main/index.js"]
