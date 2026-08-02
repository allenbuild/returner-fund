import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createServerSupabaseClient } from "@/lib/db/client";
import {
  TIMELINE_ARTIFACT_SCHEMA_VERSION,
  TIMELINE_CATEGORIES,
  TIMELINE_COVERAGE_SCHEMA_VERSION,
  TIMELINE_EVENT_DATE_TYPES,
  TIMELINE_EVENT_DETAIL_SCHEMA_VERSION,
  type CompanyTimelineArtifact,
  type CompanyTimelineEventDetailArtifact,
  type ListPublishedTimelineEventsInput,
  type ListPublishedTimelineEventsResult,
  type ListTimelineCandidatesInput,
  type ListTimelineCandidatesResult,
  type ListTimelineCoverageInput,
  type ListTimelineCoverageResult,
  type PublishedTimelineEvent,
  type PublicTimelineCoverage,
  type TimelineAdminActionResult,
  type TimelineAdminAuditActor,
  type TimelineAdminCandidateAction,
  type TimelineAdminCompanyAction,
  type TimelineAdminEventAction,
  type TimelineAdminEventDetail,
  type TimelineCandidateDetail,
  type TimelineCandidateSummary,
  type TimelineCompanyCoverageSummary,
  type TimelineCompanyRef,
  type TimelineCoverageManifest,
  type TimelineEvidenceDetail,
  type TimelineMonthGroup,
  type TimelinePostEvidence,
  type TimelineSourceDocumentAdmin,
  type TimelineSourceCoverageState,
  type TimelineSourceType,
} from "./contracts";
import { isExactIsoDate, isOneConciseSentence } from "./validation";
import { shouldMergeTimelineEvents } from "./dedupe";
import {
  timelineDatabaseEventBundleFromRows,
  type TimelineDatabaseEventBundle,
} from "./database-backfill";

const TIMELINE_ROOT = join(process.cwd(), "public", "timelines");
const TIMELINE_INTERNAL_COVERAGE_PATH = join(process.cwd(), "artifacts", "company-timeline", "coverage.json");
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const COMPANY_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
const EVENT_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
const COVERAGE_MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
const PUBLIC_TIMELINE_SOURCE_TYPES = new Set<string>([
  "company_page", "company_blog", "press_release", "changelog", "news_article",
  "accelerator_profile", "investor_page", "customer_page", "partner_page",
  "founder_post", "company_post", "product_hunt", "github_repository",
  "github_release", "research_publication", "patent", "regulatory_filing",
  "archived_page", "video", "podcast", "other",
]);

interface DbError { message: string; code?: string }
interface DbResponse<T> { data: T | null; error: DbError | null }
interface DbQuery<T = Record<string, unknown>> extends PromiseLike<DbResponse<T[]>> {
  select(columns?: string): DbQuery<T>;
  insert(values: unknown): DbQuery<T>;
  upsert(values: unknown, options?: { onConflict?: string; ignoreDuplicates?: boolean }): DbQuery<T>;
  update(values: unknown): DbQuery<T>;
  delete(): DbQuery<T>;
  eq(column: string, value: unknown): DbQuery<T>;
  in(column: string, values: readonly unknown[]): DbQuery<T>;
  or(filters: string): DbQuery<T>;
  order(column: string, options?: { ascending?: boolean }): DbQuery<T>;
  limit(value: number): DbQuery<T>;
  range(from: number, to: number): DbQuery<T>;
  maybeSingle(): PromiseLike<DbResponse<T>>;
  single(): PromiseLike<DbResponse<T>>;
}
export interface TimelineStoreClient {
  from<T = Record<string, unknown>>(table: string): DbQuery<T>;
  rpc<T = Record<string, unknown>>(
    functionName: string,
    args?: Record<string, unknown>,
  ): PromiseLike<DbResponse<T>>;
}
type TimelineDbClient = TimelineStoreClient;

export class TimelineStoreError extends Error {
  constructor(message: string, readonly code = "timeline_store_error") {
    super(message);
    this.name = "TimelineStoreError";
  }
}

export async function resolveTimelineCompanyBySlug(
  slug: string,
  client?: TimelineStoreClient,
): Promise<TimelineCompanyRef | null> {
  void client;
  const artifact = await readJsonIfPresent<unknown>(companyArtifactPath(slug), COMPANY_ARTIFACT_MAX_BYTES);
  if (artifact !== null) {
    if (!isCompanyTimelineArtifact(artifact)) {
      throw new TimelineStoreError("Timeline company artifact was malformed.", "artifact_invalid");
    }
    if (artifact.company.slug !== slug) {
      throw new TimelineStoreError("Timeline company artifact identity was inconsistent.", "artifact_identity_mismatch");
    }
    return artifact.company;
  }
  const manifest = await readCoverageManifest();
  const manifestCompany = manifest.companies.find((item) => item.company.slug === slug)?.company;
  if (manifestCompany) return manifestCompany;

  // Development/bootstrap fallback only. Production publication writes one
  // coverage row and company artifact per canonical entity, so the public API
  // never needs to materialize the large graph catalog on its hot path.
  const { findCompany } = await import("@/lib/seo/catalog");
  const company = findCompany(slug);
  return company ? { id: company.node.entityId, slug: company.slug, name: company.node.label } : null;
}

export async function listPublishedTimelineEvents(
  input: ListPublishedTimelineEventsInput,
  client?: TimelineStoreClient,
): Promise<ListPublishedTimelineEventsResult> {
  const company = await resolveTimelineCompanyById(input.companyId);
  if (!company) throw new TimelineStoreError("Timeline company was not found.", "company_not_found");
  const artifact = await readCompanyArtifact(company);
  const cursor = decodeEventCursor(input.cursor ?? null);
  const liveDatabase = await loadLiveTimelineCompany(input.companyId, optionalTimelineDb(client));
  const availableEvents = liveDatabase?.available
    ? mergeLiveDatabaseEvents(artifact.events, liveDatabase.events, input.companyId)
    : artifact.events;
  const categories = new Set(input.categories ?? []);
  const filtered = availableEvents.filter((event) =>
    (!input.from || event.eventDate >= input.from)
    && (!input.to || event.eventDate <= input.to)
    && (!categories.size || categories.has(event.category))
    && (!cursor || event.eventDate < cursor.eventDate || (event.eventDate === cursor.eventDate && event.id < cursor.id))
  ).sort(comparePublishedEvents);
  const limit = boundedLimit(input.limit);
  const events = filtered.slice(0, limit);
  const last = events.at(-1);
  const nextCursor = filtered.length > events.length && last
    ? encodeEventCursor({ eventDate: last.eventDate, id: last.id })
    : null;
  const lastModifiedAt = liveDatabase?.available && liveDatabase.lastModifiedAt > artifact.lastModifiedAt
    ? liveDatabase.lastModifiedAt
    : artifact.lastModifiedAt;
  const bytes = Buffer.from(JSON.stringify({ company: artifact.company, events: availableEvents, lastModifiedAt }));
  return {
    company: artifact.company,
    events,
    groups: buildTimelineMonthGroups(filtered),
    coverage: {
      ...artifact.coverage,
      publishedEventCount: availableEvents.length,
    },
    nextCursor,
    cache: {
      etag: `"${sha256(bytes)}"`,
      generatedAt: artifact.generatedAt,
      lastModifiedAt,
      maxAgeSeconds: 30,
      staleWhileRevalidateSeconds: 30,
    },
  };
}

