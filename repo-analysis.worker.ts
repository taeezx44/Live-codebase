// ============================================================
// workers/repo-analysis.worker.ts
//
// The BullMQ Worker that consumes jobs from the repo-analysis
// queue and orchestrates the three-step pipeline:
//
//   clone.job → analyze.job → index.job
//
// Each step is chained inside the same worker process:
// after clone succeeds, analyze is added as a child job,
// after analyze succeeds, index is added. This keeps the
// entire repo lifecycle in one traceable job tree.
//
// Why one worker for all three instead of separate queues?
//   - Simpler deployment (one container)
//   - Shared in-process state (no serialization of cloneDir)
//   - Easy to trace the full lifecycle via one jobId
//
// Scaling: run multiple worker processes in K8s — BullMQ
// handles distribution automatically via Redis locking.
// ============================================================

import path from "node:path";
import os from "node:os";
import { Worker, type Job } from "bullmq";
import {
  QUEUE,
  JOB,
  JOB_OPTS,
  type CloneJobData,
  type AnalyzeJobData,
  type IndexJobData,
} from "../jobs/job.types.js";
import { runCloneJob, cleanCloneDir } from "../jobs/clone.job.js";
import { runAnalyzeJob } from "../jobs/analyze.job.js";
import { runIndexJob } from "../jobs/index.job.js";
import { getRedisConnection } from "../queues/connection.js";

// Base directory for temporary clones
// In K8s: mount a PVC here so workers share the same storage
const CLONE_BASE_DIR = process.env.CLONE_BASE_DIR ?? path.join(os.tmpdir(), "repos");

// ── Worker concurrency ───────────────────────────────────────
// analyze is CPU-bound (tree-sitter). Keep it lower than clone/index
// to avoid saturating all CPU cores.
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? "3", 10);

// ── Worker definition ────────────────────────────────────────

export function createRepoAnalysisWorker(): Worker {
  const worker = new Worker(
    QUEUE.REPO_ANALYSIS,
    async (job: Job) => {
      switch (job.name) {
        case JOB.CLONE:   return runCloneOrchestrate(job);
        case JOB.ANALYZE: return runAnalyzeJob(job as Job<AnalyzeJobData>);
        case JOB.INDEX:   return runIndexJob(job as Job<IndexJobData>);

        default:
          throw new Error(`Unknown job name: ${job.name}`);
      }
    },
    {
      connection:  getRedisConnection(),
      concurrency: CONCURRENCY,
      // Drain delay: how long to wait between polling Redis when queue is empty
      drainDelay: 300,
      // Lock duration: how long a job can run before being considered stalled
      // Set to 20min to handle large repos — must be > longest expected job
      lockDuration: 20 * 60 * 1_000,
      // Stalled interval: how often to check for stalled jobs
      stalledInterval: 30 * 1_000,
    }
  );

  worker.on("completed", (job) => {
    console.log(`[worker] ✓ ${job.name}:${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[worker] ✗ ${job?.name}:${job?.id} failed:`, err.message);
  });

  worker.on("stalled", (jobId) => {
    console.warn(`[worker] ⚠ job ${jobId} stalled — will be requeued`);
  });

  return worker;
}

// ── Clone orchestrator ───────────────────────────────────────
//
// This is the entry point for the full pipeline.
// It runs clone, then chains analyze + index as follow-up jobs.
// Using chained jobs (not Flow) keeps the API simple: one jobId
// to track everything, status updated via QueueEvents.

async function runCloneOrchestrate(
  job: Job<CloneJobData>
): Promise<void> {
  const { repoId, repoUrl } = job.data;
  const cloneDir = path.join(CLONE_BASE_DIR, repoId);

  let cloneSucceeded = false;

  try {
    // ── Step 1: Clone ──────────────────────────────────────
    const cloneResult = await runCloneJob({
      ...job,
      data: { ...job.data, cloneDir },
    } as Job<CloneJobData>);

    cloneSucceeded = true;

    // ── Step 2: Analyze ────────────────────────────────────
    // Add as a new job — this allows it to be retried independently
    const queue = (await import("../queues/connection.js")).getRepoAnalysisQueue();

    const analyzeJob = await queue.add(
      JOB.ANALYZE,
      {
        repoId,
        cloneDir,
        filePaths: cloneResult.filePaths,
      } satisfies AnalyzeJobData,
      {
        ...JOB_OPTS.analyze,
        // Link to parent so the dashboard can show the full tree
        parent: { id: job.id!, queue: `bull:${QUEUE.REPO_ANALYSIS}` },
      }
    );

    // Wait for analyze to complete (this worker processes it too)
    // We poll instead of blocking so the lock isn't held the whole time
    const analyzeResult = await waitForJob(analyzeJob.id!);

    if (analyzeResult.failedReason) {
      throw new Error(`analyze.job failed: ${analyzeResult.failedReason}`);
    }

    // ── Step 3: Index ──────────────────────────────────────
    await queue.add(
      JOB.INDEX,
      { repoId, cloneDir } satisfies IndexJobData,
      {
        ...JOB_OPTS.index,
        parent: { id: job.id!, queue: `bull:${QUEUE.REPO_ANALYSIS}` },
      }
    );

  } finally {
    // ── Always clean up temp clone dir ─────────────────────
    // Even if analyze failed, we don't want GB of clones piling up
    if (cloneSucceeded) {
      await cleanCloneDir(cloneDir);
    }
  }
}

// ── Job polling helper ───────────────────────────────────────
// Polls job state every 2 seconds until terminal state.
// In a real system you'd use QueueEvents instead — but this
// keeps the orchestration in one place for clarity.

async function waitForJob(jobId: string, timeoutMs = 20 * 60 * 1_000): Promise<Job> {
  const { getRepoAnalysisQueue } = await import("../queues/connection.js");
  const queue = getRepoAnalysisQueue();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const j = await queue.getJob(jobId);
    if (!j) throw new Error(`Job ${jobId} not found`);

    const state = await j.getState();
    if (state === "completed" || state === "failed") return j;

    await sleep(2_000);
  }

  throw new Error(`Job ${jobId} timed out after ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
