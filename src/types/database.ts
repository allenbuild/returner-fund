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
export type IngestionTaskStatus =
  | "queued"
  | "running"
  | "retry_scheduled"
  | "completed"
  | "needs_review"
  | "blocked_or_empty"
  | "skipped"
  | "failed"
  | "canceled"
  | "dead_lettered";
export type CoverageStatus =
  | "pending"
  | "running"
  | "success"
  | "partial_success"
  | "failed"
  | "skipped"
  | "blocked_or_empty";
export type DiscoveryStatus = CoverageStatus | "needs_review";
export type IngestionEventSeverity = "debug" | "info" | "warning" | "error";
export type DeadLetterStatus = "open" | "requeued" | "resolved" | "dismissed";

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
          source_key: string | null;
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
          source_key?: string | null;
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
          source_key?: string | null;
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
          source_key: string | null;
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
          source_key?: string | null;
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
          source_key?: string | null;
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
          source_key: string | null;
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
          source_key?: string | null;
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
          source_key?: string | null;
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
          canonical_url: string | null;
          raw_visible_text: string | null;
          first_seen_at: Timestamp;
          last_checked_at: Timestamp;
          last_updated_at: Timestamp;
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
          canonical_url?: string | null;
          raw_visible_text?: string | null;
          first_seen_at?: Timestamp;
          last_checked_at?: Timestamp;
          last_updated_at?: Timestamp;
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
          canonical_url?: string | null;
          raw_visible_text?: string | null;
          first_seen_at?: Timestamp;
          last_checked_at?: Timestamp;
          last_updated_at?: Timestamp;
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
          first_seen_at: Timestamp;
          last_checked_at: Timestamp;
          last_updated_at: Timestamp;
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
          first_seen_at?: Timestamp;
          last_checked_at?: Timestamp;
          last_updated_at?: Timestamp;
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
          first_seen_at?: Timestamp;
          last_checked_at?: Timestamp;
          last_updated_at?: Timestamp;
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
      ingestion_tasks: TableDefinition<
        {
          id: string;
          ingestion_run_id: string | null;
          batch_id: string | null;
          entity_type: EntityType;
          entity_id: string | null;
          company_name: string;
          platform: string;
          status: IngestionTaskStatus;
          attempts: number;
          checkpoint_key: string;
          rate_limit_ms: number;
          last_error: string | null;
          locked_by: string | null;
          locked_at: Timestamp | null;
          max_attempts: number;
          priority: number;
          next_attempt_at: Timestamp | null;
          last_attempt_at: Timestamp | null;
          retry_base_delay_seconds: number;
          lease_token: string | null;
          lease_expires_at: Timestamp | null;
          terminal_at: Timestamp | null;
          terminal_reason: string | null;
          last_failure_kind: string | null;
          last_error_json: JsonObject;
          created_at: Timestamp;
          updated_at: Timestamp;
        },
        {
          id?: string;
          ingestion_run_id?: string | null;
          batch_id?: string | null;
          entity_type: EntityType;
          entity_id?: string | null;
          company_name: string;
          platform: string;
          status?: IngestionTaskStatus;
          attempts?: number;
          checkpoint_key: string;
          rate_limit_ms?: number;
          last_error?: string | null;
          locked_by?: string | null;
          locked_at?: Timestamp | null;
          max_attempts?: number;
          priority?: number;
          next_attempt_at?: Timestamp | null;
          last_attempt_at?: Timestamp | null;
          retry_base_delay_seconds?: number;
          lease_token?: string | null;
          lease_expires_at?: Timestamp | null;
          terminal_at?: Timestamp | null;
          terminal_reason?: string | null;
          last_failure_kind?: string | null;
          last_error_json?: JsonObject;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        },
        {
          id?: string;
          ingestion_run_id?: string | null;
          batch_id?: string | null;
          entity_type?: EntityType;
          entity_id?: string | null;
          company_name?: string;
          platform?: string;
          status?: IngestionTaskStatus;
          attempts?: number;
          checkpoint_key?: string;
          rate_limit_ms?: number;
          last_error?: string | null;
          locked_by?: string | null;
          locked_at?: Timestamp | null;
          max_attempts?: number;
          priority?: number;
          next_attempt_at?: Timestamp | null;
          last_attempt_at?: Timestamp | null;
          retry_base_delay_seconds?: number;
          lease_token?: string | null;
          lease_expires_at?: Timestamp | null;
          terminal_at?: Timestamp | null;
          terminal_reason?: string | null;
          last_failure_kind?: string | null;
          last_error_json?: JsonObject;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        }
      >;
      source_failures: TableDefinition<
        {
          id: string;
          ingestion_task_id: string | null;
          platform: string;
          source_url: string | null;
          company_name: string;
          failure_kind: string;
          message: string;
          occurred_at: Timestamp;
          raw_json: Json;
        },
        {
          id?: string;
          ingestion_task_id?: string | null;
          platform: string;
          source_url?: string | null;
          company_name: string;
          failure_kind: string;
          message: string;
          occurred_at?: Timestamp;
          raw_json?: Json;
        },
        {
          id?: string;
          ingestion_task_id?: string | null;
          platform?: string;
          source_url?: string | null;
          company_name?: string;
          failure_kind?: string;
          message?: string;
          occurred_at?: Timestamp;
          raw_json?: Json;
        }
      >;
      platform_coverage: TableDefinition<
        {
          id: string;
          batch_id: string | null;
          company_id: string | null;
          platform: string;
          evidence_count: number;
          scored_evidence_count: number;
          needs_review_count: number;
          failure_count: number;
          status: CoverageStatus;
          last_checked_at: Timestamp | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        },
        {
          id?: string;
          batch_id?: string | null;
          company_id?: string | null;
          platform: string;
          evidence_count?: number;
          scored_evidence_count?: number;
          needs_review_count?: number;
          failure_count?: number;
          status?: CoverageStatus;
          last_checked_at?: Timestamp | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        },
        {
          id?: string;
          batch_id?: string | null;
          company_id?: string | null;
          platform?: string;
          evidence_count?: number;
          scored_evidence_count?: number;
          needs_review_count?: number;
          failure_count?: number;
          status?: CoverageStatus;
          last_checked_at?: Timestamp | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        }
      >;
      discovery_attempts: TableDefinition<
        {
          id: string;
          company_id: string | null;
          platform: string;
          query: string;
          source: string;
          result_count: number;
          useful_result_count: number;
          selected_url: string | null;
          status: DiscoveryStatus;
          failure_reason: string | null;
          created_at: Timestamp;
        },
        {
          id?: string;
          company_id?: string | null;
          platform: string;
          query: string;
          source: string;
          result_count?: number;
          useful_result_count?: number;
          selected_url?: string | null;
          status: DiscoveryStatus;
          failure_reason?: string | null;
          created_at?: Timestamp;
        },
        {
          id?: string;
          company_id?: string | null;
          platform?: string;
          query?: string;
          source?: string;
          result_count?: number;
          useful_result_count?: number;
          selected_url?: string | null;
          status?: DiscoveryStatus;
          failure_reason?: string | null;
          created_at?: Timestamp;
        }
      >;
      source_discovery_paths: TableDefinition<
        {
          id: string;
          company_id: string | null;
          source_url: string;
          discovered_url: string;
          discovered_platform: string;
          discovered_entity_type: EntityType;
          discovered_entity_name: string;
          match_reason: string;
          review_state: ReviewState;
          created_at: Timestamp;
        },
        {
          id?: string;
          company_id?: string | null;
          source_url: string;
          discovered_url: string;
          discovered_platform: string;
          discovered_entity_type: EntityType;
          discovered_entity_name: string;
          match_reason: string;
          review_state?: ReviewState;
          created_at?: Timestamp;
        },
        {
          id?: string;
          company_id?: string | null;
          source_url?: string;
          discovered_url?: string;
          discovered_platform?: string;
          discovered_entity_type?: EntityType;
          discovered_entity_name?: string;
          match_reason?: string;
          review_state?: ReviewState;
          created_at?: Timestamp;
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
          idempotency_key: string | null;
          heartbeat_at: Timestamp | null;
          lease_owner: string | null;
          lease_token: string | null;
          lease_expires_at: Timestamp | null;
          stats_json: JsonObject;
        },
        {
          id?: string;
          batch_id?: string | null;
          status?: RunStatus;
          started_at?: string;
          finished_at?: string | null;
          logs?: string[];
          errors_json?: Json;
          idempotency_key?: string | null;
          heartbeat_at?: Timestamp | null;
          lease_owner?: string | null;
          lease_token?: string | null;
          lease_expires_at?: Timestamp | null;
          stats_json?: JsonObject;
        },
        {
          id?: string;
          batch_id?: string | null;
          status?: RunStatus;
          started_at?: string;
          finished_at?: string | null;
          logs?: string[];
          errors_json?: Json;
          idempotency_key?: string | null;
          heartbeat_at?: Timestamp | null;
          lease_owner?: string | null;
          lease_token?: string | null;
          lease_expires_at?: Timestamp | null;
          stats_json?: JsonObject;
        }
      >;
      ingestion_runtime_locks: TableDefinition<
        {
          lock_key: string;
          owner_id: string;
          lease_token: string;
          heartbeat_at: Timestamp;
          lease_expires_at: Timestamp;
          metadata_json: JsonObject;
          created_at: Timestamp;
          updated_at: Timestamp;
        },
        {
          lock_key: string;
          owner_id: string;
          lease_token?: string;
          heartbeat_at?: Timestamp;
          lease_expires_at: Timestamp;
          metadata_json?: JsonObject;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        },
        {
          lock_key?: string;
          owner_id?: string;
          lease_token?: string;
          heartbeat_at?: Timestamp;
          lease_expires_at?: Timestamp;
          metadata_json?: JsonObject;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        }
      >;
      ingestion_run_events: TableDefinition<
        {
          id: string;
          ingestion_run_id: string;
          ingestion_task_id: string | null;
          event_key: string | null;
          event_type: string;
          severity: IngestionEventSeverity;
          message: string | null;
          payload_json: JsonObject;
          occurred_at: Timestamp;
          created_at: Timestamp;
        },
        {
          id?: string;
          ingestion_run_id: string;
          ingestion_task_id?: string | null;
          event_key?: string | null;
          event_type: string;
          severity?: IngestionEventSeverity;
          message?: string | null;
          payload_json?: JsonObject;
          occurred_at?: Timestamp;
          created_at?: Timestamp;
        },
        {
          id?: string;
          ingestion_run_id?: string;
          ingestion_task_id?: string | null;
          event_key?: string | null;
          event_type?: string;
          severity?: IngestionEventSeverity;
          message?: string | null;
          payload_json?: JsonObject;
          occurred_at?: Timestamp;
          created_at?: Timestamp;
        }
      >;
      ingestion_checkpoints: TableDefinition<
        {
          id: string;
          social_account_id: string;
          platform: string;
          stream_key: string;
          cursor_json: JsonObject;
          high_watermark_at: Timestamp | null;
          last_successful_run_id: string | null;
          last_success_at: Timestamp | null;
          version: number;
          created_at: Timestamp;
          updated_at: Timestamp;
        },
        {
          id?: string;
          social_account_id: string;
          platform: string;
          stream_key?: string;
          cursor_json?: JsonObject;
          high_watermark_at?: Timestamp | null;
          last_successful_run_id?: string | null;
          last_success_at?: Timestamp | null;
          version?: number;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        },
        {
          id?: string;
          social_account_id?: string;
          platform?: string;
          stream_key?: string;
          cursor_json?: JsonObject;
          high_watermark_at?: Timestamp | null;
          last_successful_run_id?: string | null;
          last_success_at?: Timestamp | null;
          version?: number;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        }
      >;
      provider_rate_limits: TableDefinition<
        {
          id: string;
          provider: string;
          scope_key: string;
          limit_value: number | null;
          remaining: number | null;
          reset_at: Timestamp | null;
          blocked_until: Timestamp | null;
          consecutive_failures: number;
          last_response_at: Timestamp | null;
          metadata_json: JsonObject;
          created_at: Timestamp;
          updated_at: Timestamp;
        },
        {
          id?: string;
          provider: string;
          scope_key?: string;
          limit_value?: number | null;
          remaining?: number | null;
          reset_at?: Timestamp | null;
          blocked_until?: Timestamp | null;
          consecutive_failures?: number;
          last_response_at?: Timestamp | null;
          metadata_json?: JsonObject;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        },
        {
          id?: string;
          provider?: string;
          scope_key?: string;
          limit_value?: number | null;
          remaining?: number | null;
          reset_at?: Timestamp | null;
          blocked_until?: Timestamp | null;
          consecutive_failures?: number;
          last_response_at?: Timestamp | null;
          metadata_json?: JsonObject;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        }
      >;
      ingestion_dead_letters: TableDefinition<
        {
          id: string;
          ingestion_task_id: string;
          ingestion_run_id: string | null;
          failure_kind: string;
          failure_message: string | null;
          attempts: number;
          task_snapshot_json: JsonObject;
          error_json: JsonObject;
          status: DeadLetterStatus;
          dead_lettered_at: Timestamp;
          resolved_at: Timestamp | null;
          resolution_note: string | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        },
        {
          id?: string;
          ingestion_task_id: string;
          ingestion_run_id?: string | null;
          failure_kind: string;
          failure_message?: string | null;
          attempts: number;
          task_snapshot_json: JsonObject;
          error_json?: JsonObject;
          status?: DeadLetterStatus;
          dead_lettered_at?: Timestamp;
          resolved_at?: Timestamp | null;
          resolution_note?: string | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        },
        {
          id?: string;
          ingestion_task_id?: string;
          ingestion_run_id?: string | null;
          failure_kind?: string;
          failure_message?: string | null;
          attempts?: number;
          task_snapshot_json?: JsonObject;
          error_json?: JsonObject;
          status?: DeadLetterStatus;
          dead_lettered_at?: Timestamp;
          resolved_at?: Timestamp | null;
          resolution_note?: string | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        }
      >;
      ingestion_coverage_reports: TableDefinition<
        {
          id: string;
          ingestion_run_id: string;
          batch_id: string | null;
          report_key: string;
          platform: string | null;
          expected_count: number;
          attempted_count: number;
          succeeded_count: number;
          failed_count: number;
          skipped_count: number;
          report_json: JsonObject;
          generated_at: Timestamp;
          created_at: Timestamp;
        },
        {
          id?: string;
          ingestion_run_id: string;
          batch_id?: string | null;
          report_key: string;
          platform?: string | null;
          expected_count?: number;
          attempted_count?: number;
          succeeded_count?: number;
          failed_count?: number;
          skipped_count?: number;
          report_json?: JsonObject;
          generated_at?: Timestamp;
          created_at?: Timestamp;
        },
        {
          id?: string;
          ingestion_run_id?: string;
          batch_id?: string | null;
          report_key?: string;
          platform?: string | null;
          expected_count?: number;
          attempted_count?: number;
          succeeded_count?: number;
          failed_count?: number;
          skipped_count?: number;
          report_json?: JsonObject;
          generated_at?: Timestamp;
          created_at?: Timestamp;
        }
      >;
      ingestion_artifact_manifests: TableDefinition<
        {
          id: string;
          ingestion_run_id: string;
          ingestion_task_id: string | null;
          artifact_key: string;
          artifact_type: string;
          storage_uri: string;
          content_type: string | null;
          byte_size: number | null;
          sha256: string | null;
          metadata_json: JsonObject;
          created_at: Timestamp;
        },
        {
          id?: string;
          ingestion_run_id: string;
          ingestion_task_id?: string | null;
          artifact_key: string;
          artifact_type: string;
          storage_uri: string;
          content_type?: string | null;
          byte_size?: number | null;
          sha256?: string | null;
          metadata_json?: JsonObject;
          created_at?: Timestamp;
        },
        {
          id?: string;
          ingestion_run_id?: string;
          ingestion_task_id?: string | null;
          artifact_key?: string;
          artifact_type?: string;
          storage_uri?: string;
          content_type?: string | null;
          byte_size?: number | null;
          sha256?: string | null;
          metadata_json?: JsonObject;
          created_at?: Timestamp;
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
    Functions: {
      claim_ingestion_runtime_lock: {
        Args: {
          p_lock_key: string;
          p_owner_id: string;
          p_lease_duration?: string;
          p_metadata_json?: Json;
        };
        Returns: Database["public"]["Tables"]["ingestion_runtime_locks"]["Row"][];
      };
      renew_ingestion_runtime_lock: {
        Args: {
          p_lock_key: string;
          p_owner_id: string;
          p_lease_token: string;
          p_lease_duration?: string;
        };
        Returns: boolean;
      };
      release_ingestion_runtime_lock: {
        Args: {
          p_lock_key: string;
          p_owner_id: string;
          p_lease_token: string;
        };
        Returns: boolean;
      };
      finalize_completed_ingestion_run: {
        Args: {
          p_run_id: string;
          p_lease_owner: string;
          p_lease_token: string;
          p_stats_json?: Json;
        };
        Returns: Database["public"]["Tables"]["ingestion_runs"]["Row"][];
      };
      claim_ingestion_tasks: {
        Args: {
          p_worker_id: string;
          p_limit?: number;
          p_lease_duration?: string;
          p_ingestion_run_id?: string | null;
          p_platform?: string | null;
        };
        Returns: Database["public"]["Tables"]["ingestion_tasks"]["Row"][];
      };
      renew_ingestion_task_lease: {
        Args: {
          p_task_id: string;
          p_worker_id: string;
          p_lease_token: string;
          p_lease_duration?: string;
        };
        Returns: boolean;
      };
      requeue_expired_ingestion_tasks: {
        Args: {
          p_limit?: number;
        };
        Returns: Database["public"]["Tables"]["ingestion_tasks"]["Row"][];
      };
    };
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
export type IngestionTaskRow = TableRow<"ingestion_tasks">;
export type SourceFailureRow = TableRow<"source_failures">;
export type PlatformCoverageRow = TableRow<"platform_coverage">;
export type DiscoveryAttemptRow = TableRow<"discovery_attempts">;
export type SourceDiscoveryPathRow = TableRow<"source_discovery_paths">;
export type IngestionRunRow = TableRow<"ingestion_runs">;
export type IngestionRuntimeLockRow = TableRow<"ingestion_runtime_locks">;
export type IngestionRunEventRow = TableRow<"ingestion_run_events">;
export type IngestionCheckpointRow = TableRow<"ingestion_checkpoints">;
export type ProviderRateLimitRow = TableRow<"provider_rate_limits">;
export type IngestionDeadLetterRow = TableRow<"ingestion_dead_letters">;
export type IngestionCoverageReportRow = TableRow<"ingestion_coverage_reports">;
export type IngestionArtifactManifestRow = TableRow<"ingestion_artifact_manifests">;
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
export type IngestionTaskInsert = TableInsert<"ingestion_tasks">;
export type SourceFailureInsert = TableInsert<"source_failures">;
export type PlatformCoverageInsert = TableInsert<"platform_coverage">;
export type DiscoveryAttemptInsert = TableInsert<"discovery_attempts">;
export type SourceDiscoveryPathInsert = TableInsert<"source_discovery_paths">;
export type IngestionRunInsert = TableInsert<"ingestion_runs">;
export type IngestionRuntimeLockInsert = TableInsert<"ingestion_runtime_locks">;
export type IngestionRunEventInsert = TableInsert<"ingestion_run_events">;
export type IngestionCheckpointInsert = TableInsert<"ingestion_checkpoints">;
export type ProviderRateLimitInsert = TableInsert<"provider_rate_limits">;
export type IngestionDeadLetterInsert = TableInsert<"ingestion_dead_letters">;
export type IngestionCoverageReportInsert = TableInsert<"ingestion_coverage_reports">;
export type IngestionArtifactManifestInsert = TableInsert<"ingestion_artifact_manifests">;
export type ScoringModelVersionInsert = TableInsert<"scoring_model_versions">;
export type ScoringRunInsert = TableInsert<"scoring_runs">;
export type TractionSnapshotInsert = TableInsert<"traction_snapshots">;
export type FounderTractionSnapshotInsert = TableInsert<"founder_traction_snapshots">;
export type GraphEdgeInsert = TableInsert<"graph_edges">;
