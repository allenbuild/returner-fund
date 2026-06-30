create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.batches (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  label text not null,
  company_count_expected integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint batches_slug_not_blank check (length(trim(slug)) > 0),
  constraint batches_label_not_blank check (length(trim(label)) > 0),
  constraint batches_company_count_expected_nonnegative check (
    company_count_expected is null or company_count_expected >= 0
  )
);

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.batches(id) on delete cascade,
  yc_profile_url text,
  name text not null,
  website_url text,
  tagline text,
  description text,
  group_partner text,
  business_model text,
  customer_type text,
  pricing_model text,
  review_state text not null default 'needs_review',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_name_not_blank check (length(trim(name)) > 0),
  constraint companies_review_state_check check (review_state in ('verified', 'needs_review', 'rejected')),
  constraint companies_yc_profile_url_http check (yc_profile_url is null or yc_profile_url ~* '^https?://'),
  constraint companies_website_url_http check (website_url is null or website_url ~* '^https?://')
);

create table public.founders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  yc_profile_url text,
  linkedin_url text,
  x_url text,
  instagram_url text,
  personal_website_url text,
  review_state text not null default 'needs_review',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint founders_name_not_blank check (length(trim(name)) > 0),
  constraint founders_review_state_check check (review_state in ('verified', 'needs_review', 'rejected')),
  constraint founders_yc_profile_url_http check (yc_profile_url is null or yc_profile_url ~* '^https?://'),
  constraint founders_linkedin_url_http check (linkedin_url is null or linkedin_url ~* '^https?://'),
  constraint founders_x_url_http check (x_url is null or x_url ~* '^https?://'),
  constraint founders_instagram_url_http check (instagram_url is null or instagram_url ~* '^https?://'),
  constraint founders_personal_website_url_http check (personal_website_url is null or personal_website_url ~* '^https?://')
);

create table public.company_founders (
  company_id uuid not null references public.companies(id) on delete cascade,
  founder_id uuid not null references public.founders(id) on delete cascade,
  role text,
  review_state text not null default 'needs_review',
  source_url text,
  primary key (company_id, founder_id),
  constraint company_founders_review_state_check check (review_state in ('verified', 'needs_review', 'rejected')),
  constraint company_founders_source_url_http check (source_url is null or source_url ~* '^https?://')
);

create table public.industries (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  constraint industries_name_not_blank check (length(trim(name)) > 0)
);

create table public.company_industries (
  company_id uuid not null references public.companies(id) on delete cascade,
  industry_id uuid not null references public.industries(id) on delete cascade,
  review_state text not null default 'needs_review',
  source_url text,
  primary key (company_id, industry_id),
  constraint company_industries_review_state_check check (review_state in ('verified', 'needs_review', 'rejected')),
  constraint company_industries_source_url_http check (source_url is null or source_url ~* '^https?://')
);

create table public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  platform text not null,
  handle text,
  url text not null,
  account_id text,
  follower_count bigint,
  following_count bigint,
  verified boolean not null default false,
  review_state text not null default 'needs_review',
  discovered_from_url text,
  evidence_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_accounts_entity_type_check check (entity_type in ('company', 'founder')),
  constraint social_accounts_platform_check check (
    platform in (
      'github',
      'x',
      'twitter',
      'linkedin',
      'instagram',
      'product_hunt',
      'youtube',
      'tiktok',
      'hacker_news',
      'reddit',
      'rss',
      'blog',
      'news',
      'web',
      'bilibili',
      'xiaohongshu',
      'other'
    )
  ),
  constraint social_accounts_url_http check (url ~* '^https?://'),
  constraint social_accounts_discovered_from_url_http check (discovered_from_url is null or discovered_from_url ~* '^https?://'),
  constraint social_accounts_review_state_check check (review_state in ('verified', 'needs_review', 'rejected')),
  constraint social_accounts_follower_count_nonnegative check (follower_count is null or follower_count >= 0),
  constraint social_accounts_following_count_nonnegative check (following_count is null or following_count >= 0)
);

comment on column public.social_accounts.entity_id is
  'Polymorphic reference to companies.id or founders.id based on entity_type. Application code must validate target existence.';

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  social_account_id uuid not null references public.social_accounts(id) on delete cascade,
  platform text not null,
  platform_post_id text not null,
  url text not null,
  author_name text,
  author_handle text,
  text text not null default '',
  media_type text not null default 'unknown',
  posted_at timestamptz,
  raw_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint posts_platform_check check (
    platform in (
      'github',
      'x',
      'twitter',
      'linkedin',
      'instagram',
      'product_hunt',
      'youtube',
      'tiktok',
      'hacker_news',
      'reddit',
      'rss',
      'blog',
      'news',
      'web',
      'bilibili',
      'xiaohongshu',
      'other'
    )
  ),
  constraint posts_media_type_check check (media_type in ('text', 'image', 'video', 'link', 'repo', 'launch', 'unknown')),
  constraint posts_platform_post_id_not_blank check (length(trim(platform_post_id)) > 0),
  constraint posts_url_http check (url ~* '^https?://')
);

