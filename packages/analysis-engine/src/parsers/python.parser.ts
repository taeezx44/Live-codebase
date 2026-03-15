// ============================================================
// python.parser.ts  —  Phase 2
//
// Extracts from Python source files:
//   imports   → import x / from x import y / from x import *
//   functions → def + async def at any nesting level
//   classes   → class Foo(Base):
//   exports   → all module-scope names (Python has no export keyword)
//
// tree-sitter-python node type reference:
//   https://github.com/tree-sitter/tree-sitter-python/blob/master/grammar.js
// ============================================================

import TSPython from "tree-sitter-python";
import type Parser from "tree-sitter";
import { BaseParser } from "./base.parser.js";
import type { ImportEdge, FunctionNode, ClassNode, Language } from "../ast.js";
import { calcCyclomaticComplexityPython } from "../complexity.js";

export class PythonParser extends BaseParser {
  readonly language: Language = "python";

  constructor() {
    super(TSPython);
  }

  // ── Imports ──────────────────────────────────────────────────
  //
  // Handles all four forms:
  //   import os
  //   import os, sys
  //   import os as operating_system
  //   from os import path
  //   from os.path import join, exists
  //   from os import *
  //   from . import utils        (relative)
  //   from ..pkg import helper   (relative)

  protected extractImports(
    root: Parser.SyntaxNode,
    filePath: string,
    _source: string
  ): ImportEdge[] {
    const imports: ImportEdge[] = [];

    this.walk(root, (node) => {
      // ── import os / import os, sys / import os as x ─────────
      if (node.type === "import_statement") {
        for (const child of node.namedChildren) {
          const nameNode =
            child.type === "aliased_import"
              ? child.childForFieldName("name")
              : child;
          const moduleName = nameNode?.text ?? child.text;
          if (!moduleName) continue;
          imports.push({
            fromFile: filePath,
            toModule: moduleName,
            kind:     "static",
            symbols:  ["*"],
            range:    this.nodeToRange(node),
          });
        }
        return false;
      }

      // ── from x import y ─────────────────────────────────────
      if (node.type === "import_from_statement") {
        // Use full text parsing as fallback since tree-sitter-python@0.21
        // has inconsistent named children for import_from_statement.
        // Pattern: "from [dots][module] import [names]"
        const fullText = node.text;
        const fromMatch = fullText.match(
          /^from\s+(\.*)([\w.]+)?\s+import\s+(.+)$/s
        );

        if (!fromMatch) {
          imports.push({
            fromFile: filePath,
            toModule: ".",
            kind:     "static",
            symbols:  ["*"],
            range:    this.nodeToRange(node),
          });
          return false;
        }

        const dots      = fromMatch[1] ?? "";
        const modName   = fromMatch[2] ?? "";
        const importPart = fromMatch[3].trim();

        let moduleName = dots + modName;

        // Parse the imported names
        let symbols: string[];
        if (importPart === "*") {
          symbols = ["*"];
        } else {
          // Remove surrounding parens if present
          const cleaned = importPart.replace(/^\(|\)$/g, "").trim();
          // Split by comma, handle "x as y" → keep y
          symbols = cleaned.split(",").map((s) => {
            const m = s.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
            if (!m) return "";
            return m[2] ?? m[1];  // alias if present, else original name
          }).filter(Boolean);
        }

        // "from . import utils" → moduleName=".", symbols=["utils"]
        // Fold: toModule=".utils", symbols=["*"]
        if (/^\.+$/.test(moduleName) && symbols.length === 1 && symbols[0] !== "*") {
          moduleName = moduleName + symbols[0];
          symbols = ["*"];
        }

        imports.push({
          fromFile: filePath,
          toModule: moduleName || ".",
          kind:     "static",
          symbols:  symbols.length ? symbols : ["*"],
          range:    this.nodeToRange(node),
        });
        return false;
      }
    });

    return imports;
  }


