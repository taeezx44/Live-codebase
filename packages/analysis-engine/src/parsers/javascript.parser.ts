// ============================================================
// JavaScriptParser
//
// Handles both .js and .jsx files.
// TypeScriptParser (below) extends this for .ts / .tsx.
//
// tree-sitter node types reference:
//   https://github.com/tree-sitter/tree-sitter-javascript
// ============================================================

import TSJavaScript from "tree-sitter-javascript";
import type Parser from "tree-sitter";
import { BaseParser } from "./base.parser.js";
import type {
  ImportEdge,
  FunctionNode,
  ClassNode,
  Language,
} from "../ast.js";
import { calcCyclomaticComplexity } from "../complexity.js";

export class JavaScriptParser extends BaseParser {
  readonly language: Language = "javascript";

  constructor() {
    super(TSJavaScript);
  }

  // ── Imports ─────────────────────────────────────────────────
  //
  // We handle four forms:
  //   import x from "./x"                  → static, default
  //   import { a, b } from "./x"           → static, named
  //   import "./side-effect"               → side-effect
  //   const x = require("./x")             → require
  //   const x = await import("./x")        → dynamic

  protected extractImports(
    root: Parser.SyntaxNode,
    filePath: string,
    source: string
  ): ImportEdge[] {
    const imports: ImportEdge[] = [];

    this.walk(root, (node) => {
      // ── Static ESM import ──────────────────────────────────
      // Re-exports: export { foo } from './utils' or export * from './utils'
      // These create implicit import edges (the file depends on the re-exported module)
      if (node.type === "export_statement") {
        const sourceNode = node.childForFieldName("source");
        if (sourceNode) {
          const specifier = stripQuotes(this.nodeText(sourceNode, source));
          // export * from './foo'  or  export { a, b } from './foo'
          const clause = node.namedChildren.find((c) => c.type === "export_clause");
          const symbols: string[] = [];
          if (clause) {
            for (const spec of clause.namedChildren) {
              if (spec.type === "export_specifier") {
                const name = spec.childForFieldName("name");
                if (name) symbols.push(this.nodeText(name, source));
              }
            }
          } else {
            symbols.push("*"); // export * from './foo'
          }
          imports.push({
            fromFile: filePath,
            toModule: specifier,
            kind:     "static",
            symbols,
            range:    this.nodeToRange(node),
          });
        }
        return false;
      }

      if (node.type === "import_statement") {
        const sourceNode = node.childForFieldName("source");
        if (!sourceNode) return;

        const specifier = stripQuotes(this.nodeText(sourceNode, source));
        // tree-sitter-javascript: field name varies by version
        // find the import_clause child by type instead
        const clauseNode = node.children.find(
          (c) => c.type === "import_clause"
        ) ?? null;
        const symbols = clauseNode
          ? extractImportedSymbols(clauseNode, source)
          : [];

        imports.push({
          fromFile: filePath,
          toModule: specifier,
          kind: symbols.length === 0 ? "side-effect" : "static",
          symbols,
          range: this.nodeToRange(node),
        });
        return false; // no useful children to recurse into
      }

      // ── require("...") ─────────────────────────────────────
      if (
        node.type === "call_expression" &&
        node.childForFieldName("function")?.text === "require"
      ) {
        const args = node.childForFieldName("arguments");
        const firstArg = args?.namedChild(0);
        if (firstArg?.type === "string") {
          imports.push({
            fromFile: filePath,
            toModule: stripQuotes(this.nodeText(firstArg, source)),
            kind: "require",
            symbols: ["*"],
            range: this.nodeToRange(node),
          });
        }
        return false;
      }

      // ── import(...) — dynamic ──────────────────────────────
      if (node.type === "await_expression") {
        const inner = node.child(1); // the awaited expression
        if (inner?.type === "call_expression") {
          const fn = inner.childForFieldName("function");
          if (fn?.type === "import") {
            const args = inner.childForFieldName("arguments");
            const firstArg = args?.namedChild(0);
            if (firstArg) {
              imports.push({
                fromFile: filePath,
                toModule: stripQuotes(this.nodeText(firstArg, source)),
                kind: "dynamic",
                symbols: ["*"],
                range: this.nodeToRange(inner),
              });
            }
            return false;
          }
        }
      }
    });

    return imports;
  }

