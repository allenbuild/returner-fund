import { describe, expect, it } from "vitest";
import { buildInitialPageGraph } from "@/lib/graph/initial-page-graph";

describe("initial page graph", () => {
  it("keeps the full map and ranking shell while trimming heavy evidence for first paint", () => {
    const graph = buildInitialPageGraph();

    expect(graph.nodes).toHaveLength(197);
    expect(graph.leaderboard).toHaveLength(197);
    expect(graph.fastestGaining).toHaveLength(197);
    expect(graph.evidence.length).toBeGreaterThan(0);
    expect(graph.evidence.length).toBeLessThanOrEqual(20);
  });
});