export async function getPublishedTimelineEventDetail(
  eventId: string,
  client?: TimelineStoreClient,
): Promise<CompanyTimelineEventDetailArtifact | null> {
  if (!/^[A-Za-z0-9._~:-]{1,180}$/.test(eventId)) return null;
  if (eventId.startsWith("tldb-")) {
    const liveDatabase = await loadLiveTimelineEvent(eventId, optionalTimelineDb(client));
    if (liveDatabase?.available) {
      if (!liveDatabase.bundle || !liveDatabase.companySourceKey) return null;
      const company = await resolveTimelineCompanyById(liveDatabase.companySourceKey);
      if (!company) {
        throw new TimelineStoreError("Timeline database event referenced an unknown company.", "company_not_found");
      }
      return {
        schemaVersion: TIMELINE_EVENT_DETAIL_SCHEMA_VERSION,
        company,
        event: liveDatabase.bundle.detail,
        generatedAt: liveDatabase.bundle.updatedAt,
        lastModifiedAt: liveDatabase.bundle.updatedAt,
      };
    }
  }
  const artifact = await readJsonIfPresent<unknown>(
    join(TIMELINE_ROOT, "events", `${eventId}.json`),
    EVENT_ARTIFACT_MAX_BYTES,
  );
  if (artifact === null) return null;
  if (!isCompanyTimelineEventDetailArtifact(artifact)) {
    throw new TimelineStoreError("Timeline event artifact was malformed.", "artifact_invalid");
  }
  return artifact;
}

export async function listTimelineCoverage(
  input: ListTimelineCoverageInput = {},
  client?: TimelineStoreClient,
): Promise<ListTimelineCoverageResult> {
  const manifest = await readCoverageManifest();
  const query = input.q?.trim().toLowerCase();
  const status = input.status;
  const artifactItems = manifest.companies.map((item): TimelineCompanyCoverageSummary => ({
    company: item.company,
    historicalBackfillStatus: item.status === "in_progress" ? "running" : item.status === "complete" ? "completed" : item.status,
    historicalBackfillStartedAt: null,
    historicalBackfillCompletedAt: item.status === "complete" ? item.lastSuccessfulArtifactAt : null,
    lastIncrementalScanAt: null,
    lastDeepScanAt: null,
    publishedEventCount: item.publishedEventCount,
    candidateEventCount: item.candidateEventCount,
    unresolvedConflictCount: item.unresolvedConflictCount,
    unresolvedDateCount: item.unresolvedDateCount,
    failedSourceCount: countFailedSources(item.sourceCoverage),
    deadLetterTaskCount: 0,
    cacheStatus: item.lastSuccessfulArtifactAt ? "current" : "missing",
    sourceCoverage: item.sourceCoverage,
    lastSuccessfulArtifactAt: item.lastSuccessfulArtifactAt,
    lastError: item.lastError,
  }));
  const items = await overlayLiveTimelineCoverage(artifactItems, optionalTimelineDb(client));
  const filtered = items.filter((item) =>
    (!query || item.company.name.toLowerCase().includes(query) || item.company.slug.includes(query))
    && (!status || item.historicalBackfillStatus === status)
  ).sort((left, right) => left.company.name.localeCompare(right.company.name) || left.company.id.localeCompare(right.company.id));
  return paginate(filtered, input.cursor, input.limit);
}

export async function listTimelineCandidates(
  input: ListTimelineCandidatesInput = {},
  providedClient?: TimelineStoreClient,
): Promise<ListTimelineCandidatesResult> {
  const client = optionalTimelineDb(providedClient);
  if (!client) return { items: [], nextCursor: null };
  const limit = boundedLimit(input.limit);
  const offset = decodeOffsetCursor(input.cursor ?? null);
  let candidateQuery = client.from<Record<string, unknown>>("timeline_event_candidates")
    .select("*").order("updated_at", { ascending: false }).order("id", { ascending: false });
  if (input.companyId) candidateQuery = candidateQuery.eq("company_id", input.companyId);
  if (input.status) candidateQuery = candidateQuery.eq("status", input.status);
  const q = input.q?.trim();
  if (q) {
    // Supabase's `or` expression is raw PostgREST syntax. Strip its grammar
    // metacharacters before interpolation; the admin HTTP layer has already
    // bounded the user-facing query length.
    const safeSearch = q.replace(/[,%().*]/g, " ").replace(/\s+/g, " ").trim();
    if (safeSearch) {
      candidateQuery = candidateQuery.or(
        `proposed_title.ilike.%${safeSearch}%,proposed_summary.ilike.%${safeSearch}%`,
      );
    }
  }
  const response = await candidateQuery.range(offset, offset + limit);
  assertDb(response, "list timeline candidates");
  const returnedRows = response.data ?? [];
  const hasNextPage = returnedRows.length > limit;
  const candidateRows = returnedRows.slice(0, limit);
  const candidateIds = candidateRows.map((row) => String(row.id));
  const sourceIdsByCandidate = new Map<string, string[]>();
  if (candidateIds.length) {
    const sourceLinks = await client.from<Record<string, unknown>>("timeline_candidate_sources")
      .select("candidate_id,source_document_id").in("candidate_id", candidateIds);
    assertDb(sourceLinks, "list timeline candidate sources");
    for (const link of sourceLinks.data ?? []) {
      const candidateId = String(link.candidate_id);
      const ids = sourceIdsByCandidate.get(candidateId) ?? [];
      ids.push(String(link.source_document_id));
      sourceIdsByCandidate.set(candidateId, ids);
    }
  }
  const items = candidateRows.map((row) => candidateSummaryFromRow(
    row,
    sourceIdsByCandidate.get(String(row.id)) ?? [],
  ));
  return {
    items,
    nextCursor: hasNextPage ? Buffer.from(String(offset + items.length)).toString("base64url") : null,
  };
}

export async function getTimelineCandidateDetail(
  candidateId: string,
  providedClient?: TimelineStoreClient,
): Promise<TimelineCandidateDetail | null> {
  const client = requireTimelineDb(providedClient);
  const candidateResponse = await client.from<Record<string, unknown>>("timeline_event_candidates")
    .select("*").eq("id", candidateId).maybeSingle();
  assertDb(candidateResponse, "get timeline candidate");
  if (!candidateResponse.data) return null;
  const sourceLinks = await client.from<Record<string, unknown>>("timeline_candidate_sources")
    .select("*").eq("candidate_id", candidateId);
  assertDb(sourceLinks, "get timeline candidate sources");
  const sourceIds = (sourceLinks.data ?? []).map((row) => String(row.source_document_id));
  const sources: TimelineEvidenceDetail[] = [];
  const sourceRows = sourceIds.length
    ? await client.from<Record<string, unknown>>("source_documents").select("*").in("id", sourceIds)
    : { data: [], error: null };
  assertDb(sourceRows, "get timeline candidate source documents");
  for (const sourceRow of sourceRows.data ?? []) {
    const source = sourceDocumentAdminFromRow(sourceRow);
    const sourceId = source.id;
    const link = (sourceLinks.data ?? []).find((row) => row.source_document_id === sourceId);
    sources.push({
      id: source.id, title: source.title, publisher: source.publisher, domain: source.domain,
      sourceType: source.sourceType, publishedAt: source.publishedAt,
      evidenceRole: normalizePublicEvidenceRole(String(link?.evidence_role ?? "supporting")),
      url: source.canonicalUrl, publicationDate: source.publishedAt, excerpt: source.excerpt,
      sourceEventDate: null, isConflicting: link?.evidence_role === "conflicting", conflictDescription: null,
    });
  }
  const row = candidateResponse.data;
  const payload = objectValue(row.candidate_payload);
  const summary = candidateSummaryFromRow(row, sourceIds);
  const potentialDuplicates = await findPotentialCandidateDuplicates(client, row);
  return {
    ...summary,
    proposedImportance: numberOrNull(row.proposed_importance),
    proposedMergeKey: stringOrNull(row.proposed_merge_key),
    sources,
    potentialDuplicates,
    conflicts: Array.isArray(payload.conflicts) ? payload.conflicts as TimelineCandidateDetail["conflicts"] : [],
    classifierVersion: String(row.classifier_version),
    extractionVersion: String(row.extraction_version),
  };
}

