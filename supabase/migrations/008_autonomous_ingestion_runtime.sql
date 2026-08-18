-- Durable coordination and audit state for autonomous ingestion workers.
-- This migration intentionally preserves legacy rows from migrations 001-007;
-- new lease invariants apply only when the new lease fields are populated.

alter table public.companies add column if not exists source_key text;
alter table public.founders add column if not exists source_key text;
alter table public.social_accounts add column if not exists source_key text;

drop index if exists public.companies_batch_name_key;
create index if not exists companies_batch_name_idx
  on public.companies (batch_id, lower(name));

create unique index if not exists companies_batch_source_key
  on public.companies (batch_id, source_key);
create unique index if not exists founders_source_key
  on public.founders (source_key);
create unique index if not exists social_accounts_source_key
  on public.social_accounts (source_key);
create unique index if not exists social_accounts_entity_platform_native_key
  on public.social_accounts (
    entity_type,
    entity_id,
    platform,
    coalesce(account_id, lower(url))
  );

alter table public.ingestion_runs
  add column if not exists idempotency_key text,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists lease_owner text,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists stats_json jsonb not null default '{}'::jsonb;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ingestion_runs_idempotency_key_not_blank'
      and conrelid = 'public.ingestion_runs'::regclass
  ) then
    alter table public.ingestion_runs
      add constraint ingestion_runs_idempotency_key_not_blank check (
        idempotency_key is null or length(trim(idempotency_key)) > 0
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'ingestion_runs_lease_owner_not_blank'
      and conrelid = 'public.ingestion_runs'::regclass
  ) then
    alter table public.ingestion_runs
      add constraint ingestion_runs_lease_owner_not_blank check (
        lease_owner is null or length(trim(lease_owner)) > 0
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'ingestion_runs_lease_fields_together'
      and conrelid = 'public.ingestion_runs'::regclass
  ) then
    alter table public.ingestion_runs
      add constraint ingestion_runs_lease_fields_together check (
        lease_expires_at is null
        or (lease_owner is not null and lease_token is not null)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'ingestion_runs_stats_json_object'
      and conrelid = 'public.ingestion_runs'::regclass
  ) then
    alter table public.ingestion_runs
      add constraint ingestion_runs_stats_json_object check (
        jsonb_typeof(stats_json) = 'object'
      );
  end if;
end
$migration$;

create unique index if not exists ingestion_runs_idempotency_key_key
  on public.ingestion_runs (idempotency_key)
  where idempotency_key is not null;
create index if not exists ingestion_runs_active_lease_idx
  on public.ingestion_runs (lease_expires_at)
  where status = 'running' and lease_expires_at is not null;
create index if not exists ingestion_runs_heartbeat_idx
  on public.ingestion_runs (heartbeat_at desc)
  where status = 'running';

create table if not exists public.ingestion_runtime_locks (
  lock_key text primary key,
  owner_id text not null,
  lease_token uuid not null default gen_random_uuid(),
  heartbeat_at timestamptz not null default now(),
  lease_expires_at timestamptz not null,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ingestion_runtime_locks_key_not_blank check (length(trim(lock_key)) > 0),
  constraint ingestion_runtime_locks_owner_not_blank check (length(trim(owner_id)) > 0),
  constraint ingestion_runtime_locks_lease_after_heartbeat check (lease_expires_at > heartbeat_at),
  constraint ingestion_runtime_locks_metadata_object check (jsonb_typeof(metadata_json) = 'object')
);

create index if not exists ingestion_runtime_locks_expiry_idx
  on public.ingestion_runtime_locks (lease_expires_at);

alter table public.ingestion_tasks
  add column if not exists max_attempts integer not null default 5,
  add column if not exists priority integer not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists retry_base_delay_seconds integer not null default 30,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists terminal_at timestamptz,
  add column if not exists terminal_reason text,
  add column if not exists last_failure_kind text,
  add column if not exists last_error_json jsonb not null default '{}'::jsonb;

-- The old status constraint is replaced in place so all legacy values remain
-- valid while retry scheduling, cancellation, and dead-lettering become explicit.
alter table public.ingestion_tasks
  drop constraint if exists ingestion_tasks_status_check;
