# syntax=docker/dockerfile:1
#
# VerdictVaut API + background worker — production/staging container
# images (Phase 15, hardened + split in Phase 16).
#
# Build context MUST be the repository root (this is an npm-workspaces
# monorepo — apps/api depends on packages/shared-types). This single
# Dockerfile builds TWO independently deployable images from the same
# compiled artifacts, selected by --target (see deployment architecture
# docs/deployment-architecture.md):
#   docker build -f apps/api/Dockerfile --target runtime -t verdictvaut-api .    (HTTP API — the default target)
#   docker build -f apps/api/Dockerfile --target worker  -t verdictvaut-worker . (background blockchain workers, no HTTP port)
#
# This image bakes in NO credentials, secrets, or provider configuration.
# APP_ENVIRONMENT, DATABASE_URL, JWT secrets, and every provider secret
# reference are supplied at container run time only (see
# apps/api/.env.example for the full variable list). Building or running
# this image does not select, verify, or execute against any custody
# provider — that remains entirely driven by runtime configuration and
# ProductionSafetyGate/WithdrawalExecutorFactory, unchanged by this file.
# The `runtime` (API) image refuses to boot at all if a watcher env flag
# is left on without an explicit opt-in — see
# src/config/watcher-boundary.guard.ts — so running the same env file
# against the wrong target fails loudly instead of silently duplicating
# worker responsibility into the HTTP process.
#
# This Dockerfile has been reviewed but NOT executed with `docker build`
# in the environment it was authored in (Docker was unavailable there) —
# CI validates both targets build (.github/workflows/ci.yml's
# docker-build job) on every push; verify locally too wherever Docker is
# actually available before relying on this in a real deployment.

FROM node:20-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN npm run build -w packages/shared-types
RUN npm run prisma:generate -w apps/api
RUN npm run build -w apps/api
# Drops devDependencies (eslint, typescript, jest, ts-node, the NestJS
# CLI, and — notably — `embedded-postgres`, which bundles a full Postgres
# server binary that has no business shipping in a runtime image) now
# that the build artifacts (dist/, and prisma generate's node_modules/
# .prisma output) already exist. Smaller image, smaller attack surface,
# nothing removed that either runtime image below actually needs.
RUN npm prune --omit=dev

# Worker stage — background blockchain watchers only (Phase 16). Same
# base and build artifacts as `runtime` below, deliberately NO EXPOSE
# and no HTTP-based HEALTHCHECK: worker.main.ts binds no port at all
# (see its own docblock). Liveness is judged by a heartbeat file instead
# (WORKER_HEARTBEAT_FILE) — see scripts/worker-healthcheck.js. Defined
# BEFORE `runtime` so a plain `docker build` with no --target still
# defaults to `runtime` (the last stage, and Docker's own default target
# selection rule) — preserving the pre-Phase-16 default behavior.
FROM node:20-alpine AS worker
ENV NODE_ENV=production
WORKDIR /repo

COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /repo/apps/api/prisma ./apps/api/prisma
COPY --from=build --chown=node:node /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /repo/apps/api/scripts/worker-healthcheck.js ./apps/api/scripts/worker-healthcheck.js
COPY --from=build --chown=node:node /repo/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=build --chown=node:node /repo/packages/shared-types/package.json ./packages/shared-types/package.json

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node apps/api/scripts/worker-healthcheck.js || exit 1

CMD ["node", "apps/api/dist/worker.main.js"]

# Runtime stage (HTTP API) — same base image as `build` so the Prisma
# query-engine binary generated above is guaranteed ABI-compatible. Last
# stage in the file = the default target when --target is omitted.
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=4000
WORKDIR /repo

# node:20-alpine ships an unprivileged "node" user (uid 1000) already —
# reused rather than creating a new one.
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /repo/apps/api/prisma ./apps/api/prisma
COPY --from=build --chown=node:node /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /repo/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=build --chown=node:node /repo/packages/shared-types/package.json ./packages/shared-types/package.json

USER node
EXPOSE 4000

# Liveness only (never checks the database — see health.controller.ts's
# own docblock on why liveness and readiness are deliberately separate).
# An orchestrator should probe GET /health/ready separately for routing
# decisions.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O- http://localhost:4000/health || exit 1

# Migrations are deliberately NOT run here (`prisma migrate deploy`) —
# running them as part of container startup races every replica of a
# multi-instance deployment against the same migration. Run migrations
# as a separate, single-instance deploy step before rolling out this
# image, exactly as docs/fireblocks-sandbox-smoke-test.md's staging
# setup already does.
CMD ["node", "apps/api/dist/main.js"]
