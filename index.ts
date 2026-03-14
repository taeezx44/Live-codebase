// ============================================================
// queries/index.ts
//
// Every Cypher query used by the application, in one place.
//
// Design principles:
//   - All queries are parameterized (never string-interpolated)
//   - Every query includes a comment explaining what it does
//     and when it's called
//   - Performance notes included for queries that touch
//     >1000 nodes (LIMIT, index hints where needed)
//   - Results are typed — callers don't need to cast
// ============================================================

// ── Query result types ────────────────────────────────────────

export interface GraphNode {
  id:          string;
  language:    string;
  loc:         number;
  complexity:  number;
  exportCount: number;
}

export interface GraphEdge {
  source:  string;
  target:  string;
  kind:    string;
  symbols: string[];
}

export interface HotspotResult {
  path:       string;
  language:   string;
  loc:        number;
  complexity: number;
  fanIn:      number;   // how many files import this file
  fanOut:     number;   // how many files this file imports
}

export interface ImpactResult {
  path:  string;
  depth: number;   // how many hops away from the changed file
}

export interface FunctionCallNode {
  id:         string;
  name:       string;
  filePath:   string;
  complexity: number;
  isAsync:    boolean;
}

export interface CircularDep {
  cycle: string[];   // ordered list of file paths forming the cycle
  length: number;
}

export interface SymbolSearchResult {
  name:      string;
  kind:      "Function" | "Class";
  filePath:  string;
  score:     number;
}

// ── Graph queries ─────────────────────────────────────────────

export const GRAPH_QUERIES = {

  // ── Full repo graph (nodes + edges) ─────────────────────────
  // Used by: GET /api/repos/:id/graph
  // Returns all File nodes and IMPORTS edges for a repo.
  // Filters applied before the OPTIONAL MATCH to avoid
  // loading excluded nodes into memory.
  //
  // Performance: The file_repo_lang_idx covers the WHERE clause.
  // LIMIT applies to nodes only — edges are collected from the
  // matched node set, not independently limited.

  repoGraph: `
    MATCH (f:File { repoId: $repoId })
    WHERE f.complexity <= $maxComplexity
      AND ($languages IS NULL OR f.language IN $languages)
    WITH f LIMIT $nodeLimit

    OPTIONAL MATCH (f)-[r:IMPORTS]->(dep:File { repoId: $repoId })
    WHERE dep.complexity <= $maxComplexity
      AND ($languages IS NULL OR dep.language IN $languages)

    RETURN
      collect(DISTINCT {
        id:          f.path,
        language:    f.language,
        loc:         f.loc,
        complexity:  f.complexity,
        exportCount: f.exportCount
      }) AS nodes,
      collect(DISTINCT {
        source:  f.path,
        target:  dep.path,
        kind:    r.kind,
        symbols: r.symbols
      }) AS edges
  `,

  // ── Single file node (detail panel) ─────────────────────────
  // Used by: NodeDetailPanel initial load
  // Fast: hits the UNIQUE constraint index on path.

  fileDetail: `
    MATCH (f:File { path: $path })
    OPTIONAL MATCH (f)-[:IMPORTS]->(dep:File)
    OPTIONAL MATCH (importer:File)-[:IMPORTS]->(f)
    RETURN
      f.path        AS path,
      f.language    AS language,
      f.loc         AS loc,
      f.complexity  AS complexity,
      f.exportCount AS exportCount,
      count(DISTINCT dep)      AS importCount,
      count(DISTINCT importer) AS importedByCount
  `,

  // ── Direct imports of a file ─────────────────────────────────
  // Used by: NodeDetailPanel "imports" list

  directImports: `
    MATCH (f:File { path: $path })-[r:IMPORTS]->(dep:File)
    RETURN
      dep.path     AS path,
      dep.language AS language,
      dep.loc      AS loc,
      r.kind       AS kind,
      r.symbols    AS symbols
    ORDER BY dep.path
    LIMIT 100
  `,

  // ── Files that import a given file ───────────────────────────
  // Used by: NodeDetailPanel "imported by" list

  importedBy: `
    MATCH (importer:File)-[r:IMPORTS]->(f:File { path: $path })
    RETURN
      importer.path     AS path,
      importer.language AS language,
      importer.loc      AS loc,
      r.kind            AS kind
    ORDER BY importer.path
    LIMIT 100
  `,

} as const;

// ── Impact analysis queries ───────────────────────────────────

