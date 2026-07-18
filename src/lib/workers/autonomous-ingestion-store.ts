export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface SupabaseErrorLike {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

export interface SupabaseResponse<T> {
  data: T | null;
  error: SupabaseErrorLike | null;
  count?: number | null;
}

export interface SupabaseQuery<T = unknown> extends PromiseLike<SupabaseResponse<T>> {
  insert(values: unknown): SupabaseQuery<T>;
  upsert(values: unknown, options?: { onConflict?: string; ignoreDuplicates?: boolean }): SupabaseQuery<T>;
  update(values: unknown): SupabaseQuery<T>;
  select(columns?: string, options?: { count?: "exact"; head?: boolean }): SupabaseQuery<T>;
  eq(column: string, value: unknown): SupabaseQuery<T>;
  gt(column: string, value: unknown): SupabaseQuery<T>;
  in(column: string, values: readonly unknown[]): SupabaseQuery<T>;
  is(column: string, value: null): SupabaseQuery<T>;
  not(column: string, operator: string, value: unknown): SupabaseQuery<T>;
  single(): SupabaseQuery<T>;
  maybeSingle(): SupabaseQuery<T>;
}

/** The deliberately small client surface needed by this repository. */
export interface SupabaseLikeClient {
  from<T = unknown>(table: string): SupabaseQuery<T>;
  rpc<T = unknown>(functionName: string, args: Record<string, unknown>): PromiseLike<SupabaseResponse<T>>;
}

export type RunStatus = "queued" | "running" | "completed" | "failed" | "canceled";
export type TaskTerminalStatus =
  | "completed"
  | "needs_review"
  | "blocked_or_empty"
  | "skipped"
  | "failed"
  | "canceled"
  | "dead_lettered";
export type TaskStatus = "queued" | "running" | "retry_scheduled" | TaskTerminalStatus;

export const TERMINAL_INGESTION_TASK_STATUSES: readonly TaskTerminalStatus[] = [
  "completed",
  "needs_review",
  "blocked_or_empty",
  "skipped",
  "failed",
  "canceled",
  "dead_lettered"
] as const;

export interface IngestionRunRow {
  id: string;
  batch_id: string | null;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  logs: string[];
  errors_json: JsonValue;
  idempotency_key: string | null;
  heartbeat_at: string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  stats_json: JsonObject;
}

export interface IngestionTaskRow {
  id: string;
  ingestion_run_id: string | null;
  batch_id: string | null;
  entity_type: "company" | "founder";
  entity_id: string | null;
  company_name: string;
  platform: string;
  status: TaskStatus;
  attempts: number;
  checkpoint_key: string;
  rate_limit_ms: number;
  last_error: string | null;
  locked_by: string | null;
  locked_at: string | null;
  max_attempts: number;
  priority: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  retry_base_delay_seconds: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  terminal_at: string | null;
  terminal_reason: string | null;
  last_failure_kind: string | null;
  last_error_json: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface IngestionRunEventRow {
  id: string;
  ingestion_run_id: string;
  ingestion_task_id: string | null;
  event_key: string | null;
  event_type: string;
  severity: "debug" | "info" | "warning" | "error";
  message: string | null;
  payload_json: JsonObject;
  occurred_at: string;
  created_at: string;
}

export interface IngestionCheckpointRow {
  id: string;
  social_account_id: string;
  platform: string;
  stream_key: string;
  cursor_json: JsonObject;
  high_watermark_at: string | null;
  last_successful_run_id: string | null;
  last_success_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface IngestionCoverageReportRow {
  id: string;
  ingestion_run_id: string;
  batch_id: string | null;
  report_key: string;
  platform: string | null;
  expected_count: number;
  attempted_count: number;
  succeeded_count: number;
  failed_count: number;
  skipped_count: number;
  report_json: JsonObject;
  generated_at: string;
  created_at: string;
}

export interface IngestionArtifactManifestRow {
  id: string;
  ingestion_run_id: string;
  ingestion_task_id: string | null;
  artifact_key: string;
  artifact_type: string;
  storage_uri: string;
  content_type: string | null;
  byte_size: number | null;
  sha256: string | null;
  metadata_json: JsonObject;
  created_at: string;
}

export interface ClaimOrCreateRunInput {
  orchestrationKey: string;
  workerId: string;
  batchId?: string | null;
  leaseDurationSeconds?: number;
  leaseToken?: string;
  stats?: JsonObject;
}

export interface ClaimOrCreateRunResult {
  run: IngestionRunRow;
  claimed: boolean;
  created: boolean;
  leaseToken: string | null;
}

export interface AppendRunEventInput {
  runId: string;
  taskId?: string | null;
  eventKey?: string | null;
  eventType: string;
  severity?: IngestionRunEventRow["severity"];
  message?: string | null;
  payload?: JsonObject;
  occurredAt?: string;
}

export interface EnqueueTaskInput {
  runId: string;
  batchId?: string | null;
  entityType: IngestionTaskRow["entity_type"];
  entityId?: string | null;
  companyName: string;
  platform: string;
  checkpointKey: string;
  rateLimitMs?: number;
  maxAttempts?: number;
  priority?: number;
  nextAttemptAt?: string | null;
  retryBaseDelaySeconds?: number;
}

export interface ClaimTasksInput {
  workerId: string;
  limit?: number;
  leaseDurationSeconds?: number;
  runId?: string | null;
  platform?: string | null;
}

export interface TaskLeaseInput {
  taskId: string;
  workerId: string;
  leaseToken: string;
}

export interface RunLeaseInput {
  runId: string;
  workerId: string;
  leaseToken: string;
  leaseDurationSeconds?: number;
}

export interface CompleteTaskInput extends TaskLeaseInput {
  status?: Exclude<TaskTerminalStatus, "failed" | "canceled" | "dead_lettered">;
  terminalReason?: string;
}

export interface FailTaskInput extends TaskLeaseInput {
  failureKind: string;
  message: string;
  error?: JsonObject;
  terminalReason?: string;
}

export interface RescheduleTaskInput extends FailTaskInput {
  nextAttemptAt: string;
}

export interface DeadLetterTaskInput extends FailTaskInput {
  terminalReason?: string;
}

export interface PersistCheckpointInput {
  socialAccountId: string;
  platform: string;
  streamKey?: string;
  cursor: JsonObject;
  highWatermarkAt?: string | null;
  lastSuccessfulRunId: string;
  lastSuccessAt?: string;
  expectedVersion?: number;
}

export interface PersistCoverageReportInput {
  runId: string;
  batchId?: string | null;
  reportKey: string;
  platform?: string | null;
  expectedCount?: number;
  attemptedCount?: number;
  succeededCount?: number;
  failedCount?: number;
  skippedCount?: number;
  report?: JsonObject;
  generatedAt?: string;
}

export interface PersistArtifactManifestInput {
  runId: string;
  taskId?: string | null;
  artifactKey: string;
  artifactType: string;
  storageUri: string;
  contentType?: string | null;
  byteSize?: number | null;
  sha256?: string | null;
  metadata?: JsonObject;
}

export interface FinalizeRunInput {
  runId: string;
  status: Extract<RunStatus, "completed" | "failed" | "canceled">;
  errors?: JsonValue[];
  stats?: JsonObject;
}

export interface FinalizeRunResult {
  finalized: boolean;
  pendingTaskCount: number;
  run: IngestionRunRow | null;
}

export interface AutonomousIngestionStoreOptions {
  now?: () => Date;
  createLeaseToken?: () => string;
}

export class AutonomousIngestionStoreError extends Error {
  readonly operation: string;
  readonly code?: string;

  constructor(operation: string, error: SupabaseErrorLike) {
    super(`${operation}: ${error.message}`);
    this.name = "AutonomousIngestionStoreError";
    this.operation = operation;
    this.code = error.code;
  }
}

export class AutonomousIngestionConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutonomousIngestionConcurrencyError";
  }
}

export class AutonomousIngestionStore {
  private readonly now: () => Date;
  private readonly createLeaseToken: () => string;

  constructor(
    private readonly client: SupabaseLikeClient,
    options: AutonomousIngestionStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.createLeaseToken = options.createLeaseToken ?? (() => crypto.randomUUID());
  }

  async claimOrCreateRun(input: ClaimOrCreateRunInput): Promise<ClaimOrCreateRunResult> {
    requireNonBlank(input.orchestrationKey, "orchestrationKey");
    requireNonBlank(input.workerId, "workerId");
    const duration = leaseDuration(input.leaseDurationSeconds);
    const leaseToken = input.leaseToken ?? this.createLeaseToken();
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + duration * 1_000).toISOString();
    const insertResponse = await this.client
      .from<IngestionRunRow>("ingestion_runs")
      .insert({
        batch_id: input.batchId ?? null,
        status: "running",
        idempotency_key: input.orchestrationKey,
        heartbeat_at: nowIso,
        lease_owner: input.workerId.trim(),
        lease_token: leaseToken,
        lease_expires_at: expiresAt,
        stats_json: input.stats ?? {}
      })
      .select("*")
      .single();

    if (!insertResponse.error) {
      const run = requireData(insertResponse.data, "Create ingestion run");
      return { run, claimed: true, created: true, leaseToken };
    }
    if (!isUniqueViolation(insertResponse.error)) {
      throw new AutonomousIngestionStoreError("Create ingestion run", insertResponse.error);
    }

    const existing = await this.one<IngestionRunRow>(
      this.client
        .from<IngestionRunRow>("ingestion_runs")
        .select("*")
        .eq("idempotency_key", input.orchestrationKey)
        .single(),
      "Read idempotent ingestion run"
    );

    if (
      existing.status === "running" &&
      existing.lease_owner === input.workerId.trim() &&
      existing.lease_token === leaseToken &&
      isFuture(existing.lease_expires_at, now)
    ) {
      return { run: existing, claimed: true, created: false, leaseToken };
    }

    const claimableStatus = existing.status === "queued" || existing.status === "running";
    const leaseAvailable = !isFuture(existing.lease_expires_at, now);
    if (!claimableStatus || !leaseAvailable) {
      return { run: existing, claimed: false, created: false, leaseToken: null };
    }

    let claimQuery = this.client
      .from<IngestionRunRow>("ingestion_runs")
      .update({
        status: "running",
        heartbeat_at: nowIso,
        lease_owner: input.workerId.trim(),
        lease_token: leaseToken,
        lease_expires_at: expiresAt
      })
      .eq("id", existing.id)
      .in("status", ["queued", "running"]);
    claimQuery = existing.lease_token
      ? claimQuery.eq("lease_token", existing.lease_token)
      : claimQuery.is("lease_token", null);
    if (existing.lease_expires_at) {
      claimQuery = claimQuery.eq("lease_expires_at", existing.lease_expires_at);
    }

    const claimedRun = await this.maybeOne<IngestionRunRow>(
      claimQuery.select("*").maybeSingle(),
      "Claim existing ingestion run"
    );
    return claimedRun
      ? { run: claimedRun, claimed: true, created: false, leaseToken }
      : { run: existing, claimed: false, created: false, leaseToken: null };
  }

  async appendEvent(input: AppendRunEventInput): Promise<IngestionRunEventRow> {
    return this.one<IngestionRunEventRow>(
      this.client
        .from<IngestionRunEventRow>("ingestion_run_events")
        .insert({
          ingestion_run_id: input.runId,
          ingestion_task_id: input.taskId ?? null,
          event_key: input.eventKey ?? null,
          event_type: input.eventType,
          severity: input.severity ?? "info",
          message: input.message ?? null,
          payload_json: input.payload ?? {},
          ...(input.occurredAt ? { occurred_at: input.occurredAt } : {})
        })
        .select("*")
        .single(),
      "Append ingestion run event"
    );
  }

  async heartbeatRunLease(input: RunLeaseInput): Promise<boolean> {
    const duration = leaseDuration(input.leaseDurationSeconds);
    const now = this.now();
    const run = await this.maybeOne<IngestionRunRow>(
      this.client
        .from<IngestionRunRow>("ingestion_runs")
        .update({
          heartbeat_at: now.toISOString(),
          lease_expires_at: new Date(now.getTime() + duration * 1_000).toISOString()
        })
        .eq("id", input.runId)
        .eq("status", "running")
        .eq("lease_owner", input.workerId.trim())
        .eq("lease_token", input.leaseToken)
        .gt("lease_expires_at", now.toISOString())
        .select("*")
        .maybeSingle(),
      "Heartbeat ingestion run lease"
    );
    return run !== null;
  }

  async enqueueTasks(inputs: readonly EnqueueTaskInput[]): Promise<IngestionTaskRow[]> {
    if (inputs.length === 0) return [];
    const rows = inputs.map((input) => ({
      ingestion_run_id: input.runId,
      batch_id: input.batchId ?? null,
      entity_type: input.entityType,
      entity_id: input.entityId ?? null,
      company_name: input.companyName,
      platform: input.platform,
      status: "queued",
      checkpoint_key: input.checkpointKey,
      rate_limit_ms: input.rateLimitMs ?? 1_200,
      max_attempts: input.maxAttempts ?? 5,
      priority: input.priority ?? 0,
      next_attempt_at: input.nextAttemptAt ?? null,
      retry_base_delay_seconds: input.retryBaseDelaySeconds ?? 30
    }));

    await this.response(
      this.client
        .from<IngestionTaskRow[]>("ingestion_tasks")
        .upsert(rows, { onConflict: "checkpoint_key", ignoreDuplicates: true }),
      "Enqueue ingestion tasks"
    );
    return this.many<IngestionTaskRow>(
      this.client
        .from<IngestionTaskRow[]>("ingestion_tasks")
        .select("*")
        .in("checkpoint_key", inputs.map((input) => input.checkpointKey)),
      "Read enqueued ingestion tasks"
    );
  }

  async claimTasks(input: ClaimTasksInput): Promise<IngestionTaskRow[]> {
    return this.many<IngestionTaskRow>(
      this.client.rpc<IngestionTaskRow[]>("claim_ingestion_tasks", {
        p_worker_id: input.workerId,
        p_limit: input.limit ?? 1,
        p_lease_duration: interval(input.leaseDurationSeconds),
        p_ingestion_run_id: input.runId ?? null,
        p_platform: input.platform ?? null
      }),
      "Claim ingestion tasks"
    );
  }

  async renewTaskLease(
    input: TaskLeaseInput & { leaseDurationSeconds?: number }
  ): Promise<boolean> {
    return this.one<boolean>(
      this.client.rpc<boolean>("renew_ingestion_task_lease", {
        p_task_id: input.taskId,
        p_worker_id: input.workerId,
        p_lease_token: input.leaseToken,
        p_lease_duration: interval(input.leaseDurationSeconds)
      }),
      "Renew ingestion task lease"
    );
  }

  async requeueExpiredTasks(limit = 100): Promise<IngestionTaskRow[]> {
    return this.many<IngestionTaskRow>(
      this.client.rpc<IngestionTaskRow[]>("requeue_expired_ingestion_tasks", { p_limit: limit }),
      "Requeue expired ingestion tasks"
    );
  }

  async completeTask(input: CompleteTaskInput): Promise<IngestionTaskRow> {
    const status = input.status ?? "completed";
    return this.transitionLeasedTask(input, {
      status,
      terminal_at: this.now().toISOString(),
      terminal_reason: input.terminalReason ?? status,
      next_attempt_at: null,
      last_failure_kind: null,
      last_error: null,
      last_error_json: {},
      ...clearedLease()
    }, "Complete ingestion task");
  }

  async failTask(input: FailTaskInput): Promise<IngestionTaskRow> {
    return this.transitionLeasedTask(input, {
      status: "failed",
      terminal_at: this.now().toISOString(),
      terminal_reason: input.terminalReason ?? input.failureKind,
      next_attempt_at: null,
      last_failure_kind: input.failureKind,
      last_error: input.message,
      last_error_json: input.error ?? {},
      ...clearedLease()
    }, "Fail ingestion task");
  }

  async rescheduleTask(input: RescheduleTaskInput): Promise<IngestionTaskRow> {
    return this.transitionLeasedTask(input, {
      status: "retry_scheduled",
      next_attempt_at: input.nextAttemptAt,
      terminal_at: null,
      terminal_reason: null,
      last_failure_kind: input.failureKind,
      last_error: input.message,
      last_error_json: input.error ?? {},
      ...clearedLease()
    }, "Reschedule ingestion task");
  }

  async deadLetterTask(input: DeadLetterTaskInput): Promise<IngestionTaskRow> {
    const task = await this.transitionLeasedTask(input, {
      status: "dead_lettered",
      next_attempt_at: null,
      terminal_at: this.now().toISOString(),
      terminal_reason: input.terminalReason ?? input.failureKind,
      last_failure_kind: input.failureKind,
      last_error: input.message,
      last_error_json: input.error ?? {},
      ...clearedLease()
    }, "Dead-letter ingestion task");

    await this.response(
      this.client.from("ingestion_dead_letters").upsert({
        ingestion_task_id: task.id,
        ingestion_run_id: task.ingestion_run_id,
        failure_kind: input.failureKind,
        failure_message: input.message,
        attempts: task.attempts,
        task_snapshot_json: task as unknown as JsonObject,
        error_json: input.error ?? {},
        status: "open",
        dead_lettered_at: task.terminal_at
      }, { onConflict: "ingestion_task_id" }),
      "Persist ingestion dead letter"
    );
    return task;
  }

  async persistCheckpoint(input: PersistCheckpointInput): Promise<IngestionCheckpointRow> {
    const streamKey = input.streamKey ?? "default";
    let expectedVersion = input.expectedVersion;
    if (expectedVersion === undefined) {
      const current = await this.maybeOne<IngestionCheckpointRow>(
        this.client
          .from<IngestionCheckpointRow>("ingestion_checkpoints")
          .select("*")
          .eq("social_account_id", input.socialAccountId)
          .eq("platform", input.platform)
          .eq("stream_key", streamKey)
          .maybeSingle(),
        "Read ingestion checkpoint"
      );
      if (!current) {
        return this.one<IngestionCheckpointRow>(
          this.client
            .from<IngestionCheckpointRow>("ingestion_checkpoints")
            .insert(checkpointValues(input, streamKey, 0, this.now().toISOString()))
            .select("*")
            .single(),
          "Create ingestion checkpoint"
        );
      }
      expectedVersion = current.version;
    }

    const checkpoint = await this.maybeOne<IngestionCheckpointRow>(
      this.client
        .from<IngestionCheckpointRow>("ingestion_checkpoints")
        .update(checkpointValues(input, streamKey, expectedVersion + 1, this.now().toISOString()))
        .eq("social_account_id", input.socialAccountId)
        .eq("platform", input.platform)
        .eq("stream_key", streamKey)
        .eq("version", expectedVersion)
        .select("*")
        .maybeSingle(),
      "Update ingestion checkpoint"
    );
    if (!checkpoint) {
      throw new AutonomousIngestionConcurrencyError(
        `Checkpoint ${input.socialAccountId}/${input.platform}/${streamKey} changed concurrently.`
      );
    }
    return checkpoint;
  }

  async persistCoverageReport(
    input: PersistCoverageReportInput
  ): Promise<IngestionCoverageReportRow> {
    return this.one<IngestionCoverageReportRow>(
      this.client
        .from<IngestionCoverageReportRow>("ingestion_coverage_reports")
        .upsert({
          ingestion_run_id: input.runId,
          batch_id: input.batchId ?? null,
          report_key: input.reportKey,
          platform: input.platform ?? null,
          expected_count: input.expectedCount ?? 0,
          attempted_count: input.attemptedCount ?? 0,
          succeeded_count: input.succeededCount ?? 0,
          failed_count: input.failedCount ?? 0,
          skipped_count: input.skippedCount ?? 0,
          report_json: input.report ?? {},
          generated_at: input.generatedAt ?? this.now().toISOString()
        }, { onConflict: "ingestion_run_id,report_key" })
        .select("*")
        .single(),
      "Persist ingestion coverage report"
    );
  }

  async persistArtifactManifest(
    input: PersistArtifactManifestInput
  ): Promise<IngestionArtifactManifestRow> {
    return this.one<IngestionArtifactManifestRow>(
      this.client
        .from<IngestionArtifactManifestRow>("ingestion_artifact_manifests")
        .upsert({
          ingestion_run_id: input.runId,
          ingestion_task_id: input.taskId ?? null,
          artifact_key: input.artifactKey,
          artifact_type: input.artifactType,
          storage_uri: input.storageUri,
          content_type: input.contentType ?? null,
          byte_size: input.byteSize ?? null,
          sha256: input.sha256 ?? null,
          metadata_json: input.metadata ?? {}
        }, { onConflict: "ingestion_run_id,artifact_key" })
        .select("*")
        .single(),
      "Persist ingestion artifact manifest"
    );
  }

  async finalizeRun(input: FinalizeRunInput): Promise<FinalizeRunResult> {
    const pendingResponse = await this.response(
      this.client
        .from<never[]>("ingestion_tasks")
        .select("id", { count: "exact", head: true })
        .eq("ingestion_run_id", input.runId)
        .not("status", "in", `(${TERMINAL_INGESTION_TASK_STATUSES.join(",")})`),
      "Count nonterminal ingestion tasks"
    );
    const pendingTaskCount = pendingResponse.count ?? 0;
    if (pendingTaskCount > 0) {
      return { finalized: false, pendingTaskCount, run: null };
    }

    const run = await this.maybeOne<IngestionRunRow>(
      this.client
        .from<IngestionRunRow>("ingestion_runs")
        .update({
          status: input.status,
          finished_at: this.now().toISOString(),
          errors_json: input.errors ?? [],
          ...(input.stats ? { stats_json: input.stats } : {}),
          lease_owner: null,
          lease_token: null,
          lease_expires_at: null
        })
        .eq("id", input.runId)
        .in("status", ["queued", "running"])
        .select("*")
        .maybeSingle(),
      "Finalize ingestion run"
    );
    return { finalized: run !== null, pendingTaskCount: 0, run };
  }

  private async transitionLeasedTask(
    input: TaskLeaseInput,
    values: Record<string, unknown>,
    operation: string
  ): Promise<IngestionTaskRow> {
    const nowIso = this.now().toISOString();
    const task = await this.maybeOne<IngestionTaskRow>(
      this.client
        .from<IngestionTaskRow>("ingestion_tasks")
        .update(values)
        .eq("id", input.taskId)
        .eq("status", "running")
        .eq("locked_by", input.workerId.trim())
        .eq("lease_token", input.leaseToken)
        .gt("lease_expires_at", nowIso)
        .select("*")
        .maybeSingle(),
      operation
    );
    if (!task) {
      throw new AutonomousIngestionConcurrencyError(
        `${operation} lost ownership of task ${input.taskId}.`
      );
    }
    return task;
  }

  private async response<T>(
    request: PromiseLike<SupabaseResponse<T>>,
    operation: string
  ): Promise<SupabaseResponse<T>> {
    const response = await request;
    if (response.error) throw new AutonomousIngestionStoreError(operation, response.error);
    return response;
  }

  private async one<T>(request: PromiseLike<SupabaseResponse<T>>, operation: string): Promise<T> {
    const response = await this.response(request, operation);
    return requireData(response.data, operation);
  }

  private async maybeOne<T>(
    request: PromiseLike<SupabaseResponse<T>>,
    operation: string
  ): Promise<T | null> {
    return (await this.response(request, operation)).data;
  }

  private async many<T>(
    request: PromiseLike<SupabaseResponse<T[]>>,
    operation: string
  ): Promise<T[]> {
    return requireData((await this.response(request, operation)).data, operation);
  }
}