async function findPotentialCandidateDuplicates(
  client: TimelineDbClient,
  candidate: Record<string, unknown>,
): Promise<TimelineCandidateDetail["potentialDuplicates"]> {
  const category = stringOrNull(candidate.proposed_category);
  const eventDate = stringOrNull(candidate.proposed_event_date);
  const title = stringOrNull(candidate.proposed_title);
  if (
    !category
    || !(TIMELINE_CATEGORIES as readonly string[]).includes(category)
    || !eventDate
    || !isExactIsoDate(eventDate)
    || !title
  ) return [];

  const response = await client.from<Record<string, unknown>>("timeline_events")
    .select("id,primary_company_id,category,event_date,title,status")
    .eq("primary_company_id", candidate.company_id)
    .order("event_date", { ascending: false })
    .limit(500);
  assertDb(response, "find potential timeline candidate duplicates");
  const candidateIdentity = {
    companyId: String(candidate.company_id),
    category: category as PublishedTimelineEvent["category"],
    eventDate,
    title,
  };
  return (response.data ?? []).flatMap((event) => {
    const existingDate = stringOrNull(event.event_date);
    const existingCategory = stringOrNull(event.category);
    const existingTitle = stringOrNull(event.title);
    if (
      ["merged", "superseded", "rejected"].includes(String(event.status))
      || !existingDate
      || !isExactIsoDate(existingDate)
      || !existingCategory
      || !(TIMELINE_CATEGORIES as readonly string[]).includes(existingCategory)
      || !existingTitle
    ) return [];
    const existingIdentity = {
      id: String(event.id),
      companyId: String(event.primary_company_id),
      category: existingCategory as PublishedTimelineEvent["category"],
      eventDate: existingDate,
      title: existingTitle,
    };
    if (!shouldMergeTimelineEvents(candidateIdentity, existingIdentity)) return [];
    const distance = Math.round(Math.abs(
      Date.parse(`${eventDate}T00:00:00Z`) - Date.parse(`${existingDate}T00:00:00Z`),
    ) / 86_400_000);
    return [{
      eventId: existingIdentity.id,
      title: existingTitle,
      eventDate: existingDate,
      category: existingIdentity.category,
      deterministicMatchReasons: [
        category === existingCategory ? "Same category" : "Compatible open-source category",
        distance === 0 ? "Same exact date" : `Dates are ${distance} ${distance === 1 ? "day" : "days"} apart`,
        "Material title tokens overlap",
      ],
    }];
  }).slice(0, 20);
}

export async function getTimelineSourceDocumentAdmin(
  sourceId: string,
  providedClient?: TimelineStoreClient,
): Promise<TimelineSourceDocumentAdmin | null> {
  const client = requireTimelineDb(providedClient);
  const response = await client.from<Record<string, unknown>>("source_documents")
    .select("*").eq("id", sourceId).maybeSingle();
  assertDb(response, "get timeline source document");
  const row = response.data;
  if (!row) return null;
  return sourceDocumentAdminFromRow(row);
}

export async function getTimelineAdminEventDetail(
  eventId: string,
  providedClient?: TimelineStoreClient,
): Promise<TimelineAdminEventDetail | null> {
  const client = requireTimelineDb(providedClient);
  const response = await client.from<Record<string, unknown>>("timeline_events").select("*").eq("id", eventId).maybeSingle();
  assertDb(response, "get timeline admin event");
  const row = response.data;
  if (!row) return null;
  // Admin inspection must not depend on the public artifact. Candidate and
  // needs-review events are intentionally absent from public JSON, but an
  // administrator still needs their complete evidence before publishing,
  // splitting, removing a source, or resolving a conflict.
  const [evidenceLinks, postLinks, audits] = await Promise.all([
    client.from<Record<string, unknown>>("timeline_event_evidence")
      .select("*").eq("event_id", eventId).limit(500),
    client.from<Record<string, unknown>>("timeline_event_posts")
      .select("*").eq("event_id", eventId).limit(500),
    client.from<Record<string, unknown>>("timeline_event_audit_log")
      .select("*").eq("event_id", eventId).order("created_at", { ascending: false }).limit(200),
  ]);
  assertDb(evidenceLinks, "get timeline admin event evidence links");
  assertDb(postLinks, "get timeline admin event post links");
  assertDb(audits, "get timeline event audit history");

  const sourceIds = [...new Set((evidenceLinks.data ?? []).map((link) => String(link.source_document_id)))];
  const evidenceIds = [...new Set((postLinks.data ?? []).map((link) => String(link.evidence_id)))];
  const sourceResponse = sourceIds.length
    ? await client.from<Record<string, unknown>>("source_documents").select("*").in("id", sourceIds).limit(500)
    : { data: [], error: null };
  const postResponse = evidenceIds.length
    ? await client.from<Record<string, unknown>>("evidence_items").select("*").in("id", evidenceIds).limit(500)
    : { data: [], error: null };
  assertDb(sourceResponse, "get timeline admin event source documents");
  assertDb(postResponse, "get timeline admin event posts");

  const sourceById = new Map((sourceResponse.data ?? []).map((source) => [String(source.id), source]));
  const postById = new Map((postResponse.data ?? []).map((post) => [String(post.id), post]));
  const evidence = (evidenceLinks.data ?? []).flatMap((link): TimelineEvidenceDetail[] => {
    const source = sourceById.get(String(link.source_document_id));
    if (!source || !isHttpUrl(source.canonical_url)) return [];
    const conflicting = Boolean(link.is_conflicting);
    return [{
      id: String(source.id),
      title: String(source.title),
      publisher: stringOrNull(source.publisher),
      domain: String(source.domain),
      sourceType: String(source.source_type) as TimelineSourceType,
      publishedAt: stringOrNull(source.published_at),
      evidenceRole: normalizePublicEvidenceRole(String(link.evidence_role)),
      url: String(source.canonical_url),
      publicationDate: stringOrNull(source.published_at),
      excerpt: boundedText(link.evidence_excerpt, 2_000),
      sourceEventDate: stringOrNull(link.source_event_date),
      isConflicting: conflicting,
      conflictDescription: conflicting
        ? stringOrNull(link.conflict_description) ?? "This source contains a conflicting claim."
        : null,
    }];
  });
  const posts = (postLinks.data ?? []).flatMap((link): TimelinePostEvidence[] => {
    const post = postById.get(String(link.evidence_id));
    if (!post || !isHttpUrl(post.canonical_url)) return [];
    const metadata = objectValue(post.metadata_json);
    const publishedAt = stringOrNull(post.published_at);
    const metrics = isObject(metadata.metrics)
      ? Object.fromEntries(Object.entries(metadata.metrics).flatMap(([key, value]) =>
        /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) && typeof value === "number" && Number.isFinite(value)
          ? [[key, value]]
          : []
      ))
      : {};
    return [{
      id: String(post.id),
      platform: String(post.platform),
      account: boundedText(metadata.authorHandle ?? metadata.authorName, 160),
      postDate: publishedAt?.slice(0, 10) ?? String(row.event_date),
      excerpt: boundedText(metadata.text ?? metadata.excerpt, 2_000),
      url: String(post.canonical_url),
      metrics,
      evidenceRole: normalizePublicEvidenceRole(String(link.evidence_role)),
    }];
  });
  return {
    event: {
      id: String(row.id), companyId: String(row.primary_company_id), eventDate: String(row.event_date),
      eventDateType: String(row.event_date_type) as TimelineAdminEventDetail["event"]["eventDateType"],
      title: String(row.title), summary: String(row.summary),
      category: String(row.category) as TimelineAdminEventDetail["event"]["category"],
      isMajor: Boolean(row.is_major), hasConflict: Boolean(row.has_conflict),
      conflictSummary: stringOrNull(row.conflict_summary), evidenceCount: evidence.length + posts.length,
      sourcePreview: evidence.slice(0, 3).map((source) => ({
        id: source.id,
        title: source.title,
        publisher: source.publisher,
        domain: source.domain,
        sourceType: source.sourceType,
        publishedAt: source.publishedAt,
        evidenceRole: source.evidenceRole,
        url: source.url,
      })),
      status: String(row.status) as TimelineAdminEventDetail["event"]["status"],
      importanceScore: Number(row.importance_score), eventKey: String(row.event_key),
      publishedAt: stringOrNull(row.published_at), classifierVersion: stringOrNull(row.classifier_version),
      extractionVersion: stringOrNull(row.extraction_version),
    },
    evidence,
    posts,
    auditHistory: (audits.data ?? []).map((audit) => ({
      id: String(audit.id), actorId: String(audit.actor_id), actorEmail: stringOrNull(audit.actor_email),
      action: String(audit.action), before: nullableObject(audit.before_json), after: nullableObject(audit.after_json),
      reason: stringOrNull(audit.reason), createdAt: String(audit.created_at),
    })),
  };
}

