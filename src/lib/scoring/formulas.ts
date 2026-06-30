import {
  EngagementMetrics,
  PostScoreInput,
  PostScoreResult,
  ScoringConfig
} from "./types";
import { clamp, percentileRank, roundScore, safeNumber } from "./percentiles";

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  halfLifeDays: 30,
  reviewWindowDays: 30,
  topKPosts: 5
};

export const ENGAGEMENT_WEIGHTS = {
  likes: 1,
  comments: 3,
  shares: 4,
  reposts: 4,
  replies: 3,
  quotes: 4,
  reactions: 1,
  saves: 4,
  views: 0.02,
  upvotes: 2,
  stars: 1.5,
  forks: 4,
  watchers: 2,
  issues: 0.5,
  openIssues: 0.5,
  discussions: 2,
  productHuntUpvotes: 2,
  productHuntComments: 3
} satisfies Record<keyof EngagementMetrics, number>;

export function computeWeightedRawEngagement(metrics: EngagementMetrics): number {
  return Object.entries(ENGAGEMENT_WEIGHTS).reduce((sum, [metricName, weight]) => {
    const metricValue = metrics[metricName as keyof EngagementMetrics];

    return sum + safeNumber(metricValue) * weight;
  }, 0);
}

export function computeRecencyWeight(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays < 0) {
    return 1;
  }

  return Math.pow(0.5, ageDays / Math.max(halfLifeDays, 1));
}

export function scorePost(input: PostScoreInput): PostScoreResult {
  const config = { ...DEFAULT_SCORING_CONFIG, ...input.config };
  const collectedAt = input.collectedAt ? new Date(input.collectedAt) : new Date();
  const postedAt = input.postedAt ? new Date(input.postedAt) : null;
  const hasValidPostedAt = postedAt instanceof Date && !Number.isNaN(postedAt.getTime());
  const rawEngagement = computeWeightedRawEngagement(input.metrics);
  const logEngagement = Math.log1p(rawEngagement);
  const ageDays = hasValidPostedAt
    ? Math.max(0, (collectedAt.getTime() - postedAt.getTime()) / 86_400_000)
    : null;
  const recencyWeight =
    ageDays === null ? 0.75 : computeRecencyWeight(ageDays, config.halfLifeDays);
  const followerCount = input.followerCount ?? null;
  const engagementRate =
    followerCount === null ? null : rawEngagement / Math.max(Math.abs(followerCount), 1);
  const momentumValue = logEngagement * recencyWeight;
  const platformLogPercentile = percentileRank(
    input.percentileSamples?.logEngagement,
    logEngagement
  );
  const engagementRatePercentile =
    engagementRate === null
      ? 0.5
      : percentileRank(input.percentileSamples?.engagementRate, engagementRate);
  const momentumPercentile = percentileRank(input.percentileSamples?.momentum, momentumValue);
  const postScore = roundScore(
    100 *
      (0.5 * platformLogPercentile +
        0.3 * engagementRatePercentile +
        0.2 * momentumPercentile)
  );
  const limitations: string[] = [];

  if (engagementRate === null) {
    limitations.push("Follower count unavailable; engagement-rate percentile uses neutral 0.5.");
  }

  if (ageDays === null) {
    limitations.push("Post timestamp unavailable; recency uses conservative neutral decay.");
  }

  if (
    !input.percentileSamples?.logEngagement?.length ||
    !input.percentileSamples?.engagementRate?.length ||
    !input.percentileSamples?.momentum?.length
  ) {
    limitations.push("Comparable samples incomplete; missing percentiles fall back to neutral 0.5.");
  }

  return {
    postId: input.postId,
    platform: input.platform,
    rawEngagement,
    normalizedScore: postScore,
    recencyWeight,
    engagementRate,
    contributionScore: postScore,
    explanationJson: {
      rawMetrics: input.metrics,
      weights: ENGAGEMENT_WEIGHTS,
      rawEngagement,
      logEngagement,
      ageDays,
      recencyWeight,
      engagementRate,
      platformLogPercentile,
      engagementRatePercentile,
      momentumPercentile,
      momentumValue,
      postScore,
      qualitySignals: {
        hasFollowerCount: engagementRate !== null,
        hasPostedAt: ageDays !== null,
        hasComparableSamples:
          Boolean(input.percentileSamples?.logEngagement?.length) &&
          Boolean(input.percentileSamples?.engagementRate?.length) &&
          Boolean(input.percentileSamples?.momentum?.length)
      },
      limitations
    }
  };
}
