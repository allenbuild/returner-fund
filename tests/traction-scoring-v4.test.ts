import { describe, expect, it, vi } from "vitest";
import { calibrateBatchCompanyScores } from "@/lib/scoring/batch-calibration";
import { canonicalPostKey, dedupeEvidenceForScoring } from "@/lib/graph/dedupe";
import {
  aggregateBalancedTractionScore,
  computeEvidenceRawEngagement,
  isNativeEvidenceUrl,
  normalizeEvidenceScores,
  scoringEligibility
} from "@/lib/graph/traction-scoring";
import { TRACTION_SCORING_CONFIG } from "@/lib/graph/traction-scoring-config";
import type {
  CompanyRecord,
  EvidenceItem,
  EvidenceMetrics,
  Platform,
  ScoreBreakdown
} from "@/lib/graph/types";

const FIXED_TIME = "2026-07-15T12:00:00.000Z";
const SUPPORTED_PLATFORMS = Object.keys(TRACTION_SCORING_CONFIG.platformWeights) as Platform[];

const aliasCases: Array<{
  platform: Platform;
  canonical: EvidenceMetrics;
  aliases: EvidenceMetrics;
}> = [
  {
    platform: "x",
    canonical: { replies: 12, reposts: 8 },
    aliases: { comments: 12, shares: 8 }
  },
  {
    platform: "linkedin",
    canonical: { reactions: 50, comments: 10, reposts: 3 },
    aliases: { likes: 50, replies: 10, shares: 3 }
  },
  {
    platform: "instagram",
    canonical: { comments: 10, shares: 3 },
    aliases: { replies: 10, reposts: 3 }
  },
  {
    platform: "github",
    canonical: { issues: 12 },
    aliases: { open_issues: 12 }
  }
];

const invalidNativeUrls: Array<[Platform, string]> = [
  ["x", "https://x.com/returnerfund"],
  ["x", "https://x.com/search?q=returner%20fund"],
  ["instagram", "https://www.instagram.com/returnerfund/"],
  ["instagram", "https://www.instagram.com/explore/search/keyword/?q=returner"],
  ["linkedin", "https://www.linkedin.com/company/returner-fund/"],
  ["linkedin", "https://www.linkedin.com/search/results/content/?keywords=returner"],
  ["youtube", "https://www.youtube.com/@returnerfund"],
  ["youtube", "https://www.youtube.com/results?search_query=returner+fund"],
  ["reddit", "https://www.reddit.com/user/returnerfund/"],
  ["reddit", "https://www.reddit.com/search/?q=returner%20fund"],
  ["hacker_news", "https://news.ycombinator.com/news"],
  ["hacker_news", "https://news.ycombinator.com/from?site=returner.fund"],
  ["product_hunt", "https://www.producthunt.com/products/returner-fund"],
  ["product_hunt", "https://www.producthunt.com/search?q=returner%20fund"],
  ["bilibili", "https://space.bilibili.com/3546769999999999"],
  ["bilibili", "https://search.bilibili.com/all?keyword=returner"],
  ["github", "https://github.com/returner-fund"],
  ["github", "https://github.com/search/advanced?q=returner-fund"],
  ["github", "https://github.com/returner-fund/traction-demo/issues/1"],
  ["instagram", "https://instagram.com.evil.example/p/ABC123"],
  ["linkedin", "https://notlinkedin.com/posts/test_activity-123"],
  ["youtube", "https://youtube.com.evil.example/watch?v=Returner1"],
  ["youtube", "https://www.youtube.com/results?v=Returner1"],
  ["reddit", "https://reddit.com.evil.example/r/test/comments/abc123/title"],
  ["hacker_news", "https://news.ycombinator.com/item?id=not-a-number"],
  ["hacker_news", "https://news.ycombinator.com/item?id=123abc"],
  ["product_hunt", "https://producthunt.com.evil.example/posts/returner"],
  ["bilibili", "https://bilibili.com.evil.example/video/BV1Returner"]
];