export async function applyTimelineAdminEventAction(
  action: TimelineAdminEventAction,
  actor: TimelineAdminAuditActor,
  providedClient?: TimelineStoreClient,
): Promise<TimelineAdminActionResult> {
  const client = requireTimelineDb(providedClient);
  return applyTimelineAdminActionRpc(client, "event", action, actor);
}

export async function applyTimelineAdminCandidateAction(
  action: TimelineAdminCandidateAction,
  actor: TimelineAdminAuditActor,
  providedClient?: TimelineStoreClient,
): Promise<TimelineAdminActionResult> {
  const client = requireTimelineDb(providedClient);
  return applyTimelineAdminActionRpc(client, "candidate", action, actor);
}

export async function applyTimelineAdminCompanyAction(
  action: TimelineAdminCompanyAction,
  actor: TimelineAdminAuditActor,
  providedClient?: TimelineStoreClient,
): Promise<TimelineAdminActionResult> {
  const client = requireTimelineDb(providedClient);
  return applyTimelineAdminActionRpc(client, "company", action, actor);
}

async function applyTimelineAdminActionRpc(
  client: TimelineDbClient,
  scope: "event" | "candidate" | "company",
  action: TimelineAdminEventAction | TimelineAdminCandidateAction | TimelineAdminCompanyAction,
  actor: TimelineAdminAuditActor,
): Promise<TimelineAdminActionResult> {
  const response = await client.rpc<Record<string, unknown>>("apply_timeline_admin_action", {
    p_scope: scope,
    p_action: action,
    p_actor: { id: actor.id, email: actor.email ?? null },
  });
  assertDb(response, `apply atomic timeline ${scope} action`);
  const result = response.data;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    !isObject(result)
    || typeof result.auditId !== "string"
    || !uuid.test(result.auditId)
    || !Array.isArray(result.affectedEventIds)
    || !result.affectedEventIds.every((id) => typeof id === "string" && uuid.test(id))
    || result.cacheInvalidated !== true
  ) {
    throw new TimelineStoreError(
      "Atomic timeline admin action returned a malformed result.",
      "database_contract_error",
    );
  }
  return {
    auditId: result.auditId,
    affectedEventIds: result.affectedEventIds,
    cacheInvalidated: true,
  };
}

export async function invalidateTimelineArtifact(
  companyId: string,
  reason: string,
  providedClient?: TimelineStoreClient,
): Promise<void> {
  const client = requireTimelineDb(providedClient);
  assertDb(await client.from("timeline_artifact_invalidations").insert({ company_id: companyId, reason }).select("id"), "invalidate timeline artifact");
}

async function readCompanyArtifact(company: TimelineCompanyRef): Promise<CompanyTimelineArtifact> {
  const artifact = await readJsonIfPresent<unknown>(
    companyArtifactPath(company.slug),
    COMPANY_ARTIFACT_MAX_BYTES,
  );
  if (artifact !== null && isCompanyTimelineArtifact(artifact)) {
    if (artifact.company.id !== company.id || artifact.company.slug !== company.slug) {
      throw new TimelineStoreError(
        "Timeline artifact identity did not match the requested canonical company.",
        "artifact_identity_mismatch",
      );
    }
    return artifact;
  }
  if (artifact !== null) {
    throw new TimelineStoreError("Timeline company artifact was malformed.", "artifact_invalid");
  }
  const now = new Date(0).toISOString();
  return {
    schemaVersion: TIMELINE_ARTIFACT_SCHEMA_VERSION,
    company,
    generatedAt: now,
    lastModifiedAt: now,
    events: [], groups: [], coverage: { status: "pending", publishedEventCount: 0, lastSuccessfulArtifactAt: null }, nextCursor: null,
  };
}

async function readCoverageManifest(): Promise<TimelineCoverageManifest> {
  const manifest = await readJsonIfPresent<unknown>(
    TIMELINE_INTERNAL_COVERAGE_PATH,
    COVERAGE_MANIFEST_MAX_BYTES,
  );
  if (manifest !== null && isTimelineCoverageManifest(manifest)) return manifest;
  if (manifest !== null) {
    throw new TimelineStoreError("Timeline coverage manifest was malformed.", "artifact_invalid");
  }
  return {
    schemaVersion: TIMELINE_COVERAGE_SCHEMA_VERSION, generatedAt: new Date(0).toISOString(),
    inventorySha256: sha256(Buffer.from("[]")), sourceArtifacts: [],
    totals: { inventoryRecords: 0, uniqueCompanies: 0, terminalUniqueCompanies: 0, completeCompanies: 0, partialCompanies: 0, failedCompanies: 0, publishedEvents: 0, candidates: 0, unresolvedConflicts: 0, unresolvedDates: 0 },
    companies: [],
  };
}

async function readJsonIfPresent<T>(path: string, maxBytes = COMPANY_ARTIFACT_MAX_BYTES): Promise<T | null> {
  try {
    const metadata = await stat(path);
    if (metadata.size > maxBytes) {
      throw new TimelineStoreError(
        `Timeline artifact exceeded its ${maxBytes}-byte read limit.`,
        "artifact_too_large",
      );
    }
    return JSON.parse(await readFile(path, "utf8")) as T;
  }
  catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function companyArtifactPath(slug: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 120) {
    throw new TimelineStoreError("Timeline company slug was unsafe.", "invalid_company_slug");
  }
  return join(TIMELINE_ROOT, "companies", `${slug}.json`);
}

async function resolveTimelineCompanyById(companyId: string): Promise<TimelineCompanyRef | null> {
  const manifest = await readCoverageManifest();
  const manifestCompany = manifest.companies.find((item) => item.company.id === companyId)?.company;
  if (manifestCompany) return manifestCompany;
  const { getCatalog } = await import("@/lib/seo/catalog");
  const company = getCatalog().companies.find((item) => item.node.entityId === companyId);
  return company ? { id: company.node.entityId, slug: company.slug, name: company.node.label } : null;
}

