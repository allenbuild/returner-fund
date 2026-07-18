import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "008_autonomous_ingestion_runtime.sql"
);
const migrationSql = fs.readFileSync(migrationPath, "utf8");
const normalizedSql = normalizeSql(migrationSql);

const runtimeTables = [
  "ingestion_runs",
  "ingestion_tasks",
  "metric_observations",
  "ingestion_runtime_locks",
  "ingestion_run_events",
  "ingestion_checkpoints",
  "provider_rate_limits",
  "ingestion_dead_letters",
  "ingestion_coverage_reports",
  "ingestion_artifact_manifests"
] as const;

const newRuntimeTables = runtimeTables.slice(3);

describe("autonomous ingestion runtime migration", () => {
  it("adds idempotent, observable, leased run coordination", () => {
    for (const column of [
      "idempotency_key text",
      "heartbeat_at timestamptz",
      "lease_owner text",
      "lease_token uuid",
      "lease_expires_at timestamptz",
      "stats_json jsonb not null default '{}'::jsonb"
    ]) {
      expect(normalizedSql).toContain(column);
    }

    expect(normalizedSql).toContain(
      "create unique index if not exists ingestion_runs_idempotency_key_key"
    );
    expect(normalizedSql).toContain("where idempotency_key is not null");
    expect(normalizedSql).toContain("ingestion_runs_active_lease_idx");
    expect(normalizedSql).toContain("ingestion_runs_heartbeat_idx");
    expect(normalizedSql).toContain("create table if not exists public.ingestion_run_events");
    expect(normalizedSql).toContain("ingestion_run_events_run_event_key");
    expect(normalizedSql).toContain("create table if not exists public.ingestion_runtime_locks");
    expect(normalizedSql).toContain("ingestion_runtime_locks_key_not_blank");
    expect(normalizedSql).toContain("ingestion_runtime_locks_lease_after_heartbeat");
  });

  it("claims, renews, and releases the global runtime lock by owner and token", () => {
    const claimFunction = extractFunction(migrationSql, "claim_ingestion_runtime_lock");
    const renewFunction = extractFunction(migrationSql, "renew_ingestion_runtime_lock");
    const releaseFunction = extractFunction(migrationSql, "release_ingestion_runtime_lock");

    expect(normalizeSql(claimFunction)).toContain("on conflict (lock_key) do update");
    expect(normalizeSql(claimFunction)).toContain("returns setof public.ingestion_runtime_locks");
    expect(normalizeSql(claimFunction)).toContain("if v_lock.lock_key is not null then return next v_lock");
    expect(normalizeSql(claimFunction)).toContain("runtime_lock.lease_expires_at <= clock_timestamp()");
    expect(normalizeSql(claimFunction)).toContain("runtime_lock.owner_id = excluded.owner_id");
    expect(normalizeSql(renewFunction)).toContain("and lease_token = p_lease_token");
    expect(normalizeSql(renewFunction)).toContain("and lease_expires_at > clock_timestamp()");
    expect(normalizeSql(releaseFunction)).toContain("and lease_token = p_lease_token");
  });

  it("defines bounded retries, expiring task leases, and explicit terminal states", () => {
    for (const column of [
      "max_attempts integer not null default 5",
      "priority integer not null default 0",
      "next_attempt_at timestamptz",
      "retry_base_delay_seconds integer not null default 30",
      "lease_token uuid",
      "lease_expires_at timestamptz",
      "terminal_at timestamptz",
      "terminal_reason text",
      "last_failure_kind text",
      "last_error_json jsonb not null default '{}'::jsonb"
    ]) {
      expect(normalizedSql).toContain(column);
    }

    for (const state of [
      "'retry_scheduled'",
      "'completed'",
      "'needs_review'",
      "'blocked_or_empty'",
      "'skipped'",
      "'failed'",
      "'canceled'",
      "'dead_lettered'"
    ]) {
      expect(normalizedSql).toContain(state);
    }

    expect(normalizedSql).toContain("ingestion_tasks_claimable_idx");
    expect(normalizedSql).toContain("ingestion_tasks_expired_lease_idx");
    expect(normalizedSql).toContain("ingestion_tasks_terminal_at_status");
    expect(normalizedSql).toContain("ingestion_tasks_terminal_state_complete");
    expect(normalizedSql).toContain("and terminal_at is not null and terminal_reason is not null");
    expect(normalizedSql).toContain("and lease_token is null and lease_expires_at is null");
  });

  it("persists checkpoints, rate limits, dead letters, coverage, and artifacts", () => {
    for (const tableName of newRuntimeTables) {
      expect(normalizedSql).toContain(`create table if not exists public.${tableName}`);
    }

    expect(normalizedSql).toContain(
      "constraint ingestion_checkpoints_account_platform_key unique"
    );
    expect(normalizedSql).toContain(
      "constraint provider_rate_limits_provider_scope_key unique (provider, scope_key)"
    );
    expect(normalizedSql).toContain("blocked_until timestamptz");
    expect(normalizedSql).toContain("consecutive_failures integer not null default 0");
    expect(normalizedSql).toContain("task_snapshot_json jsonb not null");
    expect(normalizedSql).toContain("constraint ingestion_coverage_reports_run_key unique");
    expect(normalizedSql).toContain("sha256 is null or sha256 ~ '^[0-9a-f]{64}$'");
    expect(normalizedSql).toContain("constraint ingestion_artifact_manifests_run_key unique");
  });

  it("makes run events and metric observations append-only", () => {
    expect(normalizedSql).toContain("create or replace function public.reject_append_only_mutation()");
    expect(normalizedSql).toContain("before update or delete on public.ingestion_run_events");
    expect(normalizedSql).toContain("before update or delete on public.metric_observations");
    expect(normalizedSql).toContain("raise exception '% is append-only'");
  });

  it("preserves the earliest durable evidence observation across upserts", () => {
    expect(normalizedSql).toContain("create or replace function public.preserve_evidence_first_seen_at()");
    expect(normalizedSql).toContain("new.first_seen_at := least(old.first_seen_at, new.first_seen_at)");
    expect(normalizedSql).toContain("before update on public.evidence_items");
  });

  it("claims and requeues tasks with skip-locked row ownership", () => {
    const claimFunction = extractFunction(migrationSql, "claim_ingestion_tasks");
    const renewFunction = extractFunction(migrationSql, "renew_ingestion_task_lease");
    const requeueFunction = extractFunction(migrationSql, "requeue_expired_ingestion_tasks");

    expect(normalizeSql(claimFunction)).toContain("for update of task skip locked");
    expect(normalizeSql(claimFunction)).toContain("task.attempts < task.max_attempts");
    expect(normalizeSql(claimFunction)).toContain("set status = 'running'");
    expect(normalizeSql(claimFunction)).toContain("lease_token = public.gen_random_uuid()");
    expect(normalizeSql(claimFunction)).toContain("lease_expires_at = clock_timestamp()");

    expect(normalizeSql(renewFunction)).toContain("and lease_token = p_lease_token");
    expect(normalizeSql(renewFunction)).toContain("and lease_expires_at > clock_timestamp()");

    expect(normalizeSql(requeueFunction)).toContain("for update of task skip locked");
    expect(normalizeSql(requeueFunction)).toContain("then 'dead_lettered'");
    expect(normalizeSql(requeueFunction)).toContain("else 'retry_scheduled'");
    expect(normalizeSql(requeueFunction)).toContain("insert into public.ingestion_dead_letters");
    expect(normalizeSql(requeueFunction)).toContain("on conflict (ingestion_task_id) do update");
  });

  it("atomically fences completed runs on the active lease and terminal task set", () => {
    const finalizeFunction = extractFunction(migrationSql, "finalize_completed_ingestion_run");
    const sql = normalizeSql(finalizeFunction);
    expect(sql).toContain("for update");
    expect(sql).toContain("v_run.lease_owner is distinct from p_lease_owner");
    expect(sql).toContain("v_run.lease_token is distinct from p_lease_token");
    expect(sql).toContain("v_run.lease_expires_at <= clock_timestamp()");
    expect(sql).toContain("status not in ( 'completed', 'needs_review', 'blocked_or_empty', 'skipped', 'failed', 'canceled', 'dead_lettered' )");
    expect(sql).toContain("set status = 'completed'");
  });

  it("keeps all runtime state service-role-only behind RLS", () => {
    expect(normalizedSql).not.toContain("create policy");

    for (const tableName of runtimeTables) {
      expect(normalizedSql).toContain(`alter table public.${tableName} enable row level security;`);
      expect(normalizedSql).toContain(
        `revoke all privileges on table public.${tableName} from anon, authenticated;`
      );
      expect(findGrantees(migrationSql, tableName)).toEqual(["service_role"]);
    }

    for (const signature of [
      "public.claim_ingestion_runtime_lock(text, text, interval, jsonb)",
      "public.renew_ingestion_runtime_lock(text, text, uuid, interval)",
      "public.release_ingestion_runtime_lock(text, text, uuid)",
      "public.finalize_completed_ingestion_run(uuid, text, uuid, jsonb)",
      "public.claim_ingestion_tasks(text, integer, interval, uuid, text)",
      "public.renew_ingestion_task_lease(uuid, text, uuid, interval)",
      "public.requeue_expired_ingestion_tasks(integer)"
    ]) {
      expect(normalizedSql).toContain(
        `revoke all on function ${signature} from public, anon, authenticated;`
      );
      expect(normalizedSql).toContain(`grant execute on function ${signature} to service_role;`);
    }

    for (const functionName of [
      "claim_ingestion_runtime_lock",
      "renew_ingestion_runtime_lock",
      "release_ingestion_runtime_lock",
      "finalize_completed_ingestion_run",
      "claim_ingestion_tasks",
      "renew_ingestion_task_lease",
      "requeue_expired_ingestion_tasks"
    ]) {
      expect(normalizeSql(extractFunction(migrationSql, functionName))).toContain(
        "security definer set search_path = pg_catalog"
      );
    }
  });
});

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractFunction(sql: string, functionName: string): string {
  const match = sql.match(
    new RegExp(
      `create\\s+or\\s+replace\\s+function\\s+public\\.${functionName}\\s*\\([\\s\\S]*?\\n\\$function\\$;`,
      "i"
    )
  );

  if (!match) {
    throw new Error(`Migration does not define ${functionName}.`);
  }

  return match[0];
}

function findGrantees(sql: string, tableName: string): string[] {
  const grantPattern = new RegExp(
    `grant\\s+[^;]+?\\s+on\\s+table\\s+public\\.${tableName}\\s+to\\s+([^;]+);`,
    "gi"
  );

  return Array.from(
    new Set(
      Array.from(sql.matchAll(grantPattern), (match) => normalizeSql(match[1]))
    )
  );
}