export const IMPACT_QUERIES = {

  // ── Affected files (reverse traversal) ──────────────────────
  // Used by: GET /api/repos/:id/impact?path=...
  //
  // Finds all files that transitively import the given file
  // up to $depth hops. Uses variable-length path pattern.
  //
  // Performance note: variable-length traversal can be expensive
  // on dense graphs. The LIMIT 500 prevents runaway queries.
  // For most repos, hotspot files have <100 importers at depth 3.

  affectedFiles: `
    MATCH (changed:File { path: $path, repoId: $repoId })
    MATCH p = (changed)<-[:IMPORTS*1..$depth]-(importer:File { repoId: $repoId })
    WITH importer, min(length(p)) AS closestDepth
    RETURN
      importer.path AS path,
      closestDepth  AS depth
    ORDER BY closestDepth ASC, importer.path ASC
    LIMIT 500
  `,

  // ── Blast radius summary ─────────────────────────────────────
  // How many files are affected at each depth level?
  // Used by: impact panel summary section

  blastRadius: `
    MATCH (changed:File { path: $path, repoId: $repoId })
    MATCH p = (changed)<-[:IMPORTS*1..3]-(importer:File { repoId: $repoId })
    WITH length(p) AS depth
    RETURN depth, count(*) AS affectedCount
    ORDER BY depth ASC
  `,

  // ── Safe to delete? ──────────────────────────────────────────
  // Check if a file has zero importers (can be safely removed)

  hasImporters: `
    MATCH (f:File { path: $path, repoId: $repoId })<-[:IMPORTS]-()
    RETURN count(*) > 0 AS hasImporters
  `,

} as const;

// ── Hotspot queries ───────────────────────────────────────────

export const HOTSPOT_QUERIES = {

  // ── Top files by fan-in (most imported) ─────────────────────
  // Used by: GET /api/repos/:id/hotspots
  // "Hub" files — changing them has the widest blast radius.
  // Covered by: file_repo_complexity_idx

  byFanIn: `
    MATCH (f:File { repoId: $repoId })
    OPTIONAL MATCH (f)<-[:IMPORTS]-(importer:File { repoId: $repoId })
    OPTIONAL MATCH (f)-[:IMPORTS]->(dep:File { repoId: $repoId })
    WITH f,
         count(DISTINCT importer) AS fanIn,
         count(DISTINCT dep)      AS fanOut
    WHERE fanIn > 0
    RETURN
      f.path       AS path,
      f.language   AS language,
      f.loc        AS loc,
      f.complexity AS complexity,
      fanIn,
      fanOut
    ORDER BY fanIn DESC
    LIMIT $limit
  `,

  // ── Top files by cyclomatic complexity ──────────────────────
  // Technical debt hotspots — complex code that's hard to change.

  byComplexity: `
    MATCH (f:File { repoId: $repoId })
    WHERE f.complexity > 0
    RETURN
      f.path       AS path,
      f.language   AS language,
      f.loc        AS loc,
      f.complexity AS complexity
    ORDER BY f.complexity DESC
    LIMIT $limit
  `,

  // ── Combined risk score ──────────────────────────────────────
  // Risk = high fan-in AND high complexity.
  // These are the files most likely to cause bugs when changed.
  // Score formula: (fanIn × 0.6) + (complexity × 0.4), normalized.

  byRisk: `
    MATCH (f:File { repoId: $repoId })
    OPTIONAL MATCH (f)<-[:IMPORTS]-(importer:File { repoId: $repoId })
    WITH f, count(DISTINCT importer) AS fanIn
    WHERE fanIn > 0 OR f.complexity > 5
    WITH f, fanIn,
         (fanIn * 0.6 + f.complexity * 0.4) AS riskScore
    RETURN
      f.path       AS path,
      f.language   AS language,
      f.loc        AS loc,
      f.complexity AS complexity,
      fanIn,
      round(riskScore, 1) AS riskScore
    ORDER BY riskScore DESC
    LIMIT $limit
  `,

  // ── Orphan files (no importers, not an entry point) ──────────
  // Files that nobody imports — potential dead code.

  orphans: `
    MATCH (f:File { repoId: $repoId })
    WHERE NOT (f)<-[:IMPORTS]-()
      AND NOT f.path ENDS WITH 'index.ts'
      AND NOT f.path ENDS WITH 'index.js'
      AND NOT f.path ENDS WITH 'main.ts'
      AND NOT f.path ENDS WITH 'main.js'
    RETURN
      f.path     AS path,
      f.language AS language,
      f.loc      AS loc
    ORDER BY f.loc DESC
    LIMIT 50
  `,

} as const;

// ── Call graph queries ────────────────────────────────────────

