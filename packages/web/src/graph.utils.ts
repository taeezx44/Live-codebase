// ============================================================
// Graph transform utilities
//
// Converts raw API data into a Graphology MultiDirectedGraph
// that Sigma can render.
//
// Key design decisions:
//   - Node SIZE   = sqrt(loc) * 1.5   (large files = big nodes)
//   - Node COLOR  = language palette  (constant, not complexity)
//   - Edge SIZE   = 1 for static, 0.5 for others
//   - Initial positions = random in [-1, 1] circle
//     (ForceAtlas2 worker overwrites these in ~200ms)
// ============================================================

import Graph from "graphology";
import type {
  ApiGraphResponse,
  SigmaNodeAttributes,
  SigmaEdgeAttributes,
  NodeLanguage,
  ComplexityLabel,
} from "./graph.types";

// ── Language color palette ───────────────────────────────────
// Dark-mode-safe: all are vivid enough to read on #0f1117

export const LANGUAGE_COLORS: Record<NodeLanguage, string> = {
  typescript:  "#3b82f6",   // blue-500
  javascript:  "#f59e0b",   // amber-500
  python:      "#10b981",   // emerald-500
  go:          "#06b6d4",   // cyan-500
  java:        "#f97316",   // orange-500
  unknown:     "#6b7280",   // gray-500
};

export const COMPLEXITY_COLORS: Record<ComplexityLabel, string> = {
  low:      "#10b981",
  medium:   "#f59e0b",
  high:     "#f97316",
  critical: "#ef4444",
};

// ── Helpers ──────────────────────────────────────────────────

function nodeSize(loc: number): number {
  // sqrt scale: 1 LOC → 3px, 100 LOC → 15px, 10000 LOC → ~90px
  // Clamp to [3, 32] so tiny/huge files don't destroy the layout
  return Math.min(32, Math.max(3, Math.sqrt(loc) * 1.5));
}

function complexityLabel(cc: number): ComplexityLabel {
  if (cc <= 5)  return "low";
  if (cc <= 10) return "medium";
  if (cc <= 20) return "high";
  return "critical";
}

function shortLabel(fullPath: string): string {
  // "/repo/src/components/Button.tsx" → "Button.tsx"
  return fullPath.split("/").at(-1) ?? fullPath;
}

// Random position inside unit circle — FA2 replaces this quickly
function randomPos(): { x: number; y: number } {
  const angle = Math.random() * Math.PI * 2;
  const r = Math.random();
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
}

// ── Main transform ───────────────────────────────────────────

export function buildGraph(data: ApiGraphResponse): Graph<SigmaNodeAttributes, SigmaEdgeAttributes> {
  const graph = new Graph<SigmaNodeAttributes, SigmaEdgeAttributes>({
    type: "directed",
    multi: false,         // collapse parallel edges
    allowSelfLoops: false,
  });

  // Add nodes
  for (const n of data.nodes) {
    const pos = randomPos();
    graph.addNode(n.id, {
      x: pos.x,
      y: pos.y,
      size: nodeSize(n.loc),
      color: LANGUAGE_COLORS[n.language] ?? LANGUAGE_COLORS.unknown,
      label: shortLabel(n.id),
      fullPath: n.id,
      language: n.language,
      loc: n.loc,
      complexity: n.complexity,
      exportCount: n.exportCount,
      complexityLabel: complexityLabel(n.complexity),
    });
  }

  // Add edges — skip if either endpoint is missing (external dep)
  for (const e of data.edges) {
    if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
    if (graph.hasEdge(e.source, e.target)) continue; // dedup

    graph.addEdge(e.source, e.target, {
      size:    e.kind === "static" ? 1.2 : 0.6,
      color:   e.kind === "side-effect" ? "#374151" : "#4b5563",
      kind:    e.kind,
      symbols: e.symbols,
    });
  }

  return graph;
}

// ── Graph statistics (shown in toolbar) ─────────────────────

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  languageBreakdown: Partial<Record<NodeLanguage, number>>;
  avgComplexity: number;
  hotspotCount: number; // nodes with complexity "critical"
}

export function computeStats(graph: Graph<SigmaNodeAttributes>): GraphStats {
  const breakdown: Partial<Record<NodeLanguage, number>> = {};
  let totalComplexity = 0;
  let hotspotCount = 0;

  graph.forEachNode((_, attrs) => {
    breakdown[attrs.language] = (breakdown[attrs.language] ?? 0) + 1;
    totalComplexity += attrs.complexity;
    if (attrs.complexityLabel === "critical") hotspotCount++;
  });

  return {
    nodeCount: graph.order,
    edgeCount: graph.size,
    languageBreakdown: breakdown,
    avgComplexity: graph.order > 0 ? totalComplexity / graph.order : 0,
    hotspotCount,
  };
}
