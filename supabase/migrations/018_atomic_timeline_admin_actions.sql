-- Every timeline administrator mutation is applied through this single RPC.
-- PostgreSQL functions execute in the caller's transaction, so the domain
-- mutation, immutable audit record, artifact invalidation, and any queued work
-- either all commit or all roll back.

-- Publication is tied to the selected calendar day, not merely to a classifier
-- boolean. An edit cannot move a published event to a day that no verified,
-- non-conflicting direct source supports.
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
      from public.timeline_event_evidence as evidence
      join public.source_documents as source on source.id = evidence.source_document_id
      where evidence.event_id = new.id
        and evidence.evidence_role in ('primary', 'supporting')
        and not evidence.is_conflicting
        and evidence.supports_event_date
        and evidence.supports_title
        and evidence.supports_summary
        and trim(coalesce(evidence.extracted_claims ->> 'title', '')) = trim(new.title)
        and trim(coalesce(evidence.extracted_claims ->> 'summary', '')) = trim(new.summary)
        and source.attribution_status = 'verified'
        and source.canonical_url ~* '^https?://'
        and (
          evidence.source_event_date = new.event_date
          or (
            new.event_date_type in ('announcement_date', 'publication_date')
            and source.published_at is not null
            and (source.published_at at time zone 'UTC')::date = new.event_date
          )
        )
    ) then
      raise exception 'timeline event % cannot be published without verified direct evidence supporting its exact date, title, and summary', new.id;
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
  from public.timeline_events as event
  where event.id = target_event_id;

  if not coalesce(target_is_published, false) then
    return;
  end if;

  if not exists (
    select 1
    from public.timeline_events as event
    join public.timeline_event_evidence as evidence on evidence.event_id = event.id
    join public.source_documents as source on source.id = evidence.source_document_id
    where event.id = target_event_id
      and evidence.evidence_role in ('primary', 'supporting')
      and not evidence.is_conflicting
      and evidence.supports_event_date
      and evidence.supports_title
      and evidence.supports_summary
      and trim(coalesce(evidence.extracted_claims ->> 'title', '')) = trim(event.title)
      and trim(coalesce(evidence.extracted_claims ->> 'summary', '')) = trim(event.summary)
      and source.attribution_status = 'verified'
      and source.canonical_url ~* '^https?://'
      and (
        evidence.source_event_date = event.event_date
        or (
          event.event_date_type in ('announcement_date', 'publication_date')
          and source.published_at is not null
          and (source.published_at at time zone 'UTC')::date = event.event_date
        )
      )
  ) then
    raise exception 'published timeline event % must retain verified direct evidence supporting its exact date, title, and summary', target_event_id;
  end if;
end;
$$;

-- Re-run the exact-date assertion whenever either representation of the
-- supported day changes. The earlier migration already covered attribution
-- and support flags; this extends those triggers without editing history.
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
      and old.canonical_url is not distinct from new.canonical_url
      and old.published_at is not distinct from new.published_at then
    return new;
  end if;

  for affected_event_id in
    select distinct evidence.event_id
    from public.timeline_event_evidence as evidence
    where evidence.source_document_id = new.id
  loop
    perform public.assert_published_timeline_event_has_evidence(affected_event_id);
  end loop;
  return new;
end;
$$;

drop trigger if exists timeline_event_evidence_revalidate_publication on public.timeline_event_evidence;
create trigger timeline_event_evidence_revalidate_publication
after delete or update of event_id, source_document_id, evidence_role,
  supports_event_date, supports_title, supports_summary, source_event_date,
  is_conflicting
on public.timeline_event_evidence
for each row execute function public.revalidate_timeline_event_after_evidence_mutation();

drop trigger if exists source_documents_revalidate_timeline_publication on public.source_documents;
create trigger source_documents_revalidate_timeline_publication
after update of attribution_status, canonical_url, published_at
on public.source_documents
for each row execute function public.revalidate_timeline_events_after_source_mutation();

do $exact_date_backfill$
declare
  published_event_id uuid;
begin
  for published_event_id in
    select id from public.timeline_events where status = 'published' order by id
  loop
    perform public.assert_published_timeline_event_has_evidence(published_event_id);
  end loop;
end
$exact_date_backfill$;

