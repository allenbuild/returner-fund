import { describe, expect, it, vi } from "vitest";
import {
  lookupReturnerFundCompany,
  type ReturnerFundCompanyResponse,
} from "@/lib/integrations/returner-fund-company";
import type { RankedPostsSidecarScope } from "@/lib/graph/ranked-posts-sidecar";
import type { EvidenceItem, GraphNode, GraphResponse } from "@/lib/graph/types";

describe("Returner Fund company projection", () => {
  it("returns the published score and ranked company/founder source links", async () => {
    const graph = fixtureGraph();
    const loadGraph = vi.fn(async () => graph);
    const result = await lookupReturnerFundCompany(
      { companyReference: "example", batchSlug: "S26", limit: 1 },
      { loadGraph, loadSidecarScope: () => fixtureSidecar() }
    );

    expect(loadGraph).toHaveBeenCalledWith({ batchSlug: "S26", audienceId: "off" });
    expect(result.status).toBe("found");
    const response = (result as { status: "found"; response: ReturnerFundCompanyResponse }).response;
    expect(response).toMatchObject({
      schemaVersion: "returner-fund-company-v1",
      company: {
        id: "company-example",
        slug: "example",
        name: "Example",
        batchSlug: "S26",
        returnerFundUrl: "https://www.returner.fund/companies/example",
      },
      returnerFund: {
        score: 70,
        cohort: {
          rank: 2,
          size: 3,
          derivedPercentile: 50,
          percentileMethod: "tie_aware_midrank_all_published_companies",
        },
        model: { id: "returner-traction", version: "4.3.0" },
      },
      postsReturned: 1,
      totalEligiblePosts: 2,
      postsTruncated: true,
      postsComplete: true,
    });
    expect(response.bestPosts).toHaveLength(1);
    expect(response.bestPosts[0]).toMatchObject({
      id: "founder-best",
      rank: 1,
      platform: "x",
      sourceKind: "founder",
      title: "Founder launch reached one million users.",
      url: "https://x.com/founder/status/102",
      authorName: "Founder One",
      score: 90,
    });
  });

  it("accepts the graph company ID and fails closed when post snapshots are out of sync", async () => {
    const graph = fixtureGraph();
    const result = await lookupReturnerFundCompany(
      { companyReference: "company-example", batchSlug: "S26", limit: 5 },
      { loadGraph: async () => graph, loadSidecarScope: () => null }
    );

    expect(result).toEqual({ status: "unavailable", reason: "ranked_posts_out_of_sync" });
  });

  it("does not fuzzy-match unrelated names", async () => {
    const result = await lookupReturnerFundCompany(
      { companyReference: "exam", batchSlug: "S26", limit: 5 },
      { loadGraph: async () => fixtureGraph(), loadSidecarScope: () => fixtureSidecar() }
    );

    expect(result).toEqual({ status: "not_found" });
  });
});

function fixtureGraph(): GraphResponse {
  const target = companyNode("company-example", "Example", 70, "https://www.ycombinator.com/companies/example");
  target.founders = [{
    id: "founder-1",
    name: "Founder One",
    ycProfileUrl: "https://www.ycombinator.com/people/founder-one",
    socialAccounts: [],
    evidenceIds: ["founder-best"],
    platformScores: { x: 90 },
  }];
  target.platformScores = { x: 73 };
  target.scoreBreakdown = {
    modelId: "returner-traction",
    modelVersion: "4.3.0",
    modelName: "returner-traction-v4-bounded-primary-signal-global-best",
    totalScore: 70,
    absoluteScore: 70,
    weightedAvailableScore: 73,
    coverageFactor: 0.21,
    platformsWithEvidence: 1,
    totalSupportedPlatforms: 9,
    platformScores: { x: 73 },
    weightedPlatforms: [{
      platform: "x",
      score: 73,
      configuredWeight: 0.21,
      appliedWeight: 0.9605,
      contribution: 70.12,
      evidenceCount: 2,
    }],
    signalFamilyScores: { reach: 73, engagement: 60, developerAdoption: 0, launchAndCommunity: 0, momentum: 0 },
    confidence: {
      level: "high",
      value: 0.8,
      reasons: [],
      scoredEvidenceCount: 2,
      datedEvidenceCount: 2,
      verifiedLinkCount: 2,
    },
    calibration: {
      method: "global_best_ratio",
      cohortSize: 3,
      percentile: null,
      inputScore: 70,
      benchmarkScore: 100,
      scaleFactor: 1,
      benchmarkScope: "all_supported_batches",
      benchmarkPopulation: "current_company_snapshot",
    },
    limitations: [],
    evidenceAsOf: "2026-08-20T12:00:00.000Z",
    explanation: "Example explanation.",
  };

  return {
    batch: { slug: "S26", label: "YC Summer 2026" },
    batches: [{ slug: "S26", label: "YC Summer 2026" }],
    nodes: [
      companyNode("company-high", "High", 90, "https://www.ycombinator.com/companies/high"),
      target,
      companyNode("company-low", "Low", 50, "https://www.ycombinator.com/companies/low"),
    ],
    edges: [],
    leaderboard: [],
    fastestGaining: [],
    needsReview: [],
    evidence: [
      evidence({ id: "company-second", contributionScore: 80, normalizedScore: 80 }),
      evidence({
        id: "founder-best",
        entityType: "founder",
        entityId: "founder-1",
        attachedCompanyId: "company-example",
        authorName: "Founder One",
        text: "Founder launch reached one million users.",
        title: "Founder launch reached one million users.",
        contributionScore: 90,
        normalizedScore: 90,
        sourceUrl: "https://x.com/founder/status/102",
        platformPostId: "102",
      }),
      evidence({
        id: "other-company",
        entityId: "company-high",
        attachedCompanyId: "company-high",
        contributionScore: 100,
        normalizedScore: 100,
        sourceUrl: "https://x.com/high/status/103",
        platformPostId: "103",
      }),
    ],
    platformStatus: [],
    selectedTopVoiceAudience: audience(),
    topVoiceAudiences: [audience()],
    generatedAt: "2026-08-21T12:00:00.000Z",
    scoringContext: {
      modelId: "returner-traction",
      modelVersion: "4.3.0",
      modelName: "returner-traction-v4-bounded-primary-signal-global-best",
      scoreScope: "all_platforms",
      selectedPlatforms: [],
      responseBuiltAt: "2026-08-21T12:00:00.000Z",
      evidenceAsOf: "2026-08-20T12:00:00.000Z",
    },
    mode: "official_snapshot",
  };
}

