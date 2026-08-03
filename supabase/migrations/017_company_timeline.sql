-- Additive Company Timeline storage. Existing post/evidence tables remain the
-- source of truth for social evidence; timeline links never duplicate them.

create table if not exists public.source_documents (
  id uuid primary key default gen_random_uuid(),
  original_url text not null,
  canonical_url text not null,
  source_type text not null,
  publisher text,
  domain text not null,
  title text not null,
  author text,
  published_at timestamptz,
  fetched_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_validated_at timestamptz,
  http_status integer,
  content_hash text not null,
  normalized_text text,
  excerpt text,
  raw_snapshot_path text,
  metadata_json jsonb not null default '{}'::jsonb,
  discovery_method text not null,
  source_quality_tier smallint not null,
  attribution_status text not null default 'needs_review',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_documents_original_url_http check (original_url ~* '^https?://'),
  constraint source_documents_canonical_url_http check (canonical_url ~* '^https?://'),
  constraint source_documents_domain_normalized check (
    length(trim(domain)) > 0 and domain = lower(trim(domain))
  ),
  constraint source_documents_title_not_blank check (length(trim(title)) > 0),
  constraint source_documents_content_hash_sha256 check (content_hash ~ '^[a-f0-9]{64}$'),
  constraint source_documents_type_normalized check (
    source_type ~ '^[a-z][a-z0-9_]*$'
  ),
  constraint source_documents_discovery_method_normalized check (
    discovery_method ~ '^[a-z][a-z0-9_.-]*$'
  ),
  constraint source_documents_quality_tier_check check (source_quality_tier between 1 and 3),
  constraint source_documents_attribution_status_check check (
    attribution_status in ('verified', 'needs_review', 'rejected')
  ),
  constraint source_documents_http_status_check check (
    http_status is null or http_status between 100 and 599
  ),
  constraint source_documents_metadata_object check (jsonb_typeof(metadata_json) = 'object'),
  constraint source_documents_seen_order check (last_seen_at >= fetched_at),
  constraint source_documents_validation_order check (
    last_validated_at is null or last_validated_at >= fetched_at
  ),
  constraint source_documents_canonical_url_unique unique (canonical_url)
);

create index if not exists source_documents_content_hash_idx
  on public.source_documents (content_hash);
create index if not exists source_documents_domain_published_idx
  on public.source_documents (domain, published_at desc);
create index if not exists source_documents_attribution_status_idx
  on public.source_documents (attribution_status, updated_at desc);

