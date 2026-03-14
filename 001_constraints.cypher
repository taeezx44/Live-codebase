// ============================================================
// migrations/neo4j/001_constraints.cypher
//
// Run once against a fresh Neo4j instance to create constraints
// and indexes. The setup script (scripts/setup-neo4j.ts) runs
// this automatically on first `pnpm dev`.
//
// Constraints:
//   - File.path UNIQUE       — one node per file path
//   - Function.id UNIQUE     — one node per fn per file
//   - Class.id UNIQUE        — one node per class per file
//
// Indexes:
//   - File.repoId            — filter by repo (every query uses this)
//   - File.language          — filter by language
//   - File.complexity        — sort by complexity (hotspot queries)
//   - Function.name          — look up by function name
// ============================================================

// Unique constraints (also create an index automatically)
CREATE CONSTRAINT file_path_unique IF NOT EXISTS
  FOR (f:File) REQUIRE f.path IS UNIQUE;

CREATE CONSTRAINT function_id_unique IF NOT EXISTS
  FOR (fn:Function) REQUIRE fn.id IS UNIQUE;

CREATE CONSTRAINT class_id_unique IF NOT EXISTS
  FOR (c:Class) REQUIRE c.id IS UNIQUE;

// Additional indexes for common query patterns
CREATE INDEX file_repo_idx IF NOT EXISTS
  FOR (f:File) ON (f.repoId);

CREATE INDEX file_language_idx IF NOT EXISTS
  FOR (f:File) ON (f.repoId, f.language);

CREATE INDEX file_complexity_idx IF NOT EXISTS
  FOR (f:File) ON (f.repoId, f.complexity);

CREATE INDEX function_name_idx IF NOT EXISTS
  FOR (fn:Function) ON (fn.name);
