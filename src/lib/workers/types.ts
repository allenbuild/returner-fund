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
  | "bilibili"
  | "xiaohongshu";

export type IngestRunStatus = "queued" | "running" | "completed" | "failed";
export type ReviewState = "verified" | "needs_review" | "rejected";

export interface IngestBatchRequest {
  batchSlug?: string;
  options?: {
    demo?: boolean;
    refreshProfiles?: boolean;
    refreshPosts?: boolean;
    maxCompanies?: number;
    platforms?: Platform[];
  };
}

export interface IngestBatchResponse {
  runId: string;
  status: IngestRunStatus;
  logs: string[];
  errors: string[];
  graph?: GraphResponse;
}

export interface GraphResponse {
  batch: { slug: string; label: string; expectedCompanyCount?: number; observedCompanyCount?: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
  leaderboard: LeaderboardRow[];
  fastestGaining: FastestGainingRow[];
  needsReview: NeedsReviewItem[];
  generatedAt: string;
  mode: "demo" | "database";
}

export interface GraphNode {
  id: string;
  type: EntityType;
  label: string;
  score: number;
  review_state: ReviewState;
  radius: number;
  platformScores: Partial<Record<Platform, number>>;
  summary: {
    batchSlug?: string;
    ycProfileUrl?: string | null;
    websiteUrl?: string | null;
    tagline?: string | null;
    description?: string | null;
    groupPartner?: string | null;
    industries?: string[];
    relatedEntityIds?: string[];
  };
  evidence: EvidenceItem[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  edgeType: "founder_of" | "industry_similarity" | "same_group_partner";
  weight: number;
  explanation: Record<string, unknown>;
}

export interface EvidenceItem {
  id: string;
  platform: Platform;
  title: string;
  url: string;
  author?: string | null;
  timestamp?: string | null;
  text: string;
  metrics: Record<string, number | null>;
  contributionScore: number;
  explanation: string;
}

export interface LeaderboardRow {
  rank: number;
  entityId: string;
  company: string;
  score: number;
  topPlatform: Platform;
  biggestContributingPost: string;
}

export interface FastestGainingRow {
  entityId: string;
  company: string;
  scoreDelta: number;
  percentDelta: number;
  rankDelta: number;
  platformCausingJump: Platform;
  newHighPerformingPosts: string[];
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

export interface IngestPipelineLog {
  at: string;
  message: string;
}

export interface IngestRunRecord {
  runId: string;
  batchSlug: string;
  mode: "demo" | "database";
  logs: string[];
}
