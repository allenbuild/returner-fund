import type {
  EntityScore,
  Platform,
  PlatformScore,
  PostMetrics,
  PostScore,
  ScoreExplanation,
  SocialAccount,
  NormalizedPost
} from "@/types/domain";

export const RAW_ENGAGEMENT_WEIGHTS = {
  likes: 1,
  comments: 3,
  shares: 4,
  reposts: 4,
  saves: 4,
  views: 0.05,
  upvotes: 1.5,
  stars: 2,
  forks: 4,
  issues: 2
} as const;

export const DEFAULT_PLATFORM_WEIGHTS: Record<Platform, number> = {
  x: 0.2,
  linkedin: 0.2,
  instagram: 0.2,
  product_hunt: 0.15,
  github: 0.15,
  youtube: 0.1,
  rss: 0.05,
  web: 0.05,
  reddit: 0.05,
  hacker_news: 0.05,
  bilibili: 0.05,
  tiktok: 0.05
};

export interface ScoringConfig {
  halfLifeDays: number;
  lowSamplePenalty: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  halfLifeDays: 30,
  lowSamplePenalty: 0.85
};

export function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

export function percentile(value: number, sample: number[]): number {
  if (sample.length === 0) {
    return 0.5;
  }
  const sorted = [...sample].sort((a, b) => a - b);
  const belowOrEqual = sorted.filter((item) => item <= value).length;
  return belowOrEqual / sorted.length;
}

export function calculateRawEngagement(metrics: PostMetrics): number {
  return (
    (metrics.likes ?? 0) * RAW_ENGAGEMENT_WEIGHTS.likes +
    (metrics.comments ?? 0) * RAW_ENGAGEMENT_WEIGHTS.comments +
    (metrics.shares ?? 0) * RAW_ENGAGEMENT_WEIGHTS.shares +
    (metrics.reposts ?? 0) * RAW_ENGAGEMENT_WEIGHTS.reposts +
    (metrics.saves ?? 0) * RAW_ENGAGEMENT_WEIGHTS.saves +
    (metrics.views ?? 0) * RAW_ENGAGEMENT_WEIGHTS.views +
    (metrics.upvotes ?? 0) * RAW_ENGAGEMENT_WEIGHTS.upvotes +
    (metrics.stars ?? 0) * RAW_ENGAGEMENT_WEIGHTS.stars +
    (metrics.forks ?? 0) * RAW_ENGAGEMENT_WEIGHTS.forks +
    (metrics.issues ?? 0) * RAW_ENGAGEMENT_WEIGHTS.issues
  );
}

export function calculateRecencyWeight(
  postedAt: string | null,
  collectedAt: string,
  halfLifeDays: number
): { ageDays: number | null; recencyWeight: number } {
  if (!postedAt) {
    return { ageDays: null, recencyWeight: 0.7 };
  }
  const ageMs = new Date(collectedAt).getTime() - new Date(postedAt).getTime();
  const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
  return {
    ageDays,
    recencyWeight: Math.pow(0.5, ageDays / halfLifeDays)
  };
}

