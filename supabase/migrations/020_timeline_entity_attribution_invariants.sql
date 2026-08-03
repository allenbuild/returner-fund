-- Timeline evidence is only valid when its source is explicitly attributed as
-- a subject of the event's exact primary company. This migration is additive:
-- it supersedes the cross-table guards from 017-019 without rewriting applied
-- migration history.

-- Freeze the six attribution surfaces for the duration of this migration.
-- Without this lock, a concurrent ingestion/admin write could land between the
-- legacy-data audit and trigger installation. SHARE ROW EXCLUSIVE still permits
-- reads while blocking ordinary INSERT/UPDATE/DELETE writers until commit.
lock table public.timeline_events,
  public.timeline_event_entities,
  public.timeline_event_evidence,
  public.source_documents,
  public.source_document_entities,
  public.timeline_event_posts,
  public.evidence_attributions
in share row exclusive mode;

create or replace function public.assert_timeline_source_company_subject(
  target_source_document_id uuid,
  target_company_id uuid
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.source_document_entities as subject
    where subject.source_document_id = target_source_document_id
      and subject.company_id = target_company_id
      and subject.founder_id is null
      and subject.relationship_type = 'subject'
  ) then
    raise exception 'timeline source document % must be attributed as a subject of company %',
      target_source_document_id, target_company_id;
  end if;
end;
$$;