function buildTimelineMonthGroups(events: readonly PublishedTimelineEvent[]): TimelineMonthGroup[] {
  const years = new Map<number, Map<string, number>>();
  for (const event of events) {
    const year = Number(event.eventDate.slice(0, 4));
    const month = event.eventDate.slice(0, 7);
    const months = years.get(year) ?? new Map<string, number>();
    months.set(month, (months.get(month) ?? 0) + 1);
    years.set(year, months);
  }
  return [...years.entries()].sort(([left], [right]) => right - left).map(([year, months]) => ({
    year,
    months: [...months.entries()].sort(([left], [right]) => right.localeCompare(left)).map(([month, count]) => ({ month, count })),
  }));
}

function comparePublishedEvents(left: PublishedTimelineEvent, right: PublishedTimelineEvent): number {
  return right.eventDate.localeCompare(left.eventDate) || right.id.localeCompare(left.id);
}

function boundedLimit(value: number | undefined): number { return Math.min(Math.max(value ?? DEFAULT_LIMIT, 1), MAX_LIMIT); }
function encodeEventCursor(value: { eventDate: string; id: string }): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decodeEventCursor(value: string | null): { eventDate: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      Object.keys(parsed).length === 2
      && typeof parsed.eventDate === "string"
      && isExactIsoDate(parsed.eventDate)
      && typeof parsed.id === "string"
      && /^[A-Za-z0-9._~:-]{1,180}$/.test(parsed.id)
    ) {
      return { eventDate: parsed.eventDate, id: parsed.id };
    }
  } catch {
    // Fall through to the structured cursor error.
  }
  throw new TimelineStoreError("Timeline event cursor was malformed.", "invalid_cursor");
}

function paginate<T>(items: T[], cursor: string | null | undefined, requestedLimit: number | undefined): { items: T[]; nextCursor: string | null } {
  const limit = boundedLimit(requestedLimit);
  const offset = decodeOffsetCursor(cursor ?? null);
  const page = items.slice(offset, offset + limit);
  return { items: page, nextCursor: offset + page.length < items.length ? Buffer.from(String(offset + page.length)).toString("base64url") : null };
}

function decodeOffsetCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (!/^(?:0|[1-9]\d{0,8})$/.test(decoded)) throw new Error("Malformed offset cursor.");
    return Number(decoded);
  } catch {
    throw new TimelineStoreError("Timeline admin cursor was malformed.", "invalid_cursor");
  }
}

