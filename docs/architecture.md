# Architecture

This document describes how CodeVis works internally — data flow, package boundaries, and key technical decisions.

## System Overview

```
Browser
  │
  ├─ Next.js frontend (packages/web)
  │    └─ Sigma.js WebGL graph + React UI
  │
  └─ WebSocket (job progress)

         ▼

API Gateway (packages/api-gateway)       ← Hono.js, port 4000
  │
  ├─ REST: POST /repos, GET /repos/:id/graph, GET /repos/:id/impact …
  ├─ WebSocket: /ws (job progress stream)
  └─ Rate limiter (Redis Lua script, sliding window)

         ▼

Worker (packages/worker)                 ← BullMQ, 3 queues
  │
  ├─ clone.job   — git clone --depth=1 --filter=blob:none
  ├─ analyze.job — parse files → write to Neo4j + PostgreSQL
  └─ index.job   — build Fuse.js search index → Redis

         ▼

Analysis Engine (packages/analysis-engine)
  │
  ├─ tree-sitter parsers (JS, TS, Python, Go)
  ├─ Cyclomatic complexity calculator
  ├─ Import resolver (relative paths + tsconfig aliases)
  └─ Neo4jWriter (batch UNWIND, 500 nodes/tx)

         ▼

Storage Layer
  ├─ Neo4j 5        — graph: File, Function, Class nodes + edges
  ├─ PostgreSQL 16  — repo metadata, job state, user settings
  └─ Redis 7        — BullMQ queues, Fuse.js indexes, query cache
```

---

## Data Flow: Repository Analysis

A complete analysis runs in three sequential BullMQ jobs:

### Job 1 — Clone

```
POST /repos { url: "https://github.com/..." }
  │
  ├─ Validates URL (GitHub only in v1)
  ├─ Inserts repo row into PostgreSQL (status: "queued")
  ├─ Enqueues clone job → BullMQ
  └─ Returns { repoId, jobId }

clone.job:
  1. git clone --depth=1 --filter=blob:none <url> /tmp/repos/<repoId>
  2. Check size against MAX_REPO_SIZE_MB (default 1000 MB)
  3. Inject GITHUB_TOKEN for private repos (x-access-token scheme)
  4. Glob all source files (.ts .tsx .js .jsx .py .go)
  5. Emit progress events via job.updateProgress()
  6. Return { filePaths[], commitHash, defaultBranch }
```

### Job 2 — Analyze

```
analyze.job receives filePaths[] from clone.job:
  1. ParserEngine.analyzeRepo() — p-limit(8) parallel file parsing
     │
     ├─ For each file: detect language by extension
     ├─ tree-sitter.parse(source) → CST
     ├─ Extract: imports, exports, functions, classes, complexity
     └─ ImportResolver: specifiers → absolute paths

  2. Neo4jWriter.writeRepo() — 6 UNWIND passes (500 nodes/batch):
     Pass 1: MERGE (:File) nodes
     Pass 2: MERGE (:Function) nodes + [:DEFINES] edges
     Pass 3: MERGE (:Class) nodes + [:DEFINES] edges
     Pass 4: MERGE [:IMPORTS] edges (resolved only)
     Pass 5: MERGE [:CALLS] edges (Function → Function)
     Pass 6: MERGE [:EXTENDS] + [:IMPLEMENTS] edges

  3. Update PostgreSQL: totalFiles, totalLoc, status: "ready"
```

### Job 3 — Index

```
index.job:
  1. Fetch all files + exports from PostgreSQL
  2. Build Fuse.js index (path, exports, language)
  3. Serialize index → Redis (TTL: 24h)
  4. Status → "indexed"
```

---

## Graph Schema (Neo4j)

### Node Labels

| Label | Key Properties |
|---|---|
| `File` | `path`, `language`, `loc`, `repoId` |
| `Function` | `id` (`repoId:path:name:line`), `name`, `complexity`, `isAsync` |
| `Class` | `id`, `name`, `superClass`, `interfaces[]` |

### Relationship Types

| Relationship | From → To | Properties |
|---|---|---|
| `IMPORTS` | File → File | `kind` (static/dynamic/require), `symbols[]`, `line` |
| `DEFINES` | File → Function/Class | — |
| `CALLS` | Function → Function | — |
| `EXTENDS` | Class → Class | — |
| `IMPLEMENTS` | Class → Class | — |

