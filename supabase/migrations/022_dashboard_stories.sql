-- Additive storage for the public rolling-24-hour Dashboard. This deliberately
-- does not reuse Company Timeline tables: dashboard stories may be industry
-- wide, may have no Returner attribution, and rank a clustered story rather
-- than a company event or individual post.

create table if not exists public.dashboard_runs (
  id uuid primary key default gen_random_uuid(),
  run_key text not null,
  ingestion_run_id uuid references public.ingestion_runs(id) on delete set null,
  scoring_model_version_id uuid references public.scoring_model_versions(id) on delete restrict,
  window_start timestamptz not null,
  window_end timestamptz not null,
  as_of_at timestamptz not null,
  input_observed_through timestamptz,
  input_fingerprint text,
  source_snapshot_hash text,
  status text not null default 'queued',
  stats_json jsonb not null default '{}'::jsonb,
  error_json jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dashboard_runs_key_not_blank check (length(trim(run_key)) > 0),
  constraint dashboard_runs_key_unique unique (run_key),
  constraint dashboard_runs_status_check check (
    status in ('queued', 'running', 'completed', 'failed', 'canceled')
  ),
  constraint dashboard_runs_window_check check (
    window_end = window_start + interval '24 hours'
    and as_of_at = window_end
    and date_trunc('hour', window_end) = window_end
  ),
  constraint dashboard_runs_observation_cutoff_check check (
    input_observed_through is null or input_observed_through <= as_of_at
  ),
  constraint dashboard_runs_finished_after_started check (
    finished_at is null or finished_at >= started_at
  ),
  constraint dashboard_runs_terminal_finished_check check (
    (status in ('completed', 'failed', 'canceled') and finished_at is not null)
    or (status in ('queued', 'running') and finished_at is null)
  ),
  constraint dashboard_runs_completed_provenance_check check (
    status <> 'completed' or (
      scoring_model_version_id is not null
      and input_observed_through is not null
      and input_fingerprint is not null
      and input_fingerprint ~ '^[a-f0-9]{64}$'
      and source_snapshot_hash is not null
      and source_snapshot_hash ~ '^[a-f0-9]{64}$'
    )
  ),
  constraint dashboard_runs_stats_object check (jsonb_typeof(stats_json) = 'object'),
  constraint dashboard_runs_error_object check (jsonb_typeof(error_json) = 'object')
);

comment on table public.dashboard_runs is
  'Idempotent hourly, rolling-24-hour Dashboard builds. Completed runs retain their exact model and input provenance.';

-- The dashboard has a distinct score contract from the legacy company graph.
-- Register it once so completed runs never have to borrow a misleading graph
-- model version for their provenance.
do $dashboard_model$
declare
  dashboard_model_key constant text := 'technology_dashboard';
  dashboard_model_version constant text := '1.0.0';
  dashboard_model_hash constant text := '00e9e9ceff685a0401db95ea801227606aaa549b306a437371eea99ec46b138a';
  dashboard_model_config constant jsonb := $config$
  {
    "clusteringVersion": "dashboard-cluster-v1",
    "freshnessHalfLifeHours": 9,
    "schemaVersion": "technology-dashboard-v1",
    "weights": {
      "absoluteSignificance": 0.13,
      "crossPlatformConfirmation": 0.13,
      "freshness": 0.19,
      "relativeVirality": 0.22,
      "sourceQuality": 0.08,
      "velocity": 0.25
    }
  }
  $config$::jsonb;
  stored_hash text;
  stored_config jsonb;
begin
  insert into public.scoring_model_versions (model_key, version, config_hash, config_json)
  values (dashboard_model_key, dashboard_model_version, dashboard_model_hash, dashboard_model_config)
  on conflict (model_key, version) do nothing;

  select config_hash, config_json
  into stored_hash, stored_config
  from public.scoring_model_versions
  where model_key = dashboard_model_key and version = dashboard_model_version;

  if stored_hash is distinct from dashboard_model_hash
    or stored_config is distinct from dashboard_model_config then
    raise exception
      'dashboard scoring model %.% exists with config drift; expected hash %',
      dashboard_model_key, dashboard_model_version, dashboard_model_hash
      using errcode = '23514';
  end if;
end
$dashboard_model$;

