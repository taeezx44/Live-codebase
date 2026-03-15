// ============================================================
// Neo4jWriter
//
// Takes FileParseResult[] and writes it into Neo4j as:
//
//   (:File { path, language, loc, complexity })
//   (:Function { name, filePath, loc, complexity, isAsync })
//   (:Class { name, filePath })
//
//   (:File)-[:IMPORTS { kind, symbols }]->(:File)
//   (:File)-[:DEFINES]->(:Function)
//   (:File)-[:DEFINES]->(:Class)
//   (:Function)-[:CALLS]->(:Function)  [resolved later]
//
// We use MERGE (not CREATE) everywhere so re-runs are idempotent.
// ============================================================

import neo4j, { type Driver, type Session } from "neo4j-driver";
import type { FileParseResult } from "./ast.js";

export interface Neo4jConfig {
  uri: string;       // e.g. "bolt://localhost:7687"
  user: string;
  password: string;
  database?: string; // default: "neo4j"
}

const BATCH_SIZE = 500; // nodes per UNWIND batch — tuned for Neo4j heap

export class Neo4jWriter {
  private driver: Driver;
  private database: string;

  constructor(config: Neo4jConfig) {
    this.driver = neo4j.driver(
      config.uri,
      neo4j.auth.basic(config.user, config.password)
    );
    this.database = config.database ?? "neo4j";
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  // ── Setup constraints (run once on first deploy) ────────────

  async createConstraints(): Promise<void> {
    const session = this.session();
    try {
      await session.run(
        "CREATE CONSTRAINT file_path IF NOT EXISTS FOR (f:File) REQUIRE f.path IS UNIQUE"
      );
      await session.run(
        "CREATE CONSTRAINT fn_id IF NOT EXISTS FOR (fn:Function) REQUIRE fn.id IS UNIQUE"
      );
      await session.run(
        "CREATE CONSTRAINT class_id IF NOT EXISTS FOR (c:Class) REQUIRE c.id IS UNIQUE"
      );
    } finally {
      await session.close();
    }
  }

  // ── Main write path ─────────────────────────────────────────

  async writeRepo(
    repoId: string,
    files: FileParseResult[]
  ): Promise<void> {
    // Write in three passes:
    //   1. File nodes
    //   2. Function + Class nodes
    //   3. IMPORTS edges (all File nodes must exist first)

    await this.writeFileNodes(repoId, files);
    await this.writeFunctionNodes(repoId, files);
    await this.writeClassNodes(repoId, files);
    await this.writeImportEdges(repoId, files);
    await this.writeCallEdges(repoId, files);
    await this.writeHierarchyEdges(repoId, files);
  }

  // ── Pass 1: File nodes ──────────────────────────────────────

  private async writeFileNodes(
    repoId: string,
    files: FileParseResult[]
  ): Promise<void> {
    const params = files.map((f: any) => ({
      path: f.filePath,
      language: f.language,
      loc: neo4j.int(f.loc),
      exportCount: neo4j.int(f.exports.length),
      parseErrors: neo4j.int(f.parseErrors.length),
      repoId,
    }));

    await this.batchWrite(
      params,
      `UNWIND $batch AS props
       MERGE (f:File { path: props.path })
       SET f += props`,
    );
  }

  // ── Pass 2: Function nodes + DEFINES edges ─────────────────

  private async writeFunctionNodes(
    repoId: string,
    files: FileParseResult[]
  ): Promise<void> {
    const params = files.flatMap((f) =>
      f.functions.map((fn: any) => ({
        id: `${repoId}:${f.filePath}:${fn.name}:${fn.range.start.line}`,
        name: fn.name,
        filePath: f.filePath,
        loc: neo4j.int(fn.loc),
        complexity: neo4j.int(fn.complexity),
        isAsync: fn.isAsync,
        isExported: fn.isExported,
        paramCount: neo4j.int(fn.params.length),
        startLine: neo4j.int(fn.range.start.line),
      }))
    );

    await this.batchWrite(
      params,
      `UNWIND $batch AS props
       MERGE (fn:Function { id: props.id })
       SET fn += props
       WITH fn, props
       MATCH (f:File { path: props.filePath })
       MERGE (f)-[:DEFINES]->(fn)`,
    );
  }

  // ── Pass 3: Class nodes + DEFINES edges ────────────────────

  private async writeClassNodes(
    repoId: string,
    files: FileParseResult[]
  ): Promise<void> {
    const params = files.flatMap((f) =>
      f.classes.map((cls: any) => ({
        id: `${repoId}:${f.filePath}:${cls.name}`,
        name: cls.name,
        filePath: f.filePath,
        superClass: cls.superClass ?? null,
        interfaces: cls.interfaces,
        isExported: cls.isExported,
        methodCount: neo4j.int(cls.methods.length),
        startLine: neo4j.int(cls.range.start.line),
      }))
    );

    await this.batchWrite(
      params,
      `UNWIND $batch AS props
       MERGE (c:Class { id: props.id })
       SET c += props
       WITH c, props
       MATCH (f:File { path: props.filePath })
       MERGE (f)-[:DEFINES]->(c)`,
    );
  }

  // ── Pass 4: IMPORTS edges ───────────────────────────────────

  private async writeImportEdges(
    repoId: string,
    files: FileParseResult[]
  ): Promise<void> {
    // Only write edges where toFile is resolved (internal imports)
    const params = files.flatMap((f) =>
      f.imports
        .filter((imp: any) => imp.toFile != null)
        .map((imp: any) => ({
          fromPath: f.filePath,
          toPath: imp.toFile!,
          kind: imp.kind,
          symbols: imp.symbols,
          line: neo4j.int(imp.range.start.line),
        }))
    );

    await this.batchWrite(
      params,
      `UNWIND $batch AS props
       MATCH (from:File { path: props.fromPath })
       MATCH (to:File   { path: props.toPath   })
       MERGE (from)-[r:IMPORTS { kind: props.kind }]->(to)
       SET r.symbols = props.symbols,
           r.line    = props.line`,
    );
  }

  // ── Pass 5: CALLS edges (Function → Function) ─────────────
  //
  // Resolution strategy: fn.calls[] contains raw called names.
  // We attempt to match them against Function nodes in the same repo.
  // Unresolved calls (external libraries) are silently dropped.

  private async writeCallEdges(
    repoId: string,
    files: FileParseResult[]
  ): Promise<void> {
    // Build a flat list of (callerId, calleeName) pairs
    const params = files.flatMap((f) =>
      f.functions.flatMap((fn: any) => {
        const callerId = `${repoId}:${f.filePath}:${fn.name}:${fn.range.start.line}`;
        return fn.calls.map((callee: any) => ({
          callerId,
          calleeName: callee,
          repoId,
        }));
      })
    );

    if (params.length === 0) return;

    // Match by function name within the same repo — best-effort resolution.
    // When multiple functions share a name, we create edges to all of them.
    await this.batchWrite(
      params,
      `UNWIND $batch AS props
       MATCH (caller:Function { id: props.callerId })
       MATCH (callee:Function)
       WHERE callee.name = props.calleeName
         AND callee.filePath STARTS WITH props.repoId
       MERGE (caller)-[:CALLS]->(callee)`,
    );
  }

  // ── Pass 6: EXTENDS + IMPLEMENTS hierarchy edges ───────────
  //
  // Writes:
  //   (:Class)-[:EXTENDS]->(:Class)     — class Dog extends Animal
  //   (:Class)-[:IMPLEMENTS]->(:Class)  — class Foo implements Bar (TS)

  private async writeHierarchyEdges(
    repoId: string,
    files: FileParseResult[]
  ): Promise<void> {
    const extendsParams = files.flatMap((f) =>
      f.classes
        .filter((cls: any) => cls.superClass != null)
        .map((cls: any) => ({
          childId:         `${repoId}:${f.filePath}:${cls.name}`,
          superClassName:  cls.superClass!,
          repoId,
        }))
    );

    const implementsParams = files.flatMap((f) =>
      f.classes.flatMap((cls: any) =>
        cls.interfaces.map((iface: any) => ({
          classId:       `${repoId}:${f.filePath}:${cls.name}`,
          interfaceName: iface,
          repoId,
        }))
      )
    );

    if (extendsParams.length > 0) {
      await this.batchWrite(
        extendsParams,
        `UNWIND $batch AS props
         MATCH (child:Class { id: props.childId })
         MATCH (parent:Class)
         WHERE parent.name = props.superClassName
           AND parent.filePath STARTS WITH props.repoId
         MERGE (child)-[:EXTENDS]->(parent)`,
      );
    }

    if (implementsParams.length > 0) {
      await this.batchWrite(
        implementsParams,
        `UNWIND $batch AS props
         MATCH (cls:Class { id: props.classId })
         MATCH (iface:Class)
         WHERE iface.name = props.interfaceName
           AND iface.filePath STARTS WITH props.repoId
         MERGE (cls)-[:IMPLEMENTS]->(iface)`,
      );
    }
  }

  // ── Utility: batch UNWIND writes ───────────────────────────

  private async batchWrite(
    rows: object[],
    cypher: string
  ): Promise<void> {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const session = this.session();
      try {
        await session.run(cypher, { batch });
      } finally {
        await session.close();
      }
    }
  }

