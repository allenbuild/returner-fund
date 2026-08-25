import "server-only";

import { createHash } from "node:crypto";
import { createServerSupabaseClient } from "@/lib/db/client";
import {
  DASHBOARD_SCHEMA_VERSION,
  DASHBOARD_WINDOW_MS,
  DASHBOARD_VIEWS,
  type DashboardPublicSnapshot,
  type DashboardStory,
  type DashboardStorySource,
  type DashboardView
} from "./contracts";
import { dashboardSnapshotMaterialDescriptor } from "./pipeline";

const DASHBOARD_MODEL_KEY = "technology_dashboard";
const DASHBOARD_MODEL_VERSION = "2.0.0";
// The complete projection is server-only. Public cards use the compact feed,
// and source rows are returned through a bounded expansion route on demand.
const DASHBOARD_ARTIFACT_PATH = "artifacts/dashboard/current.json";

interface DbError { message: string; code?: string }
interface DbResponse<T> { data: T | null; error: DbError | null }
export interface DashboardPersistenceQuery<T = Record<string, unknown>> extends PromiseLike<DbResponse<T[]>> {
  select(columns?: string): DashboardPersistenceQuery<T>;
  insert(values: unknown): DashboardPersistenceQuery<T>;
  upsert(values: unknown, options?: { onConflict?: string; ignoreDuplicates?: boolean }): DashboardPersistenceQuery<T>;
  update(values: unknown): DashboardPersistenceQuery<T>;
  eq(column: string, value: unknown): DashboardPersistenceQuery<T>;
  maybeSingle(): PromiseLike<DbResponse<T>>;
  single(): PromiseLike<DbResponse<T>>;
}

export interface DashboardPersistenceClient {
  from<T = Record<string, unknown>>(table: string): DashboardPersistenceQuery<T>;
  rpc<T = unknown>(functionName: string, args: Record<string, unknown>): PromiseLike<DbResponse<T>>;
}

export interface DashboardPersistenceResult {
  status: "persisted" | "unchanged" | "skipped";
  runKey?: string;
  reason?: string;
}

export interface PersistDashboardSnapshotOptions {
  client?: DashboardPersistenceClient | null;
}

type IdRow = { id: string };
type StoryIdRow = IdRow & { story_key: string };
type SourceIdRow = IdRow & { canonical_key: string };
type ScoreIdRow = IdRow & { story_id: string };
type PublicationRow = IdRow & { status: string; publication_key?: string };
type RunRow = IdRow & {
  status: string;
  input_fingerprint?: string | null;
  source_snapshot_hash?: string | null;
};

/**
 * Worker-only durable projection. The static JSON artifact remains the safe
 * public fallback, while a configured Supabase deployment records the
 * idempotent run, clustered stories, source links, score components, rank
 * snapshots, and a compact publication payload.
 */
