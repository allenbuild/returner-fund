import { z } from "zod";
import {
  adminJsonResponse,
  authorizeAdminRequest,
} from "@/lib/admin/request-auth";
import {
  TIMELINE_CATEGORIES,
  TIMELINE_EVENT_DATE_TYPES,
  type TimelineAdminAuditActor,
  type TimelineAdminCandidateAction,
  type TimelineAdminCompanyAction,
  type TimelineAdminEventAction,
  type TimelineBackfillStatus,
  type TimelineCandidateStatus,
} from "./contracts";
import { TIMELINE_SOURCE_CLASSES } from "./coordinator";

export const TIMELINE_ADMIN_MAX_BODY_BYTES = 64 * 1024;
export const TIMELINE_ADMIN_MAX_PAGE_SIZE = 100;

const identifier = z.string().trim().min(1).max(180).regex(/^[A-Za-z0-9._~:-]+$/);
const reason = z.string().trim().min(3).max(1_000);
const exactDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Expected an exact calendar date.");
const eventPatchSchema = z.object({
  title: z.string().trim().min(3).max(180).optional(),
  summary: z.string().trim().min(8).max(500).optional(),
  category: z.enum(TIMELINE_CATEGORIES).optional(),
  eventDate: exactDate.optional(),
  eventDateType: z.enum(TIMELINE_EVENT_DATE_TYPES).optional(),
  isMajor: z.boolean().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "At least one field must be edited.");

const eventActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("publish"), eventId: identifier, reason }).strict(),
  z.object({ type: z.literal("reject"), eventId: identifier, reason }).strict(),
  z.object({ type: z.literal("unpublish"), eventId: identifier, reason }).strict(),
  z.object({ type: z.literal("re_evaluate"), eventId: identifier, reason }).strict(),
  z.object({ type: z.literal("edit"), eventId: identifier, patch: eventPatchSchema, reason }).strict(),
  z.object({
    type: z.literal("merge"),
    eventId: identifier,
    sourceEventIds: z.array(identifier).min(1).max(20).refine(
      (values) => new Set(values).size === values.length,
      "Source event IDs must be unique.",
    ),
    reason,
  }).strict().refine(
    (action) => !action.sourceEventIds.includes(action.eventId),
    "The target event cannot also be a merge source.",
  ),
  z.object({
    type: z.literal("split"),
    eventId: identifier,
    evidenceIds: z.array(identifier).min(1).max(100).refine(
      (values) => new Set(values).size === values.length,
      "Evidence IDs must be unique.",
    ),
    reason,
  }).strict(),
  z.object({
    type: z.literal("add_conflict_note"),
    eventId: identifier,
    note: z.string().trim().min(3).max(2_000),
    reason,
  }).strict(),
  z.object({
    type: z.literal("resolve_conflict"),
    eventId: identifier,
    resolution: z.string().trim().min(3).max(2_000),
    reason,
  }).strict(),
  z.object({
    type: z.literal("attach_evidence"),
    eventId: identifier,
    sourceDocumentId: identifier,
    evidenceRole: z.enum(["primary", "supporting", "conflicting"]),
    reason,
  }).strict(),
  z.object({
    type: z.literal("remove_evidence"),
    eventId: identifier,
    sourceDocumentId: identifier,
    reason,
  }).strict(),
]);

const companyActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rerun_discovery"), companyId: identifier }).strict(),
  z.object({
    type: z.literal("rerun_source"),
    companyId: identifier,
    sourceClass: z.enum(TIMELINE_SOURCE_CLASSES),
  }).strict(),
  z.object({ type: z.literal("reclassify"), companyId: identifier }).strict(),
  z.object({ type: z.literal("rebuild_artifact"), companyId: identifier }).strict(),
]);

const candidateActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("publish_candidate"), candidateId: identifier, reason }).strict(),
  z.object({ type: z.literal("reject_candidate"), candidateId: identifier, reason }).strict(),
  z.object({
    type: z.literal("merge_candidate"),
    candidateId: identifier,
    targetEventId: identifier,
    reason,
  }).strict(),
]);

const adminActionRequestSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("event"), action: eventActionSchema }).strict(),
  z.object({ scope: z.literal("company"), action: companyActionSchema }).strict(),
  z.object({ scope: z.literal("candidate"), action: candidateActionSchema }).strict(),
]);

export type TimelineAdminActionRequest =
  | { scope: "event"; action: TimelineAdminEventAction }
  | { scope: "company"; action: TimelineAdminCompanyAction }
  | { scope: "candidate"; action: TimelineAdminCandidateAction };

export interface TimelineAdminListQuery {
  cursor?: string;
  limit: number;
  companyId?: string;
  status?: string;
  query?: string;
}

export interface TimelineAdminCoverageQuery extends Omit<TimelineAdminListQuery, "companyId" | "status"> {
  status?: TimelineBackfillStatus;
}

export interface TimelineAdminReviewQuery extends Omit<TimelineAdminListQuery, "status"> {
  status?: TimelineCandidateStatus;
}

export function authorizeTimelineAdminRequest(request: Request): Response | null {
  return authorizeAdminRequest(request, {
    // Timeline administration includes publication and evidence mutations. Keep
    // that authority isolated from the broader ingestion/refresh credentials so
    // a diagnostics or scheduled-refresh token cannot edit public history.
    secretEnvironmentVariables: ["ADMIN_TIMELINE_SECRET"],
    secretHeaderNames: ["x-admin-timeline-secret"],
    allowInsecureLoopbackEnvironmentVariable: "ADMIN_TIMELINE_ALLOW_INSECURE_LOOPBACK",
    realm: "admin-timeline",
    unavailableCode: "admin_timeline_secret_not_configured",
    unavailableMessage: "Timeline administration is unavailable because no admin secret is configured.",
    unauthorizedCode: "admin_timeline_unauthorized",
    unauthorizedMessage: "A valid timeline admin secret is required.",
  });
}

export function parseTimelineAdminListQuery(params: URLSearchParams): TimelineAdminListQuery {
  const allowed = new Set(["cursor", "limit", "companyId", "status", "q"]);
  for (const key of new Set(params.keys())) {
    if (!allowed.has(key)) {
      throw new TimelineAdminRequestError(`Unknown query parameter: ${key}.`, 400);
    }
    if (params.getAll(key).length > 1) {
      throw new TimelineAdminRequestError(`${key} must not be repeated.`, 400);
    }
  }
  const cursor = boundedOptional(params.get("cursor"), "cursor", 512);
  if (cursor && !isValidAdminOffsetCursor(cursor)) {
    throw new TimelineAdminRequestError("cursor is malformed or no longer supported.", 400, [{
      path: "cursor",
      message: "Expected a bounded timeline admin pagination cursor.",
    }]);
  }
  const companyId = boundedOptional(params.get("companyId"), "companyId", 180);
  const status = boundedOptional(params.get("status"), "status", 80);
  const query = boundedOptional(params.get("q"), "q", 160);
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (
    rawLimit !== null &&
    (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > TIMELINE_ADMIN_MAX_PAGE_SIZE)
  ) {
    throw new TimelineAdminRequestError(
      `limit must be an integer between 1 and ${TIMELINE_ADMIN_MAX_PAGE_SIZE}.`,
      400,
    );
  }
  return {
    ...(cursor ? { cursor } : {}),
    ...(companyId ? { companyId } : {}),
    ...(status ? { status } : {}),
    ...(query ? { query } : {}),
    limit,
  };
}

export function parseTimelineAdminResourceId(value: string, field: string): string {
  const parsed = identifier.safeParse(value);
  if (!parsed.success) {
    throw new TimelineAdminRequestError(`Invalid ${field}.`, 400, [{
      path: field,
      message: `${field} is malformed.`,
    }]);
  }
  return parsed.data;
}

