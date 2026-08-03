import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  TIMELINE_CATEGORIES,
  TIMELINE_EVENT_DATE_TYPES,
  type CompanyTimelineEventDetailArtifact,
  type PublishedTimelineEvent,
  type TimelineCategory,
  type TimelineEvidenceDetail,
  type TimelinePostEvidence,
  type TimelineSourceCoverageState,
  type TimelineSourceType,
} from "./contracts";
import { canonicalizeSourceUrl, sanitizeEvidenceExcerpt } from "./source-document";
import { isExactIsoDate } from "./validation";

const SOURCE_TYPES = new Set<TimelineSourceType>([
  "company_page", "company_blog", "press_release", "changelog", "news_article",
  "accelerator_profile", "investor_page", "customer_page", "partner_page",
  "founder_post", "company_post", "product_hunt", "github_repository",
  "github_release", "research_publication", "patent", "regulatory_filing",
  "archived_page", "video", "podcast", "other",
]);
const EVIDENCE_ROLES = new Set(["primary", "supporting", "conflicting"] as const);
const TERMINAL_COVERAGE = new Set<TimelineSourceCoverageState>([
  "completed", "no_applicable_source", "no_results", "blocked", "authentication_required", "failed",
]);

export interface TimelineDatabaseEventBundle {
  event: PublishedTimelineEvent;
  detail: CompanyTimelineEventDetailArtifact["event"];
  updatedAt: string;
}

export interface TimelineDatabaseCompanySnapshot {
  events: TimelineDatabaseEventBundle[];
  sourceCoverage: Partial<Record<string, TimelineSourceCoverageState>>;
  candidateEventCount: number;
  unresolvedDateCount: number;
}

export interface TimelineDatabaseSnapshot {
  status: "loaded" | "not_configured" | "migration_unavailable";
  byCompanySourceKey: ReadonlyMap<string, TimelineDatabaseCompanySnapshot>;
  sha256: string;
  generatedAt: string | null;
  publishedEvents: number;
  limitations: string | null;
}

export async function loadPublishedTimelineDatabaseSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TimelineDatabaseSnapshot> {
  const url = clean(env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceKey = clean(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !serviceKey) return emptySnapshot("not_configured", "Supabase service-role configuration is unavailable.");
  const client = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { headers: { "X-Client-Info": "returner-timeline-artifact-backfill" } },
  });

  const companyResponse = await client.from("companies").select("id,source_key");
  if (companyResponse.error) throw databaseError("load timeline company identities", companyResponse.error);
  const sourceKeyByDatabaseId = new Map((companyResponse.data ?? []).map((row) => [String(row.id), String(row.source_key)]));

  const readClient = client as unknown as TimelineReadClient;
  const eventsResult = await pagedSelect(readClient, "published_timeline_events", "*");
  if (eventsResult.error && isMigrationUnavailable(eventsResult.error)) {
    return emptySnapshot("migration_unavailable", "Company Timeline migration or public projections are not applied.");
  }
  if (eventsResult.error) throw databaseError("load published timeline events", eventsResult.error);
  const sourcesResult = await pagedSelect(readClient, "published_timeline_source_metadata", "*");
  if (sourcesResult.error) throw databaseError("load published timeline sources", sourcesResult.error);
  const postsResult = await pagedSelect(readClient, "published_timeline_post_metadata", "*");
  if (postsResult.error && !isMigrationUnavailable(postsResult.error)) {
    throw databaseError("load published timeline posts", postsResult.error);
  }
  const coverageResult = await pagedSelect(readClient, "timeline_source_coverage", "company_id,source_class,status");
  if (coverageResult.error) throw databaseError("load timeline source coverage", coverageResult.error);
  const candidateResult = await pagedSelect(readClient, "timeline_event_candidates", "company_id,status,proposed_event_date");
  if (candidateResult.error) throw databaseError("load timeline candidate counts", candidateResult.error);

  const sourceRowsByEvent = groupBy(sourcesResult.rows, (row) => String(row.event_id ?? ""));
  const postRowsByEvent = groupBy(postsResult.error ? [] : postsResult.rows, (row) => String(row.event_id ?? ""));
  const companies = new Map<string, TimelineDatabaseCompanySnapshot>();
  let generatedAt: string | null = null;
  for (const row of eventsResult.rows) {
    const sourceKey = sourceKeyByDatabaseId.get(String(row.primary_company_id));
    if (!sourceKey) throw new Error(`Published Timeline event ${String(row.id)} references an unknown durable company.`);
    const bundle = timelineDatabaseEventBundleFromRows(
      row,
      sourceRowsByEvent.get(String(row.id)) ?? [],
      postRowsByEvent.get(String(row.id)) ?? [],
    );
    generatedAt = maxTimestamp(generatedAt, bundle.updatedAt);
    const current = companySnapshot(companies, sourceKey);
    current.events.push(bundle);
  }
  for (const row of coverageResult.rows) {
    const sourceKey = sourceKeyByDatabaseId.get(String(row.company_id));
    const status = String(row.status) as TimelineSourceCoverageState;
    if (!sourceKey || !TERMINAL_COVERAGE.has(status)) continue;
    companySnapshot(companies, sourceKey).sourceCoverage[String(row.source_class)] = status;
  }
  for (const row of candidateResult.rows) {
    const sourceKey = sourceKeyByDatabaseId.get(String(row.company_id));
    if (!sourceKey) continue;
    if (!["pending", "processing", "needs_review"].includes(String(row.status))) continue;
    const current = companySnapshot(companies, sourceKey);
    current.candidateEventCount += 1;
    if (!row.proposed_event_date) current.unresolvedDateCount += 1;
  }
  for (const current of companies.values()) {
    current.events.sort((left, right) => right.event.eventDate.localeCompare(left.event.eventDate) || right.event.id.localeCompare(left.event.id));
  }

  const stableRows = {
    events: stableRowOrder(eventsResult.rows),
    sources: stableRowOrder(sourcesResult.rows),
    posts: stableRowOrder(postsResult.error ? [] : postsResult.rows),
    coverage: stableRowOrder(coverageResult.rows),
    candidates: stableRowOrder(candidateResult.rows),
  };
  return {
    status: "loaded",
    byCompanySourceKey: companies,
    sha256: digest(stableRows),
    generatedAt,
    publishedEvents: eventsResult.rows.length,
    limitations: null,
  };
}

