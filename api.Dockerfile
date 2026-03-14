# ============================================================
# docker/api.Dockerfile  —  API Gateway
#
# Multi-stage build:
#   deps    — install all dependencies (cached layer)
#   build   — compile TypeScript
#   runner  — minimal production image (no devDeps, no src)
# ============================================================

FROM oven/bun:1.1-alpine AS base
WORKDIR /app

# ── Stage 1: Install dependencies ───────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json          ./packages/shared/
COPY packages/analysis-engine/package.json ./packages/analysis-engine/
COPY packages/api-gateway/package.json     ./packages/api-gateway/

RUN bun install --frozen-lockfile

# ── Stage 2: Build ───────────────────────────────────────────
FROM deps AS build
COPY . .
RUN bun run --filter @codevis/shared build
RUN bun run --filter @codevis/analysis-engine build
RUN bun run --filter @codevis/api-gateway build

# ── Stage 3: Runner ──────────────────────────────────────────
FROM oven/bun:1.1-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy only what's needed to run
COPY --from=build /app/packages/api-gateway/dist ./packages/api-gateway/dist
COPY --from=build /app/packages/api-gateway/package.json ./packages/api-gateway/
COPY --from=build /app/packages/analysis-engine/dist ./packages/analysis-engine/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

EXPOSE 4000

# Non-root user for security
RUN addgroup -S codevis && adduser -S codevis -G codevis
USER codevis

CMD ["bun", "packages/api-gateway/dist/server.js"]
