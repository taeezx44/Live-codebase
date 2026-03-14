// ============================================================
// GraphEvents.tsx
//
// Registers Sigma event listeners inside SigmaContainer.
// Must be rendered as a *child* of SigmaContainer so it can
// call useSigma() to access the Sigma instance.
//
// Events handled:
//   enterNode  → hover neighbours highlight
//   leaveNode  → clear highlight
//   clickNode  → select node (opens detail panel)
//   doubleClickNode → zoom to node
//   clickStage → deselect
// ============================================================

import { useEffect } from "react";
import { useSigma } from "@react-sigma/core";
import type Graph from "graphology";
import type { SigmaNodeAttributes, SigmaEdgeAttributes } from "../../lib/graph.types";

interface GraphEventsProps {
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>;
  onNodeClick: (nodeId: string) => void;
  onStageClick: () => void;
  onNodeEnter: (nodeId: string) => void;
  onNodeLeave: () => void;
}

export function GraphEvents({
  graph,
  onNodeClick,
  onStageClick,
  onNodeEnter,
  onNodeLeave,
}: GraphEventsProps) {
  const sigma = useSigma();

  useEffect(() => {
    // ── enterNode ─────────────────────────────────────────
    const handleEnter = ({ node }: { node: string }) => {
      onNodeEnter(node);
      sigma.getGraph().setNodeAttribute(node, "highlighted", true);
      // Change cursor so user knows it's clickable
      sigma.getContainer().style.cursor = "pointer";
    };

    // ── leaveNode ─────────────────────────────────────────
    const handleLeave = () => {
      onNodeLeave();
      sigma.getContainer().style.cursor = "default";
    };

    // ── clickNode ─────────────────────────────────────────
    const handleClick = ({ node }: { node: string }) => {
      onNodeClick(node);
    };

    // ── doubleClickNode → zoom to node ────────────────────
    const handleDoubleClick = ({ node }: { node: string }) => {
      const nodePosition = sigma.getNodeDisplayedCoordinates(node);
      sigma.getCamera().animate(
        { x: nodePosition.x, y: nodePosition.y, ratio: 0.1 },
        { duration: 400, easing: "cubicInOut" }
      );
    };

    // ── clickStage → deselect all ─────────────────────────
    const handleStageClick = () => {
      onStageClick();
      onNodeLeave();
    };

    sigma.on("enterNode", handleEnter);
    sigma.on("leaveNode", handleLeave);
    sigma.on("clickNode", handleClick);
    sigma.on("doubleClickNode", handleDoubleClick);
    sigma.on("clickStage", handleStageClick);

    return () => {
      sigma.off("enterNode", handleEnter);
      sigma.off("leaveNode", handleLeave);
      sigma.off("clickNode", handleClick);
      sigma.off("doubleClickNode", handleDoubleClick);
      sigma.off("clickStage", handleStageClick);
    };
  }, [sigma, onNodeClick, onStageClick, onNodeEnter, onNodeLeave]);

  return null; // pure side-effect component
}
