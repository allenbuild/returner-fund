export type Platform =
  | "github"
  | "x"
  | "linkedin"
  | "instagram"
  | "product_hunt"
  | "youtube"
  | "rss"
  | "web"
  | "reddit"
  | "hacker_news"
  | "bilibili"
  | "tiktok";

export type EntityType = "company" | "founder";
export type EdgeType = "founder_of" | "industry_similarity" | "same_group_partner";
export type ReviewState = "verified" | "needs_review" | "rejected";

export interface Batch {
  id: string;
  slug: string;
  label: string;
}

export interface Company {
  id: string;
  batchId: string;
  ycProfileUrl: string | null;
  name: string;
  websiteUrl: string | null;
  tagline: string | null;
  description: string | null;
  groupPartner: string | null;
  review_state: ReviewState;
  industries: string[];
}

export interface Founder {
  id: string;
  name: string;
  ycProfileUrl: string | null;
  linkedinUrl: string | null;
  xUrl: string | null;
  instagramUrl: string | null;
  personalWebsiteUrl: string | null;
  review_state: ReviewState;
}

export interface CompanyFounder {
  companyId: string;
  founderId: string;
  role: string | null;
  review_state: ReviewState;
  sourceUrl: string | null;
}

export interface SocialAccount {
  id: string;
  entityType: EntityType;
  entityId: string;
  platform: Platform;
  handle: string | null;
  url: string;
  accountId: string | null;
  followerCount: number | null;
  followingCount: number | null;
  verified: boolean;
  review_state: ReviewState;
  discoveredFromUrl: string | null;
  evidence: Record<string, unknown>;
}

export interface NormalizedPost {
  id: string;
  socialAccountId: string;
  platform: Platform;
  platformPostId: string;
  url: string;
  authorName: string | null;
  authorHandle: string | null;
  text: string;
  mediaType: "text" | "image" | "video" | "link" | "repo" | "launch" | "unknown";
  postedAt: string | null;
  raw: Record<string, unknown>;
}

export interface PostMetrics {
  postId: string;
  collectedAt: string;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  reposts?: number | null;
  views?: number | null;
  saves?: number | null;
  upvotes?: number | null;
  stars?: number | null;
  forks?: number | null;
  watchers?: number | null;
  issues?: number | null;
  subscribers?: number | null;
  raw?: Record<string, unknown>;
}

export interface PostScore {
  postId: string;
  rawEngagement: number;
  normalizedScore: number;
  recencyWeight: number;
  engagementRate: number | null;
  contributionScore: number;
  explanation: ScoreExplanation;
}

export interface ScoreExplanation {
  rawMetrics: Record<string, number>;
  weights: Record<string, number>;
  rawEngagement: number;
  logEngagement: number;
  ageDays: number | null;
  recencyWeight: number;
  engagementRate: number | null;
  platformLogPercentile: number;
  engagementRatePercentile: number;
  momentumPercentile: number;
  postScore: number;
  qualitySignals: Record<string, number | string | boolean>;
  limitations: string[];
}

export interface PlatformScore {
  platform: Platform;
  score: number;
  review_state: ReviewState;
  topPostIds: string[];
  explanation: Record<string, unknown>;
}

export interface EntityScore {
  entityType: EntityType;
  entityId: string;
  totalScore: number;
  review_state: ReviewState;
  platformScores: PlatformScore[];
  explanation: Record<string, unknown>;
}

export interface EvidenceItem {
  id: string;
  entityType: EntityType;
  entityId: string;
  platform: Platform;
  author: string;
  timestamp: string | null;
  title?: string;
  text: string;
  mediaType?: "text" | "image" | "video" | "link" | "repo" | "launch" | "unknown";
  mediaUrl?: string | null;
  mediaUrls?: string[];
  thumbnailUrl?: string | null;
  thumbnailSource?: string | null;
  metrics: PostMetrics;
  sourceUrl: string;
  contributionScore: number;
  why: string;
}

export interface NeedsReviewItem {
  id: string;
  entityType: EntityType;
  entityId: string;
  entityName: string;
  platform: Platform;
  candidateUrl: string;
  review_state: ReviewState;
  matchReason: string;
}

export interface GraphNode {
  id: string;
  type: EntityType;
  label: string;
  score: number;
  review_state: ReviewState;
  radius: number;
  companyId?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  edgeType: EdgeType;
  weight: number;
  explanation: Record<string, unknown>;
}

export interface LeaderboardRow {
  rank: number;
  companyId: string;
  company: string;
  score: number;
  topPlatform: Platform;
  biggestContributingPost: string;
}

export interface FastestGainingRow {
  rank: number;
  companyId: string;
  company: string;
  scoreDelta: number;
  percentDelta: number;
  rankDelta: number;
  newHighPerformingPosts: string[];
  topPlatform: Platform;
}

export interface GraphResponse {
  batch: Batch;
  nodes: GraphNode[];
  edges: GraphEdge[];
  companies: Company[];
  founders: Founder[];
  companyFounders: CompanyFounder[];
  socialAccounts: SocialAccount[];
  evidence: EvidenceItem[];
  leaderboard: LeaderboardRow[];
  fastestGaining: FastestGainingRow[];
  needsReview: NeedsReviewItem[];
  generatedAt: string;
  mode: "demo" | "database";
}

export interface EntityRef {
  type: EntityType;
  id: string;
  name: string;
  batchSlug?: string;
  websiteUrl?: string | null;
  ycProfileUrl?: string | null;
}

export interface ReviewReason {
  signal?: string;
  weight?: number;
  matched?: boolean;
  explanation?: string;
  code?: string;
  label?: string;
  sourceUrl?: string;
}

export interface ProfileCandidate {
  platform: Platform;
  handle: string | null;
  url: string;
  accountId?: string | null;
  review_state: ReviewState;
  reasons: ReviewReason[];
  discoveredFromUrl?: string | null;
  evidence: Record<string, unknown>;
}

export interface FetchPostsOptions {
  limit?: number;
  since?: string;
  signal?: AbortSignal;
}

export interface AccountMetrics {
  followerCount: number | null;
  followingCount: number | null;
  verified: boolean;
  raw: Record<string, unknown>;
}

export interface ConnectorLimitations {
  platform: Platform;
  status?: "ready" | "stub" | "public_only" | "manual_only" | "needs_api_key" | "disabled";
  requiresAuth: boolean;
  supportsMutation: boolean;
  supportsProfileDiscovery?: boolean;
  supportsRecentPosts?: boolean;
  supportsMetrics?: boolean;
  authentication?: string;
  rateLimits?: string[];
  missingCapabilities?: string[];
  safetyRules?: string[];
  notes: string[];
}

export interface SocialProfile {
  platform: Platform;
  handle: string | null;
  url: string;
  accountId?: string | null;
  followerCount?: number | null;
  followingCount?: number | null;
  verified?: boolean | null;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  publishedAt: string | null;
}

export interface SocialConnector {
  platform: Platform;
  discoverProfiles(entity: EntityRef): Promise<ProfileCandidate[]>;
  fetchRecentPosts(profile: SocialProfile, options: FetchPostsOptions): Promise<NormalizedPost[]>;
  fetchMetrics(post: NormalizedPost): Promise<PostMetrics>;
  normalizePost(rawPost: unknown): NormalizedPost;
  getPermalink(rawPost: unknown): string | null;
  getAccountMetrics(profile: SocialProfile): Promise<AccountMetrics>;
  explainLimitations(): ConnectorLimitations;
}