const supportedMetricCases = (
  Object.entries(TRACTION_SCORING_CONFIG.metricWeights) as Array<[
    Platform,
    Record<string, number | undefined>
  ]>
).flatMap(([platform, weights]) =>
  Object.entries(weights)
    .filter(([, weight]) => Number.isFinite(weight) && Number(weight) > 0)
    .map(([metric]) => ({ platform, metric }))
);

describe("traction scoring v4 invariants", () => {
  it("keeps canonical platform weights normalized", () => {
    const weights = Object.values(TRACTION_SCORING_CONFIG.platformWeights);

    expect(weights.every((weight) => Number.isFinite(weight) && Number(weight) > 0)).toBe(true);
    expect(weights.reduce((sum, weight) => sum + Number(weight), 0)).toBeCloseTo(1, 12);
  });

  it("keeps calibration and confidence heuristics in the canonical versioned config", () => {
    const calibration = TRACTION_SCORING_CONFIG.batchCalibration;
    const confidence = TRACTION_SCORING_CONFIG.confidence;

    expect(calibration.absoluteScoreWeight + calibration.cohortPercentileWeight).toBe(1);
    expect(
      confidence.base +
        confidence.evidenceDepthWeight +
        confidence.platformBreadthWeight +
        confidence.publicationDateWeight +
        confidence.verifiedLinkWeight
    ).toBe(1);
    expect(confidence.mediumThreshold).toBeLessThan(confidence.highThreshold);
    expect("topKPosts" in TRACTION_SCORING_CONFIG).toBe(false);
  });

  it.each(aliasCases)("counts $platform metric aliases once", ({ platform, canonical, aliases }) => {
    const canonicalScore = computeEvidenceRawEngagement(platform, canonical);

    expect(computeEvidenceRawEngagement(platform, aliases)).toBe(canonicalScore);
    expect(computeEvidenceRawEngagement(platform, { ...canonical, ...aliases })).toBe(canonicalScore);
  });

  it("ignores negative, non-finite, and unknown metrics", () => {
    const cleanMetrics: EvidenceMetrics = { likes: 20 };
    const contaminatedMetrics: EvidenceMetrics = {
      likes: 20,
      views: -1_000_000,
      replies: Number.POSITIVE_INFINITY,
      reposts: Number.NaN,
      unsupported_vanity_metric: Number.MAX_VALUE
    };
    const scored = normalizeEvidenceScores([
      evidence("clean-metrics", "x", cleanMetrics),
      evidence("contaminated-metrics", "x", contaminatedMetrics)
    ]);

    expect(computeEvidenceRawEngagement("x", contaminatedMetrics)).toBe(
      computeEvidenceRawEngagement("x", cleanMetrics)
    );
    expect(
      computeEvidenceRawEngagement("x", {
        likes: -1,
        views: Number.NEGATIVE_INFINITY,
        replies: Number.NaN,
        unsupported_vanity_metric: Number.MAX_VALUE
      })
    ).toBe(0);
    expect(scored.find((item) => item.id === "contaminated-metrics")?.contributionScore).toBe(
      scored.find((item) => item.id === "clean-metrics")?.contributionScore
    );
  });

  it("accepts native evidence URLs and rejects profiles, search results, and generic pages", () => {
    for (const platform of SUPPORTED_PLATFORMS) {
      expect(isNativeEvidenceUrl(platform, nativeUrl(platform, 1)), platform).toBe(true);
    }

    for (const [platform, url] of invalidNativeUrls) {
      expect(isNativeEvidenceUrl(platform, url), `${platform}: ${url}`).toBe(false);
    }

    expect(isNativeEvidenceUrl("reddit", "https://redd.it/1u2vv0c")).toBe(true);
    expect(isNativeEvidenceUrl("youtube", "https://www.youtube.com/live/FTVKNZtv7-o")).toBe(true);

    expect(
      scoringEligibility(
        evidence("x-profile", "x", { likes: 10 }, { sourceUrl: "https://x.com/returnerfund" })
      )
    ).toEqual({ eligible: false, reason: "not_native_evidence" });
  });

  it("quarantines a valid URL whose explicit GitHub repo ID disagrees", () => {
    const conflicted = evidence("github-conflict", "github", { stars: 50 }, {
      sourceUrl: "https://github.com/Returner-Fund/traction-demo",
      platformPostId: "returner-fund/different-repo"
    });

    expect(scoringEligibility(conflicted)).toEqual({ eligible: false, reason: "identity_conflict" });
    expect(normalizeEvidenceScores([conflicted])[0]?.contributionScore).toBe(0);
  });

  it("derives reference time only from eligible physical observation timestamps", () => {
    const target = evidence("clock-target", "x", { views: 80_000, likes: 500 }, {
      postedAt: "2026-06-15T12:00:00.000Z"
    });
    const futurePublication = evidence("future-publication", "instagram", { likes: 100 }, {
      postedAt: "2099-01-01T00:00:00.000Z",
      observedAt: FIXED_TIME,
      metricsCheckedAt: FIXED_TIME
    });
    const rejectedFutureObservation = evidence("rejected-future-observation", "youtube", { views: 1_000 }, {
      postedAt: "2099-01-01T00:00:00.000Z",
      observedAt: "2100-01-01T00:00:00.000Z",
      metricsCheckedAt: "2100-01-01T00:00:00.000Z",
      review_state: "rejected"
    });

    const baseline = normalizeEvidenceScores([target])[0];
    const poisoned = normalizeEvidenceScores([target, futurePublication, rejectedFutureObservation])
      .find((item) => item.id === target.id);
    const laterAsOf = normalizeEvidenceScores([target], { asOf: "2027-07-15T12:00:00.000Z" })[0];

    expect(poisoned?.contributionScore).toBe(baseline?.contributionScore);
    expect(laterAsOf?.contributionScore).toBeLessThan(baseline?.contributionScore ?? 0);
  });

  it("is independent of Date.now and bounds future observations with an explicit scoring clock", () => {
    const target = evidence("wall-clock-target", "x", { views: 80_000, likes: 500 }, {
      postedAt: "2026-06-15T12:00:00.000Z"
    });
    const futureObservation = evidence(
      "wall-clock-future-observation",
      "instagram",
      { likes: 100 },
      {
        observedAt: "2030-01-01T00:00:00.000Z",
        metricsCheckedAt: "2030-01-01T00:00:00.000Z"
      }
    );
    const dateNow = vi.spyOn(Date, "now");

    try {
      dateNow.mockReturnValue(Date.parse(FIXED_TIME));
      const scoredWithEarlierWallClock = contributionScores([target, futureObservation]);
      dateNow.mockReturnValue(Date.parse("2031-01-01T00:00:00.000Z"));
      const scoredWithLaterWallClock = contributionScores([target, futureObservation]);

      expect(scoredWithLaterWallClock).toEqual(scoredWithEarlierWallClock);
    } finally {
      dateNow.mockRestore();
    }

    const explicitBaseline = normalizeEvidenceScores([target], { asOf: FIXED_TIME })[0];
    const explicitWithFuture = normalizeEvidenceScores([target, futureObservation], { asOf: FIXED_TIME })
      .find((item) => item.id === target.id);

    expect(explicitWithFuture?.contributionScore).toBe(explicitBaseline?.contributionScore);
  });

  it("does not let a future duplicate observation age unrelated evidence against an explicit clock", () => {
    const target = evidence("future-duplicate-target", "x", { views: 80_000, likes: 500 }, {
      postedAt: "2026-06-15T12:00:00.000Z"
    });
    const anchor = evidence("future-duplicate-anchor", "instagram", { likes: 100 });
    const futureAnchor = {
      ...anchor,
      id: "future-duplicate-anchor-copy",
      metrics: { likes: 200 },
      observedAt: "2100-01-01T00:00:00.000Z",
      metricsCheckedAt: "2100-01-01T00:00:00.000Z"
    };

    const baseline = normalizeEvidenceScores([target, anchor], { asOf: FIXED_TIME })
      .find((item) => item.id === target.id);
    const withFutureDuplicate = normalizeEvidenceScores(
      [target, anchor, futureAnchor],
      { asOf: FIXED_TIME }
    )
      .find((item) => item.id === target.id);

    expect(withFutureDuplicate?.contributionScore).toBe(baseline?.contributionScore);
  });

  it("requires an explicit verified review state for canonical scoring", () => {
    const unreviewed = evidence("missing-review-state", "x", { views: 10_000, likes: 100 }, {
      review_state: undefined
    });

    expect(scoringEligibility(unreviewed)).toEqual({ eligible: false, reason: "not_verified" });
    expect(normalizeEvidenceScores([unreviewed], { asOf: FIXED_TIME })[0]?.contributionScore).toBe(0);
  });

  it("supports ingestedAt and an explicit deterministic asOf clock", () => {
    const ingestedOnly = {
      ...evidence("ingested-clock", "x", { views: 80_000, likes: 500 }, {
        postedAt: "2025-07-15T12:00:00.000Z",
        observedAt: null,
        metricsCheckedAt: null,
        first_seen_at: undefined,
        last_checked_at: undefined,
        last_updated_at: undefined
      }),
      ingestedAt: FIXED_TIME
    };

    const inferred = normalizeEvidenceScores([ingestedOnly])[0];
    const explicitOptions = normalizeEvidenceScores([ingestedOnly], { asOf: FIXED_TIME })[0];
    const explicitString = normalizeEvidenceScores([ingestedOnly], FIXED_TIME)[0];

    expect(inferred?.contributionScore).toBe(explicitOptions?.contributionScore);
    expect(explicitString?.contributionScore).toBe(explicitOptions?.contributionScore);
  });

  it("replaces the prior canonical rationale whenever evidence is rescored", () => {
    const original = evidence("replace-score-rationale", "x", { views: 80_000, likes: 500 }, {
      postedAt: FIXED_TIME,
      why: "Original source provenance remains visible."
    });
    const first = normalizeEvidenceScores([original], { asOf: FIXED_TIME })[0]!;
    const rescored = normalizeEvidenceScores([first], { asOf: "2028-07-15T12:00:00.000Z" })[0]!;

    expect(rescored.contributionScore).toBeLessThan(first.contributionScore);
    expect(rescored.why).toContain("Original source provenance remains visible.");
    expect(rescored.why.match(new RegExp(TRACTION_SCORING_CONFIG.name, "g"))).toHaveLength(1);
    expect(rescored.why).toContain(`scored ${rescored.contributionScore}/100.`);
    expect(rescored.why).not.toContain(`scored ${first.contributionScore}/100.`);
  });

  it("builds percentiles from eligible physical posts rather than attribution rows", () => {
    const low = evidence("percentile-low", "x", { likes: 10 });
    const target = evidence("percentile-target", "x", { likes: 100 });
    const high = evidence("percentile-high", "x", { likes: 1_000 });
    const duplicatedLow = {
      ...low,
      id: "percentile-low-founder-attribution",
      entityType: "founder" as const,
      entityId: "founder-returner",
      sourceUrl: low.sourceUrl.replace("x.com", "twitter.com"),
      platformPostId: low.sourceUrl.match(/status\/(\d+)/)?.[1] ?? null
    };
    const blockedExtremeDuplicate = {
      ...low,
      id: "percentile-low-blocked-snapshot",
      entityId: "company-blocked",
      metrics: { likes: 1_000_000_000 },
      linkStatus: "blocked" as const,
      observedAt: "2100-01-01T00:00:00.000Z",
      metricsCheckedAt: "2100-01-01T00:00:00.000Z"
    };

    const baseline = normalizeEvidenceScores([low, target, high], { asOf: FIXED_TIME });
    const duplicated = normalizeEvidenceScores(
      [low, duplicatedLow, blockedExtremeDuplicate, target, high],
      { asOf: FIXED_TIME }
    );

    expect(duplicated.find((item) => item.id === target.id)?.contributionScore).toBe(
      baseline.find((item) => item.id === target.id)?.contributionScore
    );
    expect(duplicated.find((item) => item.id === blockedExtremeDuplicate.id)?.contributionScore).toBe(0);
  });

  it("scores one physical post once across company/founder and ID/URL representations", () => {
    const physicalPostId = "1849812345678901234";
    const companyRow = evidence(
      "company-url-row",
      "x",
      { views: 25_000, likes: 200 },
      {
        entityType: "company",
        entityId: "company-returner",
        sourceUrl: `https://x.com/returnerfund/status/${physicalPostId}?utm_source=company`,
        platformPostId: null,
        contributionScore: 72,
        last_checked_at: "2026-07-14T12:00:00.000Z"
      }
    );
    const founderRow = evidence(
      "founder-id-row",
      "x",
      { views: 30_000, likes: 250 },
      {
        entityType: "founder",
        entityId: "founder-returner",
        sourceUrl: `https://twitter.com/returnerfounder/status/${physicalPostId}?s=20`,
        platformPostId: physicalPostId,
        contributionScore: 80,
        last_checked_at: FIXED_TIME
      }
    );

    expect(canonicalPostKey(companyRow)).toBe(canonicalPostKey(founderRow));
    expect(dedupeEvidenceForScoring([companyRow, founderRow])).toEqual([founderRow]);
    expect(dedupeEvidenceForScoring([founderRow, companyRow])).toEqual([founderRow]);

    const duplicateScore = aggregateBalancedTractionScore([companyRow, founderRow]);
    const uniqueScore = aggregateBalancedTractionScore([founderRow]);

    expect(duplicateScore.totalScore).toBe(uniqueScore.totalScore);
    expect(duplicateScore.platformScores).toEqual(uniqueScore.platformScores);
    expect(duplicateScore.weightedPlatforms[0]?.evidenceCount).toBe(1);
  });

  it("revalidates canonical eligibility when aggregating direct evidence", () => {
    const rejected = evidence("direct-rejected-row", "x", { views: 1_000_000, likes: 10_000 }, {
      contributionScore: 99,
      normalizedScore: 99,
      tractionStatus: "scored",
      review_state: "rejected"
    });
    const missingReview = evidence("direct-unreviewed-row", "instagram", { likes: 10_000 }, {
      contributionScore: 99,
      normalizedScore: 99,
      tractionStatus: "scored",
      review_state: undefined
    });

    const breakdown = aggregateBalancedTractionScore([rejected, missingReview]);

    expect(breakdown.totalScore).toBe(0);
    expect(breakdown.confidence.scoredEvidenceCount).toBe(0);
    expect(breakdown.weightedPlatforms).toEqual([]);
  });

  it("derives the confidence band from the same rounded value it exposes", () => {
    const rows = Array.from({ length: 96 }, (_, index) =>
      evidence(`confidence-threshold-${index}`, "x", { likes: 1 }, {
        contributionScore: 50,
        postedAt: index < 14 ? FIXED_TIME : "",
        publishedAtPrecision: index < 14 ? "exact" : "unknown",
        linkStatus: index < 95 ? "verified" : "unchecked"
      })
    );
    const confidence = aggregateBalancedTractionScore(rows).confidence;

    expect(confidence).toMatchObject({
      value: TRACTION_SCORING_CONFIG.confidence.highThreshold,
      level: "high",
      scoredEvidenceCount: 96,
      datedEvidenceCount: 14,
      verifiedLinkCount: 95
    });
  });

  it("is invariant to evidence permutations", () => {
    const rows = [
      evidence("permutation-x-strong", "x", { views: 120_000, likes: 450, replies: 30 }),
      evidence("permutation-x-tail", "x", { views: 8_000, likes: 40, replies: 3 }),
      evidence("permutation-instagram", "instagram", { views: 75_000, likes: 800, comments: 45 }),
      evidence("permutation-github", "github", { stars: 900, forks: 85, recent_commits_30d: 18 })
    ];
    const expected = scoringProjection(rows);

    for (const permutation of permutations(rows)) {
      expect(scoringProjection(permutation)).toEqual(expected);
    }
  });

  it("uses platform ID to break equal score and configured-weight ties", () => {
    const github = evidence("tie-github", "github", { stars: 1 }, { contributionScore: 80 });
    const linkedin = evidence("tie-linkedin", "linkedin", { reactions: 1 }, { contributionScore: 80 });

    for (const rows of [[linkedin, github], [github, linkedin]]) {
      expect(aggregateBalancedTractionScore(rows).weightedPlatforms[0]?.platform).toBe("github");
    }

    const ordered = aggregateBalancedTractionScore([
      linkedin,
      github,
      evidence("tie-top-x", "x", { likes: 1 }, { contributionScore: 90 })
    ]).weightedPlatforms.map((item) => item.platform);
    expect(ordered).toEqual(["x", "github", "linkedin"]);
  });

  it("cannot lower platform or company score when a positive unique weaker row is added", () => {
    const strong = evidence("monotone-strong", "x", { views: 250_000, likes: 1_200, replies: 80, reposts: 30 });
    const weak = evidence("monotone-weak", "x", { views: 500, likes: 3 });
    const baseline = scoreCohort([strong]);
    const augmented = scoreCohort([strong, weak]);

    expect(augmented.scored.find((item) => item.id === weak.id)?.contributionScore).toBeGreaterThan(0);
    expect(augmented.aggregate.platformScores.x).toBeGreaterThanOrEqual(baseline.aggregate.platformScores.x ?? 0);
    expect(augmented.aggregate.totalScore).toBeGreaterThanOrEqual(baseline.aggregate.totalScore);
  });

  it.each(supportedMetricCases)(
    "cannot lower $platform evidence score when supported metric $metric increases in a fixed cohort",
    ({ platform, metric }) => {
      const low = evidence(`metric-${platform}-${metric}-low`, platform, { [metric]: 5 });
      const target = evidence(`metric-${platform}-${metric}-target`, platform, { [metric]: 20 });
      const high = evidence(`metric-${platform}-${metric}-high`, platform, { [metric]: 200 });
      const increasedTarget = { ...target, metrics: { [metric]: 40 } };
      const before = normalizeEvidenceScores([low, target, high]);
      const after = normalizeEvidenceScores([low, increasedTarget, high]);
      const beforeTarget = before.find((item) => item.id === target.id);
      const afterTarget = after.find((item) => item.id === target.id);

      expect(computeEvidenceRawEngagement(platform, increasedTarget.metrics)).toBeGreaterThan(
        computeEvidenceRawEngagement(platform, target.metrics)
      );
      expect(afterTarget?.contributionScore).toBeGreaterThanOrEqual(beforeTarget?.contributionScore ?? 0);
    }
  );

  it("bounds the effect of an unrelated same-platform extreme outlier", () => {
    const existing = [
      evidence("outlier-low", "x", { views: 1_000, likes: 10 }),
      evidence("outlier-mid", "x", { views: 25_000, likes: 150 }),
      evidence("outlier-high", "x", { views: 250_000, likes: 1_500 })
    ];
    const outlier = evidence(
      "unrelated-outlier",
      "x",
      { views: 1_000_000_000_000_000, likes: 1_000_000_000_000 },
      { entityId: "company-unrelated-outlier" }
    );
    const withoutOutlier = contributionScores(existing);
    const withOutlier = contributionScores([...existing, outlier]);

    expect(existing.map((item) => withoutOutlier.get(item.id))).toEqual(
      [...existing]
        .sort((left, right) => computeEvidenceRawEngagement("x", left.metrics) - computeEvidenceRawEngagement("x", right.metrics))
        .map((item) => withoutOutlier.get(item.id))
    );
    for (const item of existing) {
      expect(Math.abs((withOutlier.get(item.id) ?? 0) - (withoutOutlier.get(item.id) ?? 0))).toBeLessThanOrEqual(4);
    }
  });

  it("scores a missing-date singleton more conservatively than an equally engaged fresh singleton", () => {
    const metrics = { views: 80_000, likes: 700, comments: 35 };
    const fresh = normalizeEvidenceScores([
      evidence("fresh-singleton", "instagram", metrics, {
        postedAt: FIXED_TIME,
        publishedAtPrecision: "exact"
      })
    ])[0];
    const missingDate = normalizeEvidenceScores([
      evidence("missing-date-singleton", "instagram", metrics, {
        postedAt: FIXED_TIME,
        publishedAtPrecision: "unknown"
      })
    ])[0];

    expect(missingDate?.rawEngagement).toBe(fresh?.rawEngagement);
    expect(missingDate?.contributionScore).toBeLessThan(fresh?.contributionScore ?? 0);
    expect(missingDate?.why).toContain("conservative momentum");
  });

  it("does not penalize a saturated platform because unrelated platforms are absent", () => {
    const onePlatformRows = perfectPlatformRows("x");
    const allPlatformRows = SUPPORTED_PLATFORMS.flatMap((platform) => perfectPlatformRows(platform));
    const onePlatform = aggregateBalancedTractionScore(onePlatformRows);
    const allPlatforms = aggregateBalancedTractionScore(allPlatformRows);

    expect(onePlatform.platformScores.x).toBe(100);
    expect(onePlatform.totalScore).toBe(allPlatforms.totalScore);
    expect(onePlatform.totalScore).toBe(100);
    expect(allPlatforms.totalScore).toBe(100);
    expect(allPlatforms.coverageFactor).toBe(1);
  });

  it("never calibrates real positive evidence to zero", () => {
    const lowPositive = scoreCohort([evidence("calibration-low", "x", { likes: 1 })]).aggregate;
    const highPositive = aggregateBalancedTractionScore(
      SUPPORTED_PLATFORMS.flatMap((platform) => perfectPlatformRows(platform, "calibration"))
    );
    const calibrated = calibrateBatchCompanyScores([
      calibrationCompany("low-positive", lowPositive),
      calibrationCompany("high-positive", highPositive)
    ]);
    const positiveRows = calibrated.filter((company) => (company.scoreBreakdown?.absoluteScore ?? 0) > 0);

    expect(lowPositive.absoluteScore).toBeGreaterThan(0);
    expect(positiveRows).toHaveLength(2);
    expect(positiveRows.every((company) => company.totalScore >= 1)).toBe(true);
    expect(positiveRows.every((company) => company.scoreBreakdown?.calibration.method === "tie_aware_percentile_blend")).toBe(true);
  });

  it("does not let legacy companies without canonical breakdowns distort calibration", () => {
    const canonical = calibrationCompany(
      "canonical-calibration-row",
      aggregateBalancedTractionScore(
        normalizeEvidenceScores(
          [evidence("canonical-calibration-evidence", "x", { views: 50_000, likes: 250 })],
          { asOf: FIXED_TIME }
        )
      )
    );
    const legacy: CompanyRecord = {
      ...canonical,
      id: "legacy-calibration-row",
      name: "Legacy calibration row",
      totalScore: 100,
      previousScore: 100,
      scoreBreakdown: undefined
    };

    const baseline = calibrateBatchCompanyScores([canonical])[0]!;
    const mixed = calibrateBatchCompanyScores([canonical, legacy]);

    expect(mixed[0]?.totalScore).toBe(baseline.totalScore);
    expect(mixed[0]?.scoreBreakdown?.calibration.cohortSize).toBe(1);
    expect(mixed[1]).toEqual(legacy);
  });
});

