// ============================================================
// middleware/rate-limit.ts
//
// Redis-backed sliding-window rate limiter.
// Uses a Lua script so the check + increment is atomic.
//
// Limits:
//   - 100 req/min  per IP  (general)
//   - 10  req/min  per IP  for POST /repos (expensive operation)
//
// Returns 429 with Retry-After header when exceeded.
// ============================================================

import type { MiddlewareHandler } from "hono";
import { getRedisConnection } from "../lib/redis.js";

const WINDOW_SECONDS = 60;
const GENERAL_LIMIT  = 100;
const EXPENSIVE_LIMIT = 10; // POST /repos

// Atomic sliding-window check in Lua (executes on Redis side)
const RATE_LIMIT_SCRIPT = `
local key   = KEYS[1]
local limit = tonumber(ARGV[1])
local now   = tonumber(ARGV[2])
local ttl   = tonumber(ARGV[3])

-- Remove entries outside the window
redis.call("ZREMRANGEBYSCORE", key, "-inf", now - ttl * 1000)

local count = redis.call("ZCARD", key)

if count < limit then
  redis.call("ZADD", key, now, now)
  redis.call("EXPIRE", key, ttl)
  return { 0, limit - count - 1 }   -- { blocked, remaining }
else
  return { 1, 0 }
end
`.trim();

export function rateLimitMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const redis = getRedisConnection();
    const ip    = c.req.header("x-forwarded-for")?.split(",")[0].trim()
               ?? c.req.header("x-real-ip")
               ?? "unknown";

    const isExpensive =
      c.req.method === "POST" && c.req.path === "/api/repos";

    const limit = isExpensive ? EXPENSIVE_LIMIT : GENERAL_LIMIT;
    const key   = `rl:${isExpensive ? "exp" : "gen"}:${ip}`;
    const now   = Date.now();

    const [blocked, remaining] = await redis.eval(
      RATE_LIMIT_SCRIPT,
      1,
      key,
      limit,
      now,
      WINDOW_SECONDS
    ) as [number, number];

    c.header("X-RateLimit-Limit",     String(limit));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset",     String(Math.ceil(now / 1000) + WINDOW_SECONDS));

    if (blocked) {
      return c.json(
        { error: "Too many requests", retryAfter: WINDOW_SECONDS },
        429,
        { "Retry-After": String(WINDOW_SECONDS) }
      );
    }

    return next();
  };
}


// ============================================================
// middleware/error.ts
//
// Global error handler — converts thrown errors into consistent
// JSON responses. Never leaks stack traces in production.
// ============================================================

import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError }       from "zod";

export const errorMiddleware: ErrorHandler = (err, c) => {
  const requestId = c.get("requestId") ?? "unknown";
  const isProd    = process.env.NODE_ENV === "production";

  // ── Hono HTTP exceptions (thrown intentionally) ───────────
  if (err instanceof HTTPException) {
    return c.json(
      { error: err.message, requestId },
      err.status
    );
  }

  // ── Zod validation errors ──────────────────────────────────
  if (err instanceof ZodError) {
    return c.json(
      {
        error:   "Validation error",
        details: err.flatten().fieldErrors,
        requestId,
      },
      400
    );
  }

  // ── Unexpected errors ──────────────────────────────────────
  console.error(`[error] ${requestId}:`, err);

  return c.json(
    {
      error:     "Internal server error",
      requestId,
      ...(isProd ? {} : { message: err.message, stack: err.stack }),
    },
    500
  );
};
