"use client";

// ============================================================
// ObservabilityDashboard.tsx
//
// Realtime system metrics dashboard.
// Polls GET /api/metrics every 5 seconds and renders:
//   - Key metric cards (active users, latency, errors, queue)
//   - Sparkline charts for latency and requests/min over time
//
// No Grafana. No Prometheus. Ships with the app.
// ============================================================

import { useEffect, useRef, useState, useCallback } from "react";

// ── Types (mirrors MetricSnapshot from collector.ts) ──────────

interface MetricSnapshot {
  timestamp:          number;
  activeConnections:  number;
  requestsPerMin:     number;
  avgLatencyMs:       number;
  p99LatencyMs:       number;
  jobQueueDepth:      number;
  parseErrorsPerMin:  number;
  neo4jQueryAvgMs:    number;
  reposAnalyzed:      number;
  errorsPerMin:       number;
}

// ── Metric card component ─────────────────────────────────────

function MetricCard({
  label, value, unit = "", color = "#3b82f6", trend,
}: {
  label: string;
  value: number;
  unit?: string;
  color?: string;
  trend?: "up" | "down" | "neutral";
}) {
  const trendIcon = trend === "up" ? "↑" : trend === "down" ? "↓" : "";
  const trendColor = trend === "up" ? "#ef4444" : trend === "down" ? "#10b981" : "#8b949e";

  return (
    <div style={{
      background: "#161b22",
      border: "1px solid #21262d",
      borderRadius: 8,
      padding: "14px 16px",
    }}>
      <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <span style={{ fontSize: 26, fontWeight: 600, color, fontFamily: "var(--font-mono, monospace)" }}>
          {value.toLocaleString()}
        </span>
        <span style={{ fontSize: 12, color: "#8b949e" }}>{unit}</span>
        {trendIcon && (
          <span style={{ fontSize: 12, color: trendColor, marginLeft: 4 }}>{trendIcon}</span>
        )}
      </div>
    </div>
  );
}

// ── Sparkline (canvas-based, no dependency) ───────────────────

function Sparkline({
  data, color = "#3b82f6", label, height = 60,
}: {
  data: number[];
  color?: string;
  label: string;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const max = Math.max(...data, 1);
    const min = Math.min(...data);

    ctx.clearRect(0, 0, w, h);

    // Fill area under line
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / (max - min || 1)) * (h - 8) - 4;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = color + "22";
    ctx.fill();

    // Draw line
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / (max - min || 1)) * (h - 8) - 4;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [data, color]);

  return (
    <div style={{
      background: "#161b22",
      border: "1px solid #21262d",
      borderRadius: 8,
      padding: "12px 14px",
    }}>
      <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.07em" }}>
        {label}
      </div>
      <canvas
        ref={canvasRef}
        width={280}
        height={height}
        style={{ width: "100%", height }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 10, color: "#6e7681", fontFamily: "monospace" }}>
        <span>{Math.min(...data, 0)}</span>
        <span>now: {data.at(-1) ?? 0}</span>
        <span>{Math.max(...data, 0)}</span>
      </div>
    </div>
  );
}

// ── Status indicator ──────────────────────────────────────────

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <div style={{
      width: 8, height: 8, borderRadius: "50%",
      background: ok ? "#3fb950" : "#ef4444",
      animation: ok ? "pulse 2s infinite" : "none",
    }} />
  );
}

// ── Main Dashboard ────────────────────────────────────────────

interface ObservabilityDashboardProps {
  apiBase?: string;
  pollIntervalMs?: number;
}

