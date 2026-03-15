// ============================================================
// routes/metrics.ts
//
// GET /api/metrics         — current snapshot (polled every 5s)
// GET /api/metrics/history — last 60 snapshots (for sparklines)
// GET /api/metrics/stream  — SSE stream (optional, EventSource)
//
// No auth required — metrics are non-sensitive aggregate data.
// In production, add IP-allowlist middleware if needed.
// ============================================================

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { metrics } from "../metrics/collector.js";
import { getRepoAnalysisQueue } from "../lib/queue.js";

export const metricsRouter = new Hono();

// ── Current snapshot ──────────────────────────────────────────

metricsRouter.get("/", async (c) => {
  // Refresh job queue depth before returning
  try {
    const queue = getRepoAnalysisQueue();
    const counts = await queue.getJobCounts("waiting", "active", "delayed");
    metrics.setJobQueueDepth(
      (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0)
    );
  } catch { /* non-fatal — queue may not be available */ }

  return c.json(metrics.snapshot());
});

// ── History for sparklines ────────────────────────────────────

metricsRouter.get("/history", (c) => {
  return c.json({ history: metrics.getHistory() });
});

// ── SSE stream (EventSource) ──────────────────────────────────
// Frontend can use:
//   const es = new EventSource("/api/metrics/stream");
//   es.onmessage = e => console.log(JSON.parse(e.data));

metricsRouter.get("/stream", (c) => {
  return streamSSE(c, async (stream) => {
    // Send immediately
    await stream.writeSSE({ data: JSON.stringify(metrics.snapshot()) });

    // Then send every 5 seconds
    const interval = setInterval(async () => {
      try {
        await stream.writeSSE({ data: JSON.stringify(metrics.snapshot()) });
      } catch {
        clearInterval(interval);
      }
    }, 5000);

    // Clean up when client disconnects
    stream.onAbort(() => clearInterval(interval));

    // Keep alive for up to 10 minutes
    await new Promise((resolve) => setTimeout(resolve, 10 * 60 * 1000));
    clearInterval(interval);
  });
});
