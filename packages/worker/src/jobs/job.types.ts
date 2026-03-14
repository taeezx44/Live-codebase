// ============================================================
// Job type definitions
//
// This file is the CONTRACT between api-gateway and worker.
// Both import from here — never define job shapes inline.
//
// BullMQ jobs have:
//   data   — payload added at enqueue time (immutable)
//   opts   — BullMQ options (attempts, backoff, priority…)
//
// Progress is reported as { pct, stage, message } so the
// WebSocket can show a meaningful progress bar + status text.
// ============================================================

// ── Shared progress shape ────────────────────────────────────

export interface JobProgress {
  pct: number;        // 0–100
  stage: string;      // e.g. "Parsing files"
  message: string;    // human-readable, shown in UI
  filesProcessed?: number;
  filesTotal?: number;
}

// ── clone.job ────────────────────────────────────────────────

export interface CloneJobData {
  repoId:    string;   // uuid, created by API before enqueue
  repoUrl:   string;   // https://github.com/owner/repo
  branch?:   string;   // defaults to HEAD
  cloneDir:  string;   // absolute path: /tmp/repos/{repoId}
}

export interface CloneJobResult {
  repoId:   string;
  cloneDir: string;
  defaultBranch: string;
  commitHash:    string;
  filePaths:     string[];   // all discovered source files
}

// ── analyze.job ──────────────────────────────────────────────

export interface AnalyzeJobData {
  repoId:   string;
  cloneDir: string;
  filePaths: string[];   // from CloneJobResult
}

export interface AnalyzeJobResult {
  repoId:       string;
  filesAnalyzed: number;
  nodesWritten:  number;
  edgesWritten:  number;
  parseErrors:   number;
  durationMs:    number;
}

// ── index.job ────────────────────────────────────────────────

export interface IndexJobData {
  repoId:   string;
  cloneDir: string;
}

export interface IndexJobResult {
  repoId:       string;
  itemsIndexed: number;
}

// ── Queue names (single source of truth) ────────────────────

export const QUEUE = {
  REPO_ANALYSIS: "repo-analysis",
} as const;

// ── Job names within the queue ───────────────────────────────

export const JOB = {
  CLONE:   "clone",
  ANALYZE: "analyze",
  INDEX:   "index",
} as const;

// ── Default BullMQ job options ───────────────────────────────

export const JOB_OPTS = {
  clone: {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 5_000 },
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 50  },
    timeout: 5 * 60 * 1_000,    // 5 min — large repos can be slow
  },
  analyze: {
    attempts: 2,
    backoff: { type: "exponential" as const, delay: 10_000 },
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 50  },
    timeout: 15 * 60 * 1_000,   // 15 min — big monorepos
  },
  index: {
    attempts: 3,
    backoff: { type: "fixed" as const, delay: 3_000 },
    removeOnComplete: { count: 200 },
    removeOnFail:     { count: 50  },
    timeout: 3 * 60 * 1_000,
  },
} as const;
