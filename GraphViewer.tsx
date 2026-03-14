// ============================================================
// GraphViewer.tsx  —  main export
//
// Usage:
//   <GraphViewer repoId="abc123" />
//
// Assembles:
//   SigmaContainer (WebGL renderer)
//     └── GraphEvents (event wiring)
//   NodeDetailPanel (side panel, slides in on click)
//   GraphToolbar (bottom bar: search, filters, layout toggle)
//
// CSS variables expected from the host (add to global CSS):
//   --panel-bg:     #0f1117
//   --border:       #1f2937
//   --text-primary: #f3f4f6
//   --text-muted:   #6b7280
// ============================================================

"use client";

import { useState, useCallback, useMemo } from "react";
import { SigmaContainer } from "@react-sigma/core";
import "@react-sigma/core/lib/react-sigma.min.css";

import { GraphEvents } from "./GraphEvents";
import { NodeDetailPanel } from "./panels/NodeDetailPanel";
import { GraphToolbar } from "./GraphToolbar";

import { useGraphData } from "./hooks/useGraphData";
import { useLayoutWorker } from "./hooks/index";
import { useSearchHighlight, useHoverNeighbours } from "./hooks/index";

import type {
  SigmaNodeAttributes,
  SigmaEdgeAttributes,
  GraphFilters,
  NodeLanguage,
} from "../../lib/graph.types";
import { DEFAULT_FILTERS, LANGUAGE_COLORS, COMPLEXITY_COLORS } from "../../lib/graph.utils";
import type Graph from "graphology";

// ── Sigma renderer settings ──────────────────────────────────

const SIGMA_SETTINGS = {
  // Render edges as arrows
  defaultEdgeType: "arrow",
  defaultEdgeColor: "#1f2937",
  // Node label rendering
  labelFont: '"JetBrains Mono", monospace',
  labelSize: 11,
  labelWeight: "400",
  labelColor: { color: "#9ca3af" },
  // Only show labels on hover or above a zoom threshold
  labelRenderedSizeThreshold: 8,
  // Disable built-in hover effect (we control it via reducers)
  hoverRenderer: () => {},
  // WebGL performance
  hideEdgesOnMove: true,     // massive perf boost while panning
  hideLabelsOnMove: true,
  renderEdgeLabels: false,
};

// ── Node / Edge reducers ─────────────────────────────────────
// These run on every render tick and determine the final visual
// attributes of each node/edge. Never mutate graph data here —
// only return new attribute objects.

function makeNodeReducer(selectedNode: string | null) {
  return (node: string, data: SigmaNodeAttributes): Partial<SigmaNodeAttributes> => {
    const isSelected   = node === selectedNode;
    const isHighlighted = data.highlighted;
    const isDimmed      = data.dimmed;

    if (isDimmed) {
      return { ...data, color: "#1f2937", size: data.size * 0.7, label: "" };
    }

    if (isSelected) {
      return {
        ...data,
        size: data.size * 1.5,
        color: "#ffffff",
        label: data.label,
        zIndex: 1,
      };
    }

    if (isHighlighted) {
      return { ...data, size: data.size * 1.2, zIndex: 1 };
    }

    return data;
  };
}

function makeEdgeReducer(selectedNode: string | null) {
  return (
    edge: string,
    data: SigmaEdgeAttributes,
    source: string,
    target: string
  ): Partial<SigmaEdgeAttributes> => {
    if (data.hidden) return { ...data, hidden: true };

    const isRelatedToSelected =
      selectedNode && (source === selectedNode || target === selectedNode);

    if (isRelatedToSelected) {
      return { ...data, color: "#60a5fa", size: 2, zIndex: 1 };
    }

    return data;
  };
}

// ── Main component ───────────────────────────────────────────

interface GraphViewerProps {
  repoId: string;
  height?: string;   // CSS height, default "100vh"
}

export function GraphViewer({ repoId, height = "100vh" }: GraphViewerProps) {
  const { graph, stats, state, error, reload } = useGraphData(repoId);
  const { layoutStatus } = useLayoutWorker(graph);

  const [selectedNode, setSelectedNode]   = useState<string | null>(null);
  const [filters, setFilters]             = useState<GraphFilters>(DEFAULT_FILTERS);

  // Search highlight
  useSearchHighlight(graph, filters.searchQuery);

  // Hover neighbours
  const { onEnter, onLeave } = useHoverNeighbours(graph);

  // Compute selected node's full attributes for the detail panel
  const selectedAttrs: SigmaNodeAttributes | null = useMemo(() => {
    if (!selectedNode || !graph?.hasNode(selectedNode)) return null;
    return graph.getNodeAttributes(selectedNode) as SigmaNodeAttributes;
  }, [selectedNode, graph]);

  // Reducers memoized on selectedNode (changes infrequently)
  const nodeReducer = useMemo(() => makeNodeReducer(selectedNode), [selectedNode]);
  const edgeReducer = useMemo(() => makeEdgeReducer(selectedNode), [selectedNode]);

  const handleNodeClick  = useCallback((node: string) => setSelectedNode(node), []);
  const handleStageClick = useCallback(() => setSelectedNode(null), []);

  // ── Loading / error states ───────────────────────────────
  if (state === "loading") {
    return (
      <div style={centeredStyle(height)}>
        <LoadingSpinner />
        <p style={{ color: "#6b7280", marginTop: 16, fontSize: 14 }}>
          Loading dependency graph…
        </p>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div style={centeredStyle(height)}>
        <p style={{ color: "#ef4444" }}>Failed to load graph: {error}</p>
        <button onClick={reload} style={retryButtonStyle}>Retry</button>
      </div>
    );
  }

  if (!graph) return null;

  return (
    <div style={{ position: "relative", width: "100%", height, background: "#0f1117" }}>

      {/* ── Sigma WebGL canvas ─────────────────────────────── */}
      <SigmaContainer
        graph={graph}
        settings={SIGMA_SETTINGS}
        style={{ width: "100%", height: "100%" }}
        // @ts-expect-error — react-sigma types lag behind
        nodeReducer={nodeReducer}
        edgeReducer={edgeReducer}
      >
        <GraphEvents
          graph={graph}
          onNodeClick={handleNodeClick}
          onStageClick={handleStageClick}
          onNodeEnter={onEnter}
          onNodeLeave={onLeave}
        />
      </SigmaContainer>

      {/* ── Node detail panel ──────────────────────────────── */}
      {selectedAttrs && (
        <NodeDetailPanel
          node={selectedAttrs}
          repoId={repoId}
          onClose={() => setSelectedNode(null)}
        />
      )}

      {/* ── Toolbar ────────────────────────────────────────── */}
      <GraphToolbar
        stats={stats}
        filters={filters}
        layoutStatus={layoutStatus}
        onFiltersChange={setFilters}
      />

      {/* ── Layout running indicator ───────────────────────── */}
      {layoutStatus === "running" && (
        <div style={layoutBadgeStyle}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#3b82f6", animation: "pulse 1s infinite" }} />
          Layout running…
        </div>
      )}
    </div>
  );
}

