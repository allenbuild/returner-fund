import { z } from "zod";
import {
  TIMELINE_CATEGORIES,
  TIMELINE_EVENT_DATE_TYPES,
  type TimelineCategory,
} from "./contracts";
import {
  timelineEventDateTypeForSource,
  type TimelineCandidateProposal,
  type TimelineClassificationInput,
  type TimelineClassifierResult,
} from "./domain";
import { canonicalizeSourceUrl } from "./source-document";

const evidenceClaimSchema = z.object({
  sourceId: z.string().min(1).max(200),
  supports: z.array(z.enum(["title", "summary", "eventDate", "quantitativeClaim"])).min(1),
  excerpt: z.string().min(1).max(800),
}).strict();

const conflictSchema = z.object({
  field: z.string().min(1).max(80),
  selectedValue: z.string().max(500).nullable(),
  claims: z.array(z.object({
    value: z.string().min(1).max(500),
    sourceId: z.string().min(1).max(200),
    sourceQualityTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }).strict()).min(2),
  description: z.string().min(1).max(500),
}).strict();

const acceptedSchema = z.object({
  isMeaningfulEvent: z.literal(true),
  companyId: z.string().min(1).max(200),
  category: z.enum(TIMELINE_CATEGORIES),
  title: z.string().min(3).max(180),
  summary: z.string().min(8).max(500),
  eventDate: z.string(),
  eventDateType: z.enum(TIMELINE_EVENT_DATE_TYPES),
  isMajor: z.boolean(),
  importanceScore: z.number().int().min(0).max(100),
  entityIds: z.array(z.string().min(1).max(200)),
  sourceIds: z.array(z.string().min(1).max(200)).min(1),
  mergeKey: z.string().min(1).max(300),
  evidence: z.array(evidenceClaimSchema).min(1),
  conflicts: z.array(conflictSchema),
  classifierVersion: z.string().min(1).max(120),
  extractionVersion: z.string().min(1).max(120),
}).strict();

const rejectedSchema = z.object({
  isMeaningfulEvent: z.literal(false),
  companyId: z.string().min(1).max(200),
  sourceIds: z.array(z.string().min(1).max(200)),
  reason: z.enum([
    "company_match_uncertain", "not_meaningful", "exact_date_unsupported",
    "source_not_direct", "source_not_verified", "unsupported_claim", "duplicate",
    "irrelevant_founder_activity",
  ]),
  classifierVersion: z.string().min(1).max(120),
  extractionVersion: z.string().min(1).max(120),
}).strict();

const classifierResultSchema = z.discriminatedUnion("isMeaningfulEvent", [acceptedSchema, rejectedSchema]);

export interface CandidateValidationResult {
  valid: boolean;
  errors: string[];
}

export function isExactIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isoDateFromExactTimestamp(value: string | null): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return isExactIsoDate(value) ? value : null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
}

export function isOneConciseSentence(value: string): boolean {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 500 || !/[.!?]$/.test(normalized)) return false;
  const withoutCommonAbbreviations = normalized.replace(/\b(?:e\.g|i\.e|U\.S|Inc|Ltd|Dr|Mr|Ms)\./g, (match) => match.replace(/\./g, ""));
  return (withoutCommonAbbreviations.match(/[.!?](?=\s|$)/g) ?? []).length === 1;
}

export function validateTimelineCandidate(
  candidate: TimelineCandidateProposal,
  input: TimelineClassificationInput,
): CandidateValidationResult {
  const errors: string[] = [];
  if (candidate.companyId !== input.company.id) errors.push("companyId does not match the classification target");
  if (!isExactIsoDate(candidate.eventDate)) errors.push("eventDate is not a real exact ISO calendar date");
  if (!isOneConciseSentence(candidate.summary)) errors.push("summary must contain exactly one concise sentence");
  if (!candidate.title.trim() || /^(?:huge|exciting|major|incredible)\s+(?:news|update|momentum)/i.test(candidate.title)) {
    errors.push("title is empty or promotional");
  }

  const sources = new Map(input.sources.map((source) => [source.id, source]));
  const claimedSources = [...new Set(candidate.sourceIds)];
  if (claimedSources.length !== candidate.sourceIds.length) errors.push("sourceIds contain duplicates");
  for (const sourceId of claimedSources) {
    const source = sources.get(sourceId);
    if (!source) {
      errors.push(`unknown sourceId ${sourceId}`);
      continue;
    }
    if (source.attributionStatus !== "verified") errors.push(`source ${sourceId} is not verified`);
    if (source.linkStatus === "invalid" || source.linkStatus === "blocked") errors.push(`source ${sourceId} is not inspectable`);
    try {
      canonicalizeSourceUrl(source.url);
    } catch {
      errors.push(`source ${sourceId} has an unsafe URL`);
    }
  }

  const directClaims = candidate.evidence.filter((claim) => claimedSources.includes(claim.sourceId));
  for (const field of ["title", "summary", "eventDate"] as const) {
    if (!directClaims.some((claim) => claim.supports.includes(field))) errors.push(`no direct evidence supports ${field}`);
  }
  const dateSources = directClaims
    .filter((claim) => claim.supports.includes("eventDate"))
    .map((claim) => sources.get(claim.sourceId))
    .filter((source) => source !== undefined);
  const matchingDateSources = dateSources.filter((source) =>
    source.publicationDatePrecision !== "unknown"
    && isoDateFromExactTimestamp(source.publicationTimestamp) === candidate.eventDate
  );
  if (matchingDateSources.length === 0) {
    errors.push("eventDate does not match an exact direct-source timestamp");
  } else if (!matchingDateSources.some((source) =>
    timelineEventDateTypeForSource(source) === candidate.eventDateType
  )) {
    errors.push("eventDateType does not match the direct source date provenance");
  }

  const quantitativeTokens = extractQuantitativeTokens(`${candidate.title} ${candidate.summary}`);
  const evidenceText = directClaims.map((claim) => claim.excerpt).join(" ");
  for (const token of quantitativeTokens) {
    if (!normalizeNumberText(evidenceText).includes(normalizeNumberText(token))) {
      errors.push(`quantitative claim is unsupported: ${token}`);
    }
  }
  if (input.existingEventKeys.includes(candidate.mergeKey)) errors.push("mergeKey already exists");
  return { valid: errors.length === 0, errors };
}

export function parseAndValidateClassifierResult(
  raw: unknown,
  input: TimelineClassificationInput,
): TimelineClassifierResult {
  const result = classifierResultSchema.parse(raw) as TimelineClassifierResult;
  if (result.isMeaningfulEvent) {
    const validation = validateTimelineCandidate(result, input);
    if (!validation.valid) throw new Error(`Invalid timeline classifier output: ${validation.errors.join("; ")}`);
  } else if (result.companyId !== input.company.id) {
    throw new Error("Rejected timeline classifier result targeted the wrong company.");
  }
  return result;
}

export function isTimelineCategory(value: string): value is TimelineCategory {
  return (TIMELINE_CATEGORIES as readonly string[]).includes(value);
}

function extractQuantitativeTokens(value: string): string[] {
  return [...value.matchAll(/(?:[$€£]\s*)?\b\d[\d,.]*(?:\s*(?:%|[kmb]|million|billion|arr|mrr|users?|customers?))?/gi)]
    .map((match) => match[0].trim())
    .filter((token) => !/^20\d{2}$/.test(token));
}

function normalizeNumberText(value: string): string {
  return value.toLowerCase().replace(/[\s,]/g, "");
}
