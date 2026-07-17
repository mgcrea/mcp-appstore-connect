# syntax=docker/dockerfile:1.7
# Build stage: install all deps, compile with tsdown, prune to prod-only deps.
FROM node:24-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
# Passed in from `pnpm docker:build` so the bundle bakes in real git info
# (the .git dir isn't COPY'd into the build context).
ARG GIT_COMMIT=unknown
ARG GIT_COMMIT_DATE=unknown
ENV GIT_COMMIT=$GIT_COMMIT GIT_COMMIT_DATE=$GIT_COMMIT_DATE
RUN pnpm build && pnpm prune --prod

# Runtime stage: debian-slim with just node + prod node_modules + dist.
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

USER node
ENTRYPOINT ["node", "/app/dist/cli.js"]
