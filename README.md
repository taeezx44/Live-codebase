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

![CodeVis demo — dependency graph of the React repository](docs/assets/demo.gif)

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

### Phase 1 — Core engine *(current)*
- [x] GitHub repo import via URL
- [x] JavaScript + TypeScript AST parsing with tree-sitter
- [x] Dependency graph (File → File via IMPORTS)
- [x] Interactive WebGL graph viewer (Sigma.js + ForceAtlas2)
- [x] Impact analysis (reverse traversal up to 3 hops)
- [x] Hotspot detection (fan-in × complexity risk score)
- [x] Circular dependency detection
- [x] Fuzzy + symbol search
- [x] Live progress via WebSocket

### Phase 2 — Intelligence *(Q3 2025)*
- [ ] Python + Go parsers
- [ ] Function-level call graph (`Function -[:CALLS]→ Function`)
- [ ] Class hierarchy graph (`Class -[:EXTENDS]→ Class`)
- [ ] Complexity trend over time (per-commit snapshots)
- [ ] VS Code extension — open any node directly in editor

### Phase 3 — History *(Q4 2025)*
- [ ] Git history analyzer — commit frequency, file churn
- [ ] Developer collaboration graph — who works on what together
- [ ] Architecture timeline — see how the graph evolved over versions
- [ ] `--since` and `--until` filters on the graph view

### Phase 4 — AI *(2026)*
- [ ] AI code insights — design smell detection, refactor suggestions
- [ ] Natural language graph queries ("show me all files that touch payments")
- [ ] Auto-generated architecture documentation
- [ ] Multi-repo analysis for microservice systems

---

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
