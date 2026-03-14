// ============================================================
// NodeDetailPanel.tsx
//
// Slides in from the right when a node is clicked.
// Shows file metadata, imports, exports, and an impact
// analysis section (lazy-fetched from /api/repos/:id/impact).
// ============================================================

"use client";

import { useEffect, useState } from "react";
import type { SigmaNodeAttributes } from "../../lib/graph.types";
import { LANGUAGE_COLORS, COMPLEXITY_COLORS } from "../../lib/graph.utils";

interface ImpactData {
  affectedFiles: string[];
  depth: number;
}

interface NodeDetailPanelProps {
  node: SigmaNodeAttributes | null;
  repoId: string;
  onClose: () => void;
}

export function NodeDetailPanel({ node, repoId, onClose }: NodeDetailPanelProps) {
  const [impact, setImpact] = useState<ImpactData | null>(null);
  const [loadingImpact, setLoadingImpact] = useState(false);

  // Fetch impact analysis when node changes
  useEffect(() => {
    if (!node) { setImpact(null); return; }
    setLoadingImpact(true);
    setImpact(null);

    fetch(`/api/repos/${repoId}/impact?path=${encodeURIComponent(node.fullPath)}`)
      .then((r) => r.json())
      .then((data) => setImpact(data))
      .catch(() => setImpact(null))
      .finally(() => setLoadingImpact(false));
  }, [node, repoId]);

  if (!node) return null;

  const langColor  = LANGUAGE_COLORS[node.language] ?? "#6b7280";
  const ccColor    = COMPLEXITY_COLORS[node.complexityLabel];
  const filename   = node.label;
  const dirPath    = node.fullPath.slice(0, node.fullPath.lastIndexOf("/"));

  return (
    <aside
      className="node-panel"
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 300,
        background: "var(--panel-bg)",
        borderLeft: "1px solid var(--border)",
        overflowY: "auto",
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        fontFamily: "var(--font-mono), monospace",
        fontSize: 13,
        color: "var(--text-primary)",
      }}
    >
      {/* ── Header ─────────────────────────────────────── */}
      <div style={{
        padding: "16px 16px 12px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 8,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 15,
            fontWeight: 600,
            color: langColor,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {filename}
          </div>
          <div style={{
            fontSize: 11,
            color: "var(--text-muted)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {dirPath}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-muted)",
            fontSize: 18,
            lineHeight: 1,
            padding: "0 4px",
            flexShrink: 0,
          }}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {/* ── Metrics row ────────────────────────────────── */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 1,
        background: "var(--border)",
        borderBottom: "1px solid var(--border)",
      }}>
        {[
          { label: "LOC",        value: node.loc.toLocaleString() },
          { label: "Complexity", value: node.complexity, color: ccColor },
          { label: "Language",   value: node.language },
          { label: "Exports",    value: node.exportCount },
        ].map(({ label, value, color }) => (
          <div key={label} style={{
            background: "var(--panel-bg)",
            padding: "10px 12px",
          }}>
            <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {label}
            </div>
            <div style={{
              fontSize: 14,
              fontWeight: 500,
              marginTop: 2,
              color: color ?? "var(--text-primary)",
            }}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* ── Complexity badge ───────────────────────────── */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
        <ComplexityBar label={node.complexityLabel} value={node.complexity} />
      </div>

      {/* ── Impact analysis ────────────────────────────── */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
        <SectionLabel>Impact analysis</SectionLabel>
        {loadingImpact && (
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 6 }}>
            Calculating…
          </div>
        )}
        {impact && !loadingImpact && (
          <>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
              Changing this file could affect{" "}
              <span style={{ color: "#f97316", fontWeight: 600 }}>
                {impact.affectedFiles.length}
              </span>{" "}
              other files (up to {impact.depth} hops)
            </div>
            {impact.affectedFiles.slice(0, 6).map((f) => (
              <div key={f} style={{
                fontSize: 11,
                color: "var(--text-muted)",
                marginTop: 3,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {f.split("/").at(-1)}
              </div>
            ))}
            {impact.affectedFiles.length > 6 && (
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                + {impact.affectedFiles.length - 6} more…
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Open in editor button ──────────────────────── */}
      <div style={{ padding: "12px 16px", marginTop: "auto" }}>
        <button
          onClick={() => {
            // vscode://file/<path> opens VS Code directly
            window.open(`vscode://file${node.fullPath}`, "_self");
          }}
          style={{
            width: "100%",
            padding: "8px 12px",
            background: "transparent",
            border: `1px solid ${langColor}`,
            borderRadius: 6,
            color: langColor,
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 500,
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = `${langColor}22`;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          }}
        >
          Open in VS Code
        </button>
      </div>
    </aside>
  );
}

// ── Sub-components ───────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10,
      fontWeight: 600,
      color: "var(--text-muted)",
      textTransform: "uppercase",
      letterSpacing: "0.1em",
      marginBottom: 6,
    }}>
      {children}
    </div>
  );
}

function ComplexityBar({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  const maxCC = 30;
  const pct = Math.min(100, (value / maxCC) * 100);
  const color = COMPLEXITY_COLORS[label as keyof typeof COMPLEXITY_COLORS] ?? "#6b7280";

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Cyclomatic complexity</span>
        <span style={{ fontSize: 11, color, fontWeight: 600 }}>
          {value} — {label}
        </span>
      </div>
      <div style={{
        height: 4,
        background: "var(--border)",
        borderRadius: 2,
        overflow: "hidden",
      }}>
        <div style={{
          height: "100%",
          width: `${pct}%`,
          background: color,
          borderRadius: 2,
          transition: "width 0.4s ease",
        }} />
      </div>
    </div>
  );
}
