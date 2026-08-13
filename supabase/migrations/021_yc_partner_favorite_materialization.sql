-- Additive storage for the YC Partner favorite materialization. The score rows
-- are the current materialized projection for a partner/company/model version;
-- the canonical social evidence remains in evidence_items.

create table if not exists public.yc_partner_favorite_scores (
  id uuid primary key default gen_random_uuid(),
  partner_id text not null,
  partner_display_name text not null,
  partner_category text not null default 'yc_partner',
  company_id uuid not null references public.companies(id) on delete cascade,
  scoring_model_version_id uuid not null references public.scoring_model_versions(id) on delete restrict,
  rank integer not null,
  score numeric(6,3) not null,
  confidence_level text not null,
  confidence_score numeric(6,3) not null,
  evidence_count integer not null default 0,
  unique_platform_count integer not null default 0,
  unique_context_count integer not null default 0,
  dated_evidence_count integer not null default 0,
  verified_link_count integer not null default 0,
  primary_reason text not null,
  confidence_reasons text[] not null default '{}'::text[],
  strongest_evidence_score numeric(6,3) not null default 0,
  secondary_evidence_bonus numeric(6,3) not null default 0,
  independent_context_bonus numeric(6,3) not null default 0,
  negative_penalty numeric(6,3) not null default 0,
  conviction_strength numeric(6,3) not null default 0,
  praise_strength numeric(6,3) not null default 0,
  specificity numeric(6,3) not null default 0,
  context_quality numeric(6,3) not null default 0,
  signal_types text[] not null default '{}'::text[],
  input_observed_through timestamptz not null,
  input_fingerprint text not null,
  materialized_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint yc_partner_favorite_scores_partner_id_check check (
    partner_id = lower(trim(partner_id))
    and partner_id ~ '^[a-z0-9]([a-z0-9-]{0,118}[a-z0-9])?$'
  ),
  constraint yc_partner_favorite_scores_partner_name_check check (
    length(trim(partner_display_name)) between 1 and 200
  ),
  constraint yc_partner_favorite_scores_category_check check (
    partner_category = lower(trim(partner_category))
    and partner_category ~ '^[a-z][a-z0-9_-]*$'
  ),
  constraint yc_partner_favorite_scores_rank_check check (rank > 0),
  constraint yc_partner_favorite_scores_score_range check (score between 0 and 100),
  constraint yc_partner_favorite_scores_confidence_score_range check (
    confidence_score between 0 and 100
  ),
  constraint yc_partner_favorite_scores_confidence_level_check check (
    (confidence_level = 'low' and confidence_score < 45)
    or (confidence_level = 'medium' and confidence_score >= 45 and confidence_score < 75)
    or (confidence_level = 'high' and confidence_score >= 75)
  ),
  constraint yc_partner_favorite_scores_evidence_count_check check (evidence_count >= 0),
  constraint yc_partner_favorite_scores_platform_count_check check (
    unique_platform_count between 0 and evidence_count
  ),
  constraint yc_partner_favorite_scores_context_count_check check (
    unique_context_count between 0 and evidence_count
  ),
  constraint yc_partner_favorite_scores_dated_count_check check (
    dated_evidence_count between 0 and evidence_count
  ),
  constraint yc_partner_favorite_scores_verified_link_count_check check (
    verified_link_count between 0 and evidence_count
  ),
  constraint yc_partner_favorite_scores_primary_reason_check check (
    length(trim(primary_reason)) between 1 and 1000
  ),
  constraint yc_partner_favorite_scores_breakdown_range_check check (
    strongest_evidence_score between 0 and 100
    and secondary_evidence_bonus between 0 and 100
    and independent_context_bonus between 0 and 100
    and negative_penalty between 0 and 100
    and conviction_strength between 0 and 100
    and praise_strength between 0 and 100
    and specificity between 0 and 100
    and context_quality between 0 and 100
  ),
  constraint yc_partner_favorite_scores_signal_types_check check (
    signal_types <@ ARRAY[
      'explicit_superlative',
      'strong_conviction',
      'substantive_praise',
      'positive_commentary',
      'neutral_mention',
      'negative_commentary',
      'unclear'
    ]::text[]
  ),
  constraint yc_partner_favorite_scores_input_fingerprint_check check (
    length(trim(input_fingerprint)) > 0
  ),
  constraint yc_partner_favorite_scores_partner_company_model_key unique (
    partner_id,
    company_id,
    scoring_model_version_id
  ),
  constraint yc_partner_favorite_scores_partner_model_rank_key unique (
    partner_id,
    scoring_model_version_id,
    rank
  )
);

comment on table public.yc_partner_favorite_scores is
  'Current normalized YC partner/company favorite scores and explainable confidence breakdowns. A row may have score 0 when the materializer includes a company with no attributable evidence.';
comment on column public.yc_partner_favorite_scores.partner_id is
  'Stable text ID from the application-owned YC group-partner registry (currently src/lib/social/top-voices.ts). It is intentionally not a foreign key because that registry is not a database entity; materializers must validate IDs against the registry and preserve them across display-name changes.';