export function scorePost(
  post: NormalizedPost,
  metrics: PostMetrics,
  platformRawEngagementSample: number[],
  engagementRateSample: number[],
  account?: SocialAccount,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG
): PostScore {
  const rawEngagement = calculateRawEngagement(metrics);
  const logEngagement = Math.log1p(rawEngagement);
  const logSample = platformRawEngagementSample.map((item) => Math.log1p(item));
  const collectedAt = metrics.collectedAt;
  const { ageDays, recencyWeight } = calculateRecencyWeight(post.postedAt, collectedAt, config.halfLifeDays);
  const followers = account?.followerCount ?? null;
  const engagementRate = followers === null ? null : rawEngagement / Math.max(followers, 1);
  const platformLogPercentile = percentile(logEngagement, logSample);
  const engagementRatePercentile =
    engagementRate === null ? 0.5 : percentile(engagementRate, engagementRateSample);
  const momentumPercentile = percentile(logEngagement * recencyWeight, logSample.map((item) => item * recencyWeight));
  const normalizedScore = clamp(
    100 * (0.5 * platformLogPercentile + 0.3 * engagementRatePercentile + 0.2 * momentumPercentile)
  );
  const contributionScore = normalizedScore * recencyWeight;
  const explanation: ScoreExplanation = {
    rawMetrics: compactMetricValues(metrics),
    weights: RAW_ENGAGEMENT_WEIGHTS,
    rawEngagement,
    logEngagement,
    ageDays,
    recencyWeight,
    engagementRate,
    platformLogPercentile,
    engagementRatePercentile,
    momentumPercentile,
    postScore: normalizedScore,
    qualitySignals: {
      hasFollowerCount: followers !== null,
      account_review_state: account?.review_state ?? "needs_review",
      platform: post.platform
    },
    limitations: followers === null ? ["Follower count unavailable; engagement-rate percentile uses neutral prior."] : []
  };

  return {
    postId: post.id ?? post.platformPostId,
    rawEngagement,
    normalizedScore,
    recencyWeight,
    engagementRate,
    contributionScore,
    explanation
  };
}

export function aggregatePlatformScore(
  platform: Platform,
  postScores: PostScore[],
  account_review_state: SocialAccount["review_state"]
): PlatformScore {
  const sorted = [...postScores].sort((a, b) => b.normalizedScore - a.normalizedScore);
  const topFive = sorted.slice(0, 5);
  const avgTop =
    topFive.length === 0 ? 0 : topFive.reduce((sum, item) => sum + item.normalizedScore, 0) / topFive.length;
  const consistency = clamp((postScores.length / 5) * 100);
  const accountMetricScore = account_review_state === "verified" ? 100 : 0;
  const score = clamp(0.75 * avgTop + 0.15 * consistency + 0.1 * accountMetricScore);
  return {
    platform,
    score: account_review_state === "verified" ? score : 0,
    review_state: account_review_state,
    topPostIds: topFive.map((item) => item.postId),
    explanation: {
      avgTop,
      consistency,
      accountMetricScore,
      account_review_state,
      sampleSize: postScores.length
    }
  };
}

export function aggregateEntityScore(
  entityType: "company" | "founder",
  entityId: string,
  platformScores: PlatformScore[]
): EntityScore {
  if (platformScores.length === 0) {
    return {
      entityType,
      entityId,
      totalScore: 0,
      review_state: "needs_review",
      platformScores: [],
      explanation: { limitations: ["No platform scores available."] }
    };
  }
  const availableWeightTotal = platformScores.reduce(
    (sum, item) => sum + (DEFAULT_PLATFORM_WEIGHTS[item.platform] ?? 0.05),
    0
  );
  const totalScore = platformScores.reduce((sum, item) => {
    const normalizedWeight = (DEFAULT_PLATFORM_WEIGHTS[item.platform] ?? 0.05) / availableWeightTotal;
    return sum + item.score * normalizedWeight;
  }, 0);
  const missingPlatformPenalty = Math.min(1, 0.65 + platformScores.length * 0.08);
  return {
    entityType,
    entityId,
    totalScore: clamp(totalScore),
    review_state: platformScores.some((score) => score.review_state === "verified") ? "verified" : "needs_review",
    platformScores,
    explanation: {
      availablePlatforms: platformScores.map((item) => item.platform),
      availableWeightTotal,
      missingPlatformPenalty
    }
  };
}

function compactMetricValues(metrics: PostMetrics): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of Object.keys(RAW_ENGAGEMENT_WEIGHTS) as Array<keyof typeof RAW_ENGAGEMENT_WEIGHTS>) {
    const value = metrics[key];
    if (typeof value === "number") {
      result[key] = value;
    }
  }
  return result;
}