create table if not exists public.source_document_entities (
  id uuid primary key default gen_random_uuid(),
  source_document_id uuid not null references public.source_documents(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  founder_id uuid references public.founders(id) on delete cascade,
  relationship_type text not null,
  relevance_reason text not null,
  created_at timestamptz not null default now(),
  constraint source_document_entities_one_target check (
    (company_id is not null and founder_id is null)
    or (company_id is null and founder_id is not null)
  ),
  constraint source_document_entities_relationship_normalized check (
    relationship_type ~ '^[a-z][a-z0-9_]*$'
  ),
  constraint source_document_entities_reason_not_blank check (length(trim(relevance_reason)) > 0)
);

create unique index if not exists source_document_entities_company_unique
  on public.source_document_entities (source_document_id, company_id, relationship_type)
  where company_id is not null;
create unique index if not exists source_document_entities_founder_unique
  on public.source_document_entities (source_document_id, founder_id, relationship_type)
  where founder_id is not null;
create index if not exists source_document_entities_company_idx
  on public.source_document_entities (company_id, source_document_id)
  where company_id is not null;

create table if not exists public.timeline_events (
  id uuid primary key default gen_random_uuid(),
  primary_company_id uuid not null references public.companies(id) on delete restrict,
  category text not null,
  title text not null,
  summary text not null,
  event_date date not null,
  event_date_type text not null,
  importance_score smallint not null,
  is_major boolean not null default false,
  event_key text not null,
  status text not null default 'candidate',
  has_conflict boolean not null default false,
  conflict_summary text,
  classifier_version text,
  extraction_version text,
  first_discovered_at timestamptz not null default now(),
  last_updated_at timestamptz not null default now(),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint timeline_events_category_check check (category in (
    'founded', 'accelerator', 'funding', 'product_launch', 'product_update',
    'traction_milestone', 'revenue_milestone', 'user_milestone', 'customer',
    'partnership', 'pricing', 'business_model', 'hiring', 'leadership',
    'founder', 'geographic_expansion', 'open_source', 'github', 'research',
    'patent', 'regulatory', 'legal', 'press', 'award', 'acquisition', 'merger',
    'exit', 'pivot', 'shutdown', 'website', 'other'
  )),
  constraint timeline_events_title_not_blank check (length(trim(title)) between 3 and 180),
  constraint timeline_events_summary_not_blank check (length(trim(summary)) between 8 and 500),
  constraint timeline_events_date_type_check check (
    event_date_type in ('occurrence_date', 'announcement_date', 'publication_date')
  ),
  constraint timeline_events_importance_check check (importance_score between 0 and 100),
  constraint timeline_events_event_key_not_blank check (
    length(trim(event_key)) > 0 and event_key = lower(trim(event_key))
  ),
  constraint timeline_events_status_check check (
    status in ('candidate', 'processing', 'needs_review', 'published', 'rejected', 'superseded', 'merged')
  ),
  constraint timeline_events_conflict_together check (
    (has_conflict and conflict_summary is not null and length(trim(conflict_summary)) > 0)
    or (not has_conflict and conflict_summary is null)
  ),
  constraint timeline_events_publication_together check (
    (status = 'published' and published_at is not null)
    or (status <> 'published')
  ),
  constraint timeline_events_company_event_key_unique unique (primary_company_id, event_key)
);

create index if not exists timeline_events_published_company_date_idx
  on public.timeline_events (primary_company_id, event_date desc, id desc)
  where status = 'published';
create index if not exists timeline_events_company_category_date_idx
  on public.timeline_events (primary_company_id, category, event_date desc);
create index if not exists timeline_events_status_updated_idx
  on public.timeline_events (status, updated_at desc);
create index if not exists timeline_events_unresolved_conflict_idx
  on public.timeline_events (primary_company_id, event_date desc)
  where has_conflict and status in ('needs_review', 'published');

create table if not exists public.timeline_event_entities (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.timeline_events(id) on delete cascade,
  entity_type text not null,
  company_id uuid references public.companies(id) on delete restrict,
  founder_id uuid references public.founders(id) on delete restrict,
  external_entity_name text,
  relationship_type text not null,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  constraint timeline_event_entities_type_check check (entity_type in (
    'company', 'founder', 'investor', 'customer', 'partner', 'product', 'other'
  )),
  constraint timeline_event_entities_target_check check (
    (entity_type = 'company' and company_id is not null and founder_id is null and external_entity_name is null)
    or (entity_type = 'founder' and founder_id is not null and company_id is null and external_entity_name is null)
    or (entity_type not in ('company', 'founder') and company_id is null and founder_id is null
        and external_entity_name is not null and length(trim(external_entity_name)) > 0)
  ),
  constraint timeline_event_entities_relationship_normalized check (
    relationship_type ~ '^[a-z][a-z0-9_]*$'
  )
);

create index if not exists timeline_event_entities_event_idx
  on public.timeline_event_entities (event_id, entity_type);
create index if not exists timeline_event_entities_company_idx
  on public.timeline_event_entities (company_id, event_id) where company_id is not null;

create table if not exists public.timeline_event_evidence (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.timeline_events(id) on delete cascade,
  source_document_id uuid not null references public.source_documents(id) on delete restrict,
  evidence_role text not null,
  supports_event_date boolean not null default false,
  supports_title boolean not null default false,
  supports_summary boolean not null default false,
  supports_quantitative_claim boolean not null default false,
  evidence_excerpt text not null,
  extracted_claims jsonb not null default '{}'::jsonb,
  source_event_date date,
  is_conflicting boolean not null default false,
  conflict_description text,
  created_at timestamptz not null default now(),
  constraint timeline_event_evidence_role_check check (
    evidence_role in ('primary', 'supporting', 'conflicting', 'discovery_only')
  ),
  constraint timeline_event_evidence_excerpt_not_blank check (length(trim(evidence_excerpt)) > 0),
  constraint timeline_event_evidence_claims_object check (jsonb_typeof(extracted_claims) = 'object'),
  constraint timeline_event_evidence_conflict_together check (
    (is_conflicting and evidence_role = 'conflicting' and conflict_description is not null
      and length(trim(conflict_description)) > 0)
    or (not is_conflicting and evidence_role <> 'conflicting' and conflict_description is null)
  ),
  constraint timeline_event_evidence_event_source_unique unique (event_id, source_document_id)
);

create index if not exists timeline_event_evidence_event_idx
  on public.timeline_event_evidence (event_id, evidence_role);
create index if not exists timeline_event_evidence_source_idx
  on public.timeline_event_evidence (source_document_id, event_id);

create table if not exists public.timeline_event_posts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.timeline_events(id) on delete cascade,
  evidence_id uuid not null references public.evidence_items(id) on delete restrict,
  evidence_role text not null,
  relevance_reason text not null,
  created_at timestamptz not null default now(),
  constraint timeline_event_posts_role_check check (
    evidence_role in ('primary', 'supporting', 'conflicting')
  ),
  constraint timeline_event_posts_reason_not_blank check (length(trim(relevance_reason)) > 0),
  constraint timeline_event_posts_event_evidence_unique unique (event_id, evidence_id)
);

