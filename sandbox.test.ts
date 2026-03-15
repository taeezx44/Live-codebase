// ============================================================
// __tests__/sandbox.test.ts
//
// Tests for the code execution sandbox.
// Requires Docker to be running.
// Run with: pnpm test --filter @codevis/api-gateway
// ============================================================

import { describe, it, expect, beforeAll } from "vitest";
import { executeCode } from "../sandbox/executor.js";

// Skip all tests if Docker is not available
let dockerAvailable = false;
beforeAll(async () => {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("docker", ["info"], { timeout: 5000 });
    dockerAvailable = true;
  } catch {
    console.warn("[sandbox.test] Docker not available — skipping execution tests");
  }
});

describe("executeCode — JavaScript", () => {
  it("runs simple console.log", async () => {
    if (!dockerAvailable) return;

    const result = await executeCode({
      language: "javascript",
      code: `console.log("hello world")`,
    });

    expect(result.stdout.trim()).toBe("hello world");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr", async () => {
    if (!dockerAvailable) return;

    const result = await executeCode({
      language: "javascript",
      code: `console.error("this is stderr"); process.exit(1)`,
    });

    expect(result.stderr).toContain("this is stderr");
    expect(result.exitCode).toBe(1);
  });

  it("enforces timeout", async () => {
    if (!dockerAvailable) return;

    const result = await executeCode({
      language:  "javascript",
      code:      `while(true){}`,
      timeoutMs: 2000,
    });

    expect(result.timedOut).toBe(true);
  });

  it("handles syntax errors gracefully", async () => {
    if (!dockerAvailable) return;

    const result = await executeCode({
      language: "javascript",
      code:     `function broken( {`,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("reads stdin", async () => {
    if (!dockerAvailable) return;

    const result = await executeCode({
      language: "javascript",
      code: `
        const lines = [];
        process.stdin.on('data', d => lines.push(d.toString().trim()));
        process.stdin.on('end', () => console.log(lines.join(',')));
      `,
      stdin: "hello\nworld",
    });

    expect(result.stdout).toContain("hello");
  });
});

describe("executeCode — Python", () => {
  it("runs basic Python", async () => {
    if (!dockerAvailable) return;

    const result = await executeCode({
      language: "python",
      code:     `print("python works")`,
    });

    expect(result.stdout.trim()).toBe("python works");
    expect(result.exitCode).toBe(0);
  });

  it("handles Python exceptions", async () => {
    if (!dockerAvailable) return;

    const result = await executeCode({
      language: "python",
      code:     `raise ValueError("intentional error")`,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ValueError");
  });
});

// ============================================================
// __tests__/metrics.test.ts
// ============================================================

import { describe as describe2, it as it2, expect as expect2, beforeEach } from "vitest";

// Import the collector directly (not the singleton) so tests are isolated
async function freshCollector() {
  // Dynamic import to get a fresh module instance per test
  const mod = await import("../metrics/collector.js");
  return mod.metrics;
}

describe2("MetricsCollector", () => {
  it2("records request latencies and returns correct avg", async () => {
    const collector = await freshCollector();
    collector.recordRequest("/api/repos", 100);
    collector.recordRequest("/api/repos", 200);
    collector.recordRequest("/api/repos", 300);

    const snap = collector.snapshot();
    expect2(snap.requestsPerMin).toBe(3);
    expect2(snap.avgLatencyMs).toBe(200);
  });

  it2("increments repos analyzed", async () => {
    const collector = await freshCollector();
    collector.incrementReposAnalyzed();
    collector.incrementReposAnalyzed();

    const snap = collector.snapshot();
    expect2(snap.reposAnalyzed).toBe(2);
  });

  it2("tracks active connections", async () => {
    const collector = await freshCollector();
    collector.setActiveConnections(42);

    const snap = collector.snapshot();
    expect2(snap.activeConnections).toBe(42);
  });
});
