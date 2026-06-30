import { describe, expect, it } from "vitest";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { sanitizeGraphResponse } from "@/lib/graph/response-sanitizer";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

describe("graph response sanitizer", () => {
  it("removes raw scrape text from dashboard graph payloads", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const sanitized = sanitizeGraphResponse(graph);

    expect(graph.evidence.some((item) => item.rawVisibleText)).toBe(true);
    expect(sanitized.evidence.some((item) => "rawVisibleText" in item)).toBe(false);
    expect(sanitized.evidence.length).toBeLessThan(graph.evidence.length);
    expect(sanitized.evidence.every((item) => item.contributionScore > 0)).toBe(true);
    expect(sanitized.evidence[0]?.id).toMatch(/^ev-/);
    expect(sanitized.evidence.every((item) => item.why === "")).toBe(true);
    expect(sanitized.nodes.every((node) => node.evidenceIds.every((id) => sanitized.evidence.some((item) => item.id === id)))).toBe(true);
    expect(
      sanitized.leaderboard.some((row) => row.biggestContribution && "rawVisibleText" in row.biggestContribution)
    ).toBe(false);
    expect(JSON.stringify(sanitized.fastestGaining)).not.toContain("rawVisibleText");
    expect(JSON.stringify(sanitized.fastestGaining)).not.toContain("newHighPerformingPosts");
  });

  it("keeps raw scrape text when explicitly requested for debug audits", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);

    expect(sanitizeGraphResponse(graph, { includeRaw: true })).toBe(graph);
  });

  it("can keep explanations for debug views without keeping raw scrape text", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const sanitized = sanitizeGraphResponse(graph, { includeWhy: true });

    expect(sanitized.evidence.some((item) => item.why)).toBe(true);
    expect(sanitized.evidence.some((item) => "rawVisibleText" in item)).toBe(false);
  });
});
