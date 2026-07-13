import type { EvidenceMetrics, Platform } from "./types";

export interface PlatformMetricWeights {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  reposts?: number;
  replies?: number;
  quotes?: number;
  reactions?: number;
  saves?: number;
  upvotes?: number;
  stars?: number;
  forks?: number;
  watchers?: number;
  issues?: number;
  open_issues?: number;
  recent_commits_30d?: number;
}

export interface TractionScoringConfig {
  name: string;
  platformWeights: Partial<Record<Platform, number>>;
  metricWeights: Partial<Record<Platform, PlatformMetricWeights>>;
  platformHalfLifeDays: Partial<Record<Platform, number>>;
  recencyWeightFloor: number;
  defaultHalfLifeDays: number;
  topKPosts: number;
}

export const TRACTION_SCORING_CONFIG: TractionScoringConfig = {
  name: "social-traction-v3-balanced-recency",
  platformWeights: {
    x: 0.34,
    instagram: 0.22,
    github: 0.14,
    linkedin: 0.14,
    product_hunt: 0.07,
    youtube: 0.05,
    hacker_news: 0.04,
    reddit: 0.03,
    bilibili: 0.02
  },
  metricWeights: {
    github: { stars: 1.5, forks: 4, watchers: 2, issues: 0.5, open_issues: 0.5, recent_commits_30d: 1 },
    x: { views: 0.08, likes: 1.5, replies: 5.5, comments: 5.5, reposts: 8, shares: 8, quotes: 8 },
    linkedin: { views: 0.08, likes: 1.5, reactions: 1.5, comments: 5.5, reposts: 8, shares: 8 },
    instagram: { views: 0.075, likes: 1.1, comments: 5, shares: 5, reposts: 5, saves: 5 },
    product_hunt: { upvotes: 2, comments: 3 },
    youtube: { views: 0.035, likes: 1, comments: 3 },
    hacker_news: { upvotes: 2, comments: 3 },
    reddit: { upvotes: 2, comments: 3 },
    bilibili: { views: 0.035, likes: 1, comments: 3, shares: 4 },
    web: {},
    rss: {}
  },
  platformHalfLifeDays: {
    github: 180,
    product_hunt: 90,
    youtube: 120,
    linkedin: 60,
    instagram: 45,
    x: 45,
    hacker_news: 45,
    reddit: 45,
    bilibili: 120
  },
  recencyWeightFloor: 0.6,
  defaultHalfLifeDays: 60,
  topKPosts: 5
};

export function weightedMetricSum(platform: Platform, metrics: EvidenceMetrics): number {
  const weights = TRACTION_SCORING_CONFIG.metricWeights[platform] ?? {};
  const normalizedMetrics = normalizeMetricsForScoring(platform, metrics);

  return Object.entries(normalizedMetrics).reduce((sum, [key, rawValue]) => {
    const value = Number(rawValue);
    const weight = weights[key as keyof PlatformMetricWeights] ?? 0;
    return Number.isFinite(value) ? sum + value * weight : sum;
  }, 0);
}

function normalizeMetricsForScoring(platform: Platform, metrics: EvidenceMetrics): EvidenceMetrics {
  if (platform !== "linkedin") {
    return metrics;
  }

  const likes = finiteMetric(metrics.likes);
  const reactions = finiteMetric(metrics.reactions);

  if (likes === null || reactions === null) {
    return metrics;
  }

  return {
    ...metrics,
    likes: Math.max(likes, reactions),
    reactions: undefined
  };
}

function finiteMetric(value: number | null | undefined): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}