create or replace function public.assert_timeline_event_evidence_company_subject(
  target_event_id uuid,
  target_source_document_id uuid
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_company_id uuid;
begin
  select event.primary_company_id
  into target_company_id
  from public.timeline_events as event
  where event.id = target_event_id;

  if target_company_id is null then
    raise exception 'timeline event % was not found while validating evidence attribution',
      target_event_id;
  end if;
  perform public.assert_timeline_source_company_subject(
    target_source_document_id,
    target_company_id
  );
end;
$$;

create or replace function public.guard_timeline_event_evidence_company_subject()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform public.assert_timeline_event_evidence_company_subject(
    new.event_id,
    new.source_document_id
  );
  return new;
end;
$$;

-- Canonical post evidence uses evidence_attributions rather than
-- source_document_entities. Keep the 019 public signature for existing
-- triggers, and expose an explicit-company helper for primary-company changes.
create or replace function public.assert_timeline_post_company_attribution_for_company(
  target_evidence_id uuid,
  target_company_id uuid
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.evidence_attributions as attribution
    where attribution.evidence_id = target_evidence_id
      and attribution.company_id = target_company_id
      and attribution.entity_type = 'company'
      and attribution.review_state = 'verified'
  ) then
    raise exception 'timeline post evidence % requires a verified attribution to company %',
      target_evidence_id, target_company_id;
  end if;
end;
$$;

create or replace function public.assert_timeline_event_post_company_attribution(
  target_event_id uuid,
  target_evidence_id uuid
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_company_id uuid;
begin
  select event.primary_company_id
  into target_company_id
  from public.timeline_events as event
  where event.id = target_event_id;

  if target_company_id is null then
    raise exception 'timeline event % was not found while validating post attribution',
      target_event_id;
  end if;
  perform public.assert_timeline_post_company_attribution_for_company(
    target_evidence_id,
    target_company_id
  );
end;
$$;

create or replace function public.assert_timeline_event_primary_entity_company(
  target_event_id uuid,
  target_company_id uuid
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  primary_entity_count integer;
  matching_primary_entity_count integer;
begin
  -- Event deletion may cascade through entity rows. There is no surviving
  -- identity to validate in that case.
  if not exists (
    select 1 from public.timeline_events as event where event.id = target_event_id
  ) then
    return;
  end if;

  select
    count(*) filter (where entity.is_primary),
    count(*) filter (
      where entity.is_primary
        and entity.entity_type = 'company'
        and entity.company_id = target_company_id
        and entity.founder_id is null
        and entity.external_entity_name is null
        and entity.relationship_type = 'subject'
    )
  into primary_entity_count, matching_primary_entity_count
  from public.timeline_event_entities as entity
  where entity.event_id = target_event_id;

  if primary_entity_count <> 1 or matching_primary_entity_count <> 1 then
    raise exception 'timeline event % must have exactly one primary entity, the subject company % (primary %, matching %)',
      target_event_id, target_company_id, primary_entity_count, matching_primary_entity_count;
  end if;
end;
$$;

-- Fail the migration closed if pre-existing rows violate any invariant.
-- Nothing is silently reattributed, deleted, or published under another
-- company identity.
do $existing_timeline_entity_attribution$
declare
  invalid_evidence record;
  invalid_post record;
  invalid_primary_entity record;
begin
  select
    event.id as event_id,
    event.primary_company_id,
    count(entity.id) filter (where entity.is_primary) as primary_entity_count,
    count(entity.id) filter (
      where entity.is_primary
        and entity.entity_type = 'company'
        and entity.company_id = event.primary_company_id
        and entity.founder_id is null
        and entity.external_entity_name is null
        and entity.relationship_type = 'subject'
    ) as matching_primary_entity_count
  into invalid_primary_entity
  from public.timeline_events as event
  left join public.timeline_event_entities as entity on entity.event_id = event.id
  group by event.id, event.primary_company_id
  having count(entity.id) filter (where entity.is_primary) <> 1
      or count(entity.id) filter (
        where entity.is_primary
          and entity.entity_type = 'company'
          and entity.company_id = event.primary_company_id
          and entity.founder_id is null
          and entity.external_entity_name is null
          and entity.relationship_type = 'subject'
      ) <> 1
  order by event.id
  limit 1;

  if found then
    raise exception 'existing timeline event % must have exactly one primary subject entity for company % (primary %, matching %)',
      invalid_primary_entity.event_id,
      invalid_primary_entity.primary_company_id,
      invalid_primary_entity.primary_entity_count,
      invalid_primary_entity.matching_primary_entity_count;
  end if;

  select evidence.event_id, evidence.source_document_id
  into invalid_evidence
  from public.timeline_event_evidence as evidence
  join public.timeline_events as event on event.id = evidence.event_id
  where not exists (
    select 1
    from public.source_document_entities as subject
    where subject.source_document_id = evidence.source_document_id
      and subject.company_id = event.primary_company_id
      and subject.founder_id is null
      and subject.relationship_type = 'subject'
  )
  order by evidence.event_id, evidence.source_document_id
  limit 1;

  if found then
    raise exception 'existing timeline event % links source document % without same-company subject attribution',
      invalid_evidence.event_id, invalid_evidence.source_document_id;
  end if;

  select post.event_id, post.evidence_id
  into invalid_post
  from public.timeline_event_posts as post
  join public.timeline_events as event on event.id = post.event_id
  where not exists (
    select 1
    from public.evidence_attributions as attribution
    where attribution.evidence_id = post.evidence_id
      and attribution.company_id = event.primary_company_id
      and attribution.entity_type = 'company'
      and attribution.review_state = 'verified'
  )
  order by post.event_id, post.evidence_id
  limit 1;

  if found then
    raise exception 'existing timeline event % links post evidence % without verified same-company attribution',
      invalid_post.event_id, invalid_post.evidence_id;
  end if;
end
$existing_timeline_entity_attribution$;

-- The deferred trigger below enforces existence. This partial unique index
-- independently makes a second primary row impossible under concurrency.
create unique index if not exists timeline_event_entities_one_primary_idx
  on public.timeline_event_entities (event_id)
  where is_primary;

drop trigger if exists timeline_event_evidence_company_subject_guard
  on public.timeline_event_evidence;
create trigger timeline_event_evidence_company_subject_guard
before insert or update of event_id, source_document_id
on public.timeline_event_evidence
for each row execute function public.guard_timeline_event_evidence_company_subject();

-- A subject link cannot be deleted or rekeyed away while Timeline evidence
-- still relies on it. Revalidate both OLD and NEW source identities so an
-- UPDATE cannot hide the loss of attribution on its old key.
create or replace function public.revalidate_timeline_evidence_after_subject_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  affected_source_ids uuid[];
  linked_evidence record;
begin
  if tg_op = 'DELETE' then
    affected_source_ids := array[old.source_document_id];
  else
    affected_source_ids := array[old.source_document_id, new.source_document_id];
  end if;

  for linked_evidence in
    select distinct evidence.event_id, evidence.source_document_id
    from public.timeline_event_evidence as evidence
    where evidence.source_document_id = any(affected_source_ids)
    order by evidence.event_id, evidence.source_document_id
  loop
    perform public.assert_timeline_event_evidence_company_subject(
      linked_evidence.event_id,
      linked_evidence.source_document_id
    );
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists timeline_evidence_revalidate_subject_attribution
  on public.source_document_entities;
create constraint trigger timeline_evidence_revalidate_subject_attribution
after delete or update of source_document_id, company_id, founder_id, relationship_type
on public.source_document_entities
deferrable initially immediate
for each row execute function public.revalidate_timeline_evidence_after_subject_mutation();

-- Supersede 019's single-key revalidation. An evidence attribution UPDATE can
-- rekey evidence_id; both the old evidence (which lost attribution) and the new
-- evidence (which gained it) must be checked against every linked event.
create or replace function public.revalidate_timeline_posts_after_attribution_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  affected_evidence_ids uuid[];
  affected_evidence_id uuid;
  linked_event_id uuid;
begin
  if tg_op = 'DELETE' then
    affected_evidence_ids := array[old.evidence_id];
  else
    affected_evidence_ids := array[old.evidence_id, new.evidence_id];
  end if;

  for affected_evidence_id in
    select distinct evidence_id
    from unnest(affected_evidence_ids) as affected(evidence_id)
    where evidence_id is not null
    order by evidence_id
  loop
    for linked_event_id in
      select post.event_id
      from public.timeline_event_posts as post
      where post.evidence_id = affected_evidence_id
      order by post.event_id
    loop
      perform public.assert_timeline_event_post_company_attribution(
        linked_event_id,
        affected_evidence_id
      );
    end loop;
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists timeline_event_posts_revalidate_attribution
  on public.evidence_attributions;
create constraint trigger timeline_event_posts_revalidate_attribution
after delete or update of evidence_id, company_id, entity_type, review_state
on public.evidence_attributions
deferrable initially immediate
for each row execute function public.revalidate_timeline_posts_after_attribution_mutation();

-- Changing an event's primary company must not strand source or post evidence
-- under the old identity. This explicit-company guard runs before the event row
-- changes, so it validates against NEW.primary_company_id rather than querying
-- the still-visible OLD row as the 019 wrapper would.
create or replace function public.guard_timeline_event_primary_company_change()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  linked_evidence record;
  linked_post record;
begin
  if old.primary_company_id is not distinct from new.primary_company_id then
    return new;
  end if;

  -- The service-only reassignment helper defers the entity constraint, updates
  -- the sole primary entity first, and then reaches this guard. Direct callers
  -- must never leave an OLD-company primary row behind.
  perform public.assert_timeline_event_primary_entity_company(
    new.id,
    new.primary_company_id
  );

  for linked_evidence in
    select evidence.source_document_id
    from public.timeline_event_evidence as evidence
    where evidence.event_id = new.id
    order by evidence.source_document_id
  loop
    perform public.assert_timeline_source_company_subject(
      linked_evidence.source_document_id,
      new.primary_company_id
    );
  end loop;

  for linked_post in
    select post.evidence_id
    from public.timeline_event_posts as post
    where post.event_id = new.id
    order by post.evidence_id
  loop
    perform public.assert_timeline_post_company_attribution_for_company(
      linked_post.evidence_id,
      new.primary_company_id
    );
  end loop;

  return new;
end;
$$;

-- Primary entity rows cannot be deleted, rekeyed, or inserted for a company
-- different from the event's primary company. Secondary/counterparty entity
-- maintenance remains independent.
create or replace function public.revalidate_timeline_primary_entity_after_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  affected_event_id uuid;
  target_company_id uuid;
  affected_event_ids uuid[];
  touches_primary boolean;
begin
  if tg_op = 'INSERT' then
    affected_event_ids := array[new.event_id];
    touches_primary := new.is_primary;
  elsif tg_op = 'DELETE' then
    affected_event_ids := array[old.event_id];
    touches_primary := old.is_primary;
  else
    affected_event_ids := array[old.event_id, new.event_id];
    touches_primary := old.is_primary or new.is_primary;
  end if;

  if not touches_primary then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  for affected_event_id in
    select distinct event_id
    from unnest(affected_event_ids) as affected(event_id)
    where event_id is not null
    order by event_id
  loop
    select event.primary_company_id
    into target_company_id
    from public.timeline_events as event
    where event.id = affected_event_id;
    if found then
      perform public.assert_timeline_event_primary_entity_company(
        affected_event_id,
        target_company_id
      );
    end if;
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists timeline_event_entities_primary_company_guard
  on public.timeline_event_entities;
create constraint trigger timeline_event_entities_primary_company_guard
after insert or delete or update of event_id, entity_type, company_id, founder_id,
  external_entity_name, relationship_type, is_primary
on public.timeline_event_entities
deferrable initially immediate
for each row execute function public.revalidate_timeline_primary_entity_after_mutation();

-- Existing ingestion writes the event and then probes/inserts its subject link
-- in a later request, while atomic admin split/candidate paths may only insert
-- the event. Seed the deterministic primary subject in the event statement so
-- all writers observe the invariant without a cross-request transaction.
create or replace function public.seed_timeline_event_primary_entity()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.timeline_event_entities (
    event_id,
    entity_type,
    company_id,
    founder_id,
    external_entity_name,
    relationship_type,
    is_primary
  ) values (
    new.id,
    'company',
    new.primary_company_id,
    null,
    null,
    'subject',
    true
  );
  return new;
end;
$$;

drop trigger if exists timeline_events_seed_primary_entity
  on public.timeline_events;
create trigger timeline_events_seed_primary_entity
after insert
on public.timeline_events
for each row execute function public.seed_timeline_event_primary_entity();

-- The deferred event-row check independently guarantees presence at the end
-- of every transaction. Entity-row mutations stay immediate by default so
-- deleting or corrupting a primary fails promptly.
create or replace function public.revalidate_timeline_primary_entity_after_event_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform public.assert_timeline_event_primary_entity_company(
    new.id,
    new.primary_company_id
  );
  return new;
end;
$$;

drop trigger if exists timeline_events_primary_entity_required
  on public.timeline_events;
create constraint trigger timeline_events_primary_entity_required
after insert or update of primary_company_id
on public.timeline_events
deferrable initially deferred
for each row execute function public.revalidate_timeline_primary_entity_after_event_mutation();

drop trigger if exists timeline_events_primary_company_attribution_guard
  on public.timeline_events;
create trigger timeline_events_primary_company_attribution_guard
before update of primary_company_id
on public.timeline_events
for each row execute function public.guard_timeline_event_primary_company_change();

-- Reassigning the primary company is an atomic, service-only operation. The
-- caller must first attach every source and canonical post to the destination
-- company. This function then defers only the immediate entity guard, updates
-- the sole entity row before the event row, lets the existing source/post and
-- publication guards validate the destination, and restores immediate mode.
-- That order removes the otherwise unavoidable transient OLD/NEW mismatch.
create or replace function public.reassign_timeline_event_primary_company(
  target_event_id uuid,
  target_company_id uuid
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_company_id uuid;
  updated_primary_rows integer;
begin
  if target_company_id is null then
    raise exception 'timeline event primary company cannot be null';
  end if;

  select event.primary_company_id
  into current_company_id
  from public.timeline_events as event
  where event.id = target_event_id
  for update;

  if not found then
    raise exception 'timeline event % was not found for primary-company reassignment',
      target_event_id;
  end if;

  if current_company_id = target_company_id then
    perform public.assert_timeline_event_primary_entity_company(
      target_event_id,
      target_company_id
    );
    return;
  end if;

  perform 1
  from public.companies as company
  where company.id = target_company_id;
  if not found then
    raise exception 'timeline destination company % was not found',
      target_company_id;
  end if;

  set constraints timeline_event_entities_primary_company_guard deferred;

  update public.timeline_event_entities
  set entity_type = 'company',
      company_id = target_company_id,
      founder_id = null,
      external_entity_name = null,
      relationship_type = 'subject',
      is_primary = true
  where event_id = target_event_id
    and is_primary;
  get diagnostics updated_primary_rows = row_count;

  if updated_primary_rows <> 1 then
    raise exception 'timeline event % must have exactly one primary entity before reassignment (updated %)',
      target_event_id, updated_primary_rows;
  end if;

  update public.timeline_events
  set primary_company_id = target_company_id,
      last_updated_at = now()
  where id = target_event_id;

  perform public.assert_timeline_event_primary_entity_company(
    target_event_id,
    target_company_id
  );
  set constraints timeline_event_entities_primary_company_guard immediate;
end;
$$;

-- Centralize the exact-date/title/summary publication predicate and include
-- the same-company subject attribution. Both publication and subsequent
-- evidence/source mutations call this predicate.
create or replace function public.timeline_event_has_publishable_company_evidence(
  target_event_id uuid,
  target_company_id uuid,
  target_title text,
  target_summary text,
  target_event_date date,
  target_event_date_type text
)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.timeline_event_evidence as evidence
    join public.source_documents as source
      on source.id = evidence.source_document_id
    join public.source_document_entities as subject
      on subject.source_document_id = evidence.source_document_id
     and subject.company_id = target_company_id
     and subject.founder_id is null
     and subject.relationship_type = 'subject'
    where evidence.event_id = target_event_id
      and evidence.evidence_role in ('primary', 'supporting')
      and not evidence.is_conflicting
      and evidence.supports_event_date
      and evidence.supports_title
      and evidence.supports_summary
      and trim(coalesce(evidence.extracted_claims ->> 'title', '')) = trim(target_title)
      and trim(coalesce(evidence.extracted_claims ->> 'summary', '')) = trim(target_summary)
      and source.attribution_status = 'verified'
      and source.canonical_url ~* '^https?://'
      and (
        evidence.source_event_date = target_event_date
        or (
          target_event_date_type in ('announcement_date', 'publication_date')
          and source.published_at is not null
          and (source.published_at at time zone 'UTC')::date = target_event_date
        )
      )
  );
$$;

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

    if not public.timeline_event_has_publishable_company_evidence(
      new.id,
      new.primary_company_id,
      new.title,
      new.summary,
      new.event_date,
      new.event_date_type
    ) then
      raise exception 'timeline event % cannot be published without verified same-company direct evidence supporting its exact date, title, and summary',
        new.id;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.assert_published_timeline_event_has_evidence(
  target_event_id uuid
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_event public.timeline_events%rowtype;
begin
  select event.*
  into target_event
  from public.timeline_events as event
  where event.id = target_event_id;

  -- Cascading event deletion leaves nothing public to revalidate.
  if not found or target_event.status <> 'published' then
    return;
  end if;

  if not public.timeline_event_has_publishable_company_evidence(
    target_event.id,
    target_event.primary_company_id,
    target_event.title,
    target_event.summary,
    target_event.event_date,
    target_event.event_date_type
  ) then
    raise exception 'published timeline event % must retain verified same-company direct evidence supporting its exact date, title, and summary',
      target_event_id;
  end if;
end;
$$;

drop trigger if exists timeline_events_publication_guard on public.timeline_events;
create trigger timeline_events_publication_guard
before insert or update of status, published_at, title, summary, event_date,
  event_date_type, category, primary_company_id
on public.timeline_events
for each row execute function public.guard_timeline_event_publication();

-- Verify every currently published event under the strengthened predicate.
do $same_company_publication_backfill$
declare
  published_event_id uuid;
begin
  for published_event_id in
    select event.id
    from public.timeline_events as event
    where event.status = 'published'
    order by event.id
  loop
    perform public.assert_published_timeline_event_has_evidence(published_event_id);
  end loop;
end
$same_company_publication_backfill$;

-- Public source metadata is fail-closed even if a privileged actor disables a
-- trigger or legacy data pre-dates the invariant: the view independently joins
-- the event's exact primary company subject attribution.
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
from public.source_documents as source
join public.timeline_event_evidence as evidence
  on evidence.source_document_id = source.id
join public.timeline_events as event
  on event.id = evidence.event_id
join public.source_document_entities as subject
  on subject.source_document_id = source.id
 and subject.company_id = event.primary_company_id
 and subject.founder_id is null
 and subject.relationship_type = 'subject'
where event.status = 'published'
  and event.published_at is not null
  and evidence.evidence_role <> 'discovery_only'
  and source.attribution_status = 'verified';

revoke all privileges on table public.published_timeline_source_metadata from public;
grant select on table public.published_timeline_source_metadata
  to anon, authenticated, service_role;

revoke all privileges on function public.assert_timeline_source_company_subject(uuid, uuid)
  from public, anon, authenticated;
revoke all privileges on function public.assert_timeline_event_evidence_company_subject(uuid, uuid)
  from public, anon, authenticated;
revoke all privileges on function public.guard_timeline_event_evidence_company_subject()
  from public, anon, authenticated;
revoke all privileges on function public.assert_timeline_post_company_attribution_for_company(uuid, uuid)
  from public, anon, authenticated;
revoke all privileges on function public.assert_timeline_event_post_company_attribution(uuid, uuid)
  from public, anon, authenticated;
revoke all privileges on function public.assert_timeline_event_primary_entity_company(uuid, uuid)
  from public, anon, authenticated;
revoke all privileges on function public.revalidate_timeline_evidence_after_subject_mutation()
  from public, anon, authenticated;
revoke all privileges on function public.revalidate_timeline_posts_after_attribution_mutation()
  from public, anon, authenticated;
revoke all privileges on function public.guard_timeline_event_primary_company_change()
  from public, anon, authenticated;
revoke all privileges on function public.revalidate_timeline_primary_entity_after_mutation()
  from public, anon, authenticated;
revoke all privileges on function public.seed_timeline_event_primary_entity()
  from public, anon, authenticated;
revoke all privileges on function public.revalidate_timeline_primary_entity_after_event_mutation()
  from public, anon, authenticated;
revoke all privileges on function public.reassign_timeline_event_primary_company(uuid, uuid)
  from public, anon, authenticated;
revoke all privileges on function public.timeline_event_has_publishable_company_evidence(uuid, uuid, text, text, date, text)
  from public, anon, authenticated;
revoke all privileges on function public.guard_timeline_event_publication()
  from public, anon, authenticated;
revoke all privileges on function public.assert_published_timeline_event_has_evidence(uuid)
  from public, anon, authenticated;

grant execute on function public.assert_timeline_source_company_subject(uuid, uuid)
  to service_role;
grant execute on function public.assert_timeline_event_evidence_company_subject(uuid, uuid)
  to service_role;
grant execute on function public.guard_timeline_event_evidence_company_subject()
  to service_role;
grant execute on function public.assert_timeline_post_company_attribution_for_company(uuid, uuid)
  to service_role;
grant execute on function public.assert_timeline_event_post_company_attribution(uuid, uuid)
  to service_role;
grant execute on function public.assert_timeline_event_primary_entity_company(uuid, uuid)
  to service_role;
grant execute on function public.revalidate_timeline_evidence_after_subject_mutation()
  to service_role;
grant execute on function public.revalidate_timeline_posts_after_attribution_mutation()
  to service_role;
grant execute on function public.guard_timeline_event_primary_company_change()
  to service_role;
grant execute on function public.revalidate_timeline_primary_entity_after_mutation()
  to service_role;
grant execute on function public.seed_timeline_event_primary_entity()
  to service_role;
grant execute on function public.revalidate_timeline_primary_entity_after_event_mutation()
  to service_role;
grant execute on function public.reassign_timeline_event_primary_company(uuid, uuid)
  to service_role;
grant execute on function public.timeline_event_has_publishable_company_evidence(uuid, uuid, text, text, date, text)
  to service_role;
grant execute on function public.guard_timeline_event_publication()
  to service_role;
grant execute on function public.assert_published_timeline_event_has_evidence(uuid)
  to service_role;

comment on function public.assert_timeline_event_evidence_company_subject(uuid, uuid) is
  'Rejects Timeline source evidence unless the source is a subject of the event primary company; enforced for ingestion and admin attachments.';
comment on function public.guard_timeline_event_primary_company_change() is
  'Prevents changing an event primary company unless every linked source and post is already attributed to the new company.';
comment on function public.seed_timeline_event_primary_entity() is
  'Creates the exactly-one primary subject entity in the same statement as a new Timeline event.';
comment on function public.reassign_timeline_event_primary_company(uuid, uuid) is
  'Atomically rebinds the exactly-one primary subject entity and event company after destination source/post attributions are prepared; service role only.';
comment on view public.published_timeline_source_metadata is
  'Public Timeline source projection restricted to verified sources with same-company subject attribution.';