  private session(): Session {
    return this.driver.session({ database: this.database });
  }
}

// ── Power Queries (for the API layer to use) ─────────────────

export const CYPHER = {
  // Get all files a given file depends on (direct imports)
  directDeps: `
    MATCH (f:File { path: $path })-[:IMPORTS]->(dep:File)
    RETURN dep.path AS path, dep.language AS language, dep.loc AS loc
  `,

  // Impact analysis: what files import THIS file (1-3 hops)
  impactedBy: `
    MATCH (f:File { path: $path })<-[:IMPORTS*1..3]-(importer:File)
    RETURN DISTINCT importer.path AS path, importer.language AS language
    ORDER BY importer.path
  `,

  // Full dep graph for a repo (nodes + edges for D3/Sigma)
  repoGraph: `
    MATCH (f:File { repoId: $repoId })
    OPTIONAL MATCH (f)-[r:IMPORTS]->(dep:File { repoId: $repoId })
    RETURN
      collect(DISTINCT {
        id: f.path, language: f.language,
        loc: f.loc, complexity: f.complexity
      }) AS nodes,
      collect(DISTINCT {
        source: f.path, target: dep.path,
        kind: r.kind, symbols: r.symbols
      }) AS edges
  `,

  // Circular dependency detection
  findCycles: `
    MATCH path = (f:File { repoId: $repoId })-[:IMPORTS*2..10]->(f)
    RETURN [n IN nodes(path) | n.path] AS cycle
    LIMIT 50
  `,

  // Hotspot: most imported files (high fan-in = core module)
  hotspots: `
    MATCH (f:File { repoId: $repoId })<-[:IMPORTS]-(importer)
    WITH f, count(importer) AS fanIn
    RETURN f.path AS path, f.loc AS loc, fanIn
    ORDER BY fanIn DESC
    LIMIT 20
  `,
};