create table public.post_metrics (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  collected_at timestamptz not null default now(),
  likes bigint,
  comments bigint,
  shares bigint,
  reposts bigint,
  views bigint,
  saves bigint,
  upvotes bigint,
  stars bigint,
  forks bigint,
  watchers bigint,
  issues bigint,
  subscribers bigint,
  raw_json jsonb not null default '{}'::jsonb,
  constraint post_metrics_likes_nonnegative check (likes is null or likes >= 0),
  constraint post_metrics_comments_nonnegative check (comments is null or comments >= 0),
  constraint post_metrics_shares_nonnegative check (shares is null or shares >= 0),
  constraint post_metrics_reposts_nonnegative check (reposts is null or reposts >= 0),
  constraint post_metrics_views_nonnegative check (views is null or views >= 0),
  constraint post_metrics_saves_nonnegative check (saves is null or saves >= 0),
  constraint post_metrics_upvotes_nonnegative check (upvotes is null or upvotes >= 0),
  constraint post_metrics_stars_nonnegative check (stars is null or stars >= 0),
  constraint post_metrics_forks_nonnegative check (forks is null or forks >= 0),
  constraint post_metrics_watchers_nonnegative check (watchers is null or watchers >= 0),
  constraint post_metrics_issues_nonnegative check (issues is null or issues >= 0),
  constraint post_metrics_subscribers_nonnegative check (subscribers is null or subscribers >= 0)
);

create table public.platform_baselines (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  metric_name text not null,
  segment text not null default 'global',
  value numeric not null,
  source_url text,
  source_title text,
  collected_at timestamptz not null default now(),
  notes text,
  constraint platform_baselines_platform_not_blank check (length(trim(platform)) > 0),
  constraint platform_baselines_metric_name_not_blank check (length(trim(metric_name)) > 0),
  constraint platform_baselines_segment_not_blank check (length(trim(segment)) > 0),
  constraint platform_baselines_value_nonnegative check (value >= 0),
  constraint platform_baselines_source_url_http check (source_url is null or source_url ~* '^https?://')
);

create table public.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.batches(id) on delete set null,
  status text not null default 'queued',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  logs text[] not null default '{}'::text[],
  errors_json jsonb not null default '[]'::jsonb,
  constraint ingestion_runs_status_check check (status in ('queued', 'running', 'completed', 'failed', 'canceled')),
  constraint ingestion_runs_finished_after_started check (finished_at is null or finished_at >= started_at)
);

create table public.scoring_runs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.batches(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  config_json jsonb not null default '{}'::jsonb,
  status text not null default 'queued',
  notes text,
  constraint scoring_runs_status_check check (status in ('queued', 'running', 'completed', 'failed', 'canceled')),
  constraint scoring_runs_finished_after_started check (finished_at is null or finished_at >= started_at)
);

create table public.post_scores (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  scoring_run_id uuid not null references public.scoring_runs(id) on delete cascade,
  raw_engagement numeric not null default 0,
  normalized_score numeric(6,3) not null default 0,
  recency_weight numeric(6,5) not null default 1,
  engagement_rate numeric,
  contribution_score numeric(6,3) not null default 0,
  explanation_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint post_scores_raw_engagement_nonnegative check (raw_engagement >= 0),
  constraint post_scores_normalized_score_range check (normalized_score >= 0 and normalized_score <= 100),
  constraint post_scores_recency_weight_range check (recency_weight >= 0 and recency_weight <= 1),
  constraint post_scores_engagement_rate_nonnegative check (engagement_rate is null or engagement_rate >= 0),
  constraint post_scores_contribution_score_range check (contribution_score >= 0 and contribution_score <= 100)
);

