-- Canonical weighted Insider identities. Per-user rows continue to store only
-- overrides, disabled defaults, and user-added identities.
create table if not exists public.insider_registry (
  person_id text primary key,
  display_name text not null,
  normalized_name text not null unique,
  aliases jsonb not null default '[]'::jsonb,
  weight smallint not null check (weight between 1 and 5),
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

comment on table public.insider_registry is
  'Canonical default Insider identities and integer weights used by dynamic score recomputation.';

alter table public.insider_registry enable row level security;
revoke all on table public.insider_registry from public, anon, authenticated;
grant select on table public.insider_registry to anon, authenticated;
grant all on table public.insider_registry to service_role;

drop policy if exists insider_registry_is_readable on public.insider_registry;
create policy insider_registry_is_readable
  on public.insider_registry for select to anon, authenticated using (true);

insert into public.insider_registry (person_id, display_name, normalized_name, aliases, weight, active)
values
  ('jude-gomila','Jude Gomila','jude gomila','["Jude Gomila"]',3,true),
  ('immad-akhund','Immad Akhund','immad akhund','["Immad Akhund"]',2,true),
  ('philip-johnston','Philip Johnston','philip johnston','["Philip Johnston","Phillip Johnston"]',2,true),
  ('ashton-kutcher','Ashton Kutcher','ashton kutcher','["Ashton Kutcher"]',2,true),
  ('paul-buchheit','Paul Buchheit','paul buchheit','["Paul Buchheit"]',4,true),
  ('tom-blomfield','Tom Blomfield','tom blomfield','["Tom Blomfield"]',3,true),
  ('jason-gray','Jason Gray','jason gray','["Jason Gray"]',3,true),
  ('jared-heyman','Jared Heyman','jared heyman','["Jared Heyman"]',4,true),
  ('paul-graham','Paul Graham','paul graham','["Paul Graham","pg"]',5,true),
  ('jessica-livingston','Jessica Livingston','jessica livingston','["Jessica Livingston"]',4,true),
  ('michael-seibel','Michael Seibel','michael seibel','["Michael Seibel"]',5,true),
  ('sam-altman','Sam Altman','sam altman','["Sam Altman","sama"]',4,true),
  ('brian-chesky','Brian Chesky','brian chesky','["Brian Chesky"]',3,true),
  ('patrick-collison','Patrick Collison','patrick collison','["Patrick Collison"]',3,true),
  ('john-collison','John Collison','john collison','["John Collison"]',2,true),
  ('brian-armstrong','Brian Armstrong','brian armstrong','["Brian Armstrong"]',3,true),
  ('drew-houston','Drew Houston','drew houston','["Drew Houston"]',1,true),
  ('steve-huffman','Steve Huffman','steve huffman','["Steve Huffman","spez"]',2,true),
  ('justin-kan','Justin Kan','justin kan','["Justin Kan"]',2,true),
  ('emmett-shear','Emmett Shear','emmett shear','["Emmett Shear"]',1,true),
  ('alexis-ohanian','Alexis Ohanian','alexis ohanian','["Alexis Ohanian"]',2,true),
  ('guillermo-rauch','Guillermo Rauch','guillermo rauch','["Guillermo Rauch"]',1,true),
  ('dylan-field','Dylan Field','dylan field','["Dylan Field"]',1,true),
  ('aravind-srinivas','Aravind Srinivas','aravind srinivas','["Aravind Srinivas"]',1,true),
  ('alex-wang','Alex Wang','alex wang','["Alex Wang"]',1,true),
  ('palmer-luckey','Palmer Luckey','palmer luckey','["Palmer Luckey"]',1,true),
  ('parker-conrad','Parker Conrad','parker conrad','["Parker Conrad"]',1,true),
  ('aaron-levie','Aaron Levie','aaron levie','["Aaron Levie"]',1,true),
  ('eric-migicovsky','Eric Migicovsky','eric migicovsky','["Eric Migicovsky"]',1,true),
  ('tony-xu','Tony Xu','tony xu','["Tony Xu"]',1,true),
  ('apoorva-mehta','Apoorva Mehta','apoorva mehta','["Apoorva Mehta"]',1,true),
  ('max-mullen','Max Mullen','max mullen','["Max Mullen"]',1,true),
  ('henrique-dubugras','Henrique Dubugras','henrique dubugras','["Henrique Dubugras"]',1,true),
  ('pedro-franceschi','Pedro Franceschi','pedro franceschi','["Pedro Franceschi"]',1,true),
  ('mathilde-collin','Mathilde Collin','mathilde collin','["Mathilde Collin"]',1,true),
  ('rahul-vohra','Rahul Vohra','rahul vohra','["Rahul Vohra"]',1,true),
  ('spenser-skates','Spenser Skates','spenser skates','["Spenser Skates"]',1,true),
  ('suhail-doshi','Suhail Doshi','suhail doshi','["Suhail Doshi"]',1,true),
  ('taro-fukuyama','Taro Fukuyama','taro fukuyama','["Taro Fukuyama"]',1,true),
  ('dalton-caldwell','Dalton Caldwell','dalton caldwell','["Dalton Caldwell"]',4,true),
  ('qasar-younis','Qasar Younis','qasar younis','["Qasar Younis"]',2,true),
  ('ali-rowghani','Ali Rowghani','ali rowghani','["Ali Rowghani"]',2,true),
  ('anu-hariharan','Anu Hariharan','anu hariharan','["Anu Hariharan"]',2,true),
  ('elad-gil','Elad Gil','elad gil','["Elad Gil"]',3,true),
  ('nat-friedman','Nat Friedman','nat friedman','["Nat Friedman"]',1,true),
  ('daniel-gross','Daniel Gross','daniel gross','["Daniel Gross"]',3,true),
  ('david-sacks','David Sacks','david sacks','["David Sacks"]',2,true),
  ('marc-andreessen','Marc Andreessen','marc andreessen','["Marc Andreessen","pmarca"]',5,true),
  ('ben-horowitz','Ben Horowitz','ben horowitz','["Ben Horowitz"]',5,true),
  ('naval-ravikant','Naval Ravikant','naval ravikant','["Naval Ravikant","naval"]',1,true),
  ('keith-rabois','Keith Rabois','keith rabois','["Keith Rabois"]',1,true),
  ('sarah-guo','Sarah Guo','sarah guo','["Sarah Guo"]',1,true),
  ('andrew-chen','Andrew Chen','andrew chen','["Andrew Chen"]',4,true),
  ('lachy-groom','Lachy Groom','lachy groom','["Lachy Groom"]',1,true),
  ('semil-shah','Semil Shah','semil shah','["Semil Shah"]',1,true),
  ('delian-asparouhov','Delian Asparouhov','delian asparouhov','["Delian Asparouhov"]',1,true),
  ('trae-stephens','Trae Stephens','trae stephens','["Trae Stephens"]',1,true),
  ('lenny-rachitsky','Lenny Rachitsky','lenny rachitsky','["Lenny Rachitsky"]',1,true)
on conflict (person_id) do update set
  display_name = excluded.display_name,
  normalized_name = excluded.normalized_name,
  aliases = excluded.aliases,
  weight = excluded.weight,
  active = excluded.active,
  updated_at = now();

-- Merge the historical misspelling without touching unrelated custom people.
update public.insider_registry canonical
set aliases = (
  select jsonb_agg(distinct item.value)
  from jsonb_array_elements(
    canonical.aliases ||
    coalesce((
      select duplicate.aliases
      from public.insider_registry duplicate
      where duplicate.person_id = 'phillip-johnston'
    ), '[]'::jsonb)
  ) item(value)
)
where canonical.person_id = 'philip-johnston';
delete from public.insider_registry where person_id = 'phillip-johnston';

alter table public.user_insider_configurations
  drop constraint if exists user_insider_configurations_exclusions_check;
alter table public.user_insider_configurations
  add constraint user_insider_configurations_exclusions_check
  check (cardinality(excluded_default_ids) <= 58);

-- Targeted score-configuration backfill for rows written by the former
-- decimal 0.01..100 editor. This changes no report evidence or content.
update public.user_insider_configurations configuration
set
  weight_overrides = coalesce((
    select jsonb_object_agg(
      entry.key,
      to_jsonb(greatest(1, least(5, round((entry.value #>> '{}')::numeric)))::integer)
    )
    from jsonb_each(configuration.weight_overrides) entry
    where jsonb_typeof(entry.value) = 'number'
  ), '{}'::jsonb),
  added_insiders = coalesce((
    select jsonb_agg(
      member.value ||
      jsonb_build_object(
        'weight', greatest(1, least(5, round((member.value->>'weight')::numeric)))::integer,
        'active', coalesce((member.value->>'active')::boolean, true)
      )
      order by member.ordinality
    )
    from jsonb_array_elements(configuration.added_insiders) with ordinality member(value, ordinality)
    where jsonb_typeof(member.value) = 'object'
      and jsonb_typeof(member.value->'weight') = 'number'
  ), '[]'::jsonb),
  updated_at = now();

update public.user_insider_configurations configuration
set
  weight_overrides = jsonb_set(
    configuration.weight_overrides,
    '{philip-johnston}',
    coalesce((
      select member.value->'weight'
      from jsonb_array_elements(configuration.added_insiders) member(value)
      where lower(regexp_replace(member.value->>'displayName', '[^a-z0-9]+', ' ', 'g'))
        in ('philip johnston', 'phillip johnston')
      limit 1
    ), '2'::jsonb),
    true
  ),
  excluded_default_ids = case
    when exists (
      select 1
      from jsonb_array_elements(configuration.added_insiders) member(value)
      where lower(regexp_replace(member.value->>'displayName', '[^a-z0-9]+', ' ', 'g'))
        in ('philip johnston', 'phillip johnston')
        and coalesce((member.value->>'active')::boolean, true) = false
    )
      then array(select distinct value from unnest(configuration.excluded_default_ids || array['philip-johnston']) value)
    else configuration.excluded_default_ids
  end,
  added_insiders = coalesce((
    select jsonb_agg(member.value order by member.ordinality)
    from jsonb_array_elements(configuration.added_insiders) with ordinality member(value, ordinality)
    where lower(regexp_replace(member.value->>'displayName', '[^a-z0-9]+', ' ', 'g'))
      not in ('philip johnston', 'phillip johnston')
  ), '[]'::jsonb),
  updated_at = now()
where exists (
  select 1
  from jsonb_array_elements(configuration.added_insiders) member(value)
  where lower(regexp_replace(member.value->>'displayName', '[^a-z0-9]+', ' ', 'g'))
    in ('philip johnston', 'phillip johnston')
);

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
  if p_expected_version < 0
     or cardinality(p_excluded_default_ids) > 58
     or jsonb_typeof(p_weight_overrides) <> 'object'
     or jsonb_typeof(p_added_insiders) <> 'array'
     or jsonb_array_length(p_added_insiders) > 200 then
    raise exception using errcode = '22023', message = 'Invalid insiders configuration.';
  end if;
  if exists (
    select 1 from jsonb_each(p_weight_overrides) entry
    where jsonb_typeof(entry.value) <> 'number'
       or (entry.value #>> '{}')::numeric <> trunc((entry.value #>> '{}')::numeric)
       or (entry.value #>> '{}')::numeric not between 1 and 5
  ) or exists (
    select 1 from jsonb_array_elements(p_added_insiders) member
    where jsonb_typeof(member) <> 'object'
       or nullif(btrim(member->>'displayName'), '') is null
       or jsonb_typeof(member->'weight') <> 'number'
       or (member->>'weight')::numeric <> trunc((member->>'weight')::numeric)
       or (member->>'weight')::numeric not between 1 and 5
       or jsonb_typeof(member->'active') <> 'boolean'
  ) then
    raise exception using errcode = '22023', message = 'Invalid insider weight or identity.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text, 0));
  select * into v_existing
  from public.user_insider_configurations
  where user_id = v_user_id
  for update;

  if not found then
    if p_expected_version <> 0 then
      raise exception using errcode = '40001', message = 'Insiders configuration changed in another session.';
    end if;
    insert into public.user_insider_configurations (
      user_id, version, excluded_default_ids, weight_overrides, added_insiders
    ) values (
      v_user_id, 1, p_excluded_default_ids, p_weight_overrides, p_added_insiders
    ) returning * into v_saved;
  else
    if v_existing.version <> p_expected_version then
      raise exception using errcode = '40001', message = 'Insiders configuration changed in another session.';
    end if;
    update public.user_insider_configurations
    set version = version + 1,
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
