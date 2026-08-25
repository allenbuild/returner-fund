import "server-only";

import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServerSupabaseClient } from "@/lib/db/client";
import {
  DASHBOARD_SCHEMA_VERSION,
  DASHBOARD_MIN_SOCIAL_VIEWS,
  DASHBOARD_PLATFORMS,
  DASHBOARD_SOURCE_KINDS,
  DASHBOARD_SOURCE_DETAIL_LIMIT,
  DASHBOARD_TOP_LIMIT,
  DASHBOARD_TOPICS,
  DASHBOARD_TREND_STATUSES,
  DASHBOARD_WINDOW_MS,
  DASHBOARD_VIEWS,
  dashboardTop100ContentKind,
  isDashboardStoryStableKey,
  type DashboardPublicFeedSnapshot,
  type DashboardPublicSnapshot,
  type DashboardStoryCard,
  type DashboardStoryPrimarySource,
  type DashboardStory,
  type DashboardStorySourceDetail
} from "./contracts";
import { stableHash } from "./normalization";
import { safeDashboardThumbnailUrl } from "./thumbnail-policy";

// Full source evidence is an internal server artifact. Only `feed.json` is
// public; detailed sources are exposed through the bounded API route below.
const DASHBOARD_ARTIFACT_PATH = join(process.cwd(), "artifacts", "dashboard", "current.json");
const DASHBOARD_FEED_ARTIFACT_PATH = join(process.cwd(), "public", "dashboard", "feed.json");
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 30_000;
const DATABASE_PUBLICATION_TIMEOUT_MS = 750;
const DASHBOARD_CARD_OMITTED_FIELDS = new Set([
  "sources",
  "summaryFingerprint",
  "score",
  "breakingScore",
  "emergingScore"
]);
const HOUR_MS = 60 * 60 * 1_000;
/** The worker runs hourly; two hours permits one delayed current publication. */
export const DASHBOARD_MAX_SNAPSHOT_AGE_MS = 2 * HOUR_MS;
/**
 * Preserve a verified last publication during a bounded worker outage. The
 * public UI marks this state stale, rather than replacing useful reporting
 * with an empty page or presenting it as a current rolling window.
 */
export const DASHBOARD_STALE_FALLBACK_MAX_AGE_MS = 48 * HOUR_MS;
const DASHBOARD_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export type DashboardSnapshotAvailability = "current" | "stale" | "unavailable";

export interface DashboardSnapshotResolution {
  snapshot: DashboardPublicSnapshot | null;
  availability: DashboardSnapshotAvailability;
}

let cachedSnapshot: { value: DashboardPublicSnapshot; expiresAt: number } | null = null;
let cachedFeedSnapshot: { value: DashboardPublicFeedSnapshot; expiresAt: number } | null = null;

/**
 * Reads one already-published projection. It deliberately cannot invoke
 * discovery, clustering, scoring, summarization, or a source connector.
 */
export async function loadPublicDashboardSnapshot(): Promise<DashboardPublicSnapshot> {
  if (cachedSnapshot && cachedSnapshot.expiresAt > Date.now() && isDashboardSnapshotWithinRetention(cachedSnapshot.value)) {
    return cachedSnapshot.value;
  }
  cachedSnapshot = null;

  const now = new Date();
  // The committed artifact is written before the optional DB projection, so a
  // current local artifact is both the fastest and normally newest safe read.
  // Do not let a stalled database network call delay public availability.
  const artifactSnapshot = await loadArtifactSnapshot();
  const artifactResolution = resolveCurrentDashboardSnapshot([artifactSnapshot], now);
  if (artifactResolution.snapshot) return remember(artifactResolution.snapshot);

  const databasePublication = await resolveWithin(
    loadDatabasePublication(),
    DATABASE_PUBLICATION_TIMEOUT_MS,
    { snapshot: null, markedStale: false }
  );
  // The artifact is first deliberately: when it was written during a database
  // outage in the same hour, it is a safer tie-breaker than an older DB row.
  const resolution = resolveCurrentDashboardSnapshot(
    [artifactSnapshot, databasePublication.snapshot],
    now
  );
  if (resolution.snapshot) return remember(resolution.snapshot);

  const fallback = resolveRetainedDashboardSnapshot(
    [artifactSnapshot, databasePublication.snapshot],
    now
  );
  if (fallback) return remember(markDashboardSnapshotStale(fallback));

  const safeState = databasePublication.markedStale || resolution.availability === "stale"
    ? "snapshot_stale"
    : "snapshot_unavailable";
  return remember(emptyDashboardSnapshot(now, safeState));
}

