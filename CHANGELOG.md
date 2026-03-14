# Changelog

All notable changes to CodeVis are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- JavaScript and TypeScript AST parsing via tree-sitter
- Dependency graph stored in Neo4j (`:File` nodes, `[:IMPORTS]` edges)
- Interactive WebGL graph viewer using Sigma.js + ForceAtlas2 Web Worker
- Impact analysis — reverse traversal up to configurable hop depth
- Hotspot detection — combined fan-in × cyclomatic complexity risk score
- Circular dependency detection using variable-length Cypher path patterns
- Orphan file detection (files not imported by anything)
- Full-text symbol search backed by Fuse.js index in Redis
- Live job progress via WebSocket (`job:progress`, `job:complete`, `job:failed`)
- BullMQ pipeline: `clone.job` → `analyze.job` → `index.job`
- Hono.js API gateway with Zod request validation
- Redis sliding-window rate limiter (100 req/min general, 10 req/min for `POST /repos`)
- PostgreSQL schema: `repos`, `files`, `file_symbols`, `repo_jobs`
- Neo4j schema: constraints + range indexes + full-text index on `:Function|Class`
- Docker Compose stack for local development (postgres, neo4j, redis)
- Multi-stage Dockerfiles for api and worker
- `dev-setup.sh` — one-command local environment bootstrap
- GitHub Actions CI: typecheck, test, build, docker image verification
- `NodeDetailPanel` — file metadata, complexity bar, impact summary, VS Code deep link
- `GraphToolbar` — language filter pills, complexity slider, graph statistics

### Changed
- Nothing yet — first release

### Deprecated
- Nothing yet

### Removed
- Nothing yet

### Fixed
- Nothing yet

### Security
- Nothing yet

---

## [0.1.0] — TBD

*First public release. Packages all Phase 1 features listed above.*

---

<!-- Links updated by release script -->
[Unreleased]: https://github.com/codevis/codevis/compare/HEAD...HEAD
[0.1.0]: https://github.com/codevis/codevis/releases/tag/v0.1.0
