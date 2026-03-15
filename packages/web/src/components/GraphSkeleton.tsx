"use client";
// ============================================================
// components/GraphSkeleton.tsx
//
// Shown while graph data is loading. Renders animated placeholder
// nodes and edges on a dark canvas so the layout doesn't jump.
// ============================================================

import React, { useEffect, useRef } from "react";

interface GraphSkeletonProps {
  height?: string;
}

export function GraphSkeleton({ height = "100vh" }: GraphSkeletonProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef   = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx    = canvas.getContext("2d")!;
    let tick = 0;

    // Fixed fake nodes for a consistent skeleton feel
    const fakeNodes = [
      { x: 0.50, y: 0.40, r: 14 },
      { x: 0.30, y: 0.55, r: 10 },
      { x: 0.68, y: 0.58, r: 12 },
      { x: 0.22, y: 0.38, r:  8 },
      { x: 0.75, y: 0.38, r:  9 },
      { x: 0.40, y: 0.68, r:  7 },
      { x: 0.60, y: 0.72, r:  8 },
      { x: 0.15, y: 0.62, r:  6 },
      { x: 0.84, y: 0.55, r:  7 },
    ];

    const fakeEdges = [
      [0, 1], [0, 2], [0, 3], [1, 3], [2, 4],
      [0, 5], [2, 6], [1, 7], [4, 8],
    ];

    function draw() {
      const W = canvas!.width;
      const H = canvas!.height;

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#0f1117";
      ctx.fillRect(0, 0, W, H);

      tick++;
      // Shimmer phase cycles every 120 frames
      const phase = (tick % 120) / 120;

      // Edges
      fakeEdges.forEach(([a, b]) => {
        const na = fakeNodes[a], nb = fakeNodes[b];
        ctx.beginPath();
        ctx.moveTo(na.x * W, na.y * H);
        ctx.lineTo(nb.x * W, nb.y * H);
        ctx.strokeStyle = "#1f2937";
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      // Nodes with shimmer
      fakeNodes.forEach((n, i) => {
        const shimmerAlpha = 0.08 + 0.12 * Math.abs(Math.sin(phase * Math.PI * 2 + i * 0.7));
        ctx.beginPath();
        ctx.arc(n.x * W, n.y * H, n.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(55, 65, 81, ${shimmerAlpha + 0.15})`;
        ctx.fill();
        // Inner shimmer ring
        ctx.beginPath();
        ctx.arc(n.x * W, n.y * H, n.r * 0.6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(75, 85, 99, ${shimmerAlpha})`;
        ctx.fill();
      });

      // "Loading" label skeleton bars
      fakeNodes.forEach((n) => {
        const bw = (n.r * 3 + 10) * (0.7 + 0.3 * Math.sin(tick * 0.02));
        ctx.fillStyle = "#1f2937";
        ctx.fillRect(n.x * W - bw / 2, n.y * H + n.r + 5, bw, 4);
      });

      animRef.current = requestAnimationFrame(draw);
    }

    function resize() {
      if (!canvas) return;
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    }

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    animRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animRef.current);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height,
        background: "#0f1117",
        overflow: "hidden",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
      {/* Loading label */}
      <div
        style={{
          position: "absolute",
          bottom: 60,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          color: "#4b5563",
          fontSize: 13,
        }}
      >
        <Spinner />
        Analysing repository…
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div
      style={{
        width: 16,
        height: 16,
        border: "2px solid #1f2937",
        borderTopColor: "#3b82f6",
        borderRadius: "50%",
        animation: "spin 0.8s linear infinite",
      }}
    />
  );
}
