// ============================================================
// sandbox/executor.ts
//
// Runs user-submitted code inside an isolated Docker container.
//
// Security model:
//   - Ephemeral container (created + destroyed per run)
//   - No network access (--network none)
//   - Read-only filesystem (--read-only)
//   - Non-root user (--user nobody)
//   - CPU limit: 0.5 cores
//   - Memory limit: 128MB
//   - Timeout: 10 seconds (SIGKILL after)
//   - No new privileges (--security-opt no-new-privileges)
//
// Supported runtimes: node:20-alpine, python:3.12-alpine
// ============================================================

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────

export type SupportedLanguage = "javascript" | "typescript" | "python";

export interface RunRequest {
  language:  SupportedLanguage;
  code:      string;
  stdin?:    string;           // optional test case input
  timeoutMs?: number;          // default 10_000
}

export interface RunResult {
  stdout:    string;
  stderr:    string;
  exitCode:  number;
  durationMs: number;
  timedOut:  boolean;
  error?:    string;           // executor-level error (not user code error)
}

// ── Runtime config per language ───────────────────────────────

const RUNTIME: Record<SupportedLanguage, { image: string; filename: string; cmd: string[] }> = {
  javascript: {
    image:    "node:20-alpine",
    filename: "solution.js",
    cmd:      ["node", "/sandbox/solution.js"],
  },
  typescript: {
    // ts-node for simplicity; esbuild would be faster but larger image
    image:    "node:20-alpine",
    filename: "solution.ts",
    cmd:      ["npx", "--yes", "tsx", "/sandbox/solution.ts"],
  },
  python: {
    image:    "python:3.12-alpine",
    filename: "solution.py",
    cmd:      ["python3", "/sandbox/solution.py"],
  },
};

// Max code size — prevent abuse
const MAX_CODE_BYTES = 64 * 1024; // 64KB

// ── Executor ─────────────────────────────────────────────────

export async function executeCode(req: RunRequest): Promise<RunResult> {
  const { language, code, stdin = "", timeoutMs = 10_000 } = req;

  // Validate
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    return {
      stdout: "", stderr: "Code too large (max 64KB)", exitCode: 1,
      durationMs: 0, timedOut: false,
      error: "Code exceeds maximum allowed size",
    };
  }

  const runtime = RUNTIME[language];
  if (!runtime) {
    return {
      stdout: "", stderr: `Unsupported language: ${language}`, exitCode: 1,
      durationMs: 0, timedOut: false,
    };
  }

  // Write code to a temp file on the host
  // Docker will bind-mount this directory as read-only into the container
  const runId   = randomUUID();
  const tmpDir  = path.join(os.tmpdir(), "codevis-sandbox", runId);
  const codeFile = path.join(tmpDir, runtime.filename);

  await fs.mkdir(tmpDir, { recursive: true });
  await fs.writeFile(codeFile, code, "utf8");

  const t0 = Date.now();

  try {
    const dockerArgs = buildDockerArgs(runtime, tmpDir, stdin, timeoutMs);

    const { stdout, stderr } = await execFileAsync("docker", dockerArgs, {
      timeout: timeoutMs + 2000, // extra 2s buffer for Docker overhead
      maxBuffer: 1024 * 1024,    // 1MB output cap
    });

    return {
      stdout:     stdout.slice(0, 50_000),   // cap output at 50KB
      stderr:     stderr.slice(0, 10_000),
      exitCode:   0,
      durationMs: Date.now() - t0,
      timedOut:   false,
    };

  } catch (err: unknown) {
    const execErr = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      code?: number | string;
    };

    const timedOut = execErr.killed === true || execErr.code === "ETIMEDOUT";

    return {
      stdout:     execErr.stdout?.slice(0, 50_000) ?? "",
      stderr:     execErr.stderr?.slice(0, 10_000) ?? "",
      exitCode:   typeof execErr.code === "number" ? execErr.code : 1,
      durationMs: Date.now() - t0,
      timedOut,
      error:      timedOut ? "Execution timed out" : undefined,
    };

  } finally {
    // Always clean up temp files
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ── Build Docker args ─────────────────────────────────────────

function buildDockerArgs(
  runtime: (typeof RUNTIME)[SupportedLanguage],
  tmpDir: string,
  stdin: string,
  timeoutMs: number
): string[] {
  return [
    "run",
    "--rm",                              // auto-remove when done
    "--network", "none",                 // no internet access
    "--read-only",                       // immutable filesystem
    "--memory", "128m",                  // 128MB RAM cap
    "--memory-swap", "128m",             // no swap (prevent memory attacks)
    "--cpus", "0.5",                     // half a CPU core
    "--pids-limit", "64",               // max 64 processes (prevent fork bombs)
    "--user", "nobody",                  // non-root
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",                 // drop all Linux capabilities
    "--tmpfs", "/tmp:size=16m,noexec",   // small writable /tmp, no exec
    "--stop-timeout", `${Math.ceil(timeoutMs / 1000)}`,
    // Bind-mount user code as read-only
    "--volume", `${tmpDir}:/sandbox:ro`,
    // Timeout wrapper: 'timeout' command inside container
    "--entrypoint", "timeout",
    runtime.image,
    `${Math.ceil(timeoutMs / 1000)}s`,
    ...runtime.cmd,
  ];
}
