import { describe, expect, it } from "vitest";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

describe("YC Spring 2026 official snapshot", () => {
  it("exposes only YC Spring 2026 in graph batch metadata", () => {
    const graph = buildGraphResponse({}, ycSpring2026GraphDataset);

    expect(graph.batch).toEqual({
      slug: "S2026",
      label: "YC Spring 2026",
      companyCountExpected: 197,
      companyCountObserved: 197
    });
    expect(graph.batches).toEqual([graph.batch]);
    expect(new Set(graph.nodes.map((node) => node.batchSlug))).toEqual(new Set(["S2026"]));
  });

  it("loads the complete public YC batch instead of the demo seed", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const companyNodes = graph.nodes.filter((node) => node.entityType === "company");
    const founderNodes = graph.nodes.filter((node) => node.entityType === "founder");

    expect(graph.mode).toBe("official_snapshot");
    expect(graph.batch.companyCountExpected).toBe(197);
    expect(graph.batch.companyCountObserved).toBe(197);
    expect(companyNodes).toHaveLength(197);
    expect(founderNodes).toHaveLength(0);
    expect(graph.leaderboard).toHaveLength(197);
    expect(graph.evidence.length).toBeGreaterThan(39);
    expect([...new Set(graph.evidence.map((item) => item.platform))]).toEqual(
      expect.arrayContaining(["github", "x", "instagram", "youtube", "web", "rss", "hacker_news"])
    );
    expect(graph.evidence.some((item) => item.platform === "github" && item.thumbnailUrl)).toBe(true);
    expect(graph.evidence.some((item) => item.platform === "youtube" && item.thumbnailUrl)).toBe(true);
    expect(graph.evidence.some((item) => item.platform === "x" && item.thumbnailUrl)).toBe(true);
    expect(graph.evidence.some((item) => item.platform === "instagram" && item.thumbnailUrl)).toBe(true);
    expect(graph.leaderboard[0]?.topPlatform).toBeTruthy();
    expect(companyNodes.filter((node) => node.score > 0).length).toBeGreaterThan(6);
    expect(companyNodes.some((node) => node.founders.length > 0)).toBe(true);
    expect(companyNodes.some((node) => node.evidenceIds.some((id) => graph.evidence.find((item) => item.id === id)?.entityType === "founder"))).toBe(true);
    expect(graph.needsReview.some((item) => item.candidateUrl === "https://www.producthunt.com/products/screen-studio")).toBe(false);
    expect(JSON.stringify(graph.evidence)).not.toContain("yc-public-directory");
  }, 30_000);
});
