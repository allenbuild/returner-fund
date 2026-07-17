create table if not exists public.evidence_items (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  evidence_kind text not null,
  canonical_key text not null,
  platform_object_id text,
  canonical_url text,
  social_account_id uuid references public.social_accounts(id) on delete set null,
  legacy_post_id uuid references public.posts(id) on delete set null,
  published_at timestamptz,
  content_fingerprint text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint evidence_items_platform_normalized check (
    length(trim(platform)) > 0 and platform = lower(trim(platform))
  ),
  constraint evidence_items_kind_check check (
    evidence_kind in (
      'post',
      'comment',
      'thread',
      'video',
      'repository',
      'release',
      'launch',
      'article',
      'profile',
      'account',
      'feed_item',
      'other'
    )
  ),
  constraint evidence_items_canonical_key_not_blank check (length(trim(canonical_key)) > 0),
  constraint evidence_items_platform_object_id_not_blank check (
    platform_object_id is null or length(trim(platform_object_id)) > 0
  ),
  constraint evidence_items_canonical_url_http check (
    canonical_url is null or canonical_url ~* '^https?://'
  ),
  constraint evidence_items_content_fingerprint_not_blank check (
    content_fingerprint is null or length(trim(content_fingerprint)) > 0
  ),
  constraint evidence_items_seen_at_order check (last_seen_at >= first_seen_at),
  constraint evidence_items_metadata_json_object check (jsonb_typeof(metadata_json) = 'object')
);

comment on table public.evidence_items is
  'Canonical identity for scoreable and context-only evidence across ingestion sources.';
comment on column public.evidence_items.canonical_key is
  'Stable, platform-scoped identity key derived from a native object id, canonical URL, or deterministic fallback.';

create table if not exists public.evidence_attributions (
  id uuid primary key default gen_random_uuid(),
  evidence_id uuid not null references public.evidence_items(id) on delete cascade,
  entity_type text not null,
  company_id uuid references public.companies(id) on delete cascade,
  founder_id uuid references public.founders(id) on delete cascade,
  attribution_type text not null default 'subject',
  is_primary boolean not null default false,
  score_eligible boolean not null default false,
  review_state text not null default 'needs_review',
  risk_level text not null default 'medium',
  match_reason text not null,
  source_url text,
  reviewed_at timestamptz,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint evidence_attributions_target_check check (
    (entity_type = 'company' and company_id is not null and founder_id is null)
    or (entity_type = 'founder' and founder_id is not null and company_id is null)
  ),
  constraint evidence_attributions_type_check check (
    attribution_type in ('subject', 'author', 'mention', 'account_owner', 'founder_rollup', 'other')
  ),
  constraint evidence_attributions_review_state_check check (
    review_state in ('verified', 'needs_review', 'rejected')
  ),
  constraint evidence_attributions_risk_level_check check (risk_level in ('low', 'medium', 'high')),
  constraint evidence_attributions_match_reason_not_blank check (length(trim(match_reason)) > 0),
  constraint evidence_attributions_source_url_http check (source_url is null or source_url ~* '^https?://'),
  constraint evidence_attributions_score_eligible_check check (
    not score_eligible or (review_state = 'verified' and risk_level = 'low')
  ),
  constraint evidence_attributions_primary_not_rejected check (
    not is_primary or review_state <> 'rejected'
  ),
  constraint evidence_attributions_metadata_json_object check (jsonb_typeof(metadata_json) = 'object')
);

comment on table public.evidence_attributions is
  'Auditable company/founder attribution decisions for canonical evidence. Numeric identity confidence is intentionally omitted.';

