export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

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
      scoring_runs: TableDefinition<
        {
          id: string;
          batch_id: string | null;
          started_at: string;
          finished_at: string | null;
          config_json: Json;
          status: RunStatus;
          notes: string | null;
        },
        {
          id?: string;
          batch_id?: string | null;
          started_at?: string;
          finished_at?: string | null;
          config_json?: Json;
          status?: RunStatus;
          notes?: string | null;
        },
        {
          id?: string;
          batch_id?: string | null;
          started_at?: string;
          finished_at?: string | null;
          config_json?: Json;
          status?: RunStatus;
          notes?: string | null;
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
          collected_at: string;
          total_score: number;
          review_state: ReviewState;
          platform_scores_json: Json;
          score_explanation_json: Json;
        },
        {
          id?: string;
          batch_id: string;
          company_id: string;
          collected_at?: string;
          total_score?: number;
          review_state?: ReviewState;
          platform_scores_json?: Json;
          score_explanation_json?: Json;
        },
        {
          id?: string;
          batch_id?: string;
          company_id?: string;
          collected_at?: string;
          total_score?: number;
          review_state?: ReviewState;
          platform_scores_json?: Json;
          score_explanation_json?: Json;
        }
      >;
      founder_traction_snapshots: TableDefinition<
        {
          id: string;
          founder_id: string;
          batch_id: string;
          collected_at: string;
          total_score: number;
          review_state: ReviewState;
          platform_scores_json: Json;
          score_explanation_json: Json;
        },
        {
          id?: string;
          founder_id: string;
          batch_id: string;
          collected_at?: string;
          total_score?: number;
          review_state?: ReviewState;
          platform_scores_json?: Json;
          score_explanation_json?: Json;
        },
        {
          id?: string;
          founder_id?: string;
          batch_id?: string;
          collected_at?: string;
          total_score?: number;
          review_state?: ReviewState;
          platform_scores_json?: Json;
          score_explanation_json?: Json;
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
export type PostMetricRow = TableRow<"post_metrics">;
export type PlatformBaselineRow = TableRow<"platform_baselines">;
export type IngestionRunRow = TableRow<"ingestion_runs">;
export type ScoringRunRow = TableRow<"scoring_runs">;
export type PostScoreRow = TableRow<"post_scores">;
export type TractionSnapshotRow = TableRow<"traction_snapshots">;
export type FounderTractionSnapshotRow = TableRow<"founder_traction_snapshots">;
export type GraphEdgeRow = TableRow<"graph_edges">;

export type SocialAccountInsert = TableInsert<"social_accounts">;
export type PostInsert = TableInsert<"posts">;
export type PostMetricInsert = TableInsert<"post_metrics">;
export type TractionSnapshotInsert = TableInsert<"traction_snapshots">;
export type FounderTractionSnapshotInsert = TableInsert<"founder_traction_snapshots">;
export type GraphEdgeInsert = TableInsert<"graph_edges">;
