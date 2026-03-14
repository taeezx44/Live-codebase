# CodeVis Roadmap

This document tracks everything planned, in progress, and completed across all phases. It is the single source of truth for what gets built and when.

Status markers: `✅ done` · `🔄 in progress` · `📋 planned` · `💡 idea (not committed)`

---

## Phase 1 — Core Engine

**Goal:** A working MVP that a developer can use to understand an unfamiliar codebase in under 5 minutes.

**Target:** Q2 2025 · **Status:** 🔄 In progress

### Infrastructure

- [x] Docker Compose: PostgreSQL 16, Neo4j 5, Redis 7
- [x] `dev-setup.sh` — one-command bootstrap from a fresh clone
- [x] `reset-db.sh` — wipe all data for a clean slate
- [x] Multi-stage Dockerfiles for api and worker
- [x] GitHub Actions CI: typecheck + test + build + docker verify
- [x] `pnpm-workspace.yaml` + `tsconfig.base.json` + `turbo.json`
- [x] Biome for lint and format (replaces ESLint + Prettier)

### Analysis engine

- [x] tree-sitter integration — base parser class
- [x] JavaScript parser: static imports, require(), dynamic import(), exports, functions, classes
- [x] TypeScript parser: extends JS parser, adds `implements` clause
- [x] Cyclomatic complexity calculator
- [x] Import resolver — relative paths → absolute, tsconfig path aliases
- [x] `ParserEngine` — parallel file parsing with `p-limit`, progress callback
- [ ] Handle `.mts` / `.cts` module extensions
- [ ] Detect re-exports: `export { foo } from "./foo"`

### Worker

- [x] `clone.job` — `git clone --depth=1 --filter=blob:none`
- [x] `analyze.job` — parse all files, write to Neo4j + PostgreSQL
- [x] `index.job` — build Fuse.js search index in Redis
- [x] BullMQ concurrency config (clone: 5, analyze: 3, index: 10)
- [x] Retry with exponential backoff + dead letter queue
- [x] Graceful shutdown on SIGTERM (finish active jobs before exit)
- [ ] Repo size quota enforcement (`MAX_REPO_SIZE_MB`)
- [ ] Support for private repos via `GITHUB_TOKEN`

### API gateway

- [x] `POST /repos` — validate, enqueue, return `{ repoId, jobId }`
- [x] `GET /repos/:id` — repo status + metadata
- [x] `GET /repos/:id/graph` — nodes + edges with language/complexity filters
- [x] `DELETE /repos/:id` — remove from PostgreSQL and Neo4j
- [x] `GET /repos/:id/impact` — reverse traversal, affected files
- [x] `GET /repos/:id/hotspots` — fan-in, complexity, risk modes
- [x] `GET /repos/:id/search` — fuzzy + symbol search via Fuse.js
- [x] `GET /jobs/:id` — job state + progress (polling fallback)
- [x] `GET /health` + `GET /health/ready` — liveness + readiness probes
- [x] WebSocket `/ws` — `job:progress`, `job:complete`, `job:failed`
- [x] Redis sliding-window rate limiter (Lua script, atomic)
- [ ] `GET /repos` — list all repos with status
- [ ] `POST /repos/:id/reanalyze` — trigger re-analysis of an existing repo
- [ ] OpenAPI spec generation from Hono routes

### Graph engine (Neo4j)

- [x] Schema setup — constraints + range indexes + full-text index
- [x] `GRAPH_QUERIES` — repo graph, file detail, direct imports, imported-by
- [x] `IMPACT_QUERIES` — affected files, blast radius, has-importers check
- [x] `HOTSPOT_QUERIES` — fan-in, complexity, risk, orphans
- [x] `CALL_GRAPH_QUERIES` — called-by, call chain, complex functions in file
- [x] `CYCLE_QUERIES` — find all cycles, file-in-cycle check
- [x] `ARCH_QUERIES` — layer violations, entry points, lang stats
- [x] `GraphService` — typed wrapper with Neo4j Integer conversion
- [ ] `ARCH_QUERIES.moduleClusters` — APOC SCC (requires APOC install)
- [ ] Query result caching in Redis (TTL: 5 min for hotspots, 1 min for graph)

### Frontend

- [x] `buildGraph()` — API response → Graphology graph
- [x] `fa2.worker.ts` — ForceAtlas2 layout on Web Worker (zero UI jank)
- [x] `SigmaContainer` with nodeReducer + edgeReducer
- [x] `GraphEvents` — hover neighbours, click select, double-click zoom
- [x] `NodeDetailPanel` — LOC, complexity bar, impact summary, VS Code deep link
- [x] `GraphToolbar` — language filter, complexity slider, stats
- [x] `useGraphData` — fetch + build + cache
- [x] `useLayoutWorker` — spawns/terminates FA2 worker
- [x] `useSearchHighlight` — dims non-matching nodes
- [x] `useHoverNeighbours` — highlight node + all its neighbours
- [ ] Loading skeleton for graph canvas
- [ ] Empty state when repo has 0 files
- [ ] Error boundary with retry button
- [ ] Keyboard shortcut: `Cmd+K` opens search

