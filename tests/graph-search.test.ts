import { describe, expect, it } from "vitest";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { searchGraphNodes } from "@/lib/graph/search";
import { demoGraphDataset } from "@/lib/graph/demo-data";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

describe("graph search", () => {
  it("handles typo-tolerant company search", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const results = searchGraphNodes(graph.nodes, "Conifr");
    const conifer = results.find((result) => result.kind === "company" && result.label === "Conifer");

    expect(conifer).toBeDefined();
    expect(conifer?.companyNodeId).toBe("company:company-conifer");
  });

  it("shows company search results with rank and score context", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const results = searchGraphNodes(graph.nodes, "Conifer");
    const conifer = results.find((result) => result.kind === "company" && result.label === "Conifer");

    expect(conifer).toBeDefined();
    expect(conifer?.subtitle).toMatch(/^#\d+, Score: \d+$/);
    expect(conifer?.rank).toBeGreaterThan(0);
    expect(conifer?.companyScore).toBeGreaterThanOrEqual(0);
  });

  it("uses canonical leaderboard ranks for filtered subsets, including ties", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const companyNodes = graph.nodes.filter((node) => node.entityType === "company");
    const first = companyNodes[0]!;
    const second = companyNodes[1]!;
    const canonicalRanks = new Map([
      [first.entityId, 7],
      [second.entityId, 7]
    ]);

    const firstResult = searchGraphNodes([first], first.label, 12, canonicalRanks)[0];
    const secondResult = searchGraphNodes([second], second.label, 12, canonicalRanks)[0];

    expect(firstResult).toMatchObject({ rank: 7, subtitle: `#7, Score: ${Math.round(first.score)}` });
    expect(secondResult).toMatchObject({ rank: 7, subtitle: `#7, Score: ${Math.round(second.score)}` });
  });

  it("returns founder matches that focus the founder's company node", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, demoGraphDataset);
    const results = searchGraphNodes(graph.nodes, "Luca");
    const luca = results.find((result) => result.kind === "founder" && result.label === "Luca Martin");

    expect(luca).toBeDefined();
    expect(luca?.companyNodeId).toBe("company:company-promptforge");
    expect(graph.nodes.some((node) => node.entityType === "founder")).toBe(false);
  });

  it("handles typo-tolerant founder search", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, demoGraphDataset);
    const results = searchGraphNodes(graph.nodes, "Lukka Martn");
    const luca = results.find((result) => result.kind === "founder" && result.label === "Luca Martin");

    expect(luca).toBeDefined();
    expect(luca?.companyNodeId).toBe("company:company-promptforge");
  });
});