create table public.traction_snapshots (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.batches(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  collected_at timestamptz not null default now(),
  total_score numeric(6,3) not null default 0,
  review_state text not null default 'needs_review',
  platform_scores_json jsonb not null default '{}'::jsonb,
  score_explanation_json jsonb not null default '{}'::jsonb,
  constraint traction_snapshots_total_score_range check (total_score >= 0 and total_score <= 100),
  constraint traction_snapshots_review_state_check check (review_state in ('verified', 'needs_review', 'rejected'))
);

create table public.founder_traction_snapshots (
  id uuid primary key default gen_random_uuid(),
  founder_id uuid not null references public.founders(id) on delete cascade,
  batch_id uuid not null references public.batches(id) on delete cascade,
  collected_at timestamptz not null default now(),
  total_score numeric(6,3) not null default 0,
  review_state text not null default 'needs_review',
  platform_scores_json jsonb not null default '{}'::jsonb,
  score_explanation_json jsonb not null default '{}'::jsonb,
  constraint founder_traction_snapshots_total_score_range check (total_score >= 0 and total_score <= 100),
  constraint founder_traction_snapshots_review_state_check check (review_state in ('verified', 'needs_review', 'rejected'))
);

create table public.graph_edges (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.batches(id) on delete cascade,
  source_node_type text not null,
  source_node_id uuid not null,
  target_node_type text not null,
  target_node_id uuid not null,
  edge_type text not null,
  weight numeric(6,5) not null default 1,
  explanation_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint graph_edges_source_node_type_check check (source_node_type in ('company', 'founder')),
  constraint graph_edges_target_node_type_check check (target_node_type in ('company', 'founder')),
  constraint graph_edges_edge_type_check check (edge_type in ('founder_of', 'industry_similarity', 'same_group_partner', 'other')),
  constraint graph_edges_weight_range check (weight >= 0 and weight <= 1),
  constraint graph_edges_no_self_loop check (source_node_type <> target_node_type or source_node_id <> target_node_id)
);

comment on column public.graph_edges.source_node_id is
  'Polymorphic reference to companies.id or founders.id based on source_node_type. Application code must validate target existence.';
comment on column public.graph_edges.target_node_id is
  'Polymorphic reference to companies.id or founders.id based on target_node_type. Application code must validate target existence.';

create unique index companies_batch_name_key on public.companies (batch_id, lower(name));
create unique index industries_lower_name_key on public.industries (lower(name));
create unique index posts_platform_post_id_key on public.posts (platform, platform_post_id);
create unique index post_scores_post_scoring_run_key on public.post_scores (post_id, scoring_run_id);
create unique index social_accounts_platform_url_key on public.social_accounts (platform, url);
create unique index social_accounts_platform_account_id_key on public.social_accounts (platform, account_id) where account_id is not null;
create unique index graph_edges_unique_key on public.graph_edges (
  batch_id,
  source_node_type,
  source_node_id,
  target_node_type,
  target_node_id,
  edge_type
);

create index batches_slug_idx on public.batches (slug);
create index companies_batch_id_idx on public.companies (batch_id);
create index companies_yc_profile_url_idx on public.companies (yc_profile_url);
create index companies_review_state_idx on public.companies (review_state);
create index founders_yc_profile_url_idx on public.founders (yc_profile_url);
create index founders_review_state_idx on public.founders (review_state);
create index company_founders_founder_id_idx on public.company_founders (founder_id);
create index company_industries_industry_id_idx on public.company_industries (industry_id);
create index social_accounts_entity_idx on public.social_accounts (entity_type, entity_id);
create index social_accounts_platform_handle_idx on public.social_accounts (platform, handle);
create index social_accounts_review_state_idx on public.social_accounts (review_state);
create index social_accounts_evidence_gin_idx on public.social_accounts using gin (evidence_json);
create index posts_social_account_posted_at_idx on public.posts (social_account_id, posted_at desc);
create index posts_platform_posted_at_idx on public.posts (platform, posted_at desc);
create index posts_raw_json_gin_idx on public.posts using gin (raw_json);
create index post_metrics_post_collected_at_idx on public.post_metrics (post_id, collected_at desc);
create index platform_baselines_platform_metric_idx on public.platform_baselines (platform, metric_name, segment);
create index ingestion_runs_batch_status_idx on public.ingestion_runs (batch_id, status, started_at desc);
create index scoring_runs_batch_status_idx on public.scoring_runs (batch_id, status, started_at desc);
create index post_scores_scoring_run_idx on public.post_scores (scoring_run_id);
create index traction_snapshots_batch_collected_at_idx on public.traction_snapshots (batch_id, collected_at desc);
create index traction_snapshots_company_collected_at_idx on public.traction_snapshots (company_id, collected_at desc);
create index founder_traction_snapshots_batch_collected_at_idx on public.founder_traction_snapshots (batch_id, collected_at desc);
create index founder_traction_snapshots_founder_collected_at_idx on public.founder_traction_snapshots (founder_id, collected_at desc);
create index graph_edges_batch_edge_type_idx on public.graph_edges (batch_id, edge_type);
create index graph_edges_source_idx on public.graph_edges (source_node_type, source_node_id);
create index graph_edges_target_idx on public.graph_edges (target_node_type, target_node_id);

create trigger batches_set_updated_at
before update on public.batches
for each row execute function public.set_updated_at();

create trigger companies_set_updated_at
before update on public.companies
for each row execute function public.set_updated_at();

create trigger founders_set_updated_at
before update on public.founders
for each row execute function public.set_updated_at();

create trigger social_accounts_set_updated_at
before update on public.social_accounts
for each row execute function public.set_updated_at();

create trigger posts_set_updated_at
before update on public.posts
for each row execute function public.set_updated_at();

create trigger graph_edges_set_updated_at
before update on public.graph_edges
for each row execute function public.set_updated_at();
