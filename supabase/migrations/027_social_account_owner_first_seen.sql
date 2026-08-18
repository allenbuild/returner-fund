-- Preserve the earliest observation timestamp for batch-scoped owner mappings
-- across repeated ingestion upserts.

create or replace function public.preserve_social_account_owner_first_seen_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
begin
  new.first_seen_at := least(old.first_seen_at, new.first_seen_at);
  return new;
end;
$function$;

drop trigger if exists social_account_owners_preserve_first_seen_at on public.social_account_owners;
create trigger social_account_owners_preserve_first_seen_at
before update on public.social_account_owners
for each row execute function public.preserve_social_account_owner_first_seen_at();