  // ── Exports ─────────────────────────────────────────────────

  protected extractExports(
    root: Parser.SyntaxNode,
    source: string
  ): string[] {
    const exports: string[] = [];

    this.walk(root, (node) => {
      if (node.type === "export_statement") {
        // export default function foo / export default class Foo
        const decl = node.childForFieldName("declaration");
        if (decl) {
          const nameNode = decl.childForFieldName("name");
          if (nameNode) exports.push(this.nodeText(nameNode, source));
        }

        // export { a, b as c }
        const clause = node.namedChildren.find(
          (c) => c.type === "export_clause"
        );
        if (clause) {
          for (const spec of clause.namedChildren) {
            if (spec.type === "export_specifier") {
              const name = spec.childForFieldName("name");
              if (name) exports.push(this.nodeText(name, source));
            }
          }
        }

        // export default <expr>
        if (node.children.some((c) => c.type === "default")) {
          exports.push("default");
        }
        return false;
      }
    });

    return [...new Set(exports)];
  }

  // ── Functions ────────────────────────────────────────────────
  //
  // Captures:
  //   function foo() {}
  //   const foo = () => {}
  //   const foo = function() {}
  //   export function foo() {}

  protected extractFunctions(
    root: Parser.SyntaxNode,
    filePath: string,
    source: string
  ): FunctionNode[] {
    const fns: FunctionNode[] = [];

    this.walk(root, (node) => {
      const fnNode = getFunctionNode(node);
      if (!fnNode) return;

      const name = resolveFunctionName(node, fnNode, source);
      if (!name) return; // skip anonymous immediately-invoked

      const params = extractParams(fnNode, source);
      const isAsync = fnNode.children.some((c) => c.type === "async");
      const isExported = isNodeExported(node);
      const calls = extractCallNames(fnNode, source);
      const complexity = calcCyclomaticComplexity(fnNode);
      const range = this.nodeToRange(node);

      fns.push({
        name,
        filePath,
        range,
        params,
        isAsync,
        isExported,
        complexity,
        loc: range.end.line - range.start.line + 1,
        calls,
      });

      // Don't skip children — nested functions are valid nodes
    });

    return fns;
  }

  // ── Classes ──────────────────────────────────────────────────

  protected extractClasses(
    root: Parser.SyntaxNode,
    filePath: string,
    source: string
  ): ClassNode[] {
    const classes: ClassNode[] = [];

    this.walk(root, (node) => {
      if (node.type !== "class_declaration" && node.type !== "class") return;

      const nameNode = node.childForFieldName("name");
      if (!nameNode) return; // anonymous class expression — skip

      // tree-sitter-javascript: superclass is in a "class_heritage" child node
      const heritageNode = node.children.find((c) => c.type === "class_heritage");
      const superClass = heritageNode
        ? heritageNode.text.replace(/^extends\s+/, "").trim()
        : undefined;

      // Extract methods from class_body
      const body = node.children.find((c) => c.type === "class_body") ?? null;
      const methods = body
        ? this.extractFunctions(body, filePath, source)
        : [];

      classes.push({
        name: this.nodeText(nameNode, source),
        filePath,
        range: this.nodeToRange(node),
        superClass,
        interfaces: [],   // JS doesn't have interfaces; TS parser overrides
        methods,
        isExported: isNodeExported(node),
      });

      return false; // methods already extracted — no need to recurse further
    });

    return classes;
  }
}

// ── Pure helper functions ────────────────────────────────────

