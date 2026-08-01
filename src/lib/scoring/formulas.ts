import {
  computeEvidenceRawEngagement,
  normalizeEvidenceScores
} from "@/lib/graph/traction-scoring";
import type {
  EvidenceItem,
  EvidenceMetrics,
  Platform as CanonicalPlatform
} from "@/lib/graph/types";
import type {
  EngagementMetrics,
  Platform,
  PostScoreInput,
  PostScoreResult,
  ScoringConfig
} from "./types";
import { percentileRank } from "./percentiles";
import { TRACTION_SCORING_CONFIG } from "./traction-config";

const DEFAULT_PLATFORM_REFERENCE = TRACTION_SCORING_CONFIG.platformReferences.x!;

/** @deprecated Use TRACTION_SCORING_CONFIG directly for new scoring code. */
export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  halfLifeDays: DEFAULT_PLATFORM_REFERENCE.halfLifeDays,
  reviewWindowDays: DEFAULT_PLATFORM_REFERENCE.halfLifeDays,
  topKPosts: TRACTION_SCORING_CONFIG.platformEvidenceSlots.length
};

const xWeights = TRACTION_SCORING_CONFIG.metricWeights.x ?? {};
const githubWeights = TRACTION_SCORING_CONFIG.metricWeights.github ?? {};
const instagramWeights = TRACTION_SCORING_CONFIG.metricWeights.instagram ?? {};
const linkedinWeights = TRACTION_SCORING_CONFIG.metricWeights.linkedin ?? {};
const productHuntWeights = TRACTION_SCORING_CONFIG.metricWeights.product_hunt ?? {};

/**
 * @deprecated Scoring is platform-specific in v4. This complete-key view exists
 * only for callers that display legacy weight metadata; scoring never reads it.
 */
export const ENGAGEMENT_WEIGHTS = {
  likes: xWeights.likes ?? 0,
  comments: xWeights.replies ?? 0,
  shares: xWeights.reposts ?? 0,
  reposts: xWeights.reposts ?? 0,
  replies: xWeights.replies ?? 0,
  quotes: xWeights.quotes ?? 0,
  reactions: linkedinWeights.reactions ?? 0,
  saves: instagramWeights.saves ?? 0,
  views: xWeights.views ?? 0,
  upvotes: productHuntWeights.upvotes ?? 0,
  stars: githubWeights.stars ?? 0,
  forks: githubWeights.forks ?? 0,
  watchers: githubWeights.watchers ?? 0,
  issues: githubWeights.issues ?? 0,
  openIssues: githubWeights.open_issues ?? githubWeights.issues ?? 0,
  discussions: 0,
  productHuntUpvotes: productHuntWeights.upvotes ?? 0,
  productHuntComments: productHuntWeights.comments ?? 0
} satisfies Record<keyof EngagementMetrics, number>;

/**
 * Compatibility wrapper for the old platform-agnostic API. Omitted platform
 * arguments retain the historical call shape and are interpreted as X.
 */
export function computeWeightedRawEngagement(
  metrics: EngagementMetrics,
  platform: Platform = "x"
): number {
  const canonicalPlatform = toCanonicalPlatform(platform);
  if (!canonicalPlatform) return 0;

  return computeEvidenceRawEngagement(canonicalPlatform, toCanonicalMetrics(metrics));
}

export function computeRecencyWeight(ageDays: number, halfLifeDays: number): number {
  void ageDays;
  void halfLifeDays;
  return 1;
}