-- Conflict visibility is evidence-driven. Evidence mutations recompute both
-- sides of an event move, while direct event flag edits are canonicalized back
-- to the linked evidence state. This makes has_conflict true iff at least one
-- linked evidence row is explicitly conflicting.
create or replace function public.synchronize_timeline_event_conflict_state(
  target_event_id uuid,
  preserve_existing_summary boolean
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  linked_conflict boolean;
  linked_summary text;
begin
  if target_event_id is null then
    return;
  end if;
  select exists (
    select 1
    from public.timeline_event_evidence as evidence
    where evidence.event_id = target_event_id and evidence.is_conflicting
  ), (
    select string_agg(
      left(coalesce(nullif(trim(evidence.conflict_description), ''), 'Linked source contains a conflicting claim.'), 500),
      ' | ' order by evidence.id
    )
    from public.timeline_event_evidence as evidence
    where evidence.event_id = target_event_id and evidence.is_conflicting
  ) into linked_conflict, linked_summary;

  update public.timeline_events as event
  set has_conflict = linked_conflict,
      conflict_summary = case
        when not linked_conflict then null
        when preserve_existing_summary
          then coalesce(nullif(trim(event.conflict_summary), ''), linked_summary, 'Linked evidence contains a conflicting claim.')
        else coalesce(linked_summary, 'Linked evidence contains a conflicting claim.')
      end,
      last_updated_at = clock_timestamp()
  where event.id = target_event_id
    and (
      event.has_conflict is distinct from linked_conflict
      or (not linked_conflict and event.conflict_summary is not null)
      or (linked_conflict and event.conflict_summary is null)
      or (linked_conflict and not preserve_existing_summary and event.conflict_summary is distinct from linked_summary)
    );
end;
$$;

create or replace function public.sync_timeline_conflict_after_evidence_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.synchronize_timeline_event_conflict_state(old.event_id, false);
    return old;
  end if;
  if tg_op = 'UPDATE' and old.event_id is distinct from new.event_id then
    perform public.synchronize_timeline_event_conflict_state(old.event_id, false);
  end if;
  perform public.synchronize_timeline_event_conflict_state(new.event_id, false);
  return new;
end;
$$;

create or replace function public.sync_timeline_conflict_after_event_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform public.synchronize_timeline_event_conflict_state(new.id, true);
  return new;
end;
$$;

drop trigger if exists timeline_event_evidence_sync_conflict on public.timeline_event_evidence;
create trigger timeline_event_evidence_sync_conflict
after insert or delete or update of event_id, evidence_role, is_conflicting, conflict_description
on public.timeline_event_evidence
for each row execute function public.sync_timeline_conflict_after_evidence_mutation();

drop trigger if exists timeline_events_sync_conflict on public.timeline_events;
create trigger timeline_events_sync_conflict
after insert or update of has_conflict, conflict_summary
on public.timeline_events
for each row execute function public.sync_timeline_conflict_after_event_mutation();

do $conflict_backfill$
declare
  target_event_id uuid;
begin
  for target_event_id in select id from public.timeline_events order by id
  loop
    perform public.synchronize_timeline_event_conflict_state(target_event_id, false);
  end loop;
end
$conflict_backfill$;

revoke all on function public.synchronize_timeline_event_conflict_state(uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.sync_timeline_conflict_after_evidence_mutation()
  from public, anon, authenticated;
revoke all on function public.sync_timeline_conflict_after_event_mutation()
  from public, anon, authenticated;
grant execute on function public.synchronize_timeline_event_conflict_state(uuid, boolean)
  to service_role;
grant execute on function public.sync_timeline_conflict_after_evidence_mutation()
  to service_role;
grant execute on function public.sync_timeline_conflict_after_event_mutation()
  to service_role;

create or replace function public.apply_timeline_admin_action(
  p_scope text,
  p_action jsonb,
  p_actor jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_type text;
  v_actor_id text;
  v_actor_email text;
  v_reason text;
  v_event_id uuid;
  v_candidate_id uuid;
  v_target_event_id uuid;
  v_source_document_id uuid;
  v_source_evidence_id uuid;
  v_new_event_id uuid;
  v_company_id uuid;
  v_audit_id uuid;
  v_event public.timeline_events%rowtype;
  v_candidate public.timeline_event_candidates%rowtype;
  v_company public.companies%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_payload jsonb;
  v_patch jsonb;
  v_claim jsonb;
  v_supports jsonb;
  v_event_key text;
  v_checkpoint text;
  v_source_classes text[];
  v_source_class text;
  v_ids uuid[];
  v_count integer;
  v_total integer;
  v_affected uuid[] := '{}'::uuid[];
  v_link record;
  v_has_conflict boolean;
begin
  if p_scope not in ('event', 'candidate', 'company') then
    raise exception 'unsupported timeline admin scope: %', coalesce(p_scope, '<null>')
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_action) <> 'object' then
    raise exception 'timeline admin action must be a JSON object' using errcode = '22023';
  end if;
  if jsonb_typeof(p_actor) <> 'object' then
    raise exception 'timeline admin actor must be a JSON object' using errcode = '22023';
  end if;

  v_type := nullif(trim(p_action ->> 'type'), '');
  v_actor_id := nullif(trim(p_actor ->> 'id'), '');
  v_actor_email := nullif(trim(p_actor ->> 'email'), '');
  if v_type is null or v_type !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'timeline admin action type is invalid' using errcode = '22023';
  end if;
  if v_actor_id is null or length(v_actor_id) > 200 then
    raise exception 'timeline admin actor id is invalid' using errcode = '22023';
  end if;
  if v_actor_email is not null and length(v_actor_email) > 320 then
    raise exception 'timeline admin actor email is invalid' using errcode = '22023';
  end if;

  if p_scope in ('event', 'candidate') then
    v_reason := nullif(trim(p_action ->> 'reason'), '');
    if v_reason is null or length(v_reason) not between 3 and 1000 then
      raise exception 'timeline admin reason must contain 3 to 1000 characters'
        using errcode = '22023';
    end if;
  end if;

  if p_scope = 'event' then
    begin
      v_event_id := nullif(p_action ->> 'eventId', '')::uuid;
    exception when invalid_text_representation then
      raise exception 'timeline event id must be a UUID' using errcode = '22023';
    end;
    if v_event_id is null then
      raise exception 'timeline event id is required' using errcode = '22023';
    end if;

    select event.* into v_event
    from public.timeline_events as event
    where event.id = v_event_id
    for update;
    if not found then
      raise exception 'timeline event % was not found', v_event_id using errcode = 'P0002';
    end if;
    if v_event.status in ('merged', 'superseded') then
      raise exception 'superseded or merged timeline events cannot be mutated'
        using errcode = '22023';
    end if;

    v_company_id := v_event.primary_company_id;
    v_before := to_jsonb(v_event);
    v_affected := array[v_event_id];

    case v_type
      when 'publish' then
        if v_event.status not in ('candidate', 'needs_review') then
          raise exception 'only candidate or needs-review events can be published'
            using errcode = '22023';
        end if;
        update public.timeline_events
        set status = 'published', published_at = clock_timestamp(), last_updated_at = clock_timestamp()
        where id = v_event_id
        returning * into v_event;

      when 'reject' then
        update public.timeline_events
        set status = 'rejected', published_at = null, last_updated_at = clock_timestamp()
        where id = v_event_id
        returning * into v_event;

      when 'unpublish' then
        if v_event.status <> 'published' then
          raise exception 'only published events can be unpublished' using errcode = '22023';
        end if;
        update public.timeline_events
        set status = 'needs_review', published_at = null, last_updated_at = clock_timestamp()
        where id = v_event_id
        returning * into v_event;

      when 're_evaluate' then
        select company.* into v_company
        from public.companies as company
        where company.id = v_company_id;
        if not found then
          raise exception 'timeline event company was not found' using errcode = 'P0002';
        end if;
        -- Force the durable sources already associated with this event back
        -- through classification. Accepted/rejected candidates are otherwise
        -- intentionally idempotent and would be skipped by the worker.
        update public.timeline_event_candidates as candidate
        set status = 'processing', rejection_reason = null, updated_at = clock_timestamp()
        where candidate.company_id = v_company_id
          and exists (
            select 1
            from public.timeline_candidate_sources as candidate_source
            join public.timeline_event_evidence as event_evidence
              on event_evidence.source_document_id = candidate_source.source_document_id
            where candidate_source.candidate_id = candidate.id
              and event_evidence.event_id = v_event_id
          );
        v_source_class := 'timeline_reconcile_publish';
        v_checkpoint := format('timeline:re_evaluate:event:%s:%s', v_event_id, v_source_class);
        insert into public.ingestion_tasks as existing_task (
          ingestion_run_id, batch_id, entity_type, entity_id, company_name,
          platform, status, attempts, checkpoint_key, rate_limit_ms,
          max_attempts, priority, next_attempt_at, terminal_at, terminal_reason,
          last_error, last_error_json, last_failure_kind, locked_by, locked_at,
          lease_token, lease_expires_at
        ) values (
          null, v_company.batch_id, 'company', v_company.id, v_company.name,
          v_source_class, 'queued', 0, v_checkpoint, 0,
          3, 75, null, null, null,
          null, '{}'::jsonb, null, null, null,
          null, null
        )
        on conflict (checkpoint_key) do update set
          ingestion_run_id = excluded.ingestion_run_id,
          batch_id = excluded.batch_id,
          entity_type = excluded.entity_type,
          entity_id = excluded.entity_id,
          company_name = excluded.company_name,
          platform = excluded.platform,
          status = 'queued',
          attempts = 0,
          rate_limit_ms = excluded.rate_limit_ms,
          max_attempts = excluded.max_attempts,
          priority = excluded.priority,
          next_attempt_at = null,
          last_attempt_at = null,
          terminal_at = null,
          terminal_reason = null,
          last_error = null,
          last_error_json = '{}'::jsonb,
          last_failure_kind = null,
          locked_by = null,
          locked_at = null,
          lease_token = null,
          lease_expires_at = null,
          updated_at = clock_timestamp()
        where existing_task.status <> 'running'
          or existing_task.lease_expires_at is null
          or existing_task.lease_expires_at <= clock_timestamp();

        update public.ingestion_dead_letters as dead_letter
        set status = 'requeued', resolved_at = clock_timestamp(),
            resolution_note = 'Requeued by Timeline administrator action.',
            updated_at = clock_timestamp()
        from public.ingestion_tasks as task
        where task.checkpoint_key = v_checkpoint
          and task.status = 'queued'
          and dead_letter.ingestion_task_id = task.id
          and dead_letter.status = 'open';

      when 'edit' then
        v_patch := p_action -> 'patch';
        if jsonb_typeof(v_patch) <> 'object' or v_patch = '{}'::jsonb then
          raise exception 'timeline event edit patch must be a non-empty object'
            using errcode = '22023';
        end if;
        if exists (
          select 1 from jsonb_object_keys(v_patch) as field(key)
          where field.key not in ('title', 'summary', 'category', 'eventDate', 'eventDateType', 'isMajor')
        ) then
          raise exception 'timeline event edit patch contains an unsupported field'
            using errcode = '22023';
        end if;
        if v_patch ? 'title' and (
          jsonb_typeof(v_patch -> 'title') <> 'string'
          or length(trim(v_patch ->> 'title')) not between 3 and 180
        ) then
          raise exception 'timeline event title must contain 3 to 180 characters'
            using errcode = '22023';
        end if;
        if v_patch ? 'summary' and (
          jsonb_typeof(v_patch -> 'summary') <> 'string'
          or length(trim(v_patch ->> 'summary')) not between 8 and 500
        ) then
          raise exception 'timeline event summary must contain 8 to 500 characters'
            using errcode = '22023';
        end if;
        if v_patch ? 'category' and (v_patch ->> 'category') not in (
          'founded', 'accelerator', 'funding', 'product_launch', 'product_update',
          'traction_milestone', 'revenue_milestone', 'user_milestone', 'customer',
          'partnership', 'pricing', 'business_model', 'hiring', 'leadership',
          'founder', 'geographic_expansion', 'open_source', 'github', 'research',
          'patent', 'regulatory', 'legal', 'press', 'award', 'acquisition', 'merger',
          'exit', 'pivot', 'shutdown', 'website', 'other'
        ) then
          raise exception 'timeline event category is invalid' using errcode = '22023';
        end if;
        if v_patch ? 'eventDateType' and (v_patch ->> 'eventDateType') not in (
          'occurrence_date', 'announcement_date', 'publication_date'
        ) then
          raise exception 'timeline event date type is invalid' using errcode = '22023';
        end if;
        if v_patch ? 'eventDate' then
          if jsonb_typeof(v_patch -> 'eventDate') <> 'string'
             or (v_patch ->> 'eventDate') !~ '^\d{4}-\d{2}-\d{2}$' then
            raise exception 'timeline event date must be an exact ISO date'
              using errcode = '22023';
          end if;
          begin
            perform (v_patch ->> 'eventDate')::date;
          exception when datetime_field_overflow or invalid_datetime_format then
            raise exception 'timeline event date must be an exact calendar date'
              using errcode = '22023';
          end;
        end if;
        if v_patch ? 'isMajor' and jsonb_typeof(v_patch -> 'isMajor') <> 'boolean' then
          raise exception 'timeline event isMajor must be boolean' using errcode = '22023';
        end if;

        -- A published title/summary correction must remain bound to one exact,
        -- verified direct source. Temporarily removing the public status lets
        -- both sides of the correction change in one transaction. No
        -- intermediate state is externally visible, and the final status
        -- update re-runs the normal publication guard against the corrected
        -- claims.
        if (
          (v_patch ? 'title' and trim(v_patch ->> 'title') is distinct from v_event.title)
          or (v_patch ? 'summary' and trim(v_patch ->> 'summary') is distinct from v_event.summary)
        ) then
          select evidence.id into v_source_evidence_id
          from public.timeline_event_evidence as evidence
          join public.source_documents as source on source.id = evidence.source_document_id
          where evidence.event_id = v_event_id
            and evidence.evidence_role in ('primary', 'supporting')
            and not evidence.is_conflicting
            and evidence.supports_event_date
            and evidence.supports_title
            and evidence.supports_summary
            and trim(coalesce(evidence.extracted_claims ->> 'title', '')) = trim(v_event.title)
            and trim(coalesce(evidence.extracted_claims ->> 'summary', '')) = trim(v_event.summary)
            and source.attribution_status = 'verified'
            and source.canonical_url ~* '^https?://'
            and (
              evidence.source_event_date = case
                when v_patch ? 'eventDate' then (v_patch ->> 'eventDate')::date
                else v_event.event_date
              end
              or (
                (case
                  when v_patch ? 'eventDateType' then v_patch ->> 'eventDateType'
                  else v_event.event_date_type
                end) in ('announcement_date', 'publication_date')
                and source.published_at is not null
                and (source.published_at at time zone 'UTC')::date = case
                  when v_patch ? 'eventDate' then (v_patch ->> 'eventDate')::date
                  else v_event.event_date
                end
              )
            )
          order by case when evidence.evidence_role = 'primary' then 0 else 1 end,
            source.source_quality_tier, evidence.id
          limit 1
          for update of evidence;
          if not found then
            raise exception 'timeline event title or summary correction requires verified direct evidence supporting the selected date and current claims'
              using errcode = '22023';
          end if;

          if v_event.status = 'published' then
            update public.timeline_events
            set status = 'needs_review', last_updated_at = clock_timestamp()
            where id = v_event_id;
          end if;

          update public.timeline_event_evidence as evidence
          set extracted_claims = evidence.extracted_claims || jsonb_build_object(
            'title', case when v_patch ? 'title' then trim(v_patch ->> 'title') else v_event.title end,
            'summary', case when v_patch ? 'summary' then trim(v_patch ->> 'summary') else v_event.summary end,
            'adminClaimCorrection', jsonb_build_object(
              'correctedBy', v_actor_id,
              'correctedAt', clock_timestamp(),
              'reason', v_reason
            )
          )
          where evidence.id = v_source_evidence_id;
        end if;

        update public.timeline_events
        set title = case when v_patch ? 'title' then trim(v_patch ->> 'title') else title end,
            summary = case when v_patch ? 'summary' then trim(v_patch ->> 'summary') else summary end,
            category = case when v_patch ? 'category' then v_patch ->> 'category' else category end,
            event_date = case when v_patch ? 'eventDate' then (v_patch ->> 'eventDate')::date else event_date end,
            event_date_type = case when v_patch ? 'eventDateType' then v_patch ->> 'eventDateType' else event_date_type end,
            is_major = case when v_patch ? 'isMajor' then (v_patch ->> 'isMajor')::boolean else is_major end,
            status = case
              when v_event.status = 'published' and v_source_evidence_id is not null then 'published'
              else status
            end,
            last_updated_at = clock_timestamp()
        where id = v_event_id
        returning * into v_event;

      when 'merge' then
        if v_event.status = 'rejected' then
          raise exception 'a rejected event cannot be a merge target' using errcode = '22023';
        end if;
        if jsonb_typeof(p_action -> 'sourceEventIds') <> 'array'
           or jsonb_array_length(p_action -> 'sourceEventIds') not between 1 and 20 then
          raise exception 'merge requires 1 to 20 source event ids' using errcode = '22023';
        end if;
        begin
          select coalesce(array_agg(value::uuid order by value::uuid), '{}'::uuid[])
          into v_ids
          from jsonb_array_elements_text(p_action -> 'sourceEventIds') as item(value);
        exception when invalid_text_representation then
          raise exception 'every merge source event id must be a UUID' using errcode = '22023';
        end;
        select count(distinct id) into v_count from unnest(v_ids) as source(id);
        if v_count <> cardinality(v_ids) or v_event_id = any(v_ids) then
          raise exception 'merge source events must be unique and differ from the target'
            using errcode = '22023';
        end if;
        perform source.id
        from public.timeline_events as source
        where source.id = any(v_ids)
        order by source.id
        for update;
        select count(*) into v_count
        from public.timeline_events as source
        where source.id = any(v_ids)
          and source.primary_company_id = v_company_id
          and source.status not in ('merged', 'superseded', 'rejected');
        if v_count <> cardinality(v_ids) then
          raise exception 'merge sources must be active events for the same company'
            using errcode = '22023';
        end if;

        insert into public.timeline_event_evidence (
          event_id, source_document_id, evidence_role, supports_event_date,
          supports_title, supports_summary, supports_quantitative_claim,
          evidence_excerpt, extracted_claims, source_event_date, is_conflicting,
          conflict_description
        )
        select v_event_id, evidence.source_document_id, evidence.evidence_role,
          evidence.supports_event_date, evidence.supports_title,
          evidence.supports_summary, evidence.supports_quantitative_claim,
          evidence.evidence_excerpt, evidence.extracted_claims,
          evidence.source_event_date, evidence.is_conflicting,
          evidence.conflict_description
        from public.timeline_event_evidence as evidence
        where evidence.event_id = any(v_ids)
        on conflict (event_id, source_document_id) do nothing;

        insert into public.timeline_event_posts (
          event_id, evidence_id, evidence_role, relevance_reason
        )
        select v_event_id, post.evidence_id, post.evidence_role, post.relevance_reason
        from public.timeline_event_posts as post
        where post.event_id = any(v_ids)
        on conflict (event_id, evidence_id) do nothing;

        insert into public.timeline_event_entities (
          event_id, entity_type, company_id, founder_id, external_entity_name,
          relationship_type, is_primary
        )
        select v_event_id, source.entity_type, source.company_id, source.founder_id,
          source.external_entity_name, source.relationship_type, source.is_primary
        from public.timeline_event_entities as source
        where source.event_id = any(v_ids)
          and not exists (
            select 1 from public.timeline_event_entities as target
            where target.event_id = v_event_id
              and target.entity_type = source.entity_type
              and target.company_id is not distinct from source.company_id
              and target.founder_id is not distinct from source.founder_id
              and target.external_entity_name is not distinct from source.external_entity_name
              and target.relationship_type = source.relationship_type
          );

        update public.timeline_events
        set status = 'merged', published_at = null, last_updated_at = clock_timestamp()
        where id = any(v_ids);
        v_affected := array_prepend(v_event_id, v_ids);

      when 'split' then
        if v_event.status = 'published' then
          raise exception 'published events must be unpublished before splitting evidence'
            using errcode = '22023';
        end if;
        if jsonb_typeof(p_action -> 'evidenceIds') <> 'array'
           or jsonb_array_length(p_action -> 'evidenceIds') not between 1 and 100 then
          raise exception 'split requires 1 to 100 evidence ids' using errcode = '22023';
        end if;
        begin
          select coalesce(array_agg(value::uuid order by value::uuid), '{}'::uuid[])
          into v_ids
          from jsonb_array_elements_text(p_action -> 'evidenceIds') as item(value);
        exception when invalid_text_representation then
          raise exception 'every split evidence id must be a UUID' using errcode = '22023';
        end;
        select count(distinct id) into v_count from unnest(v_ids) as source(id);
        if v_count <> cardinality(v_ids) then
          raise exception 'split evidence ids must be unique' using errcode = '22023';
        end if;
        select count(*) into v_count
        from public.timeline_event_evidence
        where event_id = v_event_id and source_document_id = any(v_ids);
        select count(*) into v_total
        from public.timeline_event_evidence
        where event_id = v_event_id;
        if v_count <> cardinality(v_ids) then
          raise exception 'every split evidence id must belong to the source event'
            using errcode = '22023';
        end if;
        if v_total <= v_count then
          raise exception 'a split must leave at least one evidence source on the original event'
            using errcode = '22023';
        end if;

        v_new_event_id := gen_random_uuid();
        v_event_key := format('%s-split-%s', v_event.event_key, left(v_new_event_id::text, 8));
        select exists (
          select 1 from public.timeline_event_evidence
          where event_id = v_event_id
            and source_document_id = any(v_ids)
            and is_conflicting
        ) into v_has_conflict;
        insert into public.timeline_events (
          id, primary_company_id, category, title, summary, event_date,
          event_date_type, importance_score, is_major, event_key, status,
          has_conflict, conflict_summary, classifier_version, extraction_version,
          first_discovered_at, last_updated_at, published_at
        ) values (
          v_new_event_id, v_event.primary_company_id, v_event.category,
          v_event.title, v_event.summary, v_event.event_date,
          v_event.event_date_type, v_event.importance_score, v_event.is_major,
          v_event_key, 'needs_review', v_has_conflict,
          case when v_has_conflict then v_event.conflict_summary else null end,
          v_event.classifier_version, v_event.extraction_version,
          v_event.first_discovered_at, clock_timestamp(), null
        );
        update public.timeline_event_evidence
        set event_id = v_new_event_id
        where event_id = v_event_id and source_document_id = any(v_ids);
        select exists (
          select 1 from public.timeline_event_evidence
          where event_id = v_event_id and is_conflicting
        ) into v_has_conflict;
        update public.timeline_events
        set has_conflict = v_has_conflict,
            conflict_summary = case when v_has_conflict then conflict_summary else null end,
            last_updated_at = clock_timestamp()
        where id = v_event_id
        returning * into v_event;
        v_affected := array[v_event_id, v_new_event_id];

      when 'add_conflict_note' then
        if nullif(trim(p_action ->> 'note'), '') is null
           or length(trim(p_action ->> 'note')) not between 3 and 2000 then
          raise exception 'conflict note must contain 3 to 2000 characters'
            using errcode = '22023';
        end if;
        if not exists (
          select 1 from public.timeline_event_evidence
          where event_id = v_event_id and is_conflicting
        ) then
          raise exception 'a conflict note requires directly linked conflicting evidence'
            using errcode = '22023';
        end if;
        update public.timeline_events
        set has_conflict = true,
            conflict_summary = trim(p_action ->> 'note'),
            last_updated_at = clock_timestamp()
        where id = v_event_id
        returning * into v_event;

      when 'resolve_conflict' then
        if not v_event.has_conflict then
          raise exception 'only an unresolved conflict can be resolved' using errcode = '22023';
        end if;
        if nullif(trim(p_action ->> 'resolution'), '') is null
           or length(trim(p_action ->> 'resolution')) not between 3 and 2000 then
          raise exception 'conflict resolution must contain 3 to 2000 characters'
            using errcode = '22023';
        end if;
        update public.timeline_event_evidence as evidence
        set evidence_role = 'supporting',
            is_conflicting = false,
            conflict_description = null,
            extracted_claims = evidence.extracted_claims || jsonb_build_object(
              'adminConflictResolution', jsonb_build_object(
                'resolution', trim(p_action ->> 'resolution'),
                'resolvedBy', v_actor_id,
                'resolvedAt', clock_timestamp()
              )
            )
        where evidence.event_id = v_event_id
          and evidence.is_conflicting;
        get diagnostics v_count = row_count;
        if v_count < 1 then
          raise exception 'conflict resolution requires at least one conflicting evidence link'
            using errcode = '22023';
        end if;
        perform public.synchronize_timeline_event_conflict_state(v_event_id, false);

      when 'attach_evidence' then
        begin
          v_source_document_id := nullif(p_action ->> 'sourceDocumentId', '')::uuid;
        exception when invalid_text_representation then
          raise exception 'source document id must be a UUID' using errcode = '22023';
        end;
        if v_source_document_id is null or (p_action ->> 'evidenceRole') not in (
          'primary', 'supporting', 'conflicting'
        ) then
          raise exception 'source document and a valid evidence role are required'
            using errcode = '22023';
        end if;
        if not exists (select 1 from public.source_documents where id = v_source_document_id) then
          raise exception 'source document % was not found', v_source_document_id
            using errcode = 'P0002';
        end if;
        insert into public.timeline_event_evidence (
          event_id, source_document_id, evidence_role, supports_event_date,
          supports_title, supports_summary, supports_quantitative_claim,
          evidence_excerpt, extracted_claims, is_conflicting,
          conflict_description
        ) values (
          v_event_id, v_source_document_id, p_action ->> 'evidenceRole',
          false, false, false, false,
          'Attached by an administrator; claim support requires review.',
          '{}'::jsonb, (p_action ->> 'evidenceRole') = 'conflicting',
          case when (p_action ->> 'evidenceRole') = 'conflicting' then v_reason else null end
        )
        on conflict (event_id, source_document_id) do update set
          evidence_role = excluded.evidence_role,
          supports_event_date = false,
          supports_title = false,
          supports_summary = false,
          supports_quantitative_claim = false,
          evidence_excerpt = excluded.evidence_excerpt,
          extracted_claims = '{}'::jsonb,
          source_event_date = null,
          is_conflicting = excluded.is_conflicting,
          conflict_description = excluded.conflict_description;

      when 'remove_evidence' then
        if v_event.status = 'published' then
          raise exception 'published events must be unpublished before removing evidence'
            using errcode = '22023';
        end if;
        begin
          v_source_document_id := nullif(p_action ->> 'sourceDocumentId', '')::uuid;
        exception when invalid_text_representation then
          raise exception 'source document id must be a UUID' using errcode = '22023';
        end;
        delete from public.timeline_event_evidence
        where event_id = v_event_id and source_document_id = v_source_document_id;
        get diagnostics v_count = row_count;
        if v_count <> 1 then
          raise exception 'the requested evidence source was not attached to this event'
            using errcode = '22023';
        end if;

      else
        raise exception 'unsupported timeline event action: %', v_type using errcode = '22023';
    end case;

    select event.* into v_event from public.timeline_events as event where event.id = v_event_id;
    v_after := jsonb_build_object(
      'event', to_jsonb(v_event),
      'mutation', p_action - 'eventId' - 'reason'
    );
    if v_new_event_id is not null then
      v_after := v_after || jsonb_build_object('newEventId', v_new_event_id);
    end if;
    if v_checkpoint is not null then
      v_after := v_after || jsonb_build_object('checkpoint', v_checkpoint);
    end if;

    insert into public.timeline_artifact_invalidations (company_id, reason)
    values (v_company_id, format('admin:%s', v_type));
    insert into public.timeline_event_audit_log (
      event_id, candidate_id, company_id, actor_id, actor_email,
      action, before_json, after_json, reason
    ) values (
      v_event_id, null, v_company_id, v_actor_id, v_actor_email,
      v_type, v_before, v_after, v_reason
    ) returning id into v_audit_id;

  elsif p_scope = 'candidate' then
    begin
      v_candidate_id := nullif(p_action ->> 'candidateId', '')::uuid;
    exception when invalid_text_representation then
      raise exception 'timeline candidate id must be a UUID' using errcode = '22023';
    end;
    if v_candidate_id is null then
      raise exception 'timeline candidate id is required' using errcode = '22023';
    end if;
    select candidate.* into v_candidate
    from public.timeline_event_candidates as candidate
    where candidate.id = v_candidate_id
    for update;
    if not found then
      raise exception 'timeline candidate % was not found', v_candidate_id using errcode = 'P0002';
    end if;
    if v_candidate.status not in ('pending', 'needs_review') then
      raise exception 'only pending or needs-review candidates can be reviewed'
        using errcode = '22023';
    end if;

    v_company_id := v_candidate.company_id;
    v_before := to_jsonb(v_candidate);
    v_payload := v_candidate.candidate_payload;

    if v_type = 'reject_candidate' then
      update public.timeline_event_candidates
      set status = 'rejected', rejection_reason = v_reason
      where id = v_candidate_id
      returning * into v_candidate;

    elsif v_type in ('publish_candidate', 'merge_candidate') then
      if v_type = 'merge_candidate' then
        begin
          v_target_event_id := nullif(p_action ->> 'targetEventId', '')::uuid;
        exception when invalid_text_representation then
          raise exception 'candidate merge target id must be a UUID' using errcode = '22023';
        end;
        select event.* into v_event
        from public.timeline_events as event
        where event.id = v_target_event_id
        for update;
        if v_event.id is null
           or v_event.primary_company_id <> v_company_id
           or v_event.status in ('merged', 'superseded', 'rejected') then
          raise exception 'candidate merge target must be an active event for the same company'
            using errcode = '22023';
        end if;
      else
        if v_candidate.proposed_event_date is null
           or v_candidate.proposed_event_date_type is null
           or v_candidate.proposed_category is null
           or length(trim(coalesce(v_candidate.proposed_title, ''))) not between 3 and 180
           or length(trim(coalesce(v_candidate.proposed_summary, ''))) not between 8 and 500 then
          raise exception 'candidate publication requires an exact date, date type, category, title, and summary'
            using errcode = '22023';
        end if;
        v_event_key := coalesce(v_candidate.proposed_merge_key, v_payload ->> 'mergeKey');
        if nullif(trim(v_event_key), '') is null or v_event_key <> lower(trim(v_event_key)) then
          raise exception 'candidate publication requires a normalized merge key'
            using errcode = '22023';
        end if;
        v_target_event_id := gen_random_uuid();
        v_has_conflict := case
          when jsonb_typeof(v_payload -> 'conflicts') = 'array'
            then jsonb_array_length(v_payload -> 'conflicts') > 0
          else false
        end;
        insert into public.timeline_events (
          id, primary_company_id, category, title, summary, event_date,
          event_date_type, importance_score, is_major, event_key, status,
          has_conflict, conflict_summary, classifier_version, extraction_version,
          last_updated_at
        ) values (
          v_target_event_id, v_company_id, v_candidate.proposed_category,
          trim(v_candidate.proposed_title), trim(v_candidate.proposed_summary),
          v_candidate.proposed_event_date, v_candidate.proposed_event_date_type,
          coalesce(v_candidate.proposed_importance, 50),
          case when jsonb_typeof(v_payload -> 'isMajor') = 'boolean'
            then (v_payload ->> 'isMajor')::boolean else false end,
          v_event_key, 'needs_review', v_has_conflict,
          case when v_has_conflict then 'Candidate contains conflicting source claims.' else null end,
          v_candidate.classifier_version, v_candidate.extraction_version,
          clock_timestamp()
        );
      end if;

      for v_link in
        select link.source_document_id, link.evidence_role,
          source.metadata_json ->> 'classifierSourceId' as classifier_source_id
        from public.timeline_candidate_sources as link
        join public.source_documents as source on source.id = link.source_document_id
        where link.candidate_id = v_candidate_id
        order by link.source_document_id
      loop
        v_claim := null;
        if jsonb_typeof(v_payload -> 'evidence') = 'array' then
          select evidence.value into v_claim
          from jsonb_array_elements(v_payload -> 'evidence') as evidence(value)
          where jsonb_typeof(evidence.value) = 'object'
            and (
              evidence.value ->> 'sourceDocumentId' = v_link.source_document_id::text
              or v_payload -> 'durableSourceMap' ->> (evidence.value ->> 'sourceId') = v_link.source_document_id::text
              or evidence.value ->> 'sourceId' = v_link.classifier_source_id
              or (
                jsonb_array_length(v_payload -> 'evidence') = 1
                and (
                  select count(*) from public.timeline_candidate_sources
                  where candidate_id = v_candidate_id
                ) = 1
              )
            )
          limit 1;
        end if;
        v_claim := coalesce(v_claim, '{}'::jsonb) || jsonb_build_object(
          'title', v_candidate.proposed_title,
          'summary', v_candidate.proposed_summary,
          'eventDate', v_candidate.proposed_event_date
        );
        v_supports := case
          when jsonb_typeof(v_claim -> 'supports') = 'array' then v_claim -> 'supports'
          else '[]'::jsonb
        end;
        insert into public.timeline_event_evidence (
          event_id, source_document_id, evidence_role, supports_event_date,
          supports_title, supports_summary, supports_quantitative_claim,
          evidence_excerpt, extracted_claims, source_event_date, is_conflicting,
          conflict_description
        ) values (
          v_target_event_id, v_link.source_document_id,
          case when v_link.evidence_role = 'discovery_only' then 'supporting' else v_link.evidence_role end,
          v_supports ? 'eventDate', v_supports ? 'title', v_supports ? 'summary',
          v_supports ? 'quantitativeClaim',
          coalesce(nullif(trim(v_claim ->> 'excerpt'), ''), 'Evidence attached from reviewed candidate.'),
          v_claim,
          case when v_supports ? 'eventDate' then v_candidate.proposed_event_date else null end,
          v_link.evidence_role = 'conflicting',
          case when v_link.evidence_role = 'conflicting'
            then 'Candidate source contains a conflicting claim.' else null end
        )
        on conflict (event_id, source_document_id) do nothing;
      end loop;

      if v_type = 'publish_candidate' then
        update public.timeline_events
        set status = 'published', published_at = clock_timestamp(),
            last_updated_at = clock_timestamp()
        where id = v_target_event_id
        returning * into v_event;
        update public.timeline_event_candidates
        set status = 'accepted', rejection_reason = null
        where id = v_candidate_id
        returning * into v_candidate;
      else
        update public.timeline_event_candidates
        set status = 'merged', rejection_reason = null
        where id = v_candidate_id
        returning * into v_candidate;
      end if;
      v_affected := array[v_target_event_id];
    else
      raise exception 'unsupported timeline candidate action: %', v_type using errcode = '22023';
    end if;

    v_after := jsonb_build_object(
      'candidate', to_jsonb(v_candidate),
      'targetEventId', v_target_event_id,
      'mutation', p_action - 'candidateId' - 'reason'
    );
    insert into public.timeline_artifact_invalidations (company_id, reason)
    values (v_company_id, format('admin:%s', v_type));
    insert into public.timeline_event_audit_log (
      event_id, candidate_id, company_id, actor_id, actor_email,
      action, before_json, after_json, reason
    ) values (
      null, v_candidate_id, v_company_id, v_actor_id, v_actor_email,
      v_type, v_before, v_after, v_reason
    ) returning id into v_audit_id;

  else
    if v_type not in ('rerun_discovery', 'rerun_source', 'reclassify', 'rebuild_artifact') then
      raise exception 'unsupported timeline company action: %', v_type using errcode = '22023';
    end if;
    if nullif(trim(p_action ->> 'companyId'), '') is null then
      raise exception 'timeline company source key is required' using errcode = '22023';
    end if;

    -- Public timeline artifacts carry source_key values, while every durable
    -- relation uses companies.id UUIDs. A source key can exist in more than one
    -- batch, so lock and select the lowest UUID deterministically.
    select company.* into v_company
    from public.companies as company
    where company.source_key = trim(p_action ->> 'companyId')
    order by company.id asc
    limit 1
    for update;
    if not found then
      raise exception 'timeline company source key % was not found', p_action ->> 'companyId'
        using errcode = 'P0002';
    end if;
    v_company_id := v_company.id;
    v_before := jsonb_build_object(
      'requestedSourceKey', p_action ->> 'companyId',
      'resolvedCompany', to_jsonb(v_company)
    );

    if v_type = 'rerun_source' then
      v_source_class := p_action ->> 'sourceClass';
      if v_source_class not in (
        'timeline_existing_evidence', 'timeline_official_site',
        'timeline_founder_sources', 'timeline_institutional_sources',
        'timeline_public_web', 'timeline_historical_archive',
        'timeline_gap_followup', 'timeline_reconcile_publish'
      ) then
        raise exception 'timeline source class is invalid' using errcode = '22023';
      end if;
      v_source_classes := array[v_source_class];
      if v_source_class = 'timeline_reconcile_publish' then
        update public.timeline_event_candidates
        set status = 'processing', rejection_reason = null, updated_at = clock_timestamp()
        where company_id = v_company_id;
      end if;
    elsif v_type = 'rerun_discovery' then
      v_source_classes := array[
        'timeline_existing_evidence', 'timeline_official_site',
        'timeline_founder_sources', 'timeline_institutional_sources',
        'timeline_public_web', 'timeline_historical_archive',
        'timeline_gap_followup', 'timeline_reconcile_publish'
      ];
    elsif v_type = 'reclassify' then
      v_source_classes := array['timeline_reconcile_publish'];
      update public.timeline_event_candidates
      set status = 'processing', rejection_reason = null, updated_at = clock_timestamp()
      where company_id = v_company_id;
    else
      -- Rebuilding the public cache is represented by the durable artifact
      -- invalidation written below and the immediate process-local cache clear
      -- in the HTTP route. It must not enqueue a fake discovery task.
      v_source_classes := array[]::text[];
    end if;

    v_checkpoint := format(
      'timeline:%s:%s%s',
      v_type,
      p_action ->> 'companyId',
      case when v_type = 'rerun_source' then format(':%s', v_source_class) else '' end
    );
    foreach v_source_class in array v_source_classes
    loop
      insert into public.ingestion_tasks as existing_task (
        ingestion_run_id, batch_id, entity_type, entity_id, company_name,
        platform, status, attempts, checkpoint_key, rate_limit_ms,
        max_attempts, priority, next_attempt_at, terminal_at, terminal_reason,
        last_error, last_error_json, last_failure_kind, locked_by, locked_at,
        lease_token, lease_expires_at
      ) values (
        null, v_company.batch_id, 'company', v_company.id, v_company.name,
        v_source_class, 'queued', 0, format('%s:%s', v_checkpoint, v_source_class), 0,
        3, case when v_type = 'rebuild_artifact' then 100 else 50 end,
        null, null, null, null, '{}'::jsonb, null, null, null, null, null
      )
      on conflict (checkpoint_key) do update set
        ingestion_run_id = excluded.ingestion_run_id,
        batch_id = excluded.batch_id,
        entity_type = excluded.entity_type,
        entity_id = excluded.entity_id,
        company_name = excluded.company_name,
        platform = excluded.platform,
        status = 'queued',
        attempts = 0,
        rate_limit_ms = excluded.rate_limit_ms,
        max_attempts = excluded.max_attempts,
        priority = excluded.priority,
        next_attempt_at = null,
        last_attempt_at = null,
        terminal_at = null,
        terminal_reason = null,
        last_error = null,
        last_error_json = '{}'::jsonb,
        last_failure_kind = null,
        locked_by = null,
        locked_at = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = clock_timestamp()
      where existing_task.status <> 'running'
        or existing_task.lease_expires_at is null
        or existing_task.lease_expires_at <= clock_timestamp();

      update public.ingestion_dead_letters as dead_letter
      set status = 'requeued', resolved_at = clock_timestamp(),
          resolution_note = 'Requeued by Timeline administrator action.',
          updated_at = clock_timestamp()
      from public.ingestion_tasks as task
      where task.checkpoint_key = format('%s:%s', v_checkpoint, v_source_class)
        and task.status = 'queued'
        and dead_letter.ingestion_task_id = task.id
        and dead_letter.status = 'open';
    end loop;

    v_after := jsonb_build_object(
      'checkpoint', v_checkpoint,
      'sourceClasses', to_jsonb(v_source_classes),
      'resolvedCompanyId', v_company.id,
      'requestedSourceKey', p_action ->> 'companyId'
    );
    insert into public.timeline_artifact_invalidations (company_id, reason)
    values (v_company_id, format('admin:%s', v_type));
    insert into public.timeline_event_audit_log (
      event_id, candidate_id, company_id, actor_id, actor_email,
      action, before_json, after_json, reason
    ) values (
      null, null, v_company_id, v_actor_id, v_actor_email,
      v_type, v_before, v_after, null
    ) returning id into v_audit_id;
  end if;

  return jsonb_build_object(
    'auditId', v_audit_id::text,
    'affectedEventIds', coalesce(to_jsonb(v_affected), '[]'::jsonb),
    'cacheInvalidated', true
  );
end;
$$;

revoke all on function public.apply_timeline_admin_action(text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_timeline_admin_action(text, jsonb, jsonb)
  to service_role;

-- Admin actions intentionally have no ingestion_run_id: they are independent
-- durable requests, not children of whichever scheduled run happens to be
-- active. This claim function is the only worker boundary for those tasks and
-- cannot lease scheduled-run work.
create index if not exists ingestion_tasks_timeline_admin_claimable_idx
  on public.ingestion_tasks (platform, priority desc, next_attempt_at, created_at)
  where ingestion_run_id is null and status in ('queued', 'retry_scheduled');

create or replace function public.claim_timeline_admin_tasks(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_duration interval default interval '2 minutes',
  p_source_class text default null
)
returns setof public.ingestion_tasks
language plpgsql
security definer
set search_path = pg_catalog
as $function$
begin
  if p_worker_id is null or length(trim(p_worker_id)) = 0 or length(trim(p_worker_id)) > 200 then
    raise exception 'worker id must contain 1 to 200 characters' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'claim limit must be between 1 and 100' using errcode = '22023';
  end if;
  if p_lease_duration is null
      or p_lease_duration <= interval '0 seconds'
      or p_lease_duration > interval '1 hour' then
    raise exception 'lease duration must be greater than zero and at most one hour' using errcode = '22023';
  end if;
  if p_source_class is not null and p_source_class not in (
    'timeline_existing_evidence', 'timeline_official_site',
    'timeline_founder_sources', 'timeline_institutional_sources',
    'timeline_public_web', 'timeline_historical_archive',
    'timeline_gap_followup', 'timeline_reconcile_publish'
  ) then
    raise exception 'timeline source class is invalid' using errcode = '22023';
  end if;

  return query
  with candidates as materialized (
    select task.id
    from public.ingestion_tasks as task
    where task.ingestion_run_id is null
      and task.platform in (
        'timeline_existing_evidence', 'timeline_official_site',
        'timeline_founder_sources', 'timeline_institutional_sources',
        'timeline_public_web', 'timeline_historical_archive',
        'timeline_gap_followup', 'timeline_reconcile_publish'
      )
      and task.status in ('queued', 'retry_scheduled')
      and task.attempts < task.max_attempts
      and coalesce(task.next_attempt_at, task.created_at) <= clock_timestamp()
      and (task.lease_expires_at is null or task.lease_expires_at <= clock_timestamp())
      and (p_source_class is null or task.platform = p_source_class)
    order by task.priority desc, coalesce(task.next_attempt_at, task.created_at), task.created_at, task.id
    for update of task skip locked
    limit p_limit
  )
  update public.ingestion_tasks as task
  set status = 'running',
      attempts = task.attempts + 1,
      last_attempt_at = clock_timestamp(),
      locked_by = trim(p_worker_id),
      locked_at = clock_timestamp(),
      lease_token = public.gen_random_uuid(),
      lease_expires_at = clock_timestamp() + p_lease_duration,
      terminal_at = null,
      terminal_reason = null,
      updated_at = clock_timestamp()
  from candidates
  where task.id = candidates.id
  returning task.*;
end;
$function$;

revoke all on function public.claim_timeline_admin_tasks(text, integer, interval, text)
  from public, anon, authenticated;
grant execute on function public.claim_timeline_admin_tasks(text, integer, interval, text)
  to service_role;
