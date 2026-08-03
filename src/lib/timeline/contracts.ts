/**
 * Stable, public-facing Company Timeline contracts.
 *
 * Keep ingestion-only fields (model versions, raw text, prompts, review notes,
 * and numeric confidence) out of these shapes. Public APIs and prebuilt
 * artifacts share these contracts so a database fallback cannot accidentally
 * expose more than the cached representation.
 */

export const TIMELINE_ARTIFACT_SCHEMA_VERSION = "company-timeline.v1" as const;
export const TIMELINE_EVENT_DETAIL_SCHEMA_VERSION = "company-timeline-event.v1" as const;
export const TIMELINE_COVERAGE_SCHEMA_VERSION = "company-timeline-coverage.v1" as const;
export const TIMELINE_PUBLIC_INDEX_SCHEMA_VERSION = "company-timeline-public-index.v1" as const;

export const TIMELINE_CATEGORIES = [
  "founded",
  "accelerator",
  "funding",
  "product_launch",
  "product_update",
  "traction_milestone",
  "revenue_milestone",
  "user_milestone",
  "customer",
  "partnership",
  "pricing",
  "business_model",
  "hiring",
  "leadership",
  "founder",
  "geographic_expansion",
  "open_source",
  "github",
  "research",
  "patent",
  "regulatory",
  "legal",
  "press",
  "award",
  "acquisition",
  "merger",
  "exit",
  "pivot",
  "shutdown",
  "website",
  "other",
] as const;

export type TimelineCategory = (typeof TIMELINE_CATEGORIES)[number];

export const TIMELINE_EVENT_DATE_TYPES = [
  "occurrence_date",
  "announcement_date",
  "publication_date",
] as const;

export type TimelineEventDateType = (typeof TIMELINE_EVENT_DATE_TYPES)[number];
export type TimelineEvidenceRole = "primary" | "supporting" | "conflicting";

export type TimelineSourceType =
  | "company_page"
  | "company_blog"
  | "press_release"
  | "changelog"
  | "news_article"
  | "accelerator_profile"
  | "investor_page"
  | "customer_page"
  | "partner_page"
  | "founder_post"
  | "company_post"
  | "product_hunt"
  | "github_repository"
  | "github_release"
  | "research_publication"
  | "patent"
  | "regulatory_filing"
  | "archived_page"
  | "video"
  | "podcast"
  | "other";

export interface TimelineCompanyRef {
  id: string;
  slug: string;
  name: string;
}

export interface TimelineSourcePreview {
  id: string;
  title: string;
  publisher: string | null;
  domain: string;
  sourceType: TimelineSourceType;
  publishedAt: string | null;
  evidenceRole: TimelineEvidenceRole;
  url: string;
}

export interface PublishedTimelineEvent {
  id: string;
  eventDate: string;
  eventDateType: TimelineEventDateType;
  title: string;
  summary: string;
  category: TimelineCategory;
  isMajor: boolean;
  hasConflict: boolean;
  conflictSummary: string | null;
  evidenceCount: number;
  sourcePreview: TimelineSourcePreview[];
}

export interface TimelineMonthGroup {
  /** Four-digit calendar year. */
  year: number;
  months: Array<{
    /** ISO calendar month, e.g. `2026-03`. */
    month: string;
    count: number;
  }>;
}

export type TimelineCoverageStatus = "pending" | "in_progress" | "complete" | "partial" | "failed";

export interface PublicTimelineCoverage {
  status: TimelineCoverageStatus;
  publishedEventCount: number;
  lastSuccessfulArtifactAt: string | null;
}

export interface TimelineCacheMetadata {
  etag: string;
  generatedAt: string;
  lastModifiedAt: string;
  maxAgeSeconds: number;
  staleWhileRevalidateSeconds: number;
}

export interface CompanyTimelineArtifact {
  schemaVersion: typeof TIMELINE_ARTIFACT_SCHEMA_VERSION;
  company: TimelineCompanyRef;
  generatedAt: string;
  lastModifiedAt: string;
  events: PublishedTimelineEvent[];
  groups: TimelineMonthGroup[];
  coverage: PublicTimelineCoverage;
  nextCursor: string | null;
}

export interface TimelinePostEvidence {
  id: string;
  platform: string;
  account: string | null;
  postDate: string;
  excerpt: string | null;
  url: string;
  metrics: Record<string, number | null>;
  evidenceRole: TimelineEvidenceRole;
}