create table if not exists public.metric_observations (
  id uuid primary key default gen_random_uuid(),
  evidence_id uuid not null references public.evidence_items(id) on delete cascade,
  ingestion_run_id uuid references public.ingestion_runs(id) on delete set null,
  metric_name text not null,
  metric_value numeric not null,
  metric_unit text not null default 'count',
  observed_at timestamptz not null,
  source_name text not null,
  source_url text,
  is_estimated boolean not null default false,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint metric_observations_metric_name_check check (metric_name ~ '^[a-z][a-z0-9_]*$'),
  constraint metric_observations_value_nonnegative check (
    metric_value >= 0 and metric_value <> 'NaN'::numeric
  ),
  constraint metric_observations_unit_check check (
    metric_unit in ('count', 'ratio', 'percentage', 'seconds', 'bytes', 'currency', 'other')
  ),
  constraint metric_observations_source_name_not_blank check (length(trim(source_name)) > 0),
  constraint metric_observations_source_url_http check (source_url is null or source_url ~* '^https?://'),
  constraint metric_observations_metadata_json_object check (jsonb_typeof(metadata_json) = 'object')
);

comment on table public.metric_observations is
  'Append-only metric readings. Mutable metric values must be recorded as later observations, not overwritten.';

create table if not exists public.scoring_model_versions (
  id uuid primary key default gen_random_uuid(),
  model_key text not null,
  version text not null,
  config_hash text not null,
  config_json jsonb not null,
  code_revision text,
  supersedes_id uuid references public.scoring_model_versions(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint scoring_model_versions_model_key_check check (model_key ~ '^[a-z][a-z0-9_-]*$'),
  constraint scoring_model_versions_version_not_blank check (length(trim(version)) > 0),
  constraint scoring_model_versions_config_hash_not_blank check (length(trim(config_hash)) > 0),
  constraint scoring_model_versions_code_revision_not_blank check (
    code_revision is null or length(trim(code_revision)) > 0
  ),
  constraint scoring_model_versions_config_json_object check (jsonb_typeof(config_json) = 'object'),
  constraint scoring_model_versions_not_self_superseding check (supersedes_id is null or supersedes_id <> id),
  constraint scoring_model_versions_model_version_key unique (model_key, version)
);

comment on table public.scoring_model_versions is
  'Immutable scoring definitions. Publish a new row rather than editing a version used by a completed run.';

alter table public.scoring_runs
  add column if not exists scoring_model_version_id uuid
    references public.scoring_model_versions(id) on delete restrict,
  add column if not exists as_of_at timestamptz,
  add column if not exists input_observed_through timestamptz,
  add column if not exists input_fingerprint text,
  add column if not exists run_key text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'scoring_runs_versioned_fields_together_check'
      and conrelid = 'public.scoring_runs'::regclass
  ) then
    alter table public.scoring_runs
      add constraint scoring_runs_versioned_fields_together_check check (
        (
          scoring_model_version_id is null
          and as_of_at is null
          and input_observed_through is null
        )
        or (
          scoring_model_version_id is not null
          and as_of_at is not null
          and input_observed_through is not null
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'scoring_runs_observation_cutoff_check'
      and conrelid = 'public.scoring_runs'::regclass
  ) then
    alter table public.scoring_runs
      add constraint scoring_runs_observation_cutoff_check check (
        input_observed_through is null or input_observed_through <= as_of_at
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'scoring_runs_input_fingerprint_not_blank'
      and conrelid = 'public.scoring_runs'::regclass
  ) then
    alter table public.scoring_runs
      add constraint scoring_runs_input_fingerprint_not_blank check (
        input_fingerprint is null or length(trim(input_fingerprint)) > 0
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'scoring_runs_run_key_not_blank'
      and conrelid = 'public.scoring_runs'::regclass
  ) then
    alter table public.scoring_runs
      add constraint scoring_runs_run_key_not_blank check (
        run_key is null or length(trim(run_key)) > 0
      );
  end if;
end
$$;

comment on column public.scoring_runs.config_json is
  'Effective run configuration or overrides; the immutable base configuration lives on scoring_model_versions.';
comment on column public.scoring_runs.input_observed_through is
  'Inclusive metric-observation cutoff used to make a scoring run reproducible.';

-- Legacy completed rows remain readable and may retain notes. New completions
-- must include the fields needed to identify and replay their exact inputs.
create or replace function public.enforce_completed_scoring_run_provenance()
returns trigger
language plpgsql
as $$
declare
  is_new_completion boolean := false;
begin
  if tg_op = 'UPDATE' then
    if old.status = 'completed'
      and row(
        new.status,
        new.batch_id,
        new.started_at,
        new.finished_at,
        new.config_json,
        new.scoring_model_version_id,
        new.as_of_at,
        new.input_observed_through,
        new.input_fingerprint,
        new.run_key
      ) is distinct from row(
        old.status,
        old.batch_id,
        old.started_at,
        old.finished_at,
        old.config_json,
        old.scoring_model_version_id,
        old.as_of_at,
        old.input_observed_through,
        old.input_fingerprint,
        old.run_key
      ) then
      raise exception 'completed scoring run provenance is immutable'
        using errcode = '23514';
    end if;

    is_new_completion := old.status <> 'completed' and new.status = 'completed';
  else
    is_new_completion := new.status = 'completed';
  end if;

  if is_new_completion and (
    new.scoring_model_version_id is null
    or new.as_of_at is null
    or new.input_observed_through is null
    or new.input_fingerprint is null
    or new.run_key is null
  ) then
    raise exception
      'completed scoring runs require model, as-of, input cutoff, input fingerprint, and run key'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- A completed run is only reproducible while its referenced model definition
-- remains unchanged. Model rows can still be corrected before their first
-- completed use.
create or replace function public.prevent_completed_scoring_model_version_rewrite()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from public.scoring_runs
    where scoring_model_version_id = old.id
      and status = 'completed'
  ) and row(
    new.model_key,
    new.version,
    new.config_hash,
    new.config_json,
    new.code_revision,
    new.supersedes_id,
    new.created_at
  ) is distinct from row(
    old.model_key,
    old.version,
    old.config_hash,
    old.config_json,
    old.code_revision,
    old.supersedes_id,
    old.created_at
  ) then
    raise exception 'scoring model version used by a completed run is immutable'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

