// ============================================================
// server.ts  —  HTTP server entrypoint
//
// Creates the Hono app, attaches the WebSocket server,
// and starts listening. Handles graceful shutdown on SIGTERM.
// ============================================================

import { createServer }   from "node:http";
import { serve }          from "@hono/node-server";
import { createApp }      from "./app.js";
import { createWsServer } from "./ws/handler.js";
import { closeDb }        from "./lib/postgres.js";
import { getNeo4jDriver } from "./lib/neo4j.js";
import { getRedisConnection } from "./lib/redis.js";

const PORT = parseInt(process.env.PORT ?? "4000", 10);

async function main(): Promise<void> {
  const app = createApp();
  const wss = createWsServer();

  // Hono's @hono/node-server wraps Node's http.Server
  const server = serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`[api] listening on http://0.0.0.0:${PORT}`);
  });

  // Attach WebSocket upgrade handler to the underlying http.Server
  // Hono doesn't handle WS natively in Node mode — we intercept upgrades
  const httpServer = server as ReturnType<typeof createServer>;
  const wsHandler  = (wss as ReturnType<typeof createWsServer> & {
    handleHttpUpgrade: (req: Parameters<typeof httpServer["on"]>[1], socket: unknown, head: unknown) => void
  }).handleHttpUpgrade;

  httpServer.on("upgrade", wsHandler);

  console.log(`[ws]  WebSocket available on ws://0.0.0.0:${PORT}/ws`);

  // ── Graceful shutdown ──────────────────────────────────────
  async function shutdown(signal: string): Promise<void> {
    console.log(`[api] ${signal} received — shutting down`);

    // Stop accepting new connections
    httpServer.close(async () => {
      // Close all downstream connections cleanly
      await Promise.allSettled([
        closeDb(),
        getNeo4jDriver().close(),
        getRedisConnection().quit(),
      ]);
      console.log("[api] shutdown complete");
      process.exit(0);
    });

    // Force exit after 10s if shutdown hangs
    setTimeout(() => {
      console.error("[api] forced shutdown after timeout");
      process.exit(1);
    }, 10_000);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[api] fatal startup error:", err);
  process.exit(1);
});
