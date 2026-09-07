import { loadPublishedGraphSnapshot, type PublishedGraphBatchSlug } from "@/lib/graph/published-graph-snapshot";
import {
  DASHBOARD_VIEWS,
  type DashboardCandidate,
  type DashboardMetricObservation,
  type DashboardMetrics,
  type DashboardPlatform,
  type DashboardPipelineResult,
  type DashboardPublicSnapshot,
  type DashboardRankSnapshot
} from "./contracts";
import {
  DEFAULT_DASHBOARD_REDDIT_SUBREDDITS,
  DEFAULT_DASHBOARD_RESEARCH_FEEDS,
  DEFAULT_DASHBOARD_RSS_FEEDS,
  DEFAULT_DASHBOARD_INSTAGRAM_ACCOUNTS,
  DEFAULT_DASHBOARD_YOUTUBE_CHANNELS,
  MAX_DASHBOARD_INSTAGRAM_ACCOUNTS,
  MAX_DASHBOARD_YOUTUBE_CHANNELS,
  discoverExternalDashboardCandidates,
  type ExternalDiscoveryOptions
} from "./external-discovery";
import { canonicalDashboardUrl, dashboardPlatformForCandidate, safeDate } from "./normalization";
import { buildDashboardSnapshot, dashboardTop100Eligibility } from "./pipeline";
import { dashboardCandidatesFromGraph } from "./returner-candidates";

const RETURNER_BATCHES: readonly PublishedGraphBatchSlug[] = ["S2026", "S26", "A16ZSR006"];
// The scheduled worker snapshots an exact hour a few minutes before its
// bounded public adapters finish. Permit that expected scheduler/adapter
// skew, but reject a malformed timestamp materially beyond the run.
const MAX_METRIC_OBSERVATION_SKEW_MS = 30 * 60 * 1_000;
const YOUTUBE_DETAIL_UNAVAILABLE_FAILURE = /^youtube_(?!search_)[a-z0-9-]+_detail_unavailable$/i;
const YOUTUBE_RETAINED_FAILURE = "youtube_prior_verified_retained";

export interface DashboardRefreshOptions {
  now?: Date;
  includeExternal?: boolean;
  external?: ExternalDiscoveryOptions;
  priorSnapshot?: DashboardPublicSnapshot | null;
}

export interface DashboardRefreshResult extends DashboardPipelineResult {
  sourceFailures: string[];
  sourceCounts: Record<string, number>;
  sourceHealth: DashboardRefreshSourceHealth;
}

export interface DashboardRefreshSourceHealth {
  attemptedSourceCount: number;
  successfulSourceCount: number;
  failedSourceCount: number;
  successRatio: number;
  broadSourceFailure: boolean;
}

export interface DashboardRefreshSourceHealthInput {
  returnerAttempted: number;
  returnerSucceeded: number;
  externalAttempted: number;
  externalSucceeded: number;
}

export interface DashboardRefreshLogDiagnostics {
  platformDistribution: DashboardPipelineResult["diagnostics"]["platformDistribution"];
  eligibilityReasonDistribution: DashboardPipelineResult["diagnostics"]["eligibilityReasonDistribution"];
}

