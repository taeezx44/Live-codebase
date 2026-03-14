// ============================================================
// routes/jobs.ts
//
// GET /api/jobs/:id
//   Returns current state and progress of a BullMQ job.
//   Polled by the frontend before the WS connection is open,
//   or as a fallback when WS is unavailable.
//
// Response:
//   {
//     jobId:    string
//     state:    "waiting" | "active" | "completed" | "failed" | "delayed"
//     progress: JobProgress | null
//     result:   AnalyzeJobResult | null   (when completed)
//     reason:   string | null             (when failed)
//   }
// ============================================================

import { Hono }          from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv }   from "../app.js";
import { getRepoAnalysisQueue } from "../lib/queue.js";

export const jobsRouter = new Hono<AppEnv>();

jobsRouter.get("/:id", async (c) => {
  const { id } = c.req.param();
  const queue  = getRepoAnalysisQueue();
  const job    = await queue.getJob(id);

  if (!job) throw new HTTPException(404, { message: "Job not found" });

  const state    = await job.getState();
  const progress = job.progress as object | null;

  return c.json({
    jobId:    id,
    state,
    progress: progress ?? null,
    result:   state === "completed" ? job.returnvalue : null,
    reason:   state === "failed"    ? job.failedReason : null,
    // Timestamps (ms since epoch)
    processedOn: job.processedOn ?? null,
    finishedOn:  job.finishedOn  ?? null,
  });
});


// ============================================================
// routes/health.ts
//
// GET /api/health        — liveness probe (is process alive?)
// GET /api/health/ready  — readiness probe (can serve traffic?)
//
// K8s uses:
//   livenessProbe:  GET /api/health        (fail = restart pod)
//   readinessProbe: GET /api/health/ready  (fail = remove from LB)
// ============================================================

import { Hono }          from "hono";
import type { AppEnv }   from "../app.js";
import { getDb }         from "../lib/postgres.js";
import { getNeo4jDriver } from "../lib/neo4j.js";
import { getRedisConnection } from "../lib/redis.js";

export const healthRouter = new Hono<AppEnv>();

// Liveness — just confirms the process is running
healthRouter.get("/", (c) =>
  c.json({ status: "ok", ts: new Date().toISOString() })
);

// Readiness — checks all downstream dependencies
healthRouter.get("/ready", async (c) => {
  const checks: Record<string, "ok" | "fail"> = {};
  let allOk = true;

  // ── PostgreSQL ─────────────────────────────────────────────
  try {
    await getDb().selectFrom("repos").select("id").limit(1).execute();
    checks.postgres = "ok";
  } catch {
    checks.postgres = "fail";
    allOk = false;
  }

  // ── Redis ──────────────────────────────────────────────────
  try {
    await getRedisConnection().ping();
    checks.redis = "ok";
  } catch {
    checks.redis = "fail";
    allOk = false;
  }

  // ── Neo4j ──────────────────────────────────────────────────
  try {
    const driver  = getNeo4jDriver();
    await driver.getServerInfo();
    checks.neo4j = "ok";
  } catch {
    checks.neo4j = "fail";
    allOk = false;
  }

  return c.json(
    { status: allOk ? "ready" : "degraded", checks },
    allOk ? 200 : 503
  );
});