function stripQuotes(s: string): string {
  return s.replace(/^["'`]|["'`]$/g, "");
}

function extractImportedSymbols(
  clauseNode: Parser.SyntaxNode,
  source: string
): string[] {
  const symbols: string[] = [];

  for (const child of clauseNode.namedChildren) {
    switch (child.type) {
      case "identifier": // import defaultExport
        symbols.push(child.text);
        break;
      case "namespace_import": // import * as ns
        symbols.push("*");
        break;
      case "named_imports": // import { a, b as c }
        for (const spec of child.namedChildren) {
          if (spec.type === "import_specifier") {
            const alias = spec.childForFieldName("alias");
            const name = spec.childForFieldName("name");
            symbols.push((alias ?? name)?.text ?? "");
          }
        }
        break;
    }
  }

  return symbols.filter(Boolean);
}

// Returns the "function body" node regardless of how the function is written
function getFunctionNode(
  node: Parser.SyntaxNode
): Parser.SyntaxNode | null {
  if (
    node.type === "function_declaration" ||
    node.type === "function" ||
    node.type === "generator_function_declaration" ||
    node.type === "generator_function"
  ) {
    return node;
  }

  // Class method: method_definition contains a function body
  if (node.type === "method_definition") {
    return node;
  }

  // Arrow or function expression assigned to a variable:
  // const foo = () => {} OR const foo = function() {}
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    const declarator = node.namedChildren.find(
      (c) => c.type === "variable_declarator"
    );
    const val = declarator?.childForFieldName("value");
    if (val?.type === "arrow_function" || val?.type === "function") {
      return val;
    }
  }

  return null;
}

function resolveFunctionName(
  containerNode: Parser.SyntaxNode,
  fnNode: Parser.SyntaxNode,
  source: string
): string | null {
  // Named function declaration: function foo() {}
  const nameNode = fnNode.childForFieldName("name");
  if (nameNode) return nameNode.text;

  // method_definition: name is a property_identifier child
  // e.g. bark() {} → first named child is the method name
  if (fnNode.type === "method_definition") {
    const firstNamed = fnNode.namedChild(0);
    if (firstNamed) return firstNamed.text;
  }

  // Arrow/function assigned to variable: const foo = () => {}
  if (
    containerNode.type === "lexical_declaration" ||
    containerNode.type === "variable_declaration"
  ) {
    const declarator = containerNode.namedChildren.find(
      (c) => c.type === "variable_declarator"
    );
    const id = declarator?.childForFieldName("name");
    return id?.text ?? null;
  }

  return null;
}

function extractParams(fnNode: Parser.SyntaxNode, source: string): string[] {
  const params = fnNode.childForFieldName("parameters");
  if (!params) return [];

  return params.namedChildren
    .map((p) => {
      // Handle destructured params like ({ a, b }) or ([x])
      if (p.type === "identifier") return p.text;
      if (p.type === "rest_pattern") return `...${p.namedChild(0)?.text ?? ""}`;
      if (p.type === "assignment_pattern") {
        return p.childForFieldName("left")?.text ?? p.text;
      }
      return p.text;
    })
    .filter(Boolean);
}

function isNodeExported(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return (
    parent.type === "export_statement" ||
    parent.children?.some((c) => c.type === "export")
  );
}

function extractCallNames(
  fnNode: Parser.SyntaxNode,
  source: string
): string[] {
  const calls = new Set<string>();

  function walk(node: Parser.SyntaxNode) {
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn?.type === "identifier") {
        calls.add(fn.text);
      } else if (fn?.type === "member_expression") {
        // foo.bar() → store "foo.bar"
        calls.add(fn.text);
      }
    }
    for (const child of node.children) walk(child);
  }

  walk(fnNode);
  return [...calls];
}

// ── TypeScript Parser ────────────────────────────────────────

export class TypeScriptParser extends JavaScriptParser {
  constructor() {
    super();
    // TypeScript uses the same tree-sitter grammar as JavaScript
    // but adds TypeScript-specific features like interfaces, implements, etc.
  }

  // Override to handle TypeScript-specific syntax
  protected extractClasses(
    root: Parser.SyntaxNode,
    filePath: string,
    source: string
  ): ClassNode[] {
    const classes = super.extractClasses(root, filePath, source);

    // Add TypeScript-specific processing here if needed
    // For now, just return the base implementation
    return classes;
  }
}
