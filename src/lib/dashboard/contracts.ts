import type { Platform } from "@/lib/graph/types";

/**
 * Public, versioned contract for the precomputed technology dashboard.  The
 * dashboard intentionally has its own story vocabulary instead of expanding
 * the company-graph `EvidenceItem` contract: Industry sources have no
 * Returner entity and must not be represented as a fake company/founder post.
 */
export const DASHBOARD_SCHEMA_VERSION = "technology-dashboard-v2" as const;
/** The public Top 100 is always computed over one exact rolling 72-hour window. */
export const DASHBOARD_WINDOW_MS = 72 * 60 * 60 * 1_000;
/** Social and video candidates need a real native reach reading at this gate. */
export const DASHBOARD_MIN_SOCIAL_VIEWS = 1_000_000;
export const DASHBOARD_NEWS_TARGET_SHARE = 0.3;
export const DASHBOARD_MAX_NEWS_PER_PUBLISHER = 3;
export const DASHBOARD_MAX_SOCIAL_PER_PLATFORM = 30;
export const DASHBOARD_TOP_LIMIT = 100;
/**
 * Source expansion is deliberately bounded: a ranking card never needs to
 * transfer an unbounded evidence list just to render its headline.
 */
export const DASHBOARD_SOURCE_DETAIL_LIMIT = 20;

export const DASHBOARD_UNIVERSES = ["everything", "returner", "industry"] as const;
export type DashboardUniverse = (typeof DASHBOARD_UNIVERSES)[number];
export type DashboardStoryUniverse = Exclude<DashboardUniverse, "everything">;

export const DASHBOARD_TOPICS = [
  "ai",
  "startups",
  "robotics",
  "research",
  "funding",
  "launches",
  "open_source",
  "biotech",
  "other"
] as const;
export type DashboardTopic = (typeof DASHBOARD_TOPICS)[number];

export const DASHBOARD_VIEWS = ["hottest", "breaking", "emerging"] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

/** `news` and `research` are dashboard display categories, not new graph platforms. */
export const DASHBOARD_PLATFORMS = [
  "github",
  "x",
  "linkedin",
  "instagram",
  "product_hunt",
  "youtube",
  "rss",
  "web",
  "reddit",
  "hacker_news",
  "bilibili",
  "tiktok",
  "bluesky",
  "news",
  "research"
] as const;
export type DashboardPlatform = (typeof DASHBOARD_PLATFORMS)[number];
export type DashboardNativePlatform = Platform | "news" | "research";

export const DASHBOARD_SOURCE_KINDS = [
  "post",
  "thread",
  "video",
  "article",
  "paper",
  "repository",
  "release",
  "launch",
  "discussion",
  "other"
] as const;
export type DashboardSourceKind = (typeof DASHBOARD_SOURCE_KINDS)[number];

export const DASHBOARD_TOP100_CONTENT_KINDS = ["viral_post", "news_article"] as const;
export type DashboardTop100ContentKind = (typeof DASHBOARD_TOP100_CONTENT_KINDS)[number];

const DASHBOARD_TOP100_SOCIAL_PLATFORMS = new Set<DashboardNativePlatform>([
  "x", "instagram", "linkedin", "youtube", "tiktok", "bluesky"
]);

/**
 * One shared classifier keeps worker scoring, artifact validation, and UI
 * labels from disagreeing about whether the million-view gate applies.
 */
export function dashboardTop100ContentKind(source: {
  platform: DashboardPlatform | DashboardNativePlatform;
  sourceKind: DashboardSourceKind;
}): DashboardTop100ContentKind | null {
  if (
    source.sourceKind === "article" ||
    source.sourceKind === "paper" ||
    source.platform === "web" ||
    source.platform === "rss" ||
    source.platform === "news" ||
    source.platform === "research"
  ) return "news_article";
  if (
    DASHBOARD_TOP100_SOCIAL_PLATFORMS.has(source.platform as DashboardNativePlatform) &&
    (source.sourceKind === "post" || source.sourceKind === "thread" || source.sourceKind === "video")
  ) return "viral_post";
  return null;
}

export const DASHBOARD_TREND_STATUSES = ["rising_fast", "rising", "new", "stable", "cooling"] as const;
export type DashboardTrendStatus = (typeof DASHBOARD_TREND_STATUSES)[number];

export interface DashboardMetrics {
  views?: number | null;
  likes?: number | null;
  reactions?: number | null;
  comments?: number | null;
  replies?: number | null;
  shares?: number | null;
  reposts?: number | null;
  quotes?: number | null;
  upvotes?: number | null;
  stars?: number | null;
  forks?: number | null;
  watchers?: number | null;
  subscribers?: number | null;
  downloads?: number | null;
  [metric: string]: number | null | undefined;
}

