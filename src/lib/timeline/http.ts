import { createHash } from "node:crypto";
import { z } from "zod";
import {
  TIMELINE_ARTIFACT_SCHEMA_VERSION,
  TIMELINE_CATEGORIES,
  type ListPublishedTimelineEventsResult,
  type TimelineCacheMetadata,
  type TimelineCategory,
} from "./contracts";

export const TIMELINE_DEFAULT_LIMIT = 20;
export const TIMELINE_MAX_LIMIT = 100;
// Admin mutations write a durable invalidation and request a shared Next cache
// purge. Keep every remaining browser/edge copy tightly bounded so a missed
// purge cannot serve an edited event for hours.
export const TIMELINE_BROWSER_MAX_AGE_SECONDS = 0;
export const TIMELINE_CDN_MAX_AGE_SECONDS = 30;
export const TIMELINE_STALE_WHILE_REVALIDATE_SECONDS = 30;

const PUBLIC_TIMELINE_QUERY_PARAMETERS = new Set([
  "from",
  "to",
  "categories",
  "cursor",
  "limit",
]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const timelineCategorySchema = z.enum(TIMELINE_CATEGORIES);

export interface CompanyTimelineQuery {
  from?: string;
  to?: string;
  categories: TimelineCategory[];
  cursor?: string;
  limit: number;
}

export interface CompanyTimelineHttpResponse extends Omit<ListPublishedTimelineEventsResult, "cache"> {
  schemaVersion: typeof TIMELINE_ARTIFACT_SCHEMA_VERSION;
  filters: {
    from: string | null;
    to: string | null;
    categories: TimelineCategory[];
  };
  cache: TimelineCacheMetadata;
}

export interface TimelineHttpInputIssue {
  path: string;
  message: string;
}

export class TimelineHttpInputError extends Error {
  readonly issues: TimelineHttpInputIssue[];

  constructor(message: string, issues: TimelineHttpInputIssue[]) {
    super(message);
    this.name = "TimelineHttpInputError";
    this.issues = issues;
  }
}

export function parseCompanyTimelineQuery(params: URLSearchParams): CompanyTimelineQuery {
  const issues: TimelineHttpInputIssue[] = [];
  for (const key of new Set(params.keys())) {
    if (!PUBLIC_TIMELINE_QUERY_PARAMETERS.has(key)) {
      issues.push({ path: "query", message: `Unknown query parameter: ${key}.` });
    }
    if (params.getAll(key).length > 1) {
      issues.push({ path: key, message: "Query parameters must not be repeated." });
    }
  }

  const from = optionalExactDate(params.get("from"), "from", issues);
  const to = optionalExactDate(params.get("to"), "to", issues);
  if (from && to && from > to) {
    issues.push({ path: "from", message: "from must be on or before to." });
  }

  const categories = parseCategories(params.get("categories"), issues);
  const cursor = optionalBoundedString(params.get("cursor"), "cursor", 512, issues);
  if (cursor && !isValidEventCursor(cursor)) {
    issues.push({ path: "cursor", message: "cursor is malformed or no longer supported." });
  }
  const limit = parseLimit(params.get("limit"), issues);
  if (issues.length > 0) throw new TimelineHttpInputError("Invalid timeline query.", issues);
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    categories,
    ...(cursor ? { cursor } : {}),
    limit,
  };
}

export function parseTimelineCompanySlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (
    slug.length < 1 ||
    slug.length > 120 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)
  ) {
    throw new TimelineHttpInputError("Invalid company slug.", [
      { path: "slug", message: "Company slug must contain only lowercase letters, numbers, and hyphens." },
    ]);
  }
  return slug;
}

export function parseTimelineEventId(value: string): string {
  const eventId = value.trim();
  if (
    eventId.length < 1 ||
    eventId.length > 180 ||
    !/^[A-Za-z0-9._~:-]+$/.test(eventId)
  ) {
    throw new TimelineHttpInputError("Invalid timeline event ID.", [
      { path: "eventId", message: "Timeline event ID is malformed." },
    ]);
  }
  return eventId;
}

