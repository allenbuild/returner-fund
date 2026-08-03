import { createHash } from "node:crypto";
import type { EvidenceItem } from "@/lib/graph/types";
import {
  TIMELINE_CATEGORIES,
  type TimelineCategory,
  type TimelineSourceCoverageState,
  type TimelineSourceType,
} from "./contracts";
import {
  TIMELINE_EXTRACTION_VERSION,
  type TimelineClassificationSource,
  type TimelineClassificationProvider,
  type TimelineClassifierResult,
  type TimelineCompanyIdentity,
} from "./domain";
import {
  classifySourceDeterministically,
  runTimelineClassification,
  timelineClassificationSourceFromGraphEvidence,
} from "./classification";
import {
  configuredTimelineClassifierVersion,
  createConfiguredTimelineClassificationProvider,
} from "./ai-classification";
import {
  discoverTimelineDirectSources,
  discoverTimelineWebSources,
  type TimelineWebDiscoveryResult,
} from "./discovery";
import { discoverTimelineHistoricalArchiveSources } from "./archive";
import { fetchSafeTimelineSource } from "./safe-fetch";
import { createConfiguredTimelineSearchProviders, type TimelineSearchProvider } from "./search";
import {
  canonicalizeSourceUrl,
  normalizeSourceDocument,
  sanitizeEvidenceExcerpt,
  type NormalizedSourceDocument,
} from "./source-document";
import {
  TIMELINE_SOURCE_CLASSES,
  deriveTimelineCompanyCoverageStatus,
  enqueueTimelineBackfillTasks,
  type TimelineSourceClass,
} from "./coordinator";
import { shouldMergeTimelineEvents } from "./dedupe";
import {
  AutonomousIngestionStore,
  type IngestionTaskRow,
  type JsonObject,
  type SupabaseLikeClient,
} from "@/lib/workers/autonomous-ingestion-store";

export const TIMELINE_DISCOVERY_RUNNER_VERSION = "timeline-discovery-runner-2026-08-02.v1" as const;

export interface TimelineIngestionCompany extends TimelineCompanyIdentity {
  /** Batch-scoped durable companies.id UUID. */
  databaseId: string;
  batchId: string | null;
  profileUrl: string | null;
  existingEvidenceCount: number;
  /** Canonical graph evidence is imported through the same durable gates as newly crawled sources. */
  existingEvidence?: readonly EvidenceItem[];
}

export interface TimelineDiscoveryHandlerResult {
  status: Extract<TimelineSourceCoverageState,
    "completed" | "no_applicable_source" | "no_results" | "blocked" |
    "rate_limited" | "authentication_required" | "failed">;
  reason: string;
  sources: TimelineClassificationSource[];
  metadata?: JsonObject;
}

export interface TimelinePersistenceReceipt {
  sourceDocuments: number;
  candidates: number;
  publishedEvents: number;
  unresolvedDates: number;
}

export interface TimelineDiscoveryContext {
  networkAllowed: boolean;
  perFetchTimeoutMs: number;
  providers: readonly TimelineSearchProvider[];
  /** Shared wall-clock deadline for every search and page fetch in this task. */
  deadlineAt?: number;
}

export interface TimelineDiscoveryPersistence {
  markCoverage(
    company: TimelineIngestionCompany,
    sourceClass: TimelineSourceClass,
    status: TimelineSourceCoverageState,
    input: { attempts: number; reason?: string | null; error?: string | null; metadata?: JsonObject },
  ): Promise<void>;
  persistSources(
    company: TimelineIngestionCompany,
    sourceClass: TimelineSourceClass,
    sources: readonly TimelineClassificationSource[],
    fetchedAt: string,
  ): Promise<TimelinePersistenceReceipt>;
  /** Re-run durable source documents without crawling or trusting cached model output. */
  reconcileCompany?(
    company: TimelineIngestionCompany,
    fetchedAt: string,
  ): Promise<TimelinePersistenceReceipt>;
  finalizeCompanies(
    companies: readonly TimelineIngestionCompany[],
    coverage: ReadonlyMap<string, Readonly<Record<string, TimelineSourceCoverageState>>>,
    completedAt: string,
  ): Promise<void>;
}

interface TimelineCompanyStateCountRow {
  company_id: string;
  historical_backfill_status: "pending" | "running" | "completed" | "partial" | "failed";
  historical_backfill_started_at: string | null;
  historical_backfill_completed_at: string | null;
  last_incremental_scan_at: string | null;
  last_deep_scan_at: string | null;
  source_coverage: unknown;
}

interface TimelineEventCountRow {
  primary_company_id: string;
  status: string;
  has_conflict: boolean;
}

interface TimelineCandidateCountRow {
  company_id: string;
  status: string;
  proposed_event_date: string | null;
}

interface TimelineCompanyCounts {
  publishedEvents: number;
  candidates: number;
  unresolvedConflicts: number;
  unresolvedDates: number;
}

type TimelineTaskStore = Pick<AutonomousIngestionStore,
  "enqueueTasks" | "claimTasks" | "requeueExpiredTasks" | "completeTask" | "rescheduleTask" | "deadLetterTask" |
  "persistCoverageReport" | "appendEvent">;

export interface RunTimelineDiscoveryInput {
  client: SupabaseLikeClient;
  runId: string;
  workerId: string;
  companies: readonly TimelineIngestionCompany[];
  env?: NodeJS.ProcessEnv;
  budgetMs?: number;
  concurrency?: number;
  perFetchTimeoutMs?: number;
  now?: () => Date;
  store?: TimelineTaskStore;
  persistence?: TimelineDiscoveryPersistence;
  providers?: readonly TimelineSearchProvider[];
  classificationProvider?: TimelineClassificationProvider | null;
  discover?: (
    sourceClass: TimelineSourceClass,
    company: TimelineIngestionCompany,
    context: TimelineDiscoveryContext,
  ) => Promise<TimelineDiscoveryHandlerResult>;
}

export interface TimelineDiscoveryRunReceipt extends TimelinePersistenceReceipt {
  status: "completed";
  version: typeof TIMELINE_DISCOVERY_RUNNER_VERSION;
  companyCount: number;
  expectedTasks: number;
  terminalTasks: number;
  completedTasks: number;
  blockedOrEmptyTasks: number;
  deadLetteredTasks: number;
  resumedTerminalTasks: number;
  budgetExhaustedTasks: number;
  durationMs: number;
}

export interface TimelineAdminTaskDrainReceipt extends TimelinePersistenceReceipt {
  status: "completed" | "budget_exhausted";
  claimedTasks: number;
  terminalTasks: number;
  retryScheduledTasks: number;
  deadLetteredTasks: number;
  unknownCompanyTasks: number;
  durationMs: number;
}

class RetryableTimelineDiscoveryError extends Error {
  readonly kind: "rate_limited" | "discovery_failed";
  constructor(kind: "rate_limited" | "discovery_failed", message: string) {
    super(message);
    this.name = "RetryableTimelineDiscoveryError";
    this.kind = kind;
  }
}