function companyNode(id: string, label: string, score: number, ycProfileUrl: string): GraphNode {
  return {
    id: `company:${id}`,
    entityType: "company",
    entityId: id,
    label,
    batchSlug: "S26",
    score,
    previousScore: score,
    scoreDelta: 0,
    radius: 30,
    topPlatform: "x",
    platformScores: { x: score },
    socialAccounts: [],
    evidenceIds: [],
    ycProfileUrl,
    websiteUrl: `https://${id.replace(/^company-/, "")}.example`,
    tagline: `${label} tagline`,
    description: `${label} description`,
    groupPartner: null,
    primaryIndustry: "b2b",
    businessModel: "b2b",
    review_state: "verified",
    sourceUrl: ycProfileUrl,
    visual: {
      industryColor: "#fff",
      shape: "ellipse",
      borderStyle: "solid",
      borderColor: "#000",
      groupRegion: null,
    },
    industries: ["b2b"],
    relatedEntityIds: [],
    founders: [],
    review_state_counts: { verified: 0, needs_review: 0, rejected: 0 },
  };
}

function evidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  const desiredScore = overrides.normalizedScore ?? overrides.contributionScore ?? 80;
  return {
    id: "company-second",
    batchSlug: "S26",
    entityType: "company",
    entityId: "company-example",
    attachedCompanyId: "company-example",
    platform: "x",
    authorName: "Example",
    authorHandle: "example",
    postedAt: "2026-08-20T12:00:00.000Z",
    publishedAtPrecision: "exact",
    title: "Example post",
    text: "Example post",
    mediaType: "text",
    metrics: xMetricsForEditorialScore(desiredScore),
    contributionScore: 80,
    normalizedScore: 80,
    rawEngagement: 100,
    tractionStatus: "scored",
    sourceUrl: "https://x.com/example/status/101",
    platformPostId: "101",
    why: "Verified native evidence.",
    review_state: "verified",
    linkStatus: "verified",
    ...overrides,
  };
}

function xMetricsForEditorialScore(score: number): EvidenceItem["metrics"] {
  if (!Number.isFinite(score) || score <= 0) return {};
  const rawEngagement = Math.expm1((Math.min(100, score) / 100) * Math.log1p(120_000));
  return { views: rawEngagement / 0.04 };
}

function fixtureSidecar(): RankedPostsSidecarScope {
  return {
    previewGeneratedAt: "2026-08-21T12:00:00.000Z",
    sourceEvidenceCount: 3,
    previewEvidenceCount: 3,
    fullRankableCount: 3,
    previewRankableCount: 3,
    overflowRankableCount: 0,
    fullRankableDigest: "0".repeat(64),
    representedRankableDigest: "0".repeat(64),
    crossAudiencePreviewProjectionCount: 0,
    crossAudiencePreviewProjectionKeys: [],
    previewRankableByCompany: { "company-example": 2, "company-high": 1 },
    fullRankableByCompany: { "company-example": 2, "company-high": 1 },
    evidence: [],
  };
}

function audience() {
  return {
    id: "off" as const,
    displayName: "All voices",
    description: "All evidence",
    helperText: "All evidence",
    scoreLabel: "Traction score",
    scoreDescription: "Canonical score",
    active: true,
    memberCount: 0,
  };
}
