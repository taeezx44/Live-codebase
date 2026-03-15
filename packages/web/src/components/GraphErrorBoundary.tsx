"use client";
// ============================================================
// components/GraphErrorBoundary.tsx
//
// React class error boundary that catches runtime errors in
// the graph rendering tree and shows a friendly error card
// with a retry button that remounts the subtree.
// ============================================================

import React, { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Optional fallback UI override */
  fallback?: (error: Error, retry: () => void) => ReactNode;
  height?: string;
}

interface State {
  error: Error | null;
  errorInfo: string;
}

export class GraphErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, errorInfo: "" };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ errorInfo: info.componentStack ?? "" });
    // Log to console in dev — hook up to Sentry/etc. in prod
    console.error("[GraphErrorBoundary]", error, info);
  }

  retry = () => {
    this.setState({ error: null, errorInfo: "" });
  };

  render() {
    const { error } = this.state;
    const { children, fallback, height = "100vh" } = this.props;

    if (error) {
      if (fallback) return fallback(error, this.retry);
      return <DefaultErrorCard error={error} retry={this.retry} height={height} />;
    }

    return children;
  }
}

// ── Default error UI ─────────────────────────────────────────

interface DefaultErrorCardProps {
  error: Error;
  retry: () => void;
  height: string;
}

function DefaultErrorCard({ error, retry, height }: DefaultErrorCardProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height,
        background: "#0f1117",
        color: "#f3f4f6",
        padding: "0 32px",
        textAlign: "center",
        gap: 16,
      }}
    >
      {/* Icon */}
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: "50%",
          background: "#7f1d1d33",
          border: "1px solid #7f1d1d",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 24,
        }}
      >
        ⚠
      </div>

      <h2 style={{ fontSize: 17, color: "#fca5a5", margin: 0 }}>
        Something went wrong
      </h2>

      <p
        style={{
          fontSize: 12,
          color: "#9ca3af",
          maxWidth: 420,
          lineHeight: 1.6,
          margin: 0,
        }}
      >
        The graph renderer encountered an unexpected error. This is usually
        caused by a temporary issue — retrying often fixes it.
      </p>

      {/* Error detail (collapsible in production) */}
      <details
        style={{
          fontSize: 11,
          color: "#6b7280",
          background: "#111827",
          border: "1px solid #1f2937",
          borderRadius: 6,
          padding: "8px 12px",
          maxWidth: 480,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <summary style={{ cursor: "pointer", marginBottom: 6 }}>
          Error details
        </summary>
        <code style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>
          {error.message}
        </code>
      </details>

      <button onClick={retry} style={retryStyle}>
        ↺ Retry
      </button>
    </div>
  );
}

const retryStyle: React.CSSProperties = {
  padding: "9px 22px",
  background: "transparent",
  border: "1px solid #3b82f6",
  borderRadius: 6,
  color: "#3b82f6",
  fontSize: 13,
  cursor: "pointer",
  fontWeight: 500,
  letterSpacing: "0.01em",
};
