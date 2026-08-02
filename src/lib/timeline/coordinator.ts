import type { AutonomousIngestionStore, EnqueueTaskInput, IngestionTaskRow } from "@/lib/workers/autonomous-ingestion-store";
import type { TimelineSourceCoverageState } from "./contracts";

export const TIMELINE_COORDINATOR_VERSION = "timeline-coordinator-2026-08-02.v1" as const;

export const TIMELINE_SOURCE_CLASSES = [
  "timeline_existing_evidence",
  "timeline_official_site",
  "timeline_founder_sources",
  "timeline_institutional_sources",
  "timeline_public_web",
  "timeline_historical_archive",
  "timeline_gap_followup",
  "timeline_reconcile_publish",
] as const;

export type TimelineSourceClass = (typeof TIMELINE_SOURCE_CLASSES)[number];

export interface TimelineCoordinatorCompany {
  id: string;
  name: string;
  batchId: string | null;
  hasWebsite: boolean;
  founderCount: number;
}

export interface TimelineBackfillEnqueueInput {
  runId: string;
  companies: readonly TimelineCoordinatorCompany[];
  sourceClasses?: readonly TimelineSourceClass[];
  priority?: number;
}

export async function enqueueTimelineBackfillTasks(
  store: AutonomousIngestionStore,
  input: TimelineBackfillEnqueueInput,
): Promise<IngestionTaskRow[]> {
  const sourceClasses = input.sourceClasses ?? TIMELINE_SOURCE_CLASSES;
  const tasks: EnqueueTaskInput[] = [];
  for (const company of [...input.companies].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const sourceClass of sourceClasses) {
      tasks.push({
        runId: input.runId,
        batchId: company.batchId,
        entityType: "company",
        entityId: company.id,
        companyName: company.name,
        platform: sourceClass,
        // A checkpoint is idempotent within one ingestion run, but a later
        // autonomous run must perform a fresh incremental scan. ingestion_tasks
        // enforces checkpoint_key uniqueness globally, so omitting runId would
        // silently reuse the first run's terminal task forever.
        checkpointKey: `timeline:${TIMELINE_COORDINATOR_VERSION}:${input.runId}:${company.id}:${sourceClass}`,
        rateLimitMs: sourceClass === "timeline_public_web" || sourceClass === "timeline_historical_archive" ? 1_000 : 0,
        maxAttempts: sourceClass === "timeline_public_web" || sourceClass === "timeline_historical_archive" ? 5 : 3,
        priority: (input.priority ?? 0) + sourcePriority(sourceClass),
      });
    }
  }
  // The authoritative inventory is large enough that a single PostgREST body
  // is fragile. Enqueue every source class (including non-applicable classes,
  // which the worker records explicitly) in bounded deterministic chunks.
  const enqueued: IngestionTaskRow[] = [];
  for (let offset = 0; offset < tasks.length; offset += 250) {
    enqueued.push(...await store.enqueueTasks(tasks.slice(offset, offset + 250)));
  }
  return enqueued;
}

export function isTerminalTimelineSourceCoverage(status: TimelineSourceCoverageState): boolean {
  return [
    "completed", "no_applicable_source", "no_results", "blocked",
    "authentication_required", "failed",
  ].includes(status);
}

export function deriveTimelineCompanyCoverageStatus(
  sourceCoverage: Readonly<Record<string, TimelineSourceCoverageState>>,
): "pending" | "running" | "completed" | "partial" | "failed" {
  const values = Object.values(sourceCoverage);
  if (!values.length || values.every((value) => value === "pending")) return "pending";
  if (values.some((value) => value === "running" || value === "retry_pending" || value === "rate_limited")) return "running";
  if (values.some((value) => value === "failed") && values.every((value) => value === "failed" || value === "no_applicable_source")) return "failed";
  if (values.every(isTerminalTimelineSourceCoverage)) {
    return values.some((value) => value === "failed" || value === "blocked" || value === "authentication_required") ? "partial" : "completed";
  }
  return "partial";
}

function sourcePriority(sourceClass: TimelineSourceClass): number {
  const order: Record<TimelineSourceClass, number> = {
    timeline_existing_evidence: 80,
    timeline_official_site: 70,
    timeline_founder_sources: 60,
    timeline_institutional_sources: 55,
    timeline_public_web: 50,
    timeline_historical_archive: 30,
    timeline_gap_followup: 20,
    timeline_reconcile_publish: 10,
  };
  return order[sourceClass];
}
