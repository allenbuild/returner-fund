import { describe, expect, it } from "vitest";
import { applyClientGraphFilters } from "@/lib/graph/client-filters";
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

  it("keeps leaderboard top posts available after the first client filter pass", () => {
    const graph = buildInitialPageGraph();
    const filtered = applyClientGraphFilters(graph, {
      platforms: [],
      industries: [],
      groupPartners: [],
      minScore: 0
    });

    expect(filtered.leaderboard.slice(0, 12).every((row) => row.biggestContribution)).toBe(true);
  });
});
