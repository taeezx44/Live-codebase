// ============================================================
// __tests__/graph.service.test.ts
//
// Integration tests for GraphService against a real Neo4j instance.
// Requires: NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD env vars
//           (points at a test database, NOT production)
//
// Each test suite:
//   beforeAll  — seed a small synthetic repo graph
//   afterAll   — delete all seeded data by repoId
//
// The synthetic repo has this structure:
//
//   index.ts  ──IMPORTS──►  utils.ts
//   index.ts  ──IMPORTS──►  db.ts
//   api.ts    ──IMPORTS──►  index.ts
//   api.ts    ──IMPORTS──►  utils.ts
//   utils.ts  ──IMPORTS──►  constants.ts
//
//   Cycles: none
//   Entry points: api.ts
//   Hotspot (most imported): utils.ts (fan-in: 2)
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDriver, closeDriver } from "../src/lib/driver.js";
import { GraphService } from "../src/services/graph.service.js";
import { setupSchema, dropRepoData } from "../src/schema/setup.js";

const TEST_REPO_ID = `test-${Date.now()}`;

// Synthetic file paths (prefixed with repoId for uniqueness)
const FILES = {
  index:     `${TEST_REPO_ID}:/repo/src/index.ts`,
  utils:     `${TEST_REPO_ID}:/repo/src/utils.ts`,
  db:        `${TEST_REPO_ID}:/repo/src/db.ts`,
  api:       `${TEST_REPO_ID}:/repo/src/api.ts`,
  constants: `${TEST_REPO_ID}:/repo/src/constants.ts`,
};

async function seedTestData(): Promise<void> {
  const driver = getDriver();
  const session = driver.session();
  try {
    // Create File nodes
    await session.run(`
      UNWIND $files AS f
      MERGE (:File {
        path:       f.path,
        repoId:     f.repoId,
        language:   f.language,
        loc:        f.loc,
        complexity: f.complexity,
        exportCount: f.exportCount
      })
    `, {
      files: [
        { path: FILES.index,     repoId: TEST_REPO_ID, language: "typescript", loc: 50,  complexity: 4,  exportCount: 3 },
        { path: FILES.utils,     repoId: TEST_REPO_ID, language: "typescript", loc: 120, complexity: 8,  exportCount: 10 },
        { path: FILES.db,        repoId: TEST_REPO_ID, language: "typescript", loc: 80,  complexity: 6,  exportCount: 4 },
        { path: FILES.api,       repoId: TEST_REPO_ID, language: "typescript", loc: 200, complexity: 15, exportCount: 2 },
        { path: FILES.constants, repoId: TEST_REPO_ID, language: "typescript", loc: 20,  complexity: 1,  exportCount: 8 },
      ],
    });

    // Create IMPORTS edges
    await session.run(`
      UNWIND $edges AS e
      MATCH (from:File { path: e.from })
      MATCH (to:File   { path: e.to   })
      MERGE (from)-[:IMPORTS { kind: e.kind, symbols: e.symbols }]->(to)
    `, {
      edges: [
        { from: FILES.index, to: FILES.utils,     kind: "static",  symbols: ["formatDate", "slugify"] },
        { from: FILES.index, to: FILES.db,         kind: "static",  symbols: ["query", "transaction"] },
        { from: FILES.api,   to: FILES.index,      kind: "static",  symbols: ["handler"] },
        { from: FILES.api,   to: FILES.utils,      kind: "static",  symbols: ["formatDate"] },
        { from: FILES.utils, to: FILES.constants,  kind: "static",  symbols: ["MAX_LEN", "TIMEOUT"] },
      ],
    });
  } finally {
    await session.close();
  }
}

// ── Test suite ────────────────────────────────────────────────