export function timelinePublicErrorResponse(input: {
  status: number;
  code: string;
  message: string;
  issues?: TimelineHttpInputIssue[];
}): Response {
  return Response.json(
    {
      error: {
        code: input.code,
        message: input.message,
        ...(input.issues?.length ? { details: input.issues } : {}),
      },
    },
    {
      status: input.status,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export function timelineJsonResponse<T extends object>(
  request: Request,
  payload: T,
  options: {
    generatedAt: string;
    lastModifiedAt: string;
    includeCacheMetadata?: boolean;
    responseHeaders?: Record<string, string>;
  },
): Response {
  const validator = createTimelineEtag(payload);
  const cacheMetadata: TimelineCacheMetadata = {
    etag: validator,
    generatedAt: options.generatedAt,
    lastModifiedAt: options.lastModifiedAt,
    maxAgeSeconds: TIMELINE_CDN_MAX_AGE_SECONDS,
    staleWhileRevalidateSeconds: TIMELINE_STALE_WHILE_REVALIDATE_SECONDS,
  };
  const responsePayload = options.includeCacheMetadata === false
    ? payload
    : { ...payload, cache: cacheMetadata };
  const headers = {
    ...timelineCacheHeaders(validator, options.lastModifiedAt),
    ...options.responseHeaders,
  };

  if (etagMatches(request.headers.get("if-none-match"), validator)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(JSON.stringify(responsePayload), {
    status: 200,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export function companyTimelineHttpCacheKey(slug: string, query: CompanyTimelineQuery): string {
  return JSON.stringify([
    "company-timeline.v1",
    slug,
    query.from ?? null,
    query.to ?? null,
    [...query.categories].sort(),
    query.cursor ?? null,
    query.limit,
  ]);
}

function createTimelineEtag(payload: object): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("base64url")
    .slice(0, 27);
  return `W/"timeline-${digest}"`;
}

function timelineCacheHeaders(etag: string, lastModifiedAt: string): Record<string, string> {
  const lastModified = new Date(lastModifiedAt);
  return {
    "Cache-Control": `public, max-age=${TIMELINE_BROWSER_MAX_AGE_SECONDS}, s-maxage=${TIMELINE_CDN_MAX_AGE_SECONDS}, stale-while-revalidate=${TIMELINE_STALE_WHILE_REVALIDATE_SECONDS}`,
    ETag: etag,
    ...(Number.isNaN(lastModified.getTime()) ? {} : { "Last-Modified": lastModified.toUTCString() }),
    Vary: "Accept-Encoding",
    "X-Content-Type-Options": "nosniff",
  };
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === etag || `W/${normalized}` === etag;
  });
}

function optionalExactDate(
  value: string | null,
  path: string,
  issues: TimelineHttpInputIssue[],
): string | undefined {
  if (value === null) return undefined;
  if (!isExactIsoDate(value)) {
    issues.push({ path, message: "Expected an exact calendar date in YYYY-MM-DD format." });
    return undefined;
  }
  return value;
}

function isExactIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseCategories(
  value: string | null,
  issues: TimelineHttpInputIssue[],
): TimelineCategory[] {
  if (value === null) return [];
  const values = value.split(",").map((category) => category.trim());
  if (values.length === 0 || values.some((category) => category.length === 0)) {
    issues.push({ path: "categories", message: "categories must contain one or more category values." });
    return [];
  }
  if (new Set(values).size !== values.length) {
    issues.push({ path: "categories", message: "Category values must be unique." });
  }
  const categories: TimelineCategory[] = [];
  for (const [index, valueItem] of values.entries()) {
    const parsed = timelineCategorySchema.safeParse(valueItem);
    if (parsed.success) categories.push(parsed.data);
    else issues.push({ path: `categories.${index}`, message: `Unknown timeline category: ${valueItem}.` });
  }
  return categories;
}

function optionalBoundedString(
  value: string | null,
  path: string,
  maxLength: number,
  issues: TimelineHttpInputIssue[],
): string | undefined {
  if (value === null) return undefined;
  if (value.length < 1 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    issues.push({ path, message: `${path} must be between 1 and ${maxLength} printable characters.` });
    return undefined;
  }
  return value;
}

function parseLimit(value: string | null, issues: TimelineHttpInputIssue[]): number {
  if (value === null) return TIMELINE_DEFAULT_LIMIT;
  if (!/^\d+$/.test(value)) {
    issues.push({ path: "limit", message: "limit must be an integer." });
    return TIMELINE_DEFAULT_LIMIT;
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TIMELINE_MAX_LIMIT) {
    issues.push({ path: "limit", message: `limit must be between 1 and ${TIMELINE_MAX_LIMIT}.` });
    return TIMELINE_DEFAULT_LIMIT;
  }
  return limit;
}

function isValidEventCursor(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return Object.keys(record).length === 2
      && typeof record.eventDate === "string"
      && isExactIsoDate(record.eventDate)
      && typeof record.id === "string"
      && /^[A-Za-z0-9._~:-]{1,180}$/.test(record.id);
  } catch {
    return false;
  }
}
