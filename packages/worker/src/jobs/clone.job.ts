// ============================================================
// jobs/clone.job.ts
//
// Clones a GitHub repo into /tmp/repos/{repoId} using
// simple-git (wraps git CLI).
//
// Uses --depth=1 --single-branch by default — fast for most
// repos. If the user requests git history analysis later
// (Phase 3), we can do a separate `git fetch --unshallow`.
//
// After clone, discovers all source files and returns their
// paths so analyze.job can receive them as its input.
// ============================================================

import path from "node:path";
import fs from "node:fs/promises";
import { glob } from "glob";
import simpleGit from "simple-git";
import type { Job } from "bullmq";
import type {
  CloneJobData,
  CloneJobResult,
  JobProgress,
} from "./job.types.js";

// Files we never want to analyze — mirrors analysis-engine ignores
const IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/__pycache__/**",
  "**/*.min.js",
  "**/*.bundle.js",
  "**/*.d.ts",
];

const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts",
  ".js", ".jsx", ".mjs", ".cjs",
  ".py",
  ".go",
  ".java",
]);

// Repos over this size (MB) get a warning but still proceed
const REPO_SIZE_WARN_MB = 500;

export async function runCloneJob(
  job: Job<CloneJobData, CloneJobResult>
): Promise<CloneJobResult> {
  const { repoId, repoUrl, branch, cloneDir } = job.data;

  // ── Step 1: Prepare clone directory ─────────────────────
  await progress(job, 2, "Preparing", "Setting up clone directory…");

  await fs.mkdir(cloneDir, { recursive: true });

  // ── Step 2: Clone ────────────────────────────────────────
  await progress(job, 5, "Cloning", `Cloning ${repoUrl}…`);

  const git = simpleGit();

  // Track git progress events → map to our 5–20% window
  const cloneOptions: string[] = [
    "--depth=1",
    "--single-branch",
    "--no-tags",
    "--filter=blob:none",   // partial clone: skip large blobs initially
  ];
  if (branch) cloneOptions.push("--branch", branch);

  await git.clone(repoUrl, cloneDir, cloneOptions);

  // ── Step 3: Read repo metadata ───────────────────────────
  await progress(job, 22, "Reading metadata", "Fetching commit info…");

  const repoGit = simpleGit(cloneDir);
  const logResult = await repoGit.log({ maxCount: 1 });
  const commitHash = logResult.latest?.hash ?? "unknown";

  const branchResult = await repoGit.revparse(["--abbrev-ref", "HEAD"]);
  const defaultBranch = branchResult.trim();

  // ── Step 4: Discover source files ───────────────────────
  await progress(job, 24, "Discovering files", "Scanning source files…");

  const allFiles = await glob("**/*", {
    cwd: cloneDir,
    absolute: true,
    nodir: true,
    ignore: IGNORE_PATTERNS,
  });

  const filePaths = allFiles.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return SUPPORTED_EXTENSIONS.has(ext);
  });

  // Size warning (non-fatal)
  if (filePaths.length > 20_000) {
    console.warn(`[clone.job] ${repoId}: large repo — ${filePaths.length} source files`);
  }

  await progress(job, 25, "Clone complete", `Found ${filePaths.length} source files`);

  return {
    repoId,
    cloneDir,
    defaultBranch,
    commitHash,
    filePaths,
  };
}

// ── Cleanup helper (called in finally block by orchestrator) ─

export async function cleanCloneDir(cloneDir: string): Promise<void> {
  try {
    await fs.rm(cloneDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — log but don't throw
    console.warn(`[clone.job] Failed to clean up ${cloneDir}`);
  }
}

// ── Internal ─────────────────────────────────────────────────

async function progress(
  job: Job,
  pct: number,
  stage: string,
  message: string
): Promise<void> {
  await job.updateProgress({ pct, stage, message } satisfies JobProgress);
}