/**
 * Reads the compact, worker-produced list artifact used by public cards. The
 * complete snapshot remains server-only so source arrays are never serialized
 * into the page or the list API response.
 */
export async function loadPublicDashboardFeedSnapshot(): Promise<DashboardPublicFeedSnapshot> {
  if (
    cachedFeedSnapshot &&
    cachedFeedSnapshot.expiresAt > Date.now() &&
    isDashboardFeedSnapshotWithinRetention(cachedFeedSnapshot.value)
  ) {
    return cachedFeedSnapshot.value;
  }
  cachedFeedSnapshot = null;

  const now = new Date();
  const [artifactFeed, artifactSnapshot] = await Promise.all([
    loadDashboardFeedArtifact(),
    loadArtifactSnapshot()
  ]);
  if (
    artifactFeed &&
    artifactSnapshot &&
    isCurrentDashboardFeedSnapshot(artifactFeed, now) &&
    isCurrentDashboardSnapshot(artifactSnapshot, now) &&
    artifactFeed.sourceSnapshotFingerprint === dashboardSnapshotFingerprint(artifactSnapshot)
  ) {
    return rememberFeed(artifactFeed);
  }

  // A feed artifact can be absent briefly during a rolling deployment or when
  // serving a snapshot produced before the compact split. This fallback still
  // projects only already-published data and performs no discovery or scoring.
  return rememberFeed(toDashboardPublicFeedSnapshot(await loadPublicDashboardSnapshot()));
}

/**
 * Retrieves at most `DASHBOARD_SOURCE_DETAIL_LIMIT` precomputed source rows
 * for one opaque story key. It never touches candidate collection or scoring.
 */
export async function loadPublicDashboardStorySourceDetail(
  stableKey: string
): Promise<DashboardStorySourceDetail | null> {
  if (!isDashboardStoryStableKey(stableKey)) return null;
  return selectDashboardStorySourceDetail(await loadPublicDashboardSnapshot(), stableKey);
}

/** Public pure projection used by the worker-written feed artifact and tests. */
export function toDashboardPublicFeedSnapshot(
  snapshot: DashboardPublicSnapshot
): DashboardPublicFeedSnapshot {
  return {
    ...snapshot,
    sourceSnapshotFingerprint: dashboardSnapshotFingerprint(snapshot),
    stories: snapshot.stories.map((story) => ({
      ...withoutSources(story),
      primarySource: toDashboardStoryPrimarySource(story.sources[0])
    }))
  };
}

/**
 * Selects source details from a complete snapshot already checked by the
 * store. Exported for contract tests; callers still validate the route key.
 */
export function selectDashboardStorySourceDetail(
  snapshot: DashboardPublicSnapshot,
  stableKey: string
): DashboardStorySourceDetail | null {
  if (!isDashboardStoryStableKey(stableKey)) return null;
  const story = snapshot.stories.find((candidate) => candidate.stableKey === stableKey);
  if (!story) return null;
  const sources = story.sources
    .slice(0, DASHBOARD_SOURCE_DETAIL_LIMIT)
    .flatMap((source) => {
      const detail = toDashboardStoryPrimarySource(source);
      return detail ? [detail] : [];
    });
  return {
    stableKey: story.stableKey,
    sourceCount: story.sourceCount,
    sources,
    truncated: story.sources.length > DASHBOARD_SOURCE_DETAIL_LIMIT
  };
}

