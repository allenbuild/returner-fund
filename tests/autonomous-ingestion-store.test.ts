import { describe, expect, it } from "vitest";
import {
  AutonomousIngestionConcurrencyError,
  AutonomousIngestionStore,
  type IngestionArtifactManifestRow,
  type IngestionCheckpointRow,
  type IngestionCoverageReportRow,
  type IngestionRunEventRow,
  type IngestionRunRow,
  type IngestionTaskRow,
  type SupabaseLikeClient,
  type SupabaseQuery,
  type SupabaseResponse
} from "@/lib/workers/autonomous-ingestion-store";

const NOW = new Date("2026-07-18T12:00:00.000Z");

interface ClientCall {
  kind: "from" | "query" | "rpc";
  table?: string;
  method?: string;
  args?: unknown[];
  functionName?: string;
  rpcArgs?: Record<string, unknown>;
}

class ScriptedSupabaseClient implements SupabaseLikeClient {
  readonly calls: ClientCall[] = [];
  private readonly responses: SupabaseResponse<unknown>[];

  constructor(...responses: SupabaseResponse<unknown>[]) {
    this.responses = [...responses];
  }

  from<T = unknown>(table: string): SupabaseQuery<T> {
    this.calls.push({ kind: "from", table });
    return new ScriptedQuery<T>(this, table);
  }

  rpc<T = unknown>(
    functionName: string,
    rpcArgs: Record<string, unknown>
  ): PromiseLike<SupabaseResponse<T>> {
    this.calls.push({ kind: "rpc", functionName, rpcArgs });
    return Promise.resolve(this.take<T>());
  }

  record(table: string, method: string, args: unknown[]): void {
    this.calls.push({ kind: "query", table, method, args });
  }

  take<T>(): SupabaseResponse<T> {
    const response = this.responses.shift();
    if (!response) throw new Error("Scripted client ran out of responses.");
    return response as SupabaseResponse<T>;
  }

  assertExhausted(): void {
    expect(this.responses).toHaveLength(0);
  }
}

class ScriptedQuery<T> implements SupabaseQuery<T> {
  constructor(
    private readonly client: ScriptedSupabaseClient,
    private readonly table: string
  ) {}

  insert(values: unknown): SupabaseQuery<T> {
    return this.record("insert", values);
  }

  upsert(values: unknown, options?: { onConflict?: string; ignoreDuplicates?: boolean }): SupabaseQuery<T> {
    return this.record("upsert", values, options);
  }

  update(values: unknown): SupabaseQuery<T> {
    return this.record("update", values);
  }

  select(columns?: string, options?: { count?: "exact"; head?: boolean }): SupabaseQuery<T> {
    return this.record("select", columns, options);
  }

  eq(column: string, value: unknown): SupabaseQuery<T> {
    return this.record("eq", column, value);
  }

  gt(column: string, value: unknown): SupabaseQuery<T> {
    return this.record("gt", column, value);
  }

  in(column: string, values: readonly unknown[]): SupabaseQuery<T> {
    return this.record("in", column, values);
  }

  limit(value: number): SupabaseQuery<T> {
    return this.record("limit", value);
  }

  is(column: string, value: null): SupabaseQuery<T> {
    return this.record("is", column, value);
  }

  not(column: string, operator: string, value: unknown): SupabaseQuery<T> {
    return this.record("not", column, operator, value);
  }

  single(): SupabaseQuery<T> {
    return this.record("single");
  }

  maybeSingle(): SupabaseQuery<T> {
    return this.record("maybeSingle");
  }

