# syntax=docker/dockerfile:1
#
# VerdictVaut API — production/staging container image (Phase 15).
#
# Build context MUST be the repository root (this is an npm-workspaces
# monorepo — apps/api depends on packages/shared-types):
#   docker build -f apps/api/Dockerfile -t verdictvaut-api .
#
# This image bakes in NO credentials, secrets, or provider configuration.
# APP_ENVIRONMENT, DATABASE_URL, JWT secrets, and every provider secret
# reference are supplied at container run time only (see
# apps/api/.env.example for the full variable list). Building or running
# this image does not select, verify, or execute against any custody
# provider — that remains entirely driven by runtime configuration and
# ProductionSafetyGate/WithdrawalExecutorFactory, unchanged by this file.
#
# This Dockerfile has been reviewed but NOT executed with `docker build`
# in the environment it was authored in (Docker was unavailable there) —
# verify it builds successfully wherever Docker is actually available
# before relying on it.

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

# Runtime stage — same base image as `build` so the Prisma query-engine
# binary generated above is guaranteed ABI-compatible.
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