export async function runTimelineDiscoveryIngestion(
  input: RunTimelineDiscoveryInput,
): Promise<TimelineDiscoveryRunReceipt> {
  const startedAt = (input.now ?? (() => new Date()))();
  const now = input.now ?? (() => new Date());
  const budgetMs = clamp(input.budgetMs ?? 3 * 60_000, 10_000, 10 * 60_000);
  const deadline = startedAt.getTime() + budgetMs;
  const concurrency = clamp(input.concurrency ?? 8, 1, 16);
  const perFetchTimeoutMs = clamp(input.perFetchTimeoutMs ?? 8_000, 1_000, 20_000);
  const store = input.store ?? new AutonomousIngestionStore(input.client);
  const classificationProvider = input.classificationProvider === undefined
    ? createConfiguredTimelineClassificationProvider(input.env ?? process.env, { deadlineAt: deadline })
    : input.classificationProvider;
  const persistence = input.persistence ?? new SupabaseTimelineDiscoveryPersistence(input.client, now, classificationProvider);
  const providers = [...(input.providers ?? createConfiguredTimelineSearchProviders(input.env ?? process.env))];
  const discover = input.discover ?? dispatchTimelineSourceClass;
  const companies = normalizeInventory(input.companies);
  const byDatabaseId = new Map(companies.map((company) => [company.databaseId, company]));
  const expectedTasks = companies.length * TIMELINE_SOURCE_CLASSES.length;

  const enqueued = await enqueueTimelineBackfillTasks(store as AutonomousIngestionStore, {
    runId: input.runId,
    companies: companies.map((company) => ({
      id: company.databaseId,
      name: company.name,
      batchId: company.batchId,
      hasWebsite: Boolean(company.websiteUrl),
      founderCount: company.founderNames.length,
    })),
  });
  if (enqueued.length !== expectedTasks) {
    throw new Error(`Timeline task enqueue returned ${enqueued.length}/${expectedTasks} authoritative source-class tasks.`);
  }

  const coverage = new Map<string, Record<string, TimelineSourceCoverageState>>();
  for (const company of companies) coverage.set(company.databaseId, {});
  let terminalTasks = 0;
  let completedTasks = 0;
  let blockedOrEmptyTasks = 0;
  let deadLetteredTasks = 0;
  let budgetExhaustedTasks = 0;
  let sourceDocuments = 0;
  let candidates = 0;
  let publishedEvents = 0;
  let unresolvedDates = 0;

  const resumed = enqueued.filter((task) => isTerminalTask(task.status));
  const resumedTerminalTasks = resumed.length;
  terminalTasks += resumedTerminalTasks;
  for (const task of resumed) {
    const company = task.entity_id ? byDatabaseId.get(task.entity_id) : null;
    if (!company || !isTimelineSourceClass(task.platform)) continue;
    const status = coverageStatusFromTerminalTask(task);
    coverage.get(company.databaseId)![task.platform] = status;
  }

  let emptyClaims = 0;
  let iterations = 0;
  while (terminalTasks < expectedTasks) {
    if (++iterations > expectedTasks * 6 + 100) {
      throw new Error("Timeline ingestion exceeded its bounded task-drain iteration guard.");
    }
    // Timeline shares the parent autonomous ingestion run with other
    // collectors. Never claim the run without a platform constraint: doing so
    // can lease and then dead-letter an unrelated queued ingestion task as an
    // "invalid_timeline_task". Rotate the source-class order so a bounded run
    // makes progress across every pass instead of consuming its entire network
    // budget on one class first.
    const claimed = await claimTimelineTasks(store, {
      workerId: input.workerId,
      runId: input.runId,
      limit: concurrency,
      leaseDurationSeconds: Math.max(60, Math.ceil(perFetchTimeoutMs / 1_000) + 30),
      rotation: iterations - 1,
    });
    if (!claimed.length) {
      // A retry may be intentionally delayed by provider rate limits. Poll for
      // at most one capped backoff window; longer work remains durably queued
      // for the next invocation rather than being hammered immediately.
      emptyClaims += 1;
      if (emptyClaims <= 25) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      throw new Error(`Timeline ingestion stopped with ${expectedTasks - terminalTasks} nonterminal tasks.`);
    }
    emptyClaims = 0;

    const receipts = await Promise.all(claimed.map(async (task) => {
      const company = task.entity_id ? byDatabaseId.get(task.entity_id) : null;
      if (!company || !isTimelineSourceClass(task.platform) || !task.lease_token) {
        return terminalTaskFailure(store, persistence, task, company ?? null, now(), "invalid_timeline_task", "Timeline task did not map to canonical inventory.");
      }
      const networkAllowed = now().getTime() < deadline;
      if (!networkAllowed && isNetworkSourceClass(task.platform)) budgetExhaustedTasks += 1;
      return processTimelineTask({
        store,
        persistence,
        task,
        company,
        now,
        discover,
        context: { networkAllowed, perFetchTimeoutMs, providers, deadlineAt: deadline },
      });
    }));

    for (const receipt of receipts) {
      if (!receipt.terminal) continue;
      terminalTasks += 1;
      if (receipt.taskStatus === "completed") completedTasks += 1;
      if (receipt.taskStatus === "blocked_or_empty") blockedOrEmptyTasks += 1;
      if (receipt.taskStatus === "dead_lettered") deadLetteredTasks += 1;
      if (receipt.companyId && receipt.sourceClass && receipt.coverageStatus) {
        coverage.get(receipt.companyId)![receipt.sourceClass] = receipt.coverageStatus;
      }
      sourceDocuments += receipt.persistence.sourceDocuments;
      candidates += receipt.persistence.candidates;
      publishedEvents += receipt.persistence.publishedEvents;
      unresolvedDates += receipt.persistence.unresolvedDates;
    }
  }

  const completedAt = now().toISOString();
  await persistence.finalizeCompanies(companies, coverage, completedAt);
  const receipt: TimelineDiscoveryRunReceipt = {
    status: "completed",
    version: TIMELINE_DISCOVERY_RUNNER_VERSION,
    companyCount: companies.length,
    expectedTasks,
    terminalTasks,
    completedTasks,
    blockedOrEmptyTasks,
    deadLetteredTasks,
    resumedTerminalTasks,
    budgetExhaustedTasks,
    sourceDocuments,
    candidates,
    publishedEvents,
    unresolvedDates,
    durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
  };
  await store.persistCoverageReport({
    runId: input.runId,
    reportKey: "company_timeline",
    platform: "timeline",
    expectedCount: expectedTasks,
    attemptedCount: terminalTasks - resumedTerminalTasks,
    succeededCount: completedTasks,
    failedCount: deadLetteredTasks,
    skippedCount: blockedOrEmptyTasks,
    report: receipt as unknown as JsonObject,
    generatedAt: completedAt,
  });
  await store.appendEvent({
    runId: input.runId,
    eventType: "timeline.discovery.completed",
    severity: deadLetteredTasks ? "warning" : "info",
    message: "Bounded Company Timeline discovery reached a terminal state for every source class.",
    payload: receipt as unknown as JsonObject,
  });
  return receipt;
}

/**
 * Drain the run-less tasks created atomically by Timeline admin actions.
 * A dedicated database claim function restricts this worker to
 * `ingestion_run_id is null` Timeline tasks, so it cannot steal work from a
 * normal ingestion run. The regular autonomous ingestion command invokes this
 * before its full inventory scan, giving admin requests a durable consumer
 * while keeping external discovery out of the HTTP request path.
 */
export async function runTimelineAdminTaskDrain(input: Omit<RunTimelineDiscoveryInput, "runId">): Promise<TimelineAdminTaskDrainReceipt> {
  const startedAt = (input.now ?? (() => new Date()))();
  const now = input.now ?? (() => new Date());
  const budgetMs = clamp(input.budgetMs ?? 30_000, 10_000, 2 * 60_000);
  const deadline = startedAt.getTime() + budgetMs;
  const concurrency = clamp(input.concurrency ?? 8, 1, 16);
  const perFetchTimeoutMs = clamp(input.perFetchTimeoutMs ?? 8_000, 1_000, 20_000);
  const store = input.store ?? new AutonomousIngestionStore(input.client);
  const classificationProvider = input.classificationProvider === undefined
    ? createConfiguredTimelineClassificationProvider(input.env ?? process.env, { deadlineAt: deadline })
    : input.classificationProvider;
  const persistence = input.persistence ?? new SupabaseTimelineDiscoveryPersistence(input.client, now, classificationProvider);
  const providers = [...(input.providers ?? createConfiguredTimelineSearchProviders(input.env ?? process.env))];
  const discover = input.discover ?? dispatchTimelineSourceClass;
  const companies = normalizeInventory(input.companies);
  const byDatabaseId = new Map(companies.map((company) => [company.databaseId, company]));
  // A process may die after leasing a run-less admin task. Reconcile expired
  // leases before claiming so those requests cannot remain permanently stuck
  // in `running`. The shared runtime RPC only transitions lease state; this
  // drain remains the sole executor for run-less Timeline work.
  await store.requeueExpiredTasks(1_000);
  let claimedTasks = 0;
  let terminalTasks = 0;
  let retryScheduledTasks = 0;
  let deadLetteredTasks = 0;
  let unknownCompanyTasks = 0;
  let sourceDocuments = 0;
  let candidates = 0;
  let publishedEvents = 0;
  let unresolvedDates = 0;
  let rotation = 0;

  while (now().getTime() < deadline) {
    const claimed = await claimTimelineAdminTasks(input.client, {
      workerId: input.workerId,
      limit: concurrency,
      // There is no per-request heartbeat in this bounded worker, so cover the
      // whole drain budget plus a cleanup margin. SQL still caps leases at one
      // hour independently.
      leaseDurationSeconds: Math.max(120, Math.ceil(budgetMs / 1_000) + 60),
      rotation: rotation++,
    });
    if (!claimed.length) break;
    claimedTasks += claimed.length;
    const receipts = await Promise.all(claimed.map(async (task) => {
      const company = task.entity_id ? byDatabaseId.get(task.entity_id) : null;
      if (!company || !isTimelineSourceClass(task.platform) || !task.lease_token) {
        unknownCompanyTasks += 1;
        return terminalTaskFailure(store, persistence, task, company ?? null, now(), "invalid_timeline_admin_task", "Timeline admin task did not map to canonical inventory.");
      }
      return processTimelineTask({
        store,
        persistence,
        task,
        company,
        now,
        discover,
        context: {
          networkAllowed: now().getTime() < deadline,
          perFetchTimeoutMs,
          providers,
          deadlineAt: deadline,
        },
      });
    }));
    for (const receipt of receipts) {
      if (receipt.terminal) terminalTasks += 1;
      else retryScheduledTasks += 1;
      if (receipt.taskStatus === "dead_lettered") deadLetteredTasks += 1;
      sourceDocuments += receipt.persistence.sourceDocuments;
      candidates += receipt.persistence.candidates;
      publishedEvents += receipt.persistence.publishedEvents;
      unresolvedDates += receipt.persistence.unresolvedDates;
    }
  }

  return {
    status: now().getTime() >= deadline ? "budget_exhausted" : "completed",
    claimedTasks,
    terminalTasks,
    retryScheduledTasks,
    deadLetteredTasks,
    unknownCompanyTasks,
    sourceDocuments,
    candidates,
    publishedEvents,
    unresolvedDates,
    durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
  };
}

async function claimTimelineAdminTasks(
  client: SupabaseLikeClient,
  input: { workerId: string; limit: number; leaseDurationSeconds: number; rotation: number },
): Promise<IngestionTaskRow[]> {
  const offset = Math.abs(input.rotation) % TIMELINE_SOURCE_CLASSES.length;
  const ordered = [...TIMELINE_SOURCE_CLASSES.slice(offset), ...TIMELINE_SOURCE_CLASSES.slice(0, offset)];
  const claimed: IngestionTaskRow[] = [];
  for (const sourceClass of ordered) {
    if (claimed.length >= input.limit) break;
    const response = await client.rpc<IngestionTaskRow[]>("claim_timeline_admin_tasks", {
      p_worker_id: input.workerId,
      p_limit: 1,
      p_lease_duration: `${input.leaseDurationSeconds} seconds`,
      p_source_class: sourceClass,
    });
    if (response.error) throw new Error(`claim Timeline admin tasks: ${response.error.message}`);
    claimed.push(...(response.data ?? []));
  }
  return claimed.slice(0, input.limit);
}