export function parseTimelineAdminCoverageQuery(params: URLSearchParams): TimelineAdminCoverageQuery {
  const query = parseTimelineAdminListQuery(params);
  if (query.companyId) {
    throw new TimelineAdminRequestError("companyId is not supported for coverage queries.", 400);
  }
  if (
    query.status &&
    !(["pending", "running", "completed", "partial", "failed"] as string[]).includes(query.status)
  ) {
    throw new TimelineAdminRequestError("Unknown historical backfill status.", 400);
  }
  return {
    cursor: query.cursor,
    limit: query.limit,
    query: query.query,
    status: query.status as TimelineBackfillStatus | undefined,
  };
}

export function parseTimelineAdminReviewQuery(params: URLSearchParams): TimelineAdminReviewQuery {
  const query = parseTimelineAdminListQuery(params);
  if (
    query.status &&
    !(["pending", "processing", "needs_review", "accepted", "rejected", "merged"] as string[])
      .includes(query.status)
  ) {
    throw new TimelineAdminRequestError("Unknown timeline candidate status.", 400);
  }
  return {
    cursor: query.cursor,
    limit: query.limit,
    query: query.query,
    companyId: query.companyId,
    status: query.status as TimelineCandidateStatus | undefined,
  };
}

export async function readTimelineAdminActionRequest(
  request: Request,
): Promise<TimelineAdminActionRequest> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > TIMELINE_ADMIN_MAX_BODY_BYTES) {
    throw new TimelineAdminRequestError("Timeline admin request exceeded the 64 KB limit.", 413);
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new TimelineAdminRequestError("Timeline admin request body could not be read.", 400);
  }
  if (Buffer.byteLength(text, "utf8") > TIMELINE_ADMIN_MAX_BODY_BYTES) {
    throw new TimelineAdminRequestError("Timeline admin request exceeded the 64 KB limit.", 413);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TimelineAdminRequestError("Timeline admin request must be valid JSON.", 400);
  }
  const parsed = adminActionRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new TimelineAdminRequestError(
      "Timeline admin action was invalid.",
      400,
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return parsed.data as TimelineAdminActionRequest;
}

export function timelineAdminActor(request: Request): TimelineAdminAuditActor {
  const configuredId = boundedActorValue(process.env.ADMIN_TIMELINE_ACTOR_ID, 180);
  const configuredEmail = boundedActorValue(process.env.ADMIN_TIMELINE_ACTOR_EMAIL, 320);
  const allowRequestOverride = process.env.NODE_ENV !== "production";
  const requestedId = allowRequestOverride
    ? boundedActorValue(request.headers.get("x-admin-actor-id"), 180)
    : null;
  const requestedEmail = allowRequestOverride
    ? boundedActorValue(request.headers.get("x-admin-actor-email"), 320)
    : null;
  const email = requestedEmail ?? configuredEmail;
  return {
    // Production attribution is deployment-owned. A stable fallback preserves
    // append-only auditability if an older deployment has not set the new ID.
    id: requestedId ?? configuredId ?? (allowRequestOverride ? "admin-secret" : "timeline-admin"),
    ...(email ? { email } : {}),
  };
}

function boundedActorValue(value: string | null | undefined, maximum: number): string | null {
  const normalized = value?.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

export class TimelineAdminRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
    this.name = "TimelineAdminRequestError";
  }
}

export function timelineAdminErrorResponse(error: unknown): Response {
  if (error instanceof TimelineAdminRequestError) {
    return adminJsonResponse({
      error: {
        code: "invalid_timeline_admin_request",
        message: error.message,
        ...(error.issues.length ? { details: error.issues } : {}),
      },
    }, error.status);
  }
  return adminJsonResponse({
    error: {
      code: "timeline_admin_request_failed",
      message: "The timeline admin request could not be completed.",
    },
  }, 500);
}

function boundedOptional(value: string | null, name: string, maxLength: number): string | undefined {
  if (value === null) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TimelineAdminRequestError(
      `${name} must be between 1 and ${maxLength} printable characters.`,
      400,
    );
  }
  return normalized;
}

function isValidAdminOffsetCursor(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return /^(?:0|[1-9]\d{0,8})$/.test(decoded);
  } catch {
    return false;
  }
}