comment on column public.yc_partner_favorite_scores.partner_display_name is
  'Display-name snapshot from the YC partner registry at materialization time; partner_id remains the stable identity.';
comment on column public.yc_partner_favorite_scores.scoring_model_version_id is
  'Immutable scoring model definition used to produce this materialization; re-runs update the same partner/company/model row.';
comment on column public.yc_partner_favorite_scores.input_fingerprint is
  'Deterministic fingerprint of the evidence/attribution input set used for this row, allowing continuous refreshes to detect changed inputs.';

create table if not exists public.yc_partner_favorite_citations (
  id uuid primary key default gen_random_uuid(),
  favorite_score_id uuid not null references public.yc_partner_favorite_scores(id) on delete cascade,
  evidence_id uuid not null references public.evidence_items(id) on delete restrict,
  citation_rank smallint not null,
  source_url text not null,
  excerpt text not null,
  reason text not null,
  signal_type text not null,
  score_contribution numeric(6,3) not null,
  physical_post_key text not null,
  conviction_strength numeric(6,3) not null default 0,
  praise_strength numeric(6,3) not null default 0,
  specificity numeric(6,3) not null default 0,
  context_quality numeric(6,3) not null default 0,
  negative_penalty numeric(6,3) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint yc_partner_favorite_citations_rank_check check (citation_rank > 0),
  constraint yc_partner_favorite_citations_source_url_check check (source_url ~* '^https?://'),
  constraint yc_partner_favorite_citations_excerpt_check check (
    length(trim(excerpt)) between 1 and 2000
  ),
  constraint yc_partner_favorite_citations_reason_check check (
    length(trim(reason)) between 1 and 1000
  ),
  constraint yc_partner_favorite_citations_signal_type_check check (
    signal_type in (
      'explicit_superlative',
      'strong_conviction',
      'substantive_praise',
      'positive_commentary',
      'neutral_mention',
      'negative_commentary',
      'unclear'
    )
  ),
  constraint yc_partner_favorite_citations_score_contribution_check check (
    score_contribution between 0 and 100
  ),
  constraint yc_partner_favorite_citations_physical_post_key_check check (
    length(trim(physical_post_key)) > 0
  ),
  constraint yc_partner_favorite_citations_signal_breakdown_range_check check (
    conviction_strength between 0 and 100
    and praise_strength between 0 and 100
    and specificity between 0 and 100
    and context_quality between 0 and 100
    and negative_penalty between 0 and 100
  ),
  constraint yc_partner_favorite_citations_score_evidence_key unique (
    favorite_score_id,
    evidence_id
  ),
  constraint yc_partner_favorite_citations_score_rank_key unique (
    favorite_score_id,
    citation_rank
  ),
  constraint yc_partner_favorite_citations_score_physical_post_key unique (
    favorite_score_id,
    physical_post_key
  )
);

comment on table public.yc_partner_favorite_citations is
  'Normalized, selected citations for YC partner favorite scores. Platform, publication date, and canonical evidence identity are read from evidence_items through evidence_id; citation-specific URL, excerpt, reason, and signal breakdown are materialized here.';
comment on column public.yc_partner_favorite_citations.evidence_id is
  'Canonical evidence identity. Restricting deletion preserves citation integrity until the affected favorite score is recomputed or removed.';

create index if not exists yc_partner_favorite_scores_partner_rank_idx
  on public.yc_partner_favorite_scores (partner_id, scoring_model_version_id, rank);
create index if not exists yc_partner_favorite_scores_partner_score_idx
  on public.yc_partner_favorite_scores (
    partner_id,
    scoring_model_version_id,
    score desc,
    confidence_score desc,
    rank,
    company_id
  );
create index if not exists yc_partner_favorite_scores_company_model_idx
  on public.yc_partner_favorite_scores (company_id, scoring_model_version_id);
create index if not exists yc_partner_favorite_scores_model_materialized_idx
  on public.yc_partner_favorite_scores (scoring_model_version_id, materialized_at desc);
create index if not exists yc_partner_favorite_citations_evidence_idx
  on public.yc_partner_favorite_citations (evidence_id);

drop trigger if exists yc_partner_favorite_scores_set_updated_at
  on public.yc_partner_favorite_scores;
create trigger yc_partner_favorite_scores_set_updated_at
before update on public.yc_partner_favorite_scores
for each row execute function public.set_updated_at();

drop trigger if exists yc_partner_favorite_citations_set_updated_at
  on public.yc_partner_favorite_citations;
create trigger yc_partner_favorite_citations_set_updated_at
before update on public.yc_partner_favorite_citations
for each row execute function public.set_updated_at();

-- Favorite materializations are written by trusted server-side workers and are
-- read through the application API, like the existing raw evidence and scoring
-- tables. No direct anonymous/authenticated table access is granted.
alter table public.yc_partner_favorite_scores enable row level security;
alter table public.yc_partner_favorite_citations enable row level security;

revoke all privileges on table public.yc_partner_favorite_scores from public, anon, authenticated;
revoke all privileges on table public.yc_partner_favorite_citations from public, anon, authenticated;
grant all privileges on table public.yc_partner_favorite_scores to service_role;
grant all privileges on table public.yc_partner_favorite_citations to service_role;