  protected extractExports(
    root: Parser.SyntaxNode,
    _source: string
  ): string[] {
    const names: string[] = [];

    for (const node of root.children) {
      switch (node.type) {
        case "function_definition":
        case "async_function_definition": {
          const n = node.childForFieldName("name");
          if (n) names.push(n.text);
          break;
        }
        case "class_definition": {
          const n = node.childForFieldName("name");
          if (n) names.push(n.text);
          break;
        }
        case "decorated_definition": {
          const inner = node.namedChildren.find(
            (c) =>
              c.type === "function_definition" ||
              c.type === "async_function_definition" ||
              c.type === "class_definition"
          );
          if (inner) {
            const n = inner.childForFieldName("name");
            if (n) names.push(n.text);
          }
          break;
        }
        case "expression_statement": {
          // Module-level: FOO = "bar"  /  __all__ = [...]
          const assign = node.namedChild(0);
          if (assign?.type === "assignment") {
            const left = assign.childForFieldName("left");
            if (left?.type === "identifier") names.push(left.text);
          }
          break;
        }
      }
    }

    return [...new Set(names)];
  }

  // ── Functions ────────────────────────────────────────────────
  // Captures def and async def at any nesting depth.

  protected extractFunctions(
    root: Parser.SyntaxNode,
    filePath: string,
    _source: string
  ): FunctionNode[] {
    const fns: FunctionNode[] = [];

    this.walk(root, (node) => {
      // tree-sitter-python@0.21 uses "function_definition" for both
      // sync and async. Check for leading "async" keyword child.
      const isFn = node.type === "function_definition";
      if (!isFn) return;
      const isAsync = node.text.trimStart().startsWith("async ");

      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;

      const range = this.nodeToRange(node);

      // Top-level or decorated = exported
      const parent = node.parent;
      const isExported =
        parent?.type === "module" ||
        parent?.type === "decorated_definition";

      fns.push({
        name:       nameNode.text,
        filePath,
        range,
        params:     extractPyParams(node),
        isAsync,
        isExported,
        complexity: calcCyclomaticComplexityPython(node),
        loc:        range.end.line - range.start.line + 1,
        calls:      extractPyCalls(node),
      });
    });

    return fns;
  }

  // ── Classes ──────────────────────────────────────────────────

  protected extractClasses(
    root: Parser.SyntaxNode,
    filePath: string,
    _source: string
  ): ClassNode[] {
    const classes: ClassNode[] = [];

    this.walk(root, (node) => {
      if (node.type !== "class_definition") return;

      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;

      // Superclasses from argument_list
      const superclasses: string[] = [];
      const argList = node.childForFieldName("superclasses");
      if (argList) {
        for (const child of argList.namedChildren) {
          if (child.type === "identifier" || child.type === "attribute") {
            superclasses.push(child.text);
          }
        }
      }

      const parent = node.parent;
      const isExported =
        parent?.type === "module" ||
        parent?.type === "decorated_definition";

      // Methods = functions inside the class body
      const body    = node.childForFieldName("body");
      const methods = body
        ? this.extractFunctions(body, filePath, "")
        : [];

      classes.push({
        name:       nameNode.text,
        filePath,
        range:      this.nodeToRange(node),
        superClass: superclasses[0],
        interfaces: [],
        methods,
        isExported,
      });

      return false; // extractFunctions already walked body
    });

    return classes;
  }
}

// ── Local helpers ────────────────────────────────────────────

function extractPyParams(fnNode: Parser.SyntaxNode): string[] {
  const params: string[] = [];
  const paramList = fnNode.childForFieldName("parameters");
  if (!paramList) return params;

  for (const p of paramList.namedChildren) {
    switch (p.type) {
      case "identifier":
        params.push(p.text);
        break;
      case "typed_parameter":
      case "default_parameter":
      case "typed_default_parameter": {
        const id = p.namedChild(0);
        if (id) params.push(id.text);
        break;
      }
      case "list_splat_pattern":       // *args
        params.push("*" + (p.namedChild(0)?.text ?? ""));
        break;
      case "dictionary_splat_pattern": // **kwargs
        params.push("**" + (p.namedChild(0)?.text ?? ""));
        break;
    }
  }

  // Drop self/cls — they're implementation details, not "inputs"
  return params.filter((p) => p !== "self" && p !== "cls");
}

function extractPyCalls(fnNode: Parser.SyntaxNode): string[] {
  const calls = new Set<string>();

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "call") {
      const fn = node.childForFieldName("function");
      if (fn?.type === "identifier")  calls.add(fn.text);
      if (fn?.type === "attribute")   calls.add(fn.text);
    }
    for (const child of node.children) walk(child);
  }

  walk(fnNode);
  return [...calls];
}
