export type EntityType = "company" | "founder";

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
  | "bilibili";

export type EdgeType = "founder_of" | "industry_similarity" | "same_group_partner";
export type ReviewState = "verified" | "needs_review" | "rejected";
export type BusinessModel =
  | "b2b"
  | "consumer"
  | "fintech"
  | "healthcare"
  | "industrial"
  | "developer_tools"
  | "api"
  | "hardware"
  | "open_source"
  | "services"
  | "marketplace";

export interface VisualEncoding {
  industryColor: string;
  shape: "ellipse" | "round-rectangle" | "diamond" | "hexagon";
  borderStyle: "solid" | "dashed" | "dotted" | "double";
  borderColor: string;
  groupRegion: string | null;
}

export interface BatchSummary {
  slug: string;
  label: string;
  companyCountExpected?: number;
  companyCountObserved?: number;
}

export interface SocialAccountSummary {
  id: string;
  platform: Platform;
  handle: string | null;
  url: string;
  review_state: ReviewState;
  discoveredFromUrl: string | null;
  matchReason: string;
}

export interface EvidenceMetrics {
  likes?: number;
  comments?: number;
  shares?: number;
  reposts?: number;
  replies?: number;
  quotes?: number;
  reactions?: number;
  views?: number;
  saves?: number;
  upvotes?: number;
  stars?: number;
  forks?: number;
  watchers?: number;
  issues?: number;
  open_issues?: number;
  followers?: number;
  subscribers?: number;
  [metric: string]: number | undefined;
}

export interface EvidenceItem {
  id: string;
  entityType: EntityType;
  entityId: string;
  platform: Platform;
  authorName: string;
  authorHandle: string | null;
  postedAt: string;
  title?: string;
  text: string;
  mediaType: "text" | "image" | "video" | "link" | "repo" | "launch" | "unknown";
  mediaUrl?: string | null;
  mediaUrls?: string[];
  thumbnailUrl?: string | null;
  thumbnailSource?: string | null;
  linkStatus?: "verified" | "invalid" | "unchecked" | "blocked" | null;
  linkCheckedAt?: string | null;
  linkFailureReason?: string | null;
  metrics: EvidenceMetrics;
  contributionScore: number;
  rawEngagement?: number;
  normalizedScore?: number;
  sourceUrl: string;
  platformPostId?: string | null;
  rawVisibleText?: string;
  first_seen_at?: string;
  last_checked_at?: string;
  last_updated_at?: string;
  why: string;
  attachedCompanyId?: string;
  attachedCompanyName?: string;
  socialAccountId?: string | null;
  canonicalAccountId?: string | null;
  accountUrl?: string | null;
  matchReason?: string;
  review_state?: ReviewState;
}

export interface WeightedPlatformScore {
  platform: Platform;
  score: number;
  configuredWeight: number;
  appliedWeight: number;
  contribution: number;
  evidenceCount: number;
}

export interface ScoreBreakdown {
  totalScore: number;
  weightedAvailableScore: number;
  coverageFactor: number;
  platformsWithEvidence: number;
  totalSupportedPlatforms: number;
  platformScores: Partial<Record<Platform, number>>;
  weightedPlatforms: WeightedPlatformScore[];
  explanation: string;
}

export interface CompanyRecord {
  id: string;
  batchSlug: string;
  name: string;
  ycProfileUrl: string;
  websiteUrl: string;
  tagline: string;
  description: string;
  groupPartner: string | null;
  primaryIndustry: string;
  businessModel: BusinessModel;
  review_state: ReviewState;
  sourceUrl: string;
  industries: string[];
  founderIds: string[];
  socialAccounts: SocialAccountSummary[];
  totalScore: number;
  previousScore: number;
  platformScores: Partial<Record<Platform, number>>;
  scoreBreakdown?: ScoreBreakdown;
}

export interface FounderRecord {
  id: string;
  batchSlug: string;
  name: string;
  ycProfileUrl: string;
  personalWebsiteUrl: string | null;
  primaryIndustry: string;
  businessModel: BusinessModel;
  review_state: ReviewState;
  sourceUrl: string;
  companyIds: string[];
  socialAccounts: SocialAccountSummary[];
  totalScore: number;
  previousScore: number;
  platformScores: Partial<Record<Platform, number>>;
  scoreBreakdown?: ScoreBreakdown;
}

export interface FounderSummary {
  id: string;
  name: string;
  ycProfileUrl: string;
  socialAccounts: SocialAccountSummary[];
  evidenceIds: string[];
  platformScores: Partial<Record<Platform, number>>;
}

export interface GraphNode {
  id: string;
  entityType: EntityType;
  entityId: string;
  label: string;
  batchSlug: string;
  score: number;
  previousScore: number;
  scoreDelta: number;
  radius: number;
  topPlatform: Platform | null;
  platformScores: Partial<Record<Platform, number>>;
  scoreBreakdown?: ScoreBreakdown;
  socialAccounts: SocialAccountSummary[];
  evidenceIds: string[];
  ycProfileUrl: string;
  websiteUrl: string | null;
  tagline: string | null;
  description: string | null;
  groupPartner: string | null;
  primaryIndustry: string;
  businessModel: BusinessModel;
  review_state: ReviewState;
  sourceUrl: string;
  visual: VisualEncoding;
  industries: string[];
  relatedEntityIds: string[];
  founders: FounderSummary[];
  review_state_counts: Record<ReviewState, number>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  edgeType: EdgeType;
  weight: number;
  label: string;
  explanation: string;
}

export interface LeaderboardRow {
  rank: number;
  companyId: string;
  companyName: string;
  score: number;
  topPlatform: Platform | null;
  biggestContribution: EvidenceItem | null;
}

export interface FastestGainingRow {
  rank: number;
  companyId: string;
  companyName: string;
  dod: MomentumDelta;
  wow: MomentumDelta;
}

export interface MomentumDelta {
  scoreDelta: number;
  percentDelta: number;
  rankDelta: number;
  currentScore: number;
  currentRank: number;
  baselineScore: number | null;
  baselineRank: number | null;
  benchmarkedAt: string | null;
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

export interface PlatformStatus {
  platform: Platform;
  status: "working" | "public_only" | "needs_config" | "disabled" | "risky";
  authMethod: string;
  notes: string;
}

export interface DemoGraphDataset {
  mode?: GraphResponse["mode"];
  batches: BatchSummary[];
  companies: CompanyRecord[];
  founders: FounderRecord[];
  evidence: EvidenceItem[];
  needsReview?: NeedsReviewItem[];
  platformStatus: PlatformStatus[];
}

export interface GraphFilters {
  batchSlug?: string;
  platforms?: Platform[];
  edgeTypes?: EdgeType[];
  minScore?: number;
  industries?: string[];
  groupPartners?: string[];
  businessModels?: BusinessModel[];
  declutter?: boolean;
  query?: string;
  similarityThreshold?: number;
}

export interface GraphResponse {
  batch: BatchSummary;
  batches: BatchSummary[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  leaderboard: LeaderboardRow[];
  fastestGaining: FastestGainingRow[];
  needsReview: NeedsReviewItem[];
  evidence: EvidenceItem[];
  platformStatus: PlatformStatus[];
  generatedAt: string;
  mode: "demo" | "database" | "official_snapshot";
}
