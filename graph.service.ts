// ============================================================
// services/graph.service.ts
//
// Typed service layer that wraps Neo4j queries.
// All Neo4j integer → JS number conversion happens here.
// Callers get clean typed objects — no neo4j-driver internals.
//
// Every method:
//   1. Opens a session
//   2. Runs a parameterized query
//   3. Maps records to typed results
//   4. Closes the session in finally{}
//   5. Returns typed data
// ============================================================

import type { Driver, Integer } from "neo4j-driver";
import neo4j from "neo4j-driver";
import {
  GRAPH_QUERIES,
  IMPACT_QUERIES,
  HOTSPOT_QUERIES,
  CALL_GRAPH_QUERIES,
  CYCLE_QUERIES,
  ARCH_QUERIES,
  type GraphNode,
  type GraphEdge,
  type HotspotResult,
  type ImpactResult,
  type CircularDep,
  type FunctionCallNode,
  type SymbolSearchResult,
} from "../queries/index.js";

// ── Type helpers ──────────────────────────────────────────────

// Neo4j returns Integer objects for all int properties.
// toNum() converts safely, handling both Integer and plain number.
function toNum(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (neo4j.isInt(val as Integer)) return (val as Integer).toNumber();
  return Number(val) || 0;
}

function toBool(val: unknown): boolean {
  return Boolean(val);
}

function toStr(val: unknown): string {
  return String(val ?? "");
}

function toArr(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.map(toStr);
}

// ── GraphService ──────────────────────────────────────────────

export class GraphService {
  constructor(private readonly driver: Driver) {}

  private session() {
    return this.driver.session();
  }

  // ── Graph retrieval ─────────────────────────────────────────

  async getRepoGraph(
    repoId: string,
    opts: {
      languages?: string[];
      maxComplexity?: number;
      nodeLimit?: number;
    } = {}
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const session = this.session();
    try {
      const result = await session.run(GRAPH_QUERIES.repoGraph, {
        repoId,
        maxComplexity: neo4j.int(opts.maxComplexity ?? 1000),
        languages:     opts.languages ?? null,
        nodeLimit:     neo4j.int(opts.nodeLimit ?? 5000),
      });

      const record = result.records[0];
      if (!record) return { nodes: [], edges: [] };

      const rawNodes: Record<string, unknown>[] = record.get("nodes") ?? [];
      const rawEdges: Record<string, unknown>[] = record.get("edges") ?? [];

      const nodes: GraphNode[] = rawNodes.map((n) => ({
        id:          toStr(n.id),
        language:    toStr(n.language),
        loc:         toNum(n.loc),
        complexity:  toNum(n.complexity),
        exportCount: toNum(n.exportCount),
      }));

      const edges: GraphEdge[] = rawEdges
        .filter((e) => e.source && e.target)
        .map((e) => ({
          source:  toStr(e.source),
          target:  toStr(e.target),
          kind:    toStr(e.kind),
          symbols: toArr(e.symbols),
        }));

      return { nodes, edges };
    } finally {
      await session.close();
    }
  }

  // ── File detail ─────────────────────────────────────────────

  async getFileDetail(path: string): Promise<{
    path: string;
    language: string;
    loc: number;
    complexity: number;
    exportCount: number;
    importCount: number;
    importedByCount: number;
  } | null> {
    const session = this.session();
    try {
      const result = await session.run(GRAPH_QUERIES.fileDetail, { path });
      const r = result.records[0];
      if (!r) return null;

      return {
        path:            toStr(r.get("path")),
        language:        toStr(r.get("language")),
        loc:             toNum(r.get("loc")),
        complexity:      toNum(r.get("complexity")),
        exportCount:     toNum(r.get("exportCount")),
        importCount:     toNum(r.get("importCount")),
        importedByCount: toNum(r.get("importedByCount")),
      };
    } finally {
      await session.close();
    }
  }

  // ── Impact analysis ─────────────────────────────────────────

  async getImpactedFiles(
    repoId: string,
    filePath: string,
    depth = 3
  ): Promise<ImpactResult[]> {
    const session = this.session();
    try {
      const result = await session.run(IMPACT_QUERIES.affectedFiles, {
        repoId,
        path:  filePath,
        depth: neo4j.int(depth),
      });

      return result.records.map((r) => ({
        path:  toStr(r.get("path")),
        depth: toNum(r.get("depth")),
      }));
    } finally {
      await session.close();
    }
  }

  async getBlastRadius(
    repoId: string,
    filePath: string
  ): Promise<{ depth: number; affectedCount: number }[]> {
    const session = this.session();
    try {
      const result = await session.run(IMPACT_QUERIES.blastRadius, {
        repoId,
        path: filePath,
      });

      return result.records.map((r) => ({
        depth:         toNum(r.get("depth")),
        affectedCount: toNum(r.get("affectedCount")),
      }));
    } finally {
      await session.close();
    }
  }