alter table public.traction_snapshots
  add column if not exists scoring_run_id uuid references public.scoring_runs(id) on delete cascade,
  add column if not exists rank integer,
  add column if not exists evidence_count integer;

alter table public.founder_traction_snapshots
  add column if not exists scoring_run_id uuid references public.scoring_runs(id) on delete cascade,
  add column if not exists rank integer,
  add column if not exists evidence_count integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'traction_snapshots_rank_positive'
      and conrelid = 'public.traction_snapshots'::regclass
  ) then
    alter table public.traction_snapshots
      add constraint traction_snapshots_rank_positive check (rank is null or rank > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'traction_snapshots_evidence_count_nonnegative'
      and conrelid = 'public.traction_snapshots'::regclass
  ) then
    alter table public.traction_snapshots
      add constraint traction_snapshots_evidence_count_nonnegative check (
        evidence_count is null or evidence_count >= 0
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'founder_traction_snapshots_rank_positive'
      and conrelid = 'public.founder_traction_snapshots'::regclass
  ) then
    alter table public.founder_traction_snapshots
      add constraint founder_traction_snapshots_rank_positive check (rank is null or rank > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'founder_traction_snapshots_evidence_count_nonnegative'
      and conrelid = 'public.founder_traction_snapshots'::regclass
  ) then
    alter table public.founder_traction_snapshots
      add constraint founder_traction_snapshots_evidence_count_nonnegative check (
        evidence_count is null or evidence_count >= 0
      );
  end if;
end
$$;

create unique index if not exists evidence_items_platform_canonical_key
  on public.evidence_items (platform, canonical_key);
create unique index if not exists evidence_items_platform_object_key
  on public.evidence_items (platform, evidence_kind, platform_object_id)
  where platform_object_id is not null;
create unique index if not exists evidence_items_platform_url_key
  on public.evidence_items (platform, canonical_url)
  where canonical_url is not null;
create unique index if not exists evidence_items_legacy_post_key
  on public.evidence_items (legacy_post_id)
  where legacy_post_id is not null;
create index if not exists evidence_items_social_account_published_idx
  on public.evidence_items (social_account_id, published_at desc)
  where social_account_id is not null;
