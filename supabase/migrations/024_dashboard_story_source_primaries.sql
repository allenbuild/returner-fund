-- Reconcile primary source links after each idempotent source upsert. Keeping
-- this server-side makes a primary-source replacement atomic with respect to
-- the one-primary-per-story invariant and avoids N+1 client updates.

create or replace function public.reconcile_dashboard_story_source_primaries(
  p_primary_links jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if jsonb_typeof(p_primary_links) <> 'array' then
    raise exception 'dashboard primary links must be a JSON array';
  end if;

  -- Demote any historical primary for the affected stories first. The current
  -- source links were just upserted as supporting, so this is safe even when a
  -- source moved in rank or an older link is no longer present in the snapshot.
  with desired as (
    select
      (value ->> 'story_id')::uuid as story_id,
      (value ->> 'external_source_id')::uuid as external_source_id
    from jsonb_array_elements(p_primary_links)
  )
  update public.dashboard_story_sources source
  set source_role = 'supporting'
  where source.source_role = 'primary'
    and exists (
      select 1
      from desired
      where desired.story_id = source.story_id
    );

  -- The partial unique index now has no primary row for each affected story,
  -- so all requested promotions succeed together or the transaction rolls
  -- back without exposing an invalid intermediate state.
  with desired as (
    select
      (value ->> 'story_id')::uuid as story_id,
      (value ->> 'external_source_id')::uuid as external_source_id
    from jsonb_array_elements(p_primary_links)
  )
  update public.dashboard_story_sources source
  set source_role = 'primary'
  from desired
  where source.story_id = desired.story_id
    and source.external_source_id = desired.external_source_id;
end;
$$;

comment on function public.reconcile_dashboard_story_source_primaries(jsonb) is
  'Promotes one already-upserted external source per Dashboard story without violating the primary-source uniqueness invariant.';

revoke all privileges on function public.reconcile_dashboard_story_source_primaries(jsonb)
  from public, anon, authenticated;
grant execute on function public.reconcile_dashboard_story_source_primaries(jsonb)
  to service_role;
