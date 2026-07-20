-- Batch-scoped attribution for entities which can appear in more than one
-- cohort. Canonical social accounts remain deduplicated by platform identity;
-- owner rows carry the many-to-many cohort/entity relationship and can be
-- retired without deleting historical evidence.

alter table public.evidence_attributions
  add column if not exists batch_id uuid references public.batches(id) on delete restrict;

-- A legacy founder attribution cannot be assigned safely when that founder is
-- linked to companies in multiple cohorts. Preserve the evidence row but make
-- it non-scoreable until the next importer run writes explicit per-batch rows.
with shared_founders as (
  select cf.founder_id
  from public.company_founders cf
  join public.companies c on c.id = cf.company_id
  group by cf.founder_id
  having count(distinct c.batch_id) > 1
)
update public.evidence_attributions attribution
set score_eligible = false,
    review_state = 'needs_review',
    risk_level = 'medium',
    metadata_json = coalesce(attribution.metadata_json, '{}'::jsonb) || jsonb_build_object(
      'batch_scope_migration', 'shared_founder_requires_batch_reimport'
    )
from shared_founders
where attribution.founder_id = shared_founders.founder_id
  and attribution.batch_id is null;

drop index if exists public.evidence_attributions_company_type_key;
drop index if exists public.evidence_attributions_founder_type_key;
drop index if exists public.evidence_attributions_primary_entity_type_key;

create unique index evidence_attributions_company_type_key
  on public.evidence_attributions (
    evidence_id,
    company_id,
    attribution_type,
    coalesce(batch_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where company_id is not null;
create unique index evidence_attributions_founder_type_key
  on public.evidence_attributions (
    evidence_id,
    founder_id,
    attribution_type,
    coalesce(batch_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where founder_id is not null;
create unique index evidence_attributions_primary_entity_type_key
  on public.evidence_attributions (
    evidence_id,
    entity_type,
    coalesce(batch_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where is_primary;
create index if not exists evidence_attributions_batch_entity_idx
  on public.evidence_attributions (batch_id, entity_type, company_id, founder_id)
  where batch_id is not null;

comment on column public.evidence_attributions.batch_id is
  'Cohort in which this entity attribution was observed. Null is reserved for legacy or genuinely cohort-neutral rows.';

create table if not exists public.social_account_owners (
  id uuid primary key default gen_random_uuid(),
  owner_key text not null unique,
  social_account_id uuid not null references public.social_accounts(id) on delete cascade,
  batch_id uuid not null references public.batches(id) on delete cascade,
  entity_type text not null,
  company_id uuid references public.companies(id) on delete cascade,
  founder_id uuid references public.founders(id) on delete cascade,
  owner_source_key text not null,
  account_source_key text not null,
  platform text not null,
  review_state text not null default 'needs_review',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_seen_run_id uuid references public.ingestion_runs(id) on delete set null,
  retired_at timestamptz,
  retirement_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_account_owners_target_check check (
    (entity_type = 'company' and company_id is not null and founder_id is null)
    or (entity_type = 'founder' and founder_id is not null and company_id is null)
  ),
  constraint social_account_owners_owner_key_not_blank check (length(trim(owner_key)) > 0),
  constraint social_account_owners_owner_source_key_not_blank check (length(trim(owner_source_key)) > 0),
  constraint social_account_owners_account_source_key_not_blank check (length(trim(account_source_key)) > 0),
  constraint social_account_owners_platform_normalized check (
    length(trim(platform)) > 0 and platform = lower(trim(platform))
  ),
  constraint social_account_owners_review_state_check check (
    review_state in ('verified', 'needs_review', 'rejected')
  ),
  constraint social_account_owners_seen_at_order check (last_seen_at >= first_seen_at),
  constraint social_account_owners_retirement_check check (
    (retired_at is null and retirement_reason is null)
    or (
      retired_at is not null
      and review_state = 'rejected'
      and retirement_reason is not null
      and length(trim(retirement_reason)) > 0
    )
  )
);

comment on table public.social_account_owners is
  'Batch-scoped many-to-many ownership for canonical social accounts; absent mappings are retired, never deleted.';

create index if not exists social_account_owners_batch_review_idx
  on public.social_account_owners (batch_id, review_state, retired_at);
create index if not exists social_account_owners_company_idx
  on public.social_account_owners (company_id, platform)
  where company_id is not null and retired_at is null;
create index if not exists social_account_owners_founder_idx
  on public.social_account_owners (founder_id, platform)
  where founder_id is not null and retired_at is null;
create index if not exists social_account_owners_account_idx
  on public.social_account_owners (social_account_id, batch_id);

drop trigger if exists social_account_owners_set_updated_at on public.social_account_owners;
create trigger social_account_owners_set_updated_at
before update on public.social_account_owners
for each row execute function public.set_updated_at();

alter table public.social_account_owners enable row level security;
revoke all privileges on table public.social_account_owners from anon, authenticated;
grant all privileges on table public.social_account_owners to service_role;
