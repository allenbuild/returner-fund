-- Versioned, append-only classification metadata.  Raw source content remains
-- in evidence_items; this table stores only the decision and its public-facing
-- evidence snippets so a backfill can be audited and rolled back safely.

create table if not exists public.evidence_topic_classifications (
  id uuid primary key default gen_random_uuid(),
  evidence_id uuid not null references public.evidence_items(id) on delete cascade,
  taxonomy_version text not null,
  classifier_version text not null,
  classifier_method text not null,
  primary_topic text not null,
  secondary_topic text,
  secondary_signals jsonb not null default '[]'::jsonb,
  evidence_json jsonb not null default '[]'::jsonb,
  reasoning_summary text not null,
  alternatives_json jsonb not null default '[]'::jsonb,
  confidence numeric not null,
  needs_review boolean not null default false,
  manual_override boolean not null default false,
  overridden_by text,
  override_reason text,
  supersedes_id uuid references public.evidence_topic_classifications(id) on delete restrict,
  classified_at timestamptz not null default now(),
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  constraint evidence_topic_classifications_method_check check (classifier_method in ('curated', 'rules', 'fallback', 'manual')),
  constraint evidence_topic_classifications_confidence_check check (confidence >= 0 and confidence <= 1),
  constraint evidence_topic_classifications_topic_check check (primary_topic ~ '^[a-z][a-z0-9-]*$' and (secondary_topic is null or secondary_topic ~ '^[a-z][a-z0-9-]*$')),
  constraint evidence_topic_classifications_json_check check (jsonb_typeof(secondary_signals) = 'array' and jsonb_typeof(evidence_json) = 'array' and jsonb_typeof(alternatives_json) = 'array'),
  constraint evidence_topic_classifications_reason_check check (length(trim(reasoning_summary)) > 0),
  constraint evidence_topic_classifications_override_check check (not manual_override or overridden_by is not null)
);

create unique index if not exists evidence_topic_classifications_one_active_idx
  on public.evidence_topic_classifications (evidence_id)
  where retired_at is null;
create index if not exists evidence_topic_classifications_topic_active_idx
  on public.evidence_topic_classifications (primary_topic, classified_at desc)
  where retired_at is null;
create index if not exists evidence_topic_classifications_review_active_idx
  on public.evidence_topic_classifications (needs_review, confidence, classified_at desc)
  where retired_at is null;
create index if not exists evidence_topic_classifications_version_active_idx
  on public.evidence_topic_classifications (taxonomy_version, classifier_version, classified_at desc)
  where retired_at is null;

comment on table public.evidence_topic_classifications is
  'Versioned topic decisions for canonical evidence.  Rows are superseded/retired, never overwritten.';

alter table public.evidence_topic_classifications enable row level security;
revoke all on table public.evidence_topic_classifications from public, anon, authenticated;
grant all on table public.evidence_topic_classifications to service_role;