alter table public.ingestion_tasks
  add constraint ingestion_tasks_status_check check (
    status in (
      'queued',
      'running',
      'retry_scheduled',
      'completed',
      'needs_review',
      'blocked_or_empty',
      'skipped',
      'failed',
      'canceled',
      'dead_lettered'
    )
  );

update public.ingestion_tasks
set terminal_at = coalesce(terminal_at, updated_at, created_at, clock_timestamp()),
    terminal_reason = coalesce(nullif(trim(terminal_reason), ''), status),
    locked_by = null,
    locked_at = null,
    lease_token = null,
    lease_expires_at = null
where status in (
  'completed', 'needs_review', 'blocked_or_empty', 'skipped',
  'failed', 'canceled', 'dead_lettered'
);

update public.ingestion_tasks
set terminal_at = null,
    terminal_reason = null
where status in ('queued', 'running', 'retry_scheduled');

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ingestion_tasks_max_attempts_positive'
      and conrelid = 'public.ingestion_tasks'::regclass
  ) then
    alter table public.ingestion_tasks
      add constraint ingestion_tasks_max_attempts_positive check (max_attempts > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'ingestion_tasks_retry_delay_range'
      and conrelid = 'public.ingestion_tasks'::regclass
  ) then
    alter table public.ingestion_tasks
      add constraint ingestion_tasks_retry_delay_range check (
        retry_base_delay_seconds between 0 and 3600
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'ingestion_tasks_lease_fields_together'
      and conrelid = 'public.ingestion_tasks'::regclass
  ) then
    alter table public.ingestion_tasks
      add constraint ingestion_tasks_lease_fields_together check (
        lease_expires_at is null
        or (locked_by is not null and lease_token is not null)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'ingestion_tasks_terminal_at_status'
      and conrelid = 'public.ingestion_tasks'::regclass
  ) then
    alter table public.ingestion_tasks
      add constraint ingestion_tasks_terminal_at_status check (
        terminal_at is null
        or status in (
          'completed',
          'needs_review',
          'blocked_or_empty',
          'skipped',
          'failed',
          'canceled',
          'dead_lettered'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'ingestion_tasks_terminal_reason_not_blank'
      and conrelid = 'public.ingestion_tasks'::regclass
  ) then
    alter table public.ingestion_tasks
      add constraint ingestion_tasks_terminal_reason_not_blank check (
        terminal_reason is null or length(trim(terminal_reason)) > 0
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'ingestion_tasks_last_failure_kind_not_blank'
      and conrelid = 'public.ingestion_tasks'::regclass
  ) then
    alter table public.ingestion_tasks
      add constraint ingestion_tasks_last_failure_kind_not_blank check (
        last_failure_kind is null or length(trim(last_failure_kind)) > 0
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'ingestion_tasks_last_error_json_object'
      and conrelid = 'public.ingestion_tasks'::regclass
  ) then
    alter table public.ingestion_tasks
      add constraint ingestion_tasks_last_error_json_object check (
        jsonb_typeof(last_error_json) = 'object'
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'ingestion_tasks_terminal_state_complete'
      and conrelid = 'public.ingestion_tasks'::regclass
  ) then
    alter table public.ingestion_tasks
      add constraint ingestion_tasks_terminal_state_complete check (
        (
          status in (
            'completed', 'needs_review', 'blocked_or_empty', 'skipped',
            'failed', 'canceled', 'dead_lettered'
          )
          and terminal_at is not null
          and terminal_reason is not null
          and length(trim(terminal_reason)) > 0
          and locked_by is null
          and locked_at is null
          and lease_token is null
          and lease_expires_at is null
        )
        or (
          status in ('queued', 'running', 'retry_scheduled')
          and terminal_at is null
          and terminal_reason is null
        )
      );
  end if;
end
$migration$;

create index if not exists ingestion_tasks_claimable_idx
  on public.ingestion_tasks (priority desc, next_attempt_at, created_at)
  where status in ('queued', 'retry_scheduled');
create index if not exists ingestion_tasks_expired_lease_idx
  on public.ingestion_tasks (lease_expires_at)
  where status = 'running' and lease_expires_at is not null;
create index if not exists ingestion_tasks_run_status_idx
  on public.ingestion_tasks (ingestion_run_id, status, created_at);

create table if not exists public.ingestion_run_events (
  id uuid primary key default gen_random_uuid(),
  ingestion_run_id uuid not null references public.ingestion_runs(id) on delete restrict,
  ingestion_task_id uuid references public.ingestion_tasks(id) on delete restrict,
  event_key text,
  event_type text not null,
  severity text not null default 'info',
  message text,
  payload_json jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint ingestion_run_events_event_key_not_blank check (
    event_key is null or length(trim(event_key)) > 0
  ),
  constraint ingestion_run_events_event_type_check check (
    event_type ~ '^[a-z][a-z0-9_.-]*$'
  ),
  constraint ingestion_run_events_severity_check check (
    severity in ('debug', 'info', 'warning', 'error')
  ),
  constraint ingestion_run_events_message_not_blank check (
    message is null or length(trim(message)) > 0
  ),
  constraint ingestion_run_events_payload_json_object check (
    jsonb_typeof(payload_json) = 'object'
  )
);

create unique index if not exists ingestion_run_events_run_event_key
  on public.ingestion_run_events (ingestion_run_id, event_key)
  where event_key is not null;
create index if not exists ingestion_run_events_run_occurred_idx
  on public.ingestion_run_events (ingestion_run_id, occurred_at, id);
create index if not exists ingestion_run_events_task_occurred_idx
  on public.ingestion_run_events (ingestion_task_id, occurred_at)
  where ingestion_task_id is not null;

create table if not exists public.ingestion_checkpoints (
  id uuid primary key default gen_random_uuid(),
  social_account_id uuid not null references public.social_accounts(id) on delete cascade,
  platform text not null,
  stream_key text not null default 'default',
  cursor_json jsonb not null default '{}'::jsonb,
  high_watermark_at timestamptz,
  last_successful_run_id uuid references public.ingestion_runs(id) on delete set null,
  last_success_at timestamptz,
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ingestion_checkpoints_platform_normalized check (
    length(trim(platform)) > 0 and platform = lower(trim(platform))
  ),
  constraint ingestion_checkpoints_stream_key_not_blank check (
    length(trim(stream_key)) > 0
  ),
  constraint ingestion_checkpoints_cursor_json_object check (
    jsonb_typeof(cursor_json) = 'object'
  ),
  constraint ingestion_checkpoints_version_nonnegative check (version >= 0),
  constraint ingestion_checkpoints_success_time_together check (
    last_success_at is null or last_successful_run_id is not null
  ),
  constraint ingestion_checkpoints_account_platform_key unique (
    social_account_id,
    platform,
    stream_key
  )
);

create index if not exists ingestion_checkpoints_platform_updated_idx
  on public.ingestion_checkpoints (platform, updated_at);

create table if not exists public.provider_rate_limits (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  scope_key text not null default 'global',
  limit_value bigint,
  remaining bigint,
  reset_at timestamptz,
  blocked_until timestamptz,
  consecutive_failures integer not null default 0,
  last_response_at timestamptz,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_rate_limits_provider_normalized check (
    length(trim(provider)) > 0 and provider = lower(trim(provider))
  ),
  constraint provider_rate_limits_scope_key_not_blank check (
    length(trim(scope_key)) > 0
  ),
  constraint provider_rate_limits_limit_nonnegative check (
    limit_value is null or limit_value >= 0
  ),
  constraint provider_rate_limits_remaining_nonnegative check (
    remaining is null or remaining >= 0
  ),
  constraint provider_rate_limits_remaining_within_limit check (
    remaining is null or limit_value is null or remaining <= limit_value
  ),
  constraint provider_rate_limits_failures_nonnegative check (
    consecutive_failures >= 0
  ),
  constraint provider_rate_limits_metadata_json_object check (
    jsonb_typeof(metadata_json) = 'object'
  ),
  constraint provider_rate_limits_provider_scope_key unique (provider, scope_key)
);

create index if not exists provider_rate_limits_blocked_until_idx
  on public.provider_rate_limits (blocked_until)
  where blocked_until is not null;
create index if not exists provider_rate_limits_reset_at_idx
  on public.provider_rate_limits (reset_at)
  where reset_at is not null;

create table if not exists public.ingestion_dead_letters (
  id uuid primary key default gen_random_uuid(),
  ingestion_task_id uuid not null unique references public.ingestion_tasks(id) on delete restrict,
  ingestion_run_id uuid references public.ingestion_runs(id) on delete restrict,
  failure_kind text not null,
  failure_message text,
  attempts integer not null,
  task_snapshot_json jsonb not null,
  error_json jsonb not null default '{}'::jsonb,
  status text not null default 'open',
  dead_lettered_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ingestion_dead_letters_failure_kind_not_blank check (
    length(trim(failure_kind)) > 0
  ),
  constraint ingestion_dead_letters_attempts_positive check (attempts > 0),
  constraint ingestion_dead_letters_task_snapshot_json_object check (
    jsonb_typeof(task_snapshot_json) = 'object'
  ),
  constraint ingestion_dead_letters_error_json_object check (
    jsonb_typeof(error_json) = 'object'
  ),
  constraint ingestion_dead_letters_status_check check (
    status in ('open', 'requeued', 'resolved', 'dismissed')
  ),
  constraint ingestion_dead_letters_resolution_time_check check (
    resolved_at is null or resolved_at >= dead_lettered_at
  ),
  constraint ingestion_dead_letters_resolution_note_not_blank check (
    resolution_note is null or length(trim(resolution_note)) > 0
  )
);

create index if not exists ingestion_dead_letters_open_idx
  on public.ingestion_dead_letters (dead_lettered_at)
  where status = 'open';
create index if not exists ingestion_dead_letters_run_idx
  on public.ingestion_dead_letters (ingestion_run_id, dead_lettered_at)
  where ingestion_run_id is not null;

create table if not exists public.ingestion_coverage_reports (
  id uuid primary key default gen_random_uuid(),
  ingestion_run_id uuid not null references public.ingestion_runs(id) on delete restrict,
  batch_id uuid references public.batches(id) on delete set null,
  report_key text not null,
  platform text,
  expected_count integer not null default 0,
  attempted_count integer not null default 0,
  succeeded_count integer not null default 0,
  failed_count integer not null default 0,
  skipped_count integer not null default 0,
  report_json jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint ingestion_coverage_reports_key_not_blank check (
    length(trim(report_key)) > 0
  ),
  constraint ingestion_coverage_reports_platform_not_blank check (
    platform is null or length(trim(platform)) > 0
  ),
  constraint ingestion_coverage_reports_counts_nonnegative check (
    expected_count >= 0
    and attempted_count >= 0
    and succeeded_count >= 0
    and failed_count >= 0
    and skipped_count >= 0
  ),
  constraint ingestion_coverage_reports_report_json_object check (
    jsonb_typeof(report_json) = 'object'
  ),
  constraint ingestion_coverage_reports_run_key unique (ingestion_run_id, report_key)
);

create index if not exists ingestion_coverage_reports_batch_generated_idx
  on public.ingestion_coverage_reports (batch_id, generated_at desc)
  where batch_id is not null;

create table if not exists public.ingestion_artifact_manifests (
  id uuid primary key default gen_random_uuid(),
  ingestion_run_id uuid not null references public.ingestion_runs(id) on delete restrict,
  ingestion_task_id uuid references public.ingestion_tasks(id) on delete restrict,
  artifact_key text not null,
  artifact_type text not null,
  storage_uri text not null,
  content_type text,
  byte_size bigint,
  sha256 text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ingestion_artifact_manifests_key_not_blank check (
    length(trim(artifact_key)) > 0
  ),
  constraint ingestion_artifact_manifests_type_not_blank check (
    length(trim(artifact_type)) > 0
  ),
  constraint ingestion_artifact_manifests_storage_uri_not_blank check (
    length(trim(storage_uri)) > 0
  ),
  constraint ingestion_artifact_manifests_content_type_not_blank check (
    content_type is null or length(trim(content_type)) > 0
  ),
  constraint ingestion_artifact_manifests_byte_size_nonnegative check (
    byte_size is null or byte_size >= 0
  ),
  constraint ingestion_artifact_manifests_sha256_check check (
    sha256 is null or sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint ingestion_artifact_manifests_metadata_json_object check (
    jsonb_typeof(metadata_json) = 'object'
  ),
  constraint ingestion_artifact_manifests_run_key unique (
    ingestion_run_id,
    artifact_key
  )
);

create index if not exists ingestion_artifact_manifests_task_idx
  on public.ingestion_artifact_manifests (ingestion_task_id, created_at)
  where ingestion_task_id is not null;

drop trigger if exists set_ingestion_checkpoints_updated_at on public.ingestion_checkpoints;
create trigger set_ingestion_checkpoints_updated_at
before update on public.ingestion_checkpoints
for each row execute function public.set_updated_at();

drop trigger if exists set_provider_rate_limits_updated_at on public.provider_rate_limits;
create trigger set_provider_rate_limits_updated_at
before update on public.provider_rate_limits
for each row execute function public.set_updated_at();

drop trigger if exists set_ingestion_dead_letters_updated_at on public.ingestion_dead_letters;
create trigger set_ingestion_dead_letters_updated_at
before update on public.ingestion_dead_letters
for each row execute function public.set_updated_at();

create or replace function public.reject_append_only_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
begin
  raise exception '% is append-only', tg_table_name
    using errcode = '55000';
end;
$function$;

drop trigger if exists ingestion_run_events_append_only on public.ingestion_run_events;
create trigger ingestion_run_events_append_only
before update or delete on public.ingestion_run_events
for each row execute function public.reject_append_only_mutation();

drop trigger if exists metric_observations_append_only on public.metric_observations;
create trigger metric_observations_append_only
before update or delete on public.metric_observations
for each row execute function public.reject_append_only_mutation();

create or replace function public.preserve_evidence_first_seen_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
begin
  new.first_seen_at := least(old.first_seen_at, new.first_seen_at);
  return new;
end;
$function$;

drop trigger if exists evidence_items_preserve_first_seen_at on public.evidence_items;
create trigger evidence_items_preserve_first_seen_at
before update on public.evidence_items
for each row execute function public.preserve_evidence_first_seen_at();

create or replace function public.claim_ingestion_runtime_lock(
  p_lock_key text,
  p_owner_id text,
  p_lease_duration interval default interval '10 minutes',
  p_metadata_json jsonb default '{}'::jsonb
)
returns setof public.ingestion_runtime_locks
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_lock public.ingestion_runtime_locks;
begin
  if p_lock_key is null or length(trim(p_lock_key)) = 0
    or p_owner_id is null or length(trim(p_owner_id)) = 0 then
    raise exception 'lock key and owner id are required' using errcode = '22023';
  end if;
  if p_lease_duration <= interval '0 seconds' or p_lease_duration > interval '1 hour' then
    raise exception 'lease duration must be greater than zero and at most one hour'
      using errcode = '22023';
  end if;
  if p_metadata_json is null or jsonb_typeof(p_metadata_json) <> 'object' then
    raise exception 'lock metadata must be a JSON object' using errcode = '22023';
  end if;

  insert into public.ingestion_runtime_locks as runtime_lock (
    lock_key,
    owner_id,
    lease_token,
    heartbeat_at,
    lease_expires_at,
    metadata_json
  ) values (
    trim(p_lock_key),
    trim(p_owner_id),
    pg_catalog.gen_random_uuid(),
    clock_timestamp(),
    clock_timestamp() + p_lease_duration,
    p_metadata_json
  )
  on conflict (lock_key) do update
  set owner_id = excluded.owner_id,
      lease_token = pg_catalog.gen_random_uuid(),
      heartbeat_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + p_lease_duration,
      metadata_json = excluded.metadata_json,
      updated_at = clock_timestamp()
  where runtime_lock.lease_expires_at <= clock_timestamp()
     or runtime_lock.owner_id = excluded.owner_id
  returning * into v_lock;

  if v_lock.lock_key is not null then
    return next v_lock;
  end if;
  return;
end;
$function$;

create or replace function public.renew_ingestion_runtime_lock(
  p_lock_key text,
  p_owner_id text,
  p_lease_token uuid,
  p_lease_duration interval default interval '10 minutes'
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_updated integer;
begin
  if p_lease_duration <= interval '0 seconds' or p_lease_duration > interval '1 hour' then
    raise exception 'lease duration must be greater than zero and at most one hour'
      using errcode = '22023';
  end if;
  update public.ingestion_runtime_locks
  set heartbeat_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + p_lease_duration,
      updated_at = clock_timestamp()
  where lock_key = trim(p_lock_key)
    and owner_id = trim(p_owner_id)
    and lease_token = p_lease_token
    and lease_expires_at > clock_timestamp();
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

create or replace function public.release_ingestion_runtime_lock(
  p_lock_key text,
  p_owner_id text,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_deleted integer;
begin
  delete from public.ingestion_runtime_locks
  where lock_key = trim(p_lock_key)
    and owner_id = trim(p_owner_id)
    and lease_token = p_lease_token;
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$function$;

create or replace function public.finalize_completed_ingestion_run(
  p_run_id uuid,
  p_lease_owner text,
  p_lease_token uuid,
  p_stats_json jsonb default '{}'::jsonb
)
returns setof public.ingestion_runs
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_run public.ingestion_runs;
begin
  if p_stats_json is null or jsonb_typeof(p_stats_json) <> 'object' then
    raise exception 'run stats must be a JSON object' using errcode = '22023';
  end if;

  select * into v_run
  from public.ingestion_runs
  where id = p_run_id
  for update;

  if v_run.id is null
    or v_run.status not in ('queued', 'running')
    or v_run.lease_owner is distinct from p_lease_owner
    or v_run.lease_token is distinct from p_lease_token
    or v_run.lease_expires_at is null
    or v_run.lease_expires_at <= clock_timestamp() then
    return;
  end if;

  if exists (
    select 1
    from public.ingestion_tasks
    where ingestion_run_id = p_run_id
      and status not in (
        'completed', 'needs_review', 'blocked_or_empty', 'skipped',
        'failed', 'canceled', 'dead_lettered'
      )
  ) then
    raise exception 'ingestion run still has nonterminal tasks' using errcode = '55000';
  end if;

  update public.ingestion_runs
  set status = 'completed',
      finished_at = clock_timestamp(),
      heartbeat_at = clock_timestamp(),
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      stats_json = p_stats_json,
      errors_json = '[]'::jsonb
  where id = p_run_id
  returning * into v_run;

  return next v_run;
end;
$function$;

create or replace function public.claim_ingestion_tasks(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_duration interval default interval '5 minutes',
  p_ingestion_run_id uuid default null,
  p_platform text default null
)
returns setof public.ingestion_tasks
language plpgsql
security definer
set search_path = pg_catalog
as $function$
begin
  if p_worker_id is null or length(trim(p_worker_id)) = 0 then
    raise exception 'worker id must not be blank' using errcode = '22023';
  end if;
  if p_limit < 1 or p_limit > 100 then
    raise exception 'claim limit must be between 1 and 100' using errcode = '22023';
  end if;
  if p_lease_duration <= interval '0 seconds'
    or p_lease_duration > interval '1 hour' then
    raise exception 'lease duration must be greater than zero and at most one hour'
      using errcode = '22023';
  end if;

  return query
  with candidates as materialized (
    select task.id
    from public.ingestion_tasks as task
    where task.status in ('queued', 'retry_scheduled')
      and task.attempts < task.max_attempts
      and coalesce(task.next_attempt_at, task.created_at) <= clock_timestamp()
      and (task.lease_expires_at is null or task.lease_expires_at <= clock_timestamp())
      and (p_ingestion_run_id is null or task.ingestion_run_id = p_ingestion_run_id)
      and (p_platform is null or task.platform = p_platform)
    order by
      task.priority desc,
      coalesce(task.next_attempt_at, task.created_at),
      task.created_at,
      task.id
    for update of task skip locked
    limit p_limit
  )
  update public.ingestion_tasks as task
  set status = 'running',
      attempts = task.attempts + 1,
      last_attempt_at = clock_timestamp(),
      locked_by = trim(p_worker_id),
      locked_at = clock_timestamp(),
      lease_token = pg_catalog.gen_random_uuid(),
      lease_expires_at = clock_timestamp() + p_lease_duration,
      terminal_at = null,
      terminal_reason = null,
      updated_at = clock_timestamp()
  from candidates
  where task.id = candidates.id
  returning task.*;
end;
$function$;

create or replace function public.renew_ingestion_task_lease(
  p_task_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_lease_duration interval default interval '5 minutes'
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_updated integer;
begin
  if p_task_id is null or p_lease_token is null
    or p_worker_id is null or length(trim(p_worker_id)) = 0 then
    raise exception 'task id, worker id, and lease token are required'
      using errcode = '22023';
  end if;
  if p_lease_duration <= interval '0 seconds'
    or p_lease_duration > interval '1 hour' then
    raise exception 'lease duration must be greater than zero and at most one hour'
      using errcode = '22023';
  end if;

  update public.ingestion_tasks
  set lease_expires_at = clock_timestamp() + p_lease_duration,
      locked_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = p_task_id
    and status = 'running'
    and locked_by = trim(p_worker_id)
    and lease_token = p_lease_token
    and lease_expires_at > clock_timestamp();

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

create or replace function public.requeue_expired_ingestion_tasks(
  p_limit integer default 100
)
returns setof public.ingestion_tasks
language plpgsql
security definer
set search_path = pg_catalog
as $function$
begin
  if p_limit < 1 or p_limit > 1000 then
    raise exception 'requeue limit must be between 1 and 1000' using errcode = '22023';
  end if;

  return query
  with candidates as materialized (
    select task.id
    from public.ingestion_tasks as task
    where task.status = 'running'
      and task.lease_expires_at is not null
      and task.lease_expires_at <= clock_timestamp()
    order by task.lease_expires_at, task.id
    for update of task skip locked
    limit p_limit
  ),
  updated as (
    update public.ingestion_tasks as task
    set status = case
          when task.attempts >= task.max_attempts then 'dead_lettered'
          else 'retry_scheduled'
        end,
        next_attempt_at = case
          when task.attempts >= task.max_attempts then null
          else clock_timestamp() + make_interval(
            secs => least(
              3600,
              task.retry_base_delay_seconds
                * power(2, least(greatest(task.attempts - 1, 0), 10))::integer
            )
          )
        end,
        terminal_at = case
          when task.attempts >= task.max_attempts then clock_timestamp()
          else null
        end,
        terminal_reason = case
          when task.attempts >= task.max_attempts then 'lease_expired_after_max_attempts'
          else null
        end,
        last_failure_kind = 'lease_expired',
        last_error = coalesce(task.last_error, 'worker lease expired'),
        last_error_json = jsonb_build_object(
          'kind', 'lease_expired',
          'expired_at', task.lease_expires_at,
          'worker_id', task.locked_by
        ),
        locked_by = null,
        locked_at = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = clock_timestamp()
    from candidates
    where task.id = candidates.id
    returning task.*
  ),
  dead_lettered as (
    insert into public.ingestion_dead_letters (
      ingestion_task_id,
      ingestion_run_id,
      failure_kind,
      failure_message,
      attempts,
      task_snapshot_json,
      error_json
    )
    select
      task.id,
      task.ingestion_run_id,
      coalesce(task.last_failure_kind, 'lease_expired'),
      task.last_error,
      task.attempts,
      to_jsonb(task),
      task.last_error_json
    from updated as task
    where task.status = 'dead_lettered'
    on conflict (ingestion_task_id) do update
    set ingestion_run_id = excluded.ingestion_run_id,
        failure_kind = excluded.failure_kind,
        failure_message = excluded.failure_message,
        attempts = excluded.attempts,
        task_snapshot_json = excluded.task_snapshot_json,
        error_json = excluded.error_json,
        status = 'open',
        dead_lettered_at = clock_timestamp(),
        resolved_at = null,
        resolution_note = null,
        updated_at = clock_timestamp()
    returning ingestion_task_id
  )
  select task.*
  from updated as task
  left join dead_lettered on dead_lettered.ingestion_task_id = task.id;
end;
$function$;

-- Internal operational state is available only to the service role. No RLS
-- policies are created for API client roles; service_role bypasses RLS.
alter table public.ingestion_runs enable row level security;
alter table public.ingestion_runtime_locks enable row level security;
alter table public.ingestion_tasks enable row level security;
alter table public.metric_observations enable row level security;
alter table public.ingestion_run_events enable row level security;
alter table public.ingestion_checkpoints enable row level security;
alter table public.provider_rate_limits enable row level security;
alter table public.ingestion_dead_letters enable row level security;
alter table public.ingestion_coverage_reports enable row level security;
alter table public.ingestion_artifact_manifests enable row level security;

revoke all privileges on table public.ingestion_runs from anon, authenticated;
revoke all privileges on table public.ingestion_runtime_locks from anon, authenticated;
revoke all privileges on table public.ingestion_tasks from anon, authenticated;
revoke all privileges on table public.metric_observations from anon, authenticated;
revoke all privileges on table public.ingestion_run_events from anon, authenticated;
revoke all privileges on table public.ingestion_checkpoints from anon, authenticated;
revoke all privileges on table public.provider_rate_limits from anon, authenticated;
revoke all privileges on table public.ingestion_dead_letters from anon, authenticated;
revoke all privileges on table public.ingestion_coverage_reports from anon, authenticated;
revoke all privileges on table public.ingestion_artifact_manifests from anon, authenticated;

revoke all privileges on table public.ingestion_runs from service_role;
revoke all privileges on table public.ingestion_runtime_locks from service_role;
revoke all privileges on table public.ingestion_tasks from service_role;
revoke all privileges on table public.metric_observations from service_role;
revoke all privileges on table public.ingestion_run_events from service_role;
revoke all privileges on table public.ingestion_checkpoints from service_role;
revoke all privileges on table public.provider_rate_limits from service_role;
revoke all privileges on table public.ingestion_dead_letters from service_role;
revoke all privileges on table public.ingestion_coverage_reports from service_role;
revoke all privileges on table public.ingestion_artifact_manifests from service_role;
grant select, insert, update on table public.ingestion_runs to service_role;
grant select, insert, update, delete on table public.ingestion_runtime_locks to service_role;
grant select, insert, update on table public.ingestion_tasks to service_role;
grant select, insert on table public.metric_observations to service_role;
grant select, insert on table public.ingestion_run_events to service_role;
grant select, insert, update on table public.ingestion_checkpoints to service_role;
grant select, insert, update on table public.provider_rate_limits to service_role;
grant select, insert, update on table public.ingestion_dead_letters to service_role;
grant select, insert, update on table public.ingestion_coverage_reports to service_role;
grant select, insert, update on table public.ingestion_artifact_manifests to service_role;

revoke all on function public.reject_append_only_mutation() from public, anon, authenticated;
revoke all on function public.preserve_evidence_first_seen_at() from public, anon, authenticated;
revoke all on function public.claim_ingestion_runtime_lock(text, text, interval, jsonb)
  from public, anon, authenticated;
revoke all on function public.renew_ingestion_runtime_lock(text, text, uuid, interval)
  from public, anon, authenticated;
revoke all on function public.release_ingestion_runtime_lock(text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.finalize_completed_ingestion_run(uuid, text, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.claim_ingestion_tasks(text, integer, interval, uuid, text)
  from public, anon, authenticated;
revoke all on function public.renew_ingestion_task_lease(uuid, text, uuid, interval)
  from public, anon, authenticated;
revoke all on function public.requeue_expired_ingestion_tasks(integer)
  from public, anon, authenticated;

grant execute on function public.claim_ingestion_tasks(text, integer, interval, uuid, text)
  to service_role;
grant execute on function public.claim_ingestion_runtime_lock(text, text, interval, jsonb)
  to service_role;
grant execute on function public.renew_ingestion_runtime_lock(text, text, uuid, interval)
  to service_role;
grant execute on function public.release_ingestion_runtime_lock(text, text, uuid)
  to service_role;
grant execute on function public.finalize_completed_ingestion_run(uuid, text, uuid, jsonb)
  to service_role;
grant execute on function public.renew_ingestion_task_lease(uuid, text, uuid, interval)
  to service_role;
grant execute on function public.requeue_expired_ingestion_tasks(integer)
  to service_role;