/** Hourly workers atomically publish the truthful qualified set, even under 100. */
export async function writePublicDashboardArtifact(snapshot: DashboardPublicSnapshot): Promise<void> {
  if (!isDashboardPublicSnapshot(snapshot)) throw new Error("Refusing to write an invalid dashboard snapshot.");
  if (!isCurrentDashboardSnapshot(snapshot)) {
    throw new Error("Refusing to publish a stale or future dashboard snapshot.");
  }
  const serialized = JSON.stringify(snapshot);
  const feedSnapshot = toDashboardPublicFeedSnapshot(snapshot);
  if (!isDashboardPublicFeedSnapshot(feedSnapshot)) {
    throw new Error("Refusing to write an invalid compact dashboard feed.");
  }
  const serializedFeed = JSON.stringify(feedSnapshot);
  if (Buffer.byteLength(serialized) > MAX_ARTIFACT_BYTES) {
    throw new Error("Refusing to write a dashboard artifact larger than the public read limit.");
  }
  if (Buffer.byteLength(serializedFeed) > MAX_ARTIFACT_BYTES) {
    throw new Error("Refusing to write a compact dashboard feed larger than the public read limit.");
  }
  await Promise.all([
    mkdir(join(process.cwd(), "artifacts", "dashboard"), { recursive: true }),
    mkdir(join(process.cwd(), "public", "dashboard"), { recursive: true })
  ]);
  const publicationId = `${process.pid}.${Date.now()}`;
  const temporaryPath = `${DASHBOARD_ARTIFACT_PATH}.${publicationId}.tmp`;
  const temporaryFeedPath = `${DASHBOARD_FEED_ARTIFACT_PATH}.${publicationId}.tmp`;
  await writeFile(temporaryPath, serialized, "utf8");
  await writeFile(temporaryFeedPath, serializedFeed, "utf8");
  await rename(temporaryFeedPath, DASHBOARD_FEED_ARTIFACT_PATH);
  await rename(temporaryPath, DASHBOARD_ARTIFACT_PATH);
  remember(snapshot);
  rememberFeed(feedSnapshot);
}

export function clearDashboardSnapshotCache(): void {
  cachedSnapshot = null;
  cachedFeedSnapshot = null;
}

export function isDashboardPublicSnapshot(value: unknown): value is DashboardPublicSnapshot {
  if (!isRecord(value) || value.schemaVersion !== DASHBOARD_SCHEMA_VERSION) return false;
  if (!validTimestamp(value.generatedAt) || !validTimestamp(value.updatedAt) || !validTimestamp(value.windowStart) || !validTimestamp(value.windowEnd)) {
    return false;
  }
  const windowStart = value.windowStart as string;
  const windowEnd = value.windowEnd as string;
  if (new Date(windowEnd).getTime() - new Date(windowStart).getTime() !== DASHBOARD_WINDOW_MS) return false;
  if (!Array.isArray(value.todayInTech) || !value.todayInTech.every((item) => typeof item === "string" && item.length <= 600)) return false;
  if (!Array.isArray(value.stories) || value.stories.length > DASHBOARD_VIEWS.length * 100 || !value.stories.every(isDashboardStory)) return false;
  if (!isRecord(value.availableFilters) || !Array.isArray(value.availableFilters.topics) || !Array.isArray(value.availableFilters.platforms)) return false;
  if (!isRecord(value.status) || !nonNegativeInteger(value.status.candidateCount) || !nonNegativeInteger(value.status.eligibleCandidateCount) || !nonNegativeInteger(value.status.storyCount) || !isViewStoryCounts(value.status.viewStoryCounts) || !Array.isArray(value.status.partialPlatformFailures)) return false;
  const stories = value.stories as DashboardStory[];
  const status = value.status as Record<string, unknown>;
  const viewStoryCounts = status.viewStoryCounts as Record<string, number>;
  if (status.storyCount !== stories.length) return false;
  return DASHBOARD_VIEWS.every((view) => {
    const ranks = stories
      .flatMap((story) => story.viewRankings[view] ? [story.viewRankings[view]!.rank] : []);
    return viewStoryCounts[view] === ranks.length && new Set(ranks).size === ranks.length;
  });
}