async function claimTimelineTasks(
  store: TimelineTaskStore,
  input: {
    workerId: string;
    runId: string;
    limit: number;
    leaseDurationSeconds: number;
    rotation: number;
  },
): Promise<IngestionTaskRow[]> {
  const claimed: IngestionTaskRow[] = [];
  const offset = Math.abs(input.rotation) % TIMELINE_SOURCE_CLASSES.length;
  const ordered = [
    ...TIMELINE_SOURCE_CLASSES.slice(offset),
    ...TIMELINE_SOURCE_CLASSES.slice(0, offset),
  ];
  // Claim at most one task per class per pass. With the default concurrency of
  // eight this covers all eight passes fairly; smaller limits continue from a
  // rotated class on the next drain iteration.
  for (const sourceClass of ordered) {
    if (claimed.length >= input.limit) break;
    const rows = await store.claimTasks({
      workerId: input.workerId,
      runId: input.runId,
      platform: sourceClass,
      limit: 1,
      leaseDurationSeconds: input.leaseDurationSeconds,
    });
    claimed.push(...rows);
  }
  return claimed.slice(0, input.limit);
}

interface ProcessReceipt {
  terminal: boolean;
  taskStatus: "completed" | "blocked_or_empty" | "dead_lettered" | "retry_scheduled";
  companyId: string | null;
  sourceClass: TimelineSourceClass | null;
  coverageStatus: TimelineSourceCoverageState | null;
  persistence: TimelinePersistenceReceipt;
}

const EMPTY_PERSISTENCE: TimelinePersistenceReceipt = Object.freeze({
  sourceDocuments: 0,
  candidates: 0,
  publishedEvents: 0,
  unresolvedDates: 0,
});