create index if not exists timeline_event_posts_event_idx
  on public.timeline_event_posts (event_id, evidence_role);

create table if not exists public.timeline_event_candidates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  candidate_payload jsonb not null,
  proposed_event_date date,
  proposed_event_date_type text,
  proposed_category text,
  proposed_title text,
  proposed_summary text,
  proposed_importance smallint,
  proposed_merge_key text,
  rejection_reason text,
  status text not null default 'pending',
  classifier_version text not null,
  extraction_version text not null,
  input_content_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint timeline_event_candidates_payload_object check (jsonb_typeof(candidate_payload) = 'object'),
  constraint timeline_event_candidates_status_check check (
    status in ('pending', 'processing', 'needs_review', 'accepted', 'rejected', 'merged')
  ),
  constraint timeline_event_candidates_date_type_check check (
    proposed_event_date_type is null or proposed_event_date_type in (
      'occurrence_date', 'announcement_date', 'publication_date'
    )
  ),
  constraint timeline_event_candidates_importance_check check (
    proposed_importance is null or proposed_importance between 0 and 100
  ),
  constraint timeline_event_candidates_input_hash_sha256 check (
    input_content_hash ~ '^[a-f0-9]{64}$'
  ),
  constraint timeline_event_candidates_processing_unique unique (
    company_id, input_content_hash, classifier_version, extraction_version
  )
);

create index if not exists timeline_event_candidates_review_idx
  on public.timeline_event_candidates (status, updated_at desc)
  where status in ('pending', 'needs_review');
create index if not exists timeline_event_candidates_company_status_idx
  on public.timeline_event_candidates (company_id, status, updated_at desc);
create index if not exists timeline_event_candidates_unresolved_date_idx
  on public.timeline_event_candidates (company_id, created_at desc)
  where proposed_event_date is null and status in ('pending', 'needs_review');

create table if not exists public.timeline_candidate_sources (
  candidate_id uuid not null references public.timeline_event_candidates(id) on delete cascade,
  source_document_id uuid not null references public.source_documents(id) on delete restrict,
  evidence_role text not null default 'discovery_only',
  created_at timestamptz not null default now(),
  primary key (candidate_id, source_document_id),
  constraint timeline_candidate_sources_role_check check (
    evidence_role in ('primary', 'supporting', 'conflicting', 'discovery_only')
  )
);

