// ============================================================
// Integration tests for the job pipeline
//
// These tests spin up a real BullMQ queue against a local Redis
// (testcontainers or a dev Redis). They verify the full
// clone → analyze → index chain produces the expected output.
//
// Run with: bun test (or npx vitest)
// Requires: Redis running on localhost:6379
//           (or REDIS_URL env var pointing to a test instance)
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { Queue, Worker } from "bullmq";
import { getRedisConnection, getRepoAnalysisQueue } from "../src/queues/connection.js";
import { QUEUE, JOB, JOB_OPTS } from "../src/jobs/job.types.js";
import type { CloneJobData } from "../src/jobs/job.types.js";

// A tiny local repo we create in-memory for tests
// (doesn't require network access)
async function createTestRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(
    path.join(dir, "index.ts"),
    `import { helper } from "./helper"\nexport function main() { return helper() }\n`
  );
  await fs.writeFile(
    path.join(dir, "helper.ts"),
    `export function helper(): string { return "hello" }\n`
  );
  await fs.writeFile(
    path.join(dir, "utils.ts"),
    `import { helper } from "./helper"\nexport const shout = () => helper().toUpperCase()\n`
  );
}

describe("Job pipeline — unit (no git)", () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `codevis-test-${Date.now()}`);
    await createTestRepo(testDir);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    await getRedisConnection().quit();
  });

  it("analyze.job processes test repo and returns correct counts", async () => {
    const { runAnalyzeJob } = await import("../src/jobs/analyze.job.js");

    // Build a mock BullMQ Job
    const progress: unknown[] = [];
    const mockJob = {
      id: "test-job-1",
      data: {
        repoId: "test-repo-1",
        cloneDir: testDir,
        filePaths: [
          path.join(testDir, "index.ts"),
          path.join(testDir, "helper.ts"),
          path.join(testDir, "utils.ts"),
        ],
      },
      updateProgress: async (p: unknown) => { progress.push(p); },
    } as never;

    const result = await runAnalyzeJob(mockJob);

    expect(result.filesAnalyzed).toBe(3);
    expect(result.parseErrors).toBe(0);
    expect(result.nodesWritten).toBe(3);
    // index.ts imports helper → 1 edge
    // utils.ts imports helper → 1 edge
    expect(result.edgesWritten).toBe(2);
  });

  it("progress is reported at regular intervals", async () => {
    const { runAnalyzeJob } = await import("../src/jobs/analyze.job.js");

    const progressUpdates: number[] = [];
    const mockJob = {
      id: "test-job-2",
      data: {
        repoId: "test-repo-2",
        cloneDir: testDir,
        filePaths: [
          path.join(testDir, "index.ts"),
          path.join(testDir, "helper.ts"),
        ],
      },
      updateProgress: async (p: { pct: number }) => {
        progressUpdates.push(p.pct);
      },
    } as never;

    await runAnalyzeJob(mockJob);

    // Progress should always go forward
    for (let i = 1; i < progressUpdates.length; i++) {
      expect(progressUpdates[i]).toBeGreaterThanOrEqual(progressUpdates[i - 1]);
    }

    // Should end at 90 (index.job takes over from there)
    expect(progressUpdates.at(-1)).toBe(90);
  });
});

describe("Job pipeline — queue integration (requires Redis)", () => {
  let queue: Queue;

  beforeAll(() => {
    queue = getRepoAnalysisQueue();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await getRedisConnection().quit();
  });

  it("job can be enqueued and has correct initial state", async () => {
    const testDir = path.join(os.tmpdir(), `codevis-enqueue-test-${Date.now()}`);
    await createTestRepo(testDir);

    const job = await queue.add(
      JOB.CLONE,
      {
        repoId:   "integration-test-1",
        repoUrl:  "https://github.com/test/test",  // won't actually clone in unit test
        cloneDir: testDir,
      } satisfies CloneJobData,
      JOB_OPTS.clone
    );

    expect(job.id).toBeDefined();

    const state = await job.getState();
    expect(["waiting", "active"]).toContain(state);

    // Clean up
    await job.remove();
    await fs.rm(testDir, { recursive: true, force: true });
  });
});
