export type Platform =
  | "x"
  | "twitter"
  | "linkedin"
  | "instagram"
  | "product_hunt"
  | "github"
  | "youtube"
  | "reddit"
  | "rss"
  | "web"
  | "hacker_news"
  | "bilibili"
  | "tiktok";

export type BaselineReliability = "high" | "medium" | "low" | "none";
export type ReviewState = "verified" | "needs_review" | "rejected";

export interface EngagementMetrics {
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  reposts?: number | null;
  replies?: number | null;
  quotes?: number | null;
  reactions?: number | null;
  saves?: number | null;
  views?: number | null;
  upvotes?: number | null;
  stars?: number | null;
  forks?: number | null;
  watchers?: number | null;
  issues?: number | null;
  openIssues?: number | null;
  discussions?: number | null;
  productHuntUpvotes?: number | null;
  productHuntComments?: number | null;
}

export interface ScoringConfig {
  halfLifeDays: number;
  reviewWindowDays: number;
  topKPosts: number;
}

export interface PercentileSamples {
  logEngagement?: number[];
  engagementRate?: number[];
  momentum?: number[];
}

export interface PostScoreInput {
  postId: string;
  platform: Platform;
  metrics: EngagementMetrics;
  followerCount?: number | null;
  postedAt?: string | Date | null;
  collectedAt?: string | Date | null;
  percentileSamples?: PercentileSamples;
  config?: Partial<ScoringConfig>;
}

export interface PostScoreExplanation {
  rawMetrics: EngagementMetrics;
  weights: Record<string, number>;
  rawEngagement: number;
  logEngagement: number;
  ageDays: number | null;
  recencyWeight: number;
  engagementRate: number | null;
  platformLogPercentile: number;
  engagementRatePercentile: number;
  momentumPercentile: number;
  momentumValue: number;
  postScore: number;
  qualitySignals: {
    hasFollowerCount: boolean;
    hasPostedAt: boolean;
    hasComparableSamples: boolean;
  };
  limitations: string[];
}

export interface PostScoreResult {
  postId: string;
  platform: Platform;
  rawEngagement: number;
  normalizedScore: number;
  recencyWeight: number;
  engagementRate: number | null;
  contributionScore: number;
  explanationJson: PostScoreExplanation;
}

export interface AccountMetricContext {
  followerCount?: number | null;
  followerPercentile?: number | null;
  metricAvailability?: number | null;
}

export interface PlatformScoreInput {
  entityId: string;
  platform: Platform;
  postScores: PostScoreResult[];
  account_review_state: ReviewState;
  baselineReliability?: BaselineReliability;
  accountMetrics?: AccountMetricContext;
  config?: Partial<ScoringConfig>;
}

export interface PlatformScoreExplanation {
  platform: Platform;
  topPostIds: string[];
  topPostAverage: number;
  consistencyScore: number;
  accountMetricScore: number;
  formula: {
    topPostAverageWeight: number;
    consistencyWeight: number;
    accountMetricWeight: number;
  };
  qualitySignals: {
    account_review_state: ReviewState;
    metricAvailability: number;
    sampleCoverage: number;
    baselineReliability: BaselineReliability;
    baselineReliabilityMultiplier: number;
  };
  limitations: string[];
}

export interface PlatformScoreResult<TExplanation = PlatformScoreExplanation> {
  entityId: string;
  platform: Platform;
  score: number;
  review_state: ReviewState;
  explanationJson: TExplanation;
}

export interface EntityScoreInput {
  entityId: string;
  batchSlug: string;
  platformScores: Array<PlatformScoreResult<unknown>>;
  batchPeerCompositeScores?: number[];
}

export interface CompanyScoreInput {
  companyId: string;
  batchSlug: string;
  officialAccounts: Array<PlatformScoreResult<unknown>>;
  founderAccounts: Array<PlatformScoreResult<unknown>>;
  batchPeerCompositeScores?: number[];
}

export interface FounderScoreInput extends EntityScoreInput {
  relevanceToCompany?: number | null;
}

export interface PlatformBreakdown {
  platform: Platform;
  score: number;
  review_state: ReviewState;
  sourceCoverage: number;
  appliedPlatformWeight: number;
  explanationJson: unknown;
}

export interface EntityScoreExplanation {
  entityId: string;
  batchSlug: string;
  absoluteCompositeScore: number;
  batchPercentile: number | null;
  platformCoverage: number;
  defaultPlatformWeights: Partial<Record<Platform, number>>;
  platformBreakdown: PlatformBreakdown[];
  qualitySignals: Record<string, number | string>;
  limitations: string[];
}

export interface EntityScoreResult {
  entityId: string;
  batchSlug: string;
  totalScore: number;
  review_state: ReviewState;
  platformScoresJson: PlatformBreakdown[];
  scoreExplanationJson: EntityScoreExplanation;
}
