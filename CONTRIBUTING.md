# Contributing to CodeVis

Thank you for your interest in contributing. This guide covers everything from setting up your environment to getting your PR merged.

If you just want to report a bug or request a feature, open an [issue](https://github.com/codevis/codevis/issues) — you don't need to read this whole document.

---

## Table of contents

- [Code of conduct](#code-of-conduct)
- [Before you start](#before-you-start)
- [Development setup](#development-setup)
- [Project structure](#project-structure)
- [Making changes](#making-changes)
- [Testing](#testing)
- [Code style](#code-style)
- [Submitting a PR](#submitting-a-pr)
- [How to add a language parser](#how-to-add-a-language-parser)
- [How to add a Cypher query](#how-to-add-a-cypher-query)
- [Release process](#release-process)

---

## Code of conduct

Be direct. Be kind. Assume good faith. Disagreements about technical decisions are fine — personal attacks are not.

---

## Before you start

**Check existing issues and PRs first.** If you want to add a feature, open an issue to discuss it before writing code. There may already be a branch in progress, or the feature may be intentionally out of scope for the current phase.

**Good first issues** are labelled [`good first issue`](https://github.com/codevis/codevis/labels/good%20first%20issue). These are bugs or small features that don't require deep knowledge of the whole codebase.

**Larger contributions** — new language parsers, new graph queries, UI features — should be discussed in an issue first. This protects your time: it's better to spend 5 minutes discussing scope than 5 hours writing code that gets closed.

---

## Development setup

### Prerequisites

| Tool | Version | Install |
|---|---|---|
| Docker | 24+ | [docs.docker.com](https://docs.docker.com/get-docker/) |
| pnpm | 9+ | `npm install -g pnpm` |
| Bun | 1.1+ | [bun.sh](https://bun.sh) |
| Git | any | [git-scm.com](https://git-scm.com) |

### First-time setup

```bash
git clone https://github.com/YOUR_USERNAME/codevis
cd codevis
bash infra/scripts/dev-setup.sh
```

This script does everything: starts Docker containers, waits for health checks, runs database migrations, installs npm dependencies, and builds shared packages. It takes about 90 seconds the first time.

### Day-to-day development

```bash
# Start the infra (if not already running)
pnpm infra:up

# Start all services with hot-reload
pnpm dev
```

Each package runs its own dev server. The terminal output is colour-coded by package name via Turborepo.

### Useful commands

```bash
pnpm dev              # start everything with hot-reload
pnpm test             # run all tests
pnpm test --filter @codevis/analysis-engine   # one package
pnpm typecheck        # tsc --noEmit across all packages
pnpm lint             # Biome lint + format check
pnpm build            # production build

pnpm infra:up         # start postgres + neo4j + redis
pnpm infra:down       # stop infra containers
pnpm infra:logs       # tail container logs
pnpm infra:reset      # wipe all data and restart fresh
```

---

## Project structure

```
codevis/
├── packages/
│   ├── analysis-engine/   AST parsing (tree-sitter) + Neo4j write
│   ├── worker/            BullMQ jobs: clone → analyze → index
│   ├── api-gateway/       Hono REST API + WebSocket server
│   ├── graph-engine/      Cypher queries + GraphService + Neo4j schema
│   └── web/               Next.js 15 frontend + Sigma.js graph viewer
└── infra/
    ├── docker-compose.yml
    ├── migrations/        PostgreSQL SQL + Neo4j Cypher
    ├── docker/            Dockerfiles (api, worker, web)
    └── scripts/           dev-setup.sh, reset-db.sh
```

### Package dependency graph

```
web  ──────────────────────────────────► api-gateway
api-gateway ────────────────────────────► graph-engine
api-gateway ────────────────────────────► worker (job types only)
worker ─────────────────────────────────► analysis-engine
graph-engine ───────────────────────────► (neo4j-driver only)
analysis-engine ────────────────────────► (tree-sitter only)
```

**Packages never import from packages that depend on them.** `analysis-engine` does not know that `worker` exists. If you need to share a type between two packages, put it in the lower-level package or create a new shared type in `analysis-engine/src/types/`.

---

## Making changes

### Branch naming

```
feat/python-parser          new feature
fix/neo4j-integer-overflow  bug fix
docs/add-query-examples     documentation only
refactor/graph-service      internal restructuring
test/impact-query-coverage  adding tests only
```

### Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(analysis-engine): add Python AST parser
fix(api-gateway): handle Neo4j connection timeout on /health
docs(graph-engine): add examples to CYPHER query constants
test(worker): add integration test for analyze.job retry
refactor(web): extract useHoverNeighbours into separate hook
```

The scope is the package name without the `@codevis/` prefix. If a commit touches multiple packages, use the most significant one.

**Breaking changes** add `!` after the scope and a `BREAKING CHANGE:` footer:

```
feat(api-gateway)!: change graph response shape

BREAKING CHANGE: nodes now use `id` instead of `path` as the primary key.
Clients must update their node lookup logic.
```

---

## Testing

### Running tests

```bash
# All packages
pnpm test

# Single package
pnpm test --filter @codevis/analysis-engine

# Watch mode
pnpm test --filter @codevis/graph-engine -- --watch

# With coverage
pnpm test -- --coverage
```

### Test types

**Unit tests** — no external dependencies. Mock everything that talks to a database or the network. Live in `src/parsers/__tests__/` or similar, next to the code they test.

```typescript
// Good unit test — no real Neo4j, no real filesystem
it("extracts named ESM imports", () => {
  const result = parser.parse("/fake/app.ts", `import { useState } from "react"`);
  expect(result.imports[0]).toMatchObject({ toModule: "react", symbols: ["useState"] });
});
```

**Integration tests** — require real infrastructure (PostgreSQL, Neo4j, Redis). Live in `src/__tests__/`. These only run when the infra stack is up. They're excluded from CI unit test runs and run in a separate job with Docker service containers.

```typescript
// Good integration test — seeds real data, cleans up after
beforeAll(async () => { await seedTestRepo(TEST_REPO_ID); });
afterAll(async  () => { await dropRepoData(driver, TEST_REPO_ID); });

it("returns utils.ts as highest fan-in hotspot", async () => {
  const hotspots = await service.getHotspots(TEST_REPO_ID, "fanin");
  expect(hotspots[0].path).toBe(`${TEST_REPO_ID}:/repo/src/utils.ts`);
});
```

### What must be tested

| Change type | Required tests |
|---|---|
| New language parser | Unit tests for all import forms, function types, class extraction |
| New Cypher query | Integration test that seeds data and asserts results |
| New API route | Unit test with mocked DB + queue, at minimum happy path + 404 |
| New BullMQ job | Unit test with mock job object asserting progress events |
| Bug fix | Regression test that fails before the fix and passes after |
| Refactor | All existing tests must continue to pass — no new tests required |

### Test data

Don't use real GitHub repos in tests. Seed synthetic graph data using the pattern in `packages/graph-engine/src/__tests__/graph.service.test.ts`: create a small predictable graph (5–10 nodes, known topology) so tests are deterministic and fast.

---

## Code style

We use [Biome](https://biomejs.dev/) for linting and formatting. It runs on save in VS Code if you install the Biome extension. It also runs in CI — PRs with lint errors don't merge.

```bash
# Check
pnpm lint

# Fix auto-fixable issues
pnpm lint --apply
```

### TypeScript rules

**No `any`.** If you're reaching for `any`, you probably want `unknown` (and a type guard) or a generic. If you genuinely need `any` — for example, when wrapping a third-party library with no types — add a comment explaining why:

```typescript
// neo4j-driver returns Integer objects that don't have a public interface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toNum(val: any): number { ... }
```

**No inline type assertions (`as Foo`) without a comment.** Type assertions hide bugs. If you have to assert, explain why the type is actually correct at that point.

**Exported functions need JSDoc.** Not a novel — one sentence explaining what it does, not how:

```typescript
/** Converts a raw API graph response into a Graphology graph for Sigma. */
export function buildGraph(data: ApiGraphResponse): Graph<...> { ... }
```

Private/internal functions don't need JSDoc unless the logic is non-obvious.

**Prefer named exports over default exports** for anything other than React components and Next.js pages. Named exports are easier to refactor and grep.

### Cypher query rules

All Cypher lives in `packages/graph-engine/src/queries/index.ts`. Never write inline Cypher strings in route handlers, services, or tests.

Every query constant must have:
1. A comment explaining what it returns and when it's called
2. A performance note if it touches more than ~1000 nodes
3. A `LIMIT` clause if the result set is unbounded

```typescript
// ✅ Correct
export const HOTSPOT_QUERIES = {
  // Top files by combined risk score (fan-in × complexity).
  // Used by: GET /api/repos/:id/hotspots?mode=risk
  // Performance: file_repo_idx covers the WHERE clause. O(n) scan of repo's files.
  byRisk: `
    MATCH (f:File { repoId: $repoId })
    ...
    LIMIT $limit
  `,
};

// ❌ Wrong — inline Cypher in a route handler
router.get("/:id/hotspots", async (c) => {
  const result = await session.run(`MATCH (f:File) WHERE ...`);
});
```

### React component rules

Components live in `packages/web/src/components/`. Each component gets its own directory if it has more than one file (component + hooks + types).

**Props interfaces are defined in the same file as the component**, not in a separate `types.ts`, unless multiple components share the same prop type.

**Hooks that contain non-trivial logic get their own file** in a `hooks/` subdirectory. Hooks that are 5 lines or fewer can live inline in the component.

**No `useEffect` for derived state.** If a value can be computed from other state or props, use `useMemo` or compute it inline. `useEffect` is for synchronising with external systems (DOM, WebSocket, timers) — not for reacting to state changes.

---

## Submitting a PR

### Before opening a PR

```bash
# Make sure everything passes locally before pushing
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

### PR description template

When you open a PR, the template will prompt you for:

**What does this PR do?** One paragraph. What problem does it solve, or what feature does it add? Link to the issue it closes if there is one.

**How does it work?** For non-trivial changes, explain the approach. If you considered alternatives and rejected them, say so — it saves reviewers from suggesting those alternatives.

**How to test it?** What should a reviewer do to verify this works? A curl command, a sequence of UI interactions, a test command.

**Screenshots or recordings** for any UI change, no matter how small.

### What reviewers look at

**Correctness first.** Does it do what the description says? Do the tests actually test the right thing?

**Query performance.** New Cypher queries get checked for missing indexes and unbounded result sets. If a query touches variable-length paths (`*1..N`), explain the depth choice.

**Type safety.** No `any` without justification. No runtime casts without a comment.

**Test coverage.** New behaviour needs tests. We don't require 100% coverage, but we do require that the core happy path and the most obvious failure modes are covered.

**Backwards compatibility.** If you're changing an API response shape or a job data schema, is there a migration plan? Are there clients that depend on the old shape?

### Review turnaround

Maintainers aim to leave an initial review within 48 hours on weekdays. If you haven't heard back in 72 hours, ping the PR with a comment — GitHub notifications get noisy and things occasionally slip through.

---

## How to add a language parser

This is the most common contribution. Here is the exact process.

### 1. Add the tree-sitter grammar

```bash
cd packages/analysis-engine
pnpm add tree-sitter-python   # or go, java, rust, etc.
```

### 2. Create the parser class

Copy `src/parsers/javascript.parser.ts` as a starting point. Change three things:

**The grammar import and language property:**

```typescript
import TSPython from "tree-sitter-python";
import type { Language } from "../types/ast.js";

export class PythonParser extends BaseParser {
  readonly language: Language = "python";

  constructor() {
    super(TSPython);
  }
}
```

**The import extraction.** Python uses `import_statement` and `import_from_statement` instead of `import_statement`. Look up the node types for your language in the tree-sitter grammar's `grammar.js` or by parsing a sample file and logging `root.toString()`.

**The function extraction.** Python has `function_definition` with a `def` keyword. The `parameters` node structure differs from JavaScript — check the node type reference.

### 3. Register the extension mapping

In `src/engine.ts`, add to `EXT_TO_LANGUAGE`:

```typescript
const EXT_TO_LANGUAGE: Record<string, Language> = {
  // ...existing entries...
  ".py":  "python",
  ".pyi": "python",
};
```

And instantiate the parser in the `ParserEngine` constructor:

```typescript
this.parsers = new Map([
  ["javascript", new JavaScriptParser()],
  ["typescript", new TypeScriptParser()],
  ["python",     new PythonParser()],   // ← add this
]);
```

### 4. Add to supported languages in `graph.types.ts`

```typescript
export type NodeLanguage =
  | "typescript"
  | "javascript"
  | "python"       // ← add this
  | ...
```

### 5. Write tests

Create `src/parsers/__tests__/python.parser.test.ts`. Cover at minimum:

- `import module` (standard import)
- `from module import name` (named import)
- `from module import *` (wildcard)
- `import module as alias` (aliased import)
- Function definitions (sync and async)
- Class definitions with inheritance
- Top-level exports (anything defined at module scope)
- A parse error case (malformed Python)

Look at `javascript.parser.test.ts` for the structure — it's a good template.

### 6. Update the README

Add the language to the "Supported languages" table with status `🔄 Phase N` or `✅`.

---

## How to add a Cypher query

### 1. Write the query in `queries/index.ts`

Add it to the appropriate constant group (`GRAPH_QUERIES`, `IMPACT_QUERIES`, `HOTSPOT_QUERIES`, etc.). If it doesn't fit any existing group, create a new one.

Every query needs a block comment:

```typescript
export const MY_QUERIES = {
  // Returns X for a given Y.
  // Used by: describe where in the codebase this gets called.
  // Performance: describe which index covers the main WHERE clause.
  //              Add LIMIT if results are unbounded.
  myQuery: `
    MATCH (f:File { repoId: $repoId })
    ...
    LIMIT $limit
  `,
};
```

### 2. Add result types

If the query returns a new shape, add an interface to the top of `queries/index.ts`:

```typescript
export interface MyQueryResult {
  path:     string;
  language: string;
  score:    number;
}
```

### 3. Add a method to `GraphService`

In `services/graph.service.ts`, add a method that runs the query and maps results to the typed interface. Always convert Neo4j `Integer` values with `toNum()`:

```typescript
async getMyThing(repoId: string, limit = 20): Promise<MyQueryResult[]> {
  const session = this.session();
  try {
    const result = await session.run(MY_QUERIES.myQuery, {
      repoId,
      limit: neo4j.int(limit),
    });
    return result.records.map((r) => ({
      path:     toStr(r.get("path")),
      language: toStr(r.get("language")),
      score:    toNum(r.get("score")),
    }));
  } finally {
    await session.close();
  }
}
```

### 4. Write an integration test

Seed a small deterministic graph in `graph-engine/src/__tests__/graph.service.test.ts` and assert your query returns the expected results. The existing test setup handles seeding and cleanup — add your assertions to the existing `describe` block or create a new one.

### 5. Wire it up in the API

If the query backs a new API route, add the route in `packages/api-gateway/src/routes/analysis.ts` (or `repos.ts` for repo-scoped queries). Add a unit test with a mocked `GraphService`.

---

## Release process

Releases are managed by maintainers. Contributors don't need to worry about this section, but it's documented here for transparency.

We use [semantic versioning](https://semver.org/). Version bumps happen on `main` via a release PR that updates `CHANGELOG.md` and all `package.json` versions in one commit. The CI pipeline builds and pushes Docker images tagged with both the version and `latest` on merge to `main`.

Hotfixes follow the same process on a `hotfix/x.y.z` branch, merged to both `main` and the affected release tag.