/** Restricts worker logs to bounded aggregate diagnostics, never source rows. */
export function dashboardRefreshLogDiagnostics(
  result: Pick<DashboardRefreshResult, "diagnostics">
): DashboardRefreshLogDiagnostics {
  return {
    platformDistribution: { ...result.diagnostics.platformDistribution },
    eligibilityReasonDistribution: { ...result.diagnostics.eligibilityReasonDistribution }
  };
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
  let returnerSucceeded = 0;
  for (const result of graphs) {
    if (result.status === "fulfilled") {
      returnerSucceeded += 1;
      const rows = dashboardCandidatesFromGraph(result.value.graph);
      candidates.push(...rows);
      sourceCounts[`returner:${result.value.batchSlug}`] = rows.length;
    } else {
      failures.push(`returner_graph:${errorLabel(result.reason)}`);
    }
  }

  let externalAttempted = 0;
  let externalSucceeded = 0;
  if (options.includeExternal !== false) {
    const externalOptions: ExternalDiscoveryOptions = {
      ...options.external,
      now,
      githubToken: options.external?.githubToken ?? process.env.GITHUB_TOKEN ?? null,
      xBearerToken: options.external?.xBearerToken ?? process.env.X_BEARER_TOKEN ?? null,
      youtubeChannels: options.external?.youtubeChannels ?? DEFAULT_DASHBOARD_YOUTUBE_CHANNELS,
      instagramAccounts: options.external?.instagramAccounts ?? DEFAULT_DASHBOARD_INSTAGRAM_ACCOUNTS,
      includeYoutubeSearch: options.external?.includeYoutubeSearch ?? true
    };
    externalAttempted = dashboardExternalAttemptCount(externalOptions);
    const external = await discoverExternalDashboardCandidates(externalOptions);
    const retainedYoutubeCandidates = retainPriorVerifiedYoutubeCandidatesOnDetailFailure(
      external.candidates,
      options.priorSnapshot,
      now,
      external.failures,
      externalOptions.youtubeChannels
    );
    assertConfiguredYoutubeDiscoverySucceeded(
      externalOptions.youtubeChannels,
      external.sources,
      external.failures,
      retainedYoutubeCandidates.length
    );
    failures.push(...external.failures);
    if (retainedYoutubeCandidates.length > 0) failures.push(YOUTUBE_RETAINED_FAILURE);
    failures.push(...configuredInstagramDiscoveryFailureLabels(
      externalOptions.instagramAccounts,
      external.sources
    ));
    const externalCandidates = [...external.candidates, ...retainedYoutubeCandidates];
    candidates.push(...externalCandidates);
    externalSucceeded = external.sources.length;
    sourceCounts.industry = externalCandidates.length;
    if (retainedYoutubeCandidates.length > 0) {
      sourceCounts["industry:youtube:retained"] = retainedYoutubeCandidates.length;
    }
    Object.assign(sourceCounts, dashboardExternalCandidateCounts(
      externalCandidates,
      now,
      [
        ...(externalOptions.youtubeChannels?.length ? ["youtube" as const] : []),
        ...(externalOptions.instagramAccounts?.length ? ["instagram" as const] : [])
      ]
    ));
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
    sourceCounts,
    sourceHealth: dashboardRefreshSourceHealth({
      returnerAttempted: RETURNER_BATCHES.length,
      returnerSucceeded,
      externalAttempted,
      externalSucceeded
    })
  };
}

/**
 * Provider success is measured independently of qualification. A healthy
 * source is allowed to return zero Top-100 candidates; only a broad inability
 * to read the configured source roster is treated as an outage.
 */
export function dashboardRefreshSourceHealth(
  input: DashboardRefreshSourceHealthInput
): DashboardRefreshSourceHealth {
  const returnerAttempted = nonNegativeInteger(input.returnerAttempted);
  const externalAttempted = nonNegativeInteger(input.externalAttempted);
  const attemptedSourceCount = returnerAttempted + externalAttempted;
  const successfulSourceCount = Math.min(
    attemptedSourceCount,
    Math.min(returnerAttempted, nonNegativeInteger(input.returnerSucceeded)) +
      Math.min(externalAttempted, nonNegativeInteger(input.externalSucceeded))
  );
  const failedSourceCount = attemptedSourceCount - successfulSourceCount;
  const successRatio = attemptedSourceCount > 0
    ? successfulSourceCount / attemptedSourceCount
    : 0;
  return {
    attemptedSourceCount,
    successfulSourceCount,
    failedSourceCount,
    successRatio,
    // Less than one quarter of independent adapters answering is a broad
    // collection outage, not evidence that the rolling window is empty.
    broadSourceFailure: attemptedSourceCount === 0 || successRatio < 0.25
  };
}