export function ObservabilityDashboard({
  apiBase = "",
  pollIntervalMs = 5000,
}: ObservabilityDashboardProps) {
  const [current, setCurrent]     = useState<MetricSnapshot | null>(null);
  const [history, setHistory]     = useState<MetricSnapshot[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const [snapRes, histRes] = await Promise.all([
        fetch(`${apiBase}/api/metrics`),
        fetch(`${apiBase}/api/metrics/history`),
      ]);
      if (!snapRes.ok) throw new Error("fetch failed");

      const snap = await snapRes.json() as MetricSnapshot;
      const { history: hist } = await histRes.json() as { history: MetricSnapshot[] };

      setCurrent(snap);
      setHistory(hist);
      setConnected(true);
      setLastUpdated(new Date());
    } catch {
      setConnected(false);
    }
  }, [apiBase]);

  useEffect(() => {
    fetchMetrics();
    const id = setInterval(fetchMetrics, pollIntervalMs);
    return () => clearInterval(id);
  }, [fetchMetrics, pollIntervalMs]);

  // Derived sparkline series from history
  const latencySeries = history.map(h => h.avgLatencyMs);
  const reqSeries     = history.map(h => h.requestsPerMin);
  const errorSeries   = history.map(h => h.errorsPerMin);

  const errTrend = (): "up" | "down" | "neutral" => {
    if (history.length < 2) return "neutral";
    const last = history.at(-1)!.errorsPerMin;
    const prev = history.at(-2)!.errorsPerMin;
    return last > prev ? "up" : last < prev ? "down" : "neutral";
  };

  return (
    <div style={{
      background: "#0d1117",
      color: "#e6edf3",
      fontFamily: "var(--font-sans, system-ui, sans-serif)",
      padding: 20,
      borderRadius: 12,
      minHeight: 400,
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <StatusDot ok={connected} />
        <span style={{ fontSize: 14, fontWeight: 600 }}>System Observability</span>
        {lastUpdated && (
          <span style={{ fontSize: 11, color: "#6e7681", marginLeft: "auto" }}>
            Updated {lastUpdated.toLocaleTimeString()}
          </span>
        )}
      </div>

      {!current ? (
        <div style={{ textAlign: "center", color: "#8b949e", padding: 40, fontSize: 13 }}>
          {connected ? "Loading metrics…" : "Cannot reach /api/metrics — is the API running?"}
        </div>
      ) : (
        <>
          {/* Metric cards */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 10,
            marginBottom: 16,
          }}>
            <MetricCard
              label="Active users"
              value={current.activeConnections}
              color="#3b82f6"
            />
            <MetricCard
              label="Req / min"
              value={current.requestsPerMin}
              color="#a78bfa"
            />
            <MetricCard
              label="Avg latency"
              value={current.avgLatencyMs}
              unit="ms"
              color={current.avgLatencyMs > 500 ? "#f97316" : "#10b981"}
            />
            <MetricCard
              label="p99 latency"
              value={current.p99LatencyMs}
              unit="ms"
              color={current.p99LatencyMs > 1000 ? "#ef4444" : "#f59e0b"}
            />
            <MetricCard
              label="Queue depth"
              value={current.jobQueueDepth}
              color={current.jobQueueDepth > 10 ? "#f97316" : "#8b949e"}
            />
            <MetricCard
              label="Errors / min"
              value={current.errorsPerMin}
              color={current.errorsPerMin > 0 ? "#ef4444" : "#10b981"}
              trend={errTrend()}
            />
            <MetricCard
              label="Neo4j avg"
              value={current.neo4jQueryAvgMs}
              unit="ms"
              color="#06b6d4"
            />
            <MetricCard
              label="Repos analyzed"
              value={current.reposAnalyzed}
              color="#a78bfa"
            />
          </div>

          {/* Sparklines */}
          {history.length > 1 && (
            <div style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 10,
            }}>
              <Sparkline data={latencySeries} color="#3b82f6"  label="Avg latency (ms)"    />
              <Sparkline data={reqSeries}     color="#a78bfa"  label="Requests / min"       />
              <Sparkline data={errorSeries}   color="#ef4444"  label="Errors / min"         />
            </div>
          )}
        </>
      )}

      <style>{`
        @keyframes pulse {
          0%,100%{opacity:1} 50%{opacity:.4}
        }
      `}</style>
    </div>
  );
}