create table if not exists public.timeline_company_state (
  company_id uuid primary key references public.companies(id) on delete cascade,
  historical_backfill_status text not null default 'pending',
  historical_backfill_started_at timestamptz,
  historical_backfill_completed_at timestamptz,
  last_incremental_scan_at timestamptz,
  last_deep_scan_at timestamptz,
  earliest_supported_event_date date,
  latest_supported_event_date date,
  published_event_count integer not null default 0,
  candidate_event_count integer not null default 0,
  unresolved_conflict_count integer not null default 0,
  unresolved_date_count integer not null default 0,
  source_coverage jsonb not null default '{}'::jsonb,
  last_successful_artifact_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint timeline_company_state_status_check check (
    historical_backfill_status in ('pending', 'running', 'completed', 'partial', 'failed')
  ),
  constraint timeline_company_state_counts_nonnegative check (
    published_event_count >= 0 and candidate_event_count >= 0
    and unresolved_conflict_count >= 0 and unresolved_date_count >= 0
  ),
  constraint timeline_company_state_dates_order check (
    earliest_supported_event_date is null or latest_supported_event_date is null
    or latest_supported_event_date >= earliest_supported_event_date
  ),
  constraint timeline_company_state_backfill_times check (
    historical_backfill_completed_at is null
    or (historical_backfill_started_at is not null
      and historical_backfill_completed_at >= historical_backfill_started_at)
  ),
  constraint timeline_company_state_source_coverage_object check (jsonb_typeof(source_coverage) = 'object')
);

create index if not exists timeline_company_state_backfill_idx
  on public.timeline_company_state (historical_backfill_status, updated_at);
create index if not exists timeline_company_state_unresolved_idx
  on public.timeline_company_state (unresolved_conflict_count desc, unresolved_date_count desc)
  where unresolved_conflict_count > 0 or unresolved_date_count > 0;

create table if not exists public.timeline_source_coverage (
  company_id uuid not null references public.companies(id) on delete cascade,
  source_class text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  terminal_at timestamptz,
  terminal_reason text,
  cursor_json jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, source_class),
  constraint timeline_source_coverage_source_class_normalized check (
    source_class ~ '^[a-z][a-z0-9_.-]*$'
  ),
  constraint timeline_source_coverage_status_check check (status in (
    'pending', 'running', 'completed', 'no_applicable_source', 'no_results',
    'blocked', 'rate_limited', 'authentication_required', 'failed', 'retry_pending'
  )),
  constraint timeline_source_coverage_attempts_nonnegative check (attempts >= 0),
  constraint timeline_source_coverage_cursor_object check (jsonb_typeof(cursor_json) = 'object'),
  constraint timeline_source_coverage_terminal_together check (
    (status in ('completed', 'no_applicable_source', 'no_results', 'blocked',
      'authentication_required', 'failed') and terminal_at is not null
      and terminal_reason is not null and length(trim(terminal_reason)) > 0)
    or (status in ('pending', 'running', 'rate_limited', 'retry_pending') and terminal_at is null)
  )
);

create index if not exists timeline_source_coverage_status_idx
  on public.timeline_source_coverage (status, updated_at);

create table if not exists public.timeline_event_audit_log (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.timeline_events(id) on delete restrict,
  candidate_id uuid references public.timeline_event_candidates(id) on delete restrict,
  company_id uuid not null references public.companies(id) on delete restrict,
  actor_id text not null,
  actor_email text,
  action text not null,
  before_json jsonb,
  after_json jsonb,
  reason text,
  created_at timestamptz not null default now(),
  constraint timeline_event_audit_target_check check (not (event_id is not null and candidate_id is not null)),
  constraint timeline_event_audit_actor_not_blank check (length(trim(actor_id)) > 0),
  constraint timeline_event_audit_action_normalized check (action ~ '^[a-z][a-z0-9_]*$'),
  constraint timeline_event_audit_before_object check (
    before_json is null or jsonb_typeof(before_json) = 'object'
  ),
  constraint timeline_event_audit_after_object check (
    after_json is null or jsonb_typeof(after_json) = 'object'
  )
);