/** Validates the intentionally source-list-free public card artifact. */
export function isDashboardPublicFeedSnapshot(value: unknown): value is DashboardPublicFeedSnapshot {
  if (!isRecord(value) || value.schemaVersion !== DASHBOARD_SCHEMA_VERSION) return false;
  if (!boundedString(value.sourceSnapshotFingerprint, 128)) return false;
  if (!validTimestamp(value.generatedAt) || !validTimestamp(value.updatedAt) || !validTimestamp(value.windowStart) || !validTimestamp(value.windowEnd)) {
    return false;
  }
  const windowStart = value.windowStart as string;
  const windowEnd = value.windowEnd as string;
  if (new Date(windowEnd).getTime() - new Date(windowStart).getTime() !== DASHBOARD_WINDOW_MS) return false;
  if (!Array.isArray(value.todayInTech) || !value.todayInTech.every((item) => typeof item === "string" && item.length <= 600)) return false;
  if (!Array.isArray(value.stories) || value.stories.length > DASHBOARD_VIEWS.length * 100 || !value.stories.every(isDashboardStoryCard)) return false;
  if (!isRecord(value.availableFilters) || !Array.isArray(value.availableFilters.topics) || !Array.isArray(value.availableFilters.platforms)) return false;
  if (!isRecord(value.status) || !nonNegativeInteger(value.status.candidateCount) || !nonNegativeInteger(value.status.eligibleCandidateCount) || !nonNegativeInteger(value.status.storyCount) || !isViewStoryCounts(value.status.viewStoryCounts) || !Array.isArray(value.status.partialPlatformFailures)) return false;
  const stories = value.stories as DashboardStoryCard[];
  const status = value.status as Record<string, unknown>;
  const viewStoryCounts = status.viewStoryCounts as Record<string, number>;
  if (status.storyCount !== stories.length) return false;
  return DASHBOARD_VIEWS.every((view) => {
    const ranks = stories
      .flatMap((story) => story.viewRankings[view] ? [story.viewRankings[view]!.rank] : []);
    return viewStoryCounts[view] === ranks.length && new Set(ranks).size === ranks.length;
  });
}

/**
 * A structurally valid payload is not necessarily safe to present as a live
 * rolling window. This is intentionally separate from schema validation so
 * historical artifacts can still be inspected or migrated without passing as
 * current visitor data.
 */
export function isCurrentDashboardSnapshot(
  snapshot: DashboardPublicSnapshot,
  now = new Date()
): boolean {
  if (!isDashboardPublicSnapshot(snapshot) || !Number.isFinite(now.getTime())) return false;

  const generatedAt = new Date(snapshot.generatedAt).getTime();
  const windowEnd = new Date(snapshot.windowEnd).getTime();
  if (generatedAt !== windowEnd) return false;

  const age = now.getTime() - windowEnd;
  return age >= -DASHBOARD_MAX_FUTURE_SKEW_MS && age <= DASHBOARD_MAX_SNAPSHOT_AGE_MS;
}

export function isCurrentDashboardFeedSnapshot(
  snapshot: DashboardPublicFeedSnapshot,
  now = new Date()
): boolean {
  if (!isDashboardPublicFeedSnapshot(snapshot) || !Number.isFinite(now.getTime())) return false;

  const generatedAt = new Date(snapshot.generatedAt).getTime();
  const windowEnd = new Date(snapshot.windowEnd).getTime();
  if (generatedAt !== windowEnd) return false;

  const age = now.getTime() - windowEnd;
  return age >= -DASHBOARD_MAX_FUTURE_SKEW_MS && age <= DASHBOARD_MAX_SNAPSHOT_AGE_MS;
}

