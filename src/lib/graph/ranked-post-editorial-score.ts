import type { EvidenceItem, EvidenceMetrics, Platform } from "./types";

export const RANKED_POST_EDITORIAL_SCORE_VERSION = "ranked-post-editorial-v1" as const;

type EditorialMetricWeights = Readonly<Record<string, number>>;

interface RankedPostEditorialPlatformConfig {
  highEngagement: number;
  metricWeights: EditorialMetricWeights;
}

/**
 * Ranked Posts is an editorial surface, not a company-traction leaderboard.
 * Keep its metric curve versioned and independent from the active traction
 * model so a company-scoring migration cannot silently rewrite published post
 * ordering. These are the global values used by Ranked Posts before v4.3.
 */
const RANKED_POST_EDITORIAL_PLATFORMS: Readonly<
  Partial<Record<Platform, RankedPostEditorialPlatformConfig>>
> = {
  github: {
    highEngagement: 40_000,
    metricWeights: { stars: 1.5, forks: 4, issues: 0.5 }
  },
  x: {
    highEngagement: 120_000,
    metricWeights: { views: 0.04, likes: 1.4, replies: 4.5, reposts: 6, quotes: 6 }
  },
  linkedin: {
    highEngagement: 18_000,
    metricWeights: { views: 0.04, reactions: 1.4, comments: 4.5, reposts: 6 }
  },
  instagram: {
    highEngagement: 80_000,
    metricWeights: { views: 0.04, likes: 1.1, comments: 4.5, shares: 5, saves: 4 }
  },
  product_hunt: {
    highEngagement: 4_000,
    metricWeights: { upvotes: 2, comments: 3.5 }
  },
  youtube: {
    highEngagement: 35_000,
    metricWeights: { views: 0.025, likes: 1, comments: 3.5 }
  },
  hacker_news: {
    highEngagement: 2_500,
    metricWeights: { upvotes: 2, comments: 3.5 }
  },
  reddit: {
    highEngagement: 4_000,
    metricWeights: { upvotes: 2, comments: 3.5 }
  },
  bilibili: {
    highEngagement: 35_000,
    metricWeights: { views: 0.025, likes: 1, comments: 3.5, shares: 4 }
  }
};

export function rankedPostEditorialScore(
  evidence: Pick<EvidenceItem, "platform" | "metrics">
): number {
  const config = RANKED_POST_EDITORIAL_PLATFORMS[evidence.platform];
  if (!config) return 0;

  const rawEngagement = rankedPostEditorialRawEngagement(evidence);
  if (rawEngagement <= 0) return 0;

  const absoluteScore = clamp(
    (Math.log1p(rawEngagement) / Math.log1p(config.highEngagement)) * 100,
    0,
    100
  );
  return Math.round(clamp(absoluteScore, 1, 100));
}

export function rankedPostEditorialRawEngagement(
  evidence: Pick<EvidenceItem, "platform" | "metrics">
): number {
  const config = RANKED_POST_EDITORIAL_PLATFORMS[evidence.platform];
  if (!config) return 0;
  const normalizedMetrics = normalizeEditorialMetrics(evidence.platform, evidence.metrics);
  return round(Math.max(0, weightedMetricSum(normalizedMetrics, config.metricWeights)), 4);
}

function weightedMetricSum(
  metrics: EvidenceItem["metrics"],
  weights: EditorialMetricWeights
): number {
  return Object.entries(metrics).reduce((sum, [key, rawValue]) => {
    const value = Number(rawValue);
    const weight = weights[key] ?? 0;
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(weight) || weight <= 0) {
      return sum;
    }

    const weightedValue = value * weight;
    if (!Number.isFinite(weightedValue)) return Number.MAX_VALUE;
    const next = sum + weightedValue;
    return Number.isFinite(next) ? next : Number.MAX_VALUE;
  }, 0);
}

/** Frozen metric-alias contract paired with ranked-post-editorial-v1. */
function normalizeEditorialMetrics(platform: Platform, metrics: EvidenceMetrics): EvidenceMetrics {
  const cleaned = Object.fromEntries(
    Object.entries(metrics).flatMap(([key, rawValue]) => {
      const value = Number(rawValue);
      return Number.isFinite(value) && value > 0 ? [[key, value]] : [];
    })
  ) as EvidenceMetrics;

  if (platform === "x") {
    return {
      views: cleaned.views,
      likes: cleaned.likes,
      replies: maxMetric(cleaned.replies, cleaned.comments),
      reposts: maxMetric(cleaned.reposts, cleaned.shares),
      quotes: cleaned.quotes,
      saves: cleaned.saves
    };
  }
  if (platform === "linkedin") {
    return {
      views: cleaned.views,
      reactions: maxMetric(cleaned.reactions, cleaned.likes),
      comments: maxMetric(cleaned.comments, cleaned.replies),
      reposts: maxMetric(cleaned.reposts, cleaned.shares),
      saves: cleaned.saves
    };
  }
  if (platform === "instagram") {
    return {
      views: cleaned.views,
      likes: cleaned.likes,
      comments: maxMetric(cleaned.comments, cleaned.replies),
      shares: maxMetric(cleaned.shares, cleaned.reposts),
      saves: cleaned.saves
    };
  }
  if (platform === "github") {
    return {
      stars: cleaned.stars,
      forks: cleaned.forks,
      watchers: cleaned.watchers === cleaned.stars ? undefined : cleaned.watchers,
      issues: maxMetric(cleaned.issues, cleaned.open_issues)
    };
  }
  return cleaned;
}

function maxMetric(...values: Array<number | undefined>): number | undefined {
  const finite = values.filter(
    (value): value is number => Number.isFinite(value) && Number(value) > 0
  );
  return finite.length > 0 ? Math.max(...finite) : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
