import type { TimelineCategory, TimelineEventDateType, TimelineSourceType } from "./contracts";

export const TIMELINE_CLASSIFIER_VERSION = "timeline-classifier-rules-2026-08-02.v4" as const;
export const TIMELINE_EXTRACTION_VERSION = "timeline-extraction-2026-08-02.v4" as const;

export interface TimelineCompanyIdentity {
  id: string;
  slug: string;
  name: string;
  aliases: string[];
  websiteUrl: string | null;
  founderNames: string[];
}

export interface TimelineClassificationSource {
  id: string;
  url: string;
  /** URL requested before redirects. It is retained as provenance, not trusted as canonical. */
  originalUrl?: string;
  /** Safely resolved same-site canonical URL, or an archive capture URL for archived pages. */
  canonicalUrl?: string | null;
  title: string | null;
  publisher: string | null;
  author?: string | null;
  sourceType: TimelineSourceType;
  platform: string | null;
  publicationTimestamp: string | null;
  updatedTimestamp?: string | null;
  publicationDatePrecision: "exact" | "day" | "unknown";
  text: string;
  evidenceExcerpt: string;
  sourceQualityTier: 1 | 2 | 3;
  attributionStatus: "verified" | "needs_review" | "rejected";
  linkStatus: "verified" | "unchecked" | "blocked" | "invalid" | null;
  topic: string | null;
  authorRelationship: "company" | "founder" | "third_party" | "unknown";
  /** Bounded page/capture provenance. Source normalization recursively redacts secrets. */
  metadata?: Record<string, unknown>;
  httpStatus?: number | null;
}

const DIRECT_OCCURRENCE_SOURCE_TYPES = new Set<TimelineSourceType>([
  "github_repository",
  "github_release",
  "product_hunt",
  "research_publication",
  "patent",
  "regulatory_filing",
]);

/**
 * Classify the exact source timestamp by what it actually proves. A news or
 * other third-party page timestamp proves only that page's publication date;
 * it is not silently promoted to the company's announcement or event date.
 * Direct platform records whose publication is itself the event (for example
 * a GitHub release) prove an occurrence date, while direct company/founder
 * posts prove an announcement date.
 */
export function timelineEventDateTypeForSource(
  source: Pick<TimelineClassificationSource, "authorRelationship" | "sourceType">,
): TimelineEventDateType {
  if (DIRECT_OCCURRENCE_SOURCE_TYPES.has(source.sourceType)) return "occurrence_date";
  if (source.authorRelationship === "third_party" || source.authorRelationship === "unknown") {
    return "publication_date";
  }
  return "announcement_date";
}

export interface TimelineClassificationInput {
  company: TimelineCompanyIdentity;
  sources: TimelineClassificationSource[];
  existingEventKeys: string[];
}

export interface TimelineCandidateEvidenceClaim {
  sourceId: string;
  supports: Array<"title" | "summary" | "eventDate" | "quantitativeClaim">;
  excerpt: string;
}

export interface TimelineCandidateProposal {
  isMeaningfulEvent: true;
  companyId: string;
  category: TimelineCategory;
  title: string;
  summary: string;
  eventDate: string;
  eventDateType: TimelineEventDateType;
  isMajor: boolean;
  importanceScore: number;
  entityIds: string[];
  sourceIds: string[];
  mergeKey: string;
  evidence: TimelineCandidateEvidenceClaim[];
  conflicts: TimelineFieldConflict[];
  classifierVersion: string;
  extractionVersion: string;
}

export interface TimelineFieldConflict {
  field: string;
  selectedValue: string | null;
  claims: Array<{
    value: string;
    sourceId: string;
    sourceQualityTier: 1 | 2 | 3;
  }>;
  description: string;
}

export interface TimelineRejectedCandidate {
  isMeaningfulEvent: false;
  companyId: string;
  sourceIds: string[];
  reason:
    | "company_match_uncertain"
    | "not_meaningful"
    | "exact_date_unsupported"
    | "source_not_direct"
    | "source_not_verified"
    | "unsupported_claim"
    | "duplicate"
    | "irrelevant_founder_activity";
  classifierVersion: string;
  extractionVersion: string;
}

export type TimelineClassifierResult = TimelineCandidateProposal | TimelineRejectedCandidate;

/**
 * Providers receive inert structured data and return JSON only. They have no
 * tool, secret, network, filesystem or instruction channel; source text is
 * explicitly untrusted evidence, never an instruction.
 */
export interface TimelineClassificationProvider {
  readonly id: string;
  readonly version: string;
  classify(input: Readonly<TimelineClassificationInput>): Promise<unknown>;
}