create index if not exists timeline_event_audit_event_idx
  on public.timeline_event_audit_log (event_id, created_at desc) where event_id is not null;
create index if not exists timeline_event_audit_company_idx
  on public.timeline_event_audit_log (company_id, created_at desc);

create table if not exists public.timeline_artifact_invalidations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  reason text not null,
  status text not null default 'pending',
  invalidated_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint timeline_artifact_invalidations_reason_not_blank check (length(trim(reason)) > 0),
  constraint timeline_artifact_invalidations_status_check check (
    status in ('pending', 'processing', 'completed', 'failed')
  ),
  constraint timeline_artifact_invalidations_processed_together check (
    (status = 'completed' and processed_at is not null) or status <> 'completed'
  )
);

create index if not exists timeline_artifact_invalidations_pending_idx
  on public.timeline_artifact_invalidations (invalidated_at)
  where status in ('pending', 'failed');

create or replace function public.guard_timeline_event_publication()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.status = 'published' then
    if new.published_at is null then
      new.published_at := now();
    end if;

    if not exists (
      select 1
      from public.timeline_event_evidence evidence
      join public.source_documents source on source.id = evidence.source_document_id
      where evidence.event_id = new.id
        and evidence.evidence_role in ('primary', 'supporting')
        and evidence.supports_event_date
        and evidence.supports_title
        and evidence.supports_summary
        and source.attribution_status = 'verified'
        and source.canonical_url ~* '^https?://'
    ) then
      raise exception 'timeline event % cannot be published without verified direct evidence supporting date, title, and summary', new.id;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.assert_published_timeline_event_has_evidence(target_event_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_is_published boolean;
begin
  select event.status = 'published'
  into target_is_published
  from public.timeline_events event
  where event.id = target_event_id;

  -- Event deletion may cascade through evidence rows. In that case there is no
  -- surviving public event to revalidate.
  if not coalesce(target_is_published, false) then
    return;
  end if;

  if not exists (
    select 1
    from public.timeline_event_evidence evidence
    join public.source_documents source on source.id = evidence.source_document_id
    where evidence.event_id = target_event_id
      and evidence.evidence_role in ('primary', 'supporting')
      and not evidence.is_conflicting
      and evidence.supports_event_date
      and evidence.supports_title
      and evidence.supports_summary
      and source.attribution_status = 'verified'
      and source.canonical_url ~* '^https?://'
  ) then
    raise exception 'published timeline event % must retain verified direct evidence supporting date, title, and summary', target_event_id;
  end if;
end;
$$;

create or replace function public.revalidate_timeline_event_after_evidence_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.assert_published_timeline_event_has_evidence(old.event_id);
    return old;
  end if;

  if old.event_id is distinct from new.event_id then
    perform public.assert_published_timeline_event_has_evidence(old.event_id);
  end if;
  perform public.assert_published_timeline_event_has_evidence(new.event_id);
  return new;
end;
$$;

create or replace function public.revalidate_timeline_events_after_source_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  affected_event_id uuid;
begin
  if old.attribution_status is not distinct from new.attribution_status
      and old.canonical_url is not distinct from new.canonical_url then
    return new;
  end if;

  for affected_event_id in
    select distinct evidence.event_id
    from public.timeline_event_evidence evidence
    where evidence.source_document_id = new.id
  loop
    perform public.assert_published_timeline_event_has_evidence(affected_event_id);
  end loop;
  return new;
end;
$$;

create or replace function public.reject_timeline_audit_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  raise exception 'timeline_event_audit_log is append-only';
end;
$$;

drop trigger if exists timeline_events_publication_guard on public.timeline_events;
create trigger timeline_events_publication_guard
before insert or update of status, published_at, title, summary, event_date, event_date_type, category
on public.timeline_events
for each row execute function public.guard_timeline_event_publication();

drop trigger if exists timeline_event_evidence_revalidate_publication on public.timeline_event_evidence;
create trigger timeline_event_evidence_revalidate_publication
after delete or update of event_id, source_document_id, evidence_role,
  supports_event_date, supports_title, supports_summary, is_conflicting
on public.timeline_event_evidence
for each row execute function public.revalidate_timeline_event_after_evidence_mutation();

drop trigger if exists source_documents_revalidate_timeline_publication on public.source_documents;
create trigger source_documents_revalidate_timeline_publication
after update of attribution_status, canonical_url
on public.source_documents
for each row execute function public.revalidate_timeline_events_after_source_mutation();

drop trigger if exists timeline_event_audit_log_immutable on public.timeline_event_audit_log;
create trigger timeline_event_audit_log_immutable
before update or delete on public.timeline_event_audit_log
for each row execute function public.reject_timeline_audit_mutation();

drop trigger if exists source_documents_set_updated_at on public.source_documents;
create trigger source_documents_set_updated_at before update on public.source_documents
for each row execute function public.set_updated_at();
drop trigger if exists timeline_events_set_updated_at on public.timeline_events;
create trigger timeline_events_set_updated_at before update on public.timeline_events
for each row execute function public.set_updated_at();
drop trigger if exists timeline_event_candidates_set_updated_at on public.timeline_event_candidates;
create trigger timeline_event_candidates_set_updated_at before update on public.timeline_event_candidates
for each row execute function public.set_updated_at();
drop trigger if exists timeline_company_state_set_updated_at on public.timeline_company_state;
create trigger timeline_company_state_set_updated_at before update on public.timeline_company_state
for each row execute function public.set_updated_at();
drop trigger if exists timeline_source_coverage_set_updated_at on public.timeline_source_coverage;
create trigger timeline_source_coverage_set_updated_at before update on public.timeline_source_coverage
for each row execute function public.set_updated_at();
drop trigger if exists timeline_artifact_invalidations_set_updated_at on public.timeline_artifact_invalidations;
create trigger timeline_artifact_invalidations_set_updated_at before update on public.timeline_artifact_invalidations
for each row execute function public.set_updated_at();

alter table public.source_documents enable row level security;
alter table public.source_document_entities enable row level security;
alter table public.timeline_events enable row level security;
alter table public.timeline_event_entities enable row level security;
alter table public.timeline_event_evidence enable row level security;
alter table public.timeline_event_posts enable row level security;
alter table public.timeline_event_candidates enable row level security;
alter table public.timeline_candidate_sources enable row level security;
alter table public.timeline_company_state enable row level security;
alter table public.timeline_source_coverage enable row level security;
alter table public.timeline_event_audit_log enable row level security;
alter table public.timeline_artifact_invalidations enable row level security;

revoke all privileges on table public.source_documents from anon, authenticated;
revoke all privileges on table public.source_document_entities from anon, authenticated;
revoke all privileges on table public.timeline_events from anon, authenticated;
revoke all privileges on table public.timeline_event_entities from anon, authenticated;
revoke all privileges on table public.timeline_event_evidence from anon, authenticated;
revoke all privileges on table public.timeline_event_posts from anon, authenticated;
revoke all privileges on table public.timeline_event_candidates from anon, authenticated;
revoke all privileges on table public.timeline_candidate_sources from anon, authenticated;
revoke all privileges on table public.timeline_company_state from anon, authenticated;
revoke all privileges on table public.timeline_source_coverage from anon, authenticated;
revoke all privileges on table public.timeline_event_audit_log from anon, authenticated;
revoke all privileges on table public.timeline_artifact_invalidations from anon, authenticated;

grant all privileges on table public.source_documents to service_role;
grant all privileges on table public.source_document_entities to service_role;
grant all privileges on table public.timeline_events to service_role;
grant all privileges on table public.timeline_event_entities to service_role;
grant all privileges on table public.timeline_event_evidence to service_role;
grant all privileges on table public.timeline_event_posts to service_role;
grant all privileges on table public.timeline_event_candidates to service_role;
grant all privileges on table public.timeline_candidate_sources to service_role;
grant all privileges on table public.timeline_company_state to service_role;
grant all privileges on table public.timeline_source_coverage to service_role;
grant select, insert on table public.timeline_event_audit_log to service_role;
grant all privileges on table public.timeline_artifact_invalidations to service_role;

revoke all privileges on function public.guard_timeline_event_publication() from public, anon, authenticated;
revoke all privileges on function public.assert_published_timeline_event_has_evidence(uuid) from public, anon, authenticated;
revoke all privileges on function public.revalidate_timeline_event_after_evidence_mutation() from public, anon, authenticated;
revoke all privileges on function public.revalidate_timeline_events_after_source_mutation() from public, anon, authenticated;
revoke all privileges on function public.reject_timeline_audit_mutation() from public, anon, authenticated;
grant execute on function public.guard_timeline_event_publication() to service_role;
grant execute on function public.assert_published_timeline_event_has_evidence(uuid) to service_role;
grant execute on function public.revalidate_timeline_event_after_evidence_mutation() to service_role;
grant execute on function public.revalidate_timeline_events_after_source_mutation() to service_role;
grant execute on function public.reject_timeline_audit_mutation() to service_role;

drop policy if exists published_timeline_events_read on public.timeline_events;

-- Never grant the base event table to public roles: it includes importance,
-- model lineage, internal status and processing timestamps.
create or replace view public.published_timeline_events
with (security_barrier = true)
as
select
  event.id,
  event.primary_company_id,
  event.category,
  event.title,
  event.summary,
  event.event_date,
  event.event_date_type,
  event.is_major,
  event.has_conflict,
  event.conflict_summary,
  event.published_at,
  event.updated_at
from public.timeline_events event
where event.status = 'published'
  and event.published_at is not null;

revoke all privileges on table public.published_timeline_events from public;
grant select on table public.published_timeline_events to anon, authenticated, service_role;

-- Safe source projection: raw text, raw snapshot paths, metadata, hashes, model
-- lineage and internal review fields never enter the public relation.
create or replace view public.published_timeline_source_metadata
with (security_barrier = true)
as
select distinct
  source.id,
  source.canonical_url,
  source.source_type,
  source.publisher,
  source.domain,
  source.title,
  source.author,
  source.published_at,
  evidence.evidence_role,
  evidence.evidence_excerpt,
  evidence.source_event_date,
  evidence.is_conflicting,
  evidence.conflict_description,
  evidence.event_id
from public.source_documents source
join public.timeline_event_evidence evidence on evidence.source_document_id = source.id
join public.timeline_events event on event.id = evidence.event_id
where event.status = 'published'
  and event.published_at is not null
  and evidence.evidence_role <> 'discovery_only'
  and source.attribution_status = 'verified';

revoke all privileges on table public.published_timeline_source_metadata from public;
grant select on table public.published_timeline_source_metadata to anon, authenticated, service_role;

comment on table public.timeline_event_candidates is
  'Private unresolved or unreviewed classifier output. Never queried by public timeline APIs.';
comment on table public.timeline_event_audit_log is
  'Immutable admin mutation history; application roles receive no update or delete grants.';
comment on function public.guard_timeline_event_publication() is
  'Prevents public timeline publication unless verified direct evidence supports the exact date, title, and summary.';
comment on function public.assert_published_timeline_event_has_evidence(uuid) is
  'Fails closed when a published event would lose its last verified direct source supporting date, title, and summary.';
comment on function public.reject_timeline_audit_mutation() is
  'Enforces append-only timeline audit history even for the service role.';
