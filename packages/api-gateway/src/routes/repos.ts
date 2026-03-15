// ============================================================
// routes/repos.ts
//
// POST   /api/repos           — import a new repo
// GET    /api/repos/:id       — get repo status + metadata
// GET    /api/repos/:id/graph — get full dependency graph
// DELETE /api/repos/:id       — delete repo + all data
// ============================================================

import { Hono }          from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator }    from "@hono/zod-validator";
import { z }             from "zod";
import { randomUUID }    from "node:crypto";
import type { AppEnv }   from "../app.js";
import { getDb }         from "../lib/postgres.js";
import { getRepoAnalysisQueue } from "../lib/queue.js";
import { getNeo4jDriver }       from "../lib/neo4j.js";
import { CYPHER }               from "@codevis/analysis-engine/graph";
import {
  JOB,
  JOB_OPTS,
  type CloneJobData,
} from "@codevis/worker/job.types";

export const reposRouter = new Hono<AppEnv>();

// ── Validation schemas ────────────────────────────────────────

const createRepoSchema = z.object({
  url:    z.string().url().regex(
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/,
    "Only GitHub repos are supported in Phase 1"
  ),
  branch: z.string().optional(),
  name:   z.string().min(1).max(100).optional(),
});

// ── POST /api/repos ───────────────────────────────────────────
// Validates the URL, creates a repo record in PG, enqueues
// the clone job, and returns { repoId, jobId } immediately.
// The client then polls GET /api/jobs/:jobId or subscribes WS.

reposRouter.post(
  "/",
  zValidator("json", createRepoSchema),
  async (c) => {
    const { url, branch, name } = c.req.valid("json");
    const repoId = randomUUID();
    const jobId  = randomUUID();
    const db     = getDb();

    // Insert repo record before enqueuing — so status is queryable
    // immediately even before the job starts
    await db
      .insertInto("repos")
      .values({
        id:          repoId,
        url,
        branch:      branch ?? null,
        name:        name ?? extractRepoName(url),
        status:      "queued",
        created_at:  new Date(),
        updated_at:  new Date(),
      })
      .execute();

    // Enqueue the clone job (first step of the pipeline)
    const queue = getRepoAnalysisQueue();
    await queue.add(
      JOB.CLONE,
      {
        repoId,
        repoUrl:  url,
        branch,
        cloneDir: `/tmp/repos/${repoId}`,
      } satisfies CloneJobData,
      {
        ...JOB_OPTS.clone,
        jobId,   // use our UUID so client can track by this ID
      }
    );

    // Update repo record with jobId for status lookups
    await db
      .updateTable("repos")
      .set({ current_job_id: jobId, updated_at: new Date() })
      .where("id", "=", repoId)
      .execute();

    return c.json({ repoId, jobId }, 202);
  }
);

// ── GET /api/repos/:id ────────────────────────────────────────

reposRouter.get("/:id", async (c) => {
  const { id } = c.req.param();
  const db     = getDb();

  const repo = await db
    .selectFrom("repos")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (!repo) throw new HTTPException(404, { message: "Repo not found" });

  return c.json(repo);
});

// ── GET /api/repos/:id/graph ──────────────────────────────────
// Returns the full node+edge graph from Neo4j.
// Supports optional query params for filtering:
//   ?language=typescript,javascript
//   ?maxComplexity=20
//   ?limit=5000  (default 5000 — Sigma can handle more but UX suffers)

const graphQuerySchema = z.object({
  language:      z.string().optional(),  // comma-separated
  maxComplexity: z.coerce.number().min(1).max(1000).optional().default(1000),
  limit:         z.coerce.number().min(1).max(20_000).optional().default(5_000),
});

