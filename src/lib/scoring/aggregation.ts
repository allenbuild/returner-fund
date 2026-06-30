import {
  BaselineReliability,
  CompanyScoreInput,
  EntityScoreInput,
  EntityScoreResult,
  FounderScoreInput,
  Platform,
  PlatformBreakdown,
  PlatformScoreInput,
  PlatformScoreResult,
  ReviewState,
  ScoringConfig
} from "./types";
import { DEFAULT_SCORING_CONFIG } from "./formulas";
import { clamp, percentileRank, roundScore, weightedAverage } from "./percentiles";

export const DEFAULT_PLATFORM_WEIGHTS: Partial<Record<Platform, number>> = {
  x: 0.25,
  linkedin: 0.15,
  instagram: 0.15,
  product_hunt: 0.15,
  github: 0.2,
  youtube: 0.1
};

const PLATFORM_FORMULA_WEIGHTS = {
  topPostAverage: 0.75,
  consistency: 0.15,
  accountMetric: 0.1
};

function baselineReliabilityMultiplier(reliability: BaselineReliability): number {
  switch (reliability) {
    case "high":
      return 1;
    case "medium":
      return 0.85;
    case "low":
      return 0.7;
    case "none":
      return 0.6;
    default:
      return 0.6;
  }
}

function averageScore(scores: Array<PlatformScoreResult<unknown>>): number {
  return weightedAverage(
    scores.map((score) => ({
      value: score.score,
      weight: 1
    })),
    0
  );
}

export function aggregatePlatformScore(input: PlatformScoreInput): PlatformScoreResult {
  const config: ScoringConfig = { ...DEFAULT_SCORING_CONFIG, ...input.config };
  const review_state = input.account_review_state;
  const sortedPosts = [...input.postScores].sort(
    (left, right) => right.normalizedScore - left.normalizedScore
  );
  const topPosts = sortedPosts.slice(0, config.topKPosts);
  const topPostAverage =
    topPosts.length === 0
      ? 0
      : topPosts.reduce((sum, post) => sum + post.normalizedScore, 0) / topPosts.length;
  const consistencyScore = roundScore((Math.min(input.postScores.length, config.topKPosts) / config.topKPosts) * 100);
  const accountMetricScore =
    input.accountMetrics?.followerPercentile === null ||
    input.accountMetrics?.followerPercentile === undefined
      ? 50
      : roundScore(clamp(input.accountMetrics.followerPercentile) * 100);
  const score = roundScore(
    PLATFORM_FORMULA_WEIGHTS.topPostAverage * topPostAverage +
      PLATFORM_FORMULA_WEIGHTS.consistency * consistencyScore +
      PLATFORM_FORMULA_WEIGHTS.accountMetric * accountMetricScore
  );
  const baselineReliability = input.baselineReliability ?? "low";
  const metricAvailability =
    input.accountMetrics?.metricAvailability === null ||
    input.accountMetrics?.metricAvailability === undefined
      ? input.postScores.length > 0
        ? 1
        : 0.25
      : clamp(input.accountMetrics.metricAvailability);
  const sampleCoverage = clamp(input.postScores.length / config.topKPosts);
  const limitations: string[] = [];

  if (review_state !== "verified") {
    limitations.push(
      `Account is ${review_state}; it is excluded from canonical scoring until it is verified.`
    );
  }

  if (input.postScores.length === 0) {
    limitations.push("No post samples available for this platform.");
  }

  if (input.baselineReliability === "low" || input.baselineReliability === "none") {
    limitations.push("Global baseline reliability is weak; within-batch percentiles dominate.");
  }

  if (
    input.accountMetrics?.followerPercentile === null ||
    input.accountMetrics?.followerPercentile === undefined
  ) {
    limitations.push("Account-level metric percentile unavailable; neutral account score used.");
  }

  return {
    entityId: input.entityId,
    platform: input.platform,
    score: review_state === "verified" ? score : 0,
    review_state,
    explanationJson: {
      platform: input.platform,
      topPostIds: topPosts.map((post) => post.postId),
      topPostAverage,
      consistencyScore,
      accountMetricScore,
      formula: {
        topPostAverageWeight: PLATFORM_FORMULA_WEIGHTS.topPostAverage,
        consistencyWeight: PLATFORM_FORMULA_WEIGHTS.consistency,
        accountMetricWeight: PLATFORM_FORMULA_WEIGHTS.accountMetric
      },
      qualitySignals: {
        account_review_state: review_state,
        metricAvailability,
        sampleCoverage,
        baselineReliability,
        baselineReliabilityMultiplier: baselineReliabilityMultiplier(baselineReliability)
      },
      limitations
    }
  };
}