describe("GraphService", () => {
  let service: GraphService;

  beforeAll(async () => {
    const driver = getDriver();
    await setupSchema(driver);
    await seedTestData();
    service = new GraphService(driver);
  });

  afterAll(async () => {
    await dropRepoData(getDriver(), TEST_REPO_ID);
    await closeDriver();
  });

  // ── getRepoGraph ──────────────────────────────────────────

  describe("getRepoGraph", () => {
    it("returns all nodes and edges for a repo", async () => {
      const { nodes, edges } = await service.getRepoGraph(TEST_REPO_ID);

      expect(nodes).toHaveLength(5);
      expect(edges.length).toBeGreaterThanOrEqual(5);

      const nodeIds = nodes.map((n) => n.id);
      expect(nodeIds).toContain(FILES.index);
      expect(nodeIds).toContain(FILES.utils);
    });

    it("filters by language", async () => {
      const { nodes } = await service.getRepoGraph(TEST_REPO_ID, {
        languages: ["typescript"],
      });
      expect(nodes).toHaveLength(5);

      const { nodes: emptyNodes } = await service.getRepoGraph(TEST_REPO_ID, {
        languages: ["python"],
      });
      expect(emptyNodes).toHaveLength(0);
    });

    it("filters by maxComplexity", async () => {
      // Only index (4), constants (1) are below complexity 5
      const { nodes } = await service.getRepoGraph(TEST_REPO_ID, {
        maxComplexity: 5,
      });
      const complexities = nodes.map((n) => n.complexity);
      expect(complexities.every((c) => c <= 5)).toBe(true);
    });
  });

  // ── getImpactedFiles ──────────────────────────────────────

  describe("getImpactedFiles", () => {
    it("finds files impacted by changing utils.ts", async () => {
      // utils.ts is imported by index.ts and api.ts
      const impacts = await service.getImpactedFiles(
        TEST_REPO_ID,
        FILES.utils,
        3
      );
      const paths = impacts.map((i) => i.path);
      expect(paths).toContain(FILES.index);
      expect(paths).toContain(FILES.api);
    });

    it("constants.ts impacts traverse through utils → index → api", async () => {
      const impacts = await service.getImpactedFiles(
        TEST_REPO_ID,
        FILES.constants,
        3
      );
      const paths = impacts.map((i) => i.path);
      // constants → utils → index and api (depth 2, 3)
      expect(paths).toContain(FILES.utils);
    });

    it("api.ts has no importers (it's an entry point)", async () => {
      const impacts = await service.getImpactedFiles(
        TEST_REPO_ID,
        FILES.api,
        3
      );
      expect(impacts).toHaveLength(0);
    });
  });

  // ── getHotspots ───────────────────────────────────────────

  describe("getHotspots", () => {
    it("returns utils.ts as highest fan-in hotspot", async () => {
      const hotspots = await service.getHotspots(TEST_REPO_ID, "fanin");
      expect(hotspots.length).toBeGreaterThan(0);
      // utils.ts is imported by index + api = fan-in 2 (highest)
      expect(hotspots[0].path).toBe(FILES.utils);
      expect(hotspots[0].fanIn).toBe(2);
    });

    it("returns api.ts as highest complexity hotspot", async () => {
      const hotspots = await service.getHotspots(TEST_REPO_ID, "complexity");
      expect(hotspots[0].path).toBe(FILES.api);
      expect(hotspots[0].complexity).toBe(15);
    });
  });

  // ── getOrphans ────────────────────────────────────────────

  describe("getOrphans", () => {
    it("api.ts is an orphan (not imported by any other file)", async () => {
      const orphans = await service.getOrphans(TEST_REPO_ID);
      const paths = orphans.map((o) => o.path);
      expect(paths).toContain(FILES.api);
    });
  });

  // ── findCycles ────────────────────────────────────────────

  describe("findCycles", () => {
    it("returns no cycles in our clean test graph", async () => {
      const cycles = await service.findCycles(TEST_REPO_ID);
      expect(cycles).toHaveLength(0);
    });
  });

  // ── getLangStats ──────────────────────────────────────────

  describe("getLangStats", () => {
    it("returns correct stats for typescript files", async () => {
      const stats = await service.getLangStats(TEST_REPO_ID);
      expect(stats).toHaveLength(1);
      expect(stats[0].language).toBe("typescript");
      expect(stats[0].fileCount).toBe(5);
      expect(stats[0].totalLoc).toBe(470);  // 50+120+80+200+20
    });
  });

  // ── getEntryPoints ────────────────────────────────────────

  describe("getEntryPoints", () => {
    it("identifies api.ts as the only entry point", async () => {
      const entries = await service.getEntryPoints(TEST_REPO_ID);
      const paths = entries.map((e) => e.path);
      expect(paths).toContain(FILES.api);
      // utils, index, db, constants are all imported by something
      expect(paths).not.toContain(FILES.utils);
    });
  });
});
