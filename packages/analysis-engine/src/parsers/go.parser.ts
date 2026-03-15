// ============================================================
// go.parser.ts  —  Phase 2
//
// Extracts from Go source files:
//   imports   → import "pkg" / import ( ... ) / aliased / blank
//   functions → func Name(...) / func (Recv T) Name(...)
//   types     → type Foo struct {} / type Bar interface {}
//   exports   → Go convention: uppercase first letter = exported
//
// tree-sitter-go node type reference:
//   https://github.com/tree-sitter/tree-sitter-go/blob/master/grammar.js
// ============================================================

import TSGo from "tree-sitter-go";
import type Parser from "tree-sitter";
import { BaseParser } from "./base.parser.js";
import type { ImportEdge, FunctionNode, ClassNode, Language } from "../ast.js";
import { calcCyclomaticComplexityGo } from "../complexity.js";

export class GoParser extends BaseParser {
  readonly language: Language = "go";

  constructor() {
    super(TSGo);
  }

  // ── Imports ──────────────────────────────────────────────────
  //
  // All Go import forms:
  //   import "fmt"
  //   import alias "fmt"
  //   import _ "pkg"             (blank / side-effect)
  //   import (                   (grouped)
  //     "fmt"
  //     alias "os"
  //     _ "net/http/pprof"
  //   )

  protected extractImports(
    root: Parser.SyntaxNode,
    filePath: string,
    _source: string
  ): ImportEdge[] {
    const imports: ImportEdge[] = [];

    this.walk(root, (node) => {
      if (node.type !== "import_declaration") return;

      // Walk inside to find individual import_spec nodes
      this.walk(node, (child) => {
        if (child.type !== "import_spec") return;

        const pathNode = child.childForFieldName("path");
        if (!pathNode) return;

        // Strip surrounding quotes: "fmt" → fmt
        const rawPath = pathNode.text.replace(/^["` ]|["` ]$/g, "");

        const nameNode = child.childForFieldName("name");
        const alias    = nameNode?.text ?? null;

        const kind: ImportEdge["kind"] =
          alias === "_" ? "side-effect" : "static";

        // dot import means all exported names are in scope: similar to *
        const symbols =
          alias === "." ? ["*"] : alias ? [alias] : ["*"];

        imports.push({
          fromFile: filePath,
          toModule: rawPath,
          kind,
          symbols,
          range: this.nodeToRange(child),
        });
      });

      return false; // don't double-walk
    });

    return imports;
  }

  // ── Exports ──────────────────────────────────────────────────
  // Go: uppercase first letter = exported identifier.
  // We collect top-level func, type, var, const declarations.

  protected extractExports(
    root: Parser.SyntaxNode,
    _source: string
  ): string[] {
    const names: string[] = [];

    for (const node of root.children) {
      switch (node.type) {
        case "function_declaration": {
          const n = node.childForFieldName("name");
          if (n && goIsExported(n.text)) names.push(n.text);
          break;
        }
        case "type_declaration": {
          this.walk(node, (spec) => {
            if (spec.type === "type_spec") {
              const n = spec.childForFieldName("name");
              if (n && goIsExported(n.text)) names.push(n.text);
            }
          });
          break;
        }
        case "var_declaration":
        case "const_declaration": {
          this.walk(node, (spec) => {
            if (spec.type === "var_spec" || spec.type === "const_spec") {
              // name field may be a single identifier or an identifier_list
              const nameField = spec.childForFieldName("name");
              if (nameField) {
                for (const id of nameField.type === "identifier_list"
                  ? nameField.namedChildren
                  : [nameField]) {
                  if (goIsExported(id.text)) names.push(id.text);
                }
              }
            }
          });
          break;
        }
      }
    }

    return [...new Set(names)];
  }

  // ── Functions ────────────────────────────────────────────────
  // Captures both top-level functions and methods (with receiver).

  protected extractFunctions(
    root: Parser.SyntaxNode,
    filePath: string,
    _source: string
  ): FunctionNode[] {
    const fns: FunctionNode[] = [];

    this.walk(root, (node) => {
      const isFn     = node.type === "function_declaration";
      const isMethod = node.type === "method_declaration";
      if (!isFn && !isMethod) return;

      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;

      const baseName = nameNode.text;
      const range    = this.nodeToRange(node);

      // For methods, prepend receiver type for clarity in the graph
      let displayName = baseName;
      if (isMethod) {
        const recv = node.childForFieldName("receiver");
        if (recv) {
          const paramDecl = recv.namedChildren.find(
            (c) => c.type === "parameter_declaration"
          );
          const typeChild = paramDecl?.namedChildren.find(
            (c) => c.type !== "identifier"
          );
          if (typeChild) displayName = `(${typeChild.text}).${baseName}`;
        }
      }

      fns.push({
        name:       displayName,
        filePath,
        range,
        params:     extractGoParams(node),
        isAsync:    false, // Go has goroutines but no async keyword
        isExported: goIsExported(baseName),
        complexity: calcCyclomaticComplexityGo(node),
        loc:        range.end.line - range.start.line + 1,
        calls:      extractGoCalls(node),
      });
    });

    return fns;
  }

  // ── Classes (struct + interface types) ───────────────────────
  // Go has no class keyword. Structs with associated methods are
  // the idiomatic equivalent. We map type declarations → ClassNode
  // so the dependency graph can show type relationships.

  protected extractClasses(
    root: Parser.SyntaxNode,
    filePath: string,
    _source: string
  ): ClassNode[] {
    const types: ClassNode[] = [];

    this.walk(root, (node) => {
      if (node.type !== "type_declaration") return;

      this.walk(node, (spec) => {
        if (spec.type !== "type_spec") return;

        const nameNode = spec.childForFieldName("name");
        const typeNode = spec.childForFieldName("type");
        if (!nameNode || !typeNode) return;

        if (
          typeNode.type !== "struct_type" &&
          typeNode.type !== "interface_type"
        ) return;

        types.push({
          name:       nameNode.text,
          filePath,
          range:      this.nodeToRange(spec),
          superClass: undefined,   // Go has no inheritance
          interfaces: [],
          methods:    [],          // methods live on function_declaration nodes
          isExported: goIsExported(nameNode.text),
        });

        return false;
      });
    });

    return types;
  }
}

// ── Local helpers ────────────────────────────────────────────

/** Go convention: exported iff first character is uppercase ASCII letter */
function goIsExported(name: string): boolean {
  return name.length > 0 && /^[A-Z]/.test(name);
}

function extractGoParams(fnNode: Parser.SyntaxNode): string[] {
  const params: string[] = [];
  const paramList = fnNode.childForFieldName("parameters");
  if (!paramList) return params;

  for (const child of paramList.namedChildren) {
    if (
      child.type === "parameter_declaration" ||
      child.type === "variadic_parameter_declaration"
    ) {
      // parameter_declaration: [name...] type
      // identifiers before the type are the param names
      const identifiers = child.namedChildren.filter(
        (c) => c.type === "identifier"
      );
      identifiers.forEach((id) => params.push(id.text));
    }
  }

  return params;
}

function extractGoCalls(fnNode: Parser.SyntaxNode): string[] {
  const calls = new Set<string>();

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn?.type === "identifier")          calls.add(fn.text);
      else if (fn?.type === "selector_expression") calls.add(fn.text);
    }
    for (const child of node.children) walk(child);
  }

  walk(fnNode);
  return [...calls];
}
