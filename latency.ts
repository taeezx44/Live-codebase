// ============================================================
// middleware/latency.ts
//
// Hono middleware that records every request's duration
// into the MetricsCollector automatically.
// Mount once in app.ts — covers all routes.
// ============================================================

import type { MiddlewareHandler } from "hono";
import { metrics } from "../metrics/collector.js";

export function latencyMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const t0 = performance.now();
    try {
      await next();
    } catch (err) {
      metrics.recordError();
      throw err;
    } finally {
      const ms = Math.round(performance.now() - t0);
      metrics.recordRequest(c.req.path, ms);
      // Expose timing header so browser devtools show it
      c.header("X-Response-Time", `${ms}ms`);
    }
  };
}
