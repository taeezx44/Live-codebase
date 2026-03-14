// ============================================================
// fa2.worker.ts  — ForceAtlas2 layout on a Web Worker
//
// Why a worker?
//   FA2 on a 5,000-node graph takes ~100ms per tick.
//   Running it on the main thread freezes pan/zoom/hover.
//   The worker runs ticks in a loop and posts node positions
//   back to the main thread via transferable ArrayBuffers
//   (zero-copy, no serialization cost).
//
// Protocol:
//   Main → Worker:  { type: "start", graphJSON, settings }
//   Main → Worker:  { type: "stop" }
//   Worker → Main:  { type: "progress", positions: Float32Array }
//   Worker → Main:  { type: "done" }
//
// positions layout: [id0_x, id0_y, id1_x, id1_y, ...]
// The main thread maps index → nodeId via the same order
// the graph was serialized in.
// ============================================================

import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";

// ── FA2 settings tuned for code dependency graphs ───────────
// Code graphs are typically sparse (each file imports ~3-10 others)
// and have strong hub nodes (utility files imported everywhere).
// Settings optimized for:
//   - fast clustering of modules that share imports
//   - hub nodes pulled to center but not crushing small nodes
//   - convergence in ~200 iterations for graphs up to 10k nodes

const DEFAULT_FA2_SETTINGS = {
  gravity: 0.05,
  scalingRatio: 10,
  strongGravityMode: false,
  barnesHutOptimize: true,   // O(n log n) — essential for >500 nodes
  barnesHutTheta: 0.5,
  slowDown: 3,
  linLogMode: false,
  outboundAttractionDistribution: false,
  adjustSizes: true,
};

// ── Worker message types ─────────────────────────────────────

type WorkerInMessage =
  | { type: "start"; graphJSON: object; iterations?: number }
  | { type: "stop" };

type WorkerOutMessage =
  | { type: "progress"; positions: Float32Array; nodeIds: string[] }
  | { type: "done" };

// ── Worker body ──────────────────────────────────────────────

let running = false;
let nodeIds: string[] = [];

self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;

  if (msg.type === "stop") {
    running = false;
    return;
  }

  if (msg.type === "start") {
    running = true;

    // Reconstruct graph from serialized JSON
    const graph = new Graph();
    graph.import(msg.graphJSON as ReturnType<Graph["export"]>);

    // Assign random positions if not already set
    graph.forEachNode((node, attrs) => {
      if (attrs.x == null) graph.setNodeAttribute(node, "x", Math.random());
      if (attrs.y == null) graph.setNodeAttribute(node, "y", Math.random());
    });

    nodeIds = graph.nodes();

    const BATCH = 50; // ticks per animation frame
    const MAX_ITERATIONS = msg.iterations ?? 500;
    let done = 0;

    function tick() {
      if (!running || done >= MAX_ITERATIONS) {
        self.postMessage({ type: "done" } satisfies WorkerOutMessage);
        return;
      }

      // Run a batch of FA2 iterations
      forceAtlas2.assign(graph, {
        iterations: BATCH,
        settings: DEFAULT_FA2_SETTINGS,
      });
      done += BATCH;

      // Pack positions into a transferable Float32Array
      // Layout: [x0, y0, x1, y1, ...]
      const positions = new Float32Array(nodeIds.length * 2);
      nodeIds.forEach((id, i) => {
        positions[i * 2]     = graph.getNodeAttribute(id, "x") as number;
        positions[i * 2 + 1] = graph.getNodeAttribute(id, "y") as number;
      });

      // Transfer the buffer (zero-copy) — positions is unusable after this
      self.postMessage(
        { type: "progress", positions, nodeIds } satisfies WorkerOutMessage,
        [positions.buffer]
      );

      // Yield to the event loop between batches
      setTimeout(tick, 0);
    }

    tick();
  }
};
