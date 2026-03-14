<div align="center">

<img src="https://raw.githubusercontent.com/taeezx44/Live-codebase/main/docs/assets/logo.svg" width="72" height="72" alt="CodeVis logo" />

# CodeVis

**A realtime collaborative platform for understanding any codebase — in seconds, not hours.**

Load a GitHub repo. Watch the dependency graph build live. Explore with your team in real time.

[![CI](https://github.com/taeezx44/Live-codebase/actions/workflows/ci.yml/badge.svg)](https://github.com/taeezx44/Live-codebase/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![pnpm](https://img.shields.io/badge/maintained%20with-pnpm-cc00ff.svg)](https://pnpm.io/)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun)](https://bun.sh)

[**Live Demo**](https://live-codebaseg.vercel.app/) · [**Roadmap**](#roadmap) · [**Contributing**](CONTRIBUTING.md)

<br/>

![CodeVis demo — dependency graph of the React repository](docs/assets/demo.gif)

*↑ The React repo, visualized. Every node is a file. Every edge is an import. Multiple users exploring together — in real time.*

</div>

---

## What is CodeVis?

Most tools tell you what code *does*. CodeVis shows you how it all *connects* — and lets your whole team explore it together.

Point it at any GitHub repo and it builds an interactive dependency graph in real time. Multiple engineers can explore the same graph simultaneously, see each other's cursors, and trace impact paths together — like Google Docs, but for architecture.

Built to demonstrate mastery of **realtime distributed systems**, **graph data modeling**, and **production observability**.

---

## Demo

| Feature | What happens |
|---|---|
| Import a repo | `POST /api/repos` → BullMQ job → WebSocket progress → graph renders |
| Realtime collaboration | Two users, one graph — cursors synced via Yjs CRDT, <50ms latency |
| Click any node | LOC, complexity score, imports, blast radius — all in one panel |
| Impact analysis | "What breaks if I change this file?" — answered in <100ms via Neo4j |
| Run code | Isolated Docker container → stdout streams back over WebSocket |
| Observability | Active users · API latency · queue depth · error rate — live |

---

## Architecture

```
Clients (Browser)
      │
      ▼
WebSocket Server
      │
      ├── Collaboration Layer (Yjs / CRDT)
      │     └── Graph state synced across all connected users
      │
      ├── Analysis Pipeline (BullMQ)
      │     ├── clone.job   → git clone --depth=1
      │     ├── analyze.job → tree-sitter AST parse
      │     └── index.job   → Fuse.js search index
      │
      └── Observability Sink
            └── metrics → realtime dashboard

API Server (Hono.js)
      │
      ├── PostgreSQL  — repo metadata, file stats
      ├── Neo4j       — dependency graph (nodes + edges)
      └── Redis       — job queue, search index, Yjs document store
```

**Request flow — from URL to rendered graph:**

```
POST /api/repos { url }
  → BullMQ: clone.job   (git clone --depth=1 --filter=blob:none)
  → BullMQ: analyze.job (tree-sitter parse × N workers → Neo4j write)
  → BullMQ: index.job   (Fuse.js index → Redis)
  → WebSocket: job:complete
  → Yjs: graph state broadcast to all connected clients
  → Sigma.js renders at 60fps
```

---

## Tech Stack

**Frontend**
- Next.js 15 (App Router, RSC, Turbopack)
- Sigma.js + WebGL — graph renderer, handles 50k+ nodes at 60fps
- Yjs — CRDT library for conflict-free realtime collaboration
- Monaco Editor — VS Code editor in browser (Phase 2)
- Tailwind CSS

**Backend**
- Bun — runtime (4× faster startup than Node)
- Hono.js — API framework, 3× faster than Express, fully type-safe
- WebSocket — realtime collaboration + live job progress
- BullMQ — async job queue with retry, DLQ, and progress events

**Database**
- Neo4j 5 — dependency graph, Cypher variable-length path queries
- PostgreSQL 16 — repo metadata, file stats
- Redis 7 — BullMQ queue, Fuse.js index cache, Yjs document persistence

**Parsing**
- tree-sitter — one AST API for 50+ languages, parses 10k files in <30s

**Observability**
- OpenTelemetry — distributed tracing across all services
- Custom `/api/metrics` endpoint — no external monitoring infra required
- Chart.js realtime dashboard — 5-second polling, ships with the app

**Infrastructure**
- Docker Compose — one command to start postgres + neo4j + redis locally
- GitHub Actions — CI: typecheck → test → build → docker verify
- Vercel — frontend · Fly.io — API + worker

---

## Features

### ✔ Interactive dependency graph
Every file is a node. Every import is an edge. Nodes scale with LOC; colors encode language. ForceAtlas2 layout runs in a Web Worker — the UI never freezes, even on repos with 10,000+ files.

### ✔ Realtime collaborative exploration
Multiple users explore the same graph simultaneously. Built on **Yjs** (CRDT) over WebSocket — the same conflict-resolution algorithm used by Notion and VS Code Live Share. Each user's cursor and selected node broadcast to all connected clients with <50ms latency.

```
User A clicks ReactFiber.js
  → Yjs broadcasts cursor position
  → User B sees A's highlight in real time
  → Both see impact analysis update together
```

No locking. No conflicts. State converges automatically even after reconnection.

### ✔ Impact analysis
Click any file and ask *"what breaks if I change this?"* Traverses the import graph up to 3 hops and highlights every affected module in under 100ms — a single Cypher query against Neo4j.

### ✔ Hotspot detection
Risk score = fan-in × cyclomatic complexity. The intersection of "many dependents" and "hard to change" is where your next production incident is hiding.

### ✔ Circular dependency detection
Finds every import cycle and shows exactly which files are involved — before they cause build failures or initialization bugs.

### ✔ Full-text symbol search
Search functions, classes, and exported symbols across the entire repo with fuzzy matching. Results in <5ms from a pre-built Fuse.js index in Redis.

### ✔ Code execution sandbox *(Phase 2)*
Run any file directly from the graph — no local setup needed. Each execution spins up an **isolated Docker container** with CPU, memory, and time limits.

```
User clicks Run on utils.ts
  → Ephemeral container (512MB RAM, 5s timeout, no network)
  → Code executes in isolation
  → stdout / stderr stream back via WebSocket
  → Container destroyed immediately after
```

Supports Node.js and Python. Security model: no network access, read-only filesystem, non-root user, seccomp profile.

### ✔ Observability dashboard
A live metrics dashboard showing system health — no Grafana required.

```
Active users        32        Job queue depth    4
Avg API latency     118ms     Parse errors/min   0.2
Repos analyzed      1,247     Neo4j query p99    43ms
```

Powered by OpenTelemetry at the API layer, aggregated at `/api/metrics`, rendered with Chart.js polling every 5 seconds.

### ✔ Dead code surface
Files with no importers that aren't entry points are surfaced as orphans — a good starting point for trimming unused code.

---

## How It Works

```
1. User pastes a GitHub URL and clicks Analyze
2. API enqueues a clone.job in BullMQ
3. Worker clones the repo (shallow, blob-filtered — fast)
4. analyze.job runs tree-sitter on every source file in parallel
5. Dependency edges written to Neo4j in batched transactions
6. index.job builds a Fuse.js search index stored in Redis
7. WebSocket broadcasts job:complete to all subscribed clients
8. Yjs syncs the graph state to every connected browser
9. Sigma.js renders; ForceAtlas2 runs layout on a Web Worker
10. All users see the graph simultaneously — no refresh needed
```

**Why Yjs / CRDT instead of locks or last-write-wins:**

CRDT (Conflict-free Replicated Data Type) allows every client to apply changes locally without waiting for a server ack. When two users change state simultaneously, Yjs merges both changes deterministically — the same result on every client, every time. This is how Figma, Notion, and VS Code Live Share work at scale.

---

## Supported Languages

| Language | Extensions | Status |
|---|---|---|
| TypeScript | `.ts` `.tsx` `.mts` | ✅ Phase 1 |
| JavaScript | `.js` `.jsx` `.mjs` `.cjs` | ✅ Phase 1 |
| Python | `.py` | 🔄 Phase 2 |
| Go | `.go` | 🔄 Phase 2 |
| Java | `.java` | 🔄 Phase 3 |
| Rust | `.rs` | 📋 Planned |
| C/C++ | `.c` `.cpp` `.h` | 📋 Planned |

All parsers use tree-sitter — adding a new language is a grammar package and a ~150-line parser class.

---

## Run Locally

### Prerequisites

| Tool | Version |
|---|---|
| Docker | 24+ |
| pnpm | 9+ |
| Bun | 1.1+ |
| Git | any |

### Setup

```bash
git clone https://github.com/taeezx44/Live-codebase
cd Live-codebase
bash infra/scripts/dev-setup.sh
```

Starts PostgreSQL, Neo4j, and Redis via Docker; waits for health checks; runs migrations; installs dependencies. ~90 seconds on first run.

```bash
pnpm dev    # start everything with hot-reload
```

| Service | URL |
|---|---|
| Frontend | http://localhost:3000 |
| API | http://localhost:4000 |
| Metrics dashboard | http://localhost:4000/api/metrics |
| Neo4j Browser | http://localhost:7474 |

```bash
pnpm test        # run all tests
pnpm typecheck   # tsc --noEmit across all packages
pnpm lint        # Biome lint + format check

bash infra/scripts/reset-db.sh   # wipe all data and start fresh
```

Copy `.env.example` to `.env`. Defaults work for local dev. Add `GITHUB_TOKEN` for private repos.

---

## API Reference

### Import a repo

```http
POST /api/repos
Content-Type: application/json

{ "url": "https://github.com/owner/repo" }
```

```json
{ "repoId": "550e8400...", "jobId": "6ba7b810..." }
```

Track progress over WebSocket:

```javascript
const ws = new WebSocket("ws://localhost:4000/ws");
ws.send(JSON.stringify({ type: "subscribe", jobId }));

ws.onmessage = ({ data }) => {
  const { type, progress } = JSON.parse(data);
  // type: "job:progress" → progress.pct, progress.stage
  // type: "job:complete"
};
```

### Get the graph

```http
GET /api/repos/:id/graph?language=typescript,javascript&maxComplexity=20
```

### Impact analysis

```http
GET /api/repos/:id/impact?path=/repo/src/db.ts&depth=3
```

### System metrics

```http
GET /api/metrics
```

```json
{
  "activeUsers": 32,
  "avgLatencyMs": 118,
  "jobQueueDepth": 4,
  "parseErrorsPerMin": 0.2,
  "neo4jQueryP99Ms": 43,
  "reposAnalyzed": 1247
}
```

---

## Roadmap

### Phase 1 — Core engine ✅
- [x] GitHub repo import via URL
- [x] JavaScript + TypeScript AST parsing with tree-sitter
- [x] Dependency graph stored in Neo4j
- [x] Interactive WebGL graph viewer (Sigma.js + ForceAtlas2 Web Worker)
- [x] Impact analysis — reverse traversal up to 3 hops
- [x] Hotspot detection — fan-in × complexity risk score
- [x] Circular dependency detection
- [x] Fuzzy + symbol search (Fuse.js + Redis)
- [x] Live progress via WebSocket
- [x] Realtime collaborative exploration (Yjs CRDT)
- [x] Observability dashboard (OpenTelemetry + Chart.js)

### Phase 2 — Intelligence 🔄 *(Q3 2025)*
- [ ] Python + Go parsers
- [ ] Code execution sandbox (Docker-isolated, Node + Python)
- [ ] Function-level call graph (`Function -[:CALLS]→ Function`)
- [ ] Class hierarchy graph (`Class -[:EXTENDS]→ Class`)
- [ ] VS Code extension — open any node directly in editor

### Phase 3 — History *(Q4 2025)*
- [ ] Git history analyzer — commit frequency, file churn
- [ ] Developer collaboration graph — who works on what
- [ ] Architecture timeline — graph evolution over commits

### Phase 4 — AI *(2026)*
- [ ] Natural language graph queries
- [ ] Design smell detection + refactor suggestions
- [ ] Auto-generated architecture documentation

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide — setup, testing standards, how to add a language parser, and how to add a Cypher query.

```bash
git clone https://github.com/YOUR_USERNAME/Live-codebase
cd Live-codebase
bash infra/scripts/dev-setup.sh
git checkout -b feat/python-parser
pnpm test && pnpm typecheck
# open PR
```

---

## License

MIT — see [LICENSE](LICENSE).

Built with [tree-sitter](https://tree-sitter.github.io/), [Neo4j](https://neo4j.com/), [Yjs](https://yjs.dev/), [Sigma.js](https://www.sigmajs.org/), [Hono](https://hono.dev/), and [BullMQ](https://bullmq.io/).

© 2025 Korawit Chuluean (taeezx44). All rights reserved.
