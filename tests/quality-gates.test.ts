import { describe, expect, it } from "vitest";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { selectedNodeEvidence } from "@/lib/graph/evidence-selection";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

describe("quality gates", () => {
  const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);

  it("keeps Spring 2026 graph publication-safe", () => {
    expect(graph.nodes.filter((node) => node.entityType === "company")).toHaveLength(197);
    expect(graph.nodes.some((node) => node.entityType === "founder")).toBe(false);
  });

  it("does not score evidence marked risky, non-verified, or context-only", () => {
    const scored = graph.evidence.filter((item) => item.contributionScore > 0);
    const unsafe = scored.filter((item) => {
      const text = `${item.why ?? ""} ${item.matchReason ?? ""}`;
      return (
        (item.review_state && item.review_state !== "verified") ||
        /Attribution guard:\s*(high|medium) risk/i.test(text) ||
        isProfileOrContextOnlyEvidence(item)
      );
    });

    expect(unsafe).toEqual([]);
  });

  it("does not show zero-score rows as leaderboard biggest contributions", () => {
    const badRows = graph.leaderboard.filter(
      (row) => row.biggestContribution && row.biggestContribution.contributionScore <= 0
    );

    expect(badRows).toEqual([]);
  });

  it("does not attach selected company evidence from unrelated entities", () => {
    for (const node of graph.nodes.filter((candidate) => candidate.entityType === "company")) {
      const allowedEntityIds = new Set([node.entityId, ...node.relatedEntityIds]);
      const selectedEvidence = selectedNodeEvidence(graph, node);
      const leakedRows = selectedEvidence.filter((item) => !allowedEntityIds.has(item.entityId));

      expect(leakedRows).toEqual([]);
    }
  });
});

function isProfileOrContextOnlyEvidence(item: { platform: string; platformPostId?: string | null; sourceUrl: string; why?: string }) {
  if (/Stored as context only|identity context|Profile pages are not counted as post-level traction/i.test(item.why ?? "")) {
    return true;
  }

  if (!["x", "instagram", "linkedin"].includes(item.platform)) {
    return false;
  }

  if (item.platformPostId) {
    return false;
  }

  try {
    const url = new URL(item.sourceUrl);
    const pathAndHash = `${url.pathname}${url.hash}`.toLowerCase();
    if (item.platform === "x") return !/\/status\/\d+/.test(pathAndHash);
    if (item.platform === "instagram") return !(/^\/(p|reel|tv)\//.test(pathAndHash) || /#post-\d+/.test(pathAndHash));
    if (item.platform === "linkedin") return !/\/feed\/update\/|\/posts\/|\/recent-activity\/all\/#post-/.test(pathAndHash);
  } catch {
    return true;
  }

  return false;
}
