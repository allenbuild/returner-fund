import { describe, expect, it } from "vitest";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { sanitizeGraphResponse } from "@/lib/graph/response-sanitizer";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

describe("graph response sanitizer", () => {
  it("removes raw scrape text from dashboard graph payloads", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const graphWithRaw = {
      ...graph,
      evidence: graph.evidence.map((item, index) =>
        index === 0 ? { ...item, rawVisibleText: "raw scrape text that should not ship" } : item
      )
    };
    const sanitized = sanitizeGraphResponse(graphWithRaw);

    expect(graphWithRaw.evidence.some((item) => item.rawVisibleText)).toBe(true);
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
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);

    expect(sanitizeGraphResponse(graph, { includeRaw: true })).toBe(graph);
  });

  it("keeps public-safe GitHub creation provenance when raw payloads are removed", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const evidence = graph.evidence[0];
    const nativeCreation = "2025-01-02T03:04:05.000Z";
    const sanitized = sanitizeGraphResponse({
      ...graph,
      evidence: [{
        ...evidence,
        platform: "github",
        sourceUrl: "https://github.com/returner/example-repository",
        postedAt: nativeCreation,
        publishedAtPrecision: "exact",
        rawVisibleText: JSON.stringify({
          repositoryTimestamps: {
            createdAt: nativeCreation,
            updatedAt: "2026-07-14T10:00:00.000Z",
            pushedAt: "2026-07-15T10:00:00.000Z",
            observedAt: "2026-07-16T10:00:00.000Z"
          }
        })
      }]
    }, { includeNonScoring: true, compactIds: false });

    expect(sanitized.evidence[0]).not.toHaveProperty("rawVisibleText");
    expect(sanitized.evidence[0]?.publicationProvenance).toEqual({
      kind: "github_repository",
      createdAt: nativeCreation,
      updatedAt: "2026-07-14T10:00:00.000Z",
      pushedAt: "2026-07-15T10:00:00.000Z",
      observedAt: "2026-07-16T10:00:00.000Z"
    });
  });

  it("can keep explanations for debug views without keeping raw scrape text", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const sanitized = sanitizeGraphResponse(graph, { includeWhy: true });

    expect(sanitized.evidence.some((item) => item.why)).toBe(true);
    expect(sanitized.evidence.some((item) => "rawVisibleText" in item)).toBe(false);
  });
});
