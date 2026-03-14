// ============================================================
// Cyclomatic Complexity Calculator
//
// Formula: CC = 1 + (number of branching nodes)
//
// Branching nodes we count:
//   if, else_if, ternary (?:), switch case, for, while,
//   do..while, catch, logical && / ||, nullish ??
//
// References:
//   McCabe 1976 — "A Complexity Measure"
//   Anything above 10 = high risk
//   Anything above 20 = refactor immediately
// ============================================================

import type Parser from "tree-sitter";

const BRANCH_NODE_TYPES = new Set([
  "if_statement",
  "else_clause",
  "ternary_expression",
  "switch_case",            // each case adds a path
  "for_statement",
  "for_in_statement",
  "for_of_statement",
  "while_statement",
  "do_statement",
  "catch_clause",
  "&&",                     // logical AND creates branch
  "||",                     // logical OR creates branch
  "??",                     // nullish coalescing
]);

export function calcCyclomaticComplexity(fnNode: Parser.SyntaxNode): number {
  let complexity = 1; // base complexity

  function walk(node: Parser.SyntaxNode): void {
    if (BRANCH_NODE_TYPES.has(node.type)) {
      complexity++;
    }
    // Also count individual binary_expression operators
    if (node.type === "binary_expression") {
      const op = node.children.find((c) => c.type === "&&" || c.type === "||" || c.type === "??");
      if (op) complexity++;
    }
    for (const child of node.children) walk(child);
  }

  walk(fnNode);
  return complexity;
}

export function complexityLabel(cc: number): "low" | "medium" | "high" | "critical" {
  if (cc <= 5)  return "low";
  if (cc <= 10) return "medium";
  if (cc <= 20) return "high";
  return "critical";
}
