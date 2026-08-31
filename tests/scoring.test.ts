import { describe, expect, it } from "vitest";
import {
  aggregateBalancedTractionScore,
  computeEvidenceRawEngagement,
  normalizeEvidenceScores,
  platformScoresFromEvidence
} from "@/lib/graph/traction-scoring";
import type { CompanyRecord, EvidenceItem, Platform } from "@/lib/graph/types";
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
import { calibrateBatchCompanyScores } from "@/lib/scoring/batch-calibration";
import {
  aggregateEntityScore as aggregateLegacyEntityScore,
  aggregatePlatformScore as aggregateLegacyPlatformScore,
  calculateRawEngagement,
  scorePost as scoreLegacyPost
} from "@/lib/scoring/model";
import { TRACTION_SCORING_CONFIG } from "@/lib/scoring/traction-config";

describe("scoring formulas", () => {
  it("delegates weighted raw engagement to canonical platform metrics", () => {
    const metrics = {
      likes: 10,
      comments: 2,
      reposts: 1,
      views: 100,
      stars: 3,
      forks: 1
    };

    expect(computeWeightedRawEngagement(metrics)).toBe(computeEvidenceRawEngagement("x", metrics));
    expect(computeWeightedRawEngagement(metrics, "github")).toBe(
      computeEvidenceRawEngagement("github", metrics)
    );
  });

  it("adapts legacy post inputs to canonical v4 scoring", () => {
    const metrics = { likes: 10, comments: 2, reposts: 1, views: 100 };
    const result = scorePost({
      postId: "post-1",
      platform: "x",
      metrics,
      followerCount: 88,
      postedAt: "2026-06-01T00:00:00Z",
      collectedAt: "2026-07-01T00:00:00Z",
      percentileSamples: {
        logEngagement: [1, Math.log1p(22), 5],
        engagementRate: [0.1, 0.25, 0.5],
        momentum: [1, Math.log1p(22) * 0.5, 3]
      }
    });
    const canonical = normalizeEvidenceScores([
      canonicalEvidence("post-1", "x", 1, metrics, {
        sourceUrl: "https://x.com/legacy/status/1",
        platformPostId: "1",
        postedAt: "2026-06-01T00:00:00.000Z",
        publishedAtPrecision: "exact",
        metricsCheckedAt: "2026-07-01T00:00:00.000Z"
      })
    ])[0];

    expect(result.rawEngagement).toBe(canonical.rawEngagement);
    expect(result.normalizedScore).toBe(canonical.normalizedScore);
    expect(result.contributionScore).toBe(canonical.contributionScore);
    expect(result.explanationJson.platformLogPercentile).toBe(0.5);
    expect(result.explanationJson.engagementRatePercentile).toBe(
      percentileRank([0.1, 0.25, 0.5], result.engagementRate ?? 0)
    );
    expect(result.explanationJson.momentumPercentile).toBe(
      percentileRank(
        [1, Math.log1p(22) * 0.5, 3],
        result.explanationJson.momentumValue
      )
    );
    expect(result.explanationJson.limitations.join(" ")).toContain("canonical v4 computes the score");
  });

  it("keeps the legacy formula wrapper score invariant to publication age and missing dates", () => {
    const baseInput = {
      postId: "recency-neutral-legacy-formula",
      platform: "x" as const,
      metrics: { views: 50_000, likes: 250, comments: 20, reposts: 5 },
      collectedAt: "2026-07-01T00:00:00.000Z"
    };
    const scores = [
      scorePost({ ...baseInput, postedAt: baseInput.collectedAt }),
      scorePost({ ...baseInput, postedAt: "2000-01-01T00:00:00.000Z" }),
      scorePost({ ...baseInput, postedAt: null })
    ];
    const scoreProjection = scores.map((score) => ({
      rawEngagement: score.rawEngagement,
      normalizedScore: score.normalizedScore,
      contributionScore: score.contributionScore
    }));

    expect(scoreProjection.every((score) => score.contributionScore > 0)).toBe(true);
    expect(scoreProjection).toEqual(scoreProjection.map(() => scoreProjection[0]));
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

  it("adapts verified platform inputs to canonical evidence slots", () => {
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

    expect(platform.score).toBe(canonicalPlatformAggregate("github", [100, 90, 80, 70, 60]));
    expect(platform.review_state).toBe("verified");
    expect(platform.explanationJson.topPostAverage).toBe(95);
    expect(platform.explanationJson.topPostIds).toEqual([
      "post-0",
      "post-1"
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

  it("adapts company and founder scores to canonical bounded-primary aggregation", () => {
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

    const expectedCompany = canonicalEntityAggregate({
      x: canonicalPlatformAggregate("x", [80, 40]),
      github: canonicalPlatformAggregate("github", [60])
    });
    const expectedCompanyCalibration = canonicalCalibration(
      expectedCompany.absoluteScore,
      [20, 62.29, 90]
    );
    const expectedFounder = canonicalEntityAggregate({ x: 40 });
    const expectedFounderCalibration = canonicalCalibration(
      expectedFounder.absoluteScore,
      [10, 40, 90]
    );

    expect(company.scoreExplanationJson.absoluteCompositeScore).toBe(expectedCompany.absoluteScore);
    expect(company.totalScore).toBe(expectedCompanyCalibration.totalScore);
    expect(company.scoreExplanationJson.batchPercentile).toBe(
      expectedCompanyCalibration.scoreBreakdown?.calibration.percentile
    );
    expect(
      company.platformScoresJson.find((score) => score.platform === "github")?.sourceCoverage
    ).toBe(0.5);
    expect(company.scoreExplanationJson.limitations).toContain(
      "Canonical v4 coverage is incomplete across supported platforms."
    );
    expect(founder.scoreExplanationJson.absoluteCompositeScore).toBe(expectedFounder.absoluteScore);
    expect(founder.totalScore).toBe(expectedFounderCalibration.totalScore);
    expect(founder.scoreExplanationJson.qualitySignals.relevanceToCompany).toBe(1);
  });

  it("keeps legacy records out of canonical compatibility calibration", () => {
    const canonicalRows = [
      calibrationCompany("canonical-low", 30),
      calibrationCompany("canonical-high", 70)
    ];
    const legacy = calibrationCompany("legacy-high", 100, false);
    const baseline = calibrateBatchCompanyScores(canonicalRows);
    const mixed = calibrateBatchCompanyScores([canonicalRows[0], legacy, canonicalRows[1]]);

    expect([mixed[0], mixed[2]]).toEqual(baseline);
    expect(mixed[0]?.scoreBreakdown).toEqual(
      expect.objectContaining({
        modelId: TRACTION_SCORING_CONFIG.modelId,
        modelVersion: TRACTION_SCORING_CONFIG.version,
        calibration: expect.objectContaining({ cohortSize: 2 })
      })
    );
    expect(mixed[1]).toBe(legacy);
    expect(mixed[1]?.scoreBreakdown).toBeUndefined();
    expect(mixed[1]?.totalScore).toBe(100);
  });

  it("exposes sourced baseline seed rows without making them cross-platform truth", () => {
    const instagramBaselines = baselineSeedsForPlatform("instagram");

    expect(instagramBaselines.length).toBeGreaterThan(0);
    expect(strongestBaselineReliability("instagram")).toBe("medium");
    expect(strongestBaselineReliability("github")).toBe("none");
    expect(instagramBaselines[0].notes).toContain("not be directly compared");
  });
});

describe("legacy domain scoring compatibility", () => {
  it("keeps domain callers on the canonical metric, post, platform, and entity paths", () => {
    const metrics = {
      postId: "domain-post",
      collectedAt: "2026-07-01T00:00:00.000Z",
      views: 100,
      likes: 10,
      comments: 2,
      reposts: 1
    };
    const post = {
      id: "domain-post",
      socialAccountId: "account-1",
      platform: "x" as const,
      platformPostId: "domain-post",
      url: "https://x.com/legacy/status/1",
      authorName: "Legacy",
      authorHandle: "legacy",
      text: "",
      mediaType: "text" as const,
      postedAt: "2026-06-01T00:00:00.000Z",
      raw: {}
    };
    const account = {
      id: "account-1",
      entityType: "company" as const,
      entityId: "company-1",
      platform: "x" as const,
      handle: "legacy",
      url: "https://x.com/legacy",
      accountId: "legacy",
      followerCount: 88,
      followingCount: null,
      verified: false,
      review_state: "verified" as const,
      discoveredFromUrl: null,
      evidence: {}
    };
    const postScore = scoreLegacyPost(post, metrics, [], [], account);
    const oldPostScore = scoreLegacyPost(
      { ...post, postedAt: "2000-01-01T00:00:00.000Z" },
      metrics,
      [],
      [],
      account
    );
    const undatedPostScore = scoreLegacyPost(
      { ...post, postedAt: null },
      metrics,
      [],
      [],
      account
    );
    const platformScore = aggregateLegacyPlatformScore("x", [postScore], "verified");
    const entityScore = aggregateLegacyEntityScore("company", "company-1", [platformScore]);

    expect(calculateRawEngagement(metrics, "x")).toBe(
      computeEvidenceRawEngagement("x", {
        views: metrics.views,
        likes: metrics.likes,
        comments: metrics.comments,
        reposts: metrics.reposts
      })
    );
    expect(postScore.normalizedScore).toBeGreaterThan(0);
    expect(oldPostScore.normalizedScore).toBe(postScore.normalizedScore);
    expect(oldPostScore.contributionScore).toBe(postScore.contributionScore);
    expect(undatedPostScore.normalizedScore).toBe(postScore.normalizedScore);
    expect(undatedPostScore.contributionScore).toBe(postScore.contributionScore);
    expect(postScore.explanation.qualitySignals.modelVersion).toBe(TRACTION_SCORING_CONFIG.version);
    expect(platformScore.score).toBe(canonicalPlatformAggregate("x", [postScore.normalizedScore]));
    expect(entityScore.totalScore).toBe(canonicalEntityAggregate({ x: platformScore.score }).absoluteScore);
  });
});

function canonicalPlatformAggregate(platform: Platform, scores: number[]): number {
  return (
    platformScoresFromEvidence(
      scores.map((score, index) => canonicalEvidence(`platform-${platform}-${index}`, platform, score))
    )[platform] ?? 0
  );
}

function canonicalEntityAggregate(platformScores: Partial<Record<Platform, number>>) {
  const evidence = (Object.entries(platformScores) as Array<[Platform, number]>).flatMap(
    ([platform, score]) =>
      TRACTION_SCORING_CONFIG.platformEvidenceSlots.map((_, index) =>
        canonicalEvidence(`entity-${platform}-${index}`, platform, score)
      )
  );

  return aggregateBalancedTractionScore(evidence);
}

function canonicalCalibration(absoluteScore: number, peers: number[]): CompanyRecord {
  const [calibrated] = calibrateBatchCompanyScores(
    [absoluteScore, ...peers].map((score, index) =>
      calibrationCompany(`calibration-${index}`, score)
    )
  );

  if (!calibrated) {
    throw new Error("Expected a canonical calibration result.");
  }

  return calibrated;
}

function calibrationCompany(id: string, score: number, canonical = true): CompanyRecord {
  const sourceUrl = `https://legacy.invalid/calibration/${id}`;
  const scoreBreakdown = canonical
    ? {
        ...aggregateBalancedTractionScore([]),
        modelId: TRACTION_SCORING_CONFIG.modelId,
        modelVersion: TRACTION_SCORING_CONFIG.version,
        modelName: TRACTION_SCORING_CONFIG.name,
        totalScore: score,
        absoluteScore: score,
        calibration: {
          method: "none" as const,
          cohortSize: 0,
          percentile: null,
          inputScore: score
        },
        explanation: "Scoring compatibility test."
      }
    : undefined;

  return {
    id,
    batchSlug: "test",
    name: id,
    ycProfileUrl: sourceUrl,
    websiteUrl: sourceUrl,
    tagline: id,
    description: id,
    groupPartner: null,
    primaryIndustry: "test",
    businessModel: "b2b",
    review_state: "verified",
    sourceUrl,
    industries: [],
    founderIds: [],
    socialAccounts: [],
    totalScore: score,
    previousScore: score,
    platformScores: scoreBreakdown?.platformScores ?? {},
    scoreBreakdown
  };
}

function canonicalEvidence(
  id: string,
  platform: Platform,
  contributionScore: number,
  metrics: EvidenceItem["metrics"] = {},
  overrides: Partial<EvidenceItem> = {}
): EvidenceItem {
  const nativeEvidence = canonicalNativeEvidence(platform, id);

  return {
    id,
    entityType: "company",
    entityId: "company-1",
    platform,
    authorName: "Compatibility test",
    authorHandle: "compatibility",
    postedAt: "1970-01-01T00:00:00.000Z",
    publishedAtPrecision: "unknown",
    text: "",
    mediaType: "unknown",
    metrics: Object.keys(metrics).length > 0 ? metrics : nativeEvidence.metrics,
    contributionScore,
    sourceUrl: nativeEvidence.sourceUrl,
    platformPostId: null,
    why: "Scoring compatibility test.",
    review_state: "verified",
    ...overrides
  };
}

function canonicalNativeEvidence(
  platform: Platform,
  identitySeed: string
): Pick<EvidenceItem, "metrics" | "sourceUrl"> {
  const suffix = stableTestNumber(identitySeed);

  switch (platform) {
    case "x":
      return { metrics: { likes: 1 }, sourceUrl: `https://x.com/compatibility/status/${suffix}` };
    case "instagram":
      return { metrics: { likes: 1 }, sourceUrl: `https://www.instagram.com/p/Compat${suffix}/` };
    case "linkedin":
      return {
        metrics: { reactions: 1 },
        sourceUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${suffix}`
      };
    case "github":
      return { metrics: { stars: 1 }, sourceUrl: `https://github.com/compatibility/score-${suffix}` };
    case "youtube":
      return { metrics: { views: 1 }, sourceUrl: `https://www.youtube.com/watch?v=Compat${suffix}` };
    case "product_hunt":
      return {
        metrics: { upvotes: 1 },
        sourceUrl: `https://www.producthunt.com/posts/compat-${suffix}`
      };
    case "hacker_news":
      return {
        metrics: { upvotes: 1 },
        sourceUrl: `https://news.ycombinator.com/item?id=${suffix}`
      };
    case "reddit":
      return {
        metrics: { upvotes: 1 },
        sourceUrl: `https://www.reddit.com/r/startups/comments/${suffix.toString(36)}/compatibility/`
      };
    case "bilibili":
      return { metrics: { views: 1 }, sourceUrl: `https://www.bilibili.com/video/BV${suffix}/` };
    default:
      throw new Error(`No canonical test evidence fixture for ${platform}.`);
  }
}

function stableTestNumber(value: string): number {
  let hash = 2_166_136_261;

  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }

  return (hash >>> 0) + 1;
}
