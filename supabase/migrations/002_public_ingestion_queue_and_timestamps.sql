alter table public.posts
  add column if not exists canonical_url text,
  add column if not exists raw_visible_text text,
  add column if not exists first_seen_at timestamptz not null default now(),
  add column if not exists last_checked_at timestamptz not null default now(),
  add column if not exists last_updated_at timestamptz not null default now();

alter table public.post_metrics
  add column if not exists first_seen_at timestamptz not null default now(),
  add column if not exists last_checked_at timestamptz not null default now(),
  add column if not exists last_updated_at timestamptz not null default now();

create table if not exists public.ingestion_tasks (
  id uuid primary key default gen_random_uuid(),
  ingestion_run_id uuid references public.ingestion_runs(id) on delete cascade,
  batch_id uuid references public.batches(id) on delete cascade,
  entity_type text not null,
  entity_id uuid,
  company_name text not null,
  platform text not null,
  status text not null default 'queued',
  attempts integer not null default 0,
  checkpoint_key text not null unique,
  rate_limit_ms integer not null default 1200,
  last_error text,
  locked_by text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ingestion_tasks_entity_type_check check (entity_type in ('company', 'founder')),
  constraint ingestion_tasks_status_check check (
    status in ('queued', 'running', 'completed', 'needs_review', 'blocked_or_empty', 'skipped', 'failed')
  ),
  constraint ingestion_tasks_attempts_nonnegative check (attempts >= 0),
  constraint ingestion_tasks_rate_limit_nonnegative check (rate_limit_ms >= 0),
  constraint ingestion_tasks_platform_not_blank check (length(trim(platform)) > 0),
  constraint ingestion_tasks_company_name_not_blank check (length(trim(company_name)) > 0)
);

create table if not exists public.source_failures (
  id uuid primary key default gen_random_uuid(),
  ingestion_task_id uuid references public.ingestion_tasks(id) on delete cascade,
  platform text not null,
  source_url text,
  company_name text not null,
  failure_kind text not null,
  message text not null,
  occurred_at timestamptz not null default now(),
  raw_json jsonb not null default '{}'::jsonb,
  constraint source_failures_source_url_http check (source_url is null or source_url ~* '^https?://'),
  constraint source_failures_platform_not_blank check (length(trim(platform)) > 0),
  constraint source_failures_company_name_not_blank check (length(trim(company_name)) > 0),
  constraint source_failures_failure_kind_not_blank check (length(trim(failure_kind)) > 0)
);

create index if not exists posts_canonical_url_idx on public.posts (canonical_url);
create index if not exists posts_last_checked_at_idx on public.posts (last_checked_at);
create index if not exists ingestion_tasks_status_idx on public.ingestion_tasks (status);
create index if not exists ingestion_tasks_platform_status_idx on public.ingestion_tasks (platform, status);
create index if not exists source_failures_platform_idx on public.source_failures (platform);

drop trigger if exists set_ingestion_tasks_updated_at on public.ingestion_tasks;
create trigger set_ingestion_tasks_updated_at
before update on public.ingestion_tasks
for each row execute function public.set_updated_at();