async function processTimelineTask(input: {
  store: TimelineTaskStore;
  persistence: TimelineDiscoveryPersistence;
  task: IngestionTaskRow;
  company: TimelineIngestionCompany;
  now: () => Date;
  discover: NonNullable<RunTimelineDiscoveryInput["discover"]>;
  context: TimelineDiscoveryContext;
}): Promise<ProcessReceipt> {
  const sourceClass = input.task.platform as TimelineSourceClass;
  try {
    await input.persistence.markCoverage(input.company, sourceClass, "running", {
      attempts: input.task.attempts,
      reason: null,
      error: null,
    });
    const discovered = await input.discover(sourceClass, input.company, input.context);
    if (discovered.status === "failed") throw new RetryableTimelineDiscoveryError("discovery_failed", discovered.reason);
    if (discovered.status === "rate_limited" && input.task.attempts < input.task.max_attempts) {
      throw new RetryableTimelineDiscoveryError("rate_limited", discovered.reason);
    }
    const terminalStatus = discovered.status === "rate_limited" ? "blocked" : discovered.status;
    const persistence = sourceClass === "timeline_reconcile_publish"
        && input.task.ingestion_run_id === null
        && input.persistence.reconcileCompany
      ? await input.persistence.reconcileCompany(input.company, input.now().toISOString())
      : discovered.sources.length
        ? await input.persistence.persistSources(input.company, sourceClass, discovered.sources, input.now().toISOString())
        : EMPTY_PERSISTENCE;
    await input.persistence.markCoverage(input.company, sourceClass, terminalStatus, {
      attempts: input.task.attempts,
      reason: discovered.reason,
      error: null,
      metadata: discovered.metadata,
    });
    const taskStatus = terminalStatus === "completed" ? "completed" : "blocked_or_empty";
    await input.store.completeTask({
      taskId: input.task.id,
      workerId: input.task.locked_by!,
      leaseToken: input.task.lease_token!,
      status: taskStatus,
      terminalReason: discovered.reason,
    });
    return {
      terminal: true,
      taskStatus,
      companyId: input.company.databaseId,
      sourceClass,
      coverageStatus: terminalStatus,
      persistence,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureKind = error instanceof RetryableTimelineDiscoveryError
      ? error.kind
      : "timeline_task_failure";
    if (input.task.attempts < input.task.max_attempts) {
      await input.persistence.markCoverage(input.company, sourceClass, "retry_pending", {
        attempts: input.task.attempts,
        reason: failureKind,
        error: message,
      });
      const retryDelayMs = Math.min(5_000, Math.max(
        input.task.rate_limit_ms,
        input.task.retry_base_delay_seconds * 1_000 * 2 ** Math.max(0, input.task.attempts - 1),
      ));
      await input.store.rescheduleTask({
        taskId: input.task.id,
        workerId: input.task.locked_by!,
        leaseToken: input.task.lease_token!,
        failureKind,
        message,
        error: { sourceClass, attempt: input.task.attempts },
        nextAttemptAt: new Date(input.now().getTime() + retryDelayMs).toISOString(),
      });
      return { terminal: false, taskStatus: "retry_scheduled", companyId: null, sourceClass: null, coverageStatus: null, persistence: EMPTY_PERSISTENCE };
    }
    await input.persistence.markCoverage(input.company, sourceClass, "failed", {
      attempts: input.task.attempts,
      reason: failureKind,
      error: message,
    });
    await input.store.deadLetterTask({
      taskId: input.task.id,
      workerId: input.task.locked_by!,
      leaseToken: input.task.lease_token!,
      failureKind,
      message,
      error: { sourceClass, attempt: input.task.attempts },
      terminalReason: `${failureKind}_attempts_exhausted`,
    });
    return {
      terminal: true,
      taskStatus: "dead_lettered",
      companyId: input.company.databaseId,
      sourceClass,
      coverageStatus: "failed",
      persistence: EMPTY_PERSISTENCE,
    };
  }
}

async function terminalTaskFailure(
  store: TimelineTaskStore,
  persistence: TimelineDiscoveryPersistence,
  task: IngestionTaskRow,
  company: TimelineIngestionCompany | null,
  at: Date,
  kind: string,
  message: string,
): Promise<ProcessReceipt> {
  if (company && isTimelineSourceClass(task.platform)) {
    await persistence.markCoverage(company, task.platform, "failed", {
      attempts: task.attempts,
      reason: kind,
      error: message,
    });
  }
  if (!task.locked_by || !task.lease_token) throw new Error(message);
  await store.deadLetterTask({
    taskId: task.id,
    workerId: task.locked_by,
    leaseToken: task.lease_token,
    failureKind: kind,
    message,
    error: { at: at.toISOString() },
  });
  return {
    terminal: true,
    taskStatus: "dead_lettered",
    companyId: company?.databaseId ?? null,
    sourceClass: isTimelineSourceClass(task.platform) ? task.platform : null,
    coverageStatus: company ? "failed" : null,
    persistence: EMPTY_PERSISTENCE,
  };
}

export async function dispatchTimelineSourceClass(
  sourceClass: TimelineSourceClass,
  company: TimelineIngestionCompany,
  context: TimelineDiscoveryContext,
): Promise<TimelineDiscoveryHandlerResult> {
  if (sourceClass === "timeline_existing_evidence") {
    const sources = (company.existingEvidence ?? [])
      .filter((evidence) => evidence.entityType !== "founder")
      .map(timelineClassificationSourceFromGraphEvidence);
    return {
      status: sources.length ? "completed" : "no_results",
      reason: sources.length ? "canonical_graph_evidence_imported" : "canonical_graph_has_no_evidence",
      sources,
      metadata: { evidenceCount: sources.length },
    };
  }
  if (sourceClass === "timeline_founder_sources") {
    if (!company.founderNames.length) {
      return { status: "no_applicable_source", reason: "company_has_no_canonical_founders", sources: [] };
    }
    const sources = (company.existingEvidence ?? [])
      .filter((evidence) => evidence.entityType === "founder")
      .map(timelineClassificationSourceFromGraphEvidence);
    return {
      status: sources.length ? "completed" : "no_results",
      reason: sources.length ? "canonical_founder_evidence_imported" : "no_material_founder_history_in_canonical_evidence",
      sources,
      metadata: { evidenceCount: sources.length },
    };
  }
  if (sourceClass === "timeline_reconcile_publish") {
    return { status: "completed", reason: "durable_candidates_reconciled_during_source_persistence", sources: [] };
  }
  if (!context.networkAllowed) {
    return { status: "blocked", reason: "bounded_timeline_discovery_budget_exhausted", sources: [] };
  }
  if (context.deadlineAt !== undefined && context.deadlineAt - Date.now() < 1_000) {
    return { status: "blocked", reason: "bounded_timeline_discovery_budget_exhausted", sources: [] };
  }

  const fetchPage = (url: string) => fetchSafeTimelineSource(url, {
    timeoutMs: remainingTimelineFetchTimeout(context),
    deadlineAt: context.deadlineAt,
    maxBytes: 1_000_000,
    maxRedirects: 3,
  });
  let discovered: TimelineWebDiscoveryResult;
  if (sourceClass === "timeline_official_site") {
    if (!company.websiteUrl) return { status: "no_applicable_source", reason: "company_has_no_official_website", sources: [] };
    discovered = await discoverTimelineDirectSources(company, [company.websiteUrl], {
      discoveryMethod: "official_site",
      fetchPage,
      maxUrls: 1,
      followInternalLinks: 4,
    });
  } else if (sourceClass === "timeline_institutional_sources") {
    if (!company.profileUrl) return { status: "no_applicable_source", reason: "company_has_no_institutional_profile", sources: [] };
    discovered = await discoverTimelineDirectSources(company, [company.profileUrl], {
      discoveryMethod: "institutional_profile",
      fetchPage,
      maxUrls: 1,
      sourceType: "accelerator_profile",
      sourceQualityTier: 1,
    });
  } else if (sourceClass === "timeline_historical_archive") {
    if (!company.websiteUrl) {
      return { status: "no_applicable_source", reason: "company_has_no_official_website_for_archive", sources: [] };
    }
    discovered = await discoverTimelineHistoricalArchiveSources(company, {
      maxCaptures: 3,
      fetchIndex: (url) => fetchSafeTimelineSource(url, {
        timeoutMs: remainingTimelineFetchTimeout(context),
        deadlineAt: context.deadlineAt,
        maxBytes: 250_000,
        maxRedirects: 2,
        allowedMimeTypes: ["application/json", "text/plain"],
      }),
      fetchPage,
    });
  } else if (sourceClass === "timeline_public_web" || sourceClass === "timeline_gap_followup") {
    if (!context.providers.length) {
      return { status: "authentication_required", reason: "no_public_search_provider_credential", sources: [] };
    }
    const identity = `"${company.name}"`;
    const site = company.websiteUrl ? ` site:${new URL(company.websiteUrl).hostname}` : "";
    const queries = sourceClass === "timeline_gap_followup"
        ? [
          `${identity}${site} (customer OR partnership OR pricing OR revenue OR users)`,
          `${identity} (acquired OR merger OR pivot OR shutdown OR regulatory OR patent)`,
        ]
        : undefined;
    discovered = await discoverTimelineWebSources(company, {
      providers: context.providers,
      queries,
      // Use both bounded query families: the first targets launches/capital and
      // the second targets founding/accelerator/traction history. Running only
      // the first made foundational events undiscoverable by construction.
      maxQueries: 2,
      maxResultsPerQuery: 3,
      maxFetchedPages: 3,
      fetchPage,
      // Search provider calls must share the same hard per-task budget as page
      // fetches; otherwise one hanging provider can outlive the task lease.
      signal: AbortSignal.timeout(remainingTimelineFetchTimeout(context)),
    });
  } else {
    return { status: "failed", reason: `unhandled_timeline_source_class:${sourceClass}`, sources: [] };
  }
  return {
    status: discovered.status,
    reason: discoveryReason(sourceClass, discovered),
    sources: discovered.sources,
    metadata: {
      searchedQueries: discovered.searchedQueries.length,
      discoveredUrls: discovered.discoveredUrls,
      fetchedUrls: discovered.fetchedUrls,
      failureCount: discovered.failures.length,
    },
  };
}

function remainingTimelineFetchTimeout(context: TimelineDiscoveryContext): number {
  if (context.deadlineAt === undefined) return context.perFetchTimeoutMs;
  const remaining = Math.floor(context.deadlineAt - Date.now());
  if (remaining < 1_000) throw new Error("bounded_timeline_discovery_budget_exhausted");
  return Math.min(context.perFetchTimeoutMs, remaining);
}

export class SupabaseTimelineDiscoveryPersistence implements TimelineDiscoveryPersistence {
  private readonly client: SupabaseLikeClient;
  private readonly now: () => Date;
  private readonly classificationProvider: TimelineClassificationProvider | null;
  constructor(
    client: SupabaseLikeClient,
    now: () => Date = () => new Date(),
    classificationProvider: TimelineClassificationProvider | null = null,
  ) {
    this.client = client;
    this.now = now;
    this.classificationProvider = classificationProvider;
  }

  async markCoverage(
    company: TimelineIngestionCompany,
    sourceClass: TimelineSourceClass,
    status: TimelineSourceCoverageState,
    input: { attempts: number; reason?: string | null; error?: string | null; metadata?: JsonObject },
  ): Promise<void> {
    const at = this.now().toISOString();
    const terminal = isTerminalCoverage(status);
    await checked(this.client.from("timeline_source_coverage").upsert({
      company_id: company.databaseId,
      source_class: sourceClass,
      status,
      attempts: input.attempts,
      last_attempt_at: status === "pending" ? null : at,
      terminal_at: terminal ? at : null,
      terminal_reason: terminal ? input.reason ?? status : null,
      cursor_json: input.metadata ?? {},
      last_error: input.error ?? null,
    }, { onConflict: "company_id,source_class" }), `persist ${sourceClass} coverage`);
  }

  async persistSources(
    company: TimelineIngestionCompany,
    sourceClass: TimelineSourceClass,
    sources: readonly TimelineClassificationSource[],
    fetchedAt: string,
  ): Promise<TimelinePersistenceReceipt> {
    const receipt = { ...EMPTY_PERSISTENCE };
    const durableSources = new Map<string, {
      sourceDocumentId: string;
      sourceEventDate: string | null;
      normalized: NormalizedSourceDocument;
    }>();

    // Persist the full discovery set before classification. A classifier may
    // discover that several direct sources describe one event (including
    // disagreeing claims); every claim must already have a durable document
    // identity before the candidate or event is written.
    for (const source of sources) {
      const normalized = normalizeClassificationSource(source, sourceClass, fetchedAt);
      const sourceRow = await one<{ id: string }>(this.client.from<{ id: string }>("source_documents").upsert({
        original_url: normalized.originalUrl,
        canonical_url: normalized.canonicalUrl,
        source_type: normalized.sourceType,
        publisher: normalized.publisher,
        domain: normalized.domain,
        title: normalized.title,
        author: normalized.author,
        published_at: normalized.publishedAt,
        fetched_at: normalized.fetchedAt,
        last_seen_at: normalized.fetchedAt,
        last_validated_at: normalized.fetchedAt,
        http_status: source.httpStatus ?? (source.linkStatus === "verified" ? 200 : null),
        content_hash: normalized.contentHash,
        normalized_text: normalized.normalizedText,
        excerpt: normalized.excerpt,
        metadata_json: normalized.metadata,
        discovery_method: normalized.discoveryMethod,
        source_quality_tier: normalized.sourceQualityTier,
        attribution_status: source.attributionStatus,
      }, { onConflict: "canonical_url" }).select("id").single(), "upsert timeline source document");
      receipt.sourceDocuments += 1;
      await this.ensureCompanySourceLink(sourceRow.id, company.databaseId, sourceClass);
      durableSources.set(source.id, {
        sourceDocumentId: sourceRow.id,
        sourceEventDate: normalized.publishedAt?.slice(0, 10) ?? null,
        normalized,
      });
    }

    for (const source of sources) {
      const durableSource = durableSources.get(source.id);
      if (!durableSource) throw new Error(`Timeline source ${source.id} was not durably persisted.`);
      const { sourceDocumentId, normalized } = durableSource;

      const classifierVersion = configuredTimelineClassifierVersion(this.classificationProvider);
      const existingCandidate = await optionalOne<{ id: string; status: string }>(this.client.from<{ id: string; status: string }>("timeline_event_candidates")
        .select("id,status").eq("company_id", company.databaseId).eq("input_content_hash", normalized.contentHash)
        .eq("classifier_version", classifierVersion).eq("extraction_version", TIMELINE_EXTRACTION_VERSION)
        .maybeSingle(), "read idempotent timeline candidate");
      let classification: TimelineClassifierResult;
      try {
        classification = await classifyDiscoveredTimelineSourceWithAi(company, sources, source, this.classificationProvider);
      } catch (error) {
        const deterministicFallback = classifyDiscoveredTimelineSource(company, sources, source);
        if (deterministicFallback.isMeaningfulEvent && deterministicFallback.conflicts.length > 0) {
          // A provider outage is not permission to discard a directly
          // observed disagreement. Preserve it as review-only deterministic
          // evidence with the configured model lineage.
          classification = {
            ...deterministicFallback,
            classifierVersion,
            extractionVersion: TIMELINE_EXTRACTION_VERSION,
          };
        } else {
          const failure = aiFailureCandidate(company, source, classifierVersion);
          const durableFailure = timelineCandidatePayloadWithDurableSource(
            failure,
            source.id,
            sourceDocumentId,
          );
          const candidate = await one<{ id: string }>(this.client.from<{ id: string }>("timeline_event_candidates").upsert({
            company_id: company.databaseId,
            candidate_payload: durableFailure,
            proposed_event_date: null,
            proposed_event_date_type: null,
            proposed_category: null,
            proposed_title: null,
            proposed_summary: null,
            proposed_importance: null,
            proposed_merge_key: null,
            rejection_reason: `ai_classification_failed:${boundedError(error)}`,
            status: "needs_review",
            classifier_version: classifierVersion,
            extraction_version: TIMELINE_EXTRACTION_VERSION,
            input_content_hash: normalized.contentHash,
          }, { onConflict: "company_id,input_content_hash,classifier_version,extraction_version" }).select("id").single(), "preserve failed AI timeline candidate");
          await checked(this.client.from("timeline_candidate_sources").upsert({
            candidate_id: candidate.id,
            source_document_id: sourceDocumentId,
            evidence_role: "discovery_only",
          }, { onConflict: "candidate_id,source_document_id" }), "link failed AI timeline candidate source");
          receipt.candidates += 1;
          if (!source.publicationTimestamp) receipt.unresolvedDates += 1;
          continue;
        }
      }
      // Terminal candidates are normally idempotent. A newly observed
      // material conflict is the exception: it must withdraw a previously
      // accepted/public event and retain all newly contradictory evidence.
      if (existingCandidate && ["accepted", "rejected", "merged", "needs_review"].includes(existingCandidate.status)
          && (!classification.isMeaningfulEvent || classification.conflicts.length === 0)) {
        await checked(this.client.from("timeline_candidate_sources").upsert({
          candidate_id: existingCandidate.id,
          source_document_id: sourceDocumentId,
          evidence_role: existingCandidate.status === "accepted" ? "primary" : "discovery_only",
        }, { onConflict: "candidate_id,source_document_id" }), "link existing timeline candidate source");
        continue;
      }
      if (!classification.isMeaningfulEvent
          && !(classification.reason === "exact_date_unsupported" && isPotentialTimelineClaim(source))) {
        continue;
      }
      const durableClassification = timelineCandidatePayloadWithDurableSources(classification, durableSources);
      const hasConflict = classification.isMeaningfulEvent && classification.conflicts.length > 0;
      const candidate = await one<{ id: string }>(this.client.from<{ id: string }>("timeline_event_candidates").upsert({
        company_id: company.databaseId,
        candidate_payload: durableClassification,
        proposed_event_date: classification.isMeaningfulEvent ? classification.eventDate : null,
        proposed_event_date_type: classification.isMeaningfulEvent ? classification.eventDateType : null,
        proposed_category: classification.isMeaningfulEvent ? classification.category : null,
        proposed_title: classification.isMeaningfulEvent ? classification.title : null,
        proposed_summary: classification.isMeaningfulEvent ? classification.summary : null,
        proposed_importance: classification.isMeaningfulEvent ? classification.importanceScore : null,
        proposed_merge_key: classification.isMeaningfulEvent ? classification.mergeKey : null,
        rejection_reason: classification.isMeaningfulEvent
          ? hasConflict ? "unresolved_material_conflict" : null
          : classification.reason,
        status: classification.isMeaningfulEvent
          ? hasConflict ? "needs_review" : "processing"
          : classification.reason === "exact_date_unsupported" ? "needs_review" : "rejected",
        classifier_version: classification.classifierVersion,
        extraction_version: classification.extractionVersion,
        input_content_hash: normalized.contentHash,
      }, { onConflict: "company_id,input_content_hash,classifier_version,extraction_version" }).select("id").single(), "upsert timeline candidate");
      receipt.candidates += 1;
      if (!classification.isMeaningfulEvent && classification.reason === "exact_date_unsupported") receipt.unresolvedDates += 1;
      const candidateSourceIds = classification.isMeaningfulEvent ? classification.sourceIds : [source.id];
      for (const classifierSourceId of candidateSourceIds) {
        const linkedSource = durableSources.get(classifierSourceId);
        if (!linkedSource) continue;
        await checked(this.client.from("timeline_candidate_sources").upsert({
          candidate_id: candidate.id,
          source_document_id: linkedSource.sourceDocumentId,
          evidence_role: !classification.isMeaningfulEvent ? "discovery_only"
            : classifierSourceId === classification.sourceIds[0] ? "primary"
              : sourceHasNonSelectedConflict(classification, classifierSourceId) ? "conflicting" : "supporting",
        }, { onConflict: "candidate_id,source_document_id" }), "link timeline candidate source");
      }
      if (!classification.isMeaningfulEvent) continue;

      const eventId = await this.persistAcceptedEvent(company, durableSources, classification);
      if (eventId) {
        await checked(this.client.from("timeline_event_candidates").update({ status: "accepted", rejection_reason: null })
          .eq("id", candidate.id), "accept timeline candidate");
      } else if (!hasConflict) {
        await checked(this.client.from("timeline_event_candidates").update({
          status: "needs_review",
          rejection_reason: "unresolved_material_conflict",
        }).eq("id", candidate.id), "retain candidate for existing conflict review");
      }
      if (eventId) receipt.publishedEvents += 1;
    }
    return receipt;
  }

  async reconcileCompany(
    company: TimelineIngestionCompany,
    fetchedAt: string,
  ): Promise<TimelinePersistenceReceipt> {
    const links = await many<{ source_document_id: string }>(
      this.client.from<{ source_document_id: string }[]>("source_document_entities")
        .select("source_document_id")
        .eq("company_id", company.databaseId)
        .eq("relationship_type", "subject"),
      "read durable Timeline company sources",
    );
    const sourceIds = [...new Set(links.map((row) => row.source_document_id).filter(Boolean))];
    if (!sourceIds.length) return EMPTY_PERSISTENCE;
    if (sourceIds.length > 1_000) {
      throw new Error(`Timeline reclassification exceeded the 1,000-source per-company safety bound for ${company.id}.`);
    }
    const rows = await many<Record<string, unknown>>(
      this.client.from<Record<string, unknown>[]>("source_documents").select("*").in("id", sourceIds),
      "read source documents for Timeline reclassification",
    );
    if (rows.length !== sourceIds.length) {
      throw new Error(`Timeline reclassification resolved ${rows.length}/${sourceIds.length} durable source documents for ${company.id}.`);
    }
    const sources = rows.map(durableClassificationSource);
    return this.persistSources(company, "timeline_reconcile_publish", sources, fetchedAt);
  }

  async finalizeCompanies(
    companies: readonly TimelineIngestionCompany[],
    coverage: ReadonlyMap<string, Readonly<Record<string, TimelineSourceCoverageState>>>,
    completedAt: string,
  ): Promise<void> {
    for (let offset = 0; offset < companies.length; offset += 200) {
      const companyChunk = companies.slice(offset, offset + 200);
      const companyIds = companyChunk.map((company) => company.databaseId);
      const [existingStates, eventRows, candidateRows] = await Promise.all([
        readBoundedTimelineRows<TimelineCompanyStateCountRow>(
          this.client,
          "timeline_company_state",
          "company_id,historical_backfill_status,historical_backfill_started_at,historical_backfill_completed_at,last_incremental_scan_at,last_deep_scan_at,source_coverage",
          "company_id",
          companyIds,
        ),
        readBoundedTimelineRows<TimelineEventCountRow>(
          this.client,
          "timeline_events",
          "primary_company_id,status,has_conflict",
          "primary_company_id",
          companyIds,
        ),
        readBoundedTimelineRows<TimelineCandidateCountRow>(
          this.client,
          "timeline_event_candidates",
          "company_id,status,proposed_event_date",
          "company_id",
          companyIds,
        ),
      ]);
      const existingStateByCompanyId = new Map(existingStates.map((row) => [row.company_id, row]));
      const countsByCompanyId = new Map(companyIds.map((companyId) => [companyId, emptyTimelineCompanyCounts()]));
      for (const event of eventRows) {
        const counts = countsByCompanyId.get(event.primary_company_id);
        if (!counts) continue;
        if (event.status === "published") counts.publishedEvents += 1;
        if (event.has_conflict && ["needs_review", "published"].includes(event.status)) {
          counts.unresolvedConflicts += 1;
        }
      }
      for (const candidate of candidateRows) {
        const counts = countsByCompanyId.get(candidate.company_id);
        if (!counts || !["pending", "processing", "needs_review"].includes(candidate.status)) continue;
        counts.candidates += 1;
        if (!candidate.proposed_event_date) counts.unresolvedDates += 1;
      }

      const rows = companyChunk.map((company) => {
        const scannedCoverage = coverage.get(company.databaseId) ?? {};
        const counts = countsByCompanyId.get(company.databaseId) ?? emptyTimelineCompanyCounts();
        const existingState = existingStateByCompanyId.get(company.databaseId);
        const deepScan = Object.prototype.hasOwnProperty.call(scannedCoverage, "timeline_historical_archive");
        const sourceCoverage: Record<string, TimelineSourceCoverageState> = deepScan
          ? { ...scannedCoverage }
          : { ...timelineSourceCoverageObject(existingState?.source_coverage), ...scannedCoverage };
        const scannedStatus = deriveTimelineCompanyCoverageStatus(sourceCoverage);
        const historicalBackfillStatus = deepScan
          ? scannedStatus
          : existingState?.historical_backfill_status ?? "pending";
        return {
          company_id: company.databaseId,
          historical_backfill_status: historicalBackfillStatus,
          historical_backfill_started_at: deepScan
            ? existingState?.historical_backfill_started_at ?? completedAt
            : existingState?.historical_backfill_started_at ?? null,
          historical_backfill_completed_at: deepScan
            ? completedAt
            : existingState?.historical_backfill_completed_at ?? null,
          last_incremental_scan_at: deepScan ? existingState?.last_incremental_scan_at ?? null : completedAt,
          last_deep_scan_at: deepScan ? completedAt : existingState?.last_deep_scan_at ?? null,
          published_event_count: counts.publishedEvents,
          candidate_event_count: counts.candidates,
          unresolved_conflict_count: counts.unresolvedConflicts,
          unresolved_date_count: counts.unresolvedDates,
          source_coverage: sourceCoverage,
          last_error: scannedStatus === "completed" ? null : summarizeCompanyLimitations(sourceCoverage),
        };
      });
      await checked(this.client.from("timeline_company_state").upsert(rows, { onConflict: "company_id" }), "finalize timeline company states");
    }
  }

  private async ensureCompanySourceLink(sourceDocumentId: string, companyId: string, sourceClass: string): Promise<void> {
    const existing = await optionalOne<{ id: string }>(this.client.from<{ id: string }>("source_document_entities")
      .select("id").eq("source_document_id", sourceDocumentId).eq("company_id", companyId)
      .eq("relationship_type", "subject").maybeSingle(), "read timeline source entity link");
    if (existing) return;
    await checked(this.client.from("source_document_entities").insert({
      source_document_id: sourceDocumentId,
      company_id: companyId,
      founder_id: null,
      relationship_type: "subject",
      relevance_reason: `Verified company match from ${sourceClass}.`,
    }), "insert timeline source entity link");
  }

  private async persistAcceptedEvent(
    company: TimelineIngestionCompany,
    durableSources: ReadonlyMap<string, { sourceDocumentId: string; sourceEventDate?: string | null }>,
    classification: Extract<TimelineClassifierResult, { isMeaningfulEvent: true }>,
  ): Promise<string | null> {
    const eventKey = classification.mergeKey.toLowerCase().trim().slice(0, 300);
    const hasConflict = classification.conflicts.length > 0;
    const conflictSummary = hasConflict ? summarizeTimelineConflicts(classification) : null;
    const exactEvent = await optionalOne<{ id: string; has_conflict: boolean; status: string }>(
      this.client.from<{ id: string; has_conflict: boolean; status: string }>("timeline_events")
        .select("id,has_conflict,status")
        .eq("primary_company_id", company.databaseId)
        .eq("event_key", eventKey)
        .maybeSingle(),
      "read existing timeline event",
    );
    // A terminal event is immutable ingestion history. Preserve the new
    // conflict as a review candidate instead of reviving or rewriting it.
    if (exactEvent && isTerminalTimelineEventStatus(exactEvent.status)) return null;
    let event: { id: string; has_conflict: boolean } | null = exactEvent;
    if (!event && hasConflict) {
      const sourceDocumentIds = classification.sourceIds.flatMap((sourceId) => {
        const source = durableSources.get(sourceId);
        return source ? [source.sourceDocumentId] : [];
      });
      event = await findSameCompanyTimelineEventBySourceDocuments(
        this.client,
        company.databaseId,
        sourceDocumentIds,
        {
          eventKey,
          category: classification.category,
          eventDate: classification.eventDate,
          title: classification.title,
        },
      );
    }
    if (!event) {
      event = await one<{ id: string; has_conflict: boolean }>(this.client.from<{ id: string; has_conflict: boolean }>("timeline_events").insert({
        primary_company_id: company.databaseId,
        category: classification.category,
        title: classification.title,
        summary: classification.summary,
        event_date: classification.eventDate,
        event_date_type: classification.eventDateType,
        importance_score: classification.importanceScore,
        is_major: classification.isMajor,
        event_key: eventKey,
        status: "candidate",
        has_conflict: hasConflict,
        conflict_summary: conflictSummary,
        classifier_version: classification.classifierVersion,
        extraction_version: classification.extractionVersion,
      }).select("id,has_conflict").single(), "insert timeline event");
    }
    if (hasConflict) {
      // Remove an already-published event from the public projection before
      // mutating its evidence rows. Evidence revalidation triggers then see a
      // review-only event and cannot strand contradictory data outside it.
      await checked(this.client.from("timeline_events").update({
        category: classification.category,
        title: classification.title,
        summary: classification.summary,
        event_date: classification.eventDate,
        event_date_type: classification.eventDateType,
        importance_score: classification.importanceScore,
        is_major: classification.isMajor,
        status: "needs_review",
        has_conflict: true,
        conflict_summary: conflictSummary,
        last_updated_at: this.now().toISOString(),
      }).eq("id", event.id), "withdraw conflicting timeline event for review");
    }
    const entityLink = await optionalOne<{ id: string }>(this.client.from<{ id: string }>("timeline_event_entities")
      .select("id").eq("event_id", event.id).eq("company_id", company.databaseId)
      .eq("relationship_type", "subject").maybeSingle(), "read timeline event entity link");
    if (!entityLink) {
      await checked(this.client.from("timeline_event_entities").insert({
        event_id: event.id,
        entity_type: "company",
        company_id: company.databaseId,
        founder_id: null,
        external_entity_name: null,
        relationship_type: "subject",
        is_primary: true,
      }), "insert timeline event entity link");
    }
    for (const evidenceRow of timelineEventEvidenceRows(event.id, classification, durableSources)) {
      await checked(this.client.from("timeline_event_evidence").upsert(
        evidenceRow,
        { onConflict: "event_id,source_document_id" },
      ), "upsert timeline event evidence");
    }
    await linkVerifiedTimelineEventPosts({
      client: this.client,
      eventId: event.id,
      companyId: company.databaseId,
      classification,
      graphEvidence: company.existingEvidence ?? [],
    });
    if (hasConflict) return null;
    // Conflict resolution is an explicit reviewed admin action. A later
    // single-source pass may add evidence but cannot silently clear a durable
    // unresolved conflict and put the event back in the public projection.
    if (event.has_conflict) return null;
    // The database publication trigger independently re-checks direct verified
    // evidence for date, title, and summary. Ingestion cannot bypass that gate.
    await checked(this.client.from("timeline_events").update({
      category: classification.category,
      title: classification.title,
      summary: classification.summary,
      event_date: classification.eventDate,
      event_date_type: classification.eventDateType,
      importance_score: classification.importanceScore,
      is_major: classification.isMajor,
      status: "published",
      has_conflict: false,
      conflict_summary: null,
      published_at: this.now().toISOString(),
      last_updated_at: this.now().toISOString(),
      classifier_version: classification.classifierVersion,
      extraction_version: classification.extractionVersion,
    }).eq("id", event.id), "publish timeline event");
    return event.id;
  }
}

/**
 * Conflict reconciliation is source-assisted, but company identity remains
 * authoritative. A source document can be (incorrectly or legitimately)
 * linked to more than one event, so the evidence lookup only supplies bounded
 * event IDs; the event-table lookup must independently enforce the exact
 * primary company before the caller is allowed to mutate an event.
 */
export async function findSameCompanyTimelineEventBySourceDocuments(
  client: SupabaseLikeClient,
  companyId: string,
  sourceDocumentIds: readonly string[],
  identity: {
    eventKey: string;
    category: TimelineCategory;
    eventDate: string;
    title: string;
  },
): Promise<{ id: string; has_conflict: boolean } | null> {
  const boundedSourceIds = [...new Set(sourceDocumentIds.filter(Boolean))].slice(0, 1_000);
  if (!boundedSourceIds.length) return null;
  const evidenceRows = await many<{ event_id: string }>(
    client.from<{ event_id: string }[]>("timeline_event_evidence")
      .select("event_id")
      .in("source_document_id", boundedSourceIds)
      .limit(1_001),
    "find prior events from conflicting evidence",
  );
  if (evidenceRows.length > 1_000) {
    throw new Error("Timeline conflict reconciliation exceeded the 1,000-event safety bound.");
  }
  const eventIds = [...new Set(evidenceRows.map((row) => row.event_id).filter(Boolean))];
  if (!eventIds.length) return null;
  const candidates = await many<{
    id: string;
    has_conflict: boolean;
    status: string;
    event_key: string;
    category: string;
    event_date: string;
    title: string;
  }>(
    client.from<Array<{
      id: string;
      has_conflict: boolean;
      status: string;
      event_key: string;
      category: string;
      event_date: string;
      title: string;
    }>>("timeline_events")
      .select("id,has_conflict,status,event_key,category,event_date,title")
      .in("id", eventIds)
      .eq("primary_company_id", companyId)
      .limit(1_001),
    "find same-company prior events from conflicting evidence",
  );
  if (candidates.length > 1_000) {
    throw new Error("Timeline conflict reconciliation exceeded the 1,000-candidate safety bound.");
  }
  const active = candidates.filter((candidate) => !isTerminalTimelineEventStatus(candidate.status));
  const exactKeyMatches = active.filter((candidate) => candidate.event_key === identity.eventKey);
  const deterministicMatches = exactKeyMatches.length
    ? exactKeyMatches
    : active.filter((candidate) =>
      (TIMELINE_CATEGORIES as readonly string[]).includes(candidate.category)
      && shouldMergeTimelineEvents(
        {
          companyId,
          category: identity.category,
          eventDate: identity.eventDate,
          title: identity.title,
        },
        {
          id: candidate.id,
          companyId,
          category: candidate.category as TimelineCategory,
          eventDate: candidate.event_date,
          title: candidate.title,
        },
      )
    );
  // Source overlap is only a candidate generator. Reuse is permitted solely
  // when event identity resolves to one active row; ambiguity creates a new
  // review event instead of arbitrarily rewriting either existing event.
  if (deterministicMatches.length !== 1) return null;
  const match = deterministicMatches[0]!;
  return { id: match.id, has_conflict: match.has_conflict };
}

function isTerminalTimelineEventStatus(status: string): boolean {
  return ["merged", "superseded", "rejected"].includes(status);
}

function normalizeClassificationSource(
  source: TimelineClassificationSource,
  sourceClass: TimelineSourceClass,
  fetchedAt: string,
): NormalizedSourceDocument {
  return normalizeSourceDocument({
    originalUrl: source.originalUrl ?? source.url,
    canonicalUrl: source.canonicalUrl ?? source.url,
    title: source.title ?? source.publisher ?? "Public source",
    publisher: source.publisher,
    author: source.author,
    sourceType: source.sourceType,
    publishedAt: source.publicationTimestamp,
    fetchedAt,
    text: source.text,
    excerpt: source.evidenceExcerpt,
    metadata: {
      ...(source.metadata ?? {}),
      classifierSourceId: source.id,
      platform: source.platform,
      authorRelationship: source.authorRelationship,
      publicationDatePrecision: source.publicationDatePrecision,
      pageUpdatedAt: source.updatedTimestamp ?? null,
      evidenceOrigin: sourceClass === "timeline_existing_evidence" || sourceClass === "timeline_founder_sources"
        ? "canonical_graph_evidence"
        : "safely_fetched_page",
      searchSnippetUsedAsEvidence: false,
    },
    discoveryMethod: sourceClass,
    sourceQualityTier: source.sourceQualityTier,
  });
}

/**
 * Classifier source IDs are stable extraction identifiers, while normalized
 * source_documents use UUID primary keys. Persist both identities together so
 * a later administrator review can bind each support claim to the exact
 * durable source without guessing or weakening the publication evidence gate.
 */
export function timelineCandidatePayloadWithDurableSource(
  classification: TimelineClassifierResult,
  classifierSourceId: string,
  sourceDocumentId: string,
): Record<string, unknown> {
  return timelineCandidatePayloadWithDurableSources(classification, new Map([
    [classifierSourceId, { sourceDocumentId }],
  ]));
}

function timelineCandidatePayloadWithDurableSources(
  classification: TimelineClassifierResult,
  durableSources: ReadonlyMap<string, { sourceDocumentId: string }>,
): Record<string, unknown> {
  const durableSourceMap = Object.fromEntries(
    classification.sourceIds.flatMap((sourceId) => {
      const durable = durableSources.get(sourceId);
      return durable ? [[sourceId, durable.sourceDocumentId]] : [];
    }),
  );
  if (!classification.isMeaningfulEvent) return { ...classification, durableSourceMap };
  return {
    ...classification,
    durableSourceMap,
    evidence: classification.evidence.map((claim) => {
      const durable = durableSources.get(claim.sourceId);
      return durable ? { ...claim, sourceDocumentId: durable.sourceDocumentId } : claim;
    }),
  };
}

/** Pure projection used by persistence and tests to guarantee that every
 * direct source remains attached, with non-selected claims explicitly marked
 * conflicting rather than overwritten by the selected value. */
export function timelineEventEvidenceRows(
  eventId: string,
  classification: Extract<TimelineClassifierResult, { isMeaningfulEvent: true }>,
  durableSources: ReadonlyMap<string, { sourceDocumentId: string; sourceEventDate?: string | null }>,
): Array<Record<string, unknown>> {
  return classification.evidence.flatMap((claim) => {
    const durableSource = durableSources.get(claim.sourceId);
    if (!durableSource) return [];
    const sourceConflicts = conflictsForSource(classification, claim.sourceId);
    const conflicting = sourceConflicts.some(({ conflict, sourceClaim }) =>
      normalizeConflictValue(sourceClaim.value) !== normalizeConflictValue(conflict.selectedValue ?? "")
    );
    const sourceDateClaim = sourceConflicts.find(({ conflict }) => conflict.field === "event_date")?.sourceClaim.value
      ?? durableSource.sourceEventDate
      ?? classification.eventDate;
    const quantitativeConflict = sourceConflicts.some(({ conflict, sourceClaim }) =>
      conflict.field !== "event_date"
      && normalizeConflictValue(sourceClaim.value) !== normalizeConflictValue(conflict.selectedValue ?? "")
    );
    return [{
      event_id: eventId,
      source_document_id: durableSource.sourceDocumentId,
      evidence_role: conflicting ? "conflicting" : claim.sourceId === classification.sourceIds[0] ? "primary" : "supporting",
      supports_event_date: claim.supports.includes("eventDate") && sourceDateClaim === classification.eventDate,
      supports_title: claim.supports.includes("title"),
      supports_summary: claim.supports.includes("summary"),
      supports_quantitative_claim: claim.supports.includes("quantitativeClaim") && !quantitativeConflict,
      evidence_excerpt: claim.excerpt,
      extracted_claims: {
        sourceId: claim.sourceId,
        supports: claim.supports,
        title: classification.title,
        summary: classification.summary,
        eventDate: sourceDateClaim,
        conflicts: sourceConflicts.map(({ conflict, sourceClaim }) => ({
          field: conflict.field,
          value: sourceClaim.value,
          selectedValue: conflict.selectedValue,
        })),
      },
      source_event_date: sourceDateClaim,
      is_conflicting: conflicting,
      conflict_description: conflicting
        ? sourceConflicts.map(({ conflict }) => conflict.description).join(" ").slice(0, 500)
        : null,
    }];
  });
}

const MAX_VERIFIED_COMPANY_ATTRIBUTIONS = 1_000;

interface TimelineGraphEvidenceReference {
  sourceId: string;
  graphEvidenceId: string;
  platform: string;
  platformObjectId: string | null;
  canonicalUrl: string | null;
  evidenceRole: "primary" | "supporting" | "conflicting";
}

/**
 * Links existing canonical evidence without duplicating it. A graph row alone
 * is never sufficient: the referenced evidence_items row must also have a
 * verified evidence_attributions row for this exact durable company.
 */
export async function linkVerifiedTimelineEventPosts(input: {
  client: SupabaseLikeClient;
  eventId: string;
  companyId: string;
  classification: Extract<TimelineClassifierResult, { isMeaningfulEvent: true }>;
  graphEvidence: readonly EvidenceItem[];
}): Promise<number> {
  const sourceIds = new Set(input.classification.sourceIds);
  const references: TimelineGraphEvidenceReference[] = input.graphEvidence.flatMap((evidence) => {
    if (!sourceIds.has(evidence.id) || evidence.review_state !== "verified") return [];
    return [{
      sourceId: evidence.id,
      graphEvidenceId: evidence.id,
      platform: evidence.platform,
      platformObjectId: evidence.platformObjectId ?? evidence.platformPostId ?? null,
      canonicalUrl: safeCanonicalUrl(evidence.sourceUrl),
      evidenceRole: evidence.id === input.classification.sourceIds[0] ? "primary"
        : sourceHasNonSelectedConflict(input.classification, evidence.id) ? "conflicting" : "supporting",
    }];
  });
  if (!references.length) return 0;

  const attributions = await many<{ evidence_id: string }>(
    input.client.from<{ evidence_id: string }[]>("evidence_attributions")
      .select("evidence_id")
      .eq("company_id", input.companyId)
      .eq("review_state", "verified")
      .limit(MAX_VERIFIED_COMPANY_ATTRIBUTIONS + 1),
    "read verified Timeline evidence attributions",
  );
  if (attributions.length > MAX_VERIFIED_COMPANY_ATTRIBUTIONS) {
    throw new Error(`Verified Timeline evidence attribution lookup exceeded ${MAX_VERIFIED_COMPANY_ATTRIBUTIONS} rows.`);
  }
  const verifiedIds = [...new Set(attributions.map((row) => row.evidence_id).filter(Boolean))];
  if (!verifiedIds.length) return 0;

  const evidenceRows: Array<{
    id: string;
    platform: string;
    platform_object_id: string | null;
    canonical_url: string | null;
  }> = [];
  for (let offset = 0; offset < verifiedIds.length; offset += 200) {
    const ids = verifiedIds.slice(offset, offset + 200);
    evidenceRows.push(...await many(
      input.client.from<Array<{
        id: string;
        platform: string;
        platform_object_id: string | null;
        canonical_url: string | null;
      }>>("evidence_items")
        .select("id,platform,platform_object_id,canonical_url")
        .in("id", ids)
        .limit(ids.length),
      "read verified Timeline evidence items",
    ));
  }

  const links = new Map<string, { evidenceRole: TimelineGraphEvidenceReference["evidenceRole"]; platform: string }>();
  for (const row of evidenceRows) {
    const matching = references.find((reference) => evidenceReferenceMatchesRow(reference, row));
    if (!matching) continue;
    const prior = links.get(row.id);
    if (!prior || evidenceRolePriority(matching.evidenceRole) < evidenceRolePriority(prior.evidenceRole)) {
      links.set(row.id, { evidenceRole: matching.evidenceRole, platform: matching.platform });
    }
  }
  if (!links.size) return 0;
  await checked(input.client.from("timeline_event_posts").upsert(
    [...links.entries()].map(([evidenceId, link]) => ({
      event_id: input.eventId,
      evidence_id: evidenceId,
      evidence_role: link.evidenceRole,
      relevance_reason: `Verified canonical ${link.platform} evidence attributed to the same company.`,
    })),
    { onConflict: "event_id,evidence_id" },
  ), "link verified canonical evidence to Timeline event");
  return links.size;
}

function evidenceReferenceMatchesRow(
  reference: TimelineGraphEvidenceReference,
  row: { id: string; platform: string; platform_object_id: string | null; canonical_url: string | null },
): boolean {
  if (reference.platform !== row.platform) return false;
  if (reference.graphEvidenceId === row.id) return true;
  if (reference.platformObjectId && row.platform_object_id
      && reference.platformObjectId === row.platform_object_id) return true;
  const rowCanonicalUrl = safeCanonicalUrl(row.canonical_url);
  return Boolean(reference.canonicalUrl && rowCanonicalUrl && reference.canonicalUrl === rowCanonicalUrl);
}

function evidenceRolePriority(value: TimelineGraphEvidenceReference["evidenceRole"]): number {
  return value === "primary" ? 0 : value === "supporting" ? 1 : 2;
}

function safeCanonicalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return canonicalizeSourceUrl(value);
  } catch {
    return null;
  }
}