function databaseEvent(row: Record<string, unknown>, sources: TimelineEvidenceDetail[]): PublishedTimelineEvent {
  const category = String(row.category) as TimelineCategory;
  if (!(TIMELINE_CATEGORIES as readonly string[]).includes(category)) throw new Error(`Published Timeline event has invalid category ${category}.`);
  const eventDateType = String(row.event_date_type) as PublishedTimelineEvent["eventDateType"];
  if (!(TIMELINE_EVENT_DATE_TYPES as readonly string[]).includes(eventDateType)) throw new Error(`Published Timeline event has invalid date type ${eventDateType}.`);
  const eventDate = String(row.event_date);
  if (!isExactIsoDate(eventDate)) throw new Error(`Published Timeline event has invalid exact date ${eventDate}.`);
  const title = requiredText(row.title, 140, "published Timeline title");
  const summary = requiredText(row.summary, 320, "published Timeline summary");
  const hasConflict = Boolean(row.has_conflict);
  const conflictSummary = hasConflict ? requiredText(row.conflict_summary, 240, "published Timeline conflict summary") : null;
  return {
    id: `tldb-${String(row.id).toLowerCase()}`,
    eventDate,
    eventDateType,
    title,
    summary,
    category,
    isMajor: Boolean(row.is_major),
    hasConflict,
    conflictSummary,
    evidenceCount: sources.length,
    sourcePreview: sources.slice(0, 3).map((source) => ({
      id: source.id,
      title: source.title,
      publisher: source.publisher,
      domain: source.domain,
      sourceType: source.sourceType,
      publishedAt: source.publishedAt,
      evidenceRole: source.evidenceRole,
      url: source.url,
    })),
  };
}

function databaseEvidence(row: Record<string, unknown>): TimelineEvidenceDetail | null {
  const sourceType = String(row.source_type) as TimelineSourceType;
  const evidenceRole = String(row.evidence_role) as TimelineEvidenceDetail["evidenceRole"];
  if (!SOURCE_TYPES.has(sourceType) || !EVIDENCE_ROLES.has(evidenceRole)) return null;
  let url: string;
  try { url = canonicalizeSourceUrl(String(row.canonical_url)); } catch { return null; }
  const isConflicting = Boolean(row.is_conflicting);
  const sourceEventDate = row.source_event_date ? String(row.source_event_date) : null;
  return {
    id: `srcdb-${String(row.id).toLowerCase()}`,
    title: requiredText(row.title, 240, "published Timeline source title"),
    publisher: optionalText(row.publisher, 160),
    domain: new URL(url).hostname.replace(/^www\./, "").toLowerCase(),
    sourceType,
    publishedAt: optionalTimestamp(row.published_at),
    evidenceRole,
    url,
    publicationDate: optionalTimestamp(row.published_at),
    excerpt: optionalText(row.evidence_excerpt, 500),
    sourceEventDate: sourceEventDate && isExactIsoDate(sourceEventDate) ? sourceEventDate : null,
    isConflicting,
    conflictDescription: isConflicting ? optionalText(row.conflict_description, 240) ?? "This source conflicts with the selected event claim." : null,
  };
}

