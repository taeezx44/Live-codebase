// ============================================================
// ParserEngine — the public API of analysis-engine
//
// Usage:
//   const engine = new ParserEngine({ rootDir: "/path/to/repo" });
//   const result = await engine.analyzeFile("/path/to/repo/src/app.ts");
//   const repoResult = await engine.analyzeRepo("/path/to/repo");
// ============================================================

import fs from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import pLimit from "p-limit";
import { JavaScriptParser, TypeScriptParser } from "./parsers/javascript.parser.js";
import { PythonParser }     from "./parsers/python.parser.js";
import { GoParser }         from "./parsers/go.parser.js";
import { ImportResolver, type ResolverConfig } from "./resolver.js";
import type { FileParseResult, Language } from "./ast.js";
import { BaseParser } from "./parsers/base.parser.js";

// ── Registry ────────────────────────────────────────────────

const EXT_TO_LANGUAGE: Record<string, Language> = {
  ".js":  "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts":  "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".py":  "python",
  ".pyi": "python",     // Python stub files — same grammar
  ".go":  "go",
};

// Files/dirs we never want to parse
const IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/__pycache__/**",
  "**/*.min.js",
  "**/*.bundle.js",
  "**/*.d.ts",           // TS declaration files — not real code
];

// ── Engine ───────────────────────────────────────────────────

export interface EngineConfig {
  rootDir: string;
  aliases?: Record<string, string[]>;
  /** Max parallel file parse workers. Default: 8 */
  concurrency?: number;
}

export interface RepoAnalysisResult {
  rootDir: string;
  files: FileParseResult[];
  totalFiles: number;
  totalLoc: number;
  parseErrors: number;
  durationMs: number;
  languages: Record<Language, number>; // file count per language
}

export class ParserEngine {
  private readonly parsers: Map<Language, BaseParser>;
  private readonly resolver: ImportResolver;
  private readonly concurrency: number;
  private readonly rootDir: string;

  constructor(config: EngineConfig) {
    this.rootDir = config.rootDir;
    this.concurrency = config.concurrency ?? 8;

    // Lazy-init parsers — tree-sitter grammars are ~2MB each,
    // only load what we actually encounter
    this.parsers = new Map<Language, BaseParser>([
      ["javascript", new JavaScriptParser()],
      ["typescript", new TypeScriptParser()],
      ["python",     new PythonParser()],
      ["go",         new GoParser()],
    ]);

    this.resolver = new ImportResolver({
      rootDir: config.rootDir,
      aliases: config.aliases,
    });
  }

  // ── Analyse a single file ───────────────────────────────────

  async analyzeFile(filePath: string): Promise<FileParseResult | null> {
    const ext = path.extname(filePath).toLowerCase();
    const language = EXT_TO_LANGUAGE[ext];
    if (!language) return null; // unsupported extension

    const parser = this.parsers.get(language);
    if (!parser) return null;

    const source = await fs.readFile(filePath, "utf-8");
    const result = parser.parse(filePath, source);

    // Resolve import specifiers → absolute paths
    result.imports = this.resolver.resolveAll(result.imports);

    return result;
  }

  // ── Analyse an entire repository ───────────────────────────

  async analyzeRepo(
    onProgress?: (done: number, total: number) => void
  ): Promise<RepoAnalysisResult> {
    const t0 = performance.now();

    // Discover all source files
    const files = await glob("**/*", {
      cwd: this.rootDir,
      absolute: true,
      nodir: true,
      ignore: IGNORE_PATTERNS,
    });

    // Filter to only supported extensions
    const sourceFiles = files.filter((f: string) => {
      const ext = path.extname(f).toLowerCase();
      return ext in EXT_TO_LANGUAGE;
    });

    // Parse with bounded concurrency (avoid OOM on huge repos)
    const limit = pLimit(this.concurrency);
    let done = 0;
    const results: FileParseResult[] = [];

    await Promise.all(
      sourceFiles.map((filePath: string) =>
        limit(async () => {
          const result = await this.analyzeFile(filePath);
          if (result) results.push(result);
          done++;
          onProgress?.(done, sourceFiles.length);
        })
      )
    );

    // Aggregate stats
    const languages = {} as Record<Language, number>;
    let totalLoc = 0;
    let parseErrors = 0;

    for (const r of results) {
      languages[r.language] = (languages[r.language] ?? 0) + 1;
      totalLoc += r.loc;
      parseErrors += r.parseErrors.length;
    }

    return {
      rootDir: this.rootDir,
      files: results,
      totalFiles: results.length,
      totalLoc,
      parseErrors,
      durationMs: performance.now() - t0,
      languages,
    };
  }
}
