// ============================================================
// lib/driver.ts
//
// Neo4j Driver singleton with:
//   - Connection pool management
//   - Health check (used by /api/health/ready)
//   - Query execution timing (dev mode logs slow queries)
//   - Graceful shutdown
// ============================================================

import neo4j, { type Driver, type ServerInfo } from "neo4j-driver";

let _driver: Driver | null = null;

const SLOW_QUERY_THRESHOLD_MS = 500;   // log queries taking > 500ms

export function getDriver(): Driver {
  if (_driver) return _driver;

  _driver = neo4j.driver(
    process.env.NEO4J_URI      ?? "bolt://localhost:7687",
    neo4j.auth.basic(
      process.env.NEO4J_USER     ?? "neo4j",
      process.env.NEO4J_PASSWORD ?? "password"
    ),
    {
      // Connection pool — keep it modest; Neo4j Community has limits
      maxConnectionPoolSize:      50,
      connectionAcquisitionTimeout: 5_000,  // ms before "pool exhausted" error

      // Query logging in development
      logging: process.env.NODE_ENV === "development"
        ? neo4j.logging.console("info")
        : neo4j.logging.console("error"),

      // Disable encryption for local dev (bolt://)
      // In production use bolt+s:// or neo4j+s:// (TLS)
      encrypted: process.env.NEO4J_ENCRYPTED === "true" ? "ENCRYPTION_ON" : "ENCRYPTION_OFF",
    }
  );

  return _driver;
}

export async function closeDriver(): Promise<void> {
  if (_driver) {
    await _driver.close();
    _driver = null;
  }
}

// ── Health check ─────────────────────────────────────────────

export async function checkNeo4jHealth(): Promise<{
  ok: boolean;
  latencyMs: number;
  serverInfo?: ServerInfo;
  error?: string;
}> {
  const driver = getDriver();
  const t0 = Date.now();
  try {
    const info = await driver.getServerInfo();
    return { ok: true, latencyMs: Date.now() - t0, serverInfo: info };
  } catch (err) {
    return {
      ok:       false,
      latencyMs: Date.now() - t0,
      error:    (err as Error).message,
    };
  }
}

// ── Timed query wrapper (dev-only query profiling) ────────────

export async function timedQuery<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  if (process.env.NODE_ENV !== "development") return fn();

  const t0 = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - t0;
    if (ms > SLOW_QUERY_THRESHOLD_MS) {
      console.warn(`[neo4j] SLOW QUERY (${ms}ms): ${label}`);
    } else {
      console.debug(`[neo4j] ${label}: ${ms}ms`);
    }
    return result;
  } catch (err) {
    const ms = Date.now() - t0;
    console.error(`[neo4j] QUERY FAILED (${ms}ms): ${label}`, (err as Error).message);
    throw err;
  }
}