export interface TimelineEvidenceDetail extends TimelineSourcePreview {
  publicationDate: string | null;
  excerpt: string | null;
  sourceEventDate: string | null;
  isConflicting: boolean;
  conflictDescription: string | null;
}

export interface PublishedTimelineEventDetail extends PublishedTimelineEvent {
  evidence: TimelineEvidenceDetail[];
  posts: TimelinePostEvidence[];
}

export interface CompanyTimelineEventDetailArtifact {
  schemaVersion: typeof TIMELINE_EVENT_DETAIL_SCHEMA_VERSION;
  company: TimelineCompanyRef;
  event: PublishedTimelineEventDetail;
  generatedAt: string;
  lastModifiedAt: string;
}

export interface ListPublishedTimelineEventsInput {
  companyId: string;
  from?: string | null;
  to?: string | null;
  categories?: readonly TimelineCategory[];
  cursor?: string | null;
  limit?: number;
}

export interface ListPublishedTimelineEventsResult {
  company: TimelineCompanyRef;
  events: PublishedTimelineEvent[];
  groups: TimelineMonthGroup[];
  coverage: PublicTimelineCoverage;
  nextCursor: string | null;
  cache: TimelineCacheMetadata;
}

export type TimelineCandidateStatus =
  | "pending"
  | "processing"
  | "needs_review"
  | "accepted"
  | "rejected"
  | "merged";

export type TimelineBackfillStatus = "pending" | "running" | "completed" | "partial" | "failed";
export type TimelineArtifactCacheStatus = "current" | "pending" | "building" | "failed" | "missing";

export type TimelineSourceCoverageState =
  | "pending"
  | "running"
  | "completed"
  | "no_applicable_source"
  | "no_results"
  | "blocked"
  | "rate_limited"
  | "authentication_required"
  | "failed"
  | "retry_pending";

export interface TimelineCompanyCoverageSummary {
  company: TimelineCompanyRef;
  historicalBackfillStatus: TimelineBackfillStatus;
  historicalBackfillStartedAt: string | null;
  historicalBackfillCompletedAt: string | null;
  lastIncrementalScanAt: string | null;
  lastDeepScanAt: string | null;
  publishedEventCount: number;
  candidateEventCount: number;
  unresolvedConflictCount: number;
  unresolvedDateCount: number;
  failedSourceCount: number;
  deadLetterTaskCount: number;
  cacheStatus: TimelineArtifactCacheStatus;
  sourceCoverage: Partial<Record<string, TimelineSourceCoverageState>>;
  lastSuccessfulArtifactAt: string | null;
  lastError: string | null;
}