/**
 * A bounded stale fallback is still a verified publication, but callers must
 * surface its age rather than treat it as a current rolling-hour snapshot.
 */
export function isDashboardSnapshotWithinRetention(
  snapshot: DashboardPublicSnapshot,
  now = new Date()
): boolean {
  if (!isDashboardPublicSnapshot(snapshot) || !Number.isFinite(now.getTime())) return false;

  const generatedAt = new Date(snapshot.generatedAt).getTime();
  const windowEnd = new Date(snapshot.windowEnd).getTime();
  if (generatedAt !== windowEnd) return false;

  const age = now.getTime() - windowEnd;
  return age >= -DASHBOARD_MAX_FUTURE_SKEW_MS && age <= DASHBOARD_STALE_FALLBACK_MAX_AGE_MS;
}

function isDashboardFeedSnapshotWithinRetention(
  snapshot: DashboardPublicFeedSnapshot,
  now = new Date()
): boolean {
  if (!isDashboardPublicFeedSnapshot(snapshot) || !Number.isFinite(now.getTime())) return false;

  const generatedAt = new Date(snapshot.generatedAt).getTime();
  const windowEnd = new Date(snapshot.windowEnd).getTime();
  if (generatedAt !== windowEnd) return false;

  const age = now.getTime() - windowEnd;
  return age >= -DASHBOARD_MAX_FUTURE_SKEW_MS && age <= DASHBOARD_STALE_FALLBACK_MAX_AGE_MS;
}

/**
 * Selects the newest usable projection rather than giving a database row
 * blanket precedence over the independently published static artifact.
 */
export function resolveCurrentDashboardSnapshot(
  snapshots: readonly (DashboardPublicSnapshot | null | undefined)[],
  now = new Date()
): DashboardSnapshotResolution {
  const structurallyValid = snapshots.filter((snapshot): snapshot is DashboardPublicSnapshot =>
    snapshot !== null && snapshot !== undefined && isDashboardPublicSnapshot(snapshot)
  );
  const current = structurallyValid
    .filter((snapshot) => isCurrentDashboardSnapshot(snapshot, now))
    .sort((left, right) => new Date(right.windowEnd).getTime() - new Date(left.windowEnd).getTime());
  const snapshot = current[0] ?? null;
  return {
    snapshot,
    availability: snapshot ? "current" : structurallyValid.length ? "stale" : "unavailable"
  };
}

function resolveRetainedDashboardSnapshot(
  snapshots: readonly (DashboardPublicSnapshot | null | undefined)[],
  now: Date
): DashboardPublicSnapshot | null {
  return snapshots
    .filter((snapshot): snapshot is DashboardPublicSnapshot =>
      snapshot !== null && snapshot !== undefined && isDashboardSnapshotWithinRetention(snapshot, now)
    )
    .sort((left, right) => new Date(right.windowEnd).getTime() - new Date(left.windowEnd).getTime())[0] ?? null;
}

function markDashboardSnapshotStale(snapshot: DashboardPublicSnapshot): DashboardPublicSnapshot {
  const partialPlatformFailures = snapshot.status.partialPlatformFailures.includes("snapshot_stale")
    ? snapshot.status.partialPlatformFailures
    : [...snapshot.status.partialPlatformFailures, "snapshot_stale"];
  return {
    ...snapshot,
    status: { ...snapshot.status, partialPlatformFailures }
  };
}

