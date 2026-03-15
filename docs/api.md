# API Reference

Base URL: `http://localhost:4000`

All responses are JSON. Errors follow `{ error: string, code?: string }`.

---

## Repositories

### POST /api/repos

Enqueue a new repository for analysis.

**Request body**
```json
{
  "url":    "https://github.com/owner/repo",
  "branch": "main"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | ✓ | GitHub HTTPS URL |
| `branch` | string | — | Branch to clone (default: repo default branch) |

**Response `201`**
```json
{
  "repoId": "abc123",
  "jobId":  "bullmq-job-id",
  "status": "queued"
}
```

**Errors**
- `400` — invalid URL or missing field
- `409` — repo already exists (use `POST /repos/:id/reanalyze` to re-run)
- `429` — rate limited

---

### GET /api/repos

List all repositories with their current status.

**Query params**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | number | 50 | Max results (max 100) |
| `offset` | number | 0 | Pagination offset |
| `status` | string | — | Filter by status: `queued` \| `cloning` \| `analyzing` \| `ready` \| `failed` |

**Response `200`**
```json
{
  "repos": [
    {
      "repo_id":     "abc123",
      "url":         "https://github.com/owner/repo",
      "status":      "ready",
      "total_files": 247,
      "analyzed_at": "2025-06-01T12:00:00Z",
      "created_at":  "2025-06-01T11:58:00Z"
    }
  ],
  "limit": 50,
  "offset": 0
}
```

---

### GET /api/repos/:id

Get metadata and status for a specific repository.

**Response `200`**
```json
{
  "repoId":      "abc123",
  "url":         "https://github.com/owner/repo",
  "status":      "ready",
  "totalFiles":  247,
  "totalLoc":    52000,
  "analyzedAt":  "2025-06-01T12:00:00Z",
  "commitHash":  "a1b2c3d",
  "branch":      "main"
}
```

**Errors**
- `404` — repo not found

---

### DELETE /api/repos/:id

Delete a repository and all its graph data.

**Response `200`**
```json
{ "deleted": true }
```

---

### POST /api/repos/:id/reanalyze

Re-trigger analysis for an existing repository (e.g. after a push).

**Response `200`**
```json
{
  "repoId": "abc123",
  "jobId":  "bullmq-job-id",
  "status": "queued"
}
```

---

## Graph

### GET /api/repos/:id/graph

Returns the full dependency graph (nodes + edges).

**Query params**

| Param | Type | Default | Description |
|---|---|---|---|
| `languages` | string | — | Comma-separated filter: `ts,js,py` |
| `maxComplexity` | number | 1000 | Hide files with cyclomatic complexity above this |
| `nodeLimit` | number | 2000 | Max nodes returned |

**Response `200`**
```json
{
  "repoId": "abc123",
  "nodes": [
    {
      "id":          "src/app.ts",
      "language":    "typescript",
      "loc":         310,
      "complexity":  12,
      "exportCount": 4
    }
  ],
  "edges": [
    {
      "source":  "src/app.ts",
      "target":  "src/utils.ts",
      "kind":    "static",
      "symbols": ["parseConfig", "logger"]
    }
  ]
}
```

---

### GET /api/repos/:id/impact

Reverse traversal: which files would be affected if this file changes?

**Query params**

| Param | Type | Default | Description |
|---|---|---|---|
| `path` | string | ✓ | Absolute file path |
| `depth` | number | 3 | Max hops (1–10) |

**Response `200`**
```json
{
  "path": "src/utils.ts",
  "affectedFiles": [
    { "path": "src/app.ts",     "depth": 1 },
    { "path": "src/server.ts",  "depth": 1 },
    { "path": "test/app.test.ts", "depth": 2 }
  ],
  "depth": 3
}
```

---

### GET /api/repos/:id/hotspots

Returns files ranked by risk (fan-in × complexity).

**Query params**

| Param | Type | Default | Description |
|---|---|---|---|
| `mode` | string | `risk` | `fanin` \| `complexity` \| `risk` |
| `limit` | number | 20 | Max results |

**Response `200`**
```json
{
  "hotspots": [
    {
      "path":       "src/utils.ts",
      "language":   "typescript",
      "loc":        580,
      "complexity": 24,
      "fanIn":      18,
      "fanOut":     6,
      "riskScore":  432
    }
  ]
}
```

---

### GET /api/repos/:id/search

Fuzzy + symbol search across the repository.

**Query params**

| Param | Type | Description |
|---|---|---|
| `q` | string | Search query (min 2 chars) |
| `limit` | number | Max results (default 20) |

**Response `200`**
```json
{
  "results": [
    {
      "type":    "file",
      "path":    "src/utils.ts",
      "score":   0.95
    },
    {
      "type":    "symbol",
      "name":    "parseConfig",
      "filePath": "src/utils.ts",
      "kind":    "function",
      "score":   0.88
    }
  ]
}
```

---

## Jobs

### GET /api/jobs/:id

Get job state and progress (polling fallback if WebSocket unavailable).

**Response `200`**
```json
{
  "jobId":    "bullmq-job-id",
  "state":    "active",
  "progress": {
    "pct":     65,
    "stage":   "Analyzing",
    "message": "Parsing 160 / 247 files…"
  },
  "failedReason": null
}
```

Job states: `waiting` | `active` | `completed` | `failed` | `delayed`

---

## Health

### GET /health

Liveness probe — returns 200 if the process is running.

```json
{ "status": "ok", "uptime": 3600 }
```

### GET /health/ready

Readiness probe — returns 200 only when Neo4j, PostgreSQL, and Redis are all reachable.

```json
{
  "status": "ready",
  "checks": {
    "neo4j":    "ok",
    "postgres": "ok",
    "redis":    "ok"
  }
}
```

Returns `503` with failing check names if any dependency is down.

---

## WebSocket

Connect to `ws://localhost:4000/ws?repoId=<id>` to receive real-time job progress.

### Events

**`job:progress`**
```json
{
  "type":    "job:progress",
  "repoId":  "abc123",
  "jobId":   "bullmq-job-id",
  "pct":     45,
  "stage":   "Analyzing",
  "message": "Parsing 111 / 247 files…"
}
```

**`job:complete`**
```json
{
  "type":   "job:complete",
  "repoId": "abc123",
  "stats": {
    "totalFiles": 247,
    "totalLoc":   52000,
    "durationMs": 8200
  }
}
```

**`job:failed`**
```json
{
  "type":   "job:failed",
  "repoId": "abc123",
  "error":  "Repo exceeds size limit (1200 MB > 1000 MB)"
}
```

---

## Rate Limiting

All endpoints are rate-limited per IP using a Redis sliding-window algorithm:

| Tier | Limit |
|---|---|
| Default | 60 requests / minute |
| `POST /repos` | 10 requests / minute |
| WebSocket connections | 5 concurrent per IP |

Exceeded requests receive `429 Too Many Requests` with a `Retry-After` header.

---

## Error Codes

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `INVALID_URL` | URL is not a valid GitHub HTTPS URL |
| 400 | `MISSING_FIELD` | Required field absent from request body |
| 404 | `REPO_NOT_FOUND` | No repo with that ID |
| 409 | `REPO_EXISTS` | Repo already analyzed — use reanalyze endpoint |
| 422 | `REPO_TOO_LARGE` | Repo exceeds `MAX_REPO_SIZE_MB` |
| 429 | `RATE_LIMITED` | Too many requests |
| 503 | `DEPENDENCY_DOWN` | Neo4j / PostgreSQL / Redis unreachable |