create index if not exists evidence_items_platform_published_idx
  on public.evidence_items (platform, published_at desc);
create index if not exists evidence_items_last_seen_idx
  on public.evidence_items (last_seen_at desc);

create unique index if not exists evidence_attributions_company_type_key
  on public.evidence_attributions (evidence_id, company_id, attribution_type)
  where company_id is not null;
create unique index if not exists evidence_attributions_founder_type_key
  on public.evidence_attributions (evidence_id, founder_id, attribution_type)
  where founder_id is not null;
create unique index if not exists evidence_attributions_primary_entity_type_key
  on public.evidence_attributions (evidence_id, entity_type)
  where is_primary;
create index if not exists evidence_attributions_company_review_idx
  on public.evidence_attributions (company_id, review_state)
  where company_id is not null;
create index if not exists evidence_attributions_founder_review_idx
  on public.evidence_attributions (founder_id, review_state)
  where founder_id is not null;
create index if not exists evidence_attributions_score_eligible_idx
  on public.evidence_attributions (evidence_id)
  where score_eligible;

create unique index if not exists metric_observations_identity_key
  on public.metric_observations (evidence_id, metric_name, source_name, observed_at);
create index if not exists metric_observations_evidence_metric_observed_idx
  on public.metric_observations (evidence_id, metric_name, observed_at desc);
create index if not exists metric_observations_metric_observed_idx
  on public.metric_observations (metric_name, observed_at desc);
create index if not exists metric_observations_ingestion_run_idx
  on public.metric_observations (ingestion_run_id)
  where ingestion_run_id is not null;

create index if not exists scoring_model_versions_supersedes_idx
  on public.scoring_model_versions (supersedes_id)
  where supersedes_id is not null;
create index if not exists scoring_model_versions_config_hash_idx
  on public.scoring_model_versions (model_key, config_hash);
create unique index if not exists scoring_runs_run_key
  on public.scoring_runs (run_key)
  where run_key is not null;
create index if not exists scoring_runs_model_started_idx
  on public.scoring_runs (scoring_model_version_id, started_at desc)
  where scoring_model_version_id is not null;
create index if not exists scoring_runs_batch_as_of_idx
  on public.scoring_runs (batch_id, as_of_at desc)
  where as_of_at is not null;

create unique index if not exists traction_snapshots_run_company_key
  on public.traction_snapshots (scoring_run_id, company_id)
  where scoring_run_id is not null;
create index if not exists traction_snapshots_run_rank_idx
  on public.traction_snapshots (scoring_run_id, rank)
  where scoring_run_id is not null;
create unique index if not exists founder_traction_snapshots_run_founder_key
  on public.founder_traction_snapshots (scoring_run_id, founder_id)
  where scoring_run_id is not null;
create index if not exists founder_traction_snapshots_run_rank_idx
  on public.founder_traction_snapshots (scoring_run_id, rank)
  where scoring_run_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'evidence_items_set_updated_at'
      and tgrelid = 'public.evidence_items'::regclass
      and not tgisinternal
  ) then
    create trigger evidence_items_set_updated_at
    before update on public.evidence_items
    for each row execute function public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'evidence_attributions_set_updated_at'
      and tgrelid = 'public.evidence_attributions'::regclass
      and not tgisinternal
  ) then
    create trigger evidence_attributions_set_updated_at
    before update on public.evidence_attributions
    for each row execute function public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'scoring_runs_completed_provenance_guard'
      and tgrelid = 'public.scoring_runs'::regclass
      and not tgisinternal
  ) then
    create trigger scoring_runs_completed_provenance_guard
    before insert or update on public.scoring_runs
    for each row execute function public.enforce_completed_scoring_run_provenance();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'scoring_model_versions_completed_run_guard'
      and tgrelid = 'public.scoring_model_versions'::regclass
      and not tgisinternal
  ) then
    create trigger scoring_model_versions_completed_run_guard
    before update on public.scoring_model_versions
    for each row execute function public.prevent_completed_scoring_model_version_rewrite();
  end if;
end
$$;
