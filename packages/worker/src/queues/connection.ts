// ============================================================
// queues/connection.ts
//
// Single Redis connection shared by all Queue + Worker instances.
//
// BullMQ uses ioredis under the hood. One connection per process
// is the correct pattern — avoid creating a new connection per
// queue instantiation or you'll exhaust Redis connections fast.
//
// In production, point REDIS_URL at a Redis Sentinel or
// Cluster URL — ioredis handles failover transparently.
// ============================================================

import { Redis } from "ioredis";

let _connection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (_connection) return _connection;

  _connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,   // required by BullMQ
    enableReadyCheck: false,      // required by BullMQ
    lazyConnect: false,
  });

  _connection.on("error", (err) => {
    console.error("[Redis] connection error:", err.message);
  });

  return _connection;
}

// ── Queue factory ────────────────────────────────────────────

import { Queue } from "bullmq";
import { QUEUE } from "../jobs/job.types.js";

let _repoAnalysisQueue: Queue | null = null;

export function getRepoAnalysisQueue(): Queue {
  if (_repoAnalysisQueue) return _repoAnalysisQueue;

  _repoAnalysisQueue = new Queue(QUEUE.REPO_ANALYSIS, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      // Keep completed jobs for 24h so the API can query status
      removeOnComplete: { age: 24 * 60 * 60 },
      removeOnFail:     { age: 7 * 24 * 60 * 60 }, // 7 days for debugging
    },
  });

  return _repoAnalysisQueue;
}
