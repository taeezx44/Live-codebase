"use client";
// ============================================================
// hooks/useLayoutWorker.ts
//
// Manages the ForceAtlas2 Web Worker lifecycle.
// Spawns on mount, posts graph data, receives positioned nodes,
// terminates on unmount. Keeps layout computation off the main
// thread so pan/zoom never drops a frame.
// ============================================================

import { useEffect, useRef, useCallback } from "react";
import type { Graph } from "graphology";

interface LayoutNode {
  key:  string;
  x:    number;
  y:    number;
}

interface UseLayoutWorkerOptions {
  /** Called with updated positions after layout converges */
  onPositions?: (positions: LayoutNode[]) => void;
  iterations?: number;
}

export function useLayoutWorker(
  graph: Graph | null,
  options: UseLayoutWorkerOptions = {}
): { isRunning: boolean; cancel: () => void } {
  const workerRef  = useRef<Worker | null>(null);
  const isRunning  = useRef(false);

  const cancel = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    isRunning.current = false;
  }, []);

  useEffect(() => {
    if (!graph || graph.order === 0) return;

    // Terminate any existing worker before spawning a new one
    cancel();

    const worker = new Worker(
      new URL("../workers/fa2.worker.ts", import.meta.url),
      { type: "module" }
    );
    workerRef.current = worker;
    isRunning.current = true;

    // Serialize graph data for the worker
    const nodes: Array<{ key: string; x: number; y: number }> = [];
    const edges: Array<{ source: string; target: string }> = [];

    graph.forEachNode((key, attrs) => {
      nodes.push({ key, x: attrs.x ?? 0, y: attrs.y ?? 0 });
    });
    graph.forEachEdge((_edge, _attrs, source, target) => {
      edges.push({ source, target });
    });

    worker.postMessage({
      type:       "run",
      nodes,
      edges,
      iterations: options.iterations ?? 150,
    });

    worker.onmessage = (e) => {
      if (e.data.type === "positions") {
        isRunning.current = false;
        options.onPositions?.(e.data.positions as LayoutNode[]);
      }
    };

    worker.onerror = () => {
      isRunning.current = false;
    };

    return () => {
      cancel();
    };
  }, [graph, cancel, options.iterations]);

  return { isRunning: isRunning.current, cancel };
}