/** @deprecated New production callers should use normalizeEvidenceScores. */
export function scorePost(input: PostScoreInput): PostScoreResult {
  const canonicalPlatform = toCanonicalPlatform(input.platform);
  const postedAt = validDate(input.postedAt);
  const collectedAt = validDate(input.collectedAt) ?? postedAt ?? new Date(0);
  const canonicalMetrics = toCanonicalMetrics(input.metrics);
  const scoredEvidence = canonicalPlatform
    ? normalizeEvidenceScores(
        [compatibilityEvidence(input, canonicalPlatform, canonicalMetrics, postedAt, collectedAt)],
        { asOf: collectedAt }
      )[0]
    : undefined;
  const rawEngagement = scoredEvidence?.rawEngagement ?? 0;
  const logEngagement = Math.log1p(rawEngagement);
  const ageDays = postedAt
    ? Math.max(0, (collectedAt.getTime() - postedAt.getTime()) / 86_400_000)
    : null;
  const recencyWeight = 1;
  const followerCount = input.followerCount ?? null;
  const engagementRate =
    followerCount === null ? null : rawEngagement / Math.max(Math.abs(followerCount), 1);
  const momentumValue = logEngagement * recencyWeight;
  const platformLogPercentile = rawEngagement > 0 ? 0.5 : 0;
  const engagementRatePercentile =
    engagementRate === null
      ? 0.5
      : percentileRank(input.percentileSamples?.engagementRate, engagementRate);
  const momentumPercentile = percentileRank(input.percentileSamples?.momentum, momentumValue);
  const postScore = scoredEvidence?.normalizedScore ?? 0;
  const limitations: string[] = [];

  if (engagementRate === null) {
    limitations.push("Follower count unavailable; engagement rate is diagnostic only in canonical v4.");
  }

  if (input.percentileSamples) {
    limitations.push("Legacy percentile samples are diagnostic only; canonical v4 computes the score.");
  }

  if (input.config) {
    limitations.push(
      "Legacy scoring overrides are accepted for compatibility but canonical v4 owns score configuration."
    );
  }

  if (!canonicalPlatform) {
    limitations.push(
      `Platform ${input.platform} has no calibrated canonical v4 model and remains unscored; numeric compatibility fields must not be interpreted as zero traction.`
    );
  }

  return {
    postId: input.postId,
    platform: input.platform,
    rawEngagement,
    normalizedScore: postScore,
    recencyWeight,
    engagementRate,
    contributionScore: scoredEvidence?.contributionScore ?? 0,
    scoringStatus: canonicalPlatform ? "scored" : "unscored",
    explanationJson: {
      rawMetrics: input.metrics,
      weights: canonicalMetricWeights(canonicalPlatform),
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

function compatibilityEvidence(
  input: PostScoreInput,
  platform: CanonicalPlatform,
  metrics: EvidenceMetrics,
  postedAt: Date | null,
  collectedAt: Date
): EvidenceItem {
  const identity = compatibilityIdentity(platform);

  return {
    id: `legacy-compat:${input.postId}`,
    entityType: "company",
    entityId: "legacy-compat",
    platform,
    authorName: "Legacy compatibility wrapper",
    authorHandle: null,
    postedAt: (postedAt ?? collectedAt).toISOString(),
    publishedAtPrecision: postedAt ? "exact" : "unknown",
    metricsCheckedAt: collectedAt.toISOString(),
    text: "",
    mediaType: "unknown",
    metrics,
    contributionScore: 1,
    sourceUrl: identity.sourceUrl,
    platformPostId: identity.platformPostId,
    why: "Adapted from the legacy scoring API.",
    review_state: "verified"
  };
}

function compatibilityIdentity(
  platform: CanonicalPlatform
): { sourceUrl: string; platformPostId: string | null } {
  switch (platform) {
    case "x":
      return { sourceUrl: "https://x.com/legacy/status/1", platformPostId: "1" };
    case "instagram":
      return {
        sourceUrl: "https://www.instagram.com/p/legacycompat",
        platformPostId: "legacycompat"
      };
    case "linkedin":
      return {
        sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1",
        platformPostId: "1"
      };
    case "product_hunt":
      return {
        sourceUrl: "https://www.producthunt.com/posts/legacy-compat",
        platformPostId: "posts/legacy-compat"
      };
    case "github":
      return {
        sourceUrl: "https://github.com/legacy/compatibility",
        platformPostId: "legacy/compatibility"
      };
    case "youtube":
      return {
        sourceUrl: "https://www.youtube.com/watch?v=legacycompat",
        platformPostId: "legacycompat"
      };
    case "reddit":
      return {
        sourceUrl: "https://www.reddit.com/r/legacy/comments/abc123/post",
        platformPostId: "abc123"
      };
    case "hacker_news":
      return { sourceUrl: "https://news.ycombinator.com/item?id=1", platformPostId: "1" };
    case "bilibili":
      return {
        sourceUrl: "https://www.bilibili.com/video/BV1compat",
        platformPostId: "BV1compat"
      };
    default:
      return { sourceUrl: "https://legacy.invalid/unsupported", platformPostId: null };
  }
}

function toCanonicalMetrics(metrics: EngagementMetrics): EvidenceMetrics {
  const result: EvidenceMetrics = {};

  for (const [legacyKey, rawValue] of Object.entries(metrics)) {
    if (!Number.isFinite(rawValue)) continue;

    const canonicalKey =
      legacyKey === "openIssues"
        ? "open_issues"
        : legacyKey === "productHuntUpvotes"
          ? "upvotes"
          : legacyKey === "productHuntComments"
            ? "comments"
            : legacyKey;
    const value = Number(rawValue);
    const existing = result[canonicalKey];
    result[canonicalKey] = existing === undefined ? value : Math.max(existing, value);
  }

  return result;
}

function canonicalMetricWeights(platform: CanonicalPlatform | null): Record<string, number> {
  if (!platform) return {};

  return Object.fromEntries(
    Object.entries(TRACTION_SCORING_CONFIG.metricWeights[platform] ?? {}).filter(
      (entry): entry is [string, number] => Number.isFinite(entry[1])
    )
  );
}

function toCanonicalPlatform(platform: Platform): CanonicalPlatform | null {
  const canonicalPlatform = platform === "twitter" ? "x" : platform;
  return (TRACTION_SCORING_CONFIG.platformWeights[canonicalPlatform as CanonicalPlatform] ?? 0) > 0
    ? (canonicalPlatform as CanonicalPlatform)
    : null;
}

function validDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