/**
 * Keep the last truthful projection when a broad source outage would shrink
 * it. The publication clocks and story window deliberately remain unchanged:
 * consumers can mark it stale instead of mistaking retained rows for a new
 * rolling-window observation.
 */
export function retainPriorDashboardSnapshotOnBroadSourceFailure(
  priorSnapshot: DashboardPublicSnapshot | null | undefined,
  nextSnapshot: DashboardPublicSnapshot,
  sourceHealth: DashboardRefreshSourceHealth,
  failureLabels: readonly string[] = []
): DashboardPublicSnapshot | null {
  if (
    !priorSnapshot ||
    priorSnapshot.stories.length === 0 ||
    !sourceHealth.broadSourceFailure ||
    nextSnapshot.stories.length >= priorSnapshot.stories.length
  ) {
    return null;
  }
  return {
    ...priorSnapshot,
    status: {
      ...priorSnapshot.status,
      partialPlatformFailures: [...new Set([
        ...priorSnapshot.status.partialPlatformFailures,
        ...failureLabels,
        "source_health_collapse",
        "source_retained"
      ])].sort()
    }
  };
}

export function dashboardExternalAttemptCount(options: ExternalDiscoveryOptions | undefined): number {
  // HN, GitHub repository search, and GitHub release events are always the
  // first three bounded external jobs.
  const fixedJobs = 3;
  const rssJobs = options?.rssFeeds?.length ?? configuredRssFeedAttemptCount();
  const researchJobs = options?.researchFeeds?.length ?? DEFAULT_DASHBOARD_RESEARCH_FEEDS.length;
  const redditJobs = options?.redditSubreddits
    ? new Set(options.redditSubreddits.map((value) => value.trim().toLowerCase()).filter(Boolean)).size
    : DEFAULT_DASHBOARD_REDDIT_SUBREDDITS.length;
  const xJobs = options?.xBearerToken?.trim() ? 1 : 0;
  const youtubeJobs = Math.min(options?.youtubeChannels?.length ?? 0, MAX_DASHBOARD_YOUTUBE_CHANNELS);
  const instagramJobs = Math.min(options?.instagramAccounts?.length ?? 0, MAX_DASHBOARD_INSTAGRAM_ACCOUNTS);
  const youtubeSearchJobs = options?.includeYoutubeSearch === true ? 1 : 0;
  return fixedJobs + rssJobs + researchJobs + redditJobs + xJobs + youtubeJobs + instagramJobs + youtubeSearchJobs;
}

/**
 * Sanitized worker diagnostics: counts only, with no provider bodies, URLs,
 * titles, handles, or tokens. Required platforms remain visible at zero so a
 * successful adapter receipt cannot conceal an empty candidate projection.
 */
export function dashboardExternalCandidateCounts(
  candidates: readonly DashboardCandidate[],
  now: Date,
  requiredPlatforms: readonly DashboardPlatform[] = []
): Record<string, number> {
  const platforms = new Set(requiredPlatforms);
  for (const candidate of candidates) platforms.add(dashboardPlatformForCandidate(candidate));
  const counts: Record<string, number> = {};
  for (const platform of [...platforms].sort()) {
    counts[`industry:${platform}:candidates`] = 0;
    counts[`industry:${platform}:eligible`] = 0;
  }
  for (const candidate of candidates) {
    const platform = dashboardPlatformForCandidate(candidate);
    counts[`industry:${platform}:candidates`] = (counts[`industry:${platform}:candidates`] ?? 0) + 1;
    const eligibility = dashboardTop100Eligibility(candidate, now);
    if (eligibility.eligible) {
      counts[`industry:${platform}:eligible`] = (counts[`industry:${platform}:eligible`] ?? 0) + 1;
      continue;
    }
    const rejectionKey = `industry:${platform}:rejected:${eligibility.reason}`;
    counts[rejectionKey] = (counts[rejectionKey] ?? 0) + 1;
  }
  return counts;
}