function evidence(
  id: string,
  platform: Platform,
  metrics: EvidenceMetrics,
  overrides: Partial<EvidenceItem> = {}
): EvidenceItem {
  const { metrics: overrideMetrics, ...itemOverrides } = overrides;

  return {
    id,
    entityType: "company",
    entityId: "company-returner",
    platform,
    authorName: "Returner Fund",
    authorHandle: "returnerfund",
    postedAt: FIXED_TIME,
    publishedAtPrecision: "exact",
    observedAt: FIXED_TIME,
    metricsCheckedAt: FIXED_TIME,
    text: "Returner Fund traction update",
    mediaType: mediaTypeFor(platform),
    linkStatus: "verified",
    contributionScore: 1,
    sourceUrl: nativeUrl(platform, stableNumber(id)),
    platformPostId: null,
    first_seen_at: FIXED_TIME,
    last_checked_at: FIXED_TIME,
    last_updated_at: FIXED_TIME,
    why: "Deterministic traction scoring fixture.",
    review_state: "verified",
    ...itemOverrides,
    metrics: overrideMetrics ?? metrics
  };
}

function nativeUrl(platform: Platform, index: number): string {
  const suffix = Math.max(1, Math.floor(index));

  switch (platform) {
    case "x":
      return `https://x.com/returnerfund/status/${1849812345000000000n + BigInt(suffix)}`;
    case "instagram":
      return `https://www.instagram.com/reel/C8Returner${suffix}/`;
    case "linkedin":
      return `https://www.linkedin.com/posts/returner-fund_traction-update-activity-${7468000000000000000n + BigInt(suffix)}-Rf${suffix}`;
    case "github":
      return `https://github.com/returner-fund/traction-demo-${suffix}`;
    case "youtube":
      return `https://www.youtube.com/watch?v=Returner${suffix}`;
    case "product_hunt":
      return `https://www.producthunt.com/posts/returner-traction-${suffix}`;
    case "hacker_news":
      return `https://news.ycombinator.com/item?id=${40_000_000 + (suffix % 9_000_000)}`;
    case "reddit":
      return `https://www.reddit.com/r/startups/comments/rt${suffix.toString(36)}/returner_fund_launch/`;
    case "bilibili":
      return `https://www.bilibili.com/video/BV1Returner${suffix}/`;
    default:
      throw new Error(`No native scoring URL fixture for ${platform}`);
  }
}

