// ============================================================
// src/app.ts  —  Hono app factory
//
// Returns a configured Hono app. Kept separate from server.ts
// so tests can import the app without binding a port.
//
// Middleware order matters:
//   1. requestId   — stamp every request with a UUID
//   2. logger      — log after requestId so the ID is in every line
//   3. cors        — must come before auth so pre-flight works
//   4. rateLimit   — before auth (cheap check first)
//   5. routes      — actual handlers
//   6. notFound    — 404 fallback
//   7. onError     — global error handler
// ============================================================

import { Hono } from "hono";
import { cors }         from "hono/cors";
import { requestId }    from "hono/request-id";
import { logger }       from "hono/logger";
import { prettyJSON }   from "hono/pretty-json";
import { secureHeaders } from "hono/secure-headers";
import { timeout }      from "hono/timeout";

import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { errorMiddleware }     from "./middleware/error.js";

import { reposRouter }    from "./routes/repos.js";
import { analysisRouter } from "./routes/analysis.js";
import { jobsRouter }     from "./routes/jobs.js";
import { healthRouter }   from "./routes/health.js";

export type AppEnv = {
  Variables: {
    requestId: string;
  };
};

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ── Global middleware ──────────────────────────────────────

  app.use("*", requestId());

  app.use("*", logger());          // pino-compatible structured output

  app.use("*", secureHeaders());   // X-Content-Type-Options, etc.

  app.use(
    "*",
    cors({
      origin: (origin) => {
        const allowed = (process.env.CORS_ORIGINS ?? "http://localhost:3000")
          .split(",")
          .map((o) => o.trim());
        return allowed.includes(origin) ? origin : null;
      },
      allowMethods:  ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders:  ["Content-Type", "Authorization", "X-Request-Id"],
      exposeHeaders: ["X-Request-Id"],
      maxAge:        600,
    })
  );

  app.use("*", rateLimitMiddleware());

  // 30s timeout on all routes (WebSocket is excluded — it upgrades)
  app.use("/api/*", timeout(30_000));

  // Pretty JSON in development only
  if (process.env.NODE_ENV !== "production") {
    app.use("*", prettyJSON());
  }

  // ── Routes ─────────────────────────────────────────────────

  app.route("/api/repos",    reposRouter);
  app.route("/api/repos",    analysisRouter);   // sub-paths under /repos/:id
  app.route("/api/jobs",     jobsRouter);
  app.route("/api/health",   healthRouter);

  // ── 404 fallback ───────────────────────────────────────────

  app.notFound((c) =>
    c.json(
      { error: "Not found", path: c.req.path },
      404
    )
  );

  // ── Global error handler ───────────────────────────────────

  app.onError(errorMiddleware);

  return app;
}