### Indexes

```cypher
-- Unique constraints (auto-create B-tree index)
CREATE CONSTRAINT FOR (f:File)     REQUIRE f.path IS UNIQUE
CREATE CONSTRAINT FOR (fn:Function) REQUIRE fn.id IS UNIQUE
CREATE CONSTRAINT FOR (c:Class)    REQUIRE c.id IS UNIQUE

-- Range index for repo scoping
CREATE INDEX FOR (f:File) ON (f.repoId)

-- Full-text index for symbol search
CREATE FULLTEXT INDEX symbolSearch FOR (fn:Function|c:Class) ON EACH [fn.name, c.name]
```

---

## Package Boundaries

Each package is a self-contained unit with a clear contract:

| Package | Owns | Depends on |
|---|---|---|
| `analysis-engine` | Parsing, AST extraction, Neo4j writing | `neo4j-driver`, `tree-sitter-*` |
| `worker` | Job orchestration, cloning, progress events | `analysis-engine`, `bullmq`, `simple-git` |
| `api-gateway` | HTTP + WebSocket API, rate limiting | `graph-engine`, `bullmq`, `hono` |
| `graph-engine` | All Cypher queries, typed result mapping | `neo4j-driver`, `ioredis` |
| `web` | Frontend graph viewer, React UI | `@react-sigma/core`, `graphology` |

No package may import from another package except through its public API. The `graph-engine` package is the only place where raw Cypher strings live — the API gateway imports `GraphService` methods, never writes Cypher inline.

---

## Key Technical Decisions

### tree-sitter for parsing

tree-sitter gives us a concrete syntax tree (CST) for 50+ languages through a single API. All parsers extend `BaseParser` and implement four abstract methods: `extractImports`, `extractExports`, `extractFunctions`, `extractClasses`. Adding a new language is ~200 lines.

Alternative considered: Babel AST — rejected because it only handles JS/TS and adds 40 MB to the worker image.

### Neo4j for graph storage

Graph databases have native variable-length path traversal: `MATCH (f)-[:IMPORTS*1..5]->(dep)` is a single query vs. recursive CTEs in PostgreSQL. Impact analysis and cycle detection both need this.

Alternative considered: PostgreSQL with recursive CTEs — rejected because query latency at depth > 3 becomes unpredictable (>500ms).

### Sigma.js + WebGL for rendering

Sigma.js renders 50,000+ nodes at 60fps using WebGL. D3.js SVG rendering degrades above ~5,000 nodes. ForceAtlas2 layout runs on a Web Worker so pan/zoom never blocks.

### BullMQ for job orchestration

The analysis pipeline has three distinct failure domains (network, compute, storage). BullMQ provides per-job retry policies, dead-letter queues, and progress events — all over Redis (no extra infrastructure).

### Hono.js for the API gateway

Hono is 3× faster than Express on Node, has first-class TypeScript support, and works on Cloudflare Workers if we ever move to edge deployment.

---

## Query Result Caching

Graph queries are cached in Redis with TTLs tuned to their volatility:

| Query type | TTL | Rationale |
|---|---|---|
| Full repo graph | 60s | Expensive traversal, rarely changes mid-session |
| Hotspots | 300s | Computed aggregation, stable within a session |
| Impact analysis | 30s | May change after reanalysis |
| Search index | 24h | Only rebuilt on `index.job` |

Cache is invalidated on `POST /repos/:id/reanalyze` via `GraphService.invalidateRepo()`.

---

## WebSocket Progress Events

Job progress is streamed to the browser over WebSocket:

```
Client connects: ws://localhost:4000/ws?repoId=<id>
  │
  Server subscribes to BullMQ QueueEvents for that repoId
  │
  On job.progress:   { type: "job:progress", pct, stage, message }
  On job.completed:  { type: "job:complete",  repoId, stats }
  On job.failed:     { type: "job:failed",    repoId, error }
```

The frontend polls `GET /jobs/:id` as a fallback if WebSocket disconnects.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j connection |
| `NEO4J_USER` | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | — | Neo4j password (required) |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `GITHUB_TOKEN` | — | Personal access token for private repos |
| `MAX_REPO_SIZE_MB` | `1000` | Reject repos larger than this |
| `API_PORT` | `4000` | API gateway port |
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed origin for CORS |