function candidateSummaryFromRow(
  row: Record<string, unknown>,
  sourceIds: string[] = [],
): TimelineCandidateSummary {
  return {
    id: String(row.id), companyId: String(row.company_id), status: String(row.status) as TimelineCandidateSummary["status"],
    proposedDate: stringOrNull(row.proposed_event_date), proposedCategory: stringOrNull(row.proposed_category) as TimelineCandidateSummary["proposedCategory"],
    proposedTitle: stringOrNull(row.proposed_title), proposedSummary: stringOrNull(row.proposed_summary),
    sourceIds, rejectionReason: stringOrNull(row.rejection_reason), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function optionalTimelineDb(providedClient?: TimelineStoreClient): TimelineStoreClient | null {
  if (providedClient) return providedClient;
  // Store functions are imported by jsdom component tests, but service-role
  // credentials must never be instantiated in a browser-like runtime.
  if (typeof window !== "undefined") return null;
  const client = createServerSupabaseClient({ useServiceRole: true });
  return client ? client as unknown as TimelineStoreClient : null;
}

function requireTimelineDb(providedClient?: TimelineStoreClient): TimelineStoreClient {
  const client = optionalTimelineDb(providedClient);
  if (!client) throw new TimelineStoreError("Timeline administration requires Supabase service-role configuration.", "database_not_configured");
  return client;
}

function assertDb<T>(response: DbResponse<T>, operation: string): void {
  if (response.error) throw new TimelineStoreError(`${operation}: ${response.error.message}`, response.error.code ?? "database_error");
}

function normalizePublicEvidenceRole(value: string): "primary" | "supporting" | "conflicting" {
  return value === "primary" || value === "conflicting" ? value : "supporting";
}

function sourceDocumentAdminFromRow(row: Record<string, unknown>): TimelineSourceDocumentAdmin {
  return {
    id: String(row.id),
    originalUrl: String(row.original_url),
    canonicalUrl: String(row.canonical_url),
    sourceType: String(row.source_type) as TimelineSourceType,
    publisher: stringOrNull(row.publisher),
    domain: String(row.domain),
    title: String(row.title),
    author: stringOrNull(row.author),
    publishedAt: stringOrNull(row.published_at),
    fetchedAt: String(row.fetched_at),
    lastSeenAt: String(row.last_seen_at),
    lastValidatedAt: stringOrNull(row.last_validated_at),
    httpStatus: numberOrNull(row.http_status),
    contentHash: String(row.content_hash),
    normalizedText: boundedText(row.normalized_text, 20_000),
    excerpt: boundedText(row.excerpt, 2_000),
    metadata: sanitizeAdminMetadata(row.metadata_json),
    discoveryMethod: String(row.discovery_method),
    sourceQualityTier: Number(row.source_quality_tier) as 1 | 2 | 3,
    attributionStatus: String(row.attribution_status) as TimelineSourceDocumentAdmin["attributionStatus"],
  };
}

interface LiveTimelineCompanyResult {
  available: boolean;
  events: TimelineDatabaseEventBundle[];
  lastModifiedAt: string;
}

interface LiveTimelineEventResult {
  available: boolean;
  companySourceKey: string | null;
  bundle: TimelineDatabaseEventBundle | null;
}

async function overlayLiveTimelineCoverage(
  artifactItems: TimelineCompanyCoverageSummary[],
  client: TimelineStoreClient | null,
): Promise<TimelineCompanyCoverageSummary[]> {
  if (!client) return artifactItems;
  const companiesResponse = await client.from<Record<string, unknown>>("companies").select("id,source_key");
  if (companiesResponse.error && isTimelineMigrationUnavailable(companiesResponse.error)) return artifactItems;
  if (companiesResponse.error) throw dbReadError("resolve Timeline coverage companies", companiesResponse.error);
  const canonicalIdBySourceKey = new Map<string, string>();
  for (const row of companiesResponse.data ?? []) {
    const sourceKey = stringOrNull(row.source_key);
    const id = stringOrNull(row.id);
    if (!sourceKey || !id) continue;
    const current = canonicalIdBySourceKey.get(sourceKey);
    if (!current || id.localeCompare(current) < 0) canonicalIdBySourceKey.set(sourceKey, id);
  }
  const sourceKeyByCanonicalId = new Map([...canonicalIdBySourceKey].map(([sourceKey, id]) => [id, sourceKey]));
  if (!sourceKeyByCanonicalId.size) return artifactItems;

  const [stateResult, coverageResult, invalidationResult, deadLetterResult] = await Promise.all([
    readAllTimelineRows(client, "timeline_company_state", "*"),
    readAllTimelineRows(client, "timeline_source_coverage", "company_id,source_class,status,last_error,updated_at"),
    readAllTimelineRows(client, "timeline_artifact_invalidations", "company_id,status,invalidated_at,processed_at,last_error"),
    readAllTimelineRows(client, "ingestion_dead_letters", "ingestion_task_id,status,resolved_at,task_snapshot_json", (query) => query.eq("status", "open")),
  ]);
  const migrationError = [stateResult, coverageResult, invalidationResult]
    .map((result) => result.error).find((error): error is DbError => Boolean(error));
  if (migrationError && isTimelineMigrationUnavailable(migrationError)) return artifactItems;
  if (migrationError) throw dbReadError("read live Timeline coverage", migrationError);
  if (deadLetterResult.error) throw dbReadError("read open Timeline dead letters", deadLetterResult.error);

  const stateBySourceKey = new Map<string, Record<string, unknown>>();
  for (const row of stateResult.rows) {
    const sourceKey = sourceKeyByCanonicalId.get(String(row.company_id));
    if (sourceKey) stateBySourceKey.set(sourceKey, row);
  }
  const coverageBySourceKey = new Map<string, Partial<Record<string, TimelineSourceCoverageState>>>();
  for (const row of coverageResult.rows) {
    const sourceKey = sourceKeyByCanonicalId.get(String(row.company_id));
    const sourceClass = stringOrNull(row.source_class);
    const sourceStatus = stringOrNull(row.status) as TimelineSourceCoverageState | null;
    if (!sourceKey || !sourceClass || !sourceStatus) continue;
    const current = coverageBySourceKey.get(sourceKey) ?? {};
    current[sourceClass] = sourceStatus;
    coverageBySourceKey.set(sourceKey, current);
  }
  const deadLettersBySourceKey = new Map<string, number>();
  for (const row of deadLetterResult.rows) {
    if (row.status !== "open" || row.resolved_at !== null) continue;
    const task = objectValue(row.task_snapshot_json);
    if (!String(task.platform ?? "").startsWith("timeline_")) continue;
    const sourceKey = sourceKeyByCanonicalId.get(String(task.entity_id));
    if (sourceKey) deadLettersBySourceKey.set(sourceKey, (deadLettersBySourceKey.get(sourceKey) ?? 0) + 1);
  }
  const invalidationsBySourceKey = new Map<string, Record<string, unknown>[]>();
  for (const row of invalidationResult.rows) {
    const sourceKey = sourceKeyByCanonicalId.get(String(row.company_id));
    if (sourceKey) invalidationsBySourceKey.set(sourceKey, [...(invalidationsBySourceKey.get(sourceKey) ?? []), row]);
  }

  return artifactItems.map((item) => {
    const state = stateBySourceKey.get(item.company.id);
    const sourceCoverage = coverageBySourceKey.get(item.company.id)
      ?? objectSourceCoverage(state?.source_coverage)
      ?? item.sourceCoverage;
    return {
      ...item,
      historicalBackfillStatus: (stringOrNull(state?.historical_backfill_status) as TimelineCompanyCoverageSummary["historicalBackfillStatus"] | null)
        ?? item.historicalBackfillStatus,
      historicalBackfillStartedAt: stringOrNull(state?.historical_backfill_started_at) ?? item.historicalBackfillStartedAt,
      historicalBackfillCompletedAt: stringOrNull(state?.historical_backfill_completed_at) ?? item.historicalBackfillCompletedAt,
      lastIncrementalScanAt: stringOrNull(state?.last_incremental_scan_at),
      lastDeepScanAt: stringOrNull(state?.last_deep_scan_at),
      publishedEventCount: numberOrFallback(state?.published_event_count, item.publishedEventCount),
      candidateEventCount: numberOrFallback(state?.candidate_event_count, item.candidateEventCount),
      unresolvedConflictCount: numberOrFallback(state?.unresolved_conflict_count, item.unresolvedConflictCount),
      unresolvedDateCount: numberOrFallback(state?.unresolved_date_count, item.unresolvedDateCount),
      sourceCoverage,
      failedSourceCount: countFailedSources(sourceCoverage),
      deadLetterTaskCount: deadLettersBySourceKey.get(item.company.id) ?? 0,
      cacheStatus: cacheStatusFromInvalidations(invalidationsBySourceKey.get(item.company.id) ?? [], item),
      lastSuccessfulArtifactAt: stringOrNull(state?.last_successful_artifact_at) ?? item.lastSuccessfulArtifactAt,
      lastError: stringOrNull(state?.last_error) ?? item.lastError,
    };
  });
}

async function readAllTimelineRows(
  client: TimelineStoreClient,
  table: string,
  columns: string,
  refine?: (query: DbQuery<Record<string, unknown>>) => DbQuery<Record<string, unknown>>,
): Promise<{ rows: Record<string, unknown>[]; error: DbError | null }> {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < 20_000; offset += 1_000) {
    let query = client.from<Record<string, unknown>>(table).select(columns);
    if (refine) query = refine(query);
    const response = await query.range(offset, offset + 999);
    if (response.error) return { rows: [], error: response.error };
    const page = response.data ?? [];
    rows.push(...page);
    if (page.length < 1_000) return { rows, error: null };
  }
  throw new TimelineStoreError(`Timeline admin table ${table} exceeded its 20,000-row safety bound.`, "database_result_too_large");
}

function cacheStatusFromInvalidations(
  rows: readonly Record<string, unknown>[],
  item: TimelineCompanyCoverageSummary,
): TimelineCompanyCoverageSummary["cacheStatus"] {
  if (rows.some((row) => row.status === "failed")) return "failed";
  if (rows.some((row) => row.status === "processing")) return "building";
  if (rows.some((row) => row.status === "pending")) return "pending";
  return item.lastSuccessfulArtifactAt ? "current" : "missing";
}

function objectSourceCoverage(value: unknown): Partial<Record<string, TimelineSourceCoverageState>> | null {
  if (!isObject(value)) return null;
  const entries = Object.entries(value).filter((entry): entry is [string, TimelineSourceCoverageState] =>
    typeof entry[1] === "string"
    && ["pending", "running", "completed", "no_applicable_source", "no_results", "blocked", "rate_limited", "authentication_required", "failed", "retry_pending"].includes(entry[1])
  );
  return Object.fromEntries(entries);
}

function countFailedSources(coverage: TimelineCompanyCoverageSummary["sourceCoverage"]): number {
  return Object.values(coverage).filter((status) =>
    ["blocked", "rate_limited", "authentication_required", "failed"].includes(status ?? "")
  ).length;
}

function numberOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Request-time overlay for durable publication changes. Static artifacts stay
 * the fast, last-good baseline, while the narrow public database projections
 * make an audited publish/edit/unpublish visible immediately after the local
 * HTTP cache is invalidated. A missing migration is treated as bootstrap mode;
 * every other database error fails closed instead of serving ambiguous state.
 */
async function loadLiveTimelineCompany(
  companySourceKey: string,
  client: TimelineStoreClient | null,
): Promise<LiveTimelineCompanyResult | null> {
  if (!client) return null;
  const companyResponse = await client.from<Record<string, unknown>>("companies")
    .select("id,source_key").eq("source_key", companySourceKey);
  if (companyResponse.error && isTimelineMigrationUnavailable(companyResponse.error)) return null;
  if (companyResponse.error) throw dbReadError("resolve live timeline company", companyResponse.error);
  const databaseCompanyIds = (companyResponse.data ?? []).map((row) => String(row.id));
  if (!databaseCompanyIds.length) return null;

  const eventsResponse = await client.from<Record<string, unknown>>("published_timeline_events")
    .select("*").in("primary_company_id", databaseCompanyIds);
  if (eventsResponse.error && isTimelineMigrationUnavailable(eventsResponse.error)) return null;
  if (eventsResponse.error) throw dbReadError("read live published timeline events", eventsResponse.error);
  const eventRows = eventsResponse.data ?? [];
  if (!eventRows.length) {
    return { available: true, events: [], lastModifiedAt: new Date(0).toISOString() };
  }

  const eventIds = eventRows.map((row) => String(row.id));
  const [sourcesResponse, postsResponse] = await Promise.all([
    client.from<Record<string, unknown>>("published_timeline_source_metadata")
      .select("*").in("event_id", eventIds),
    client.from<Record<string, unknown>>("published_timeline_post_metadata")
      .select("*").in("event_id", eventIds),
  ]);
  const projectionErrors: Array<[string, DbError | null]> = [
    ["read live published timeline evidence", sourcesResponse.error],
    ["read live published timeline posts", postsResponse.error],
  ];
  for (const [operation, error] of projectionErrors) {
    if (error && !isTimelineMigrationUnavailable(error)) throw dbReadError(operation, error);
  }
  if (projectionErrors.some(([, error]) => error !== null)) return null;
  const sourcesByEvent = groupRows(sourcesResponse.data ?? [], "event_id");
  const postsByEvent = groupRows(postsResponse.data ?? [], "event_id");
  const events = eventRows.map((row) => timelineDatabaseEventBundleFromRows(
    row,
    sourcesByEvent.get(String(row.id)) ?? [],
    postsByEvent.get(String(row.id)) ?? [],
  ));
  const lastModifiedAt = events.reduce(
    (latest, item) => item.updatedAt > latest ? item.updatedAt : latest,
    new Date(0).toISOString(),
  );
  return { available: true, events, lastModifiedAt };
}

async function loadLiveTimelineEvent(
  publicEventId: string,
  client: TimelineStoreClient | null,
): Promise<LiveTimelineEventResult | null> {
  if (!client) return null;
  const databaseEventId = publicEventId.slice("tldb-".length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(databaseEventId)) {
    return { available: true, companySourceKey: null, bundle: null };
  }
  const eventResponse = await client.from<Record<string, unknown>>("published_timeline_events")
    .select("*").eq("id", databaseEventId).maybeSingle();
  if (eventResponse.error && isTimelineMigrationUnavailable(eventResponse.error)) return null;
  if (eventResponse.error) throw dbReadError("read live published timeline event", eventResponse.error);
  if (!eventResponse.data) return { available: true, companySourceKey: null, bundle: null };

  const [sourceResponse, postResponse, companyResponse] = await Promise.all([
    client.from<Record<string, unknown>>("published_timeline_source_metadata")
      .select("*").eq("event_id", databaseEventId),
    client.from<Record<string, unknown>>("published_timeline_post_metadata")
      .select("*").eq("event_id", databaseEventId),
    client.from<Record<string, unknown>>("companies")
      .select("source_key").eq("id", String(eventResponse.data.primary_company_id)).maybeSingle(),
  ]);
  const projectionErrors: Array<[string, DbError | null]> = [
    ["read live published timeline event evidence", sourceResponse.error],
    ["read live published timeline event posts", postResponse.error],
    ["resolve live timeline event company", companyResponse.error],
  ];
  for (const [operation, error] of projectionErrors) {
    if (error && !isTimelineMigrationUnavailable(error)) throw dbReadError(operation, error);
  }
  if (projectionErrors.some(([, error]) => error !== null)) return null;
  const companySourceKey = stringOrNull(companyResponse.data?.source_key);
  if (!companySourceKey) {
    throw new TimelineStoreError("Live timeline event company has no canonical source key.", "database_contract_error");
  }
  return {
    available: true,
    companySourceKey,
    bundle: timelineDatabaseEventBundleFromRows(
      eventResponse.data,
      sourceResponse.data ?? [],
      postResponse.data ?? [],
    ),
  };
}

function mergeLiveDatabaseEvents(
  artifactEvents: readonly PublishedTimelineEvent[],
  databaseEvents: readonly TimelineDatabaseEventBundle[],
  companyId: string,
): PublishedTimelineEvent[] {
  const merged = artifactEvents.filter((event) => !event.id.startsWith("tldb-")).map((event) => ({ ...event }));
  for (const database of databaseEvents) {
    const duplicateIndex = merged.findIndex((event) => samePublicTimelineEvent(event, database.event, companyId));
    if (duplicateIndex < 0) {
      merged.push(database.event);
      continue;
    }
    const current = merged[duplicateIndex]!;
    const sourcePreview = dedupeSourcePreviews([...current.sourcePreview, ...database.event.sourcePreview]);
    merged[duplicateIndex] = {
      ...database.event,
      isMajor: current.isMajor || database.event.isMajor,
      hasConflict: current.hasConflict || database.event.hasConflict,
      conflictSummary: current.conflictSummary ?? database.event.conflictSummary,
      evidenceCount: Math.max(current.evidenceCount, database.event.evidenceCount, sourcePreview.length),
      sourcePreview: sourcePreview.slice(0, 3),
    };
  }
  return merged.sort(comparePublishedEvents);
}

function samePublicTimelineEvent(
  left: PublishedTimelineEvent,
  right: PublishedTimelineEvent,
  companyId: string,
): boolean {
  return shouldMergeTimelineEvents(
    {
      id: left.id, companyId, category: left.category, eventDate: left.eventDate, title: left.title,
      sourceIds: left.sourcePreview.map((source) => source.id), sourceUrls: left.sourcePreview.map((source) => source.url),
    },
    {
      id: right.id, companyId, category: right.category, eventDate: right.eventDate, title: right.title,
      sourceIds: right.sourcePreview.map((source) => source.id), sourceUrls: right.sourcePreview.map((source) => source.url),
    },
  );
}

function dedupeSourcePreviews(
  sources: ReadonlyArray<PublishedTimelineEvent["sourcePreview"][number]>,
): PublishedTimelineEvent["sourcePreview"] {
  const byUrl = new Map<string, PublishedTimelineEvent["sourcePreview"][number]>();
  for (const source of sources) {
    const prior = byUrl.get(source.url);
    if (!prior || evidenceRoleRank(source.evidenceRole) < evidenceRoleRank(prior.evidenceRole)) {
      byUrl.set(source.url, source);
    }
  }
  return [...byUrl.values()].sort((left, right) =>
    evidenceRoleRank(left.evidenceRole) - evidenceRoleRank(right.evidenceRole) || left.id.localeCompare(right.id)
  );
}

function evidenceRoleRank(role: "primary" | "supporting" | "conflicting"): number {
  return role === "primary" ? 0 : role === "supporting" ? 1 : 2;
}

function groupRows(
  rows: readonly Record<string, unknown>[],
  key: string,
): Map<string, Record<string, unknown>[]> {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const value = String(row[key] ?? "");
    grouped.set(value, [...(grouped.get(value) ?? []), row]);
  }
  return grouped;
}

