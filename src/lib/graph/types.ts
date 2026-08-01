import type { CompanyVertical, CompanyVerticalClassification } from "./company-verticals";
import type { PostTopic, PostTopicClassification } from "./post-topics";

export type EntityType = "company" | "founder";

export const PLATFORM_VALUES = [
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
  "bluesky"
] as const;

export type Platform = (typeof PLATFORM_VALUES)[number];

export type EdgeType = "founder_of" | "industry_similarity" | "same_group_partner" | "top_voice_attention";
export type ReviewState = "verified" | "needs_review" | "rejected";
export type TopVoiceAudienceId = "off" | "yc_partners" | "insiders";
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
  batchSlug?: string;
  entityType: EntityType;
  entityId: string;
  platform: Platform;
  authorName: string;
  authorHandle: string | null;
  postedAt: string;
  publishedAtPrecision?: "exact" | "day" | "unknown";
  observedAt?: string | null;
  metricsCheckedAt?: string | null;
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
  tractionStatus?: "scored" | "unscored";
  tractionLimitations?: string[];
  sourceUrl: string;
  platformPostId?: string | null;
  /**
   * Stable native object identity when a platform exposes one independently
   * from its mutable URL/slug. GitHub repository IDs are the first consumer.
   */
  platformObjectId?: string | null;
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
  topVoice?: EvidenceTopVoiceMatch;
  topics?: PostTopic[];
  topicClassification?: PostTopicClassification;
}

export interface EvidenceTopVoiceMatch {
  audienceId: TopVoiceAudienceId;
  memberId: string;
  displayName: string;
  category: string;
  weight: number;
  matchedBy: string;
  originalContributionScore: number;
}

export interface WeightedPlatformScore {
  platform: Platform;
  score: number;
  configuredWeight: number;
  appliedWeight: number;
  contribution: number;
  evidenceCount: number;
}

export type ScoreConfidenceLevel = "low" | "medium" | "high";

export interface ScoreConfidence {
  level: ScoreConfidenceLevel;
  value: number;
  reasons: string[];
  scoredEvidenceCount: number;
  datedEvidenceCount: number;
  verifiedLinkCount: number;
}

export interface ScoreCalibration {
  method: "none" | "tie_aware_percentile_blend";
  cohortSize: number;
  percentile: number | null;
  inputScore: number;
}

export interface ScoreBreakdown {
  modelId: string;
  modelVersion: string;
  modelName: string;
  totalScore: number;
  absoluteScore: number;
  weightedAvailableScore: number;
  coverageFactor: number;
  platformsWithEvidence: number;
  totalSupportedPlatforms: number;
  platformScores: Partial<Record<Platform, number>>;
  weightedPlatforms: WeightedPlatformScore[];
  signalFamilyScores: {
    reach: number;
    engagement: number;
    developerAdoption: number;
    launchAndCommunity: number;
    momentum: number;
  };
  confidence: ScoreConfidence;
  calibration: ScoreCalibration;
  limitations: string[];
  evidenceAsOf: string | null;
  explanation: string;
}

export interface InsiderScoreMatch {
  memberId: string;
  displayName: string;
  effectiveWeight: number;
  influenceScore: number;
  publishedWeight: number;
  publishedInfluenceScore: number;
  adjustment: number;
  evidenceCount: number;
  included: boolean;
  exclusionReason: "disabled" | "not_selected" | null;
}

export interface InsiderScoreBreakdown {
  /** The immutable score in the published Insider snapshot. */
  baseScore: number;
  publishedInsiderInfluence: number;
  /** Current quadratic influence points after configuration and selection. */
  weightedInsiderSubtotal: number;
  insiderScoreAdjustment: number;
  finalScore: number;
  selectedInsiderIds: string[];
  configurationVersion: number | null;
  matches: InsiderScoreMatch[];
  formula: "published_score_plus_quadratic_insider_adjustments_capped_0_100";
}

export interface ScoringContext {
  modelId: string;
  modelVersion: string;
  modelName: string;
  scoreScope: "all_platforms" | "selected_platforms" | "top_voice";
  selectedPlatforms: Platform[];
  responseBuiltAt: string;
  evidenceAsOf: string | null;
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
  verticals?: CompanyVertical[];
  verticalClassification?: CompanyVerticalClassification;
  founderIds: string[];
  socialAccounts: SocialAccountSummary[];
  totalScore: number;
  previousScore: number;
  platformScores: Partial<Record<Platform, number>>;
  scoreBreakdown?: ScoreBreakdown;
  insiderScoreBreakdown?: InsiderScoreBreakdown;
  topVoiceScore?: number;
  topVoiceConnectionCount?: number;
  topVoiceConnections?: TopVoiceConnectionPreview[];
  selectedTopVoiceAudience?: TopVoiceAudienceSummary;
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
  insiderScoreBreakdown?: InsiderScoreBreakdown;
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
  verticals?: CompanyVertical[];
  verticalClassification?: CompanyVerticalClassification;
  relatedEntityIds: string[];
  founders: FounderSummary[];
  review_state_counts: Record<ReviewState, number>;
  isTopVoiceNode?: boolean;
  topVoiceScore?: number;
  topVoiceConnectionCount?: number;
  topVoiceConnections?: TopVoiceConnectionPreview[];
  insiderScoreBreakdown?: InsiderScoreBreakdown;
  selectedTopVoiceAudience?: TopVoiceAudienceSummary;
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
  socialAccounts: SocialAccountSummary[];
  founderAccounts?: {
    founderId: string;
    founderName: string;
    socialAccounts: SocialAccountSummary[];
  }[];
  biggestContribution: EvidenceItem | null;
  topVoiceScore?: number;
  topVoiceConnectionCount?: number;
  topVoiceConnections?: TopVoiceConnectionPreview[];
  insiderScoreBreakdown?: InsiderScoreBreakdown;
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
  batchSlug?: string;
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
  batchSlugs?: string[];
}

export interface TopVoiceMember {
  personId: string;
  displayName: string;
  aliases: string[];
  handles: Partial<Record<Platform, string[]>>;
  category: string;
  weight: number;
  active: boolean;
  source: string;
  notes?: string;
}

export interface TopVoiceSet {
  id: Exclude<TopVoiceAudienceId, "off">;
  displayName: string;
  description: string;
  members: TopVoiceMember[];
  defaultWeight: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TopVoiceAudienceSummary {
  id: TopVoiceAudienceId;
  displayName: string;
  description: string;
  helperText: string;
  scoreLabel: string;
  scoreDescription: string;
  active: boolean;
  memberCount: number;
}

export interface TopVoiceConnectionPreview {
  memberId: string;
  displayName: string;
  category: string;
  weight: number;
  contributionScore: number;
  evidenceCount: number;
  topEvidenceId: string | null;
  platforms: Platform[];
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
  topics?: PostTopic[];
  verticals?: CompanyVertical[];
  businessModels?: BusinessModel[];
  declutter?: boolean;
  query?: string;
  similarityThreshold?: number;
  topVoices?: TopVoiceAudienceId;
  insiderIds?: string[];
}

export interface InsiderFilterOption {
  memberId: string;
  displayName: string;
  weight: number;
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
  selectedTopVoiceAudience: TopVoiceAudienceSummary;
  topVoiceAudiences: TopVoiceAudienceSummary[];
  insiderFilterOptions?: InsiderFilterOption[];
  selectedInsiderIds?: string[];
  insiderConfigurationVersion?: number | null;
  generatedAt: string;
  scoringContext?: ScoringContext;
  mode: "demo" | "database" | "official_snapshot";
}