export async function persistDashboardSnapshot(
  snapshot: DashboardPublicSnapshot,
  options: PersistDashboardSnapshotOptions = {}
): Promise<DashboardPersistenceResult> {
  if (!snapshot.stories.length) return { status: "skipped", reason: "empty_snapshot" };
  if (snapshot.schemaVersion !== DASHBOARD_SCHEMA_VERSION) {
    throw new Error("Dashboard persistence refused an unknown snapshot schema.");
  }

  const client = options.client ?? optionalDashboardPersistenceClient();
  if (!client) return { status: "skipped", reason: "database_not_configured" };

  const generatedAt = exactHour(snapshot.generatedAt, "generatedAt");
  const windowEnd = exactHour(snapshot.windowEnd, "windowEnd");
  const windowStart = new Date(snapshot.windowStart);
  if (!Number.isFinite(windowStart.getTime()) || windowEnd.getTime() - windowStart.getTime() !== DASHBOARD_WINDOW_MS) {
    throw new Error("Dashboard persistence requires an exact rolling 72-hour snapshot.");
  }

  const materialHash = sha256(dashboardSnapshotMaterialDescriptor(snapshot));
  const sourceHash = sha256(JSON.stringify(snapshot.stories.map((story) => ({
    stableKey: story.stableKey,
    sources: story.sources.map((source) => ({ canonicalKey: source.canonicalKey, metrics: source.metrics, publishedAt: source.publishedAt }))
  }))));
  const runKey = `dashboard:${generatedAt.toISOString().replace(/[-:.TZ]/g, "").toLowerCase()}:${materialHash.slice(0, 24)}`;
  const run = await findOrCreateRun(client, {
    runKey,
    snapshot,
    generatedAt,
    materialHash,
    sourceHash
  });
  if (run.status === "completed") {
    const publicationResult = await ensureCompletedRunPublication(
      client,
      snapshot,
      run.id,
      runKey,
      generatedAt,
      materialHash,
      sourceHash
    );
    return { status: publicationResult, runKey };
  }
  if (run.status !== "running") {
    throw new Error(`Dashboard persistence run ${runKey} is ${run.status} and cannot be resumed.`);
  }

  try {
    const storyIds = await upsertStories(client, snapshot, generatedAt);
    const sourceIds = await upsertSources(client, snapshot, generatedAt);
    await upsertStorySources(client, snapshot, storyIds, sourceIds, generatedAt);
    await upsertStoryTopics(client, snapshot, storyIds);
    await upsertStoryEntities(client, snapshot, storyIds);
    const scoreIds = await insertScores(client, snapshot, storyIds, run.id);
    await insertRankSnapshots(client, snapshot, storyIds, scoreIds, run.id, generatedAt);
    // A draft may be safely recorded while the run is still writable. Once
    // completed, result rows become immutable and the publication guard will
    // only permit the final state transition after that completion succeeds.
    const stagedPublicationId = await stageDashboardPublication(client, snapshot, run.id, runKey, generatedAt, new Date());
    // The RPC uses `clock_timestamp()` and wraps run completion plus the
    // current-publication swap in one database transaction. That avoids both
    // client/DB clock skew and an interrupted two-request swap with no
    // current public projection.
    const publicationResult = await finalizeDashboardPublication(
      client,
      run.id,
      stagedPublicationId,
      materialHash,
      sourceHash,
      generatedAt,
      snapshot
    );
    return { status: publicationResult, runKey };
  } catch (error) {
    // `fail_dashboard_run` only mutates running/queued rows. If a network
    // response is lost after atomic finalization, it leaves the completed run
    // intact and an idempotent retry repairs/reads its publication receipt.
    await markRunFailed(client, run.id, error);
    throw error;
  }
}

function optionalDashboardPersistenceClient(): DashboardPersistenceClient | null {
  if (typeof window !== "undefined") return null;
  const client = createServerSupabaseClient({ useServiceRole: true });
  return client ? client as unknown as DashboardPersistenceClient : null;
}

async function findOrCreateRun(
  client: DashboardPersistenceClient,
  input: {
    runKey: string;
    snapshot: DashboardPublicSnapshot;
    generatedAt: Date;
    materialHash: string;
    sourceHash: string;
  }
): Promise<RunRow> {
  const existing = await expectDb(
    client.from<RunRow>("dashboard_runs")
      .select("id,status,input_fingerprint,source_snapshot_hash")
      .eq("run_key", input.runKey)
      .maybeSingle(),
    "look up dashboard run"
  );
  if (existing) {
    if (existing.status === "completed" && (
      existing.input_fingerprint !== input.materialHash ||
      existing.source_snapshot_hash !== input.sourceHash
    )) {
      throw new Error("Dashboard persistence found a completed run with conflicting immutable provenance.");
    }
    return existing;
  }

  const model = await expectDb(
    client.from<IdRow>("scoring_model_versions")
      .select("id")
      .eq("model_key", DASHBOARD_MODEL_KEY)
      .eq("version", DASHBOARD_MODEL_VERSION)
      .maybeSingle(),
    "look up dashboard scoring model"
  );
  if (!model?.id) throw new Error("Dashboard scoring model migration is unavailable.");

  const inserted = await expectRows(
    client.from<RunRow>("dashboard_runs")
      .insert({
        run_key: input.runKey,
        scoring_model_version_id: model.id,
        window_start: input.snapshot.windowStart,
        window_end: input.snapshot.windowEnd,
        as_of_at: input.snapshot.windowEnd,
        input_observed_through: input.snapshot.windowEnd,
        input_fingerprint: input.materialHash,
        source_snapshot_hash: input.sourceHash,
        status: "running",
        stats_json: runStats(input.snapshot)
      })
      .select("id,status"),
    "create dashboard run"
  );
  const run = inserted[0];
  if (!run) throw new Error("Dashboard run insert did not return an id.");
  return run;
}

