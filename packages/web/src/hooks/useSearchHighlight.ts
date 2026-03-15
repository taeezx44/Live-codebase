"use client";
// ============================================================
// hooks/useSearchHighlight.ts
//
// Given a search query string, returns a Set of node keys that
// match. The graph renderer dims nodes NOT in this set.
//
// Matching strategy (priority order):
//   1. File basename contains query (case-insensitive)
//   2. Full path contains query
//   3. Empty query → all nodes match (Set is null = no filter)
// ============================================================

import { useMemo } from "react";
import type { Graph } from "graphology";

interface UseSearchHighlightResult {
  /** null means "no active filter — show everything" */
  matchedKeys: Set<string> | null;
  matchCount:  number;
}

export function useSearchHighlight(
  graph: Graph | null,
  query: string
): UseSearchHighlightResult {
  return useMemo(() => {
    const q = query.trim().toLowerCase();

    if (!q || !graph) {
      return { matchedKeys: null, matchCount: graph?.order ?? 0 };
    }

    const matched = new Set<string>();

    graph.forEachNode((key, attrs) => {
      const path     = (attrs.id ?? key) as string;
      const basename = path.split("/").at(-1)?.toLowerCase() ?? "";
      const fullPath = path.toLowerCase();

      if (basename.includes(q) || fullPath.includes(q)) {
        matched.add(key);
      }
    });

    return { matchedKeys: matched, matchCount: matched.size };
  }, [graph, query]);
}
