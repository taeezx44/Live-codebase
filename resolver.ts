// ============================================================
// Import Resolver
//
// After parsing, every ImportEdge has a raw `toModule` string
// like "./utils", "../lib/db", "lodash", "@/components/Button".
//
// This module resolves them to absolute file paths (or marks
// them as "external" if they're third-party npm packages).
//
// Resolution order (mirrors Node.js + TypeScript):
//   1. Exact match: ./foo.ts → /abs/foo.ts
//   2. Extension fallback: ./foo → ./foo.ts → ./foo.tsx → ./foo.js
//   3. Index file: ./foo → ./foo/index.ts → ./foo/index.js
//   4. Path alias: @/components → <root>/src/components
//   5. No match → mark as external (npm package)
// ============================================================

import path from "node:path";
import fs from "node:fs";
import type { ImportEdge } from "../types/ast.js";

export interface ResolverConfig {
  rootDir: string;
  // tsconfig paths mapping e.g. { "@/*": ["src/*"] }
  aliases?: Record<string, string[]>;
  extensions?: string[];
}

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export class ImportResolver {
  private readonly rootDir: string;
  private readonly aliases: Record<string, string[]>;
  private readonly extensions: string[];

  constructor(config: ResolverConfig) {
    this.rootDir = config.rootDir;
    this.aliases = config.aliases ?? {};
    this.extensions = config.extensions ?? DEFAULT_EXTENSIONS;
  }

  // Resolve all edges in a parse result, mutating toFile in place
  resolveAll(edges: ImportEdge[]): ImportEdge[] {
    return edges.map((edge) => ({
      ...edge,
      toFile: this.resolve(edge.fromFile, edge.toModule),
    }));
  }

  resolve(fromFile: string, specifier: string): string | undefined {
    // ── 1. Apply path aliases ───────────────────────────────
    const aliased = this.applyAlias(specifier);
    const effectiveSpecifier = aliased ?? specifier;

    // ── 2. External package (doesn't start with . or /) ────
    if (!effectiveSpecifier.startsWith(".") && !effectiveSpecifier.startsWith("/")) {
      return undefined; // external — neo4j edge will be marked "external"
    }

    const fromDir = path.dirname(fromFile);
    const base = path.resolve(fromDir, effectiveSpecifier);

    // ── 3. Exact path with extension ───────────────────────
    if (fs.existsSync(base) && fs.statSync(base).isFile()) {
      return base;
    }

    // ── 4. Try appending extensions ────────────────────────
    for (const ext of this.extensions) {
      const candidate = base + ext;
      if (fs.existsSync(candidate)) return candidate;
    }

    // ── 5. Index file inside directory ─────────────────────
    for (const ext of this.extensions) {
      const candidate = path.join(base, "index" + ext);
      if (fs.existsSync(candidate)) return candidate;
    }

    // Not found — could be a virtual module or missing file
    return undefined;
  }

  private applyAlias(specifier: string): string | null {
    for (const [pattern, targets] of Object.entries(this.aliases)) {
      // Support both exact "lodash" and glob "@/*"
      const prefix = pattern.replace(/\*$/, "");
      if (specifier.startsWith(prefix)) {
        const rest = specifier.slice(prefix.length);
        // Use the first alias target
        const target = targets[0].replace(/\*$/, "");
        return path.join(this.rootDir, target, rest);
      }
    }
    return null;
  }
}
