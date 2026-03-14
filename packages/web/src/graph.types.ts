// ============================================================
// Graph types — mirror what the API returns and what Sigma needs
// ============================================================

export type NodeLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "java"
  | "unknown";

export type ComplexityLabel = "low" | "medium" | "high" | "critical";

// Raw shape from GET /api/repos/:id/graph
export interface ApiGraphNode {
  id: string;           // absolute file path, e.g. "/repo/src/app.ts"
  language: NodeLanguage;
  loc: number;
  complexity: number;   // max cyclomatic across all functions in file
  exportCount: number;
  parseErrors: number;
}

export interface ApiGraphEdge {
  source: string;       // file path
  target: string;       // file path
  kind: "static" | "dynamic" | "require" | "side-effect";
  symbols: string[];    // e.g. ["useState", "useEffect"]
}

export interface ApiGraphResponse {
  repoId: string;
  nodes: ApiGraphNode[];
  edges: ApiGraphEdge[];
}

// Sigma node attributes — extends Graphology's NodeAttributes
export interface SigmaNodeAttributes {
  // Graphology layout (set by ForceAtlas2)
  x: number;
  y: number;
  // Sigma rendering
  size: number;         // radius — mapped from LOC
  color: string;        // hex — mapped from language
  label: string;        // filename only, e.g. "app.ts"
  // Our custom data (accessible in reducers)
  fullPath: string;
  language: NodeLanguage;
  loc: number;
  complexity: number;
  exportCount: number;
  complexityLabel: ComplexityLabel;
  // Interaction state (mutated by reducers, never stored in graph)
  highlighted?: boolean;
  dimmed?: boolean;
}

export interface SigmaEdgeAttributes {
  size: number;
  color: string;
  kind: "static" | "dynamic" | "require" | "side-effect";
  symbols: string[];
  hidden?: boolean;
}

// What the NodeDetailPanel receives when a node is clicked
export interface SelectedNodeData extends ApiGraphNode {
  label: string;
  importCount: number;      // edges going OUT from this node
  importedByCount: number;  // edges coming IN to this node
}

// Toolbar filter state
export interface GraphFilters {
  languages: Set<NodeLanguage>;
  maxComplexity: number;       // 1–100, default 100
  hideExternals: boolean;
  searchQuery: string;
}

export const DEFAULT_FILTERS: GraphFilters = {
  languages: new Set(["typescript", "javascript", "python", "go", "java", "unknown"]),
  maxComplexity: 100,
  hideExternals: false,
  searchQuery: "",
};
