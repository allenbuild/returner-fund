-- Make the dashboard's terminal publication transition transactional and use
-- database time for terminal run stamps. This is intentionally additive: 022
-- may already be present in a staged production deployment.

alter table public.dashboard_story_entities
  add column if not exists entity_key text;

update public.dashboard_story_entities
set entity_key = case
  when company_id is not null then 'company:' || company_id::text
  when founder_id is not null then 'founder:' || founder_id::text
  else 'external:' || lower(trim(external_entity_name))
end
where entity_key is null;

alter table public.dashboard_story_entities
  alter column entity_key set not null;

create unique index if not exists dashboard_story_entities_identity_unique
  on public.dashboard_story_entities (story_id, entity_key, relationship_type);

create or replace function public.finalize_dashboard_publication(
  p_dashboard_run_id uuid,
  p_publication_id uuid,
  p_input_fingerprint text,
  p_source_snapshot_hash text,
  p_input_observed_through timestamptz,
  p_stats_json jsonb
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_run public.dashboard_runs%rowtype;
  target_publication public.dashboard_publications%rowtype;
  current_publication public.dashboard_publications%rowtype;
  finalized_at timestamptz := clock_timestamp();
begin
  select *
  into target_run
  from public.dashboard_runs
  where id = p_dashboard_run_id
  for update;
  if not found then
    raise exception 'dashboard run % was not found', p_dashboard_run_id;
  end if;

  select *
  into target_publication
  from public.dashboard_publications
  where id = p_publication_id
    and dashboard_run_id = p_dashboard_run_id
  for update;
  if not found then
    raise exception 'dashboard publication % does not belong to run %',
      p_publication_id, p_dashboard_run_id;
  end if;

  -- A completed/retracted historical record must never be resurrected by a
  -- retry. Only the deterministic draft receipt is promotable.
  if target_publication.status <> 'draft' then
    return 'unchanged';
  end if;

  if target_run.status = 'running' then
    update public.dashboard_runs
    set status = 'completed',
        input_fingerprint = p_input_fingerprint,
        source_snapshot_hash = p_source_snapshot_hash,
        input_observed_through = p_input_observed_through,
        stats_json = p_stats_json,
        finished_at = finalized_at
    where id = p_dashboard_run_id;
  elsif target_run.status = 'completed' then
    if target_run.input_fingerprint is distinct from p_input_fingerprint
      or target_run.source_snapshot_hash is distinct from p_source_snapshot_hash then
      raise exception 'completed dashboard run % has conflicting provenance', p_dashboard_run_id;
    end if;
  else
    raise exception 'dashboard run % is % and cannot be finalized',
      p_dashboard_run_id, target_run.status;
  end if;

  select *
  into current_publication
  from public.dashboard_publications
  where is_current
    and id <> p_publication_id
  for update;

  -- A delayed retry cannot make an older hourly snapshot current again.
  if found and current_publication.generated_at > target_publication.generated_at then
    update public.dashboard_publications
    set status = 'superseded',
        is_current = false,
        superseded_at = finalized_at
    where id = p_publication_id;
    return 'unchanged';
  end if;

  if found then
    update public.dashboard_publications
    set status = 'superseded',
        is_current = false,
        superseded_at = finalized_at
    where id = current_publication.id;
  end if;

  update public.dashboard_publications
  set status = 'published',
      is_current = true,
      published_at = finalized_at
  where id = p_publication_id;

  return 'published';
end;
$$;

create or replace function public.fail_dashboard_run(
  p_dashboard_run_id uuid,
  p_error_json jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- A delayed error handler must not rewrite an atomically completed run.
  update public.dashboard_runs
  set status = 'failed',
      error_json = p_error_json,
      finished_at = clock_timestamp()
  where id = p_dashboard_run_id
    and status in ('queued', 'running');
end;
$$;

comment on function public.finalize_dashboard_publication(uuid, uuid, text, text, timestamptz, jsonb) is
  'Atomically completes a dashboard run and promotes its staged publication using database time.';

revoke all privileges on function public.finalize_dashboard_publication(uuid, uuid, text, text, timestamptz, jsonb)
  from public, anon, authenticated;
revoke all privileges on function public.fail_dashboard_run(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_dashboard_publication(uuid, uuid, text, text, timestamptz, jsonb)
  to service_role;
grant execute on function public.fail_dashboard_run(uuid, jsonb)
  to service_role;