async function upsertStories(
  client: DashboardPersistenceClient,
  snapshot: DashboardPublicSnapshot,
  generatedAt: Date
): Promise<Map<string, string>> {
  const rows = snapshot.stories.map((story) => ({
    story_key: normalizedStoryKey(story.stableKey),
    status: "active",
    universe: story.universe,
    title: story.title,
    summary: story.summary,
    summary_status: "generated",
    summary_input_hash: sha256(story.summaryFingerprint),
    summary_model_version: "source-grounded-v1",
    cluster_fingerprint: sha256(story.sources.map((source) => source.canonicalKey).sort().join("\u001f")),
    clustering_version: "dashboard-cluster-v1",
    thumbnail_url: httpUrlOrNull(story.thumbnailUrl),
    thumbnail_alt: nullableBounded(story.thumbnailAlt, 240),
    thumbnail_source: story.thumbnailUrl ? "dashboard_source_selection" : null,
    // The snapshot belongs to an exact UTC hour, which can precede the
    // worker's database insert by several minutes. Migration 025 preserves
    // the earliest value on conflict, so this is correct for both first-seen
    // provenance and the `last_seen_at >= first_seen_at` invariant.
    first_seen_at: generatedAt.toISOString(),
    last_seen_at: generatedAt.toISOString(),
    last_ranked_at: generatedAt.toISOString(),
    metadata_json: {
      labels: story.labels,
      platforms: story.platforms,
      sourceCount: story.sourceCount,
      independentSourceCount: story.independentSourceCount
    }
  }));
  const records = await expectRows(
    client.from<StoryIdRow>("dashboard_stories")
      .upsert(rows, { onConflict: "story_key" })
      .select("id,story_key"),
    "upsert dashboard stories"
  );
  return idMap(records, "story_key", "dashboard stories");
}

async function upsertSources(
  client: DashboardPersistenceClient,
  snapshot: DashboardPublicSnapshot,
  generatedAt: Date
): Promise<Map<string, string>> {
  const byCanonicalKey = new Map<string, DashboardStorySource>();
  for (const story of snapshot.stories) {
    for (const source of story.sources) {
      if (!byCanonicalKey.has(source.canonicalKey)) byCanonicalKey.set(source.canonicalKey, source);
    }
  }
  const records = await expectRows(
    client.from<SourceIdRow>("dashboard_external_sources")
      .upsert([...byCanonicalKey.values()].map((source) => ({
        canonical_key: source.canonicalKey,
        platform: source.platform,
        source_type: source.sourceKind,
        canonical_url: requiredHttpUrl(source.url, `source ${source.canonicalKey}`),
        publisher: nullableBounded(source.publisher, 300),
        author: nullableBounded(source.authorName, 300),
        source_title: nullableBounded(source.title, 500),
        published_at: source.publishedAt,
        observed_at: generatedAt.toISOString(),
        verification_state: source.verificationState,
        source_quality_tier: 2,
        independence_key: source.canonicalKey,
        content_fingerprint: sha256(JSON.stringify({
          canonicalKey: source.canonicalKey,
          title: source.title,
          summary: source.summary,
          publishedAt: source.publishedAt
        })),
        thumbnail_url: httpUrlOrNull(source.thumbnailUrl),
        thumbnail_alt: nullableBounded(source.thumbnailAlt, 240),
        metadata_json: {
          nativePlatform: source.nativePlatform,
          metrics: source.metrics,
          destinationUrl: source.destinationUrl,
          signals: source.signals
        }
      })), { onConflict: "canonical_key" })
      .select("id,canonical_key"),
    "upsert dashboard source projections"
  );
  return idMap(records, "canonical_key", "dashboard sources");
}