export function aggregateFounderScore(input: FounderScoreInput): EntityScoreResult {
  const base = aggregateEntityScores({
    entityId: input.entityId,
    batchSlug: input.batchSlug,
      platformScores: input.platformScores,
      batchPeerCompositeScores: input.batchPeerCompositeScores
  });
  const relevanceToCompany =
    input.relevanceToCompany === null || input.relevanceToCompany === undefined
      ? 0.85
      : clamp(input.relevanceToCompany);
  return {
    ...base,
    scoreExplanationJson: {
      ...base.scoreExplanationJson,
      qualitySignals: {
        ...base.scoreExplanationJson.qualitySignals,
        relevanceToCompany
      },
      limitations:
        input.relevanceToCompany === null || input.relevanceToCompany === undefined
          ? [
              ...base.scoreExplanationJson.limitations,
              "Founder-company relevance unavailable; conservative default used."
            ]
          : base.scoreExplanationJson.limitations
    }
  };
}

export function aggregateCompanyScore(input: CompanyScoreInput): EntityScoreResult {
  const platforms = new Set<Platform>([
    ...input.officialAccounts.filter(isVerifiedScore).map((score) => score.platform),
    ...input.founderAccounts.filter(isVerifiedScore).map((score) => score.platform)
  ]);
  const platformScores: Array<PlatformScoreResult<unknown>> = [];
  const platformBreakdownOverrides = new Map<Platform, { sourceCoverage: number }>();

  for (const platform of platforms) {
    const officialScores = input.officialAccounts.filter((score) => score.platform === platform && isVerifiedScore(score));
    const founderScores = input.founderAccounts.filter((score) => score.platform === platform && isVerifiedScore(score));
    const hasOfficial = officialScores.length > 0;
    const hasFounder = founderScores.length > 0;
    const sourceCoverage = (hasOfficial ? 0.6 : 0) + (hasFounder ? 0.4 : 0);
    const score = weightedAverage(
      [
        { value: averageScore(officialScores), weight: hasOfficial ? 0.6 : 0 },
        { value: averageScore(founderScores), weight: hasFounder ? 0.4 : 0 }
      ],
      0
    );

    platformScores.push({
      entityId: input.companyId,
      platform,
      score: roundScore(score),
      review_state: "verified",
      explanationJson: {
        platform,
        officialAccountCount: officialScores.length,
        founderAccountCount: founderScores.length,
        officialSourceWeight: hasOfficial ? 0.6 : 0,
        founderSourceWeight: hasFounder ? 0.4 : 0,
        sourceCoverage,
        officialScores: officialScores.map((platformScore) => platformScore.explanationJson),
        founderScores: founderScores.map((platformScore) => platformScore.explanationJson)
      }
    });
    platformBreakdownOverrides.set(platform, { sourceCoverage });
  }

  return aggregateEntityScores(
    {
      entityId: input.companyId,
      batchSlug: input.batchSlug,
      platformScores,
      batchPeerCompositeScores: input.batchPeerCompositeScores
    },
    platformBreakdownOverrides
  );
}