export const CALL_GRAPH_QUERIES = {

  // ── Functions called by a given function (direct) ────────────
  // Used by: call graph panel, "what does this call?"

  calledBy: `
    MATCH (caller:Function { id: $functionId })-[:CALLS]->(callee:Function)
    RETURN
      callee.id         AS id,
      callee.name       AS name,
      callee.filePath   AS filePath,
      callee.complexity AS complexity,
      callee.isAsync    AS isAsync
    ORDER BY callee.name
    LIMIT 50
  `,

  // ── Full call chain (execution path) ────────────────────────
  // Traces the execution path from a root function.
  // Used by: "Trace execution" feature in call graph view.

  callChain: `
    MATCH path = (root:Function { id: $functionId })-[:CALLS*1..5]->(leaf:Function)
    RETURN
      [n IN nodes(path) | n.id]   AS ids,
      [n IN nodes(path) | n.name] AS names,
      length(path)                 AS depth
    ORDER BY depth ASC
    LIMIT 100
  `,

  // ── Functions with high complexity in a file ─────────────────
  // Used by: file detail panel "complex functions" list

  complexFunctionsInFile: `
    MATCH (f:File { path: $filePath })-[:DEFINES]->(fn:Function)
    WHERE fn.complexity > $minComplexity
    RETURN
      fn.id         AS id,
      fn.name       AS name,
      fn.complexity AS complexity,
      fn.loc        AS loc,
      fn.isAsync    AS isAsync,
      fn.isExported AS isExported
    ORDER BY fn.complexity DESC
    LIMIT 20
  `,

} as const;

// ── Circular dependency detection ────────────────────────────

export const CYCLE_QUERIES = {

  // ── Find all cycles (up to length 10) ────────────────────────
  // A cycle means: File A imports File B which (transitively)
  // imports File A back. This is a common source of bugs and
  // bundler warnings.
  //
  // Performance: This query can be slow on large graphs.
  // Run it asynchronously and cache the results in Redis.
  // LIMIT 50 prevents it from running forever on pathological graphs.

  findCycles: `
    MATCH path = (f:File { repoId: $repoId })-[:IMPORTS*2..10]->(f)
    WITH [n IN nodes(path) | n.path] AS cycle
    RETURN DISTINCT cycle, size(cycle) AS length
    ORDER BY length ASC
    LIMIT 50
  `,

  // ── Check if a specific file is in a cycle ───────────────────

  fileInCycle: `
    MATCH path = (f:File { path: $path })-[:IMPORTS*2..6]->(f)
    RETURN count(path) > 0 AS inCycle
  `,

} as const;

// ── Architecture detection queries ───────────────────────────

export const ARCH_QUERIES = {

  // ── Detect layer violations (layered architecture) ───────────
  // In a clean layered arch, controllers import services,
  // services import repositories — never the reverse.
  // This query finds violations.

  layerViolations: `
    MATCH (low:File)-[:IMPORTS]->(high:File)
    WHERE (low.path CONTAINS '/repositories/' OR low.path CONTAINS '/models/')
      AND (high.path CONTAINS '/controllers/' OR high.path CONTAINS '/routes/')
      AND low.repoId = $repoId
    RETURN
      low.path  AS fromPath,
      high.path AS toPath,
      'lower layer imports upper layer' AS violation
    LIMIT 50
  `,

  // ── Find entry points (files not imported by anyone) ─────────
  // Entry points = likely controllers, routes, CLI entry files.

  entryPoints: `
    MATCH (f:File { repoId: $repoId })
    WHERE NOT (f)<-[:IMPORTS]-(:File { repoId: $repoId })
      AND (f)-[:IMPORTS]->()
    RETURN
      f.path     AS path,
      f.language AS language,
      f.loc      AS loc
    ORDER BY f.loc DESC
    LIMIT 30
  `,

  // ── Module clusters (strongly connected components) ──────────
  // Files that heavily import each other form "clusters" —
  // likely belong to the same feature/module.
  // Uses APOC (must be installed): apoc.algo.scc

  moduleClusters: `
    CALL apoc.algo.scc('File', 'IMPORTS', {
      write: false,
      partitionProperty: 'sccId'
    })
    YIELD loadMillis, computeMillis
    MATCH (f:File { repoId: $repoId })
    WHERE f.sccId IS NOT NULL
    WITH f.sccId AS clusterId, collect(f.path) AS members
    WHERE size(members) > 1
    RETURN clusterId, members, size(members) AS clusterSize
    ORDER BY clusterSize DESC
    LIMIT 20
  `,

  // ── Dependency statistics per language ───────────────────────
  // Used by: dashboard overview panel

  langStats: `
    MATCH (f:File { repoId: $repoId })
    RETURN
      f.language           AS language,
      count(f)             AS fileCount,
      sum(f.loc)           AS totalLoc,
      avg(f.complexity)    AS avgComplexity,
      max(f.complexity)    AS maxComplexity,
      sum(f.parseErrors)   AS totalParseErrors
    ORDER BY fileCount DESC
  `,

} as const;
