// ============================================================
// metrics/collector.ts
//
// Central metrics store for the Observability Dashboard.
// Collects: active WebSocket connections, API request latency,
// job queue depth, parse errors, Neo4j query timing.
//
// Design: in-process ring buffer (no Prometheus server needed)
// → /api/metrics endpoint reads from this store
// → Frontend polls every 5 seconds with Chart.js
// ============================================================

import { EventEmitter } from "node:events";

// ── Types ────────────────────────────────────────────────────

export interface MetricSnapshot {
  timestamp: number;
  activeConnections: number;
  requestsPerMin: number;
  avgLatencyMs: number;
  p99LatencyMs: number;
  jobQueueDepth: number;
  parseErrorsPerMin: number;
  neo4jQueryAvgMs: number;
  reposAnalyzed: number;
  errorsPerMin: number;
}

export interface LatencyEntry {
  ts: number;
  ms: number;
  route: string;
}

// ── Ring buffer helper ────────────────────────────────────────

class RingBuffer<T> {
  private buf: T[] = [];
  constructor(private readonly max: number) {}

  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.max) this.buf.shift();
  }

  get items(): T[] { return this.buf; }

  since(ms: number): T[] {
    const cutoff = Date.now() - ms;
    return this.buf.filter((i: any) => i.ts > cutoff);
  }
}

// ── MetricsCollector singleton ────────────────────────────────

class MetricsCollector extends EventEmitter {
  // Rolling 5-minute windows
  private latencies   = new RingBuffer<LatencyEntry>(2000);
  private parseErrors = new RingBuffer<{ ts: number }>(500);
  private errors      = new RingBuffer<{ ts: number }>(500);
  private neo4jTimes  = new RingBuffer<{ ts: number; ms: number }>(500);
  private repoCount   = 0;

  // Live counters
  private activeConnections = 0;
  private jobQueueDepth     = 0;

  // ── Record methods (called from middleware/jobs) ───────────

  recordRequest(route: string, ms: number): void {
    this.latencies.push({ ts: Date.now(), ms, route });
  }

  recordParseError(): void {
    this.parseErrors.push({ ts: Date.now() });
  }

  recordError(): void {
    this.errors.push({ ts: Date.now() });
  }

  recordNeo4jQuery(ms: number): void {
    this.neo4jTimes.push({ ts: Date.now(), ms });
  }

  setActiveConnections(n: number): void {
    this.activeConnections = n;
  }

  setJobQueueDepth(n: number): void {
    this.jobQueueDepth = n;
  }

  incrementReposAnalyzed(): void {
    this.repoCount++;
  }

  // ── Snapshot (called by /api/metrics) ─────────────────────

  snapshot(): MetricSnapshot {
    const WIN_1M  = 60_000;
    const WIN_5M  = 300_000;

    const recentReqs    = this.latencies.since(WIN_1M);
    const recentErrors  = this.errors.since(WIN_1M);
    const recentParseE  = this.parseErrors.since(WIN_1M);
    const recentNeo4j   = this.neo4jTimes.since(WIN_5M);

    const latencyMs = recentReqs.map(r => r.ms);
    const avgLatency = latencyMs.length
      ? Math.round(latencyMs.reduce((a, b) => a + b, 0) / latencyMs.length)
      : 0;

    const p99 = latencyMs.length
      ? Math.round(latencyMs.sort((a, b) => a - b)[Math.floor(latencyMs.length * 0.99)] ?? 0)
      : 0;

    const neo4jAvg = recentNeo4j.length
      ? Math.round(recentNeo4j.reduce((s, e) => s + e.ms, 0) / recentNeo4j.length)
      : 0;

    return {
      timestamp:          Date.now(),
      activeConnections:  this.activeConnections,
      requestsPerMin:     recentReqs.length,
      avgLatencyMs:       avgLatency,
      p99LatencyMs:       p99,
      jobQueueDepth:      this.jobQueueDepth,
      parseErrorsPerMin:  recentParseE.length,
      neo4jQueryAvgMs:    neo4jAvg,
      reposAnalyzed:      this.repoCount,
      errorsPerMin:       recentErrors.length,
    };
  }

  // History for sparklines (last 60 data points, 1 per 5s)
  private history: MetricSnapshot[] = [];

  startHistoryCollection(intervalMs = 5000): void {
    setInterval(() => {
      const snap = this.snapshot();
      this.history.push(snap);
      if (this.history.length > 60) this.history.shift();
      this.emit("snapshot", snap);
    }, intervalMs);
  }

  getHistory(): MetricSnapshot[] {
    return this.history;
  }
}

export const metrics = new MetricsCollector();