  // ── Hotspots ─────────────────────────────────────────────────

  async getHotspots(
    repoId: string,
    mode: "fanin" | "complexity" | "risk" = "risk",
    limit = 20
  ): Promise<HotspotResult[]> {
    const session = this.session();

    const queryMap = {
      fanin:      HOTSPOT_QUERIES.byFanIn,
      complexity: HOTSPOT_QUERIES.byComplexity,
      risk:       HOTSPOT_QUERIES.byRisk,
    };

    try {
      const result = await session.run(queryMap[mode], {
        repoId,
        limit: neo4j.int(limit),
      });

      return result.records.map((r) => ({
        path:       toStr(r.get("path")),
        language:   toStr(r.get("language")),
        loc:        toNum(r.get("loc")),
        complexity: toNum(r.get("complexity")),
        fanIn:      toNum(r.get("fanIn") ?? 0),
        fanOut:     toNum(r.get("fanOut") ?? 0),
      }));
    } finally {
      await session.close();
    }
  }

  async getOrphans(repoId: string): Promise<{ path: string; language: string; loc: number }[]> {
    const session = this.session();
    try {
      const result = await session.run(HOTSPOT_QUERIES.orphans, { repoId });
      return result.records.map((r) => ({
        path:     toStr(r.get("path")),
        language: toStr(r.get("language")),
        loc:      toNum(r.get("loc")),
      }));
    } finally {
      await session.close();
    }
  }

  // ── Circular dependencies ────────────────────────────────────

  async findCycles(repoId: string): Promise<CircularDep[]> {
    const session = this.session();
    try {
      const result = await session.run(CYCLE_QUERIES.findCycles, { repoId });
      return result.records.map((r) => ({
        cycle:  toArr(r.get("cycle")),
        length: toNum(r.get("length")),
      }));
    } finally {
      await session.close();
    }
  }

  // ── Architecture ──────────────────────────────────────────────

  async getEntryPoints(repoId: string): Promise<{ path: string; language: string; loc: number }[]> {
    const session = this.session();
    try {
      const result = await session.run(ARCH_QUERIES.entryPoints, { repoId });
      return result.records.map((r) => ({
        path:     toStr(r.get("path")),
        language: toStr(r.get("language")),
        loc:      toNum(r.get("loc")),
      }));
    } finally {
      await session.close();
    }
  }

  async getLangStats(repoId: string): Promise<{
    language: string;
    fileCount: number;
    totalLoc: number;
    avgComplexity: number;
    maxComplexity: number;
    totalParseErrors: number;
  }[]> {
    const session = this.session();
    try {
      const result = await session.run(ARCH_QUERIES.langStats, { repoId });
      return result.records.map((r) => ({
        language:         toStr(r.get("language")),
        fileCount:        toNum(r.get("fileCount")),
        totalLoc:         toNum(r.get("totalLoc")),
        avgComplexity:    toNum(r.get("avgComplexity")),
        maxComplexity:    toNum(r.get("maxComplexity")),
        totalParseErrors: toNum(r.get("totalParseErrors")),
      }));
    } finally {
      await session.close();
    }
  }

  // ── Full-text symbol search ───────────────────────────────────

  async searchSymbols(
    repoId: string,
    query: string,
    limit = 20
  ): Promise<SymbolSearchResult[]> {
    const session = this.session();
    try {
      // Neo4j full-text search returns a score 0–1 (higher = better match)
      const result = await session.run(
        `
        CALL db.index.fulltext.queryNodes('symbol_search', $query)
        YIELD node, score
        WHERE node.filePath STARTS WITH $repoPrefix
        RETURN
          node.name     AS name,
          labels(node)[0] AS kind,
          node.filePath AS filePath,
          score
        ORDER BY score DESC
        LIMIT $limit
        `,
        {
          query:      query + "~",    // ~ = fuzzy search in Lucene
          repoPrefix: repoId + ":",   // files are prefixed with repoId
          limit:      neo4j.int(limit),
        }
      );

      return result.records.map((r) => ({
        name:     toStr(r.get("name")),
        kind:     toStr(r.get("kind")) as "Function" | "Class",
        filePath: toStr(r.get("filePath")),
        score:    toNum(r.get("score")),
      }));
    } finally {
      await session.close();
    }
  }

  // ── Call graph ───────────────────────────────────────────────

  async getCallChain(functionId: string): Promise<FunctionCallNode[][]> {
    const session = this.session();
    try {
      const result = await session.run(CALL_GRAPH_QUERIES.callChain, { functionId });

      // Each record is one path through the call graph
      return result.records.map((r) => {
        const ids:   string[] = toArr(r.get("ids"));
        const names: string[] = toArr(r.get("names"));
        return ids.map((id, i) => ({
          id,
          name:       names[i] ?? id,
          filePath:   "",   // enriched by caller if needed
          complexity: 0,
          isAsync:    false,
        }));
      });
    } finally {
      await session.close();
    }
  }
}