function conflictsForSource(
  classification: Extract<TimelineClassifierResult, { isMeaningfulEvent: true }>,
  sourceId: string,
) {
  return classification.conflicts.flatMap((conflict) => {
    const sourceClaim = conflict.claims.find((claim) => claim.sourceId === sourceId);
    return sourceClaim ? [{ conflict, sourceClaim }] : [];
  });
}

function sourceHasNonSelectedConflict(
  classification: Extract<TimelineClassifierResult, { isMeaningfulEvent: true }>,
  sourceId: string,
): boolean {
  return conflictsForSource(classification, sourceId).some(({ conflict, sourceClaim }) =>
    normalizeConflictValue(sourceClaim.value) !== normalizeConflictValue(conflict.selectedValue ?? "")
  );
}

function summarizeTimelineConflicts(
  classification: Extract<TimelineClassifierResult, { isMeaningfulEvent: true }>,
): string {
  return classification.conflicts.map((conflict) => {
    const values = [...new Set(conflict.claims.map((claim) => claim.value))];
    return `${conflict.description} Reported values: ${values.join(" vs ")}.`;
  }).join(" ").slice(0, 1_000);
}

function normalizeConflictValue(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/,/g, "").replace(/\s+/g, " ").trim();
}

function normalizeInventory(companies: readonly TimelineIngestionCompany[]): TimelineIngestionCompany[] {
  const byId = new Map<string, TimelineIngestionCompany>();
  for (const company of companies) {
    if (!company.databaseId || !company.id || !company.name || !company.slug) throw new TypeError("Timeline inventory contains an incomplete company.");
    if (byId.has(company.databaseId)) throw new TypeError(`Duplicate durable timeline company ${company.databaseId}.`);
    const existingEvidence = dedupeExistingGraphEvidence(company.existingEvidence ?? []);
    byId.set(company.databaseId, {
      ...company,
      aliases: [...new Set(company.aliases.map((item) => item.trim()).filter(Boolean))].sort(),
      founderNames: [...new Set(company.founderNames.map((item) => item.trim()).filter(Boolean))].sort(),
      existingEvidence,
      existingEvidenceCount: existingEvidence.length,
    });
  }
  return [...byId.values()].sort((left, right) => left.databaseId.localeCompare(right.databaseId));
}

