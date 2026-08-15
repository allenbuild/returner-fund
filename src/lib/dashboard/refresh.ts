import { loadPublishedGraphSnapshot, type PublishedGraphBatchSlug } from "@/lib/graph/published-graph-snapshot";
import {
  DASHBOARD_VIEWS,
  type DashboardCandidate,
  type DashboardMetricObservation,
  type DashboardMetrics,
  type DashboardPipelineResult,
  type DashboardPublicSnapshot,
  type DashboardRankSnapshot
} from "./contracts";
import { discoverExternalDashboardCandidates, type ExternalDiscoveryOptions } from "./external-discovery";
import { safeDate } from "./normalization";
import { buildDashboardSnapshot } from "./pipeline";
import { dashboardCandidatesFromGraph } from "./returner-candidates";

const RETURNER_BATCHES: readonly PublishedGraphBatchSlug[] = ["S2026", "S26", "A16ZSR006"];
// The scheduled worker snapshots an exact hour a few minutes before its
// bounded public adapters finish. Permit that expected scheduler/adapter
// skew, but reject a malformed timestamp materially beyond the run.
const MAX_METRIC_OBSERVATION_SKEW_MS = 30 * 60 * 1_000;

export interface DashboardRefreshOptions {
  now?: Date;
  includeExternal?: boolean;
  external?: ExternalDiscoveryOptions;
  priorSnapshot?: DashboardPublicSnapshot | null;
}

export interface DashboardRefreshResult extends DashboardPipelineResult {
  sourceFailures: string[];
  sourceCounts: Record<string, number>;
}

/**
 * Worker-only refresh orchestration. It is not imported by the route/page;
 * each source is isolated so an outage produces a partial snapshot rather
 * than preventing an otherwise healthy dashboard publication.
 */
export async function refreshTechnologyDashboard(
  options: DashboardRefreshOptions = {}
): Promise<DashboardRefreshResult> {
  const now = options.now ?? new Date();
  const failures: string[] = [];
  const sourceCounts: Record<string, number> = {};
  const candidates: DashboardCandidate[] = [];

  const graphs = await Promise.allSettled(
    RETURNER_BATCHES.map(async (batchSlug) => ({
      batchSlug,
      graph: await loadPublishedGraphSnapshot({ batchSlug, audienceId: "off" })
    }))
  );
  for (const result of graphs) {
    if (result.status === "fulfilled") {
      const rows = dashboardCandidatesFromGraph(result.value.graph);
      candidates.push(...rows);
      sourceCounts[`returner:${result.value.batchSlug}`] = rows.length;
    } else {
      failures.push(`returner_graph:${errorLabel(result.reason)}`);
    }
  }

  if (options.includeExternal !== false) {
    const external = await discoverExternalDashboardCandidates({
      ...options.external,
      now,
      githubToken: options.external?.githubToken ?? process.env.GITHUB_TOKEN ?? null
    });
    candidates.push(...external.candidates);
    sourceCounts.industry = external.candidates.length;
    failures.push(...external.failures);
  }

  const priorRankSnapshots: DashboardRankSnapshot[] = (options.priorSnapshot?.stories ?? []).flatMap((story) =>
    DASHBOARD_VIEWS.flatMap((view) => {
      const ranking = story.viewRankings?.[view];
      // Artifacts emitted before per-view ranks represent the Hottest list.
      const legacyHottest = view === "hottest" && !ranking
        ? { rank: story.rank }
        : null;
      const current = ranking ?? legacyHottest;
      return current ? [{
        stableKey: story.stableKey,
        view,
        rank: current.rank,
        trendScore: story.trendScore,
        capturedAt: options.priorSnapshot?.generatedAt ?? now.toISOString()
      }] : [];
    })
  );
  const candidatesWithPriorMetrics = enrichDashboardCandidatesWithPriorSnapshotMetrics(
    candidates,
    options.priorSnapshot,
    now
  );
  const pipeline = buildDashboardSnapshot(candidatesWithPriorMetrics, {
    now,
    priorRankSnapshots,
    priorStories: options.priorSnapshot?.stories ?? [],
    platformFailures: failures
  });

  return {
    ...pipeline,
    sourceFailures: [...new Set(failures)].sort(),
    sourceCounts
  };
}

