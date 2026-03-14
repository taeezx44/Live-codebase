// ============================================================
// events/queue-events.listener.ts
//
// Subscribes to BullMQ's QueueEvents (Redis pub/sub channel)
// and broadcasts job state changes to WebSocket clients.
//
// This is intentionally SEPARATE from the Worker so it can
// run in the api-gateway process (not the worker process).
// The API handles WS connections; the worker handles jobs.
// Both read the same Redis — QueueEvents is the bridge.
//
// WebSocket message format:
//   { type: "job:progress", jobId, repoId, progress: JobProgress }
//   { type: "job:complete", jobId, repoId }
//   { type: "job:failed",   jobId, repoId, reason: string }
//
// The frontend subscribes by jobId (returned from POST /api/repos).
// ============================================================

import { QueueEvents } from "bullmq";
import { QUEUE, type JobProgress } from "../jobs/job.types.js";
import { getRedisConnection } from "../queues/connection.js";
import type { WebSocketServer, WebSocket } from "ws";

// Map of jobId → Set of WebSocket clients listening for that job
type WsClients = Map<string, Set<WebSocket>>;

export function createQueueEventsListener(wss: WebSocketServer): () => Promise<void> {
  const queueEvents = new QueueEvents(QUEUE.REPO_ANALYSIS, {
    connection: getRedisConnection(),
  });

  // Track which WS clients are listening for which jobId.
  // Populated when a WS client sends: { type: "subscribe", jobId }
  const subscribers: WsClients = new Map();

  // ── Wire up WS client subscriptions ─────────────────────
  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "subscribe" && msg.jobId) {
          if (!subscribers.has(msg.jobId)) subscribers.set(msg.jobId, new Set());
          subscribers.get(msg.jobId)!.add(ws);
        }
        if (msg.type === "unsubscribe" && msg.jobId) {
          subscribers.get(msg.jobId)?.delete(ws);
        }
      } catch { /* ignore malformed messages */ }
    });

    ws.on("close", () => {
      // Clean up all subscriptions for this client
      for (const clients of subscribers.values()) {
        clients.delete(ws);
      }
    });
  });

  // ── BullMQ event handlers ────────────────────────────────

  queueEvents.on("progress", ({ jobId, data }) => {
    const progress = data as unknown as JobProgress;
    broadcast(subscribers, jobId, {
      type:    "job:progress",
      jobId,
      progress,
    });
  });

  queueEvents.on("completed", ({ jobId, returnvalue }) => {
    broadcast(subscribers, jobId, {
      type:   "job:complete",
      jobId,
      result: returnvalue,
    });
    // Clean up subscriber set — job is done
    subscribers.delete(jobId);
  });

  queueEvents.on("failed", ({ jobId, failedReason }) => {
    broadcast(subscribers, jobId, {
      type:   "job:failed",
      jobId,
      reason: failedReason,
    });
    subscribers.delete(jobId);
  });

  queueEvents.on("stalled", ({ jobId }) => {
    broadcast(subscribers, jobId, {
      type:  "job:stalled",
      jobId,
    });
  });

  // Return a cleanup function
  return async () => {
    await queueEvents.close();
  };
}

// ── Broadcast to all WS clients subscribed to a jobId ───────

function broadcast(
  subscribers: WsClients,
  jobId: string,
  payload: object
): void {
  const clients = subscribers.get(jobId);
  if (!clients || clients.size === 0) return;

  const msg = JSON.stringify(payload);

  for (const ws of clients) {
    // 1 = OPEN
    if (ws.readyState === 1) {
      ws.send(msg, (err) => {
        if (err) clients.delete(ws); // remove dead connection
      });
    } else {
      clients.delete(ws);
    }
  }
}