async function loadDatabasePublication(): Promise<{ snapshot: DashboardPublicSnapshot | null; markedStale: boolean }> {
  try {
    const client = createServerSupabaseClient({ useServiceRole: true });
    if (!client) return { snapshot: null, markedStale: false };
    const { data, error } = await client
      .from("dashboard_publications")
      .select("payload_json, generated_at, freshness_status")
      .eq("status", "published")
      .eq("is_current", true)
      .maybeSingle();
    if (error || !data) return { snapshot: null, markedStale: false };
    if (data.freshness_status === "stale") return { snapshot: null, markedStale: true };
    return {
      snapshot: isDashboardPublicSnapshot(data.payload_json) ? data.payload_json : null,
      markedStale: false
    };
  } catch {
    // A rolling rollout may have app code before the additive migration. The
    // static artifact remains a safe fallback without exposing the failure.
    return { snapshot: null, markedStale: false };
  }
}

async function resolveWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function loadArtifactSnapshot(): Promise<DashboardPublicSnapshot | null> {
  let raw: string;
  try {
    raw = await readFile(DASHBOARD_ARTIFACT_PATH, "utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(raw) > MAX_ARTIFACT_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isDashboardPublicSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function loadDashboardFeedArtifact(): Promise<DashboardPublicFeedSnapshot | null> {
  let raw: string;
  try {
    raw = await readFile(DASHBOARD_FEED_ARTIFACT_PATH, "utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(raw) > MAX_ARTIFACT_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isDashboardPublicFeedSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function emptyDashboardSnapshot(
  now = new Date(),
  safeState: "snapshot_stale" | "snapshot_unavailable" = "snapshot_unavailable"
): DashboardPublicSnapshot {
  const timestamp = now.toISOString();
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    generatedAt: timestamp,
    updatedAt: timestamp,
    windowStart: new Date(now.getTime() - DASHBOARD_WINDOW_MS).toISOString(),
    windowEnd: timestamp,
    todayInTech: [],
    stories: [],
    availableFilters: { topics: [], platforms: [] },
    status: {
      candidateCount: 0,
      eligibleCandidateCount: 0,
      storyCount: 0,
      viewStoryCounts: { hottest: 0, breaking: 0, emerging: 0 },
      // This is a safe publication state, not an upstream platform failure:
      // callers can avoid describing expired rankings as a current Top 100.
      partialPlatformFailures: [safeState]
    }
  };
}

function remember(snapshot: DashboardPublicSnapshot): DashboardPublicSnapshot {
  cachedSnapshot = { value: snapshot, expiresAt: Date.now() + CACHE_TTL_MS };
  return snapshot;
}

function rememberFeed(snapshot: DashboardPublicFeedSnapshot): DashboardPublicFeedSnapshot {
  cachedFeedSnapshot = { value: snapshot, expiresAt: Date.now() + CACHE_TTL_MS };
  return snapshot;
}

function withoutSources(story: DashboardStory): Omit<
  DashboardStory,
  "sources" | "summaryFingerprint" | "score" | "breakingScore" | "emergingScore"
> {
  const card = Object.fromEntries(
    Object.entries(story).filter(([field]) => !DASHBOARD_CARD_OMITTED_FIELDS.has(field))
  ) as Omit<DashboardStory, "sources" | "summaryFingerprint" | "score" | "breakingScore" | "emergingScore">;
  // The compact feed is public presentation data. Keep an unreviewed source
  // image from turning the browser's Next image optimizer into a remote-image
  // proxy; the card renderer has a local fallback when this becomes null.
  return { ...card, thumbnailUrl: safeDashboardThumbnailUrl(card.thumbnailUrl) };
}

function toDashboardStoryPrimarySource(
  source: DashboardStory["sources"][number] | undefined
): DashboardStoryPrimarySource | null {
  if (!source) return null;
  return {
    id: source.id,
    url: source.url,
    title: source.title,
    publisher: source.publisher,
    platform: source.platform,
    sourceKind: source.sourceKind,
    publishedAt: source.publishedAt,
    metrics: source.metrics
  };
}

function dashboardSnapshotFingerprint(snapshot: DashboardPublicSnapshot): string {
  return `dsh-${stableHash(JSON.stringify(snapshot))}`;
}

function isDashboardStory(value: unknown): value is DashboardStory {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" &&
    typeof value.stableKey === "string" &&
    positiveInteger(value.rank) &&
    typeof value.title === "string" && value.title.length > 0 && value.title.length <= 240 &&
    typeof value.summary === "string" && value.summary.length > 0 && value.summary.length <= 1_000 &&
    typeof value.summaryFingerprint === "string" &&
    (value.universe === "returner" || value.universe === "industry") &&
    isBoundedStringArray(value.labels, 48, 120) &&
    isAllowedStringArray(value.topics, DASHBOARD_TOPICS) &&
    isAllowedStringArray(value.platforms, DASHBOARD_PLATFORMS) &&
    validTimestamp(value.publishedAt) && validTimestamp(value.updatedAt) &&
    finiteScore(value.trendScore) && finiteScore(value.breakingScore) && finiteScore(value.emergingScore) &&
    isViewRankings(value.viewRankings) &&
    nonNegativeInteger(value.sourceCount) && nonNegativeInteger(value.independentSourceCount) &&
    value.independentSourceCount <= value.sourceCount &&
    isMetrics(value.engagement) &&
    (value.thumbnailUrl === null || isHttpUrl(value.thumbnailUrl)) &&
    nullableBoundedString(value.thumbnailAlt, 240) &&
    Array.isArray(value.sources) &&
    value.sources.length === value.sourceCount &&
    value.sources.every((source) => isDashboardStorySource(source) && isQualifiedTop100Source(source));
}

function isDashboardStoryCard(value: unknown): value is DashboardStoryCard {
  if (
    !isRecord(value) ||
    Object.hasOwn(value, "sources") ||
    Object.hasOwn(value, "summaryFingerprint") ||
    Object.hasOwn(value, "score") ||
    Object.hasOwn(value, "breakingScore") ||
    Object.hasOwn(value, "emergingScore")
  ) return false;
  return typeof value.id === "string" &&
    typeof value.stableKey === "string" &&
    positiveInteger(value.rank) &&
    typeof value.title === "string" && value.title.length > 0 && value.title.length <= 240 &&
    typeof value.summary === "string" && value.summary.length > 0 && value.summary.length <= 1_000 &&
    (value.universe === "returner" || value.universe === "industry") &&
    isBoundedStringArray(value.labels, 48, 120) &&
    isAllowedStringArray(value.topics, DASHBOARD_TOPICS) &&
    isAllowedStringArray(value.platforms, DASHBOARD_PLATFORMS) &&
    validTimestamp(value.publishedAt) && validTimestamp(value.updatedAt) &&
    finiteScore(value.trendScore) &&
    isViewRankings(value.viewRankings) &&
    nonNegativeInteger(value.sourceCount) && nonNegativeInteger(value.independentSourceCount) &&
    value.independentSourceCount <= value.sourceCount &&
    isMetrics(value.engagement) &&
    (value.thumbnailUrl === null || isHttpUrl(value.thumbnailUrl)) &&
    nullableBoundedString(value.thumbnailAlt, 240) &&
    value.primarySource !== null && isDashboardStoryPrimarySource(value.primarySource) &&
    isQualifiedTop100Source(value.primarySource);
}

function isQualifiedTop100Source(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.platform !== "string" ||
    typeof value.sourceKind !== "string" ||
    !(DASHBOARD_PLATFORMS as readonly string[]).includes(value.platform) ||
    !(DASHBOARD_SOURCE_KINDS as readonly string[]).includes(value.sourceKind)
  ) return false;
  const contentKind = dashboardTop100ContentKind({
    platform: value.platform as (typeof DASHBOARD_PLATFORMS)[number],
    sourceKind: value.sourceKind as (typeof DASHBOARD_SOURCE_KINDS)[number]
  });
  if (contentKind === "news_article") return true;
  if (contentKind !== "viral_post") return false;
  if (!isRecord(value.metrics)) return false;
  const views = value.metrics.views;
  return typeof views === "number" && Number.isFinite(views) && views >= DASHBOARD_MIN_SOCIAL_VIEWS;
}

function isDashboardStoryPrimarySource(value: unknown): value is DashboardStoryPrimarySource {
  if (!isRecord(value)) return false;
  return boundedString(value.id, 320) &&
    isHttpUrl(value.url) &&
    nullableBoundedString(value.title, 500) &&
    nullableBoundedString(value.publisher, 300) &&
    typeof value.platform === "string" && (DASHBOARD_PLATFORMS as readonly string[]).includes(value.platform) &&
    typeof value.sourceKind === "string" && (DASHBOARD_SOURCE_KINDS as readonly string[]).includes(value.sourceKind) &&
    validTimestamp(value.publishedAt) &&
    isMetrics(value.metrics);
}

function isViewRankings(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length === 0) return false;
  return Object.entries(value).every(([view, ranking]) =>
    (DASHBOARD_VIEWS as readonly string[]).includes(view) &&
    isRecord(ranking) &&
    positiveInteger(ranking.rank) && ranking.rank <= DASHBOARD_TOP_LIMIT &&
    (ranking.previousRank === null || (positiveInteger(ranking.previousRank) && ranking.previousRank <= DASHBOARD_TOP_LIMIT)) &&
    (ranking.rankDelta === null || Number.isInteger(ranking.rankDelta)) &&
    typeof ranking.trendStatus === "string" && (DASHBOARD_TREND_STATUSES as readonly string[]).includes(ranking.trendStatus)
  );
}

function isDashboardStorySource(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return boundedString(value.id, 320) &&
    boundedString(value.canonicalKey, 1_000) &&
    boundedString(value.platform, 80) &&
    boundedString(value.nativePlatform, 80) &&
    typeof value.sourceKind === "string" && (DASHBOARD_SOURCE_KINDS as readonly string[]).includes(value.sourceKind) &&
    value.verificationState === "verified" &&
    isHttpUrl(value.url) &&
    (value.destinationUrl === null || isHttpUrl(value.destinationUrl)) &&
    nullableBoundedString(value.title, 500) &&
    nullableBoundedString(value.summary, 300) &&
    nullableBoundedString(value.authorName, 300) &&
    nullableBoundedString(value.publisher, 300) &&
    validTimestamp(value.publishedAt) &&
    isMetrics(value.metrics) &&
    (value.thumbnailUrl === null || isHttpUrl(value.thumbnailUrl)) &&
    nullableBoundedString(value.thumbnailAlt, 240) &&
    Array.isArray(value.signals) && value.signals.length <= 10 && value.signals.every((signal) => boundedString(signal, 160));
}

function isMetrics(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((metric) =>
    metric === null || (typeof metric === "number" && Number.isFinite(metric) && metric >= 0)
  );
}

function isViewStoryCounts(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return DASHBOARD_VIEWS.every((view) => nonNegativeInteger(value[view]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function finiteScore(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function nullableBoundedString(value: unknown, maxLength: number): boolean {
  return value === null || boundedString(value, maxLength);
}

function isBoundedStringArray(value: unknown, maximumItems: number, maximumLength: number): boolean {
  return Array.isArray(value) && value.length <= maximumItems && value.every((item) => boundedString(item, maximumLength));
}

function isAllowedStringArray(value: unknown, allowed: readonly string[]): boolean {
  return Array.isArray(value) && value.length <= allowed.length && value.every((item) =>
    typeof item === "string" && allowed.includes(item)
  );
}

function isHttpUrl(value: unknown): boolean {
  if (!boundedString(value, 2_000)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