/**
 * Adds a second, real observation only when the same physical source appeared
 * in a previously published snapshot. This runs in the worker refresh path,
 * never in the public page/API path. A source with one scrape remains without
 * a velocity history instead of receiving an invented baseline.
 */
export function enrichDashboardCandidatesWithPriorSnapshotMetrics(
  candidates: readonly DashboardCandidate[],
  priorSnapshot: DashboardPublicSnapshot | null | undefined,
  now = new Date()
): DashboardCandidate[] {
  const priorObservedAt = safeDate(priorSnapshot?.generatedAt);
  const currentRunAt = Number.isFinite(now.getTime()) ? now : null;
  if (!priorSnapshot || !priorObservedAt || !currentRunAt || currentRunAt.getTime() <= priorObservedAt.getTime()) {
    return [...candidates];
  }

  const priorByCanonicalKey = new Map<string, DashboardMetricObservation>();
  const ambiguousCanonicalKeys = new Set<string>();
  for (const story of priorSnapshot.stories) {
    for (const source of story.sources) {
      const canonicalKey = normalizedCanonicalKey(source.canonicalKey);
      const metrics = observedMetrics(source.metrics);
      if (!canonicalKey || !metrics || ambiguousCanonicalKeys.has(canonicalKey)) continue;
      // A valid projection should expose a physical source once. If an older
      // or malformed artifact contains it twice, do not select an arbitrary
      // reading and turn that ambiguity into a velocity signal.
      if (priorByCanonicalKey.has(canonicalKey)) {
        priorByCanonicalKey.delete(canonicalKey);
        ambiguousCanonicalKeys.add(canonicalKey);
        continue;
      }
      priorByCanonicalKey.set(canonicalKey, {
        observedAt: priorObservedAt.toISOString(),
        metrics
      });
    }
  }

  return candidates.map((candidate) => {
    const canonicalKey = normalizedCanonicalKey(candidate.canonicalKey);
    const prior = canonicalKey ? priorByCanonicalKey.get(canonicalKey) : undefined;
    const currentObservedAt = safeDate(candidate.observedAt);
    const currentMetrics = observedMetrics(candidate.metrics);
    if (
      !prior ||
      !currentObservedAt ||
      !currentMetrics ||
      currentObservedAt.getTime() <= priorObservedAt.getTime() ||
      currentObservedAt.getTime() > currentRunAt.getTime() + MAX_METRIC_OBSERVATION_SKEW_MS
    ) {
      return candidate;
    }

    return {
      ...candidate,
      metricHistory: mergeMetricObservations(
        candidate.metricHistory ?? [],
        prior,
        { observedAt: currentObservedAt.toISOString(), metrics: currentMetrics }
      )
    };
  });
}

function normalizedCanonicalKey(value: string | null | undefined): string | null {
  // Canonical keys are already normalized by the adapters. Preserve their
  // exact semantics here: lower-casing a URL/object key could merge two
  // genuinely distinct physical sources and manufacture a metric history.
  const normalized = value?.trim();
  return normalized || null;
}

function observedMetrics(value: DashboardMetrics | null | undefined): DashboardMetrics | null {
  const entries = Object.entries(value ?? {}).flatMap(([key, metric]) =>
    typeof metric === "number" && Number.isFinite(metric) && metric >= 0
      ? [[key, metric] as const]
      : []
  );
  return entries.length ? Object.fromEntries(entries) : null;
}

function mergeMetricObservations(
  existing: readonly DashboardMetricObservation[],
  prior: DashboardMetricObservation,
  current: DashboardMetricObservation
): DashboardMetricObservation[] {
  const observations = new Map<string, DashboardMetricObservation>();
  for (const observation of existing) {
    const observedAt = safeDate(observation.observedAt);
    const metrics = observedMetrics(observation.metrics);
    if (!observedAt || !metrics) continue;
    observations.set(observedAt.toISOString(), { observedAt: observedAt.toISOString(), metrics });
  }
  observations.set(prior.observedAt, prior);
  observations.set(current.observedAt, current);
  return [...observations.values()].sort((left, right) =>
    new Date(left.observedAt).getTime() - new Date(right.observedAt).getTime()
  );
}

function errorLabel(error: unknown): string {
  const value = error instanceof Error ? error.message : "unknown";
  return value.replace(/[^a-z0-9_.:-]+/gi, "_").slice(0, 160) || "unknown";
}
