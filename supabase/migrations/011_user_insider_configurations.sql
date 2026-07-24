-- Private, per-user edits to the built-in Insiders audience. The canonical
-- 50-person seed remains in application code; this row stores only differences.
create table if not exists public.user_insider_configurations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  version bigint not null default 1 check (version > 0),
  excluded_default_ids text[] not null default '{}'::text[],
  weight_overrides jsonb not null default '{}'::jsonb,
  added_insiders jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_insider_configurations_exclusions_check
    check (cardinality(excluded_default_ids) <= 50),
  constraint user_insider_configurations_weights_check
    check (jsonb_typeof(weight_overrides) = 'object'),
  constraint user_insider_configurations_added_check
    check (jsonb_typeof(added_insiders) = 'array' and jsonb_array_length(added_insiders) <= 200)
);

comment on table public.user_insider_configurations is
  'Private default-plus-overrides configuration for a signed-in user''s Insiders audience.';

alter table public.user_insider_configurations enable row level security;
revoke all on table public.user_insider_configurations from public, anon;
revoke all on table public.user_insider_configurations from authenticated;
grant select, insert, update, delete on table public.user_insider_configurations to authenticated;
grant all on table public.user_insider_configurations to service_role;

drop policy if exists user_owns_insider_configuration on public.user_insider_configurations;
create policy user_owns_insider_configuration
  on public.user_insider_configurations
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create or replace function public.save_user_insider_configuration(
  p_expected_version bigint,
  p_excluded_default_ids text[],
  p_weight_overrides jsonb,
  p_added_insiders jsonb
)
returns public.user_insider_configurations
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.user_insider_configurations;
  v_saved public.user_insider_configurations;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;
  if p_expected_version < 0 then
    raise exception using errcode = '22023', message = 'Expected version must be non-negative.';
  end if;
  if cardinality(p_excluded_default_ids) > 50
     or jsonb_typeof(p_weight_overrides) <> 'object'
     or jsonb_typeof(p_added_insiders) <> 'array'
     or jsonb_array_length(p_added_insiders) > 200 then
    raise exception using errcode = '22023', message = 'Invalid insiders configuration.';
  end if;
  if exists (
    select 1
    from jsonb_each(p_weight_overrides) entry
    where jsonb_typeof(entry.value) <> 'number'
      or (entry.value #>> '{}')::numeric < 0.01
      or (entry.value #>> '{}')::numeric > 100
  ) then
    raise exception using errcode = '22023', message = 'Invalid insider weight.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text, 0));

  select *
  into v_existing
  from public.user_insider_configurations
  where user_id = v_user_id
  for update;

  if not found then
    if p_expected_version <> 0 then
      raise exception using errcode = '40001', message = 'Insiders configuration changed in another session.';
    end if;
    insert into public.user_insider_configurations (
      user_id,
      version,
      excluded_default_ids,
      weight_overrides,
      added_insiders
    ) values (
      v_user_id,
      1,
      p_excluded_default_ids,
      p_weight_overrides,
      p_added_insiders
    )
    returning * into v_saved;
  else
    if v_existing.version <> p_expected_version then
      raise exception using errcode = '40001', message = 'Insiders configuration changed in another session.';
    end if;
    update public.user_insider_configurations
    set
      version = version + 1,
      excluded_default_ids = p_excluded_default_ids,
      weight_overrides = p_weight_overrides,
      added_insiders = p_added_insiders,
      updated_at = now()
    where user_id = v_user_id
    returning * into v_saved;
  end if;

  return v_saved;
end;
$$;

revoke all on function public.save_user_insider_configuration(bigint, text[], jsonb, jsonb) from public, anon;
grant execute on function public.save_user_insider_configuration(bigint, text[], jsonb, jsonb) to authenticated, service_role;