async function upsertStorySources(
  client: DashboardPersistenceClient,
  snapshot: DashboardPublicSnapshot,
  storyIds: ReadonlyMap<string, string>,
  sourceIds: ReadonlyMap<string, string>,
  generatedAt: Date
): Promise<void> {
  const rows: Array<Record<string, unknown>> = [];
  const primaryLinks: Array<{ story_id: string; external_source_id: string }> = [];
  for (const story of snapshot.stories) {
    const storyId = requiredId(storyIds, normalizedStoryKey(story.stableKey), "story");
    // Sources arrive in the deterministic story-strength order selected by the
    // pipeline. Persist every link as supporting first, then atomically change
    // exactly one link per story to primary below. That avoids a transient
    // collision with the one-primary-per-story database index when a stronger
    // source replaces last hour's primary.
    const primaryCanonicalKey = story.sources[0]?.canonicalKey ?? null;
    for (const source of story.sources) {
      rows.push({
        story_id: storyId,
        external_source_id: requiredId(sourceIds, source.canonicalKey, "source"),
        source_key: `dashboard-source:${sha256(source.canonicalKey)}`,
        source_role: "supporting",
        verification_state: source.verificationState,
        source_quality_tier: 2,
        platform: source.platform,
        canonical_url: requiredHttpUrl(source.url, `source ${source.canonicalKey}`),
        publisher: nullableBounded(source.publisher, 300),
        author: nullableBounded(source.authorName, 300),
        source_title: nullableBounded(source.title, 500),
        published_at: source.publishedAt,
        observed_at: generatedAt.toISOString(),
        independence_key: source.canonicalKey,
        thumbnail_url: httpUrlOrNull(source.thumbnailUrl),
        thumbnail_alt: nullableBounded(source.thumbnailAlt, 240),
        metadata_json: { metrics: source.metrics, signals: source.signals }
      });
    }
    if (primaryCanonicalKey) {
      primaryLinks.push({
        story_id: storyId,
        external_source_id: requiredId(sourceIds, primaryCanonicalKey, "primary source")
      });
    }
  }
  if (!rows.length) throw new Error("Dashboard persistence received stories without sources.");
  await expectRows(
    client.from<IdRow>("dashboard_story_sources")
      .upsert(rows, { onConflict: "source_key" })
      .select("id"),
    "upsert dashboard story sources"
  );
  await expectDb(
    client.rpc<null>("reconcile_dashboard_story_source_primaries", {
      p_primary_links: primaryLinks
    }),
    "reconcile dashboard story source primaries"
  );
}

async function upsertStoryTopics(
  client: DashboardPersistenceClient,
  snapshot: DashboardPublicSnapshot,
  storyIds: ReadonlyMap<string, string>
): Promise<void> {
  const rows = snapshot.stories.flatMap((story) => story.topics.map((topic) => ({
    story_id: requiredId(storyIds, normalizedStoryKey(story.stableKey), "story"),
    topic_key: topic,
    display_name: displayTopic(topic),
    confidence: 1,
    classifier_version: "dashboard-topic-v1",
    is_primary: false,
    metadata_json: {}
  })));
  if (!rows.length) return;
  await expectRows(
    client.from<IdRow>("dashboard_story_topics")
      .upsert(rows, { onConflict: "story_id,topic_key" })
      .select("id"),
    "upsert dashboard story topics"
  );
}

async function upsertStoryEntities(
  client: DashboardPersistenceClient,
  snapshot: DashboardPublicSnapshot,
  storyIds: ReadonlyMap<string, string>
): Promise<void> {
  const rows = snapshot.stories.flatMap((story) => {
    const storyId = requiredId(storyIds, normalizedStoryKey(story.stableKey), "story");
    const tracked = new Map<string, NonNullable<DashboardStorySource["trackedEntity"]>>();
    for (const source of story.sources) {
      const entity = source.trackedEntity;
      if (!entity) continue;
      const entityId = entity.companyId ?? entity.founderId;
      if (!entityId || !isUuid(entityId)) continue;
      const entityType = entity.companyId ? "company" : "founder";
      tracked.set(`${entityType}:${entityId}`, entity);
    }
    return [...tracked.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([entityKey, entity]) => {
      const entityType = entity.companyId ? "company" : "founder";
      return {
        story_id: storyId,
        entity_key: entityKey,
        entity_type: entityType,
        company_id: entityType === "company" ? entity.companyId ?? null : null,
        founder_id: entityType === "founder" ? entity.founderId ?? null : null,
        external_entity_name: null,
        relationship_type: "subject",
        attribution_state: "verified",
        // A cluster can correctly have several verified cohort entities; avoid
        // making one arbitrary source the single primary relationship.
        is_primary: false,
        is_returner: true,
        metadata_json: {
          name: entity.name,
          cohortLabel: entity.cohortLabel,
          batchSlug: entity.batchSlug ?? null
        }
      };
    });
  });
  if (!rows.length) return;
  await expectRows(
    client.from<IdRow>("dashboard_story_entities")
      .upsert(rows, { onConflict: "story_id,entity_key,relationship_type" })
      .select("id"),
    "upsert dashboard story entities"
  );
}

