// ============================================================
// hooks/useGraphData.ts
//
// Fetches graph data from the API and builds the Graphology
// graph object. Handles loading / error states cleanly.
// ============================================================

import { useState, useEffect, useCallback } from "react";
import Graph from "graphology";
import type { SigmaNodeAttributes, SigmaEdgeAttributes } from "../../lib/graph.types";
import { buildGraph, type GraphStats, computeStats } from "../../lib/graph.utils";

type FetchState = "idle" | "loading" | "success" | "error";

export function useGraphData(repoId: string | null) {
  const [graph, setGraph]   = useState<Graph<SigmaNodeAttributes, SigmaEdgeAttributes> | null>(null);
  const [stats, setStats]   = useState<GraphStats | null>(null);
  const [state, setState]   = useState<FetchState>("idle");
  const [error, setError]   = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!repoId) return;
    setState("loading");
    setError(null);

    try {
      const res = await fetch(`/api/repos/${repoId}/graph`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const g = buildGraph(data);

      setGraph(g);
      setStats(computeStats(g));
      setState("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setState("error");
    }
  }, [repoId]);

  useEffect(() => { load(); }, [load]);

  return { graph, stats, state, error, reload: load };
}
