# syntax=docker/dockerfile:1
#
# VerdictVaut web frontend — production/staging container image (Phase 15).
#
# Build context MUST be the repository root (npm-workspaces monorepo —
# apps/web depends on packages/shared-types):
#   docker build -f apps/web/Dockerfile -t verdictvaut-web .
#
# Bakes in no secrets. Only NEXT_PUBLIC_* build args are ever compiled
# into client bundles (Next.js's own convention, not something this file
# adds) — set them as --build-arg at build time for the target
# environment; nothing here defaults them to a real endpoint.
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

# Only NEXT_PUBLIC_* vars are ever embedded client-side by Next.js's own
# build — no other secret reaches this stage.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_ENVIRONMENT=sandbox
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_APP_ENVIRONMENT=${NEXT_PUBLIC_APP_ENVIRONMENT}

RUN npm run build -w packages/shared-types
RUN npm run build -w apps/web

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /repo

# next.config.mjs's `output: "standalone"` traces only the production
# dependency subset needed to run, into apps/web/.next/standalone —
# self-contained, no repo-root node_modules copy needed for runtime.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O- http://localhost:3000/ || exit 1

CMD ["node", "apps/web/server.js"]