async function insertScores(
  client: DashboardPersistenceClient,
  snapshot: DashboardPublicSnapshot,
  storyIds: ReadonlyMap<string, string>,
  runId: string
): Promise<Map<string, string>> {
  const rows = snapshot.stories.map((story) => ({
    dashboard_run_id: runId,
    story_id: requiredId(storyIds, normalizedStoryKey(story.stableKey), "story"),
    rank: story.rank,
    trend_score: story.trendScore,
    relative_engagement_score: story.score.relativeVirality,
    velocity_score: story.score.velocity,
    freshness_score: story.score.freshness,
    confirmation_score: story.score.crossPlatformConfirmation,
    source_quality_score: story.score.sourceQuality,
    breaking_score: story.breakingScore,
    emerging_score: story.emergingScore,
    rank_delta: story.rankDelta,
    trend_state: story.trendStatus,
    source_count: story.sourceCount,
    platform_count: story.platforms.length,
    independent_source_count: story.independentSourceCount,
    component_json: story.score
  }));
  const records = await expectRows(
    client.from<ScoreIdRow>("dashboard_story_scores")
      // A worker can lose its process after these rows commit but before the
      // final publication RPC returns. The run remains writable, so resuming
      // its deterministic projection must update rather than duplicate it.
      .upsert(rows, { onConflict: "dashboard_run_id,story_id" })
      .select("id,story_id"),
    "upsert dashboard scores"
  );
  return idMap(records, "story_id", "dashboard scores");
}

async function insertRankSnapshots(
  client: DashboardPersistenceClient,
  snapshot: DashboardPublicSnapshot,
  storyIds: ReadonlyMap<string, string>,
  scoreIds: ReadonlyMap<string, string>,
  runId: string,
  generatedAt: Date
): Promise<void> {
  const rows = snapshot.stories.flatMap((story) => {
    const storyId = requiredId(storyIds, normalizedStoryKey(story.stableKey), "story");
    const scoreId = requiredId(scoreIds, storyId, "score");
    return DASHBOARD_VIEWS.flatMap((view) => {
      const ranking = story.viewRankings[view];
      if (!ranking) return [];
      return [{
        dashboard_run_id: runId,
        story_id: storyId,
        dashboard_story_score_id: scoreId,
        ranking_view: view,
        captured_at: generatedAt.toISOString(),
        rank: ranking.rank,
        view_score: scoreForView(story, view),
        rank_delta: ranking.rankDelta,
        trend_state: ranking.trendStatus
      }];
    });
  });
  if (!rows.length) throw new Error("Dashboard persistence received no rank snapshots.");
  await expectRows(
    client.from<IdRow>("dashboard_rank_snapshots")
      .upsert(rows, { onConflict: "dashboard_run_id,story_id,ranking_view" })
      .select("id"),
    "upsert dashboard rank snapshots"
  );
}

async function stageDashboardPublication(
  client: DashboardPersistenceClient,
  snapshot: DashboardPublicSnapshot,
  runId: string,
  runKey: string,
  generatedAt: Date,
  now: Date
): Promise<string> {
  const serialized = JSON.stringify(snapshot);
  const artifactHash = sha256(serialized);
  const publicationKey = `${runKey}:publication`;
  const existing = await expectDb(
    client.from<PublicationRow>("dashboard_publications")
      .select("id,status,publication_key")
      .eq("dashboard_run_id", runId)
      .maybeSingle(),
    "look up staged dashboard publication"
  );
  if (existing) {
    if (existing.status === "draft") return existing.id;
    throw new Error(`Dashboard persistence run already has a ${existing.status} publication receipt.`);
  }
  const staged = await expectRows(
    client.from<IdRow>("dashboard_publications").insert({
      dashboard_run_id: runId,
      publication_key: publicationKey,
      status: "draft",
      is_current: false,
      generated_at: generatedAt.toISOString(),
      freshness_checked_at: now.toISOString(),
      data_fresh_through: generatedAt.toISOString(),
      freshness_status: snapshot.status.partialPlatformFailures.length ? "partial" : "fresh",
      schema_version: snapshot.schemaVersion,
      payload_json: snapshot,
      payload_sha256: artifactHash,
      artifact_path: DASHBOARD_ARTIFACT_PATH,
      artifact_sha256: artifactHash,
      metadata_json: { runKey, candidateCount: snapshot.status.candidateCount }
    }).select("id"),
    "stage dashboard publication"
  );
  const stagedId = staged[0]?.id;
  if (!stagedId) throw new Error("Dashboard publication staging did not return an id.");

  return stagedId;
}