export function aggregateEntityScores(
  input: EntityScoreInput,
  platformBreakdownOverrides = new Map<Platform, { sourceCoverage: number }>()
): EntityScoreResult {
  const presentScores = input.platformScores.filter((score) => {
    const configuredWeight = DEFAULT_PLATFORM_WEIGHTS[score.platform] ?? 0;

    return configuredWeight > 0 && score.score > 0 && score.review_state === "verified";
  });
  const totalConfiguredWeight = Object.values(DEFAULT_PLATFORM_WEIGHTS).reduce(
    (sum, weight) => sum + (weight ?? 0),
    0
  );
  const availableWeight = presentScores.reduce(
    (sum, score) => sum + (DEFAULT_PLATFORM_WEIGHTS[score.platform] ?? 0),
    0
  );
  const weightedAvailableScore = roundScore(
    weightedAverage(
      presentScores.map((score) => ({
        value: score.score,
        weight: DEFAULT_PLATFORM_WEIGHTS[score.platform] ?? 0
      })),
      0
    )
  );
  const coverageFactor =
    presentScores.length > 0
      ? 0.85 + 0.15 * Math.sqrt(presentScores.length / Object.keys(DEFAULT_PLATFORM_WEIGHTS).length)
      : 0;
  const absoluteCompositeScore = roundScore(weightedAvailableScore * coverageFactor);
  const batchPercentile =
    input.batchPeerCompositeScores?.length === undefined
      ? null
      : percentileRank(input.batchPeerCompositeScores, absoluteCompositeScore);
  const totalScore = roundScore(batchPercentile === null ? absoluteCompositeScore : batchPercentile * 100);
  const platformCoverage =
    totalConfiguredWeight <= 0 ? 0 : clamp(availableWeight / totalConfiguredWeight);
  const review_state = entityReviewState(input.platformScores);
  const platformScoresJson: PlatformBreakdown[] = presentScores.map((score) => ({
    platform: score.platform,
    score: score.score,
    review_state: score.review_state,
    sourceCoverage: platformBreakdownOverrides.get(score.platform)?.sourceCoverage ?? 1,
    appliedPlatformWeight:
      availableWeight <= 0 ? 0 : (DEFAULT_PLATFORM_WEIGHTS[score.platform] ?? 0) / availableWeight,
    explanationJson: score.explanationJson
  }));
  const limitations: string[] = [];

  if (presentScores.length === 0) {
    limitations.push("No configured platform scores available.");
  }

  if (platformCoverage < 1) {
    limitations.push("Missing platforms were re-normalized; source coverage is incomplete.");
  }

  if (batchPercentile === null) {
    limitations.push("Batch peer scores unavailable; total score is absolute composite, not batch-relative percentile.");
  }

  return {
    entityId: input.entityId,
    batchSlug: input.batchSlug,
    totalScore,
    review_state,
    platformScoresJson,
    scoreExplanationJson: {
      entityId: input.entityId,
      batchSlug: input.batchSlug,
      absoluteCompositeScore,
      batchPercentile,
      platformCoverage,
      defaultPlatformWeights: DEFAULT_PLATFORM_WEIGHTS,
      platformBreakdown: platformScoresJson,
      qualitySignals: {
        review_state,
        coverageFactor,
        weightedAvailableScore,
        platformCoverage,
        availablePlatformWeight: availableWeight,
        totalConfiguredPlatformWeight: totalConfiguredWeight
      },
      limitations
    }
  };
}

function isVerifiedScore(score: PlatformScoreResult<unknown>): boolean {
  return score.review_state === "verified";
}

function entityReviewState(scores: Array<PlatformScoreResult<unknown>>): ReviewState {
  if (scores.some(isVerifiedScore)) {
    return "verified";
  }

  if (scores.length > 0 && scores.every((score) => score.review_state === "rejected")) {
    return "rejected";
  }

  return "needs_review";
}