### Documentation

- [x] `README.md` — flagship level with demo GIF
- [x] `CONTRIBUTING.md` — setup, testing, style, adding parsers and queries
- [x] `CHANGELOG.md` — Keep a Changelog format
- [x] `LICENSE` — MIT
- [ ] `docs/architecture.md` — deeper dive on data flow
- [ ] `docs/api.md` — auto-generated from OpenAPI spec

---

## Phase 2 — Intelligence Layer

**Goal:** Move from "what imports what" to "what is this code actually doing."

**Target:** Q3 2025 · **Status:** 📋 Planned

### New parsers

- [ ] Python parser — `import`, `from x import y`, `def`, `class`, decorators
- [ ] Go parser — `import`, `func`, `type struct`, `interface`
- [ ] Parser test harness — shared test fixtures for all languages

### Call graph

- [ ] Function-level `[:CALLS]` edges written by `analyze.job`
- [ ] Call resolution: raw `calls[]` array → matched `Function` nodes in Neo4j
- [ ] `GET /repos/:id/callgraph?function=<id>` — call chain for one function
- [ ] Call graph view in UI — separate panel, not the main dep graph

### Class hierarchy

- [ ] `[:EXTENDS]` and `[:IMPLEMENTS]` edges for TypeScript + Java
- [ ] `GET /repos/:id/hierarchy?class=<name>` — full inheritance chain
- [ ] Class hierarchy panel in NodeDetailPanel

### Complexity trends

- [ ] Store complexity snapshot per commit (requires git history)
- [ ] `GET /repos/:id/files/:path/trend` — complexity over last N commits
- [ ] Sparkline in NodeDetailPanel showing complexity trend

### VS Code extension

- [ ] Extension scaffold (`vscode` API, language client)
- [ ] Sidebar panel showing current file's position in the dependency graph
- [ ] Command: "Show files that import this" → opens filtered graph in browser
- [ ] Command: "Show impact if I change this" → opens impact panel in browser

---

## Phase 3 — History

**Goal:** Show how the codebase evolved, not just what it looks like now.

**Target:** Q4 2025 · **Status:** 📋 Planned

### Git history

- [ ] `git log --follow --stat` parser — file rename tracking
- [ ] Commit frequency per file (30-day rolling window)
- [ ] `git_commits` table in PostgreSQL — hash, author, date, files changed
- [ ] `churn` score = commit frequency × LOC (proxy for instability)
- [ ] Churn heatmap on the graph (colour = churn, not language)

### Developer collaboration

- [ ] `developer_files` table — author → files touched (from `git blame`)
- [ ] `[:COLLABORATED_ON]` edge in Neo4j when 2+ devs touch the same file
- [ ] Developer network graph view — nodes are devs, edges are shared files
- [ ] `GET /repos/:id/contributors` — top contributors per file

### Architecture timeline

- [ ] Per-commit graph snapshots stored in Neo4j (labelled with commit hash)
- [ ] Timeline scrubber in UI — drag to any commit, graph re-renders
- [ ] Diff view between two commits — new edges green, removed edges red

---

## Phase 4 — AI

**Goal:** Answer questions about the codebase in natural language.

**Target:** 2026 · **Status:** 💡 Ideas only — scope not yet defined

### AI insights

- [ ] Design smell detection — god objects, feature envy, shotgun surgery
- [ ] Duplicate code detection across files
- [ ] Refactor suggestion: "This file has 3 responsibilities, consider splitting"
- [ ] Powered by Anthropic Claude API (configurable, not hardcoded)

### Natural language queries

- [ ] "Show me all files that touch payments" → graph filter
- [ ] "Which function is called most across the codebase?" → call graph query
- [ ] "What changed most in the last month?" → git history query
- [ ] Chat interface in sidebar — context-aware of currently selected node

### Auto-documentation

- [ ] Architecture document generated from graph structure
- [ ] Module descriptions inferred from exported symbols + usage patterns
- [ ] Markdown output, exportable

### Multi-repo analysis

- [ ] Import multiple repos as one "workspace"
- [ ] Cross-repo `[:IMPORTS]` edges (for monorepos and microservice systems)
- [ ] Workspace graph view showing inter-service dependencies

---

## Ongoing

These items apply to every phase and are never fully "done."

- [ ] Increase integration test coverage for all Cypher queries
- [ ] Property-based tests for the parser (fuzzing with arbitrary TypeScript)
- [ ] Performance benchmarks — track parse time per 1000 files across releases
- [ ] Dependency audit — `pnpm audit` in CI, auto-PR for patch updates
- [ ] Accessibility audit for graph UI (keyboard navigation, screen reader labels)
- [ ] Docker image size audit — keep api < 200MB, worker < 300MB
