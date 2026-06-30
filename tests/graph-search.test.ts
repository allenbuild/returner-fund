import { describe, expect, it } from "vitest";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { searchGraphNodes } from "@/lib/graph/search";
import { demoGraphDataset } from "@/lib/graph/demo-data";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

describe("graph search", () => {
  it("handles typo-tolerant company search", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const results = searchGraphNodes(graph.nodes, "HeyCliky");
    const heyclicky = results.find((result) => result.kind === "company" && result.label === "HeyClicky");

    expect(heyclicky).toBeDefined();
    expect(heyclicky?.companyNodeId).toBe("company:company-heyclicky");
  });

  it("shows company search results with rank and score context", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const results = searchGraphNodes(graph.nodes, "rent a human");
    const rentAHuman = results.find((result) => result.kind === "company" && result.label === "RentAHuman");

    expect(rentAHuman).toBeDefined();
    expect(rentAHuman?.subtitle).toMatch(/^#\d+, Score: \d+$/);
    expect(rentAHuman?.rank).toBeGreaterThan(0);
    expect(rentAHuman?.companyScore).toBeGreaterThanOrEqual(0);
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
