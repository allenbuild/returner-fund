-- Timeline post links must always point at canonical evidence with a verified
-- attribution to the event's exact primary company. Application checks are
-- defense in depth; this trigger is the durable cross-table invariant.

create or replace function public.assert_timeline_event_post_company_attribution(
  target_event_id uuid,
  target_evidence_id uuid
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.timeline_events as event
    join public.evidence_attributions as attribution
      on attribution.evidence_id = target_evidence_id
     and attribution.company_id = event.primary_company_id
     and attribution.entity_type = 'company'
     and attribution.review_state = 'verified'
    where event.id = target_event_id
  ) then
    raise exception 'timeline event % may link evidence % only with a verified attribution to the same company',
      target_event_id, target_evidence_id;
  end if;
end;
$$;

do $$
declare
  invalid_link record;
begin
  select post.event_id, post.evidence_id
  into invalid_link
  from public.timeline_event_posts as post
  where not exists (
    select 1
    from public.timeline_events as event
    join public.evidence_attributions as attribution
      on attribution.evidence_id = post.evidence_id
     and attribution.company_id = event.primary_company_id
     and attribution.entity_type = 'company'
     and attribution.review_state = 'verified'
    where event.id = post.event_id
  )
  limit 1;

  if found then
    raise exception 'existing timeline event % links evidence % without a verified same-company attribution',
      invalid_link.event_id, invalid_link.evidence_id;
  end if;
end;
$$;

create or replace function public.guard_timeline_event_post_company_attribution()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform public.assert_timeline_event_post_company_attribution(new.event_id, new.evidence_id);
  return new;
end;
$$;

create or replace function public.revalidate_timeline_posts_after_attribution_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  linked_event_id uuid;
  affected_evidence_id uuid := case when tg_op = 'DELETE' then old.evidence_id else new.evidence_id end;
begin
  for linked_event_id in
    select post.event_id
    from public.timeline_event_posts as post
    where post.evidence_id = affected_evidence_id
  loop
    perform public.assert_timeline_event_post_company_attribution(linked_event_id, affected_evidence_id);
  end loop;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists timeline_event_posts_company_attribution_guard on public.timeline_event_posts;
create trigger timeline_event_posts_company_attribution_guard
before insert or update of event_id, evidence_id on public.timeline_event_posts
for each row execute function public.guard_timeline_event_post_company_attribution();

drop trigger if exists timeline_event_posts_revalidate_attribution on public.evidence_attributions;
create constraint trigger timeline_event_posts_revalidate_attribution
after delete or update of evidence_id, company_id, entity_type, review_state
on public.evidence_attributions
deferrable initially immediate
for each row execute function public.revalidate_timeline_posts_after_attribution_mutation();

-- Artifact generation reads this service-only projection instead of exposing
-- the canonical evidence/attribution base tables to public roles.
create or replace view public.published_timeline_post_metadata
with (security_barrier = true)
as
select distinct
  evidence.id,
  post.event_id,
  evidence.platform,
  evidence.canonical_url,
  evidence.published_at,
  jsonb_build_object(
    'authorHandle', evidence.metadata_json -> 'authorHandle',
    'authorName', coalesce(
      evidence.metadata_json -> 'authorName',
      evidence.metadata_json -> 'company_name'
    ),
    'text', evidence.metadata_json -> 'text',
    'metrics', coalesce(metrics.values, '{}'::jsonb)
  ) as metadata_json,
  post.evidence_role
from public.timeline_event_posts as post
join public.timeline_events as event on event.id = post.event_id
join public.evidence_items as evidence on evidence.id = post.evidence_id
join public.evidence_attributions as attribution
  on attribution.evidence_id = evidence.id
 and attribution.company_id = event.primary_company_id
 and attribution.entity_type = 'company'
 and attribution.review_state = 'verified'
left join lateral (
  select jsonb_object_agg(latest.metric_name, latest.metric_value) as values
  from (
    select distinct on (observation.metric_name)
      observation.metric_name,
      observation.metric_value
    from public.metric_observations as observation
    where observation.evidence_id = evidence.id
    order by observation.metric_name, observation.observed_at desc, observation.created_at desc
  ) as latest
) as metrics on true
where event.status = 'published'
  and event.published_at is not null
  and evidence.canonical_url ~* '^https?://';

revoke all privileges on table public.published_timeline_post_metadata from public, anon, authenticated;
grant select on table public.published_timeline_post_metadata to service_role;

revoke all privileges on function public.assert_timeline_event_post_company_attribution(uuid, uuid)
  from public, anon, authenticated;
revoke all privileges on function public.guard_timeline_event_post_company_attribution()
  from public, anon, authenticated;
revoke all privileges on function public.revalidate_timeline_posts_after_attribution_mutation()
  from public, anon, authenticated;
grant execute on function public.assert_timeline_event_post_company_attribution(uuid, uuid) to service_role;
grant execute on function public.guard_timeline_event_post_company_attribution() to service_role;
grant execute on function public.revalidate_timeline_posts_after_attribution_mutation() to service_role;

comment on view public.published_timeline_post_metadata is
  'Service-only artifact projection of canonical post evidence verified for the same company as each published Timeline event.';
