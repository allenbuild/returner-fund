export type Json =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | Json[];

export type JsonObject = { [key: string]: Json | undefined };
export type Timestamp = string;

export type EntityType = "company" | "founder";

export type SocialPlatform =
  | "github"
  | "x"
  | "twitter"
  | "linkedin"
  | "instagram"
  | "product_hunt"
  | "youtube"
  | "tiktok"
  | "bluesky"
  | "hacker_news"
  | "reddit"
  | "rss"
  | "blog"
  | "news"
  | "web"
  | "bilibili"
  | "xiaohongshu"
  | "other";

export type MediaType = "text" | "image" | "video" | "link" | "repo" | "launch" | "unknown";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "canceled";
export type GraphEdgeType = "founder_of" | "industry_similarity" | "same_group_partner" | "other";
export type ReviewState = "verified" | "needs_review" | "rejected";
export type EvidenceKind =
  | "post"
  | "comment"
  | "thread"
  | "video"
  | "repository"
  | "release"
  | "launch"
  | "article"
  | "profile"
  | "account"
  | "feed_item"
  | "other";
export type EvidenceAttributionType =
  | "subject"
  | "author"
  | "mention"
  | "account_owner"
  | "founder_rollup"
  | "other";
export type AttributionRiskLevel = "low" | "medium" | "high";
export type MetricUnit =
  | "count"
  | "ratio"
  | "percentage"
  | "seconds"
  | "bytes"
  | "currency"
  | "other";