function companySnapshot(map: Map<string, TimelineDatabaseCompanySnapshot>, sourceKey: string): TimelineDatabaseCompanySnapshot {
  const current = map.get(sourceKey) ?? { events: [], sourceCoverage: {}, candidateEventCount: 0, unresolvedDateCount: 0 };
  map.set(sourceKey, current);
  return current;
}

interface TimelineReadClient {
  from(table: string): {
    select(columns: string): {
      range(from: number, to: number): PromiseLike<{
        data: unknown[] | null;
        error: { code?: string; message: string } | null;
      }>;
    };
  };
}

/**
 * Maps the database's deliberately narrow public projections into the same
 * public contract used by repository artifacts. Exported for the request-time
 * invalidation overlay; callers must supply rows from the two published views,
 * never the private base tables.
 */
export function timelineDatabaseEventBundleFromRows(
  eventRow: Record<string, unknown>,
  sourceRows: readonly Record<string, unknown>[],
  postRows: readonly Record<string, unknown>[] = [],
): TimelineDatabaseEventBundle {
  const sources = sourceRows
    .map(databaseEvidence)
    .filter((item): item is TimelineEvidenceDetail => item !== null);
  if (!sources.length) {
    throw new Error(`Published Timeline event ${String(eventRow.id)} has no safe public evidence projection.`);
  }
  const event = databaseEvent(eventRow, sources);
  const posts = postRows.flatMap((row) => {
    const post = databasePost(row, event.eventDate);
    return post ? [post] : [];
  });
  return {
    event,
    detail: { ...event, evidence: sources, posts },
    updatedAt: timestamp(eventRow.updated_at ?? eventRow.published_at),
  };
}

function databasePost(row: Record<string, unknown>, fallbackDate: string): TimelinePostEvidence | null {
  const evidenceRole = String(row.evidence_role) as TimelinePostEvidence["evidenceRole"];
  if (!EVIDENCE_ROLES.has(evidenceRole)) return null;
  let url: string;
  try { url = canonicalizeSourceUrl(String(row.canonical_url)); } catch { return null; }
  const metadata = isRecord(row.metadata_json) ? row.metadata_json : {};
  const metrics = isRecord(metadata.metrics)
    ? Object.fromEntries(Object.entries(metadata.metrics).flatMap(([key, value]) =>
      /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) && typeof value === "number" && Number.isFinite(value)
        ? [[key, value]]
        : []
    ))
    : {};
  const publishedAt = optionalTimestamp(row.published_at);
  return {
    id: String(row.id),
    platform: requiredText(row.platform, 64, "published Timeline post platform"),
    account: optionalText(metadata.authorHandle ?? metadata.authorName, 160),
    postDate: publishedAt?.slice(0, 10) ?? fallbackDate,
    excerpt: optionalText(metadata.text, 500),
    url,
    metrics,
    evidenceRole,
  };
}

async function pagedSelect(client: TimelineReadClient, table: string, columns: string) {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1_000) {
    const response = await client.from(table).select(columns).range(offset, offset + 999);
    if (response.error) return { rows: [], error: response.error };
    const page = (response.data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < 1_000) return { rows, error: null };
  }
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) grouped.set(key(row), [...(grouped.get(key(row)) ?? []), row]);
  return grouped;
}

function stableRowOrder(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function emptySnapshot(status: "not_configured" | "migration_unavailable", limitations: string): TimelineDatabaseSnapshot {
  return { status, byCompanySourceKey: new Map(), sha256: digest({ status }), generatedAt: null, publishedEvents: 0, limitations };
}

function isMigrationUnavailable(error: { code?: string; message?: string }): boolean {
  return ["42P01", "PGRST205", "PGRST204"].includes(String(error.code ?? ""))
    || /published_timeline_(?:events|post_metadata).*(?:not found|does not exist|schema cache)/i.test(String(error.message ?? ""));
}

function databaseError(operation: string, error: { code?: string; message: string }): Error {
  return new Error(`${operation}: ${error.message}${error.code ? ` (${error.code})` : ""}`);
}

function requiredText(value: unknown, maximum: number, label: string): string {
  const text = optionalText(value, maximum);
  if (!text) throw new Error(`${label} is empty.`);
  return text;
}
function optionalText(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim() ? sanitizeEvidenceExcerpt(value, maximum) : null;
}
function optionalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}
function timestamp(value: unknown): string {
  const parsed = optionalTimestamp(value);
  if (!parsed) throw new Error("Published Timeline row is missing a valid update timestamp.");
  return parsed;
}
function maxTimestamp(left: string | null, right: string): string { return !left || right > left ? right : left; }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function clean(value: string | undefined): string | null { return value?.trim() || null; }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
