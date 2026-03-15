"use client";
// ============================================================
// hooks/useHoverNeighbours.ts
//
// When the user hovers a node:
//   - that node + all direct neighbours stay at full opacity
//   - every other node is "dimmed" (grey, smaller)
//   - edges connected to the hovered node are highlighted blue
//   - all other edges are hidden
//
// Returns { onEnter, onLeave } callbacks to pass to GraphEvents.
// ============================================================

import { useCallback } from "react";
import type Graph from "graphology";

export function useHoverNeighbours(graph: Graph | null) {
  const onEnter = useCallback(
    (node: string) => {
      if (!graph) return;

      // Collect the hovered node + its direct neighbours
      const neighbours = new Set<string>(graph.neighbors(node));
      neighbours.add(node);

      graph.forEachNode((n) => {
        graph.setNodeAttribute(n, "highlighted", neighbours.has(n));
        graph.setNodeAttribute(n, "dimmed",       !neighbours.has(n));
      });

      // Highlight connected edges, hide the rest
      graph.forEachEdge((edge, _attrs, source, target) => {
        const connected = source === node || target === node;
        graph.setEdgeAttribute(edge, "hidden",   !connected);
        graph.setEdgeAttribute(edge, "color",    connected ? "#60a5fa" : undefined);
        graph.setEdgeAttribute(edge, "size",     connected ? 2 : 1);
      });
    },
    [graph]
  );

  const onLeave = useCallback(
    (_node: string) => {
      if (!graph) return;

      // Reset all nodes
      graph.forEachNode((n) => {
        graph.setNodeAttribute(n, "highlighted", false);
        graph.setNodeAttribute(n, "dimmed",       false);
      });

      // Reset all edges
      graph.forEachEdge((edge) => {
        graph.setEdgeAttribute(edge, "hidden", false);
        graph.setEdgeAttribute(edge, "color",  undefined);
        graph.setEdgeAttribute(edge, "size",   1);
      });
    },
    [graph]
  );

  return { onEnter, onLeave };
}
