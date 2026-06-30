import { describe, expect, it } from "vitest";
import {
  aggregateCompanyScore,
  aggregateFounderScore,
  aggregatePlatformScore,
  batchPercentileScores,
  baselineSeedsForPlatform,
  computeWeightedRawEngagement,
  percentileRank,
  scorePost,
  strongestBaselineReliability
} from "@/lib/scoring";

describe("scoring formulas", () => {
  it("computes weighted raw engagement with documented metric weights", () => {
    expect(
      computeWeightedRawEngagement({
        likes: 10,
        comments: 2,
        reposts: 1,
        views: 100,
        stars: 3,
        forks: 1
      })
    ).toBe(30.5);
  });

  it("scores posts with transparent intermediate explanation values", () => {
    const result = scorePost({
      postId: "post-1",
      platform: "x",
      metrics: { likes: 10, comments: 2, reposts: 1, views: 100 },
      followerCount: 88,
      postedAt: "2026-06-01T00:00:00Z",
      collectedAt: "2026-07-01T00:00:00Z",
      percentileSamples: {
        logEngagement: [1, Math.log1p(22), 5],
        engagementRate: [0.1, 0.25, 0.5],
        momentum: [1, Math.log1p(22) * 0.5, 3]
      }
    });

    expect(result.rawEngagement).toBe(22);
    expect(result.engagementRate).toBe(0.25);
    expect(result.recencyWeight).toBeCloseTo(0.5);
    expect(result.normalizedScore).toBe(50);
    expect(result.explanationJson.platformLogPercentile).toBe(0.5);
    expect(result.explanationJson.engagementRatePercentile).toBe(0.5);
    expect(result.explanationJson.momentumPercentile).toBe(0.5);
  });

  it("uses mid-rank percentiles and batch-relative scores", () => {
    expect(percentileRank([10, 20, 20, 40], 20)).toBe(0.5);

    const rows = batchPercentileScores(
      [
        { id: "low", score: 10 },
        { id: "mid", score: 20 },
        { id: "high", score: 40 }
      ],
      (row) => row.score
    );

    expect(rows.find((row) => row.row.id === "mid")?.score).toBe(50);
  });

  it("aggregates verified platform scores with top-k, consistency, and account metrics", () => {
    const platform = aggregatePlatformScore({
      entityId: "company-1",
      platform: "github",
      account_review_state: "verified",
      baselineReliability: "medium",
      accountMetrics: { followerPercentile: 0.6, metricAvailability: 1 },
      postScores: [100, 90, 80, 70, 60, 0].map((score, index) => ({
        postId: `post-${index}`,
        platform: "github",
        rawEngagement: score,
        normalizedScore: score,
        recencyWeight: 1,
        engagementRate: null,
        contributionScore: score,
        explanationJson: {
          rawMetrics: {},
          weights: {},
          rawEngagement: score,
          logEngagement: score,
          ageDays: 0,
          recencyWeight: 1,
          engagementRate: null,
          platformLogPercentile: 1,
          engagementRatePercentile: 0.5,
          momentumPercentile: 1,
          momentumValue: score,
          postScore: score,
          qualitySignals: {
            hasFollowerCount: false,
            hasPostedAt: true,
            hasComparableSamples: true
          },
          limitations: []
        }
      }))
    });

    expect(platform.score).toBe(81);
    expect(platform.review_state).toBe("verified");
    expect(platform.explanationJson.topPostAverage).toBe(80);
    expect(platform.explanationJson.topPostIds).toEqual([
      "post-0",
      "post-1",
      "post-2",
      "post-3",
      "post-4"
    ]);
  });

  it("excludes needs_review platform candidates from canonical scoring", () => {
    const platform = aggregatePlatformScore({
      entityId: "company-1",
      platform: "github",
      account_review_state: "needs_review",
      baselineReliability: "medium",
      accountMetrics: { followerPercentile: 0.6, metricAvailability: 1 },
      postScores: []
    });

    expect(platform.score).toBe(0);
    expect(platform.review_state).toBe("needs_review");
    expect(platform.explanationJson.limitations.join(" ")).toContain("excluded from canonical scoring");
  });

  it("aggregates company and founder scores with platform renormalization and peer percentiles", () => {
    const officialX = {
      entityId: "company-1",
      platform: "x" as const,
      score: 80,
      review_state: "verified" as const,
      explanationJson: {}
    };
    const founderX = {
      entityId: "founder-1",
      platform: "x" as const,
      score: 40,
      review_state: "verified" as const,
      explanationJson: {}
    };
    const github = {
      entityId: "company-1",
      platform: "github" as const,
      score: 60,
      review_state: "verified" as const,
      explanationJson: {}
    };

    const company = aggregateCompanyScore({
      companyId: "company-1",
      batchSlug: "S2026",
      officialAccounts: [officialX, github],
      founderAccounts: [founderX],
      batchPeerCompositeScores: [20, 62.29, 90]
    });
    const founder = aggregateFounderScore({
      entityId: "founder-1",
      batchSlug: "S2026",
      platformScores: [founderX],
      relevanceToCompany: 1,
      batchPeerCompositeScores: [10, 40, 90]
    });

    expect(company.scoreExplanationJson.absoluteCompositeScore).toBe(58.28);
    expect(company.totalScore).toBe(33.33);
    expect(company.platformScoresJson.find((score) => score.platform === "github")?.sourceCoverage).toBe(0.6);
    expect(company.scoreExplanationJson.limitations).toContain(
      "Missing platforms were re-normalized; source coverage is incomplete."
    );
    expect(founder.totalScore).toBe(33.33);
    expect(founder.scoreExplanationJson.qualitySignals.relevanceToCompany).toBe(1);
  });

  it("exposes sourced baseline seed rows without making them cross-platform truth", () => {
    const instagramBaselines = baselineSeedsForPlatform("instagram");

    expect(instagramBaselines.length).toBeGreaterThan(0);
    expect(strongestBaselineReliability("instagram")).toBe("medium");
    expect(strongestBaselineReliability("github")).toBe("none");
    expect(instagramBaselines[0].notes).toContain("not be directly compared");
  });
});
