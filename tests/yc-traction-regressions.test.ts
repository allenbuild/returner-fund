import { describe, expect, it } from "vitest";
import { selectedNodeEvidence } from "@/lib/graph/evidence-selection";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import {
  aggregateBalancedTractionScore,
  computeEvidenceRawEngagement,
  normalizeEvidenceScores
} from "@/lib/graph/traction-scoring";
import { TRACTION_SCORING_CONFIG } from "@/lib/graph/traction-scoring-config";
import type { EvidenceItem, Platform } from "@/lib/graph/types";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

describe("YC traction scoring regressions", () => {
  it("does not attach smol machines evidence to Runtime's selected company feed", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const runtime = graph.nodes.find((node) => node.entityType === "company" && node.label === "Runtime");

    expect(runtime).toBeTruthy();
    expect(graph.evidence.some((item) => item.attachedCompanyName === "smol machines")).toBe(true);

    const selectedEvidence = selectedNodeEvidence(graph, runtime!);
    const allowedEntityIds = new Set([runtime!.entityId, ...runtime!.relatedEntityIds]);

    expect(selectedEvidence.every((item) => allowedEntityIds.has(item.entityId))).toBe(true);
    expect(selectedEvidence.some((item) => item.attachedCompanyName === "smol machines")).toBe(false);
  });

  it("scores InsForge's GitHub traction above Interfaze's GitHub traction", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const insforge = graph.nodes.find((node) => node.entityType === "company" && node.label === "InsForge");
    const interfaze = graph.nodes.find((node) => node.entityType === "company" && node.label === "Interfaze");

    expect(insforge?.platformScores.github).toBeGreaterThan(interfaze?.platformScores.github ?? 0);
    expect(insforge?.score).toBeGreaterThan(interfaze?.score ?? 0);
  });

  it("does not score GitHub profile aggregates when repo-level evidence exists", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const insforge = graph.nodes.find((node) => node.entityType === "company" && node.label === "InsForge");
    const selectedEvidence = selectedNodeEvidence(graph, insforge!);
    const profileAggregate = selectedEvidence.find((item) => item.id === "evidence-github-profile-company-insforge");
    const repoEvidence = selectedEvidence.filter(
      (item) => item.platform === "github" && item.id.startsWith("evidence-github-repo-company-insforge")
    );

    expect(profileAggregate?.contributionScore ?? 0).toBe(0);
    expect(repoEvidence.some((item) => item.contributionScore > 0)).toBe(true);
  });

  it("does not inflate sparse one-platform GitHub evidence into a perfect company score", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const smol = graph.nodes.find((node) => node.entityType === "company" && node.label === "smol machines");
    const heyClicky = graph.nodes.find((node) => node.entityType === "company" && node.label === "HeyClicky");

    expect(smol?.score).toBeLessThan(70);
    expect(heyClicky?.score).toBeGreaterThan(smol?.score ?? 0);
    expect(smol?.scoreBreakdown?.explanation).toContain("Evidence-depth factor");
    expect(smol?.scoreBreakdown?.weightedPlatforms[0]?.evidenceCount).toBe(1);
  });

  it("uses the full 0-100 peer range for Spring 2026 company scores", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const companyScores = graph.nodes.filter((node) => node.entityType === "company").map((node) => node.score);

    expect(companyScores).toHaveLength(197);
    expect(Math.max(...companyScores)).toBe(100);
    expect(Math.min(...companyScores)).toBe(0);
    expect(graph.leaderboard[0]?.score).toBe(100);
  });

  it("makes X views material after log scaling", () => {
    const lowView = evidence("low-x", "x", { views: 2_000, likes: 20, comments: 1 });
    const highView = evidence("high-x", "x", { views: 250_000, likes: 20, comments: 1 });
    const scored = normalizeEvidenceScores([lowView, highView]);

    expect(computeEvidenceRawEngagement("x", highView.metrics)).toBeGreaterThan(
      computeEvidenceRawEngagement("x", lowView.metrics) * 20
    );
    expect(scored.find((item) => item.id === "high-x")?.contributionScore).toBeGreaterThan(
      (scored.find((item) => item.id === "low-x")?.contributionScore ?? 0) + 40
    );
  });

  it("applies recency decay before platform normalization", () => {
    const oldPost = {
      ...evidence("old-instagram", "instagram", { views: 100_000, likes: 500, comments: 20 }),
      postedAt: "2025-06-01T00:00:00Z",
      last_checked_at: "2026-06-28T00:00:00Z"
    };
    const freshPost = {
      ...evidence("fresh-instagram", "instagram", { views: 100_000, likes: 500, comments: 20 }),
      postedAt: "2026-06-20T00:00:00Z",
      last_checked_at: "2026-06-28T00:00:00Z"
    };
    const scored = normalizeEvidenceScores([oldPost, freshPost]);

    expect(scored.find((item) => item.id === "fresh-instagram")?.contributionScore).toBeGreaterThan(
      (scored.find((item) => item.id === "old-instagram")?.contributionScore ?? 0) + 40
    );
    expect(scored.find((item) => item.id === "fresh-instagram")?.why).toContain("Recency-adjusted");
  });

  it("lets strong cross-platform traction beat one perfect GitHub-only signal", () => {
    const githubOnly = aggregateBalancedTractionScore([evidence("github-only", "github", {}, 100)]);
    const crossPlatform = aggregateBalancedTractionScore([
      evidence("x", "x", {}, 98),
      evidence("linkedin", "linkedin", {}, 98),
      evidence("instagram", "instagram", {}, 98),
      evidence("product-hunt", "product_hunt", {}, 98),
      evidence("youtube", "youtube", {}, 98)
    ]);

    expect(crossPlatform.totalScore).toBeGreaterThan(githubOnly.totalScore);
  });

  it("does not average away a viral view-heavy social post", () => {
    const score = aggregateBalancedTractionScore([
      evidence("viral-x", "x", {}, 100),
      evidence("tail-x-1", "x", {}, 20),
      evidence("tail-x-2", "x", {}, 15),
      evidence("tail-x-3", "x", {}, 10),
      evidence("tail-x-4", "x", {}, 10)
    ]);

    expect(score.platformScores.x).toBeGreaterThanOrEqual(80);
    expect(score.totalScore).toBeGreaterThanOrEqual(70);
  });

  it("applies a coverage penalty to one-platform companies", () => {
    const onePlatform = aggregateBalancedTractionScore([evidence("x", "x", {}, 100)]);
    const allConfiguredPlatforms = aggregateBalancedTractionScore([
      evidence("x", "x", {}, 100),
      evidence("linkedin", "linkedin", {}, 100),
      evidence("instagram", "instagram", {}, 100),
      evidence("product-hunt", "product_hunt", {}, 100),
      evidence("github", "github", {}, 100),
      evidence("youtube", "youtube", {}, 100),
      evidence("hacker-news", "hacker_news", {}, 100)
    ]);

    expect(onePlatform.coverageFactor).toBeLessThan(allConfiguredPlatforms.coverageFactor);
    expect(allConfiguredPlatforms.coverageFactor).toBe(1);
    expect(onePlatform.totalScore).toBeLessThan(100);
    expect(allConfiguredPlatforms.totalScore).toBeGreaterThan(onePlatform.totalScore);
  });

  it("orders score explanations by current weighted platform contribution", () => {
    const score = aggregateBalancedTractionScore([
      evidence("github", "github", {}, 100),
      evidence("instagram", "instagram", {}, 80)
    ]);

    expect(score.weightedPlatforms[0]?.platform).toBe("instagram");
    expect(score.weightedPlatforms[0]?.contribution).toBeGreaterThan(score.weightedPlatforms[1]?.contribution ?? 0);
    expect(score.explanation).toContain("contributes");
  });

  it("lets a perfect social signal outrank a moderate GitHub signal", () => {
    const score = aggregateBalancedTractionScore([
      evidence("github", "github", {}, 60),
      evidence("instagram", "instagram", {}, 100)
    ]);

    expect(score.weightedPlatforms[0]?.platform).toBe("instagram");
    expect(score.weightedPlatforms[0]?.contribution).toBeGreaterThan(score.weightedPlatforms[1]?.contribution ?? 0);
  });

  it("uses the recommended long-run scoring config for live graph scoring", () => {
    expect(TRACTION_SCORING_CONFIG.name).toBe("social-traction-v2-with-browser-metrics");
    expect(TRACTION_SCORING_CONFIG.platformWeights.github).toBe(0.14);
    expect(TRACTION_SCORING_CONFIG.platformWeights.x).toBe(0.34);
    expect(TRACTION_SCORING_CONFIG.platformWeights.linkedin).toBe(0.14);
    expect(TRACTION_SCORING_CONFIG.metricWeights.instagram?.views).toBe(0.075);
    expect(TRACTION_SCORING_CONFIG.metricWeights.x?.views).toBe(0.08);
    expect(TRACTION_SCORING_CONFIG.metricWeights.linkedin?.views).toBe(0.08);
    expect(TRACTION_SCORING_CONFIG.metricWeights.youtube?.views).toBe(0.035);
    expect(TRACTION_SCORING_CONFIG.metricWeights.x?.reposts).toBe(8);
    expect(TRACTION_SCORING_CONFIG.metricWeights.linkedin?.comments).toBe(5.5);
    expect(TRACTION_SCORING_CONFIG.metricWeights.github?.recent_commits_30d).toBe(1);
    expect(computeEvidenceRawEngagement("instagram", { views: 100_000, likes: 100, comments: 10 })).toBe(7660);
    expect(computeEvidenceRawEngagement("x", { views: 1_000_000, likes: 1_000, comments: 100, reposts: 100 })).toBe(82850);
    expect(computeEvidenceRawEngagement("linkedin", { views: 100_000, reactions: 100, comments: 20, reposts: 10 })).toBe(8340);
  });

  it("carries GitHub recent activity into scoring experiments", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const githubRows = graph.evidence.filter((item) => item.platform === "github");

    expect(githubRows.some((item) => item.metrics.recent_commits_30d !== undefined)).toBe(true);
    expect(
      computeEvidenceRawEngagement("github", { stars: 10, forks: 2, watchers: 1, recent_commits_30d: 8 })
    ).toBeGreaterThan(computeEvidenceRawEngagement("github", { stars: 10, forks: 2, watchers: 1, recent_commits_30d: 0 }));
  });
});

function evidence(
  id: string,
  platform: Platform,
  metrics: EvidenceItem["metrics"],
  contributionScore = 50
): EvidenceItem {
  return {
    id,
    entityType: "company",
    entityId: "company-test",
    platform,
    authorName: "Test",
    authorHandle: null,
    postedAt: "2026-06-01T00:00:00Z",
    text: id,
    mediaType: platform === "github" ? "repo" : "text",
    metrics,
    contributionScore,
    sourceUrl: `https://example.com/${id}`,
    why: "test"
  };
}