function dedupeExistingGraphEvidence(evidence: readonly EvidenceItem[]): EvidenceItem[] {
  const byIdentity = new Map<string, EvidenceItem>();
  for (const item of evidence) {
    if (!item || typeof item !== "object" || !item.id || !item.sourceUrl) continue;
    const identity = `${item.platform}|${item.platformObjectId ?? item.platformPostId ?? item.id}|${item.sourceUrl}`;
    if (!byIdentity.has(identity)) byIdentity.set(identity, item);
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.postedAt.localeCompare(right.postedAt) || left.id.localeCompare(right.id)
  );
}

function isTimelineSourceClass(value: string): value is TimelineSourceClass {
  return (TIMELINE_SOURCE_CLASSES as readonly string[]).includes(value);
}

function isNetworkSourceClass(sourceClass: TimelineSourceClass): boolean {
  return sourceClass === "timeline_official_site"
    || sourceClass === "timeline_institutional_sources"
    || sourceClass === "timeline_public_web"
    || sourceClass === "timeline_historical_archive"
    || sourceClass === "timeline_gap_followup";
}

function isTerminalTask(status: IngestionTaskRow["status"]): boolean {
  return ["completed", "needs_review", "blocked_or_empty", "skipped", "failed", "canceled", "dead_lettered"].includes(status);
}

