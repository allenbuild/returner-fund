import type {
  EntityScore,
  NormalizedPost,
  Platform,
  PlatformScore,
  PostMetrics,
  PostScore,
  SocialAccount
} from "@/types/domain";
import {
  aggregateEntityScores as aggregateCompatibilityEntityScores,
  aggregatePlatformScore as aggregateCompatibilityPlatformScore,
  DEFAULT_PLATFORM_WEIGHTS as CANONICAL_PLATFORM_WEIGHTS
} from "./aggregation";
import {
  computeRecencyWeight,
  computeWeightedRawEngagement,
  ENGAGEMENT_WEIGHTS,
  scorePost as scoreCompatibilityPost
} from "./formulas";
import { clamp as clampValue, percentileRank } from "./percentiles";
import { TRACTION_SCORING_CONFIG } from "./traction-config";

/** @deprecated Use TRACTION_SCORING_CONFIG.metricWeights for platform-aware weights. */
export const RAW_ENGAGEMENT_WEIGHTS = ENGAGEMENT_WEIGHTS;

/** @deprecated Use TRACTION_SCORING_CONFIG.platformWeights directly. */
export const DEFAULT_PLATFORM_WEIGHTS: Partial<Record<Platform, number>> = {
  x: CANONICAL_PLATFORM_WEIGHTS.x ?? 0,
  linkedin: CANONICAL_PLATFORM_WEIGHTS.linkedin ?? 0,
  instagram: CANONICAL_PLATFORM_WEIGHTS.instagram ?? 0,
  product_hunt: CANONICAL_PLATFORM_WEIGHTS.product_hunt ?? 0,
  github: CANONICAL_PLATFORM_WEIGHTS.github ?? 0,
  youtube: CANONICAL_PLATFORM_WEIGHTS.youtube ?? 0,
  rss: CANONICAL_PLATFORM_WEIGHTS.rss ?? 0,
  web: CANONICAL_PLATFORM_WEIGHTS.web ?? 0,
  reddit: CANONICAL_PLATFORM_WEIGHTS.reddit ?? 0,
  hacker_news: CANONICAL_PLATFORM_WEIGHTS.hacker_news ?? 0,
  bilibili: CANONICAL_PLATFORM_WEIGHTS.bilibili ?? 0
};

export interface ScoringConfig {
  halfLifeDays: number;
  lowSamplePenalty: number;
}

/** @deprecated Canonical v4 owns production score configuration. */
export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  halfLifeDays: TRACTION_SCORING_CONFIG.platformReferences.x!.halfLifeDays,
  lowSamplePenalty: TRACTION_SCORING_CONFIG.durableSignalWeight
};

export function clamp(value: number, min = 0, max = 100): number {
  return clampValue(value, min, max);
}

export function percentile(value: number, sample: number[]): number {
  return percentileRank(sample, value);
}

/**
 * Compatibility wrapper for the former platform-agnostic helper. Callers that
 * know the platform can pass it as the second argument; omitted means X.
 */
export function calculateRawEngagement(metrics: PostMetrics, platform: Platform = "x"): number {
  return computeWeightedRawEngagement(metrics, platform);
}

export function calculateRecencyWeight(
  postedAt: string | null,
  collectedAt: string,
  halfLifeDays: number
): { ageDays: number | null; recencyWeight: number } {
  const postedDate = validDate(postedAt);
  const collectedDate = validDate(collectedAt);

  if (!postedDate || !collectedDate) {
    return {
      ageDays: null,
      recencyWeight: TRACTION_SCORING_CONFIG.missingDateMomentum
    };
  }

  const ageDays = Math.max(0, (collectedDate.getTime() - postedDate.getTime()) / 86_400_000);
  return {
    ageDays,
    recencyWeight: computeRecencyWeight(ageDays, halfLifeDays)
  };
}

