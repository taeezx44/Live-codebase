// ============================================================
// BaseParser — abstract class every language parser extends
// ============================================================
//
// tree-sitter gives us a concrete syntax tree (CST) where
// every node is typed and positioned. We walk it once and
// extract all the data we need in a single pass.
//
// Dependency:
//   npm install tree-sitter tree-sitter-javascript
//              tree-sitter-typescript tree-sitter-python
//              tree-sitter-go tree-sitter-java

import Parser from "tree-sitter";
import type {
  FileParseResult,
  FunctionNode,
  ClassNode,
  ImportEdge,
  Language,
  Range,
} from "../ast.js";

export abstract class BaseParser {
  protected parser: Parser;
  abstract readonly language: Language;

  constructor(tsLanguage: object) {
    this.parser = new Parser();
    // Each subclass passes its language grammar object
    this.parser.setLanguage(tsLanguage as any);
  }

  // ── Public API ──────────────────────────────────────────────

  parse(filePath: string, source: string): FileParseResult {
    const t0 = performance.now();

    const tree = this.parser.parse(source);
    const root = tree.rootNode;

    const result: FileParseResult = {
      filePath,
      language: this.language,
      loc: source.split("\n").length,
      imports: this.extractImports(root, filePath, source),
      exports: this.extractExports(root, source),
      functions: this.extractFunctions(root, filePath, source),
      classes: this.extractClasses(root, filePath, source),
      parseErrors: this.collectErrors(root),
      durationMs: performance.now() - t0,
    };

    return result;
  }

  // ── Helpers (usable by subclasses) ──────────────────────────

  protected nodeToRange(node: Parser.SyntaxNode): Range {
    return {
      start: { line: node.startPosition.row, column: node.startPosition.column },
      end:   { line: node.endPosition.row,   column: node.endPosition.column },
    };
  }

  protected nodeText(node: Parser.SyntaxNode, source: string): string {
    return source.slice(node.startIndex, node.endIndex);
  }

  // Walk a tree depth-first, calling visitor on every node.
  // Return false from visitor to prune children.
  protected walk(
    node: Parser.SyntaxNode,
    visitor: (n: Parser.SyntaxNode) => boolean | void
  ): void {
    const cont = visitor(node);
    if (cont === false) return;
    for (const child of node.children) {
      this.walk(child, visitor);
    }
  }

  // Collect all ERROR nodes (indicates parse failure in that region)
  private collectErrors(root: Parser.SyntaxNode): string[] {
    const errors: string[] = [];
    this.walk(root, (node) => {
      if (node.type === "ERROR") {
        errors.push(
          `Parse error at ${node.startPosition.row + 1}:${node.startPosition.column}`
        );
      }
    });
    return errors;
  }

  // ── Abstract — each language must implement ─────────────────

  protected abstract extractImports(
    root: Parser.SyntaxNode,
    filePath: string,
    source: string
  ): ImportEdge[];

  protected abstract extractExports(
    root: Parser.SyntaxNode,
    source: string
  ): string[];

  protected abstract extractFunctions(
    root: Parser.SyntaxNode,
    filePath: string,
    source: string
  ): FunctionNode[];

  protected abstract extractClasses(
    root: Parser.SyntaxNode,
    filePath: string,
    source: string
  ): ClassNode[];
}
