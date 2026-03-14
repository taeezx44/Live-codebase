// ============================================================
// schema/setup.ts
//
// Run once on first deploy (and safely re-run any time).
// Creates all constraints and indexes. Uses IF NOT EXISTS
// everywhere so it's fully idempotent.
//
// Execution order matters:
//   1. Constraints first (auto-create backing indexes)
//   2. Additional composite indexes
//   3. Full-text index for symbol search
// ============================================================

import type { Driver } from "neo4j-driver";

// ── Constraints (unique + existence) ────────────────────────
// Each UNIQUE constraint implicitly creates a B-tree index.

const CONSTRAINTS: string[] = [
  // :File uniqueness — the path is globally unique per repo
  // (we prefix path with repoId to avoid cross-repo collisions)
  `CREATE CONSTRAINT file_path_unique IF NOT EXISTS
   FOR (f:File) REQUIRE f.path IS UNIQUE`,

  // :Function and :Class use a synthetic id = "{repoId}:{path}:{name}:{line}"
  `CREATE CONSTRAINT function_id_unique IF NOT EXISTS
   FOR (fn:Function) REQUIRE fn.id IS UNIQUE`,

  `CREATE CONSTRAINT class_id_unique IF NOT EXISTS
   FOR (c:Class) REQUIRE c.id IS UNIQUE`,

  `CREATE CONSTRAINT repo_id_unique IF NOT EXISTS
   FOR (r:Repo) REQUIRE r.id IS UNIQUE`,
];

// ── Range indexes (for WHERE / ORDER BY queries) ─────────────
// Neo4j 5 uses RANGE indexes by default — no need to specify type.

const RANGE_INDEXES: string[] = [
  // Most queries filter by repoId first — this is the most important index
  `CREATE INDEX file_repo_idx IF NOT EXISTS
   FOR (f:File) ON (f.repoId)`,

  // Language filter (GET /repos/:id/graph?language=typescript)
  `CREATE INDEX file_repo_lang_idx IF NOT EXISTS
   FOR (f:File) ON (f.repoId, f.language)`,

  // Hotspot queries sort by complexity DESC
  `CREATE INDEX file_repo_complexity_idx IF NOT EXISTS
   FOR (f:File) ON (f.repoId, f.complexity)`,

  // LOC-based sizing in graph view
  `CREATE INDEX file_repo_loc_idx IF NOT EXISTS
   FOR (f:File) ON (f.repoId, f.loc)`,

  // Function lookup by name (call graph resolution)
  `CREATE INDEX function_name_idx IF NOT EXISTS
   FOR (fn:Function) ON (fn.name)`,

  // Function complexity (hotspot functions)
  `CREATE INDEX function_complexity_idx IF NOT EXISTS
   FOR (fn:Function) ON (fn.filePath, fn.complexity)`,

  // Class lookup by name (inheritance queries)
  `CREATE INDEX class_name_idx IF NOT EXISTS
   FOR (c:Class) ON (c.name)`,
];

// ── Full-text index (for symbol search) ──────────────────────
// Neo4j full-text indexes use Lucene under the hood.
// We index Function.name and Class.name for semantic search.

const FULLTEXT_INDEXES: string[] = [
  `CREATE FULLTEXT INDEX symbol_search IF NOT EXISTS
   FOR (n:Function|Class) ON EACH [n.name]
   OPTIONS { indexConfig: { \`fulltext.analyzer\`: 'standard-no-stop-words' } }`,
];

// ── Main setup function ───────────────────────────────────────

export async function setupSchema(driver: Driver): Promise<void> {
  const session = driver.session();

  try {
    console.log("[neo4j] Setting up schema...");

    const allStatements = [
      ...CONSTRAINTS,
      ...RANGE_INDEXES,
      ...FULLTEXT_INDEXES,
    ];

    for (const stmt of allStatements) {
      try {
        await session.run(stmt);
        // Extract the index/constraint name for logging
        const name = stmt.match(/(?:INDEX|CONSTRAINT)\s+(\w+)/i)?.[1] ?? "unknown";
        console.log(`[neo4j]   ✓ ${name}`);
      } catch (err) {
        // IF NOT EXISTS should prevent this, but log anyway
        console.warn(`[neo4j]   ⚠ Statement failed (may already exist):`, (err as Error).message);
      }
    }

    console.log("[neo4j] Schema setup complete");
  } finally {
    await session.close();
  }
}

// ── Teardown (for tests) ──────────────────────────────────────

export async function dropRepoData(driver: Driver, repoId: string): Promise<void> {
  const session = driver.session();
  try {
    // DETACH DELETE removes all relationships too
    await session.run(
      `MATCH (n) WHERE n.repoId = $repoId DETACH DELETE n`,
      { repoId }
    );
  } finally {
    await session.close();
  }
}