/** Append-only readings let the scoring job measure velocity instead of guessing it. */
export interface DashboardMetricObservation {
  observedAt: string;
  metrics: DashboardMetrics;
}

export interface DashboardTrackedEntity {
  companyId?: string;
  founderId?: string;
  name: string;
  /** Existing cohort label, e.g. YC S26 or a16z Speedrun. */
  cohortLabel: string;
  batchSlug?: string;
}

/**
 * Normalized input to the hourly pipeline. It can wrap a canonical
 * `evidence_items` row, an external discovery row, or an imported source
 * document. It is intentionally additive and never creates a duplicate Post.
 */
export interface DashboardCandidate {
  id: string;
  /** Stable platform-scoped physical-source identity. */
  canonicalKey: string;
  platform: DashboardNativePlatform;
  sourceKind: DashboardSourceKind;
  url: string;
  /** A submitted/referenced canonical destination, useful for HN/news clustering. */
  destinationUrl?: string | null;
  linkedUrls?: string[];
  title?: string | null;
  /** A concise factual source description, when an adapter extracted one. */
  summary?: string | null;
  text?: string | null;
  authorName?: string | null;
  authorHandle?: string | null;
  publisher?: string | null;
  publishedAt: string;
  observedAt?: string | null;
  metrics?: DashboardMetrics;
  metricHistory?: DashboardMetricObservation[];
  /** Historical expected engagement for this account/channel, if safely available. */
  accountBaseline?: DashboardMetrics | null;
  followerCount?: number | null;
  /** Stable product/company/person/repository/paper identifiers supplied by discovery. */
  entityKeys?: string[];
  /** Optional deterministic event identity from a trusted adapter or previous story match. */
  storyKey?: string | null;
  entityLabel?: string | null;
  trackedEntity?: DashboardTrackedEntity | null;
  topics?: DashboardTopic[];
  thumbnailUrl?: string | null;
  thumbnailAlt?: string | null;
  mediaUrl?: string | null;
  sourceQuality?: number | null;
  /** False for a company syndicating its own announcement; true for independent attention. */
  independentlyReported?: boolean;
  /** Input fingerprint from canonical source content; drives summary caching. */
  contentFingerprint?: string | null;
  /**
   * Worker-only proof that a social/video row is verified, scored native
   * evidence. It is never copied into a public story source.
   */
  socialBackfillEligible?: boolean;
  /** Worker-only source qualification copied from canonical evidence. */
  sourceVerified?: boolean;
  sourceLinkStatus?: "verified" | "invalid" | "unchecked" | "blocked" | null;
  publicationPrecision?: "exact" | "day" | "unknown";
}

export interface DashboardStorySource {
  id: string;
  canonicalKey: string;
  platform: DashboardPlatform;
  nativePlatform: DashboardNativePlatform;
  sourceKind: DashboardSourceKind;
  /** Carried from the candidate; the public artifact accepts only `verified`. */
  verificationState: "verified" | "unverified";
  url: string;
  destinationUrl: string | null;
  title: string | null;
  summary: string | null;
  authorName: string | null;
  publisher: string | null;
  publishedAt: string;
  metrics: DashboardMetrics;
  thumbnailUrl: string | null;
  thumbnailAlt: string | null;
  trackedEntity: DashboardTrackedEntity | null;
  /** Safe, high-level score explanations rather than implementation internals. */
  signals: string[];
}

export interface DashboardScoreBreakdown {
  /** Relative to account / platform historical expectations, on a 0–100 scale. */
  relativeVirality: number;
  /** Observed metric change, age-normalized and platform-normalized. */
  velocity: number;
  freshness: number;
  /** Independent community/source agreement, not simple company cross-posting. */
  crossPlatformConfirmation: number;
  sourceQuality: number;
  absoluteSignificance: number;
}

export interface DashboardStory {
  id: string;
  stableKey: string;
  rank: number;
  previousRank: number | null;
  rankDelta: number | null;
  trendStatus: DashboardTrendStatus;
  /**
   * A story can be in the Top 100 for more than one view. `rank` above is
   * retained as the canonical Hottest rank for backwards-compatible clients;
   * the selected view must use this map for its position and movement.
   */
  viewRankings: Partial<Record<DashboardView, DashboardViewRanking>>;
  title: string;
  /** Exactly one source-grounded sentence. */
  summary: string;
  summaryFingerprint: string;
  thumbnailUrl: string | null;
  thumbnailAlt: string | null;
  universe: DashboardStoryUniverse;
  labels: string[];
  topics: DashboardTopic[];
  platforms: DashboardPlatform[];
  publishedAt: string;
  updatedAt: string;
  trendScore: number;
  breakingScore: number;
  emergingScore: number;
  score: DashboardScoreBreakdown;
  sourceCount: number;
  independentSourceCount: number;
  engagement: DashboardMetrics;
  sources: DashboardStorySource[];
}