/** @deprecated New production callers should use normalizeEvidenceScores. */
export function scorePost(
  post: NormalizedPost,
  metrics: PostMetrics,
  platformRawEngagementSample: number[],
  engagementRateSample: number[],
  account?: SocialAccount,
  config?: ScoringConfig
): PostScore {
  const canonicalHalfLife =
    post.platform === "tiktok" || post.platform === "bluesky"
      ? DEFAULT_SCORING_CONFIG.halfLifeDays
      : TRACTION_SCORING_CONFIG.platformReferences[post.platform]?.halfLifeDays ??
        DEFAULT_SCORING_CONFIG.halfLifeDays;
  const { recencyWeight } = calculateRecencyWeight(
    post.postedAt,
    metrics.collectedAt,
    canonicalHalfLife
  );
  const logSample = platformRawEngagementSample
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.log1p(value));
  const result = scoreCompatibilityPost({
    postId: post.id ?? post.platformPostId,
    platform: post.platform,
    metrics,
    followerCount: account?.followerCount ?? null,
    postedAt: post.postedAt,
    collectedAt: metrics.collectedAt,
    percentileSamples: {
      logEngagement: logSample,
      engagementRate: engagementRateSample,
      momentum: logSample.map((value) => value * recencyWeight)
    },
    config: config ? { halfLifeDays: config.halfLifeDays } : undefined
  });
  const accountIsEligible = !account || account.review_state === "verified";
  const normalizedScore = accountIsEligible ? result.normalizedScore : 0;
  const contributionScore = accountIsEligible ? result.contributionScore : 0;
  const limitations = accountIsEligible
    ? result.explanationJson.limitations
    : [
        ...result.explanationJson.limitations,
        `Account is ${account.review_state}; canonical v4 excludes it from scoring.`
      ];

  return {
    postId: result.postId,
    rawEngagement: result.rawEngagement,
    normalizedScore,
    recencyWeight: result.recencyWeight,
    engagementRate: result.engagementRate,
    contributionScore,
    scoringStatus: result.scoringStatus,
    explanation: {
      rawMetrics: numericMetrics(metrics),
      weights: result.explanationJson.weights,
      rawEngagement: result.explanationJson.rawEngagement,
      logEngagement: result.explanationJson.logEngagement,
      ageDays: result.explanationJson.ageDays,
      recencyWeight: result.explanationJson.recencyWeight,
      engagementRate: result.explanationJson.engagementRate,
      platformLogPercentile: result.explanationJson.platformLogPercentile,
      engagementRatePercentile: result.explanationJson.engagementRatePercentile,
      momentumPercentile: result.explanationJson.momentumPercentile,
      postScore: normalizedScore,
      qualitySignals: {
        hasFollowerCount: result.engagementRate !== null,
        account_review_state: account?.review_state ?? "verified",
        platform: post.platform,
        modelId: TRACTION_SCORING_CONFIG.modelId,
        modelVersion: TRACTION_SCORING_CONFIG.version
      },
      limitations
    }
  };
}

/** @deprecated New production callers should use platformScoresFromEvidence. */
export function aggregatePlatformScore(
  platform: Platform,
  postScores: PostScore[],
  account_review_state: SocialAccount["review_state"]
): PlatformScore {
  const result = aggregateCompatibilityPlatformScore({
    entityId: "legacy-domain",
    platform,
    account_review_state,
    postScores: postScores.map((postScore) => ({
      postId: postScore.postId,
      platform,
      rawEngagement: postScore.rawEngagement,
      normalizedScore: postScore.normalizedScore,
      recencyWeight: postScore.recencyWeight,
      engagementRate: postScore.engagementRate,
      contributionScore: postScore.contributionScore,
      scoringStatus: postScore.scoringStatus,
      explanationJson: {
        rawMetrics: postScore.explanation.rawMetrics,
        weights: postScore.explanation.weights,
        rawEngagement: postScore.explanation.rawEngagement,
        logEngagement: postScore.explanation.logEngagement,
        ageDays: postScore.explanation.ageDays,
        recencyWeight: postScore.explanation.recencyWeight,
        engagementRate: postScore.explanation.engagementRate,
        platformLogPercentile: postScore.explanation.platformLogPercentile,
        engagementRatePercentile: postScore.explanation.engagementRatePercentile,
        momentumPercentile: postScore.explanation.momentumPercentile,
        momentumValue: postScore.explanation.logEngagement * postScore.explanation.recencyWeight,
        postScore: postScore.explanation.postScore,
        qualitySignals: {
          hasFollowerCount: postScore.explanation.engagementRate !== null,
          hasPostedAt: postScore.explanation.ageDays !== null,
          hasComparableSamples: false
        },
        limitations: postScore.explanation.limitations
      }
    }))
  });

  return {
    platform,
    score: result.score,
    scoringStatus: result.scoringStatus,
    review_state: result.review_state,
    topPostIds: result.explanationJson.topPostIds,
    explanation: { ...result.explanationJson }
  };
}

/** @deprecated New production callers should use aggregateBalancedTractionScore. */
export function aggregateEntityScore(
  entityType: "company" | "founder",
  entityId: string,
  platformScores: PlatformScore[]
): EntityScore {
  const result = aggregateCompatibilityEntityScores({
    entityId,
    batchSlug: "legacy-compat",
    platformScores: platformScores.map((platformScore) => ({
      entityId,
      platform: platformScore.platform,
      score: platformScore.score,
      scoringStatus: platformScore.scoringStatus,
      review_state: platformScore.review_state,
      explanationJson: platformScore.explanation
    }))
  });

  return {
    entityType,
    entityId,
    totalScore: result.totalScore,
    review_state: result.review_state,
    platformScores,
    explanation: { ...result.scoreExplanationJson }
  };
}

function numericMetrics(metrics: PostMetrics): Record<string, number> {
  return Object.fromEntries(
    Object.entries(metrics).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1])
    )
  );
}

function validDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