// ── GraphToolbar ─────────────────────────────────────────────

interface GraphToolbarProps {
  stats: ReturnType<typeof import("../../lib/graph.utils").computeStats> | null;
  filters: GraphFilters;
  layoutStatus: "idle" | "running" | "done";
  onFiltersChange: (f: GraphFilters) => void;
}

export function GraphToolbar({
  stats,
  filters,
  layoutStatus,
  onFiltersChange,
}: GraphToolbarProps) {
  const languages = Object.keys(LANGUAGE_COLORS) as NodeLanguage[];

  return (
    <div style={{
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      background: "#0f1117cc",
      backdropFilter: "blur(8px)",
      borderTop: "1px solid #1f2937",
      padding: "10px 16px",
      display: "flex",
      alignItems: "center",
      gap: 16,
      flexWrap: "wrap",
      fontSize: 12,
      color: "#9ca3af",
      zIndex: 5,
    }}>

      {/* Search */}
      <input
        type="text"
        placeholder="Search files…"
        value={filters.searchQuery}
        onChange={(e) => onFiltersChange({ ...filters, searchQuery: e.target.value })}
        style={{
          background: "#1f2937",
          border: "1px solid #374151",
          borderRadius: 6,
          padding: "5px 10px",
          color: "#f3f4f6",
          fontSize: 12,
          width: 180,
          outline: "none",
        }}
      />

      {/* Language filters */}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        {languages.map((lang) => {
          const active = filters.languages.has(lang);
          const color  = LANGUAGE_COLORS[lang];
          return (
            <button
              key={lang}
              onClick={() => {
                const next = new Set(filters.languages);
                active ? next.delete(lang) : next.add(lang);
                onFiltersChange({ ...filters, languages: next });
              }}
              style={{
                padding: "3px 8px",
                borderRadius: 12,
                border: `1px solid ${color}`,
                background: active ? `${color}33` : "transparent",
                color: active ? color : "#6b7280",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 500,
                transition: "all 0.15s",
              }}
            >
              {lang}
            </button>
          );
        })}
      </div>

      {/* Complexity slider */}
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span>Max CC</span>
        <input
          type="range"
          min={1}
          max={50}
          value={filters.maxComplexity}
          onChange={(e) => onFiltersChange({ ...filters, maxComplexity: Number(e.target.value) })}
          style={{ width: 80, accentColor: "#f97316" }}
        />
        <span style={{ color: "#f97316", minWidth: 24 }}>{filters.maxComplexity}</span>
      </label>

      {/* Stats */}
      {stats && (
        <div style={{ marginLeft: "auto", display: "flex", gap: 16 }}>
          <Stat label="files"  value={stats.nodeCount} />
          <Stat label="edges"  value={stats.edgeCount} />
          <Stat label="hotspots" value={stats.hotspotCount} color="#ef4444" />
        </div>
      )}
    </div>
  );
}

// ── Tiny helpers ─────────────────────────────────────────────

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <span>
      <span style={{ color: color ?? "#f3f4f6", fontWeight: 600 }}>
        {value.toLocaleString()}
      </span>{" "}
      {label}
    </span>
  );
}

function LoadingSpinner() {
  return (
    <div style={{
      width: 32, height: 32,
      border: "2px solid #1f2937",
      borderTopColor: "#3b82f6",
      borderRadius: "50%",
      animation: "spin 0.7s linear infinite",
    }} />
  );
}

function centeredStyle(height: string): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height,
    background: "#0f1117",
    color: "#f3f4f6",
  };
}

const retryButtonStyle: React.CSSProperties = {
  marginTop: 12,
  padding: "8px 16px",
  background: "transparent",
  border: "1px solid #3b82f6",
  borderRadius: 6,
  color: "#3b82f6",
  cursor: "pointer",
  fontSize: 13,
};

const layoutBadgeStyle: React.CSSProperties = {
  position: "absolute",
  top: 16,
  right: 16,
  background: "#0f1117cc",
  border: "1px solid #1f2937",
  borderRadius: 8,
  padding: "6px 10px",
  fontSize: 11,
  color: "#9ca3af",
  display: "flex",
  alignItems: "center",
  gap: 6,
};