function isTimelineMigrationUnavailable(error: DbError): boolean {
  return ["42P01", "PGRST205", "PGRST204"].includes(String(error.code ?? ""))
    || /(?:companies|published_timeline_(?:events|source_metadata|post_metadata)|timeline_(?:company_state|source_coverage|artifact_invalidations)).*(?:not found|does not exist|schema cache)/i.test(error.message);
}

function dbReadError(operation: string, error: DbError): TimelineStoreError {
  return new TimelineStoreError(`${operation}: ${error.message}`, error.code ?? "database_error");
}

function isCompanyTimelineArtifact(value: unknown): value is CompanyTimelineArtifact {
  if (!isObject(value) || value.schemaVersion !== TIMELINE_ARTIFACT_SCHEMA_VERSION) return false;
  if (!isTimelineCompanyRef(value.company) || !isIsoTimestamp(value.generatedAt) || !isIsoTimestamp(value.lastModifiedAt)) {
    return false;
  }
  if (!Array.isArray(value.events) || !value.events.every(isPublishedTimelineEvent)) return false;
  if (!Array.isArray(value.groups) || !value.groups.every(isTimelineMonthGroup)) return false;
  if (!isPublicTimelineCoverage(value.coverage)) return false;
  return value.nextCursor === null || typeof value.nextCursor === "string";
}