function coverageStatusFromTerminalTask(task: IngestionTaskRow): TimelineSourceCoverageState {
  if (task.status === "completed") return "completed";
  if (task.status === "failed" || task.status === "dead_lettered") return "failed";
  if (/auth/i.test(task.terminal_reason ?? "")) return "authentication_required";
  if (/not_applicable/i.test(task.terminal_reason ?? "")) return "no_applicable_source";
  if (/no_(?:result|source)/i.test(task.terminal_reason ?? "")) return "no_results";
  return "blocked";
}

function isTerminalCoverage(status: TimelineSourceCoverageState): boolean {
  return ["completed", "no_applicable_source", "no_results", "blocked", "authentication_required", "failed"].includes(status);
}

function discoveryReason(sourceClass: TimelineSourceClass, result: TimelineWebDiscoveryResult): string {
  if (result.status === "completed") return `${sourceClass}_fetched_${result.sources.length}_verified_pages`;
  if (result.status === "authentication_required") return "no_public_search_provider_credential";
  if (result.status === "rate_limited") return `${sourceClass}_provider_rate_limited`;
  if (result.status === "no_results") return `${sourceClass}_returned_no_attributable_page`;
  if (result.status === "blocked") return `${sourceClass}_page_fetch_blocked`;
  return `${sourceClass}_discovery_failed`;
}

