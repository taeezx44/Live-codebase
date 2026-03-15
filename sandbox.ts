// ============================================================
// routes/sandbox.ts
//
// POST /api/sandbox/run     — execute code, return result
// POST /api/sandbox/stream  — execute code, stream stdout via SSE
// GET  /api/sandbox/langs   — list supported languages
//
// Rate limit: 10 runs/min per IP (expensive operation)
// Max code: 64KB (enforced in executor)
// Max timeout: 10 seconds (enforced in executor + Docker)
// ============================================================

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { executeCode, type SupportedLanguage } from "../sandbox/executor.js";
import { metrics } from "../metrics/collector.js";

export const sandboxRouter = new Hono();

// ── Validation schema ─────────────────────────────────────────

const runSchema = z.object({
  language: z.enum(["javascript", "typescript", "python"]),
  code:     z.string().min(1).max(65_536),
  stdin:    z.string().max(4096).optional(),
  timeout:  z.number().int().min(1000).max(10_000).optional().default(10_000),
});

// ── GET /api/sandbox/langs ────────────────────────────────────

sandboxRouter.get("/langs", (c) =>
  c.json({
    languages: [
      { id: "javascript", label: "JavaScript", version: "Node 20" },
      { id: "typescript", label: "TypeScript", version: "Node 20 + tsx" },
      { id: "python",     label: "Python",     version: "3.12"        },
    ],
  })
);

// ── POST /api/sandbox/run — sync response ─────────────────────

sandboxRouter.post(
  "/run",
  zValidator("json", runSchema),
  async (c) => {
    const { language, code, stdin, timeout } = c.req.valid("json");

    const t0     = Date.now();
    const result = await executeCode({ language, code, stdin, timeoutMs: timeout });
    const ms     = Date.now() - t0;

    // Track in observability
    metrics.recordRequest("/api/sandbox/run", ms);
    if (result.exitCode !== 0) metrics.recordError();

    return c.json({
      ...result,
      language,
    });
  }
);

// ── POST /api/sandbox/stream — SSE streaming output ───────────
//
// Streams stdout line-by-line as it arrives.
// Frontend uses EventSource to display live output.
//
// Events emitted:
//   { event: "stdout",   data: "line of output\n" }
//   { event: "stderr",   data: "error line\n" }
//   { event: "done",     data: JSON with exitCode, durationMs, timedOut }
//   { event: "error",    data: "executor error message" }

sandboxRouter.post(
  "/stream",
  zValidator("json", runSchema),
  (c) => {
    const { language, code, stdin, timeout } = c.req.valid("json");

    return streamSSE(c, async (stream) => {
      const t0 = Date.now();

      try {
        // For streaming we still run the full execution but emit
        // stdout/stderr line by line once complete.
        // True line-streaming would require a Docker attach — Phase 2 upgrade.
        const result = await executeCode({ language, code, stdin, timeoutMs: timeout });

        // Emit stdout lines
        for (const line of result.stdout.split("\n")) {
          if (line) await stream.writeSSE({ event: "stdout", data: line });
        }

        // Emit stderr lines
        for (const line of result.stderr.split("\n")) {
          if (line) await stream.writeSSE({ event: "stderr", data: line });
        }

        // Final summary
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({
            exitCode:   result.exitCode,
            durationMs: result.durationMs,
            timedOut:   result.timedOut,
          }),
        });

      } catch (err) {
        await stream.writeSSE({
          event: "error",
          data:  (err as Error).message ?? "Executor error",
        });
      }
    });
  }
);