reposRouter.get(
  "/:id/graph",
  zValidator("query", graphQuerySchema),
  async (c) => {
    const { id }                            = c.req.param();
    const { language, maxComplexity, limit } = c.req.valid("query");

    const db = getDb();

    // Verify repo exists and analysis is complete
    const repo = await db
      .selectFrom("repos")
      .select(["id", "status"])
      .where("id", "=", id)
      .executeTakeFirst();

    if (!repo) throw new HTTPException(404, { message: "Repo not found" });
    if (repo.status !== "complete") {
      throw new HTTPException(409, {
        message: `Repo analysis is ${repo.status} — graph not ready yet`,
      });
    }

    // Build language filter array
    const languageFilter = language
      ? language.split(",").map((l) => l.trim())
      : null;

    // Query Neo4j for the full graph
    const driver  = getNeo4jDriver();
    const session = driver.session();

    try {
      const result = await session.run(
        buildGraphQuery(languageFilter, maxComplexity, limit),
        { repoId: id, maxComplexity, limit }
      );

      const record   = result.records[0];
      const rawNodes = record?.get("nodes") ?? [];
      const rawEdges = record?.get("edges") ?? [];

      // Serialize Neo4j integers to plain numbers
      const nodes = rawNodes.map((n: Record<string, unknown>) => ({
        ...n,
        loc:        toNumber(n.loc),
        complexity: toNumber(n.complexity),
        exportCount: toNumber(n.exportCount),
      }));

      const edges = rawEdges
        .filter((e: Record<string, unknown>) => e.source && e.target)
        .map((e: Record<string, unknown>) => ({
          source:  e.source,
          target:  e.target,
          kind:    e.kind,
          symbols: e.symbols ?? [],
        }));

      return c.json({ repoId: id, nodes, edges });
    } finally {
      await session.close();
    }
  }
);

// ── DELETE /api/repos/:id ─────────────────────────────────────
// Deletes repo from PG + all nodes/edges from Neo4j.
// This is irreversible — the user has to re-import.

// ── GET /repos — list all repos with status ──────────────────────────────
reposRouter.get("/", async (c) => {
  const db = getDb();
  const limit  = Math.min(Number(c.req.query("limit")  ?? 50), 100);
  const offset = Number(c.req.query("offset") ?? 0);
  const status = c.req.query("status"); // optional filter

  let query = db
    .selectFrom("repos")
    .select(["repo_id", "url", "status", "total_files", "analyzed_at", "created_at"])
    .orderBy("created_at", "desc")
    .limit(limit)
    .offset(offset);

  if (status) {
    query = query.where("status", "=", status);
  }

  const repos = await query.execute();
  return c.json({ repos, limit, offset });
});

// ── POST /repos/:id/reanalyze — re-trigger analysis ──────────────────────
reposRouter.post("/:id/reanalyze", async (c) => {
  const repoId = c.req.param("id");
  const db     = getDb();
  const queue  = getRepoAnalysisQueue();

  const repo = await db
    .selectFrom("repos")
    .select(["repo_id", "url"])
    .where("repo_id", "=", repoId)
    .executeTakeFirst();

  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }

  // Reset status and enqueue a fresh clone job
  await db
    .updateTable("repos")
    .set({ status: "queued", analyzed_at: null })
    .where("repo_id", "=", repoId)
    .execute();

  const job = await queue.add("clone", {
    repoId:   repo.repo_id,
    repoUrl:  repo.url,
    cloneDir: `/tmp/repos/${repo.repo_id}`,
  });

  return c.json({ repoId, jobId: job.id, status: "queued" });
});

reposRouter.delete("/:id", async (c) => {
  const { id } = c.req.param();
  const db     = getDb();

  const repo = await db
    .selectFrom("repos")
    .select(["id"])
    .where("id", "=", id)
    .executeTakeFirst();

  if (!repo) throw new HTTPException(404, { message: "Repo not found" });

  // Delete from Neo4j first (idempotent if already gone)
  const driver  = getNeo4jDriver();
  const session = driver.session();
  try {
    await session.run(
      `MATCH (n { repoId: $repoId }) DETACH DELETE n`,
      { repoId: id }
    );
  } finally {
    await session.close();
  }

  // Delete from PostgreSQL (cascades to files, file_symbols tables)
  await db.deleteFrom("repos").where("id", "=", id).execute();

  return c.json({ deleted: id }, 200);
});

// ── Helpers ───────────────────────────────────────────────────

function extractRepoName(url: string): string {
  // "https://github.com/facebook/react" → "facebook/react"
  return url.replace("https://github.com/", "");
}

function buildGraphQuery(
  languages: string[] | null,
  maxComplexity: number,
  limit: number
): string {
  const langFilter = languages?.length
    ? `AND f.language IN [${languages.map((l) => `'${l}'`).join(", ")}]`
    : "";

  return `
    MATCH (f:File { repoId: $repoId })
    WHERE f.complexity <= $maxComplexity ${langFilter}
    WITH f LIMIT ${limit}
    OPTIONAL MATCH (f)-[r:IMPORTS]->(dep:File { repoId: $repoId })
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
  `;
}

function toNumber(val: unknown): number {
  if (typeof val === "number") return val;
  // Neo4j Integer object
  if (val && typeof val === "object" && "toNumber" in val) {
    return (val as { toNumber(): number }).toNumber();
  }
  return Number(val) || 0;
}