function checkpointValues(
  input: PersistCheckpointInput,
  streamKey: string,
  version: number,
  defaultSuccessAt: string
): Record<string, unknown> {
  return {
    social_account_id: input.socialAccountId,
    platform: input.platform,
    stream_key: streamKey,
    cursor_json: input.cursor,
    high_watermark_at: input.highWatermarkAt ?? null,
    last_successful_run_id: input.lastSuccessfulRunId,
    last_success_at: input.lastSuccessAt ?? defaultSuccessAt,
    version
  };
}

function clearedLease(): Record<string, null> {
  return { locked_by: null, locked_at: null, lease_token: null, lease_expires_at: null };
}

function interval(seconds = 300): string {
  return `${leaseDuration(seconds)} seconds`;
}

function leaseDuration(seconds = 300): number {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3_600) {
    throw new RangeError("leaseDurationSeconds must be an integer between 1 and 3600.");
  }
  return seconds;
}

function requireData<T>(data: T | null, operation: string): T {
  if (data === null) throw new Error(`${operation}: Supabase returned no data.`);
  return data;
}

function requireNonBlank(value: string, name: string): void {
  if (!value.trim()) throw new TypeError(`${name} must not be blank.`);
}

function isFuture(value: string | null, now: Date): boolean {
  return value !== null && Date.parse(value) > now.getTime();
}

function isUniqueViolation(error: SupabaseErrorLike): boolean {
  return error.code === "23505";
}