type TableDefinition<Row, Insert, Update> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export interface Database {
  public: {
    Tables: {
      batches: TableDefinition<
        {
          id: string;
          slug: string;
          label: string;
          company_count_expected: number | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          slug: string;
          label: string;
          company_count_expected?: number | null;
          created_at?: string;
          updated_at?: string;
        },
        {
          id?: string;
          slug?: string;
          label?: string;
          company_count_expected?: number | null;
          created_at?: string;
          updated_at?: string;
        }
      >;
      companies: TableDefinition<
        {
          id: string;
          batch_id: string;
          yc_profile_url: string | null;
          name: string;
          website_url: string | null;
          tagline: string | null;
          description: string | null;
          group_partner: string | null;
          business_model: string | null;
          customer_type: string | null;
          pricing_model: string | null;
          review_state: ReviewState;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          batch_id: string;
          yc_profile_url?: string | null;
          name: string;
          website_url?: string | null;
          tagline?: string | null;
          description?: string | null;
          group_partner?: string | null;
          business_model?: string | null;
          customer_type?: string | null;
          pricing_model?: string | null;
          review_state?: ReviewState;
          created_at?: string;
          updated_at?: string;
        },
        {
          id?: string;
          batch_id?: string;
          yc_profile_url?: string | null;
          name?: string;
          website_url?: string | null;
          tagline?: string | null;
          description?: string | null;
          group_partner?: string | null;
          business_model?: string | null;
          customer_type?: string | null;
          pricing_model?: string | null;
          review_state?: ReviewState;
          created_at?: string;
          updated_at?: string;
        }
      >;
      founders: TableDefinition<
        {
          id: string;
          name: string;
          yc_profile_url: string | null;
          linkedin_url: string | null;
          x_url: string | null;
          instagram_url: string | null;
          personal_website_url: string | null;
          review_state: ReviewState;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          name: string;
          yc_profile_url?: string | null;
          linkedin_url?: string | null;
          x_url?: string | null;
          instagram_url?: string | null;
          personal_website_url?: string | null;
          review_state?: ReviewState;
          created_at?: string;
          updated_at?: string;
        },
        {
          id?: string;
          name?: string;
          yc_profile_url?: string | null;
          linkedin_url?: string | null;
          x_url?: string | null;
          instagram_url?: string | null;
          personal_website_url?: string | null;
          review_state?: ReviewState;
          created_at?: string;
          updated_at?: string;
        }
      >;
      company_founders: TableDefinition<
        {
          company_id: string;
          founder_id: string;
          role: string | null;
          review_state: ReviewState;
          source_url: string | null;
        },
        {
          company_id: string;
          founder_id: string;
          role?: string | null;
          review_state?: ReviewState;
          source_url?: string | null;
        },
        {
          company_id?: string;
          founder_id?: string;
          role?: string | null;
          review_state?: ReviewState;
          source_url?: string | null;
        }
      >;
      industries: TableDefinition<
        {
          id: string;
          name: string;
        },
        {
          id?: string;
          name: string;
        },
        {
          id?: string;
          name?: string;
        }
      >;
      company_industries: TableDefinition<
        {
          company_id: string;
          industry_id: string;
          review_state: ReviewState;
          source_url: string | null;
        },
        {
          company_id: string;
          industry_id: string;
          review_state?: ReviewState;
          source_url?: string | null;
        },
        {
          company_id?: string;
          industry_id?: string;
          review_state?: ReviewState;
          source_url?: string | null;
        }
      >;
      social_accounts: TableDefinition<
        {
          id: string;
          entity_type: EntityType;
          entity_id: string;
          platform: SocialPlatform;
          handle: string | null;
          url: string;
          account_id: string | null;
          follower_count: number | null;
          following_count: number | null;
          verified: boolean;
          review_state: ReviewState;
          discovered_from_url: string | null;
          evidence_json: Json;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          entity_type: EntityType;
          entity_id: string;
          platform: SocialPlatform;
          handle?: string | null;
          url: string;
          account_id?: string | null;
          follower_count?: number | null;
          following_count?: number | null;
          verified?: boolean;
          review_state?: ReviewState;
          discovered_from_url?: string | null;
          evidence_json?: Json;
          created_at?: string;
          updated_at?: string;
        },
        {
          id?: string;
          entity_type?: EntityType;
          entity_id?: string;
          platform?: SocialPlatform;
          handle?: string | null;
          url?: string;
          account_id?: string | null;
          follower_count?: number | null;
          following_count?: number | null;
          verified?: boolean;
          review_state?: ReviewState;
          discovered_from_url?: string | null;
          evidence_json?: Json;
          created_at?: string;
          updated_at?: string;
        }
      >;
      posts: TableDefinition<
        {
          id: string;
          social_account_id: string;
          platform: SocialPlatform;
          platform_post_id: string;
          url: string;
          author_name: string | null;
          author_handle: string | null;
          text: string;
          media_type: MediaType;
          posted_at: string | null;
          raw_json: Json;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          social_account_id: string;
          platform: SocialPlatform;
          platform_post_id: string;
          url: string;
          author_name?: string | null;
          author_handle?: string | null;
          text?: string;
          media_type?: MediaType;
          posted_at?: string | null;
          raw_json?: Json;
          created_at?: string;
          updated_at?: string;
        },
        {
          id?: string;
          social_account_id?: string;
          platform?: SocialPlatform;
          platform_post_id?: string;
          url?: string;
          author_name?: string | null;
          author_handle?: string | null;
          text?: string;
          media_type?: MediaType;
          posted_at?: string | null;
          raw_json?: Json;
          created_at?: string;
          updated_at?: string;
        }
      >;
      evidence_items: TableDefinition<
        {
          id: string;
          platform: string;
          evidence_kind: EvidenceKind;
          canonical_key: string;
          platform_object_id: string | null;
          canonical_url: string | null;
          social_account_id: string | null;
          legacy_post_id: string | null;
          published_at: Timestamp | null;
          content_fingerprint: string | null;
          first_seen_at: Timestamp;
          last_seen_at: Timestamp;
          metadata_json: JsonObject;
          created_at: Timestamp;
          updated_at: Timestamp;
        },
        {
          id?: string;
          platform: string;
          evidence_kind: EvidenceKind;
          canonical_key: string;
          platform_object_id?: string | null;
          canonical_url?: string | null;
          social_account_id?: string | null;
          legacy_post_id?: string | null;
          published_at?: Timestamp | null;
          content_fingerprint?: string | null;
          first_seen_at?: Timestamp;
          last_seen_at?: Timestamp;
          metadata_json?: JsonObject;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        },
        {
          id?: string;
          platform?: string;
          evidence_kind?: EvidenceKind;
          canonical_key?: string;
          platform_object_id?: string | null;
          canonical_url?: string | null;
          social_account_id?: string | null;
          legacy_post_id?: string | null;
          published_at?: Timestamp | null;
          content_fingerprint?: string | null;
          first_seen_at?: Timestamp;
          last_seen_at?: Timestamp;
          metadata_json?: JsonObject;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        }
      >;
      evidence_attributions: TableDefinition<
        {
          id: string;
          evidence_id: string;
          entity_type: EntityType;
          company_id: string | null;
          founder_id: string | null;
          attribution_type: EvidenceAttributionType;
          is_primary: boolean;
          score_eligible: boolean;
          review_state: ReviewState;
          risk_level: AttributionRiskLevel;
          match_reason: string;
          source_url: string | null;
          reviewed_at: Timestamp | null;
          metadata_json: JsonObject;
          created_at: Timestamp;
          updated_at: Timestamp;
        },
        {
          id?: string;
          evidence_id: string;
          entity_type: EntityType;
          company_id?: string | null;
          founder_id?: string | null;
          attribution_type?: EvidenceAttributionType;
          is_primary?: boolean;
          score_eligible?: boolean;
          review_state?: ReviewState;
          risk_level?: AttributionRiskLevel;
          match_reason: string;
          source_url?: string | null;
          reviewed_at?: Timestamp | null;
          metadata_json?: JsonObject;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        },
        {
          id?: string;
          evidence_id?: string;
          entity_type?: EntityType;
          company_id?: string | null;
          founder_id?: string | null;
          attribution_type?: EvidenceAttributionType;
          is_primary?: boolean;
          score_eligible?: boolean;
          review_state?: ReviewState;
          risk_level?: AttributionRiskLevel;
          match_reason?: string;
          source_url?: string | null;
          reviewed_at?: Timestamp | null;
          metadata_json?: JsonObject;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        }
      >;
      metric_observations: TableDefinition<
        {
          id: string;
          evidence_id: string;
          ingestion_run_id: string | null;
          metric_name: string;
          metric_value: number;
          metric_unit: MetricUnit;
          observed_at: Timestamp;
          source_name: string;
          source_url: string | null;
          is_estimated: boolean;
          metadata_json: JsonObject;
          created_at: Timestamp;
        },
        {
          id?: string;
          evidence_id: string;
          ingestion_run_id?: string | null;
          metric_name: string;
          metric_value: number;
          metric_unit?: MetricUnit;
          observed_at: Timestamp;
          source_name: string;
          source_url?: string | null;
          is_estimated?: boolean;
          metadata_json?: JsonObject;
          created_at?: Timestamp;
        },
        {
          id?: string;
          evidence_id?: string;
          ingestion_run_id?: string | null;
          metric_name?: string;
          metric_value?: number;
          metric_unit?: MetricUnit;
          observed_at?: Timestamp;
          source_name?: string;
          source_url?: string | null;
          is_estimated?: boolean;
          metadata_json?: JsonObject;
          created_at?: Timestamp;
        }
      >;
      post_metrics: TableDefinition<
        {
          id: string;
          post_id: string;
          collected_at: string;
          likes: number | null;
          comments: number | null;
          shares: number | null;
          reposts: number | null;
          views: number | null;
          saves: number | null;
          upvotes: number | null;
          stars: number | null;
          forks: number | null;
          watchers: number | null;
          issues: number | null;
          subscribers: number | null;
          raw_json: Json;
        },
        {
          id?: string;
          post_id: string;
          collected_at?: string;
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
          raw_json?: Json;
        },
        {
          id?: string;
          post_id?: string;
          collected_at?: string;
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
          raw_json?: Json;
        }
      >;
      platform_baselines: TableDefinition<
        {
          id: string;
          platform: SocialPlatform | string;
          metric_name: string;
          segment: string;
          value: number;
          source_url: string | null;
          source_title: string | null;
          collected_at: string;
          notes: string | null;
        },
        {
          id?: string;
          platform: SocialPlatform | string;
          metric_name: string;
          segment?: string;
          value: number;
          source_url?: string | null;
          source_title?: string | null;
          collected_at?: string;
          notes?: string | null;
        },
        {
          id?: string;
          platform?: SocialPlatform | string;
          metric_name?: string;
          segment?: string;
          value?: number;
          source_url?: string | null;
          source_title?: string | null;
          collected_at?: string;
          notes?: string | null;
        }
      >;
      ingestion_runs: TableDefinition<
        {
          id: string;
          batch_id: string | null;
          status: RunStatus;
          started_at: string;
          finished_at: string | null;
          logs: string[];
          errors_json: Json;
        },
        {
          id?: string;
          batch_id?: string | null;
          status?: RunStatus;
          started_at?: string;
          finished_at?: string | null;
          logs?: string[];
          errors_json?: Json;
        },
        {
          id?: string;
          batch_id?: string | null;
          status?: RunStatus;
          started_at?: string;
          finished_at?: string | null;
          logs?: string[];
          errors_json?: Json;
        }
      >;
      scoring_model_versions: TableDefinition<
        {
          id: string;
          model_key: string;
          version: string;
          config_hash: string;
          config_json: JsonObject;
          code_revision: string | null;
          supersedes_id: string | null;
          created_at: Timestamp;
        },
        {
          id?: string;
          model_key: string;
          version: string;
          config_hash: string;
          config_json: JsonObject;
          code_revision?: string | null;
          supersedes_id?: string | null;
          created_at?: Timestamp;
        },
        {
          id?: string;
          model_key?: string;
          version?: string;
          config_hash?: string;
          config_json?: JsonObject;
          code_revision?: string | null;
          supersedes_id?: string | null;
          created_at?: Timestamp;
        }
      >;
      scoring_runs: TableDefinition<
        {
          id: string;
          batch_id: string | null;
          started_at: Timestamp;
          finished_at: Timestamp | null;
          config_json: Json;
          status: RunStatus;
          notes: string | null;
          scoring_model_version_id: string | null;
          as_of_at: Timestamp | null;
          input_observed_through: Timestamp | null;
          input_fingerprint: string | null;
          run_key: string | null;
        },
        {
          id?: string;
          batch_id?: string | null;
          started_at?: Timestamp;
          finished_at?: Timestamp | null;
          config_json?: Json;
          status?: RunStatus;
          notes?: string | null;
          scoring_model_version_id?: string | null;
          as_of_at?: Timestamp | null;
          input_observed_through?: Timestamp | null;
          input_fingerprint?: string | null;
          run_key?: string | null;
        },
        {
          id?: string;
          batch_id?: string | null;
          started_at?: Timestamp;
          finished_at?: Timestamp | null;
          config_json?: Json;
          status?: RunStatus;
          notes?: string | null;
          scoring_model_version_id?: string | null;
          as_of_at?: Timestamp | null;
          input_observed_through?: Timestamp | null;
          input_fingerprint?: string | null;
          run_key?: string | null;
        }
      >;
      post_scores: TableDefinition<
        {
          id: string;
          post_id: string;
          scoring_run_id: string;
          raw_engagement: number;
          normalized_score: number;
          recency_weight: number;
          engagement_rate: number | null;
          contribution_score: number;
          explanation_json: Json;
          created_at: string;
        },
        {
          id?: string;
          post_id: string;
          scoring_run_id: string;
          raw_engagement?: number;
          normalized_score?: number;
          recency_weight?: number;
          engagement_rate?: number | null;
          contribution_score?: number;
          explanation_json?: Json;
          created_at?: string;
        },
        {
          id?: string;
          post_id?: string;
          scoring_run_id?: string;
          raw_engagement?: number;
          normalized_score?: number;
          recency_weight?: number;
          engagement_rate?: number | null;
          contribution_score?: number;
          explanation_json?: Json;
          created_at?: string;
        }
      >;
      traction_snapshots: TableDefinition<
        {
          id: string;
          batch_id: string;
          company_id: string;
          collected_at: Timestamp;
          total_score: number;
          review_state: ReviewState;
          platform_scores_json: Json;
          score_explanation_json: Json;
          scoring_run_id: string | null;
          rank: number | null;
          evidence_count: number | null;
        },
        {
          id?: string;
          batch_id: string;
          company_id: string;
          collected_at?: Timestamp;
          total_score?: number;
          review_state?: ReviewState;
          platform_scores_json?: Json;
          score_explanation_json?: Json;
          scoring_run_id?: string | null;
          rank?: number | null;
          evidence_count?: number | null;
        },
        {
          id?: string;
          batch_id?: string;
          company_id?: string;
          collected_at?: Timestamp;
          total_score?: number;
          review_state?: ReviewState;
          platform_scores_json?: Json;
          score_explanation_json?: Json;
          scoring_run_id?: string | null;
          rank?: number | null;
          evidence_count?: number | null;
        }
      >;
      founder_traction_snapshots: TableDefinition<
        {
          id: string;
          founder_id: string;
          batch_id: string;
          collected_at: Timestamp;
          total_score: number;
          review_state: ReviewState;
          platform_scores_json: Json;
          score_explanation_json: Json;
          scoring_run_id: string | null;
          rank: number | null;
          evidence_count: number | null;
        },
        {
          id?: string;
          founder_id: string;
          batch_id: string;
          collected_at?: Timestamp;
          total_score?: number;
          review_state?: ReviewState;
          platform_scores_json?: Json;
          score_explanation_json?: Json;
          scoring_run_id?: string | null;
          rank?: number | null;
          evidence_count?: number | null;
        },
        {
          id?: string;
          founder_id?: string;
          batch_id?: string;
          collected_at?: Timestamp;
          total_score?: number;
          review_state?: ReviewState;
          platform_scores_json?: Json;
          score_explanation_json?: Json;
          scoring_run_id?: string | null;
          rank?: number | null;
          evidence_count?: number | null;
        }
      >;
      graph_edges: TableDefinition<
        {
          id: string;
          batch_id: string;
          source_node_type: EntityType;
          source_node_id: string;
          target_node_type: EntityType;
          target_node_id: string;
          edge_type: GraphEdgeType;
          weight: number;
          explanation_json: Json;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          batch_id: string;
          source_node_type: EntityType;
          source_node_id: string;
          target_node_type: EntityType;
          target_node_id: string;
          edge_type: GraphEdgeType;
          weight?: number;
          explanation_json?: Json;
          created_at?: string;
          updated_at?: string;
        },
        {
          id?: string;
          batch_id?: string;
          source_node_type?: EntityType;
          source_node_id?: string;
          target_node_type?: EntityType;
          target_node_id?: string;
          edge_type?: GraphEdgeType;
          weight?: number;
          explanation_json?: Json;
          created_at?: string;
          updated_at?: string;
        }
      >;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

export type TableName = keyof Database["public"]["Tables"];
export type TableRow<Table extends TableName> = Database["public"]["Tables"][Table]["Row"];
export type TableInsert<Table extends TableName> = Database["public"]["Tables"][Table]["Insert"];
export type TableUpdate<Table extends TableName> = Database["public"]["Tables"][Table]["Update"];

export type BatchRow = TableRow<"batches">;
export type CompanyRow = TableRow<"companies">;
export type FounderRow = TableRow<"founders">;
export type CompanyFounderRow = TableRow<"company_founders">;
export type IndustryRow = TableRow<"industries">;
export type CompanyIndustryRow = TableRow<"company_industries">;
export type SocialAccountRow = TableRow<"social_accounts">;
export type PostRow = TableRow<"posts">;
export type EvidenceItemRow = TableRow<"evidence_items">;
export type EvidenceAttributionRow = TableRow<"evidence_attributions">;
export type MetricObservationRow = TableRow<"metric_observations">;
export type PostMetricRow = TableRow<"post_metrics">;
export type PlatformBaselineRow = TableRow<"platform_baselines">;
export type IngestionRunRow = TableRow<"ingestion_runs">;
export type ScoringModelVersionRow = TableRow<"scoring_model_versions">;
export type ScoringRunRow = TableRow<"scoring_runs">;
export type PostScoreRow = TableRow<"post_scores">;
export type TractionSnapshotRow = TableRow<"traction_snapshots">;
export type FounderTractionSnapshotRow = TableRow<"founder_traction_snapshots">;
export type GraphEdgeRow = TableRow<"graph_edges">;

export type SocialAccountInsert = TableInsert<"social_accounts">;
export type PostInsert = TableInsert<"posts">;
export type EvidenceItemInsert = TableInsert<"evidence_items">;
export type EvidenceAttributionInsert = TableInsert<"evidence_attributions">;
export type MetricObservationInsert = TableInsert<"metric_observations">;
export type PostMetricInsert = TableInsert<"post_metrics">;
export type ScoringModelVersionInsert = TableInsert<"scoring_model_versions">;
export type ScoringRunInsert = TableInsert<"scoring_runs">;
export type TractionSnapshotInsert = TableInsert<"traction_snapshots">;
export type FounderTractionSnapshotInsert = TableInsert<"founder_traction_snapshots">;
export type GraphEdgeInsert = TableInsert<"graph_edges">;
