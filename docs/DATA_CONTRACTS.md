# Data Contracts

## Global Defaults

- Default batch slug: `S2026`
- Default batch label: `YC Spring 2026`
- Expected company count: `197`
- Review states: `verified`, `needs_review`, `rejected`

The canonical schema is implemented through Supabase migrations. All primary IDs use UUIDs unless a join table naturally uses composite keys.

## Database Tables

### batches

- `id`
- `slug`
- `label`
- `company_count_expected`
- `created_at`
- `updated_at`

### companies

- `id`
- `batch_id`
- `yc_profile_url`
- `name`
- `website_url`
- `tagline`
- `description`
- `group_partner`
- `business_model`
- `customer_type`
- `pricing_model`
- `review_state`
- `created_at`
- `updated_at`

### founders

- `id`
- `name`
- `yc_profile_url`
- `linkedin_url`
- `x_url`
- `instagram_url`
- `personal_website_url`
- `review_state`
- `created_at`
- `updated_at`

### company_founders

- `company_id`
- `founder_id`
- `role`
- `review_state`
- `source_url`

### industries

- `id`
- `name`

### company_industries

- `company_id`
- `industry_id`
- `review_state`
- `source_url`

### social_accounts

- `id`
- `entity_type`
- `entity_id`
- `platform`
- `handle`
- `url`
- `account_id`
- `follower_count`
- `following_count`
- `verified`
- `review_state`
- `discovered_from_url`
- `evidence_json`
- `created_at`
- `updated_at`

### posts

- `id`
- `social_account_id`
- `platform`
- `platform_post_id`
- `url`
- `canonical_url`
- `author_name`
- `author_handle`
- `text`
- `media_type`
- `posted_at`
- `raw_visible_text`
- `raw_json`
- `first_seen_at`
- `last_checked_at`
- `last_updated_at`
- `created_at`
- `updated_at`

### post_metrics

- `id`
- `post_id`
- `collected_at`
- `likes`
- `comments`
- `shares`
- `reposts`
- `views`
- `saves`
- `upvotes`
- `stars`
- `forks`
- `watchers`
- `issues`
- `subscribers`
- `raw_json`
- `first_seen_at`
- `last_checked_at`
- `last_updated_at`

### ingestion_tasks

- `id`
- `ingestion_run_id`
- `batch_id`
- `entity_type`
- `entity_id`
- `company_name`
- `platform`
- `status`
- `attempts`
- `checkpoint_key`
- `rate_limit_ms`
- `last_error`
- `locked_by`
- `locked_at`
- `created_at`
- `updated_at`

Task statuses: `queued`, `running`, `completed`, `needs_review`, `blocked_or_empty`, `skipped`, `failed`.

### source_failures

- `id`
- `ingestion_task_id`
- `platform`
- `source_url`
- `company_name`
- `failure_kind`
- `message`
- `occurred_at`
- `raw_json`

### platform_coverage

- `id`
- `batch_id`
- `company_id`
- `platform`
- `evidence_count`
- `scored_evidence_count`
- `needs_review_count`
- `failure_count`
- `status`
- `last_checked_at`
- `created_at`
- `updated_at`

Coverage statuses: `pending`, `running`, `success`, `partial_success`, `failed`, `skipped`, `blocked_or_empty`.

### discovery_attempts

- `id`
- `company_id`
- `platform`
- `query`
- `source`
- `result_count`
- `useful_result_count`
- `selected_url`
- `status`
- `failure_reason`
- `created_at`

Discovery attempts store both successful and failed query patterns so later runs can reuse or avoid them.

### source_discovery_paths

- `id`
- `company_id`
- `source_url`
- `discovered_url`
- `discovered_platform`
- `discovered_entity_type`
- `discovered_entity_name`
- `match_reason`
- `review_state`
- `created_at`

### platform_baselines

- `id`
- `platform`
- `metric_name`
- `segment`
- `value`
- `source_url`
- `source_title`
- `collected_at`
- `notes`

### post_scores

- `id`
- `post_id`
- `scoring_run_id`
- `raw_engagement`
- `normalized_score`
- `recency_weight`
- `engagement_rate`
- `contribution_score`
- `explanation_json`
- `created_at`

### traction_snapshots

- `id`
- `batch_id`
- `company_id`
- `collected_at`
- `total_score`
- `review_state`
- `platform_scores_json`
- `score_explanation_json`

### founder_traction_snapshots

- `id`
- `founder_id`
- `batch_id`
- `collected_at`
- `total_score`
- `review_state`
- `platform_scores_json`
- `score_explanation_json`

### graph_edges

- `id`
- `batch_id`
- `source_node_type`
- `source_node_id`
- `target_node_type`
- `target_node_id`
- `edge_type`
- `weight`
- `explanation_json`
- `created_at`
- `updated_at`

### ingestion_runs

- `id`
- `batch_id`
- `status`
- `started_at`
- `finished_at`
- `logs`
- `errors_json`

### scoring_runs

- `id`
- `batch_id`
- `started_at`
- `finished_at`
- `config_json`
- `status`
- `notes`

## TypeScript Contracts

### ReviewState

```ts
export type ReviewState = "verified" | "needs_review" | "rejected";
```

### Entity

```ts
export type EntityType = "company" | "founder";

export interface EntityRef {
  type: EntityType;
  id: string;
  name: string;
  batchSlug?: string;
  websiteUrl?: string | null;
  ycProfileUrl?: string | null;
}
```

### Batch

```ts
export interface Batch {
  id: string;
  slug: string;
  label: string;
  companyCountExpected: number | null;
}
```

### Company

```ts
export interface Company {
  id: string;
  batchId: string;
  ycProfileUrl: string | null;
  name: string;
  websiteUrl: string | null;
  tagline: string | null;
  description: string | null;
  groupPartner: string | null;
  businessModel: string | null;
  customerType: string | null;
  pricingModel: string | null;
  review_state: ReviewState;
  industries: string[];
}
```

### Connector

```ts
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
```

### Profile Candidate

```ts
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
```

### Normalized Post

```ts
export interface NormalizedPost {
  platform: Platform;
  platformPostId: string;
  url: string;
  authorName: string | null;
  authorHandle: string | null;
  text: string;
  mediaType: "text" | "image" | "video" | "link" | "repo" | "launch" | "unknown";
  postedAt: string | null;
  raw: unknown;
}
```

### Graph API

`GET /api/graph?batch=S2026&date=latest`

```ts
export interface GraphResponse {
  batch: {
    slug: string;
    label: string;
    companyCountExpected: number | null;
    companyCountLoaded: number;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  leaderboard: LeaderboardRow[];
  fastestGaining: FastestGainingRow[];
  reviewQueue: ReviewQueueItem[];
  generatedAt: string;
  mode: "demo" | "database";
}
```

Graph API query filters should include batch, date/snapshot, platforms, edge types, score range, query, and review state. They should not include numeric identity-quality filters.

### Ingest API

`POST /api/ingest/batch`

```ts
export interface IngestBatchRequest {
  batchSlug: string;
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
  status: "queued" | "running" | "completed" | "failed";
  logs: string[];
  errors: string[];
  graph?: GraphResponse;
}
```

Callers should send `batchSlug: "S2026"` by default. Ingest results should compare loaded companies with `company_count_expected` when that value is present.