  then<TResult1 = SupabaseResponse<T>, TResult2 = never>(
    onfulfilled?: ((value: SupabaseResponse<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.client.take<T>()).then(onfulfilled, onrejected);
  }

  private record(method: string, ...args: unknown[]): SupabaseQuery<T> {
    this.client.record(this.table, method, args);
    return this;
  }
}

describe("AutonomousIngestionStore", () => {
  it("creates and leases a run under its orchestration key", async () => {
    const createdRun = runRow({ lease_token: "lease-new", lease_owner: "worker-a" });
    const client = new ScriptedSupabaseClient(ok(createdRun));
    const store = createStore(client);

    const result = await store.claimOrCreateRun({
      orchestrationKey: "scheduled:2026-07-18",
      workerId: "worker-a",
      leaseToken: "lease-new",
      leaseDurationSeconds: 600,
      batchId: "batch-1"
    });

    expect(result).toEqual({
      run: createdRun,
      claimed: true,
      created: true,
      leaseToken: "lease-new"
    });
    expect(queryCall(client, "insert").args?.[0]).toMatchObject({
      idempotency_key: "scheduled:2026-07-18",
      lease_owner: "worker-a",
      lease_token: "lease-new",
      lease_expires_at: "2026-07-18T12:10:00.000Z"
    });
    client.assertExhausted();
  });

  it("returns an actively leased idempotent run without stealing it", async () => {
    const activeRun = runRow({
      lease_owner: "worker-other",
      lease_token: "lease-other",
      lease_expires_at: "2026-07-18T12:05:00.000Z"
    });
    const client = new ScriptedSupabaseClient(
      failure("duplicate key", "23505"),
      ok(activeRun)
    );

    const result = await createStore(client).claimOrCreateRun({
      orchestrationKey: "scheduled:2026-07-18",
      workerId: "worker-a",
      leaseToken: "lease-new"
    });

    expect(result).toEqual({ run: activeRun, claimed: false, created: false, leaseToken: null });
    expect(client.calls.filter((call) => call.method === "update")).toHaveLength(0);
  });

  it("optimistically claims an expired idempotent run", async () => {
    const expiredRun = runRow({
      finished_at: "2026-07-18T11:30:00.000Z",
      logs: ["durable task and checkpoint history remains attached to run-1"],
      errors_json: [{ message: "stale cancellation" }],
      stats_json: { phase: "canceled", canceled: true },
      lease_owner: "worker-old",
      lease_token: "lease-old",
      lease_expires_at: "2026-07-18T11:59:00.000Z"
    });
    const claimedRun = runRow({
      logs: expiredRun.logs,
      errors_json: [],
      stats_json: { phase: "initializing" },
      lease_owner: "worker-new",
      lease_token: "lease-new"
    });
    const client = new ScriptedSupabaseClient(
      failure("duplicate key", "23505"),
      ok(expiredRun),
      ok(claimedRun)
    );

    const result = await createStore(client).claimOrCreateRun({
      orchestrationKey: "scheduled:2026-07-18",
      workerId: "worker-new",
      leaseToken: "lease-new",
      stats: { phase: "initializing" }
    });

    expect(result.claimed).toBe(true);
    expect(result.run.id).toBe(expiredRun.id);
    expect(result.run.started_at).toBe(expiredRun.started_at);
    expect(result.run.logs).toEqual(expiredRun.logs);
    expect(queryCall(client, "update").args?.[0]).toMatchObject({
      status: "running",
      finished_at: null,
      lease_owner: "worker-new",
      lease_token: "lease-new",
      stats_json: { phase: "initializing" },
      errors_json: []
    });
    expect(queryCall(client, "update").args?.[0]).not.toHaveProperty("id");
    expect(queryCall(client, "update").args?.[0]).not.toHaveProperty("started_at");
    expect(queryCall(client, "update").args?.[0]).not.toHaveProperty("logs");
    expect(queryCalls(client, "eq")).toContainEqual(
      expect.objectContaining({ args: ["status", "running"] })
    );
    expect(queryCalls(client, "eq")).toContainEqual(
      expect.objectContaining({ args: ["finished_at", "2026-07-18T11:30:00.000Z"] })
    );
    expect(queryCalls(client, "eq")).toContainEqual(
      expect.objectContaining({ args: ["heartbeat_at", NOW.toISOString()] })
    );
    expect(queryCalls(client, "eq")).toContainEqual(
      expect.objectContaining({ args: ["lease_owner", "worker-old"] })
    );
    expect(queryCalls(client, "eq")).toContainEqual(
      expect.objectContaining({ args: ["lease_token", "lease-old"] })
    );
    expect(queryCalls(client, "eq")).toContainEqual(
      expect.objectContaining({ args: ["lease_expires_at", "2026-07-18T11:59:00.000Z"] })
    );
  });

  it("never rewrites a completed idempotent run while attempting recovery", async () => {
    const completedRun = runRow({
      status: "completed",
      finished_at: "2026-07-18T11:30:00.000Z",
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      stats_json: { phase: "completed", durable: true }
    });
    const client = new ScriptedSupabaseClient(
      failure("duplicate key", "23505"),
      ok(completedRun)
    );

    const result = await createStore(client).claimOrCreateRun({
      orchestrationKey: "scheduled:2026-07-18",
      workerId: "worker-new",
      leaseToken: "lease-new",
      stats: { phase: "initializing" }
    });

    expect(result).toEqual({
      run: completedRun,
      claimed: false,
      created: false,
      leaseToken: null
    });
    expect(client.calls.filter((call) => call.method === "update")).toHaveLength(0);
  });

  it("only inserts immutable events and surfaces Supabase errors", async () => {
    const event = eventRow();
    const successClient = new ScriptedSupabaseClient(ok(event));
    const stored = await createStore(successClient).appendEvent({
      runId: "run-1",
      eventKey: "task-1:claimed",
      eventType: "task.claimed",
      payload: { worker: "worker-a" }
    });
    expect(stored).toBe(event);
    expect(queryCall(successClient, "insert").args?.[0]).toMatchObject({
      event_key: "task-1:claimed",
      event_type: "task.claimed",
      payload_json: { worker: "worker-a" }
    });
    expect(successClient.calls.some((call) => call.method === "update")).toBe(false);

    const failureClient = new ScriptedSupabaseClient(failure("write denied", "42501"));
    await expect(createStore(failureClient).appendEvent({
      runId: "run-1",
      eventType: "run.started"
    })).rejects.toMatchObject({
      name: "AutonomousIngestionStoreError",
      code: "42501",
      operation: "Append ingestion run event"
    });
  });

  it("idempotently enqueues tasks and reads all checkpoint keys", async () => {
    const task = taskRow();
    const client = new ScriptedSupabaseClient(ok(null), ok([task]));
    const result = await createStore(client).enqueueTasks([{
      runId: "run-1",
      entityType: "company",
      companyName: "Returner",
      platform: "github",
      checkpointKey: "run-1:returner:github"
    }]);

    expect(result).toEqual([task]);
    expect(queryCall(client, "upsert").args?.[1]).toEqual({
      onConflict: "checkpoint_key",
      ignoreDuplicates: true
    });
    expect(queryCall(client, "in").args).toEqual([
      "checkpoint_key",
      ["run-1:returner:github"]
    ]);
  });

  it("bounds checkpoint-key reads so large Timeline enqueues cannot exceed PostgREST URL limits", async () => {
    const inputs = Array.from({ length: 45 }, (_, index) => ({
      runId: "run-1",
      entityType: "company" as const,
      companyName: `Company ${index}`,
      platform: "timeline_historical_archive",
      checkpointKey: `timeline:timeline-coordinator-2026-08-02.v1:run-1:company-${index}:timeline_historical_archive`
    }));
    const rows = inputs.map((input, index) => taskRow({
      id: `task-${index}`,
      checkpoint_key: input.checkpointKey,
      company_name: input.companyName,
      platform: input.platform
    }));
    const client = new ScriptedSupabaseClient(
      ok(null),
      ok(rows.slice(0, 20)),
      ok(rows.slice(20, 40)),
      ok(rows.slice(40))
    );

    const result = await createStore(client).enqueueTasks(inputs);

    expect(result).toEqual(rows);
    const filters = queryCalls(client, "in").map((call) => call.args?.[1] as string[]);
    expect(filters.map((values) => values.length)).toEqual([20, 20, 5]);
    expect(filters.flat()).toEqual(inputs.map((input) => input.checkpointKey));
    client.assertExhausted();
  });

  it("uses the migration RPC names and parameter names for atomic claims and leases", async () => {
    const task = taskRow();
    const client = new ScriptedSupabaseClient(ok([task]), ok(true), ok([task]));
    const store = createStore(client);

    expect(await store.claimTasks({
      workerId: "worker-a",
      limit: 4,
      leaseDurationSeconds: 90,
      runId: "run-1",
      platform: "github"
    })).toEqual([task]);
    expect(await store.renewTaskLease({
      taskId: "task-1",
      workerId: "worker-a",
      leaseToken: "task-lease",
      leaseDurationSeconds: 120
    })).toBe(true);
    expect(await store.requeueExpiredTasks(25)).toEqual([task]);

    expect(rpcCall(client, "claim_ingestion_tasks").rpcArgs).toEqual({
      p_worker_id: "worker-a",
      p_limit: 4,
      p_lease_duration: "90 seconds",
      p_ingestion_run_id: "run-1",
      p_platform: "github"
    });
    expect(rpcCall(client, "renew_ingestion_task_lease").rpcArgs).toEqual({
      p_task_id: "task-1",
      p_worker_id: "worker-a",
      p_lease_token: "task-lease",
      p_lease_duration: "120 seconds"
    });
    expect(rpcCall(client, "requeue_expired_ingestion_tasks").rpcArgs).toEqual({ p_limit: 25 });
  });

  it("heartbeats run leases and guards task terminal transitions by live ownership", async () => {
    const run = runRow();
    const completedTask = taskRow({ status: "completed", terminal_at: NOW.toISOString() });
    const client = new ScriptedSupabaseClient(ok(run), ok(completedTask), ok(null));
    const store = createStore(client);

    expect(await store.heartbeatRunLease({
      runId: "run-1",
      workerId: "worker-a",
      leaseToken: "run-lease",
      leaseDurationSeconds: 60
    })).toBe(true);
    expect(await store.completeTask({
      taskId: "task-1",
      workerId: "worker-a",
      leaseToken: "task-lease"
    })).toBe(completedTask);
    await expect(store.failTask({
      taskId: "task-stale",
      workerId: "worker-a",
      leaseToken: "stale",
      failureKind: "provider_error",
      message: "upstream failed"
    })).rejects.toBeInstanceOf(AutonomousIngestionConcurrencyError);

    expect(queryCalls(client, "gt").map((call) => call.args?.[0])).toEqual([
      "lease_expires_at",
      "lease_expires_at",
      "lease_expires_at"
    ]);
  });

  it("reschedules, fails, and dead-letters with failure metadata", async () => {
    const retry = taskRow({ status: "retry_scheduled" });
    const failed = taskRow({ status: "failed" });
    const dead = taskRow({ status: "dead_lettered", terminal_at: NOW.toISOString() });
    const client = new ScriptedSupabaseClient(ok(retry), ok(failed), ok(dead), ok(null));
    const store = createStore(client);
    const lease = { taskId: "task-1", workerId: "worker-a", leaseToken: "task-lease" };

    await store.rescheduleTask({
      ...lease,
      failureKind: "rate_limited",
      message: "try later",
      nextAttemptAt: "2026-07-18T12:05:00.000Z"
    });
    await store.failTask({ ...lease, failureKind: "invalid_data", message: "bad payload" });
    await store.deadLetterTask({
      ...lease,
      failureKind: "max_attempts",
      message: "attempt limit reached",
      error: { providerStatus: 503 }
    });

    const updates = queryCalls(client, "update").map((call) => call.args?.[0]);
    expect(updates).toEqual([
      expect.objectContaining({ status: "retry_scheduled", last_failure_kind: "rate_limited" }),
      expect.objectContaining({ status: "failed", last_failure_kind: "invalid_data" }),
      expect.objectContaining({ status: "dead_lettered", last_failure_kind: "max_attempts" })
    ]);
    expect(queryCall(client, "upsert").args?.[0]).toMatchObject({
      ingestion_task_id: "task-1",
      failure_kind: "max_attempts",
      attempts: 1,
      status: "open"
    });
  });

  it("persists versioned checkpoints, coverage, and artifact manifests", async () => {
    const current = checkpointRow({ version: 3 });
    const saved = checkpointRow({ version: 4 });
    const coverage = coverageRow();
    const artifact = artifactRow();
    const client = new ScriptedSupabaseClient(ok(current), ok(saved), ok(coverage), ok(artifact));
    const store = createStore(client);

    expect(await store.persistCheckpoint({
      socialAccountId: "account-1",
      platform: "github",
      cursor: { page: 3 },
      lastSuccessfulRunId: "run-1"
    })).toBe(saved);
    expect(await store.persistCoverageReport({
      runId: "run-1",
      reportKey: "github:all",
      expectedCount: 10,
      succeededCount: 9,
      failedCount: 1
    })).toBe(coverage);
    expect(await store.persistArtifactManifest({
      runId: "run-1",
      taskId: "task-1",
      artifactKey: "github:returner",
      artifactType: "traction-json",
      storageUri: "public/github-returner.json",
      sha256: "a".repeat(64)
    })).toBe(artifact);

    expect(queryCalls(client, "eq")).toContainEqual(
      expect.objectContaining({ args: ["version", 3] })
    );
    expect(queryCalls(client, "upsert").map((call) => call.args?.[1])).toEqual([
      { onConflict: "ingestion_run_id,report_key" },
      { onConflict: "ingestion_run_id,artifact_key" }
    ]);
  });

  it("finalizes only after every task is terminal", async () => {
    const finalized = runRow({ status: "completed", finished_at: NOW.toISOString() });
    const client = new ScriptedSupabaseClient(
      { data: null, error: null, count: 2 },
      { data: null, error: null, count: 0 },
      ok(finalized)
    );
    const store = createStore(client);

    expect(await store.finalizeRun({ runId: "run-1", status: "completed" })).toEqual({
      finalized: false,
      pendingTaskCount: 2,
      run: null
    });
    expect(client.calls.filter((call) => call.method === "update")).toHaveLength(0);

    expect(await store.finalizeRun({
      runId: "run-1",
      status: "completed",
      stats: { completedTasks: 10 }
    })).toEqual({ finalized: true, pendingTaskCount: 0, run: finalized });
    expect(queryCall(client, "not").args).toEqual([
      "status",
      "in",
      "(completed,needs_review,blocked_or_empty,skipped,failed,canceled,dead_lettered)"
    ]);
    expect(queryCall(client, "update").args?.[0]).toMatchObject({
      status: "completed",
      stats_json: { completedTasks: 10 },
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null
    });
  });
});

function createStore(client: SupabaseLikeClient): AutonomousIngestionStore {
  return new AutonomousIngestionStore(client, {
    now: () => NOW,
    createLeaseToken: () => "generated-lease"
  });
}

function ok<T>(data: T): SupabaseResponse<unknown> {
  return { data, error: null };
}

function failure(message: string, code: string): SupabaseResponse<unknown> {
  return { data: null, error: { message, code } };
}

function queryCall(client: ScriptedSupabaseClient, method: string): ClientCall {
  const call = client.calls.find((candidate) => candidate.kind === "query" && candidate.method === method);
  if (!call) throw new Error(`Missing ${method} query call.`);
  return call;
}

function queryCalls(client: ScriptedSupabaseClient, method: string): ClientCall[] {
  return client.calls.filter((call) => call.kind === "query" && call.method === method);
}

function rpcCall(client: ScriptedSupabaseClient, functionName: string): ClientCall {
  const call = client.calls.find(
    (candidate) => candidate.kind === "rpc" && candidate.functionName === functionName
  );
  if (!call) throw new Error(`Missing ${functionName} RPC call.`);
  return call;
}

function runRow(overrides: Partial<IngestionRunRow> = {}): IngestionRunRow {
  return {
    id: "run-1",
    batch_id: "batch-1",
    status: "running",
    started_at: "2026-07-18T11:00:00.000Z",
    finished_at: null,
    logs: [],
    errors_json: [],
    idempotency_key: "scheduled:2026-07-18",
    heartbeat_at: NOW.toISOString(),
    lease_owner: "worker-a",
    lease_token: "run-lease",
    lease_expires_at: "2026-07-18T12:05:00.000Z",
    stats_json: {},
    ...overrides
  };
}

function taskRow(overrides: Partial<IngestionTaskRow> = {}): IngestionTaskRow {
  return {
    id: "task-1",
    ingestion_run_id: "run-1",
    batch_id: "batch-1",
    entity_type: "company",
    entity_id: "company-1",
    company_name: "Returner",
    platform: "github",
    status: "running",
    attempts: 1,
    checkpoint_key: "run-1:returner:github",
    rate_limit_ms: 1200,
    last_error: null,
    locked_by: "worker-a",
    locked_at: NOW.toISOString(),
    max_attempts: 5,
    priority: 0,
    next_attempt_at: null,
    last_attempt_at: NOW.toISOString(),
    retry_base_delay_seconds: 30,
    lease_token: "task-lease",
    lease_expires_at: "2026-07-18T12:05:00.000Z",
    terminal_at: null,
    terminal_reason: null,
    last_failure_kind: null,
    last_error_json: {},
    created_at: "2026-07-18T11:00:00.000Z",
    updated_at: NOW.toISOString(),
    ...overrides
  };
}

function eventRow(): IngestionRunEventRow {
  return {
    id: "event-1",
    ingestion_run_id: "run-1",
    ingestion_task_id: null,
    event_key: "task-1:claimed",
    event_type: "task.claimed",
    severity: "info",
    message: null,
    payload_json: {},
    occurred_at: NOW.toISOString(),
    created_at: NOW.toISOString()
  };
}

function checkpointRow(overrides: Partial<IngestionCheckpointRow> = {}): IngestionCheckpointRow {
  return {
    id: "checkpoint-1",
    social_account_id: "account-1",
    platform: "github",
    stream_key: "default",
    cursor_json: { page: 3 },
    high_watermark_at: null,
    last_successful_run_id: "run-1",
    last_success_at: NOW.toISOString(),
    version: 0,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides
  };
}

function coverageRow(): IngestionCoverageReportRow {
  return {
    id: "coverage-1",
    ingestion_run_id: "run-1",
    batch_id: "batch-1",
    report_key: "github:all",
    platform: "github",
    expected_count: 10,
    attempted_count: 10,
    succeeded_count: 9,
    failed_count: 1,
    skipped_count: 0,
    report_json: {},
    generated_at: NOW.toISOString(),
    created_at: NOW.toISOString()
  };
}

function artifactRow(): IngestionArtifactManifestRow {
  return {
    id: "artifact-1",
    ingestion_run_id: "run-1",
    ingestion_task_id: "task-1",
    artifact_key: "github:returner",
    artifact_type: "traction-json",
    storage_uri: "public/github-returner.json",
    content_type: "application/json",
    byte_size: 100,
    sha256: "a".repeat(64),
    metadata_json: {},
    created_at: NOW.toISOString()
  };
}
