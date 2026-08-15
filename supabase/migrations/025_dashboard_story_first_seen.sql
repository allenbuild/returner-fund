-- The hourly snapshot is intentionally keyed to the start of its UTC hour,
-- while database inserts happen several minutes later. Preserve that first
-- snapshot timestamp across upserts without allowing it to move forward.

create or replace function public.preserve_dashboard_story_first_seen()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    new.first_seen_at := least(old.first_seen_at, new.first_seen_at);
  end if;
  return new;
end;
$$;

drop trigger if exists dashboard_stories_preserve_first_seen on public.dashboard_stories;
create trigger dashboard_stories_preserve_first_seen
before update on public.dashboard_stories
for each row execute function public.preserve_dashboard_story_first_seen();

comment on function public.preserve_dashboard_story_first_seen() is
  'Keeps a Dashboard story first_seen_at immutable at its earliest hourly snapshot timestamp during idempotent upserts.';

revoke all privileges on function public.preserve_dashboard_story_first_seen()
  from public, anon, authenticated;
grant execute on function public.preserve_dashboard_story_first_seen()
  to service_role;
