// ============================================================
// jobs/analyze.job.ts  —  THE core job
//
// This is the most complex and longest-running job.
// It does three things in sequence:
//
//   1. Parse all source files in parallel (p-limit: 8 workers)
//      → uses ParserEngine from analysis-engine package
//
//   2. Write nodes + edges to Neo4j in batched transactions
//      → uses Neo4jWriter from analysis-engine package
//
//   3. Write file metadata to PostgreSQL
//      → bulk INSERT with ON CONFLICT DO UPDATE
//
// Progress reporting:
//   25% → start
//   25–75% → parsing files (proportional to files done)
//   75–85% → writing to Neo4j
//   85–90% → writing to PostgreSQL
//   90% → done (index.job takes over from here)
//
// Error strategy:
//   - Individual file parse failures are NON-FATAL.
//     We log them and continue. A repo with 1 broken file
//     should still produce a useful graph.
//   - Neo4j write failures ARE fatal — retry the whole job.
//   - We report parse error count in the result for the UI.
// ============================================================

import pLimit from "p-limit";
import type { Job } from "bullmq";
import {
  ParserEngine,
  type FileParseResult,
} from "@codevis/analysis-engine";
import { Neo4jWriter } from "@codevis/analysis-engine/graph";
import type {
  AnalyzeJobData,
  AnalyzeJobResult,
  JobProgress,
} from "./job.types.js";
import { getDb } from "../db/postgres.js";

// Batch sizes tuned for typical heap limits
const PARSE_CONCURRENCY = 8;    // parallel file parsers
const NEO4J_BATCH_SIZE  = 500;  // nodes/edges per Cypher UNWIND
const PG_BATCH_SIZE     = 1000; // rows per INSERT batch

export async function runAnalyzeJob(
  job: Job<AnalyzeJobData, AnalyzeJobResult>
): Promise<AnalyzeJobResult> {
  const { repoId, cloneDir, filePaths } = job.data;
  const t0 = Date.now();

  await progress(job, 26, "Parsing", `Starting analysis of ${filePaths.length} files…`);

  // ── Phase 1: Parse all files ─────────────────────────────
  const engine = new ParserEngine({
    rootDir: cloneDir,
    concurrency: PARSE_CONCURRENCY,
  });

  const results: FileParseResult[] = [];
  const limit = pLimit(PARSE_CONCURRENCY);
  let parsed = 0;
  let parseErrors = 0;

  // Parse files with live progress (25% → 75%)
  await Promise.all(
    filePaths.map((filePath) =>
      limit(async () => {
        try {
          const result = await engine.analyzeFile(filePath);
          if (result) {
            results.push(result);
            parseErrors += result.parseErrors.length;
          }
        } catch (err) {
          // Individual file failure — non-fatal
          parseErrors++;
          console.warn(`[analyze.job] parse error in ${filePath}:`, err);
        } finally {
          parsed++;

          // Report progress every 50 files (avoid hammering Redis)
          if (parsed % 50 === 0 || parsed === filePaths.length) {
            const pct = 26 + Math.floor((parsed / filePaths.length) * 49);
            await progress(
              job,
              pct,
              "Parsing files",
              `${parsed} / ${filePaths.length} files parsed`,
              parsed,
              filePaths.length
            );
          }
        }
      })
    )
  );

  await progress(job, 75, "Writing graph", "Storing dependency graph in Neo4j…");

  // ── Phase 2: Write graph to Neo4j ───────────────────────
  const neo4j = new Neo4jWriter({
    uri:      process.env.NEO4J_URI      ?? "bolt://localhost:7687",
    user:     process.env.NEO4J_USER     ?? "neo4j",
    password: process.env.NEO4J_PASSWORD ?? "password",
  });

  try {
    await neo4j.writeRepo(repoId, results);
  } finally {
    await neo4j.close();
  }

  await progress(job, 85, "Writing metadata", "Storing file metadata in PostgreSQL…");

  // ── Phase 3: Write metadata to PostgreSQL ───────────────
  await writeFileMetadataToPostgres(repoId, results);

  await progress(job, 90, "Analysis complete", `Processed ${results.length} files`);

  return {
    repoId,
    filesAnalyzed: results.length,
    nodesWritten:  results.length,                         // one node per file
    edgesWritten:  results.reduce((s, r) => s + r.imports.filter(i => i.toFile).length, 0),
    parseErrors,
    durationMs:    Date.now() - t0,
  };
}

// ── PostgreSQL bulk write ────────────────────────────────────
//
// We write file metadata to PG so the API can query it without
// going through Neo4j. Things like "list all files sorted by
// complexity" are much faster in PG than Cypher.

async function writeFileMetadataToPostgres(
  repoId: string,
  results: FileParseResult[]
): Promise<void> {
  const db = getDb();

  // Process in batches to avoid hitting PG query size limits
  for (let i = 0; i < results.length; i += PG_BATCH_SIZE) {
    const batch = results.slice(i, i + PG_BATCH_SIZE);

    // Build the VALUES rows
    const rows = batch.map((r) => ({
      repo_id:       repoId,
      file_path:     r.filePath,
      language:      r.language,
      loc:           r.loc,
      complexity:    Math.max(0, ...r.functions.map((f) => f.complexity)),
      function_count: r.functions.length,
      class_count:   r.classes.length,
      import_count:  r.imports.length,
      export_count:  r.exports.length,
      parse_errors:  r.parseErrors.length,
    }));

    // Upsert: re-running analysis on the same repo updates in place
    await db
      .insertInto("files")
      .values(rows)
      .onConflict((oc) =>
        oc.columns(["repo_id", "file_path"]).doUpdateSet({
          loc:           (eb) => eb.ref("excluded.loc"),
          complexity:    (eb) => eb.ref("excluded.complexity"),
          function_count:(eb) => eb.ref("excluded.function_count"),
          class_count:   (eb) => eb.ref("excluded.class_count"),
          import_count:  (eb) => eb.ref("excluded.import_count"),
          export_count:  (eb) => eb.ref("excluded.export_count"),
          parse_errors:  (eb) => eb.ref("excluded.parse_errors"),
          updated_at:    new Date(),
        })
      )
      .execute();
  }
}

// ── Progress helper ──────────────────────────────────────────

async function progress(
  job: Job,
  pct: number,
  stage: string,
  message: string,
  filesProcessed?: number,
  filesTotal?: number
): Promise<void> {
  await job.updateProgress({
    pct,
    stage,
    message,
    filesProcessed,
    filesTotal,
  } satisfies JobProgress);
}
