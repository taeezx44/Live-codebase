# ============================================================
# docker/worker.Dockerfile
# ============================================================

FROM oven/bun:1.1-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json          ./packages/shared/
COPY packages/analysis-engine/package.json ./packages/analysis-engine/
COPY packages/worker/package.json          ./packages/worker/
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN bun run --filter @codevis/shared build
RUN bun run --filter @codevis/analysis-engine build
RUN bun run --filter @codevis/worker build

FROM oven/bun:1.1-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# tree-sitter needs write access to compile grammars on first load
# Use a writable tmp directory for the grammar cache
ENV TREE_SITTER_GRAMMAR_CACHE=/tmp/tree-sitter

COPY --from=build /app/packages/worker/dist          ./packages/worker/dist
COPY --from=build /app/packages/worker/package.json  ./packages/worker/
COPY --from=build /app/packages/analysis-engine/dist ./packages/analysis-engine/dist
COPY --from=build /app/packages/shared/dist          ./packages/shared/dist
COPY --from=build /app/node_modules                  ./node_modules
COPY --from=build /app/package.json                  ./

# Need git binary for simple-git
RUN apk add --no-cache git

RUN addgroup -S codevis && adduser -S codevis -G codevis
USER codevis

CMD ["bun", "packages/worker/dist/index.js"]
