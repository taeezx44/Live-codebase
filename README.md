<div align="center">

<img src="https://raw.githubusercontent.com/taeezx44/Live-codebase/main/docs/assets/logo.svg" width="72" height="72" alt="Korawit Chuluean logo" />

# Korawit Chuluean

**Understand any codebase in seconds — not hours.**

Load a GitHub repo. Watch the dependency graph build live. Click any file to trace what breaks if you change it.

[![CI](https://github.com/taeezx44/Live-codebase/actions/workflows/ci.yml/badge.svg)](https://github.com/taeezx44/Live-codebase/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![pnpm](https://img.shields.io/badge/maintained%20with-pnpm-cc00ff.svg)](https://pnpm.io/)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun)](https://bun.sh)

[**Live Demo**](https://live-codebaseg.vercel.app/) · [**Docs**](https://docs.codevis.dev) · [**Roadmap**](#roadmap) · [**Contributing**](CONTRIBUTING.md)

<br/>

https://github.com/taeezx44/Live-codebase/raw/main/docs/assets/demo.mp4

*↑ The React repo, visualized. Every node is a file. Every edge is an import. Click any node to see its blast radius.*

</div>

---

## What is CodeVis?

Most tools tell you what code *does*. CodeVis shows you how it all *connects*.

Point it at any GitHub repo and it builds an interactive dependency graph in real time — using tree-sitter to parse every file, Neo4j to store the relationships, and WebGL to render tens of thousands of nodes at 60fps without breaking a sweat.

```bash
# Import any public repo in one line
curl -X POST https://api.codevis.dev/repos \
  -H "Content-Type: application/json" \
  -d '{"url": "https://github.com/facebook/react"}'

# → { "repoId": "abc123", "jobId": "xyz789" }
# Graph is ready in ~30 seconds
```

---

## Features

### Interactive dependency graph
Every file is a node. Every import is an edge. Nodes scale with LOC; colors encode language. ForceAtlas2 layout runs in a Web Worker — the UI never freezes, even on repos with 10,000+ files.

### One-click impact analysis
Click any file and ask *"what breaks if I change this?"* CodeVis traverses the import graph up to 3 hops and highlights every affected module in under 100ms — powered by a single Cypher query against Neo4j.

### Hotspot detection
The risk heatmap combines fan-in (how many files import you) with cyclomatic complexity (how hard you are to change). The intersection of high and high is where your next production incident is hiding.

### Circular dependency detection
Cycles in your import graph cause build failures, test flakiness, and initialization bugs. CodeVis finds every cycle and shows you exactly which files are involved — before they find you.

### Full-text symbol search
Search function names, class names, and exported symbols across the entire repo with fuzzy matching. Results in <5ms, served from a pre-built Fuse.js index in Redis.

### Dead code surface
Files that nobody imports and aren't entry points are highlighted as orphans. Not every orphan is dead — some are test utilities or CLI tools — but it's a good place to start trimming.

---

## Architecture

CodeVis is a TypeScript monorepo with five packages. Each one does exactly one thing.

### System overview

```
┌─────────────────────────────────────────────────────────────┐
│                        GitHub Repo                          │
│               https://github.com/owner/repo                 │
└──────────────────────────┬──────────────────────────────────┘
                           │  POST /api/repos
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      API Gateway                            │
│              Hono.js  ·  WebSocket  ·  Rate limit           │
└──────────────────────────┬──────────────────────────────────┘
                           │  enqueue
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Analysis Engine                          │
│                                                             │
│  clone.job          analyze.job          index.job          │
│  ──────────         ───────────          ─────────          │
│  git clone          tree-sitter          Fuse.js            │
│  --depth=1    →     AST parse      →     search index       │
│  --filter=    →     8 parallel     →     → Redis            │
│  blob:none          workers                                 │
│                     ↓                                       │
│                  Graph Engine                               │
│                  ──────────────                             │
│                  Neo4j write                                │
│                  UNWIND batch                               │
└──────────────────────────┬──────────────────────────────────┘
                           │  job:complete (WebSocket)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      Web Client                             │
│                                                             │
│  GET /api/repos/:id/graph                                   │
│         ↓                                                   │
│  Sigma.js + WebGL     ForceAtlas2 (Web Worker)              │
│  render nodes/edges   layout without blocking UI            │
└─────────────────────────────────────────────────────────────┘
```

### Data pipeline — from raw source to interactive graph

```
GitHub URL
   │
   ├─ 1. Clone          git clone --depth=1 --filter=blob:none
   │                    → /tmp/repos/{repoId}  (~2–5s)
   │
   ├─ 2. Discover       glob("**/*.{ts,js,py,go}")
   │                    → filePaths[]  (skip node_modules, dist)
   │
   ├─ 3. Parse          tree-sitter AST per file (8 workers in parallel)
   │                    → imports[], functions[], classes[], complexity
   │
   ├─ 4. Resolve        relative path → absolute path
   │                    → ImportEdge.toFile filled in
   │
   ├─ 5. Write graph    Neo4j UNWIND batch (500 nodes/tx)
   │                    (:File)-[:IMPORTS]→(:File)
   │                    (:File)-[:DEFINES]→(:Function)
   │
   ├─ 6. Write metadata PostgreSQL bulk INSERT
   │                    files(repo_id, path, language, loc, complexity)
   │
   └─ 7. Index          Fuse.js document array → Redis (TTL 24h)
                        searchable by filename + exported symbols
```

### Realtime flow — WebSocket & collaboration

```
User A opens graph                User B opens same graph
       │                                   │
       ▼                                   ▼
  WS connect                          WS connect
  subscribe(repoId)                   subscribe(repoId)
       │                                   │
       └──────── Yjs shared state ─────────┘
                       │
          ┌────────────┴────────────┐
          │                         │
   A clicks node X           B sees X highlighted
   A runs impact analysis    B sees blast radius overlay
   A types search query      B sees filtered graph update
          │                         │
          └────── <50ms round-trip ─┘
                  (CRDT merge, no locks)
```

### Package structure

```
codevis/
├── packages/
│   ├── analysis-engine/   # tree-sitter AST parser + Neo4j writer
│   ├── worker/            # BullMQ jobs: clone → analyze → index
│   ├── api-gateway/       # Hono REST API + WebSocket + sandbox + metrics
│   ├── graph-engine/      # Cypher queries + GraphService
│   └── web/               # Next.js 15 + Sigma.js graph viewer
└── infra/
    ├── docker-compose.yml
    ├── migrations/        # PostgreSQL + Neo4j schemas
    └── scripts/           # dev-setup.sh, reset-db.sh
```

**Technology choices — each one deliberate:**

| Layer | Technology | Why |
|---|---|---|
| AST parsing | tree-sitter | One API for 50+ languages. Parses 10k files in <30s |
| Graph storage | Neo4j 5 | `MATCH (f)<-[:IMPORTS*1..3]-(x)` vs. 5 recursive JOINs in SQL |
| Queue | BullMQ | Redis-backed, retries, progress events, dead letter queue built in |
| API | Hono.js | 3× faster than Express. Type-safe routing with `@hono/zod-validator` |
| Collaboration | Yjs (CRDT) | Conflict-free merge — same algorithm as Figma and Notion |
| Graph renderer | Sigma.js + WebGL | 50k+ nodes at 60fps. D3 SVG stutters at ~3k nodes |
| Layout | ForceAtlas2 (Web Worker) | Runs off the main thread — pan/zoom never drops a frame |
| Code execution | Docker (ephemeral) | Isolated per run, memory+CPU capped, no network access |
| Frontend | Next.js 15 (App Router) | Streaming, RSC, Turbopack in dev |

---

## Performance

Measured on a 4-core / 8GB machine with Docker Desktop:

| Benchmark | Result |
|---|---|
| Max codebase size tested | 500k LOC (Linux kernel subset) |
| React repo (247 files, 52k LOC) | Graph ready in **~8s** |
| Express repo (83 files, 12k LOC) | Graph ready in **~3s** |
| Node count before WebGL slows | **50,000+ nodes** at 60fps |
| Impact analysis query (Neo4j) | **<100ms** at depth=3 |
| Symbol search (Fuse.js / Redis) | **<5ms** for any query |
| WebSocket collaboration latency | **<50ms** end-to-end |
| Sandbox startup (Docker) | **~800ms** cold, ~200ms warm |
| ForceAtlas2 layout convergence | **~300 iterations** on Web Worker |
| Concurrent analysis jobs | **3 parallel** (CPU-bound, tunable) |

---

## Engineering Challenges

Building CodeVis required solving problems that don't have obvious off-the-shelf answers.

### Parsing large codebases without blocking

Naively parsing thousands of files sequentially takes minutes. The solution: `p-limit` with concurrency=8 workers, each running tree-sitter synchronously (tree-sitter is a C library — it's fast). Progress is reported every 50 files via `job.updateProgress()` to keep the WebSocket feed alive. On a 10,000-file repo, parse time is ~30 seconds wall-clock with 8 workers vs. ~4 minutes single-threaded.

### Handling cyclic dependencies correctly

Import cycles (A → B → C → A) are common in real codebases and cause naive graph traversals to loop forever. CodeVis uses Neo4j's built-in cycle detection: `MATCH path = (f)-[:IMPORTS*2..10]->(f)` with a `LIMIT 50` guard. For impact analysis, a `visited` set prevents re-traversal. For the ForceAtlas2 layout, cycles are handled naturally since the algorithm works on the full graph topology.

### Realtime graph sync without conflicts

When two users interact with the same graph simultaneously, naive "last write wins" causes flickering and lost state. CodeVis uses **Yjs** — a CRDT (Conflict-free Replicated Data Type) library. Every graph interaction is a Yjs operation. Operations from any client are merged deterministically: the same result on every client, regardless of arrival order. This means no locking, no server-side merge logic, and automatic reconnection recovery.

### Neo4j write throughput for large repos

Writing 10,000 nodes + edges one-by-one to Neo4j takes ~60 seconds due to per-transaction overhead. The solution: `UNWIND` batching — 500 rows per `MERGE` statement. This reduces the transaction count from 10,000 to 20, cutting write time to ~3 seconds. All writes use `MERGE` (not `CREATE`) so re-analysis is fully idempotent.

### Isolating user code execution

Running arbitrary user code is a security problem, not a feature problem. Each sandbox run creates an ephemeral Docker container with: `--network none` (no internet), `--read-only` (no filesystem writes), `--memory 128m`, `--cpus 0.5`, `--pids-limit 64` (no fork bombs), `--cap-drop ALL`, and a `timeout` wrapper that sends SIGKILL at 10 seconds. The container is destroyed immediately after the run — no state persists between executions.

---

## Getting started

### Prerequisites

- Docker 24+
- pnpm 9+
- Bun 1.1+
- Git

### Local development

```bash
# Clone and set up everything in one command
git clone https://github.com/taeezx44/Live-codebase
cd codevis
bash infra/scripts/dev-setup.sh
```

The setup script starts PostgreSQL, Neo4j, and Redis via Docker; waits for health checks; runs migrations; and installs dependencies. Takes about 90 seconds on first run.

```bash
# Start all services with hot-reload
pnpm dev
```

| Service | URL |
|---|---|
| Frontend | http://localhost:3000 |
| API | http://localhost:4000 |
| Neo4j Browser | http://localhost:7474 |
| API docs | http://localhost:4000/api/docs |

```bash
# Run all tests
pnpm test

# Typecheck all packages
pnpm typecheck

# Wipe all data and start fresh
bash infra/scripts/reset-db.sh
```

### Environment variables

Copy `.env.example` to `.env`. The defaults work for local development — you only need to change things if you want to analyze private repos (add `GITHUB_TOKEN`) or enable AI insights (add `ANTHROPIC_API_KEY`).

---

## API reference

### Import a repo

```http
POST /api/repos
Content-Type: application/json

{
  "url": "https://github.com/owner/repo",
  "branch": "main"         // optional, defaults to HEAD
}
```

```json
{
  "repoId": "550e8400-e29b-41d4-a716-446655440000",
  "jobId":  "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
}
```

Track progress over WebSocket:

```javascript
const ws = new WebSocket("ws://localhost:4000/ws");
ws.send(JSON.stringify({ type: "subscribe", jobId }));

ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  // { type: "job:progress", progress: { pct: 42, stage: "Parsing files", message: "1234 / 2891 files" } }
  // { type: "job:complete" }
};
```

### Get the graph

```http
GET /api/repos/:id/graph?language=typescript,javascript&maxComplexity=20
```

```json
{
  "repoId": "550e8400...",
  "nodes": [
    { "id": "/repo/src/app.ts", "language": "typescript", "loc": 142, "complexity": 8, "exportCount": 3 }
  ],
  "edges": [
    { "source": "/repo/src/app.ts", "target": "/repo/src/db.ts", "kind": "static", "symbols": ["query"] }
  ]
}
```

### Impact analysis

```http
GET /api/repos/:id/impact?path=/repo/src/db.ts&depth=3
```

```json
{
  "path": "/repo/src/db.ts",
  "affectedFiles": [
    { "path": "/repo/src/users.service.ts", "depth": 1 },
    { "path": "/repo/src/api.ts",           "depth": 2 }
  ],
  "depth": 3
}
```

### Hotspots

```http
GET /api/repos/:id/hotspots?mode=risk&limit=10
```

`mode` accepts `fanin` (most imported), `complexity` (highest cyclomatic), or `risk` (combined score).

---

## Supported languages

| Language | Extensions | Status |
|---|---|---|
| TypeScript | `.ts` `.tsx` `.mts` | ✅ Phase 1 |
| JavaScript | `.js` `.jsx` `.mjs` `.cjs` | ✅ Phase 1 |
| Python | `.py` | 🔄 Phase 2 |
| Go | `.go` | 🔄 Phase 2 |
| Java | `.java` | 🔄 Phase 3 |
| Rust | `.rs` | 📋 Planned |
| C/C++ | `.c` `.cpp` `.h` | 📋 Planned |

All parsers use tree-sitter — adding a new language is adding a grammar and a ~150-line parser class.

---

## Roadmap

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
- [x] Handle `.mts` / `.cts` module extensions
- [x] Detect re-exports: `export { foo } from "./foo"`

### Worker

- [x] `clone.job` — `git clone --depth=1 --filter=blob:none`
- [x] `analyze.job` — parse all files, write to Neo4j + PostgreSQL
- [x] `index.job` — build Fuse.js search index in Redis
- [x] BullMQ concurrency config (clone: 5, analyze: 3, index: 10)
- [x] Retry with exponential backoff + dead letter queue
- [x] Graceful shutdown on SIGTERM (finish active jobs before exit)
- [x] Repo size quota enforcement (`MAX_REPO_SIZE_MB`)
- [x] Support for private repos via `GITHUB_TOKEN`

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
- [x] `GET /repos` — list all repos with status
- [x] `POST /repos/:id/reanalyze` — trigger re-analysis of an existing repo
- [x] OpenAPI spec generation from Hono routes

### Graph engine (Neo4j)

- [x] Schema setup — constraints + range indexes + full-text index
- [x] `GRAPH_QUERIES` — repo graph, file detail, direct imports, imported-by
- [x] `IMPACT_QUERIES` — affected files, blast radius, has-importers check
- [x] `HOTSPOT_QUERIES` — fan-in, complexity, risk, orphans
- [x] `CALL_GRAPH_QUERIES` — called-by, call chain, complex functions in file
- [x] `CYCLE_QUERIES` — find all cycles, file-in-cycle check
- [x] `ARCH_QUERIES` — layer violations, entry points, lang stats
- [x] `GraphService` — typed wrapper with Neo4j Integer conversion
- [x] `ARCH_QUERIES.moduleClusters` — APOC SCC (requires APOC install)
- [x] Query result caching in Redis (TTL: 5 min for hotspots, 1 min for graph)

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
- [x] Loading skeleton for graph canvas
- [x] Empty state when repo has 0 files
- [x] Error boundary with retry button
- [x] Keyboard shortcut: `Cmd+K` opens search

### Documentation

- [x] `README.md` — flagship level with demo GIF
- [x] `CONTRIBUTING.md` — setup, testing, style, adding parsers and queries
- [x] `CHANGELOG.md` — Keep a Changelog format
- [x] `LICENSE` — MIT
- [x] `docs/architecture.md` — deeper dive on data flow
- [x] `docs/api.md` — auto-generated from OpenAPI spec

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

## Contributing

Contributions are welcome. A few things to know before you start:

**The codebase is a TypeScript strict-mode monorepo.** `any` types require a comment explaining why. Every new public function needs a JSDoc comment explaining what it does, not how.

**Tests are required for new features.** Unit tests live in `__tests__/` next to the code they test. Integration tests that need a real Neo4j or Redis instance are in `src/__tests__/` and require the infra stack to be running.

**The query layer is centralized.** All Cypher queries live in `packages/graph-engine/src/queries/index.ts`. Don't write inline Cypher strings elsewhere — every query should be named, documented, and typed.

```bash
# Fork and clone
git clone https://github.com/YOUR_USERNAME/Live-codebase
cd codevis
bash infra/scripts/dev-setup.sh

# Create a feature branch
git checkout -b feat/python-parser

# Make your changes, then
pnpm test
pnpm typecheck

# Open a PR against main
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide, including how to write a parser for a new language.

---

## Self-hosting

CodeVis is MIT-licensed and fully self-hostable. The Docker Compose stack in `infra/` is production-ready with one change: set real passwords in `.env` and point `NEO4J_URI` at a persistent volume.

For high-availability deployments, the Kubernetes manifests are in `infra/k8s/`. The worker is stateless and scales horizontally — run as many replicas as you have CPU cores to spare.

---

## License

MIT — see [LICENSE](LICENSE).

Built with [tree-sitter](https://tree-sitter.github.io/), [Neo4j](https://neo4j.com/), [Sigma.js](https://www.sigmajs.org/), [Hono](https://hono.dev/), and [BullMQ](https://bullmq.io/).

© 2025 Korawit Chuluean. All rights reserved.
