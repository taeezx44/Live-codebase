// ============================================================
// Core AST types — shared across all language parsers
// ============================================================

export type Language = "javascript" | "typescript" | "python" | "go" | "java";

export interface Position {
  line: number;   // 0-indexed (tree-sitter default)
  column: number;
}

export interface Range {
  start: Position;
  end: Position;
}

// A single import statement extracted from a file
export interface ImportEdge {
  fromFile: string;        // absolute path of the importing file
  toModule: string;        // raw specifier: "./utils", "lodash", etc.
  toFile?: string;         // resolved absolute path (filled later by resolver)
  kind: "static" | "dynamic" | "require" | "side-effect";
  symbols: string[];       // ["useState", "useEffect"] or ["default"] or ["*"]
  range: Range;
}

// A function or method found in a file
export interface FunctionNode {
  name: string;
  filePath: string;
  range: Range;
  params: string[];
  isAsync: boolean;
  isExported: boolean;
  complexity: number;      // cyclomatic complexity
  loc: number;             // lines of code (end.line - start.line + 1)
  calls: string[];         // raw names of functions this fn calls
}

// A class found in a file
export interface ClassNode {
  name: string;
  filePath: string;
  range: Range;
  superClass?: string;
  interfaces: string[];
  methods: FunctionNode[];
  isExported: boolean;
}

// Full parse result for one file
export interface FileParseResult {
  filePath: string;
  language: Language;
  loc: number;             // total lines
  imports: ImportEdge[];
  exports: string[];       // exported names
  functions: FunctionNode[];
  classes: ClassNode[];
  parseErrors: string[];   // any tree-sitter ERROR nodes
  durationMs: number;
}
