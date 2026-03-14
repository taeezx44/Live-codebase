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

```
codevis/
├── packages/
│   ├── analysis-engine/   # tree-sitter AST parser + Neo4j writer
│   ├── worker/            # BullMQ jobs: clone → analyze → index
│   ├── api-gateway/       # Hono REST API + WebSocket server
│   ├── graph-engine/      # Cypher queries + GraphService
│   └── web/               # Next.js 15 + Sigma.js graph viewer
└── infra/
    ├── docker-compose.yml
    ├── migrations/        # PostgreSQL + Neo4j schemas
    └── scripts/           # dev-setup.sh, reset-db.sh
```

**Request flow — from URL to rendered graph:**

```
POST /api/repos { url }
  → BullMQ: clone.job   (git clone --depth=1 --filter=blob:none)
  → BullMQ: analyze.job (tree-sitter parse × N workers → Neo4j write)
  → BullMQ: index.job   (Fuse.js index → Redis)
  → WebSocket: job:complete
  → GET /api/repos/:id/graph
  → Sigma.js renders
```

**Technology choices — each one deliberate:**

| Layer | Technology | Why |
|---|---|---|
| AST parsing | tree-sitter | One API for 50+ languages. Fast enough to parse 10k files in <30s |
| Graph storage | Neo4j 5 | `MATCH (f)<-[:IMPORTS*1..3]-(x)` in one line vs. 5 recursive JOINs in SQL |
| Queue | BullMQ | Redis-backed, retries, progress events, dead letter queue built in |
| API | Hono.js | 3× faster than Express. Type-safe routing with `@hono/zod-validator` |
| Graph renderer | Sigma.js + WebGL | Handles 50k+ nodes at 60fps. D3 starts stuttering at ~3k |
| Layout | ForceAtlas2 (Web Worker) | Runs off the main thread — pan/zoom never drops a frame |
| Frontend | Next.js 15 (App Router) | Streaming, RSC, Turbopack in dev |

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