create table if not exists public.dashboard_stories (
  id uuid primary key default gen_random_uuid(),
  story_key text not null,
  status text not null default 'candidate',
  universe text not null default 'industry',
  merged_into_story_id uuid references public.dashboard_stories(id) on delete restrict,
  title text not null,
  summary text,
  summary_status text not null default 'pending',
  summary_input_hash text,
  summary_model_version text,
  cluster_fingerprint text,
  clustering_version text,
  thumbnail_url text,
  thumbnail_alt text,
  thumbnail_source text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_ranked_at timestamptz,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dashboard_stories_key_normalized check (
    story_key = lower(trim(story_key))
    and story_key ~ '^[a-z0-9][a-z0-9._:-]{0,255}$'
  ),
  constraint dashboard_stories_key_unique unique (story_key),
  constraint dashboard_stories_status_check check (
    status in ('candidate', 'active', 'suppressed', 'merged', 'expired')
  ),
  constraint dashboard_stories_universe_check check (
    universe in ('returner', 'industry', 'both')
  ),
  constraint dashboard_stories_merged_target_check check (
    (status = 'merged' and merged_into_story_id is not null and merged_into_story_id <> id)
    or (status <> 'merged' and merged_into_story_id is null)
  ),
  constraint dashboard_stories_title_check check (length(trim(title)) between 3 and 240),
  constraint dashboard_stories_summary_check check (
    summary is null or length(trim(summary)) between 8 and 1000
  ),
  constraint dashboard_stories_summary_status_check check (
    summary_status in ('pending', 'generated', 'needs_review', 'rejected')
  ),
  constraint dashboard_stories_summary_fields_check check (
    (summary is null and summary_input_hash is null and summary_model_version is null)
    or (summary is not null and summary_input_hash is not null
      and summary_input_hash ~ '^[a-f0-9]{64}$'
      and summary_model_version is not null
      and length(trim(summary_model_version)) > 0)
  ),
  constraint dashboard_stories_cluster_fingerprint_check check (
    cluster_fingerprint is null or cluster_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  constraint dashboard_stories_thumbnail_url_check check (
    thumbnail_url is null or thumbnail_url ~* '^https?://'
  ),
  constraint dashboard_stories_thumbnail_alt_check check (
    thumbnail_alt is null or length(trim(thumbnail_alt)) between 1 and 240
  ),
  constraint dashboard_stories_thumbnail_source_check check (
    thumbnail_source is null or length(trim(thumbnail_source)) > 0
  ),
  constraint dashboard_stories_seen_order check (last_seen_at >= first_seen_at),
  constraint dashboard_stories_metadata_object check (jsonb_typeof(metadata_json) = 'object')
);

comment on table public.dashboard_stories is
  'Stable clustered narratives. Returner is an attribution/filter dimension only; it is never a ranking coefficient.';
comment on column public.dashboard_stories.summary_input_hash is
  'Hash of the verified source set used for the cached summary. A changed source set requires an explicit new summary.';

create table if not exists public.dashboard_external_sources (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null,
  platform text not null,
  source_type text not null,
  canonical_url text not null,
  publisher text,
  author text,
  source_title text,
  published_at timestamptz,
  observed_at timestamptz not null default now(),
  verification_state text not null default 'needs_review',
  source_quality_tier smallint not null default 2,
  independence_key text not null,
  content_fingerprint text,
  thumbnail_url text,
  thumbnail_alt text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dashboard_external_sources_key_not_blank check (length(trim(canonical_key)) > 0),
  constraint dashboard_external_sources_key_unique unique (canonical_key),
  constraint dashboard_external_sources_platform_normalized check (
    platform = lower(trim(platform)) and length(trim(platform)) > 0
  ),
  constraint dashboard_external_sources_type_normalized check (
    source_type ~ '^[a-z][a-z0-9_]*$'
  ),
  constraint dashboard_external_sources_url_check check (canonical_url ~* '^https?://'),
  constraint dashboard_external_sources_title_check check (
    source_title is null or length(trim(source_title)) between 1 and 500
  ),
  constraint dashboard_external_sources_verification_check check (
    verification_state in ('verified', 'needs_review', 'rejected')
  ),
  constraint dashboard_external_sources_quality_check check (source_quality_tier between 1 and 3),
  constraint dashboard_external_sources_independence_key_check check (
    length(trim(independence_key)) > 0
  ),
  constraint dashboard_external_sources_fingerprint_check check (
    content_fingerprint is null or content_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  constraint dashboard_external_sources_thumbnail_url_check check (
    thumbnail_url is null or thumbnail_url ~* '^https?://'
  ),
  constraint dashboard_external_sources_thumbnail_alt_check check (
    thumbnail_alt is null or length(trim(thumbnail_alt)) between 1 and 240
  ),
  constraint dashboard_external_sources_metadata_object check (jsonb_typeof(metadata_json) = 'object')
);

comment on table public.dashboard_external_sources is
  'Canonical source records for broad Industry discovery that is not yet represented by a Returner evidence item or Company Timeline source document.';

create table if not exists public.dashboard_story_sources (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.dashboard_stories(id) on delete cascade,
  evidence_id uuid references public.evidence_items(id) on delete restrict,
  source_document_id uuid references public.source_documents(id) on delete restrict,
  external_source_id uuid references public.dashboard_external_sources(id) on delete restrict,
  source_key text not null,
  source_role text not null default 'supporting',
  verification_state text not null default 'needs_review',
  source_quality_tier smallint not null default 2,
  platform text not null,
  canonical_url text not null,
  publisher text,
  author text,
  source_title text,
  published_at timestamptz,
  observed_at timestamptz not null default now(),
  independence_key text not null,
  thumbnail_url text,
  thumbnail_alt text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dashboard_story_sources_exactly_one_canonical_target check (
    (case when evidence_id is null then 0 else 1 end)
    + (case when source_document_id is null then 0 else 1 end)
    + (case when external_source_id is null then 0 else 1 end) = 1
  ),
  constraint dashboard_story_sources_key_not_blank check (length(trim(source_key)) > 0),
  constraint dashboard_story_sources_role_check check (
    source_role in ('primary', 'supporting', 'corroborating', 'context', 'conflicting')
  ),
  constraint dashboard_story_sources_verification_check check (
    verification_state in ('verified', 'needs_review', 'rejected')
  ),
  constraint dashboard_story_sources_quality_check check (source_quality_tier between 1 and 3),
  constraint dashboard_story_sources_platform_normalized check (
    platform = lower(trim(platform)) and length(trim(platform)) > 0
  ),
  constraint dashboard_story_sources_canonical_url_check check (canonical_url ~* '^https?://'),
  constraint dashboard_story_sources_title_check check (
    source_title is null or length(trim(source_title)) between 1 and 500
  ),
  constraint dashboard_story_sources_independence_key_check check (
    length(trim(independence_key)) > 0
  ),
  constraint dashboard_story_sources_thumbnail_url_check check (
    thumbnail_url is null or thumbnail_url ~* '^https?://'
  ),
  constraint dashboard_story_sources_thumbnail_alt_check check (
    thumbnail_alt is null or length(trim(thumbnail_alt)) between 1 and 240
  ),
  constraint dashboard_story_sources_metadata_object check (jsonb_typeof(metadata_json) = 'object')
);

comment on table public.dashboard_story_sources is
  'Canonical physical evidence, source-document, or external-source links used to ground a story. Global source identity uniqueness prevents duplicate stories from counting the same source.';

create table if not exists public.dashboard_story_topics (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.dashboard_stories(id) on delete cascade,
  topic_key text not null,
  display_name text not null,
  confidence numeric(5,4) not null default 1,
  classifier_version text,
  is_primary boolean not null default false,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dashboard_story_topics_key_normalized check (
    topic_key = lower(trim(topic_key))
    and topic_key ~ '^[a-z0-9][a-z0-9_-]{0,127}$'
  ),
  constraint dashboard_story_topics_display_name_check check (
    length(trim(display_name)) between 1 and 120
  ),
  constraint dashboard_story_topics_confidence_check check (confidence between 0 and 1),
  constraint dashboard_story_topics_classifier_version_check check (
    classifier_version is null or length(trim(classifier_version)) > 0
  ),
  constraint dashboard_story_topics_metadata_object check (jsonb_typeof(metadata_json) = 'object'),
  constraint dashboard_story_topics_story_topic_unique unique (story_id, topic_key)
);

create table if not exists public.dashboard_story_entities (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.dashboard_stories(id) on delete cascade,
  entity_type text not null,
  company_id uuid references public.companies(id) on delete restrict,
  founder_id uuid references public.founders(id) on delete restrict,
  external_entity_name text,
  relationship_type text not null default 'subject',
  attribution_state text not null default 'needs_review',
  is_primary boolean not null default false,
  is_returner boolean not null default false,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dashboard_story_entities_target_check check (
    (entity_type = 'company' and company_id is not null and founder_id is null and external_entity_name is null)
    or (entity_type = 'founder' and founder_id is not null and company_id is null and external_entity_name is null)
    or (entity_type in ('organization', 'product', 'person', 'other')
      and company_id is null and founder_id is null
      and external_entity_name is not null and length(trim(external_entity_name)) > 0)
  ),
  constraint dashboard_story_entities_relationship_check check (
    relationship_type ~ '^[a-z][a-z0-9_]*$'
  ),
  constraint dashboard_story_entities_attribution_check check (
    attribution_state in ('verified', 'needs_review', 'rejected')
  ),
  constraint dashboard_story_entities_returner_check check (
    not is_returner or (
      entity_type in ('company', 'founder') and attribution_state = 'verified'
    )
  ),
  constraint dashboard_story_entities_metadata_object check (jsonb_typeof(metadata_json) = 'object')
);

comment on table public.dashboard_story_entities is
  'Story/entity attribution. A Returner label requires a verified local company or founder attribution and does not affect the trend score.';

create table if not exists public.dashboard_story_scores (
  id uuid primary key default gen_random_uuid(),
  dashboard_run_id uuid not null references public.dashboard_runs(id) on delete restrict,
  story_id uuid not null references public.dashboard_stories(id) on delete restrict,
  rank smallint not null,
  trend_score numeric(14,6) not null,
  relative_engagement_score numeric(14,6) not null default 0,
  velocity_score numeric(14,6) not null default 0,
  freshness_score numeric(14,6) not null default 0,
  confirmation_score numeric(14,6) not null default 0,
  source_quality_score numeric(14,6) not null default 0,
  breaking_score numeric(14,6) not null default 0,
  emerging_score numeric(14,6) not null default 0,
  rank_delta integer,
  score_delta numeric(14,6),
  trend_state text not null,
  source_count integer not null,
  platform_count smallint not null,
  independent_source_count smallint not null,
  component_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- This is the canonical Hottest position, not a public view membership.
  -- A story can rank #127 overall while still being Top 100 in Breaking.
  constraint dashboard_story_scores_rank_check check (rank >= 1),
  constraint dashboard_story_scores_trend_score_check check (trend_score >= 0),
  constraint dashboard_story_scores_component_scores_check check (
    relative_engagement_score >= 0 and velocity_score >= 0 and freshness_score >= 0
    and confirmation_score >= 0 and source_quality_score >= 0
    and breaking_score >= 0 and emerging_score >= 0
  ),
  constraint dashboard_story_scores_state_check check (
    trend_state in ('new', 'rising_fast', 'rising', 'stable', 'cooling')
  ),
  constraint dashboard_story_scores_counts_check check (
    source_count > 0
    and platform_count between 1 and source_count
    and independent_source_count between 0 and source_count
  ),
  constraint dashboard_story_scores_component_object check (jsonb_typeof(component_json) = 'object'),
  constraint dashboard_story_scores_run_story_unique unique (dashboard_run_id, story_id),
  constraint dashboard_story_scores_run_rank_unique unique (dashboard_run_id, rank)
);

comment on table public.dashboard_story_scores is
  'Private, explainable per-run scoring components. The public projection exposes rank/movement, never these raw model values.';

create table if not exists public.dashboard_rank_snapshots (
  id uuid primary key default gen_random_uuid(),
  dashboard_run_id uuid not null references public.dashboard_runs(id) on delete restrict,
  story_id uuid not null references public.dashboard_stories(id) on delete restrict,
  dashboard_story_score_id uuid not null references public.dashboard_story_scores(id) on delete restrict,
  ranking_view text not null default 'hottest',
  captured_at timestamptz not null default now(),
  rank smallint not null,
  view_score numeric(14,6) not null,
  rank_delta integer,
  trend_state text not null,
  created_at timestamptz not null default now(),
  constraint dashboard_rank_snapshots_rank_check check (rank between 1 and 100),
  constraint dashboard_rank_snapshots_view_check check (
    ranking_view in ('hottest', 'breaking', 'emerging')
  ),
  constraint dashboard_rank_snapshots_score_check check (view_score >= 0),
  constraint dashboard_rank_snapshots_state_check check (
    trend_state in ('new', 'rising_fast', 'rising', 'stable', 'cooling')
  ),
  constraint dashboard_rank_snapshots_score_view_unique unique (dashboard_story_score_id, ranking_view),
  constraint dashboard_rank_snapshots_run_story_view_unique unique (
    dashboard_run_id, story_id, ranking_view
  ),
  constraint dashboard_rank_snapshots_run_view_rank_unique unique (
    dashboard_run_id, ranking_view, rank
  )
);

comment on table public.dashboard_rank_snapshots is
  'Immutable Top 100 rank history for Hottest, Breaking, and Emerging views across hourly refreshes.';

create table if not exists public.dashboard_publications (
  id uuid primary key default gen_random_uuid(),
  dashboard_run_id uuid not null references public.dashboard_runs(id) on delete restrict,
  publication_key text not null,
  status text not null default 'draft',
  is_current boolean not null default false,
  generated_at timestamptz not null default now(),
  freshness_checked_at timestamptz not null default now(),
  data_fresh_through timestamptz,
  freshness_status text not null default 'fresh',
  schema_version text not null,
  payload_json jsonb not null default '{}'::jsonb,
  payload_sha256 text not null,
  artifact_path text not null,
  artifact_sha256 text not null,
  published_at timestamptz,
  superseded_at timestamptz,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dashboard_publications_run_unique unique (dashboard_run_id),
  constraint dashboard_publications_key_not_blank check (length(trim(publication_key)) > 0),
  constraint dashboard_publications_key_unique unique (publication_key),
  constraint dashboard_publications_status_check check (
    status in ('draft', 'published', 'superseded', 'retracted')
  ),
  constraint dashboard_publications_current_check check (not is_current or status = 'published'),
  constraint dashboard_publications_freshness_status_check check (
    freshness_status in ('fresh', 'partial', 'stale', 'degraded')
  ),
  constraint dashboard_publications_freshness_order_check check (
    data_fresh_through is null or data_fresh_through <= generated_at
  ),
  constraint dashboard_publications_schema_version_check check (
    length(trim(schema_version)) between 1 and 128
  ),
  constraint dashboard_publications_payload_object check (jsonb_typeof(payload_json) = 'object'),
  constraint dashboard_publications_payload_hash_check check (
    payload_sha256 ~ '^[a-f0-9]{64}$'
  ),
  constraint dashboard_publications_artifact_path_check check (
    artifact_path ~ '^public/dashboard/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}[.]json$'
    and artifact_path !~ '(^|/)[.][.]?(/|$)'
  ),
  constraint dashboard_publications_artifact_hash_check check (
    artifact_sha256 ~ '^[a-f0-9]{64}$'
  ),
  constraint dashboard_publications_published_check check (
    (status = 'published' and published_at is not null
      and coalesce(jsonb_typeof(payload_json -> 'stories') = 'array', false))
    or status <> 'published'
  ),
  constraint dashboard_publications_superseded_check check (
    (status = 'superseded' and superseded_at is not null)
    or status <> 'superseded'
  ),
  constraint dashboard_publications_metadata_object check (jsonb_typeof(metadata_json) = 'object')
);

comment on table public.dashboard_publications is
  'Compact, service-only public Dashboard snapshot plus its static-artifact receipt. Server routes read one precomputed payload row; the generated JSON artifact remains the no-database fallback.';

create unique index if not exists dashboard_publications_one_current_idx
  on public.dashboard_publications (is_current)
  where is_current;
create index if not exists dashboard_runs_status_window_idx
  on public.dashboard_runs (status, window_end desc);
create index if not exists dashboard_runs_ingestion_idx
  on public.dashboard_runs (ingestion_run_id, started_at desc)
  where ingestion_run_id is not null;
create index if not exists dashboard_stories_active_seen_idx
  on public.dashboard_stories (last_seen_at desc, id)
  where status = 'active';
create index if not exists dashboard_stories_universe_seen_idx
  on public.dashboard_stories (universe, last_seen_at desc)
  where status = 'active';
create index if not exists dashboard_external_sources_platform_published_idx
  on public.dashboard_external_sources (platform, published_at desc);
create index if not exists dashboard_external_sources_verified_seen_idx
  on public.dashboard_external_sources (observed_at desc)
  where verification_state = 'verified';
create unique index if not exists dashboard_story_sources_source_key_unique
  on public.dashboard_story_sources (source_key);
create unique index if not exists dashboard_story_sources_evidence_unique
  on public.dashboard_story_sources (evidence_id)
  where evidence_id is not null;
create unique index if not exists dashboard_story_sources_document_unique
  on public.dashboard_story_sources (source_document_id)
  where source_document_id is not null;
create unique index if not exists dashboard_story_sources_external_unique
  on public.dashboard_story_sources (external_source_id)
  where external_source_id is not null;
create unique index if not exists dashboard_story_sources_primary_unique
  on public.dashboard_story_sources (story_id)
  where source_role = 'primary';
create index if not exists dashboard_story_sources_story_idx
  on public.dashboard_story_sources (story_id, source_role, published_at desc);
create index if not exists dashboard_story_sources_window_idx
  on public.dashboard_story_sources (published_at desc, platform)
  where verification_state = 'verified';
create index if not exists dashboard_story_topics_topic_idx
  on public.dashboard_story_topics (topic_key, story_id);
create unique index if not exists dashboard_story_topics_primary_unique
  on public.dashboard_story_topics (story_id)
  where is_primary;
create unique index if not exists dashboard_story_entities_company_unique
  on public.dashboard_story_entities (story_id, company_id, relationship_type)
  where company_id is not null;
create unique index if not exists dashboard_story_entities_founder_unique
  on public.dashboard_story_entities (story_id, founder_id, relationship_type)
  where founder_id is not null;
create unique index if not exists dashboard_story_entities_external_unique
  on public.dashboard_story_entities (story_id, lower(external_entity_name), relationship_type)
  where external_entity_name is not null;
create unique index if not exists dashboard_story_entities_primary_unique
  on public.dashboard_story_entities (story_id)
  where is_primary;
create index if not exists dashboard_story_entities_returner_idx
  on public.dashboard_story_entities (company_id, story_id)
  where is_returner and company_id is not null;
create index if not exists dashboard_story_scores_story_history_idx
  on public.dashboard_story_scores (story_id, dashboard_run_id desc);
create index if not exists dashboard_rank_snapshots_story_history_idx
  on public.dashboard_rank_snapshots (story_id, ranking_view, captured_at desc);
create index if not exists dashboard_rank_snapshots_run_view_rank_idx
  on public.dashboard_rank_snapshots (dashboard_run_id, ranking_view, rank);
create index if not exists dashboard_publications_published_idx
  on public.dashboard_publications (published_at desc)
  where status = 'published';

create or replace function public.assert_dashboard_run_writable(target_dashboard_run_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_status text;
begin
  select status
  into target_status
  from public.dashboard_runs
  where id = target_dashboard_run_id
  for update;

  if not found then
    raise exception 'dashboard run % was not found', target_dashboard_run_id;
  end if;
  if target_status not in ('queued', 'running') then
    raise exception 'dashboard run % is % and cannot accept result mutations',
      target_dashboard_run_id, target_status;
  end if;
end;
$$;

create or replace function public.guard_dashboard_story_score_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform public.assert_dashboard_run_writable(
    case when tg_op = 'DELETE' then old.dashboard_run_id else new.dashboard_run_id end
  );
  if tg_op = 'UPDATE' and old.dashboard_run_id is distinct from new.dashboard_run_id then
    perform public.assert_dashboard_run_writable(old.dashboard_run_id);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.assert_dashboard_rank_snapshot_matches_score()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  score_row public.dashboard_story_scores%rowtype;
  expected_view_score numeric;
begin
  if tg_op = 'DELETE' then
    perform public.assert_dashboard_run_writable(old.dashboard_run_id);
    return old;
  end if;

  select *
  into score_row
  from public.dashboard_story_scores
  where id = new.dashboard_story_score_id;

  expected_view_score := case new.ranking_view
    when 'hottest' then score_row.trend_score
    when 'breaking' then score_row.breaking_score
    when 'emerging' then score_row.emerging_score
    else null
  end;

  if not found
    or score_row.dashboard_run_id <> new.dashboard_run_id
    or score_row.story_id <> new.story_id
    or expected_view_score is distinct from new.view_score
    or (
      new.ranking_view = 'hottest' and (
        score_row.rank <> new.rank
        or score_row.rank_delta is distinct from new.rank_delta
        or score_row.trend_state <> new.trend_state
      )
    ) then
    raise exception 'dashboard rank snapshot must match its score row for the selected ranking view';
  end if;

  perform public.assert_dashboard_run_writable(new.dashboard_run_id);
  return new;
end;
$$;

create or replace function public.guard_dashboard_publication()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_run_status text;
begin
  if new.status = 'published' then
    select status into target_run_status
    from public.dashboard_runs
    where id = new.dashboard_run_id;
    if target_run_status is distinct from 'completed' then
      raise exception 'dashboard publication requires a completed run';
    end if;
    if not exists (
      select 1
      from public.dashboard_rank_snapshots snapshot
      where snapshot.dashboard_run_id = new.dashboard_run_id
        and snapshot.ranking_view = 'hottest'
    ) then
      raise exception 'dashboard publication requires at least one rank snapshot';
    end if;
    if exists (
      select 1
      from public.dashboard_story_scores score
      join public.dashboard_stories story on story.id = score.story_id
      where score.dashboard_run_id = new.dashboard_run_id
        and (
          story.status <> 'active'
          or story.summary is null
          or story.summary_status <> 'generated'
          or not exists (
            select 1
            from public.dashboard_story_sources source
            where source.story_id = story.id
              and source.source_role = 'primary'
              and source.verification_state = 'verified'
          )
        )
    ) then
      raise exception 'dashboard publication contains a story without an active, grounded generated summary';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.prevent_completed_dashboard_run_rewrite()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.status = 'completed' and row(
    new.run_key,
    new.ingestion_run_id,
    new.scoring_model_version_id,
    new.window_start,
    new.window_end,
    new.as_of_at,
    new.input_observed_through,
    new.input_fingerprint,
    new.source_snapshot_hash,
    new.status,
    new.stats_json,
    new.error_json,
    new.started_at,
    new.finished_at,
    new.created_at
  ) is distinct from row(
    old.run_key,
    old.ingestion_run_id,
    old.scoring_model_version_id,
    old.window_start,
    old.window_end,
    old.as_of_at,
    old.input_observed_through,
    old.input_fingerprint,
    old.source_snapshot_hash,
    old.status,
    old.stats_json,
    old.error_json,
    old.started_at,
    old.finished_at,
    old.created_at
  ) then
    raise exception 'completed dashboard run provenance is immutable';
  end if;
  return new;
end;
$$;

create or replace function public.prevent_published_dashboard_publication_rewrite()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.status = 'published' and row(
    new.dashboard_run_id,
    new.publication_key,
    new.generated_at,
    new.freshness_checked_at,
    new.data_fresh_through,
    new.freshness_status,
    new.schema_version,
    new.payload_json,
    new.payload_sha256,
    new.artifact_path,
    new.artifact_sha256,
    new.published_at,
    new.metadata_json,
    new.created_at
  ) is distinct from row(
    old.dashboard_run_id,
    old.publication_key,
    old.generated_at,
    old.freshness_checked_at,
    old.data_fresh_through,
    old.freshness_status,
    old.schema_version,
    old.payload_json,
    old.payload_sha256,
    old.artifact_path,
    old.artifact_sha256,
    old.published_at,
    old.metadata_json,
    old.created_at
  ) then
    raise exception 'published dashboard artifact provenance is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists dashboard_runs_completed_immutable on public.dashboard_runs;
create trigger dashboard_runs_completed_immutable
before update on public.dashboard_runs
for each row execute function public.prevent_completed_dashboard_run_rewrite();
drop trigger if exists dashboard_story_scores_writable_guard on public.dashboard_story_scores;
create trigger dashboard_story_scores_writable_guard
before insert or update or delete on public.dashboard_story_scores
for each row execute function public.guard_dashboard_story_score_mutation();
drop trigger if exists dashboard_rank_snapshots_writable_guard on public.dashboard_rank_snapshots;
create trigger dashboard_rank_snapshots_writable_guard
before insert or update or delete on public.dashboard_rank_snapshots
for each row execute function public.assert_dashboard_rank_snapshot_matches_score();
drop trigger if exists dashboard_publications_guard on public.dashboard_publications;
create trigger dashboard_publications_guard
before insert or update of dashboard_run_id, status, is_current, generated_at, freshness_checked_at,
  data_fresh_through, freshness_status, schema_version, payload_json, payload_sha256, artifact_path,
  artifact_sha256, published_at, superseded_at, metadata_json
on public.dashboard_publications
for each row execute function public.guard_dashboard_publication();
drop trigger if exists dashboard_publications_published_immutable on public.dashboard_publications;
create trigger dashboard_publications_published_immutable
before update on public.dashboard_publications
for each row execute function public.prevent_published_dashboard_publication_rewrite();

drop trigger if exists dashboard_runs_set_updated_at on public.dashboard_runs;
create trigger dashboard_runs_set_updated_at before update on public.dashboard_runs
for each row execute function public.set_updated_at();
drop trigger if exists dashboard_stories_set_updated_at on public.dashboard_stories;
create trigger dashboard_stories_set_updated_at before update on public.dashboard_stories
for each row execute function public.set_updated_at();
drop trigger if exists dashboard_external_sources_set_updated_at on public.dashboard_external_sources;
create trigger dashboard_external_sources_set_updated_at before update on public.dashboard_external_sources
for each row execute function public.set_updated_at();
drop trigger if exists dashboard_story_sources_set_updated_at on public.dashboard_story_sources;
create trigger dashboard_story_sources_set_updated_at before update on public.dashboard_story_sources
for each row execute function public.set_updated_at();
drop trigger if exists dashboard_story_topics_set_updated_at on public.dashboard_story_topics;
create trigger dashboard_story_topics_set_updated_at before update on public.dashboard_story_topics
for each row execute function public.set_updated_at();
drop trigger if exists dashboard_story_entities_set_updated_at on public.dashboard_story_entities;
create trigger dashboard_story_entities_set_updated_at before update on public.dashboard_story_entities
for each row execute function public.set_updated_at();
drop trigger if exists dashboard_publications_set_updated_at on public.dashboard_publications;
create trigger dashboard_publications_set_updated_at before update on public.dashboard_publications
for each row execute function public.set_updated_at();

-- Raw sources, score components, payload metadata, and run errors remain
-- service-only. The public site reaches its server route or generated JSON,
-- never a direct database relation.
alter table public.dashboard_runs enable row level security;
alter table public.dashboard_stories enable row level security;
alter table public.dashboard_external_sources enable row level security;
alter table public.dashboard_story_sources enable row level security;
alter table public.dashboard_story_topics enable row level security;
alter table public.dashboard_story_entities enable row level security;
alter table public.dashboard_story_scores enable row level security;
alter table public.dashboard_rank_snapshots enable row level security;
alter table public.dashboard_publications enable row level security;

revoke all privileges on table public.dashboard_runs from public, anon, authenticated;
revoke all privileges on table public.dashboard_stories from public, anon, authenticated;
revoke all privileges on table public.dashboard_external_sources from public, anon, authenticated;
revoke all privileges on table public.dashboard_story_sources from public, anon, authenticated;
revoke all privileges on table public.dashboard_story_topics from public, anon, authenticated;
revoke all privileges on table public.dashboard_story_entities from public, anon, authenticated;
revoke all privileges on table public.dashboard_story_scores from public, anon, authenticated;
revoke all privileges on table public.dashboard_rank_snapshots from public, anon, authenticated;
revoke all privileges on table public.dashboard_publications from public, anon, authenticated;

grant all privileges on table public.dashboard_runs to service_role;
grant all privileges on table public.dashboard_stories to service_role;
grant all privileges on table public.dashboard_external_sources to service_role;
grant all privileges on table public.dashboard_story_sources to service_role;
grant all privileges on table public.dashboard_story_topics to service_role;
grant all privileges on table public.dashboard_story_entities to service_role;
grant all privileges on table public.dashboard_story_scores to service_role;
grant all privileges on table public.dashboard_rank_snapshots to service_role;
grant all privileges on table public.dashboard_publications to service_role;

revoke all privileges on function public.assert_dashboard_run_writable(uuid) from public, anon, authenticated;
revoke all privileges on function public.guard_dashboard_story_score_mutation() from public, anon, authenticated;
revoke all privileges on function public.assert_dashboard_rank_snapshot_matches_score() from public, anon, authenticated;
revoke all privileges on function public.guard_dashboard_publication() from public, anon, authenticated;
revoke all privileges on function public.prevent_completed_dashboard_run_rewrite() from public, anon, authenticated;
revoke all privileges on function public.prevent_published_dashboard_publication_rewrite() from public, anon, authenticated;
grant execute on function public.assert_dashboard_run_writable(uuid) to service_role;
grant execute on function public.guard_dashboard_story_score_mutation() to service_role;
grant execute on function public.assert_dashboard_rank_snapshot_matches_score() to service_role;
grant execute on function public.guard_dashboard_publication() to service_role;
grant execute on function public.prevent_completed_dashboard_run_rewrite() to service_role;
grant execute on function public.prevent_published_dashboard_publication_rewrite() to service_role;