/**
 * A configured YouTube roster is a publication coverage invariant. A fulfilled
 * adapter may legitimately return zero candidates, so this checks only the
 * discovery source receipts and never requires a million-view video.
 */
export function assertConfiguredYoutubeDiscoverySucceeded(
  youtubeChannels: ExternalDiscoveryOptions["youtubeChannels"],
  succeededSources: readonly string[],
  failureLabels: readonly string[] = [],
  retainedVerifiedCandidateCount = 0
): void {
  if (!youtubeChannels?.length) return;
  if (succeededSources.some((source) => source.startsWith("youtube:") && source !== "youtube:search")) return;
  if (
    retainedVerifiedCandidateCount > 0 &&
    isSystemicConfiguredYoutubeDetailOutage(youtubeChannels, failureLabels)
  ) return;
  const youtubeFailures = failureLabels
    .filter((label) => !label.startsWith("youtube_search_") && /^youtube_[a-z0-9-]+_[a-z0-9_-]+$/i.test(label))
    .slice(0, MAX_DASHBOARD_YOUTUBE_CHANNELS);
  const diagnostic = youtubeFailures.length > 0 ? youtubeFailures.join(",") : "no_failure_labels";
  throw new Error(`dashboard_youtube_discovery_unavailable:${diagnostic}`);
}

/**
 * Reuses only the last published, strictly-qualified YouTube source when the
 * hosted worker cannot obtain any current video detail. The copied counters
 * remain the prior native observation, receive no synthetic metric history,
 * and must pass the current rolling-window and Top-100 gates again.
 */
export function retainPriorVerifiedYoutubeCandidatesOnDetailFailure(
  currentCandidates: readonly DashboardCandidate[],
  priorSnapshot: DashboardPublicSnapshot | null | undefined,
  now: Date,
  failureLabels: readonly string[],
  youtubeChannels: ExternalDiscoveryOptions["youtubeChannels"]
): DashboardCandidate[] {
  if (
    !priorSnapshot ||
    !Number.isFinite(now.getTime()) ||
    currentCandidates.some((candidate) => candidate.platform === "youtube") ||
    !isSystemicConfiguredYoutubeDetailOutage(youtubeChannels, failureLabels)
  ) return [];

  const priorObservedAt = safeDate(priorSnapshot.generatedAt);
  if (!priorObservedAt || priorObservedAt.getTime() > now.getTime()) return [];
  const configuredAuthorNames = new Set(
    (youtubeChannels ?? [])
      .slice(0, MAX_DASHBOARD_YOUTUBE_CHANNELS)
      .map((channel) => normalizedYoutubeAuthorName(channel.name))
      .filter(Boolean)
  );

  const retained = new Map<string, DashboardCandidate>();
  for (const story of priorSnapshot.stories) {
    // The public artifact does not persist a per-source observation clock yet.
    // A single-source story's updatedAt is therefore the only exact compatible
    // observation receipt. Requiring one source prevents another clustered
    // source from advancing that clock on YouTube's behalf.
    if (story.sources.length !== 1) continue;
    for (const source of story.sources) {
      if (
        source.platform !== "youtube" ||
        source.nativePlatform !== "youtube" ||
        source.sourceKind !== "video" ||
        source.verificationState !== "verified"
      ) continue;
      const publishedAt = safeDate(source.publishedAt);
      const sourceObservedAt = safeDate(story.updatedAt);
      const videoId = youtubeWatchVideoId(source.url);
      if (
        !publishedAt ||
        publishedAt.toISOString() !== source.publishedAt ||
        publishedAt.getTime() > priorObservedAt.getTime() ||
        !sourceObservedAt ||
        sourceObservedAt.getTime() < publishedAt.getTime() ||
        sourceObservedAt.getTime() > priorObservedAt.getTime() ||
        !configuredAuthorNames.has(normalizedYoutubeAuthorName(source.authorName)) ||
        source.publisher !== "YouTube" ||
        !videoId ||
        source.id !== `youtube:${videoId}` ||
        source.canonicalKey !== `youtube:video:${videoId}`
      ) continue;

      const candidate: DashboardCandidate = {
        id: source.id,
        canonicalKey: source.canonicalKey,
        platform: "youtube",
        sourceKind: "video",
        url: source.url,
        destinationUrl: source.destinationUrl,
        title: source.title,
        summary: source.summary,
        text: [source.title, source.summary].filter(Boolean).join(" "),
        authorName: source.authorName,
        publisher: source.publisher,
        publishedAt: source.publishedAt,
        observedAt: sourceObservedAt.toISOString(),
        metrics: { ...source.metrics },
        priorStoryStableKey: story.stableKey,
        trackedEntity: source.trackedEntity,
        topics: [...story.topics],
        thumbnailUrl: source.thumbnailUrl,
        thumbnailAlt: source.thumbnailAlt,
        independentlyReported: false,
        sourceQuality: 80,
        socialBackfillEligible: true,
        sourceVerified: true,
        sourceLinkStatus: "verified",
        publicationPrecision: "exact"
      };
      if (dashboardTop100Eligibility(candidate, now).eligible) {
        retained.set(candidate.canonicalKey, candidate);
      }
    }
  }
  return [...retained.values()].sort((left, right) => left.canonicalKey.localeCompare(right.canonicalKey));
}