export interface TimelineCandidateSummary {
  id: string;
  companyId: string;
  status: TimelineCandidateStatus;
  proposedDate: string | null;
  proposedCategory: TimelineCategory | null;
  proposedTitle: string | null;
  proposedSummary: string | null;
  sourceIds: string[];
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineCandidateConflict {
  field: string;
  selectedValue: string | null;
  alternateClaims: Array<{
    value: string;
    sourceId: string;
    sourceQualityTier: 1 | 2 | 3;
  }>;
  description: string;
}

export interface TimelineCandidateDetail extends TimelineCandidateSummary {
  proposedImportance: number | null;
  proposedMergeKey: string | null;
  sources: TimelineEvidenceDetail[];
  potentialDuplicates: Array<{
    eventId: string;
    title: string;
    eventDate: string;
    category: TimelineCategory;
    deterministicMatchReasons: string[];
  }>;
  conflicts: TimelineCandidateConflict[];
  classifierVersion: string;
  extractionVersion: string;
}

export interface TimelineSourceDocumentAdmin {
  id: string;
  originalUrl: string;
  canonicalUrl: string;
  sourceType: TimelineSourceType;
  publisher: string | null;
  domain: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  fetchedAt: string;
  lastSeenAt: string;
  lastValidatedAt: string | null;
  httpStatus: number | null;
  contentHash: string;
  normalizedText: string | null;
  excerpt: string | null;
  metadata: Record<string, unknown>;
  discoveryMethod: string;
  sourceQualityTier: 1 | 2 | 3;
  attributionStatus: "verified" | "needs_review" | "rejected";
}

export interface TimelineAdminAuditEntry {
  id: string;
  actorId: string;
  actorEmail: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  createdAt: string;
}

export interface TimelineAdminEventDetail {
  event: PublishedTimelineEvent & {
    companyId: string;
    status: "candidate" | "processing" | "needs_review" | "published" | "rejected" | "superseded" | "merged";
    importanceScore: number;
    eventKey: string;
    publishedAt: string | null;
    classifierVersion: string | null;
    extractionVersion: string | null;
  };
  evidence: TimelineEvidenceDetail[];
  posts: TimelinePostEvidence[];
  auditHistory: TimelineAdminAuditEntry[];
}

export interface ListTimelineCoverageInput {
  q?: string | null;
  status?: TimelineBackfillStatus | null;
  cursor?: string | null;
  limit?: number;
}

export interface ListTimelineCoverageResult {
  items: TimelineCompanyCoverageSummary[];
  nextCursor: string | null;
}

export interface ListTimelineCandidatesInput {
  q?: string | null;
  companyId?: string | null;
  status?: TimelineCandidateStatus | null;
  cursor?: string | null;
  limit?: number;
}

export interface ListTimelineCandidatesResult {
  items: TimelineCandidateSummary[];
  nextCursor: string | null;
}

export type TimelineAdminEventAction =
  | { type: "publish"; eventId: string; reason: string }
  | { type: "reject"; eventId: string; reason: string }
  | { type: "unpublish"; eventId: string; reason: string }
  | { type: "re_evaluate"; eventId: string; reason: string }
  | { type: "edit"; eventId: string; patch: Partial<Pick<PublishedTimelineEvent, "title" | "summary" | "category" | "eventDate" | "eventDateType" | "isMajor">>; reason: string }
  | { type: "merge"; eventId: string; sourceEventIds: string[]; reason: string }
  | { type: "split"; eventId: string; evidenceIds: string[]; reason: string }
  | { type: "add_conflict_note"; eventId: string; note: string; reason: string }
  | { type: "resolve_conflict"; eventId: string; resolution: string; reason: string }
  | { type: "attach_evidence"; eventId: string; sourceDocumentId: string; evidenceRole: TimelineEvidenceRole; reason: string }
  | { type: "remove_evidence"; eventId: string; sourceDocumentId: string; reason: string };

export type TimelineAdminCompanyAction =
  | { type: "rerun_discovery"; companyId: string }
  | { type: "rerun_source"; companyId: string; sourceClass: string }
  | { type: "reclassify"; companyId: string }
  | { type: "rebuild_artifact"; companyId: string };

export type TimelineAdminCandidateAction =
  | { type: "publish_candidate"; candidateId: string; reason: string }
  | { type: "reject_candidate"; candidateId: string; reason: string }
  | { type: "merge_candidate"; candidateId: string; targetEventId: string; reason: string };

export interface TimelineAdminAuditActor {
  id: string;
  email?: string | null;
}

export interface TimelineAdminActionResult {
  auditId: string;
  affectedEventIds: string[];
  cacheInvalidated: boolean;
}

export interface TimelineArtifactInvalidation {
  companyId: string;
  reason: string;
  invalidatedAt: string;
}

export interface TimelineCoverageManifestCompany {
  company: TimelineCompanyRef;
  artifactPath: string;
  artifactSha256: string;
  status: TimelineCoverageStatus;
  sourceCoverage: Partial<Record<string, TimelineSourceCoverageState>>;
  publishedEventCount: number;
  candidateEventCount: number;
  unresolvedConflictCount: number;
  unresolvedDateCount: number;
  lastSuccessfulArtifactAt: string | null;
  lastError: string | null;
}

export interface TimelineCoverageManifest {
  schemaVersion: typeof TIMELINE_COVERAGE_SCHEMA_VERSION;
  generatedAt: string;
  inventorySha256: string;
  sourceArtifacts: Array<{ path: string; sha256: string }>;
  totals: {
    /** Batch-scoped graph rows read before canonical-entity deduplication. */
    inventoryRecords: number;
    /** Canonical entity IDs after cross-batch evidence has been unioned. */
    uniqueCompanies: number;
    terminalUniqueCompanies: number;
    completeCompanies: number;
    partialCompanies: number;
    failedCompanies: number;
    publishedEvents: number;
    candidates: number;
    unresolvedConflicts: number;
    unresolvedDates: number;
  };
  companies: TimelineCoverageManifestCompany[];
}

/**
 * Deliberately minimal metadata that may be served directly by the static
 * host. Operational coverage, candidates, failures, and source-class state
 * belong only in the internal coverage manifest and protected admin APIs.
 */
export interface TimelinePublicIndex {
  schemaVersion: typeof TIMELINE_PUBLIC_INDEX_SCHEMA_VERSION;
  generatedAt: string;
  companyCount: number;
  publishedEventCount: number;
}
