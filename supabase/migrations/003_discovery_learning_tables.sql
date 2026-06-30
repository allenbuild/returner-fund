create table if not exists public.platform_coverage (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.batches(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  platform text not null,
  evidence_count integer not null default 0,
  scored_evidence_count integer not null default 0,
  needs_review_count integer not null default 0,
  failure_count integer not null default 0,
  status text not null default 'pending',
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_coverage_platform_not_blank check (length(trim(platform)) > 0),
  constraint platform_coverage_status_check check (
    status in ('pending', 'running', 'success', 'partial_success', 'failed', 'skipped', 'blocked_or_empty')
  ),
  constraint platform_coverage_counts_nonnegative check (
    evidence_count >= 0 and scored_evidence_count >= 0 and needs_review_count >= 0 and failure_count >= 0
  ),
  unique (company_id, platform)
);

create table if not exists public.discovery_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  platform text not null,
  query text not null,
  source text not null,
  result_count integer not null default 0,
  useful_result_count integer not null default 0,
  selected_url text,
  status text not null,
  failure_reason text,
  created_at timestamptz not null default now(),
  constraint discovery_attempts_platform_not_blank check (length(trim(platform)) > 0),
  constraint discovery_attempts_query_not_blank check (length(trim(query)) > 0),
  constraint discovery_attempts_source_not_blank check (length(trim(source)) > 0),
  constraint discovery_attempts_status_check check (
    status in ('pending', 'running', 'success', 'partial_success', 'failed', 'skipped', 'blocked_or_empty', 'needs_review')
  ),
  constraint discovery_attempts_selected_url_http check (selected_url is null or selected_url ~* '^https?://'),
  constraint discovery_attempts_counts_nonnegative check (result_count >= 0 and useful_result_count >= 0)
);

create table if not exists public.source_discovery_paths (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  source_url text not null,
  discovered_url text not null,
  discovered_platform text not null,
  discovered_entity_type text not null,
  discovered_entity_name text not null,
  match_reason text not null,
  review_state text not null default 'needs_review',
  created_at timestamptz not null default now(),
  constraint source_discovery_paths_source_url_http check (source_url ~* '^https?://'),
  constraint source_discovery_paths_discovered_url_http check (discovered_url ~* '^https?://'),
  constraint source_discovery_paths_platform_not_blank check (length(trim(discovered_platform)) > 0),
  constraint source_discovery_paths_entity_type_check check (discovered_entity_type in ('company', 'founder')),
  constraint source_discovery_paths_entity_name_not_blank check (length(trim(discovered_entity_name)) > 0),
  constraint source_discovery_paths_review_state_check check (review_state in ('verified', 'needs_review', 'rejected'))
);

create index if not exists platform_coverage_platform_status_idx on public.platform_coverage (platform, status);
create index if not exists discovery_attempts_company_platform_idx on public.discovery_attempts (company_id, platform);
create index if not exists discovery_attempts_status_idx on public.discovery_attempts (status);
create index if not exists source_discovery_paths_company_platform_idx on public.source_discovery_paths (company_id, discovered_platform);

drop trigger if exists set_platform_coverage_updated_at on public.platform_coverage;
create trigger set_platform_coverage_updated_at
before update on public.platform_coverage
for each row execute function public.set_updated_at();