function isSystemicConfiguredYoutubeDetailOutage(
  youtubeChannels: ExternalDiscoveryOptions["youtubeChannels"],
  failureLabels: readonly string[]
): boolean {
  const channels = (youtubeChannels ?? []).slice(0, MAX_DASHBOARD_YOUTUBE_CHANNELS);
  if (channels.length === 0) return false;
  const failures = new Set(failureLabels.filter((label) => YOUTUBE_DETAIL_UNAVAILABLE_FAILURE.test(label)));
  return channels.every((channel) => failures.has(youtubeDetailUnavailableFailureLabel(channel.handle)));
}

function youtubeDetailUnavailableFailureLabel(handleValue: string): string {
  const handle = handleValue.trim().replace(/^@/, "");
  const slug = handle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "source";
  return `youtube_${slug}_detail_unavailable`;
}

function normalizedYoutubeAuthorName(value: string | null | undefined): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function youtubeWatchVideoId(value: string): string | null {
  const canonical = canonicalDashboardUrl(value);
  if (!canonical) return null;
  try {
    const url = new URL(canonical);
    const videoId = url.searchParams.get("v") ?? "";
    return url.hostname === "www.youtube.com" && url.pathname === "/watch" && /^[A-Za-z0-9_-]{11}$/.test(videoId)
      ? videoId
      : null;
  } catch {
    return null;
  }
}

/**
 * Record a complete fixed-roster Instagram outage without discarding healthy
 * RSS, GitHub, YouTube, and other discovery results. Per-account diagnostics
 * are already carried by the external discovery result; this bounded aggregate
 * label makes the platform-wide outage explicit in the published snapshot.
 * Broad source collapse remains fail-closed through source-health retention.
 */
export function configuredInstagramDiscoveryFailureLabels(
  instagramAccounts: ExternalDiscoveryOptions["instagramAccounts"],
  succeededSources: readonly string[]
): string[] {
  if (!instagramAccounts?.length) return [];
  if (succeededSources.some((source) => source.startsWith("instagram:"))) return [];
  return ["instagram_discovery_unavailable"];
}

function configuredRssFeedAttemptCount(): number {
  const configured = process.env.DASHBOARD_RSS_FEEDS?.trim();
  if (!configured) return DEFAULT_DASHBOARD_RSS_FEEDS.length;
  return Math.min(8, configured.split(",").map((value) => value.trim()).filter(Boolean).length);
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
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
