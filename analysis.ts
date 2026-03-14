// ============================================================
// routes/analysis.ts
//
// GET /api/repos/:id/impact?path=<filepath>
//   Returns all files that would be affected if the given
//   file changed (up to 3 hops through the import graph).
//
// GET /api/repos/:id/hotspots
//   Returns the top 20 most-imported files (high fan-in).
//   These are the "load-bearing" modules — changing them
//   has the widest blast radius.
//
// GET /api/repos/:id/search?q=<query>&limit=20
//   Full-text search over filenames + exported symbols.
//   Reads the Fuse.js index from Redis (written by index.job).
// ============================================================

import { Hono }          from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator }    from "@hono/zod-validator";
import { z }             from "zod";
import { cache }         from "hono/cache";
import type { AppEnv }   from "../app.js";
import { getNeo4jDriver } from "../lib/neo4j.js";
import { getRedisConnection } from "../lib/redis.js";

export const analysisRouter = new Hono<AppEnv>();

// ── GET /api/repos/:id/impact ─────────────────────────────────
// Query: ?path=/abs/path/to/file.ts
// Response: { path, affectedFiles: string[], depth: number }

const impactQuerySchema = z.object({
  path:  z.string().min(1),
  depth: z.coerce.number().min(1).max(5).optional().default(3),
});

analysisRouter.get(
  "/:id/impact",
  zValidator("query", impactQuerySchema),
  async (c) => {
    const { id }         = c.req.param();
    const { path, depth } = c.req.valid("query");

    const driver  = getNeo4jDriver();
    const session = driver.session();

    try {
      // Find all files that import THIS file (reverse traversal)
      // *1..depth = variable-length path up to `depth` hops
      const result = await session.run(
        `
        MATCH (f:File { path: $path, repoId: $repoId })
              <-[:IMPORTS*1..${depth}]-(importer:File { repoId: $repoId })
        RETURN DISTINCT importer.path AS path
        ORDER BY importer.path
        LIMIT 200
        `,
        { path, repoId: id }
      );

      const affectedFiles = result.records.map((r) => r.get("path") as string);

      return c.json({ path, affectedFiles, depth });
    } finally {
      await session.close();
    }
  }
);

// ── GET /api/repos/:id/hotspots ───────────────────────────────
// Files with the highest fan-in (most other files import them)
// are the riskiest to change. Cache for 5 minutes.

const hotspotsQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional().default(20),
});

analysisRouter.get(
  "/:id/hotspots",
  zValidator("query", hotspotsQuerySchema),
  cache({ cacheName: "hotspots", cacheControl: "max-age=300" }),
  async (c) => {
    const { id }    = c.req.param();
    const { limit } = c.req.valid("query");

    const driver  = getNeo4jDriver();
    const session = driver.session();

    try {
      const result = await session.run(
        `
        MATCH (f:File { repoId: $repoId })<-[:IMPORTS]-(importer)
        WITH f, count(importer) AS fanIn
        ORDER BY fanIn DESC
        LIMIT $limit
        RETURN
          f.path       AS path,
          f.language   AS language,
          f.loc        AS loc,
          f.complexity AS complexity,
          fanIn
        `,
        { repoId: id, limit }
      );

      const hotspots = result.records.map((r) => ({
        path:       r.get("path")       as string,
        language:   r.get("language")   as string,
        loc:        r.get("loc")        as number,
        complexity: r.get("complexity") as number,
        fanIn:      r.get("fanIn")      as number,
      }));

      return c.json({ repoId: id, hotspots });
    } finally {
      await session.close();
    }
  }
);

// ── GET /api/repos/:id/search?q=... ───────────────────────────
// Reads the pre-built Fuse.js index from Redis and does
// client-side fuzzy search. Fast (<5ms) for indexes up to
// ~50k documents because everything is already in memory.

const searchQuerySchema = z.object({
  q:     z.string().min(1).max(200),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
});

analysisRouter.get(
  "/:id/search",
  zValidator("query", searchQuerySchema),
  async (c) => {
    const { id }      = c.req.param();
    const { q, limit } = c.req.valid("query");

    const redis     = getRedisConnection();
    const indexJson = await redis.get(`search:index:${id}`);

    if (!indexJson) {
      throw new HTTPException(404, {
        message: "Search index not ready — analysis may still be running",
      });
    }

    // Dynamically import Fuse.js (avoid loading it on every request)
    const Fuse = (await import("fuse.js")).default;

    const docs = JSON.parse(indexJson) as object[];
    const fuse = new Fuse(docs, {
      keys: [
        { name: "filename", weight: 3 },    // filename match is most relevant
        { name: "symbols",  weight: 2 },    // exported symbol match
        { name: "dirPath",  weight: 1 },    // directory path
      ],
      threshold:           0.35,  // 0 = exact, 1 = match anything
      includeScore:        true,
      includeMatches:      true,
      minMatchCharLength:  2,
    });

    const rawResults = fuse.search(q, { limit });

    const results = rawResults.map(({ item, score, matches }) => ({
      ...item,
      score:   Math.round((1 - (score ?? 0)) * 100),   // 0-100, higher = better
      matches: matches?.map((m) => ({
        key:     m.key,
        indices: m.indices,
      })),
    }));

    return c.json({ query: q, results, total: results.length });
  }
);