/**
 * The only source data included in the list/card transport. The complete,
 * precomputed source list is available from the bounded story-detail route
 * after a visitor explicitly expands a card.
 */
export interface DashboardStoryPrimarySource {
  id: string;
  url: string;
  title: string | null;
  publisher: string | null;
  platform: DashboardPlatform;
  sourceKind: DashboardSourceKind;
  publishedAt: string;
  /** Native counters from this displayed source, never an aggregate story total. */
  metrics: DashboardMetrics;
}

/**
 * Public card representation. It deliberately excludes source lists and raw
 * model/intermediate score fields; the cards need only their published Trend
 * Score and view-specific ranks.
 */
export type DashboardStoryCard = Omit<
  DashboardStory,
  "sources" | "summaryFingerprint" | "score" | "breakingScore" | "emergingScore"
> & {
  primarySource: DashboardStoryPrimarySource | null;
};

/** Bounded precomputed detail returned only for one expanded story. */
export interface DashboardStorySourceDetail {
  stableKey: string;
  sourceCount: number;
  /** Detail rows are display-safe source fields, never raw scoring metadata. */
  sources: DashboardStoryPrimarySource[];
  truncated: boolean;
}

export interface DashboardViewRanking {
  /** One-based position within this specific view's Top 100. */
  rank: number;
  previousRank: number | null;
  rankDelta: number | null;
  trendStatus: DashboardTrendStatus;
}

export interface DashboardAvailableFilters {
  topics: DashboardTopic[];
  platforms: DashboardPlatform[];
}

export interface DashboardPublicSnapshot {
  schemaVersion: typeof DASHBOARD_SCHEMA_VERSION;
  generatedAt: string;
  updatedAt: string;
  windowStart: string;
  windowEnd: string;
  /** Small, factual bullet list derived only from the ranked stories. */
  todayInTech: string[];
  stories: DashboardStory[];
  availableFilters: DashboardAvailableFilters;
  /** Source health belongs here, never in a user-facing story claim. */
  status: {
    candidateCount: number;
    eligibleCandidateCount: number;
    /** Number of unique stories retained across the three Top-100 views. */
    storyCount: number;
    /** Keeps the public payload honest when view lists overlap. */
    viewStoryCounts: Record<DashboardView, number>;
    partialPlatformFailures: string[];
  };
}

/**
 * Compact public list artifact used by `/dashboard` and `/api/dashboard`.
 * The worker creates it from the same immutable ranking projection as the
 * complete source artifact, so browser requests never score or discover.
 */
export interface DashboardPublicFeedSnapshot {
  schemaVersion: typeof DASHBOARD_SCHEMA_VERSION;
  /** Identifies the complete precomputed source snapshot this feed was derived from. */
  sourceSnapshotFingerprint: string;
  generatedAt: string;
  updatedAt: string;
  windowStart: string;
  windowEnd: string;
  todayInTech: string[];
  stories: DashboardStoryCard[];
  availableFilters: DashboardAvailableFilters;
  status: DashboardPublicSnapshot["status"];
}

export interface DashboardRankSnapshot {
  stableKey: string;
  /** Rank history is view-specific; a story may have up to three entries per run. */
  view: DashboardView;
  rank: number;
  trendScore: number;
  capturedAt: string;
}

export interface DashboardPipelineOptions {
  now?: Date;
  priorRankSnapshots?: DashboardRankSnapshot[];
  /** Reuses a previously checked, source-grounded sentence until inputs materially change. */
  priorStories?: DashboardStory[];
  limit?: number;
  platformFailures?: string[];
}

export interface DashboardPipelineResult {
  snapshot: DashboardPublicSnapshot;
  rankSnapshots: DashboardRankSnapshot[];
  diagnostics: {
    candidateCount: number;
    eligibleCandidateCount: number;
    duplicateSourcesRemoved: number;
    clusterCount: number;
    newStoryCount: number;
    updatedStoryCount: number;
    platformDistribution: Record<string, number>;
    topicDistribution: Record<string, number>;
    universeDistribution: Record<DashboardStoryUniverse, number>;
  };
}

export function isDashboardTopic(value: string): value is DashboardTopic {
  return (DASHBOARD_TOPICS as readonly string[]).includes(value);
}

export function isDashboardPlatform(value: string): value is DashboardPlatform {
  return (DASHBOARD_PLATFORMS as readonly string[]).includes(value);
}

/**
 * Stable keys are worker-created opaque identifiers, not free-form route
 * values. Keeping this contract narrow lets the public source route stay
 * public without becoming a wildcard API bypass.
 */
export function isDashboardStoryStableKey(value: string): boolean {
  return /^story-[a-z0-9][a-z0-9_-]{0,127}$/.test(value);
}
