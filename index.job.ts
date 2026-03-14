// ============================================================
// jobs/index.job.ts
//
// Builds the search index after analysis is complete.
// Runs fast (usually <5s) — reads from PostgreSQL, writes
// to a simple in-process Fuse.js index serialized to Redis.
//
// For Phase 1 this is "good enough". Phase 2 can replace with
// a proper MeiliSearch or Typesense integration.
//
// Index structure stored in Redis:
//   key: "search:index:{repoId}"
//   value: JSON array of searchable documents
//   TTL: 24h (refreshed on each re-analysis)
// ============================================================

import type { Job } from "bullmq";
import type { IndexJobData, IndexJobResult, JobProgress } from "./job.types.js";
import { getDb } from "../db/postgres.js";
import { getRedisConnection } from "../queues/connection.js";

const INDEX_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export interface SearchDocument {
  id:         string;  // file path (same as graph node id)
  filename:   string;  // "Button.tsx"
  dirPath:    string;  // "src/components"
  language:   string;
  loc:        number;
  complexity: number;
  // Concatenated symbol names for full-text matching
  symbols:    string;  // "useState useEffect MyComponent"
}

export async function runIndexJob(
  job: Job<IndexJobData, IndexJobResult>
): Promise<IndexJobResult> {
  const { repoId } = job.data;

  await progress(job, 91, "Indexing", "Loading file data…");

  const db = getDb();

  // Load all files + their exported symbols from PG
  const files = await db
    .selectFrom("files as f")
    .leftJoin("file_symbols as s", "s.file_path", "f.file_path")
    .where("f.repo_id", "=", repoId)
    .select([
      "f.file_path",
      "f.language",
      "f.loc",
      "f.complexity",
      db.fn.coalesce(
        db.fn.stringAgg("s.symbol_name", " "),
        db.val("")
      ).as("symbols"),
    ])
    .groupBy(["f.file_path", "f.language", "f.loc", "f.complexity"])
    .execute();

  await progress(job, 95, "Indexing", `Building index for ${files.length} files…`);

  // Build searchable documents
  const docs: SearchDocument[] = files.map((f) => {
    const parts    = f.file_path.split("/");
    const filename = parts.at(-1) ?? f.file_path;
    const dirPath  = parts.slice(0, -1).join("/");

    return {
      id:         f.file_path,
      filename,
      dirPath,
      language:   f.language,
      loc:        f.loc,
      complexity: f.complexity,
      symbols:    f.symbols ?? "",
    };
  });

  // Persist index to Redis (JSON — Fuse.js reads it client-side or
  // the search-engine service reads it server-side)
  const redis = getRedisConnection();
  const key   = `search:index:${repoId}`;

  await redis.set(key, JSON.stringify(docs), "EX", INDEX_TTL_SECONDS);

  await progress(job, 100, "Complete", `Indexed ${docs.length} files`);

  return { repoId, itemsIndexed: docs.length };
}

async function progress(
  job: Job,
  pct: number,
  stage: string,
  message: string
): Promise<void> {
  await job.updateProgress({ pct, stage, message } satisfies JobProgress);
}
