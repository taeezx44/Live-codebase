"use client";
// ============================================================
// components/GraphEmptyState.tsx
//
// Shown when the analysis finished successfully but found
// 0 source files (e.g. a docs-only repo, wrong URL, etc.)
// ============================================================

import React from "react";

interface GraphEmptyStateProps {
  repoUrl?: string;
  height?: string;
  onReanalyze?: () => void;
}

export function GraphEmptyState({
  repoUrl,
  height = "100vh",
  onReanalyze,
}: GraphEmptyStateProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height,
        background: "#0f1117",
        color: "#9ca3af",
        textAlign: "center",
        padding: "0 32px",
        gap: 16,
      }}
    >
      {/* Icon */}
      <svg
        width="64"
        height="64"
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ opacity: 0.4 }}
      >
        <circle cx="32" cy="32" r="30" stroke="#374151" strokeWidth="2" />
        <circle cx="32" cy="22" r="5" fill="#374151" />
        <circle cx="18" cy="40" r="5" fill="#374151" />
        <circle cx="46" cy="40" r="5" fill="#374151" />
        {/* No edges — intentionally empty graph */}
      </svg>

      <h2 style={{ fontSize: 18, color: "#d1d5db", margin: 0 }}>
        No source files found
      </h2>

      <p style={{ fontSize: 13, maxWidth: 400, lineHeight: 1.6, margin: 0 }}>
        CodeVis couldn&apos;t find any supported source files in this repository.
        <br />
        Supported: <code>.ts</code>, <code>.tsx</code>, <code>.js</code>,{" "}
        <code>.jsx</code>, <code>.py</code>, <code>.go</code>
      </p>

      {repoUrl && (
        <p style={{ fontSize: 12, color: "#6b7280", margin: 0 }}>
          Repository:{" "}
          <a
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#3b82f6" }}
          >
            {repoUrl}
          </a>
        </p>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        {onReanalyze && (
          <button onClick={onReanalyze} style={primaryButtonStyle}>
            Re-analyse
          </button>
        )}
        <a
          href="https://github.com/taeezx44/Live-codebase#supported-languages"
          target="_blank"
          rel="noopener noreferrer"
          style={secondaryButtonStyle}
        >
          Supported languages ↗
        </a>
      </div>
    </div>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  padding: "8px 18px",
  background: "#1d4ed8",
  border: "none",
  borderRadius: 6,
  color: "#fff",
  fontSize: 13,
  cursor: "pointer",
  fontWeight: 500,
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "8px 18px",
  background: "transparent",
  border: "1px solid #374151",
  borderRadius: 6,
  color: "#9ca3af",
  fontSize: 13,
  cursor: "pointer",
  textDecoration: "none",
};