function summarizeCompanyLimitations(coverage: Readonly<Record<string, TimelineSourceCoverageState>>): string {
  const limited = Object.entries(coverage).filter(([, status]) => ["blocked", "authentication_required", "failed"].includes(status));
  return limited.length ? `Limited source classes: ${limited.map(([source, status]) => `${source}=${status}`).join(", ")}.` : "Timeline source coverage is partial.";
}

function isPotentialTimelineClaim(source: TimelineClassificationSource): boolean {
  return /\b(?:founded|accepted into|joined y combinator|raised|funding|financing|launched|released|now live|general availability|public beta|reached|surpassed|partnered|acquired|pivoted|shutting down|regulatory approval)\b/i
    .test(`${source.title ?? ""} ${source.text.slice(0, 12_000)}`);
}

function emptyTimelineCompanyCounts(): TimelineCompanyCounts {
  return { publishedEvents: 0, candidates: 0, unresolvedConflicts: 0, unresolvedDates: 0 };
}

function timelineSourceCoverageObject(value: unknown): Record<string, TimelineSourceCoverageState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, TimelineSourceCoverageState] =>
    typeof entry[1] === "string"
  ));
}

async function readBoundedTimelineRows<T>(
  client: SupabaseLikeClient,
  table: string,
  columns: string,
  companyColumn: string,
  companyIds: readonly string[],
): Promise<T[]> {
  if (!companyIds.length) return [];
  const rows: T[] = [];
  const pageSize = 1_000;
  const maximumRows = 20_000;
  for (let offset = 0; offset < maximumRows; offset += pageSize) {
    const query = client.from<T[]>(table).select(columns).in(companyColumn, companyIds) as unknown as {
      range(from: number, to: number): PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
    };
    const response = await query.range(offset, offset + pageSize - 1);
    if (response.error) throw new Error(`read grouped ${table} rows: ${response.error.message}`);
    const page = response.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
  throw new Error(`read grouped ${table} rows exceeded the bounded ${maximumRows}-row company chunk limit.`);
}

async function checked(request: PromiseLike<{ error: { message: string } | null }>, operation: string): Promise<void> {
  const response = await request;
  if (response.error) throw new Error(`${operation}: ${response.error.message}`);
}

async function one<T>(request: PromiseLike<{ data: T | null; error: { message: string } | null }>, operation: string): Promise<T> {
  const response = await request;
  if (response.error) throw new Error(`${operation}: ${response.error.message}`);
  if (!response.data) throw new Error(`${operation}: database returned no row.`);
  return response.data;
}

async function optionalOne<T>(request: PromiseLike<{ data: T | null; error: { message: string } | null }>, operation: string): Promise<T | null> {
  const response = await request;
  if (response.error) throw new Error(`${operation}: ${response.error.message}`);
  return response.data;
}

async function many<T>(request: PromiseLike<{ data: T[] | null; error: { message: string } | null }>, operation: string): Promise<T[]> {
  const response = await request;
  if (response.error) throw new Error(`${operation}: ${response.error.message}`);
  return response.data ?? [];
}

function durableClassificationSource(row: Record<string, unknown>): TimelineClassificationSource {
  const metadata = isRecord(row.metadata_json) ? row.metadata_json : {};
  const publishedAt = typeof row.published_at === "string" ? row.published_at : null;
  const sourceType = String(row.source_type ?? "other") as TimelineSourceType;
  const httpStatus = typeof row.http_status === "number" ? row.http_status : null;
  return {
    id: `durable:${String(row.id)}`,
    url: String(row.canonical_url),
    title: typeof row.title === "string" ? row.title : null,
    publisher: typeof row.publisher === "string" ? row.publisher : null,
    sourceType,
    platform: typeof metadata.platform === "string" ? metadata.platform : null,
    publicationTimestamp: publishedAt,
    publicationDatePrecision: publishedAt ? "exact" : "unknown",
    text: typeof row.normalized_text === "string" ? row.normalized_text : String(row.excerpt ?? ""),
    evidenceExcerpt: sanitizeEvidenceExcerpt(String(row.excerpt ?? row.normalized_text ?? ""), 600),
    sourceQualityTier: row.source_quality_tier === 1 || row.source_quality_tier === 2 ? row.source_quality_tier : 3,
    attributionStatus: row.attribution_status === "verified" ? "verified" : row.attribution_status === "rejected" ? "rejected" : "needs_review",
    linkStatus: httpStatus === null ? "unchecked" : httpStatus >= 200 && httpStatus < 400 ? "verified" : "blocked",
    topic: typeof metadata.topic === "string" ? metadata.topic : null,
    authorRelationship: sourceType === "founder_post" ? "founder"
      : sourceType === "company_post" || sourceType === "company_page" || sourceType === "company_blog" || sourceType === "press_release"
        ? "company"
        : "third_party",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.floor(value), minimum), maximum);
}

export function timelineSourceInputHash(source: TimelineClassificationSource): string {
  return createHash("sha256").update(JSON.stringify({
    url: source.url,
    publicationTimestamp: source.publicationTimestamp,
    text: source.text,
  })).digest("hex");
}

/** Shared exact-date/evidence gate used before any durable candidate write. */
export function classifyDiscoveredTimelineSource(
  company: TimelineCompanyIdentity,
  sources: readonly TimelineClassificationSource[],
  source: TimelineClassificationSource,
): TimelineClassifierResult {
  return classifySourceDeterministically({ company, sources: [...sources], existingEventKeys: [] }, source);
}

export async function classifyDiscoveredTimelineSourceWithAi(
  company: TimelineCompanyIdentity,
  sources: readonly TimelineClassificationSource[],
  source: TimelineClassificationSource,
  provider: TimelineClassificationProvider | null,
): Promise<TimelineClassifierResult> {
  const deterministic = classifyDiscoveredTimelineSource(company, sources, source);
  if (!provider) return deterministic;
  // The model receives the same bounded source set as the deterministic gate
  // so it can veto uncertainty without being blind to direct contradictions.
  const input = { company, sources: [...sources], existingEventKeys: [] };
  const ai = await runTimelineClassification(provider, input);
  const classifierVersion = configuredTimelineClassifierVersion(provider);
  if (!ai.isMeaningfulEvent) {
    // A model veto may reject an ordinary candidate, but it must never erase
    // deterministic proof that direct sources materially disagree. Preserve
    // the review-only conflict record; publication remains impossible.
    if (deterministic.isMeaningfulEvent && deterministic.conflicts.length > 0) {
      return { ...deterministic, classifierVersion, extractionVersion: TIMELINE_EXTRACTION_VERSION };
    }
    return { ...ai, classifierVersion, extractionVersion: TIMELINE_EXTRACTION_VERSION };
  }
  // AI may veto a source, but it cannot manufacture a publishable event or
  // override the deterministic exact-date/company/evidence extraction gate.
  // When both layers accept, the deterministic supported claims are the
  // durable candidate and the AI model/prompt version remains in lineage.
  return {
    ...deterministic,
    classifierVersion,
    extractionVersion: TIMELINE_EXTRACTION_VERSION,
  };
}

function aiFailureCandidate(
  company: TimelineCompanyIdentity,
  source: TimelineClassificationSource,
  classifierVersion: string,
): TimelineClassifierResult {
  return {
    isMeaningfulEvent: false,
    companyId: company.id,
    sourceIds: [source.id],
    reason: "unsupported_claim",
    classifierVersion,
    extractionVersion: TIMELINE_EXTRACTION_VERSION,
  };
}

function boundedError(error: unknown): string {
  return sanitizeEvidenceExcerpt(error instanceof Error ? error.message : String(error), 240)
    .replace(/[^a-zA-Z0-9 .:_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