async function finalizeDashboardPublication(
  client: DashboardPersistenceClient,
  runId: string,
  stagedId: string,
  materialHash: string,
  sourceHash: string,
  generatedAt: Date,
  snapshot: DashboardPublicSnapshot
): Promise<"persisted" | "unchanged"> {
  const result = await expectDb(
    client.rpc<string>("finalize_dashboard_publication", {
      p_dashboard_run_id: runId,
      p_publication_id: stagedId,
      p_input_fingerprint: materialHash,
      p_source_snapshot_hash: sourceHash,
      p_input_observed_through: generatedAt.toISOString(),
      p_stats_json: runStats(snapshot)
    }),
    "finalize dashboard publication"
  );
  if (result === "unchanged") return "unchanged";
  if (result !== "published") throw new Error("Dashboard publication finalization returned an unknown state.");
  return "persisted";
}

async function ensureCompletedRunPublication(
  client: DashboardPersistenceClient,
  snapshot: DashboardPublicSnapshot,
  runId: string,
  runKey: string,
  generatedAt: Date,
  materialHash: string,
  sourceHash: string
): Promise<"persisted" | "unchanged"> {
  const publication = await expectDb(
    client.from<IdRow & { status: string; is_current: boolean }>("dashboard_publications")
      .select("id,status,is_current")
      .eq("dashboard_run_id", runId)
      .maybeSingle(),
    "look up completed dashboard publication"
  );
  // A completed publication, including an intentionally superseded one, is
  // historical provenance and must not be rewritten by an idempotent retry.
  if (publication && publication.status !== "draft") return "unchanged";
  const stagedId = publication?.id ?? await stageDashboardPublication(
    client,
    snapshot,
    runId,
    runKey,
    generatedAt,
    new Date()
  );
  return finalizeDashboardPublication(
    client,
    runId,
    stagedId,
    materialHash,
    sourceHash,
    generatedAt,
    snapshot
  );
}

async function markRunFailed(client: DashboardPersistenceClient, runId: string, error: unknown): Promise<void> {
  try {
    await expectDb(
      client.rpc<null>("fail_dashboard_run", {
        p_dashboard_run_id: runId,
        p_error_json: { message: safeErrorMessage(error) }
      }),
      "mark dashboard run failed"
    );
  } catch {
    // Preserve the original write failure; the artifact publisher emits its
    // own sanitized error state and remains the independent public fallback.
  }
}

function runStats(snapshot: DashboardPublicSnapshot): Record<string, unknown> {
  return {
    candidateCount: snapshot.status.candidateCount,
    eligibleCandidateCount: snapshot.status.eligibleCandidateCount,
    storyCount: snapshot.status.storyCount,
    viewStoryCounts: snapshot.status.viewStoryCounts,
    partialPlatformFailures: snapshot.status.partialPlatformFailures
  };
}

async function expectDb<T>(promise: PromiseLike<DbResponse<T>>, operation: string): Promise<T | null> {
  const response = await promise;
  if (response.error) throw new Error(`${operation}: ${response.error.message}`);
  return response.data;
}

async function expectRows<T>(promise: PromiseLike<DbResponse<T[]>>, operation: string): Promise<T[]> {
  const response = await promise;
  if (response.error) throw new Error(`${operation}: ${response.error.message}`);
  return response.data ?? [];
}

function idMap<T extends Record<K, string> & IdRow, K extends string>(
  rows: readonly T[],
  key: K,
  description: string
): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of rows) {
    if (!row.id || !row[key]) throw new Error(`Dashboard ${description} response omitted an identity.`);
    result.set(row[key], row.id);
  }
  return result;
}

function requiredId(values: ReadonlyMap<string, string>, key: string, description: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`Dashboard persistence could not resolve ${description} identity for ${key}.`);
  return value;
}

function normalizedStoryKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(normalized)) {
    throw new Error(`Dashboard story key is not persistable: ${value}`);
  }
  return normalized;
}

function scoreForView(story: DashboardStory, view: DashboardView): number {
  if (view === "breaking") return story.breakingScore;
  if (view === "emerging") return story.emergingScore;
  return story.trendScore;
}

function displayTopic(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function exactHour(value: string, field: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCMinutes() !== 0 || date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) {
    throw new Error(`Dashboard persistence requires ${field} to be an exact UTC-hour slot.`);
  }
  return date;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function httpUrlOrNull(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function requiredHttpUrl(value: string, description: string): string {
  const url = httpUrlOrNull(value);
  if (!url) throw new Error(`Dashboard persistence requires an HTTP URL for ${description}.`);
  return url;
}

function nullableBounded(value: string | null, maximumLength: number): string | null {
  const normalized = value?.trim() ?? "";
  return normalized && normalized.length <= maximumLength ? normalized : null;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "dashboard_persistence_error";
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}