function mediaTypeFor(platform: Platform): EvidenceItem["mediaType"] {
  if (platform === "github") return "repo";
  if (platform === "product_hunt") return "launch";
  if (["instagram", "youtube", "bilibili"].includes(platform)) return "video";
  return "text";
}

function positiveMetrics(platform: Platform): EvidenceMetrics {
  if (platform === "github") return { stars: 1 };
  if (platform === "product_hunt" || platform === "hacker_news" || platform === "reddit") return { upvotes: 1 };
  if (platform === "youtube" || platform === "bilibili") return { views: 1 };
  if (platform === "linkedin") return { reactions: 1 };
  return { likes: 1 };
}

function scoreCohort(rows: EvidenceItem[]): {
  scored: EvidenceItem[];
  aggregate: ScoreBreakdown;
} {
  const scored = normalizeEvidenceScores(rows);
  return { scored, aggregate: aggregateBalancedTractionScore(scored) };
}

function scoringProjection(rows: EvidenceItem[]) {
  const { scored, aggregate } = scoreCohort(rows);

  return {
    evidence: scored
      .map((item) => ({
        id: item.id,
        rawEngagement: item.rawEngagement,
        contributionScore: item.contributionScore
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    totalScore: aggregate.totalScore,
    absoluteScore: aggregate.absoluteScore,
    platformScores: Object.entries(aggregate.platformScores).sort(([left], [right]) => left.localeCompare(right)),
    weightedPlatforms: aggregate.weightedPlatforms
      .map((item) => ({ ...item }))
      .sort((left, right) => left.platform.localeCompare(right.platform)),
    signalFamilyScores: aggregate.signalFamilyScores,
    confidence: aggregate.confidence
  };
}

function contributionScores(rows: EvidenceItem[]): Map<string, number> {
  return new Map(normalizeEvidenceScores(rows).map((item) => [item.id, item.contributionScore]));
}

function perfectPlatformRows(platform: Platform, prefix = "cap"): EvidenceItem[] {
  return TRACTION_SCORING_CONFIG.platformEvidenceSlots.map((_, index) =>
    evidence(`${prefix}-${platform}-${index}`, platform, positiveMetrics(platform), { contributionScore: 100 })
  );
}

function calibrationCompany(id: string, scoreBreakdown: ScoreBreakdown): CompanyRecord {
  return {
    id,
    batchSlug: "test-v4",
    name: id,
    ycProfileUrl: `https://www.ycombinator.com/companies/${id}`,
    websiteUrl: `https://${id}.example.com`,
    tagline: "Deterministic scoring fixture",
    description: "Deterministic scoring fixture",
    groupPartner: null,
    primaryIndustry: "financial-services",
    businessModel: "b2b",
    review_state: "verified",
    sourceUrl: `https://www.ycombinator.com/companies/${id}`,
    industries: ["Financial Services"],
    founderIds: [],
    socialAccounts: [],
    totalScore: scoreBreakdown.absoluteScore,
    previousScore: scoreBreakdown.absoluteScore,
    platformScores: scoreBreakdown.platformScores,
    scoreBreakdown
  };
}

function stableNumber(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) + 1;
}

function permutations<T>(values: T[]): T[][] {
  if (values.length <= 1) return [values];

  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((tail) => [value, ...tail])
  );
}