function isCompanyTimelineEventDetailArtifact(
  value: unknown,
): value is CompanyTimelineEventDetailArtifact {
  if (!isObject(value) || value.schemaVersion !== TIMELINE_EVENT_DETAIL_SCHEMA_VERSION) return false;
  if (!isTimelineCompanyRef(value.company) || !isIsoTimestamp(value.generatedAt) || !isIsoTimestamp(value.lastModifiedAt)) {
    return false;
  }
  if (!isObject(value.event) || !isPublishedTimelineEvent(value.event)) return false;
  if (!Array.isArray(value.event.evidence) || value.event.evidence.length < 1) return false;
  if (!value.event.evidence.every(isTimelineEvidenceDetail)) return false;
  return Array.isArray(value.event.posts) && value.event.posts.every(isTimelinePostEvidence);
}

function isTimelineCoverageManifest(value: unknown): value is TimelineCoverageManifest {
  if (!isObject(value) || value.schemaVersion !== TIMELINE_COVERAGE_SCHEMA_VERSION) return false;
  if (!isIsoTimestamp(value.generatedAt) || !Array.isArray(value.companies)) return false;
  return value.companies.every((item) =>
    isObject(item)
    && isTimelineCompanyRef(item.company)
    && typeof item.artifactPath === "string"
    && typeof item.publishedEventCount === "number"
    && typeof item.candidateEventCount === "number"
  );
}

function isPublishedTimelineEvent(value: unknown): value is PublishedTimelineEvent {
  if (!isObject(value)) return false;
  if (
    typeof value.id !== "string"
    || !/^[A-Za-z0-9._~:-]{1,180}$/.test(value.id)
    || typeof value.eventDate !== "string"
    || !isExactIsoDate(value.eventDate)
    || typeof value.eventDateType !== "string"
    || !(TIMELINE_EVENT_DATE_TYPES as readonly string[]).includes(value.eventDateType)
    || typeof value.title !== "string"
    || value.title.trim().length < 3
    || value.title.length > 180
    || typeof value.summary !== "string"
    || value.summary.trim().length < 8
    || !isOneConciseSentence(value.summary)
    || typeof value.category !== "string"
    || !(TIMELINE_CATEGORIES as readonly string[]).includes(value.category)
    || typeof value.isMajor !== "boolean"
    || typeof value.hasConflict !== "boolean"
    || !(value.conflictSummary === null || (typeof value.conflictSummary === "string" && value.conflictSummary.length <= 500))
    || !Number.isInteger(value.evidenceCount)
    || Number(value.evidenceCount) < 1
  ) return false;
  if (
    (value.hasConflict && (typeof value.conflictSummary !== "string" || value.conflictSummary.trim().length === 0))
    || (!value.hasConflict && value.conflictSummary !== null)
  ) return false;
  return Array.isArray(value.sourcePreview)
    && value.sourcePreview.length > 0
    && value.sourcePreview.length <= 3
    && value.sourcePreview.every(isTimelineSourcePreview);
}

function isTimelineSourcePreview(value: unknown): boolean {
  return isObject(value)
    && typeof value.id === "string"
    && /^[A-Za-z0-9._~:-]{1,180}$/.test(value.id)
    && typeof value.title === "string"
    && value.title.trim().length > 0
    && value.title.length <= 300
    && (value.publisher === null || (typeof value.publisher === "string" && value.publisher.length <= 160))
    && typeof value.domain === "string"
    && value.domain.trim().length > 0
    && value.domain.length <= 253
    && typeof value.sourceType === "string"
    && PUBLIC_TIMELINE_SOURCE_TYPES.has(value.sourceType)
    && (value.publishedAt === null || isExactDateOrTimestamp(value.publishedAt))
    && ["primary", "supporting", "conflicting"].includes(String(value.evidenceRole))
    && isHttpUrl(value.url)
    && value.url.length <= 2_048;
}

function isTimelineEvidenceDetail(value: unknown): boolean {
  if (!isTimelineSourcePreview(value) || !isObject(value)) return false;
  return (value.publicationDate === null || isExactDateOrTimestamp(value.publicationDate))
    && (value.excerpt === null || (typeof value.excerpt === "string" && value.excerpt.length <= 2_000))
    && (value.sourceEventDate === null || (typeof value.sourceEventDate === "string" && isExactIsoDate(value.sourceEventDate)))
    && typeof value.isConflicting === "boolean"
    && (
      (value.isConflicting && typeof value.conflictDescription === "string" && value.conflictDescription.trim().length > 0)
      || (!value.isConflicting && value.conflictDescription === null)
    );
}

function isTimelinePostEvidence(value: unknown): boolean {
  if (!isObject(value)) return false;
  return typeof value.id === "string"
    && /^[A-Za-z0-9._~:-]{1,180}$/.test(value.id)
    && typeof value.platform === "string"
    && value.platform.trim().length > 0
    && (value.account === null || (typeof value.account === "string" && value.account.length <= 160))
    && typeof value.postDate === "string"
    && isExactIsoDate(value.postDate)
    && (value.excerpt === null || (typeof value.excerpt === "string" && value.excerpt.length <= 2_000))
    && isHttpUrl(value.url)
    && value.url.length <= 2_048
    && isObject(value.metrics)
    && Object.keys(value.metrics).length <= 64
    && Object.entries(value.metrics).every(([key, metric]) =>
      /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)
      && (metric === null || (typeof metric === "number" && Number.isFinite(metric)))
    )
    && ["primary", "supporting", "conflicting"].includes(String(value.evidenceRole));
}

function isTimelineMonthGroup(value: unknown): boolean {
  return isObject(value)
    && Number.isInteger(value.year)
    && Number(value.year) >= 1900
    && Number(value.year) <= 9999
    && Array.isArray(value.months)
    && value.months.every((month) =>
      isObject(month)
      && typeof month.month === "string"
      && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(month.month)
      && Number.isInteger(month.count)
      && Number(month.count) > 0
    );
}

function isPublicTimelineCoverage(value: unknown): value is PublicTimelineCoverage {
  return isObject(value)
    && ["pending", "in_progress", "complete", "partial", "failed"].includes(String(value.status))
    && Number.isInteger(value.publishedEventCount)
    && Number(value.publishedEventCount) >= 0
    && (value.lastSuccessfulArtifactAt === null || isIsoTimestamp(value.lastSuccessfulArtifactAt));
}

function isTimelineCompanyRef(value: unknown): value is TimelineCompanyRef {
  return isObject(value)
    && typeof value.id === "string"
    && value.id.length > 0
    && typeof value.slug === "string"
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug)
    && typeof value.name === "string"
    && value.name.trim().length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(new Date(value).getTime());
}

/**
 * Source publication provenance may be an exact calendar day when the source
 * exposes no trustworthy time-of-day. The artifact contract intentionally
 * preserves that precision instead of fabricating midnight UTC.
 */
function isExactDateOrTimestamp(value: unknown): value is string {
  return (typeof value === "string" && isExactIsoDate(value)) || isIsoTimestamp(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function boundedText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" ? value.slice(0, maxLength) : null;
}

function sanitizeAdminMetadata(value: unknown, depth = 0): Record<string, unknown> {
  if (!isObject(value) || depth > 4) return {};
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (/(authorization|bearer|cookie|password|secret|session|token|api[_-]?key|service[_-]?role)/i.test(key)) {
      sanitized[key] = "[redacted]";
    } else {
      sanitized[key] = sanitizeAdminMetadataValue(item, depth + 1);
    }
  }
  return sanitized;
}

function sanitizeAdminMetadataValue(value: unknown, depth: number): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 2_000);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizeAdminMetadataValue(entry, depth + 1));
  }
  if (isObject(value)) return sanitizeAdminMetadata(value, depth);
  return null;
}

function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function stringOrNull(value: unknown): string | null { return typeof value === "string" ? value : null; }
function numberOrNull(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function nullableObject(value: unknown): Record<string, unknown> | null { const object = objectValue(value); return Object.keys(object).length ? object : null; }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
