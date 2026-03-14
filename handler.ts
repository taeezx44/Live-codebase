// ============================================================
// ws/handler.ts
//
// WebSocket endpoint: GET /ws  (HTTP upgrade)
//
// Hono doesn't have built-in WS support in Node.js mode —
// we use the `ws` library directly and attach it to the
// http.Server created in server.ts.
//
// Protocol (client → server):
//   { type: "subscribe",   jobId: string }
//   { type: "unsubscribe", jobId: string }
//   { type: "ping" }
//
// Protocol (server → client):
//   { type: "pong" }
//   { type: "job:progress", jobId, progress: JobProgress }
//   { type: "job:complete", jobId, result }
//   { type: "job:failed",   jobId, reason }
//   { type: "job:stalled",  jobId }
//   { type: "error",        message }
//
// One WS connection can subscribe to multiple jobIds.
// On disconnect, all subscriptions are cleaned up automatically.
//
// Heartbeat:
//   Server sends a ping frame every 30s.
//   If no pong is received within 10s, connection is terminated.
//   This catches dead TCP connections that don't fire "close".
// ============================================================

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage }        from "node:http";
import { QueueEvents }                 from "bullmq";
import { QUEUE }                       from "@codevis/worker/job.types";
import { getRedisConnection }          from "../lib/redis.js";

// jobId → Set<WebSocket>
type SubscriberMap = Map<string, Set<WebSocket>>;

const HEARTBEAT_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS        = 10_000;

export function createWsServer(): WebSocketServer {
  const wss         = new WebSocketServer({ noServer: true });
  const subscribers: SubscriberMap = new Map();

  // ── QueueEvents (Redis pub/sub) ──────────────────────────
  const queueEvents = new QueueEvents(QUEUE.REPO_ANALYSIS, {
    connection: getRedisConnection(),
  });

  queueEvents.on("progress", ({ jobId, data }) => {
    send(subscribers, jobId, { type: "job:progress", jobId, progress: data });
  });

  queueEvents.on("completed", ({ jobId, returnvalue }) => {
    send(subscribers, jobId, { type: "job:complete", jobId, result: returnvalue });
    subscribers.delete(jobId);
  });

  queueEvents.on("failed", ({ jobId, failedReason }) => {
    send(subscribers, jobId, { type: "job:failed", jobId, reason: failedReason });
    subscribers.delete(jobId);
  });

  queueEvents.on("stalled", ({ jobId }) => {
    send(subscribers, jobId, { type: "job:stalled", jobId });
  });

  // ── WebSocket connection handler ─────────────────────────
  wss.on("connection", (ws: WebSocket) => {
    // Heartbeat state
    let isAlive = true;
    let pongTimeout: ReturnType<typeof setTimeout> | null = null;

    ws.on("pong", () => {
      isAlive = true;
      if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
    });

    // ── Heartbeat interval ─────────────────────────────────
    const heartbeat = setInterval(() => {
      if (!isAlive) {
        // No pong received — connection is dead
        ws.terminate();
        return;
      }
      isAlive = false;
      ws.ping();

      // If no pong within PONG_TIMEOUT_MS, terminate
      pongTimeout = setTimeout(() => {
        ws.terminate();
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);

    // ── Message handler ────────────────────────────────────
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      switch (msg.type) {
        case "subscribe": {
          const jobId = msg.jobId as string | undefined;
          if (!jobId || typeof jobId !== "string") {
            ws.send(JSON.stringify({ type: "error", message: "jobId required" }));
            return;
          }
          if (!subscribers.has(jobId)) subscribers.set(jobId, new Set());
          subscribers.get(jobId)!.add(ws);

          // Immediately send current job state so client doesn't
          // need to separately poll GET /api/jobs/:id
          sendCurrentJobState(jobId, ws);
          break;
        }

        case "unsubscribe": {
          const jobId = msg.jobId as string | undefined;
          if (jobId) subscribers.get(jobId)?.delete(ws);
          break;
        }

        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;

        default:
          ws.send(JSON.stringify({ type: "error", message: `Unknown type: ${msg.type}` }));
      }
    });

    // ── Cleanup on disconnect ──────────────────────────────
    ws.on("close", () => {
      clearInterval(heartbeat);
      if (pongTimeout) clearTimeout(pongTimeout);

      // Remove this WS from all subscriber sets
      for (const clients of subscribers.values()) {
        clients.delete(ws);
      }
    });

    ws.on("error", (err) => {
      console.error("[ws] socket error:", err.message);
    });
  });

  // ── HTTP upgrade handler ──────────────────────────────────
  // Called from server.ts on the "upgrade" event.
  // Only accepts /ws path — all others get 404.
  const handleUpgrade = (req: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => {
    const url = req.url ?? "";
    if (!url.startsWith("/ws")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  };

  // Attach the upgrade handler on the wss for server.ts to use
  (wss as WebSocketServer & { handleHttpUpgrade: typeof handleUpgrade }).handleHttpUpgrade
    = handleUpgrade;

  return wss;
}

// ── Helpers ───────────────────────────────────────────────────

function send(
  subscribers: SubscriberMap,
  jobId: string,
  payload: object
): void {
  const clients = subscribers.get(jobId);
  if (!clients?.size) return;

  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg, (err) => { if (err) clients.delete(ws); });
    } else {
      clients.delete(ws);
    }
  }
}

// Send the current job state immediately on subscribe
// so the client doesn't have to wait for the next progress event
async function sendCurrentJobState(jobId: string, ws: WebSocket): Promise<void> {
  try {
    const { getRepoAnalysisQueue } = await import("../lib/queue.js");
    const job = await getRepoAnalysisQueue().getJob(jobId);
    if (!job || ws.readyState !== WebSocket.OPEN) return;

    const state    = await job.getState();
    const progress = job.progress;

    if (state === "completed") {
      ws.send(JSON.stringify({ type: "job:complete", jobId, result: job.returnvalue }));
    } else if (state === "failed") {
      ws.send(JSON.stringify({ type: "job:failed",   jobId, reason: job.failedReason }));
    } else if (progress) {
      ws.send(JSON.stringify({ type: "job:progress", jobId, progress }));
    }
  } catch { /* non-fatal — WS will get the next event anyway */ }
}
