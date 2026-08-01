import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  applyBenchmarkMomentumRows,
  ensureBenchmarkMomentum,
  inheritCanonicalCompanyScoring
} from "@/lib/graph/benchmarks";
import { graphBenchmarkDatesAreFresh } from "@/lib/graph/benchmark-freshness";
import { applyClientGraphFilters } from "@/lib/graph/client-filters";
import { clearGraphResponseCache } from "@/lib/graph/graph-response-cache";
import { applyInsiderScenarioScoring } from "@/lib/graph/insider-scoring";
import { datasetWithLiveEvidence } from "@/lib/graph/live-evidence-dataset";
import { overlayLiveEvidenceOnGraph, type LiveEvidenceOverlayResult } from "@/lib/graph/live-evidence-overlay";
import { personalizeInsiderGraphSnapshot } from "@/lib/graph/personalized-insider-snapshot";
import { sanitizeGraphResponse } from "@/lib/graph/response-sanitizer";
import {
  formatStaticGraphSnapshotContractIssue,
  STATIC_GRAPH_SCORING_MODEL_ID,
  STATIC_GRAPH_SCORING_MODEL_VERSION,
  validateStaticGraphSnapshotContract
} from "@/lib/graph/static-graph-snapshot-contract.mjs";
import {
  loadLiveEvidenceRecords,
  runLiveSourceRefresh,
  type LiveEvidenceRecord,
  type LiveRefreshCancellationReason,
  type LiveSourceRefreshResult
} from "@/lib/ingestion/live-source-refresh";
import { isCurrentCentralDay } from "@/lib/time/central-day";
import type { EdgeType, GraphResponse, Platform, TopVoiceAudienceId, TopVoiceMember } from "@/lib/graph/types";
import {
  effectiveInsiderMembers,
  type UserInsiderConfiguration
} from "@/lib/social/user-insiders";
import {
  authenticateInsiderRequest,
  loadUserInsiderConfiguration
} from "@/lib/social/user-insiders-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_BATCH_SLUG = "S2026";
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const REQUEST_BODY_TIMEOUT_MS = 5_000;
const MAX_SOURCE_URLS = 20;
const MAX_FILTER_VALUES = 64;
const MAX_COMPANY_X_TARGETS = 220;
const MAX_TOP_VOICE_X_TARGETS = 50;
const BUSY_RETRY_AFTER_SECONDS = 5;
const SERVER_REFRESH_TIMEOUT_MS = 40_000;
const LIVE_REFRESH_BUDGET_MS = 30_000;
const MAX_LIVE_NETWORK_REQUESTS = 100;
const PLATFORM_VALUES = [
  "github",
  "x",
  "linkedin",
  "instagram",
  "product_hunt",
  "youtube",
  "rss",
  "web",
  "reddit",
  "hacker_news",
  "bilibili",
  "tiktok",
  "bluesky"
] as const satisfies readonly Platform[];
const EDGE_TYPE_VALUES = [
  "founder_of",
  "industry_similarity",
  "same_group_partner",
  "top_voice_attention"
] as const satisfies readonly EdgeType[];
const TOP_VOICE_AUDIENCE_VALUES = ["off", "yc_partners", "insiders"] as const satisfies readonly TopVoiceAudienceId[];
const ALLOWED_X_SOURCE_HOSTS = new Set(["x.com", "twitter.com", "fxtwitter.com", "vxtwitter.com"]);

const platformSchema = z.enum(PLATFORM_VALUES);
const sourceUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .url()
  .refine((value) => normalizeDirectXStatusUrl(value) !== null, {
    message: "Must be an HTTPS X/Twitter status URL."
  })
  .transform((value) => normalizeDirectXStatusUrl(value) as string);
const uniquePlatformsSchema = z
  .array(platformSchema)
  .max(PLATFORM_VALUES.length)
  .refine((values) => new Set(values).size === values.length, { message: "Platforms must be unique." });
const uniqueSourceUrlsSchema = z
  .array(sourceUrlSchema)
  .max(MAX_SOURCE_URLS)
  .refine((values) => new Set(values).size === values.length, { message: "Source URLs must be unique." });
const uniqueEdgeTypesSchema = z
  .array(z.enum(EDGE_TYPE_VALUES))
  .max(EDGE_TYPE_VALUES.length)
  .refine((values) => new Set(values).size === values.length, { message: "Edge types must be unique." });
const filterValueSchema = z.string().trim().min(1).max(120);
const uniqueFilterValuesSchema = z
  .array(filterValueSchema)
  .max(MAX_FILTER_VALUES)
  .refine((values) => new Set(values).size === values.length, { message: "Filter values must be unique." });
const refreshRequestSchema = z
  .object({
    action: z.enum(["ingest", "refresh"]).default("ingest"),
    batchSlug: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).default(DEFAULT_BATCH_SLUG),
    platforms: uniquePlatformsSchema.default([]),
    sourceUrls: uniqueSourceUrlsSchema.default([]),
    edgeTypes: uniqueEdgeTypesSchema.default([]),
    industries: uniqueFilterValuesSchema.default([]),
    groupPartners: uniqueFilterValuesSchema.default([]),
    minScore: z.number().min(0).max(100).default(0),
    topVoices: z.enum(TOP_VOICE_AUDIENCE_VALUES).default("off")
  })
  .strict()
  .superRefine((body, context) => {
    if (body.sourceUrls.length > 0 && body.platforms.length > 0 && !body.platforms.includes("x")) {
      context.addIssue({
        code: "custom",
        path: ["sourceUrls"],
        message: "Direct X source URLs require the x platform to be selected."
      });
    }
  });

type RefreshRequest = z.infer<typeof refreshRequestSchema>;

const snapshotMomentumSchema = z
  .object({
    currentScore: z.number(),
    currentRank: z.number(),
    baselineScore: z.number().nullable(),
    baselineRank: z.number().nullable(),
    benchmarkedAt: z.string().nullable()
  })
  .passthrough();
const snapshotScoreConfidenceSchema = z
  .object({
    level: z.enum(["low", "medium", "high"]),
    value: z.number().min(0).max(1),
    reasons: z.array(z.string()),
    scoredEvidenceCount: z.number().int().nonnegative(),
    datedEvidenceCount: z.number().int().nonnegative(),
    verifiedLinkCount: z.number().int().nonnegative()
  })
  .passthrough();
const snapshotScoreCalibrationSchema = z
  .object({
    method: z.literal("none"),
    cohortSize: z.number().int().nonnegative(),
    percentile: z.number().min(0).max(1).nullable(),
    inputScore: z.number().min(0).max(100)
  })
  .passthrough();
const snapshotScoreBreakdownSchema = z
  .object({
    modelId: z.literal(STATIC_GRAPH_SCORING_MODEL_ID),
    modelVersion: z.literal(STATIC_GRAPH_SCORING_MODEL_VERSION),
    absoluteScore: z.number().min(0).max(100),
    confidence: snapshotScoreConfidenceSchema,
    calibration: snapshotScoreCalibrationSchema
  })
  .passthrough()
  .superRefine((breakdown, context) => {
    if (breakdown.calibration.inputScore !== breakdown.absoluteScore) {
      context.addIssue({
        code: "custom",
        path: ["calibration", "inputScore"],
        message: "Calibration inputScore must match absoluteScore."
      });
    }
  });
const graphSnapshotSchema = z
  .object({
    batch: z.object({ slug: z.string().min(1) }).passthrough(),
    batches: z.array(z.object({ slug: z.string().min(1) }).passthrough()),
    nodes: z.array(
      z
        .object({
          id: z.string().min(1),
          entityType: z.string().min(1),
          entityId: z.string().min(1),
          batchSlug: z.string().min(1),
          score: z.number(),
          primaryIndustry: z.string(),
          evidenceIds: z.array(z.string()),
          scoreBreakdown: snapshotScoreBreakdownSchema,
          founders: z.array(
            z.object({ id: z.string().min(1), evidenceIds: z.array(z.string()) }).passthrough()
          )
        })
        .passthrough()
    ),
    edges: z.array(
      z
        .object({
          id: z.string().min(1),
          source: z.string().min(1),
          target: z.string().min(1),
          edgeType: z.enum(EDGE_TYPE_VALUES)
        })
        .passthrough()
    ),
    leaderboard: z.array(
      z.object({ rank: z.number(), companyId: z.string().min(1), score: z.number() }).passthrough()
    ),
    fastestGaining: z.array(
      z
        .object({
          rank: z.number(),
          companyId: z.string().min(1),
          dod: snapshotMomentumSchema,
          wow: snapshotMomentumSchema
        })
        .passthrough()
    ),
    needsReview: z.array(z.unknown()),
    evidence: z.array(
      z
        .object({
          id: z.string().min(1),
          entityType: z.string().min(1),
          entityId: z.string().min(1),
          platform: platformSchema,
          postedAt: z.string(),
          text: z.string(),
          metrics: z.record(z.string(), z.unknown()),
          contributionScore: z.number(),
          sourceUrl: z.string().min(1),
          why: z.string()
        })
        .passthrough()
    ),
    platformStatus: z.array(z.unknown()),
    selectedTopVoiceAudience: z.object({ id: z.enum(TOP_VOICE_AUDIENCE_VALUES) }).passthrough(),
    topVoiceAudiences: z.array(
      z.object({ id: z.enum(TOP_VOICE_AUDIENCE_VALUES) }).passthrough()
    ),
    generatedAt: z.string().min(1),
    scoringContext: z
      .object({
        modelId: z.literal(STATIC_GRAPH_SCORING_MODEL_ID),
        modelVersion: z.literal(STATIC_GRAPH_SCORING_MODEL_VERSION),
        responseBuiltAt: z.string().min(1)
      })
      .passthrough(),
    mode: z.enum(["demo", "database", "official_snapshot"])
  })
  .passthrough();

interface RefreshRouteResult {
  httpStatus: number;
  payload: Record<string, unknown>;
}

type SnapshotFallbackReason =
  | "unsupported_batch_or_audience"
  | "missing_or_unreadable"
  | "invalid_json"
  | "invalid_structure"
  | "identity_mismatch"
  | "stale"
  | "snapshot_processing_failed"
  | "top_voice_live_evidence_requires_rebuild";

interface GraphResolution {
  overlay: LiveEvidenceOverlayResult;
  source: "generated_public_snapshot" | "rebuild";
  fallbackReason?: SnapshotFallbackReason;
}

interface SnapshotLoadResult {
  graph: GraphResponse | null;
  fallbackReason?: SnapshotFallbackReason;
}

interface RefreshExecutionObservability {
  routeStartedAt: number;
  liveRefreshStartedAt?: number;
  liveRefreshElapsedMs?: number;
  graphStartedAt?: number;
  stageLog?: Array<{ stage: string; platform: string }>;
}

interface InFlightRefresh {
  key: string;
  startedAt: string;
  promise: Promise<RefreshRouteResult>;
}

let inFlightRefresh: InFlightRefresh | null = null;

export async function POST(request: Request) {
  const requestStartedAt = Date.now();
  const authFailure = authorizeRefreshRequest(request, requestStartedAt);
  if (authFailure) {
    return authFailure;
  }
  const storageFailure = refreshStorageFailure(requestStartedAt);
  if (storageFailure) {
    return storageFailure;
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonRequestBody(request);
  } catch (error) {
    if (error instanceof RefreshRequestError) {
      return errorResponse(error.status, error.code, [error.message], requestStartedAt);
    }
    console.error("Graph refresh request body could not be read", error);
    return errorResponse(400, "invalid_request_body", ["Request body could not be read."], requestStartedAt);
  }

  const parsed = refreshRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join(".") || "body"}: ${issue.message}`
    );
    return errorResponse(400, "invalid_request", errors, requestStartedAt);
  }

  const body = parsed.data;
  let insiderMembers: TopVoiceMember[] | undefined;
  let insiderConfiguration: UserInsiderConfiguration | undefined;
  let insiderRequestScope = "built-in";
  if (body.topVoices === "insiders") {
    const authenticated = await authenticateInsiderRequest(request);
    if (authenticated) {
      try {
        insiderConfiguration = await loadUserInsiderConfiguration(authenticated.client, authenticated.userId);
        insiderMembers = effectiveInsiderMembers(insiderConfiguration);
        insiderRequestScope = `${authenticated.userId}:${insiderConfiguration.version}`;
      } catch (error) {
        console.error("Personalized Insiders refresh configuration load failed", error);
        return errorResponse(
          500,
          "insider_configuration_load_failed",
          ["Your private Insiders list could not be loaded."],
          requestStartedAt
        );
      }
    }
  }
  const requestKey = `${refreshRequestKey(body)}:${insiderRequestScope}`;
  const activeRefresh = inFlightRefresh;
  if (activeRefresh) {
    if (activeRefresh.key !== requestKey) {
      return errorResponse(
        429,
        "refresh_in_progress",
        ["A different graph refresh is already in progress. Retry after it completes."],
        requestStartedAt,
        {
          refreshRequest: {
            idempotencyKey: requestKey,
            disposition: "rejected_in_flight",
            activeIdempotencyKey: activeRefresh.key,
            activeStartedAt: activeRefresh.startedAt
          }
        },
        { "Retry-After": String(BUSY_RETRY_AFTER_SECONDS) }
      );
    }

    const joinedAt = Date.now();
    const result = await activeRefresh.promise;
    return refreshResultResponse(result, {
      idempotencyKey: requestKey,
      disposition: "joined",
      startedAt: activeRefresh.startedAt,
      waitedMs: Date.now() - joinedAt
    });
  }

  const observability: RefreshExecutionObservability = { routeStartedAt: requestStartedAt };
  const startedAt = new Date().toISOString();
  const abortController = new AbortController();
  const unlinkRequestSignal = forwardAbortSignal(request.signal, abortController);
  const executionPromise = executeRefresh(
    body,
    observability,
    abortController.signal,
    insiderMembers,
    insiderConfiguration
  ).catch((error) =>
    request.signal.aborted
      ? cancelledRefreshFailure(observability, requestKey)
      : unexpectedRefreshFailure(error, observability, requestKey)
  );
  const promise = runRefreshWithDeadline(executionPromise, abortController, observability, requestKey);
  inFlightRefresh = { key: requestKey, startedAt, promise };
  void executionPromise.finally(() => {
    unlinkRequestSignal();
    if (inFlightRefresh?.promise === promise) {
      inFlightRefresh = null;
    }
  });

  const result = await promise;
  return refreshResultResponse(result, {
    idempotencyKey: requestKey,
    disposition: "executed",
    startedAt,
    waitedMs: 0
  });
}

async function executeRefresh(
  body: RefreshRequest,
  observability: RefreshExecutionObservability,
  signal: AbortSignal,
  insiderMembers?: TopVoiceMember[],
  insiderConfiguration?: UserInsiderConfiguration
): Promise<RefreshRouteResult> {
  const routeStartedAt = observability.routeStartedAt;
  const action = body.action;
  const batchSlug = body.batchSlug;
  const topVoices = body.topVoices;
  const targetScope = refreshTargetScope(body);
  throwIfRefreshAborted(signal);
  clearGraphResponseCache();
  const liveRefreshStartedAt = Date.now();
  observability.liveRefreshStartedAt = liveRefreshStartedAt;
  const liveRefresh = await runLiveSourceRefresh({
    batchSlug,
    platforms: body.platforms,
    topVoices,
    topVoiceMembers: insiderMembers,
    xSourceUrls: body.sourceUrls,
    maxPostsPerTarget: 1,
    maxXTargets: targetScope.profileTargetLimit,
    maxTopVoiceXTargets: targetScope.profileTargetLimit,
    signal,
    deadlineAt: Date.now() + LIVE_REFRESH_BUDGET_MS,
    maxNetworkRequests: MAX_LIVE_NETWORK_REQUESTS
  });
  const liveRefreshElapsedMs = Date.now() - liveRefreshStartedAt;
  observability.liveRefreshElapsedMs = liveRefreshElapsedMs;
  observability.stageLog = liveRefresh.stageLog;
  throwIfRefreshAborted(signal);
  observability.graphStartedAt = Date.now();
  let liveEvidenceRecords: LiveEvidenceRecord[];
  try {
    liveEvidenceRecords = await loadLiveEvidenceRecords();
  } catch (error) {
    throwIfRefreshAborted(signal);
    return persistedLiveEvidenceReloadFailure({
      action,
      batchSlug,
      requestedPlatforms: body.platforms,
      liveRefresh,
      liveRefreshElapsedMs,
      observability,
      error
    });
  }
  throwIfRefreshAborted(signal);
  const graphResolution = await resolveGraph(
    batchSlug,
    topVoices,
    liveEvidenceRecords,
    insiderMembers,
    insiderConfiguration
  );
  throwIfRefreshAborted(signal);
  const filteredGraph = applyRefreshClientFilters(graphResolution.overlay.graph, body);
  const sanitizedGraph = sanitizeGraphResponse(filteredGraph);
  const graph = graphResolution.source === "generated_public_snapshot"
    ? sanitizedGraph
    : (await import("@/lib/graph/summer-platform-status")).enrichSummerPlatformStatus(sanitizedGraph);
  const graphElapsedMs = Date.now() - (observability.graphStartedAt ?? Date.now());
  const newestIngestedEvidence = [...liveRefresh.acceptedEvidence].sort(sortLiveRecordsNewestFirst);
  const readBackRows = countReadBackAcceptedRows(liveEvidenceRecords, liveRefresh.acceptedEvidence);
  const acceptedVisibleEvidence = visibleEvidenceForAcceptedRows(filteredGraph.evidence, liveRefresh.acceptedEvidence);
  const acceptedHiddenEvidence = hiddenEvidenceForAcceptedRows(
    graphResolution.overlay.hiddenEvidence,
    liveRefresh.acceptedEvidence,
    acceptedVisibleEvidence
  );
  const newestVisibleEvidence = [...acceptedVisibleEvidence].sort(sortEvidenceNewestFirst);
  const cancellationReason = normalizeRefreshCancellationReason(
    liveRefresh.cancellationReason,
    liveRefresh.failureReasonCounts
  );
  const networkRequests = liveRefresh.networkRequests ?? 0;
  const networkRequestBudget = liveRefresh.networkRequestBudget ?? MAX_LIVE_NETWORK_REQUESTS;
  const networkRequestBudgetExhausted = Boolean(
    liveRefresh.networkRequestBudgetExhausted ||
    (liveRefresh.failureReasonCounts.network_request_budget_exhausted ?? 0) > 0
  );
  const refreshOutcome = classifyRefreshOutcome({
    acceptedCount: liveRefresh.acceptedEvidence.length,
    storedCount: liveRefresh.storedEvidence.length,
    readBackCount: readBackRows,
    visibleCount: acceptedVisibleEvidence.length,
    failureReasonCounts: liveRefresh.failureReasonCounts,
    cancellationReason,
    networkRequests,
    networkRequestBudget,
    networkRequestBudgetExhausted
  });
  const refreshSummary = {
    action,
    batchSlug,
    generatedAt: liveRefresh.generatedAt,
    status: refreshOutcome.status,
    requestedPlatforms: body.platforms ?? [],
    attemptedPlatforms: attemptedPlatformsFromStages(liveRefresh.stageLog),
    unsupportedPlatforms: unsupportedPlatformsFromStages(liveRefresh.stageLog),
    acceptedRows: liveRefresh.acceptedEvidence.length,
    storedRows: liveRefresh.storedEvidence.length,
    readBackRows,
    visibleRows: acceptedVisibleEvidence.length,
    ingestionRunId: liveRefresh.runId,
    cancellationReason,
    networkRequests,
    networkRequestBudget,
    networkRequestBudgetExhausted,
    graphSource: graphResolution.source,
    ...(graphResolution.fallbackReason ? { snapshotFallbackReason: graphResolution.fallbackReason } : {}),
    ...(graphResolution.source === "generated_public_snapshot"
      ? {
          fastPath:
            topVoices !== "off" && liveRefresh.acceptedEvidence.length === 0 && liveEvidenceRecords.length === 0
              ? "static_top_voice_noop"
              : "generated_public_snapshot"
        }
      : {}),
    targetScope,
    sourceSnapshots: liveRefresh.sourceSnapshots,
    stageCounts: countStages(liveRefresh.stageLog),
    stageSummary: summarizeStages(liveRefresh.stageLog),
    newestIngestedEvidence: newestIngestedEvidence.slice(0, 8).map((item) => ({
      companyName: item.companyName,
      platform: item.platform,
      sourceUrl: item.sourceUrl,
      postedAt: item.postedAt,
      metrics: item.metrics
    })),
    newestVisibleEvidence: newestVisibleEvidence.slice(0, 8).map((item) => ({
      companyName: item.attachedCompanyName ?? item.authorName,
      platform: item.platform,
      sourceUrl: item.sourceUrl,
      postedAt: item.postedAt,
      score: item.contributionScore,
      metrics: item.metrics
    })),
    hiddenEvidence: acceptedHiddenEvidence.slice(0, 12),
    platformRows: liveRefresh.platformRows,
    failureReasonCounts: liveRefresh.failureReasonCounts,
    appliedFilters: {
      platforms: body.platforms ?? [],
      edgeTypes: body.edgeTypes ?? [],
      industries: body.industries ?? [],
      groupPartners: body.groupPartners ?? [],
      minScore: body.minScore ?? 0,
      topVoices
    },
    timings: {
      liveRefreshMs: liveRefreshElapsedMs,
      graphMs: graphElapsedMs,
      totalMs: Date.now() - routeStartedAt
    }
  };

  return {
    httpStatus: 200,
    payload: {
      runId: `${graph.mode}-${action}-${Date.now()}`,
      status: refreshOutcome.status,
      logs: [
        `${formatMode(graph.mode)} ${action} ${formatRefreshOutcome(refreshOutcome.status)} for ${graph.batch.slug}.`,
        graphResolutionLog(graphResolution, topVoices, liveEvidenceRecords.length),
        `Live source refresh accepted ${liveRefresh.acceptedEvidence.length} new/updated X evidence row(s) and stored ${liveRefresh.storedEvidence.length}.`,
        acceptedVisibleEvidence.length
          ? `Newest visible live evidence: ${newestVisibleEvidence[0]?.attachedCompanyName ?? newestVisibleEvidence[0]?.authorName} / ${newestVisibleEvidence[0]?.platform} / ${newestVisibleEvidence[0]?.sourceUrl}.`
          : "No live evidence was visible in the current filtered graph; see refreshSummary.hiddenEvidence for filter or batch reasons.",
        cancellationReason
          ? `Stage log was not persisted because live source refresh ended with ${cancellationReason}.`
          : `Stage log written to outputs/ingestion-refresh-stage-log-current.json. Unsupported real-time adapters are reported with adapter_not_wired reasons.`
      ],
      errors: refreshOutcome.errors,
      refreshSummary,
      graph
    }
  };
}

class RefreshRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RefreshRequestError";
  }
}

function authorizeRefreshRequest(request: Request, requestStartedAt: number): NextResponse | null {
  if (process.env.NODE_ENV === "development" && isLoopbackRequest(request)) {
    return null;
  }

  const configuredSecret = [process.env.GRAPH_REFRESH_SECRET, process.env.REFRESH_SECRET]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));

  if (!configuredSecret) {
    if (process.env.NODE_ENV === "production") {
      return errorResponse(
        503,
        "refresh_secret_not_configured",
        ["Graph refresh is unavailable because its server secret is not configured."],
        requestStartedAt
      );
    }
    return null;
  }

  const authorization = request.headers.get("authorization");
  const bearerSecret = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const providedSecrets = [
    bearerSecret,
    request.headers.get("x-graph-refresh-secret")?.trim(),
    request.headers.get("x-refresh-secret")?.trim()
  ].filter((value): value is string => Boolean(value));

  if (!providedSecrets.some((providedSecret) => secretsMatch(providedSecret, configuredSecret))) {
    return errorResponse(
      401,
      "refresh_unauthorized",
      ["A valid graph refresh secret is required."],
      requestStartedAt,
      {},
      { "WWW-Authenticate": 'Bearer realm="graph-refresh"' }
    );
  }

  return null;
}

function isLoopbackRequest(request: Request): boolean {
  try {
    const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function refreshStorageFailure(requestStartedAt: number): NextResponse | null {
  if (process.env.NODE_ENV !== "production") {
    return null;
  }

  return errorResponse(
    503,
    "refresh_storage_not_configured",
    ["Manual source refresh is unavailable in production because this route only has process-local filesystem persistence."],
    requestStartedAt
  );
}

function secretsMatch(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

async function readJsonRequestBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType && contentType !== "application/json" && !contentType.endsWith("+json")) {
    throw new RefreshRequestError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_REQUEST_BODY_BYTES) {
    throw new RefreshRequestError(
      413,
      "request_body_too_large",
      `Request body must not exceed ${MAX_REQUEST_BODY_BYTES} bytes.`
    );
  }

  const text = await readRequestText(request);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RefreshRequestError(400, "malformed_json", "Request body must be valid JSON.");
  }
}

async function readRequestText(request: Request): Promise<string> {
  if (!request.body) {
    return "";
  }
  if (request.signal.aborted) {
    throw requestBodyAbortedError();
  }

  const reader = request.body.getReader();
  const guard = createRequestBodyReadGuard(request.signal);
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";
  let completed = false;

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), guard.stopped]);
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > MAX_REQUEST_BODY_BYTES) {
        throw new RefreshRequestError(
          413,
          "request_body_too_large",
          `Request body must not exceed ${MAX_REQUEST_BODY_BYTES} bytes.`
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    completed = true;
    return text + decoder.decode();
  } finally {
    guard.dispose();
    if (completed) {
      releaseRequestBodyReader(reader);
    } else {
      cancelRequestBodyReader(reader);
    }
  }
}

function createRequestBodyReadGuard(signal: AbortSignal): {
  stopped: Promise<never>;
  dispose: () => void;
} {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(requestBodyAbortedError());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    timeoutId = setTimeout(() => {
      reject(new RefreshRequestError(
        408,
        "request_body_timed_out",
        `Request body was not received within ${REQUEST_BODY_TIMEOUT_MS}ms.`
      ));
    }, REQUEST_BODY_TIMEOUT_MS);
  });

  return {
    stopped,
    dispose: () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      signal.removeEventListener("abort", onAbort);
    }
  };
}

function requestBodyAbortedError(): RefreshRequestError {
  return new RefreshRequestError(
    400,
    "request_body_aborted",
    "Request body read was aborted before it completed."
  );
}

function cancelRequestBodyReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  // A hostile stream may never settle its cancel hook, so cleanup must not delay the response.
  try {
    void reader.cancel().catch(() => undefined).finally(() => releaseRequestBodyReader(reader));
  } catch {
    releaseRequestBodyReader(reader);
  }
}

function releaseRequestBodyReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // A pending read retains the lock until cancellation settles.
  }
}

function errorResponse(
  httpStatus: number,
  code: string,
  errors: string[],
  requestStartedAt: number,
  extraPayload: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {}
): NextResponse {
  return NextResponse.json(
    {
      status: "failed",
      logs: [],
      errors,
      error: { code },
      timings: { totalMs: Date.now() - requestStartedAt },
      ...extraPayload
    },
    {
      status: httpStatus,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        ...extraHeaders
      }
    }
  );
}

function refreshResultResponse(
  result: RefreshRouteResult,
  refreshRequest: {
    idempotencyKey: string;
    disposition: "executed" | "joined";
    startedAt: string;
    waitedMs: number;
  }
): NextResponse {
  return NextResponse.json(
    {
      ...result.payload,
      refreshRequest
    },
    {
      status: result.httpStatus,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Refresh-Idempotency-Key": refreshRequest.idempotencyKey,
        "X-Refresh-Disposition": refreshRequest.disposition
      }
    }
  );
}

function persistedLiveEvidenceReloadFailure(input: {
  action: RefreshRequest["action"];
  batchSlug: string;
  requestedPlatforms: Platform[];
  liveRefresh: LiveSourceRefreshResult;
  liveRefreshElapsedMs: number;
  observability: RefreshExecutionObservability;
  error: unknown;
}): RefreshRouteResult {
  const now = Date.now();
  const reason = "persisted_live_evidence_reload_failed";
  const stageLog = input.liveRefresh.stageLog;
  const failureReasonCounts = {
    ...input.liveRefresh.failureReasonCounts,
    [reason]: (input.liveRefresh.failureReasonCounts[reason] ?? 0) + 1
  };
  console.error("Graph refresh persisted live evidence reload failed", {
    error: input.error,
    ingestionRunId: input.liveRefresh.runId
  });

  return {
    httpStatus: 500,
    payload: {
      runId: `graph-refresh-failed-${now}`,
      status: "failed",
      logs: [],
      errors: [
        `Persisted live evidence could not be read back after refresh (${reason}); graph visibility was not verified.`
      ],
      error: { code: "refresh_persisted_evidence_reload_failed" },
      refreshSummary: {
        action: input.action,
        batchSlug: input.batchSlug,
        generatedAt: input.liveRefresh.generatedAt,
        status: "failed",
        requestedPlatforms: input.requestedPlatforms,
        attemptedPlatforms: attemptedPlatformsFromStages(stageLog),
        unsupportedPlatforms: unsupportedPlatformsFromStages(stageLog),
        acceptedRows: input.liveRefresh.acceptedEvidence.length,
        storedRows: input.liveRefresh.storedEvidence.length,
        readBackRows: 0,
        visibleRows: 0,
        ingestionRunId: input.liveRefresh.runId,
        sourceSnapshots: input.liveRefresh.sourceSnapshots,
        stageCounts: countStages(stageLog),
        stageSummary: summarizeStages(stageLog),
        failureReasonCounts,
        timings: {
          liveRefreshMs: input.liveRefreshElapsedMs,
          graphMs: input.observability.graphStartedAt ? now - input.observability.graphStartedAt : 0,
          totalMs: now - input.observability.routeStartedAt
        }
      }
    }
  };
}

function unexpectedRefreshFailure(
  error: unknown,
  observability: RefreshExecutionObservability,
  requestKey: string
): RefreshRouteResult {
  console.error("Graph refresh execution failed", { error, requestKey });
  const now = Date.now();
  const liveRefreshMs = observability.liveRefreshElapsedMs ?? (
    observability.liveRefreshStartedAt ? now - observability.liveRefreshStartedAt : 0
  );
  const graphMs = observability.graphStartedAt ? now - observability.graphStartedAt : 0;
  const stageLog = observability.stageLog ?? [];

  return {
    httpStatus: 500,
    payload: {
      runId: `graph-refresh-failed-${now}`,
      status: "failed",
      logs: [],
      errors: ["Graph refresh failed unexpectedly."],
      error: { code: "refresh_failed" },
      refreshSummary: {
        status: "failed",
        stageCounts: countStages(stageLog),
        stageSummary: summarizeStages(stageLog),
        timings: {
          liveRefreshMs,
          graphMs,
          totalMs: now - observability.routeStartedAt
        }
      }
    }
  };
}

function cancelledRefreshFailure(
  observability: RefreshExecutionObservability,
  requestKey: string
): RefreshRouteResult {
  const now = Date.now();
  const stageLog = observability.stageLog ?? [];
  console.warn("Graph refresh request was cancelled", { requestKey });

  return {
    httpStatus: 499,
    payload: {
      runId: `graph-refresh-cancelled-${now}`,
      status: "failed",
      logs: [],
      errors: ["Graph refresh was cancelled because the request ended."],
      error: { code: "refresh_cancelled" },
      refreshSummary: {
        status: "failed",
        cancellationReason: "refresh_cancelled",
        stageCounts: countStages(stageLog),
        stageSummary: summarizeStages(stageLog),
        timings: {
          liveRefreshMs: observability.liveRefreshElapsedMs ?? (
            observability.liveRefreshStartedAt ? now - observability.liveRefreshStartedAt : 0
          ),
          graphMs: observability.graphStartedAt ? now - observability.graphStartedAt : 0,
          totalMs: now - observability.routeStartedAt
        }
      }
    }
  };
}

function runRefreshWithDeadline(
  executionPromise: Promise<RefreshRouteResult>,
  abortController: AbortController,
  observability: RefreshExecutionObservability,
  requestKey: string
): Promise<RefreshRouteResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<RefreshRouteResult>((resolve) => {
    timeoutId = setTimeout(() => {
      const now = Date.now();
      resolve({
        httpStatus: 504,
        payload: {
          runId: `graph-refresh-timeout-${now}`,
          status: "failed",
          logs: [],
          errors: ["Graph refresh exceeded its 40 second server budget and was cancelled."],
          error: { code: "refresh_timed_out" },
          refreshSummary: {
            status: "failed",
            stageCounts: countStages(observability.stageLog ?? []),
            stageSummary: summarizeStages(observability.stageLog ?? []),
            timings: {
              liveRefreshMs: observability.liveRefreshStartedAt
                ? now - observability.liveRefreshStartedAt
                : 0,
              graphMs: observability.graphStartedAt ? now - observability.graphStartedAt : 0,
              totalMs: now - observability.routeStartedAt
            }
          }
        }
      });
      abortController.abort(new DOMException("Graph refresh exceeded its server execution budget.", "TimeoutError"));
      console.warn("Graph refresh timed out and was cancelled", { requestKey });
    }, SERVER_REFRESH_TIMEOUT_MS);
  });

  return Promise.race([executionPromise, timeoutPromise]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}

function forwardAbortSignal(source: AbortSignal, target: AbortController): () => void {
  const forwardAbort = () => {
    if (!target.signal.aborted) {
      target.abort(source.reason);
    }
  };

  if (source.aborted) {
    forwardAbort();
    return () => undefined;
  }

  source.addEventListener("abort", forwardAbort, { once: true });
  return () => source.removeEventListener("abort", forwardAbort);
}

function throwIfRefreshAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new DOMException("Graph refresh was aborted.", "AbortError");
}

function refreshRequestKey(body: RefreshRequest): string {
  const canonicalBody = {
    ...body,
    platforms: [...body.platforms].sort(),
    sourceUrls: [...body.sourceUrls].sort(),
    edgeTypes: [...body.edgeTypes].sort(),
    industries: [...body.industries].sort(),
    groupPartners: [...body.groupPartners].sort()
  };
  return createHash("sha256").update(JSON.stringify(canonicalBody), "utf8").digest("hex").slice(0, 24);
}

function refreshTargetScope(body: RefreshRequest) {
  const totalTargetLimit = body.topVoices === "off" ? MAX_COMPANY_X_TARGETS : MAX_TOP_VOICE_X_TARGETS;
  return {
    directSourceUrlCount: body.sourceUrls.length,
    maxSourceUrls: MAX_SOURCE_URLS,
    profileTargetLimit: Math.max(0, totalTargetLimit - body.sourceUrls.length),
    totalTargetLimit
  };
}

function normalizeDirectXStatusUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^(?:www|mobile)\./, "").toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !ALLOWED_X_SOURCE_HOSTS.has(hostname)
    ) {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    const handle = parts[0];
    const postId = parts[2];
    if (
      !handle ||
      !/^[A-Za-z0-9_]{1,15}$/.test(handle) ||
      parts[1]?.toLowerCase() !== "status" ||
      !/^\d{10,25}$/.test(postId ?? "")
    ) {
      return null;
    }

    return `https://x.com/${handle.toLowerCase()}/status/${postId}`;
  } catch {
    return null;
  }
}

function formatMode(mode: string): string {
  if (mode === "official_snapshot") {
    return "Official YC snapshot";
  }
  if (mode === "database") {
    return "Database";
  }
  return "Demo";
}

function formatRefreshOutcome(status: RefreshOutcomeStatus): string {
  if (status === "completed") {
    return "completed";
  }
  if (status === "partial") {
    return "finished with partial results";
  }
  return "failed";
}

async function resolveGraph(
  batchSlug: string,
  topVoices: TopVoiceAudienceId,
  liveEvidenceRecords: LiveEvidenceRecord[],
  insiderMembers?: TopVoiceMember[],
  insiderConfiguration?: UserInsiderConfiguration
): Promise<GraphResolution> {
  const snapshot = insiderMembers
    ? { graph: null, fallbackReason: "top_voice_live_evidence_requires_rebuild" as const }
    : await loadGeneratedGraphSnapshot(batchSlug, topVoices);
  let fallbackReason = snapshot.fallbackReason;

  if (snapshot.graph) {
    try {
      const overlayRecords = topVoices === "off"
        ? liveEvidenceNotCapturedBySnapshot(snapshot.graph, liveEvidenceRecords)
        : liveEvidenceRecords;
      const calibrationCohort = overlayRecords.length > 0 && topVoices === "off"
        ? (await import("@/lib/graph/yc-spring-2026-dataset")).yc2026GraphDataset.companies.filter(
            (company) => company.batchSlug === batchSlug
          )
        : undefined;
      const overlay = overlayLiveEvidenceOnGraph(snapshot.graph, overlayRecords, {
        topVoices,
        calibrationCohort
      });
      if (topVoices === "off" || overlayRecords.length === 0) {
        return { overlay, source: "generated_public_snapshot" };
      }
      fallbackReason = "top_voice_live_evidence_requires_rebuild";
    } catch (error) {
      console.warn("Generated graph snapshot could not be overlaid safely; rebuilding", {
        batchSlug,
        topVoices,
        error
      });
      fallbackReason = "snapshot_processing_failed";
    }
  }

  console.warn("Graph refresh is rebuilding because the generated snapshot fast path was unavailable", {
    batchSlug,
    topVoices,
    fallbackReason
  });
  const [graphBuilder, graphDataset] = await Promise.all([
    import("@/lib/graph/graph-builder"),
    import("@/lib/graph/yc-spring-2026-dataset")
  ]);
  clearGraphResponseCache();
  graphBuilder.clearTopVoiceRollupCache();

  const dataset = graphDataset.yc2026GraphDataset;
  const canonicalSnapshot = topVoices === "off"
    ? { graph: null }
    : await loadGeneratedGraphSnapshot(batchSlug, "off");
  let liveBaseOverlay: LiveEvidenceOverlayResult;
  let canonicalGraph: GraphResponse;
  if (canonicalSnapshot.graph) {
    const overlayRecords = liveEvidenceNotCapturedBySnapshot(canonicalSnapshot.graph, liveEvidenceRecords);
    liveBaseOverlay = overlayLiveEvidenceOnGraph(canonicalSnapshot.graph, overlayRecords, {
      topVoices: "off",
      calibrationCohort: dataset.companies.filter((company) => company.batchSlug === batchSlug)
    });
    canonicalGraph = liveBaseOverlay.graph;
  } else {
    const baseGraph = graphBuilder.buildGraphResponse({ batchSlug, topVoices: "off" }, dataset);
    liveBaseOverlay = overlayLiveEvidenceOnGraph(baseGraph, liveEvidenceRecords, {
      topVoices: "off",
      calibrationCohort: dataset.companies.filter((company) => company.batchSlug === batchSlug)
    });
    canonicalGraph = liveBaseOverlay.graph;
    try {
      const benchmarkRows = ensureBenchmarkMomentum(canonicalGraph).graph.fastestGaining;
      canonicalGraph = applyBenchmarkMomentumRows(canonicalGraph, benchmarkRows);
    } catch (error) {
      console.error("Graph refresh benchmark momentum failed; returning graph without persisted benchmark deltas", error);
    }
  }
  const graphWithBenchmarksBase = topVoices === "off"
    ? canonicalGraph
    : inheritCanonicalCompanyScoring(
        graphBuilder.buildGraphResponse(
          { batchSlug, topVoices },
          datasetWithLiveEvidence(dataset, liveEvidenceRecords),
          { insiderMembers: insiderConfiguration ? undefined : insiderMembers }
        ),
        canonicalGraph
      );
  const graphWithBenchmarks = topVoices === "insiders"
    ? insiderConfiguration
      ? personalizeInsiderGraphSnapshot({
          insiderGraph: graphWithBenchmarksBase,
          baseGraph: canonicalGraph,
          configuration: insiderConfiguration
        })
      : applyInsiderScenarioScoring({
          ...graphWithBenchmarksBase,
          insiderFilterOptions: (insiderMembers ?? []).map((member) => ({
            memberId: member.personId,
            displayName: member.displayName,
            weight: member.weight
          }))
        })
    : graphWithBenchmarksBase;

  return {
    overlay: topVoices === "off"
      ? {
          ...liveBaseOverlay,
          graph: graphWithBenchmarks
        }
      : overlayLiveEvidenceOnGraph(graphWithBenchmarks, liveEvidenceRecords, {
          topVoices,
          calibrationCohort: dataset.companies.filter((company) => company.batchSlug === batchSlug)
        }),
    source: "rebuild",
    fallbackReason: fallbackReason ?? "missing_or_unreadable"
  };
}

function liveEvidenceNotCapturedBySnapshot(
  graph: GraphResponse,
  records: LiveEvidenceRecord[]
): LiveEvidenceRecord[] {
  const snapshotGeneratedAt = Date.parse(graph.generatedAt);
  const snapshotEvidenceKeys = new Set(graph.evidence.map(evidenceKey));

  return records.filter((record) => {
    if (!snapshotEvidenceKeys.has(evidenceKey(record))) {
      return true;
    }
    const freshness = latestLiveEvidenceTimestamp(record);
    return freshness === null || freshness > snapshotGeneratedAt;
  });
}

function latestLiveEvidenceTimestamp(record: LiveEvidenceRecord): number | null {
  const timestamps = [
    record.last_checked_at,
    record.last_updated_at,
    record.linkCheckedAt,
    record.first_seen_at,
    record.postedAt
  ]
    .map((value) => Date.parse(value ?? ""))
    .filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : null;
}

function applyRefreshClientFilters(graph: GraphResponse, body: RefreshRequest): GraphResponse {
  const filteredGraph = applyClientGraphFilters(graph, {
    platforms: body.platforms,
    industries: body.industries,
    groupPartners: body.groupPartners,
    minScore: body.minScore
  });
  if (!body.edgeTypes.length) {
    return filteredGraph;
  }

  const selectedEdgeTypes = new Set(body.edgeTypes);
  return {
    ...filteredGraph,
    edges: filteredGraph.edges.filter((edge) => selectedEdgeTypes.has(edge.edgeType))
  };
}

async function loadGeneratedGraphSnapshot(
  batchSlug: string,
  topVoices: TopVoiceAudienceId
): Promise<SnapshotLoadResult> {
  const batchFilenames: Record<string, string> = {
    A16ZSR006: "a16zsr006",
    S2026: "s2026",
    S26: "s26"
  };
  const audienceSuffixes: Record<TopVoiceAudienceId, string> = {
    off: "",
    yc_partners: "-yc-partners",
    insiders: "-insiders"
  };
  const batchFilename = batchFilenames[batchSlug];
  const suffix = audienceSuffixes[topVoices];
  if (!batchFilename || suffix === undefined) {
    return { graph: null, fallbackReason: "unsupported_batch_or_audience" };
  }

  let snapshotText: string;
  try {
    snapshotText = await readFile(
      join(process.cwd(), "public", "graph", `${batchFilename}${suffix}.json`),
      "utf8"
    );
  } catch (error) {
    console.warn("Generated graph snapshot could not be read", { batchSlug, topVoices, error });
    return { graph: null, fallbackReason: "missing_or_unreadable" };
  }

  let snapshotValue: unknown;
  try {
    snapshotValue = JSON.parse(snapshotText) as unknown;
  } catch (error) {
    console.warn("Generated graph snapshot contains invalid JSON", { batchSlug, topVoices, error });
    return { graph: null, fallbackReason: "invalid_json" };
  }

  const parsed = graphSnapshotSchema.safeParse(snapshotValue);
  if (!parsed.success) {
    console.warn("Generated graph snapshot failed structural validation", {
      batchSlug,
      topVoices,
      issue: parsed.error.issues[0]?.message
    });
    return { graph: null, fallbackReason: "invalid_structure" };
  }

  const contract = validateStaticGraphSnapshotContract(parsed.data);
  if (!contract.ok) {
    console.warn("Generated graph snapshot failed canonical v4 contract validation", {
      batchSlug,
      topVoices,
      issue: contract.issues[0]
        ? formatStaticGraphSnapshotContractIssue(contract.issues[0])
        : "unknown canonical contract violation"
    });
    return { graph: null, fallbackReason: "invalid_structure" };
  }

  const graph = parsed.data as unknown as GraphResponse;
  const identityMatches =
    graph.mode === "official_snapshot" &&
    graph.batch.slug === batchSlug &&
    graph.selectedTopVoiceAudience.id === topVoices &&
    graph.batches.some((batch) => batch.slug === batchSlug) &&
    graph.nodes.every((node) => node.batchSlug === batchSlug);
  if (!identityMatches) {
    console.warn("Generated graph snapshot identity does not match the refresh request", {
      batchSlug,
      topVoices,
      snapshotBatchSlug: graph.batch.slug,
      snapshotTopVoices: graph.selectedTopVoiceAudience.id
    });
    return { graph: null, fallbackReason: "identity_mismatch" };
  }
  if (!generatedGraphSnapshotIsFresh(graph)) {
    console.warn("Generated graph snapshot is stale; rebuilding graph response", {
      batchSlug,
      topVoices,
      generatedAt: graph.generatedAt
    });
    return { graph: null, fallbackReason: "stale" };
  }

  return { graph };
}

function generatedGraphSnapshotIsFresh(graph: GraphResponse, now = new Date()): boolean {
  const generatedAt = new Date(graph.generatedAt);
  if (
    !Number.isFinite(generatedAt.getTime()) ||
    generatedAt.getTime() > now.getTime() + 5 * 60 * 1000 ||
    !isCurrentCentralDay(generatedAt, now)
  ) {
    return false;
  }

  const hasBenchmarkDates = graph.fastestGaining.some(
    (row) => row.dod.benchmarkedAt || row.wow.benchmarkedAt
  );
  return !hasBenchmarkDates || graphBenchmarkDatesAreFresh(graph, now);
}

function graphResolutionLog(
  resolution: GraphResolution,
  topVoices: TopVoiceAudienceId,
  liveEvidenceRecordCount: number
): string {
  if (resolution.source === "generated_public_snapshot") {
    if (topVoices !== "off" && liveEvidenceRecordCount === 0) {
      return "Live source refresh accepted no new top-voice rows; returned the generated public top-voice graph snapshot instead of rebuilding the expensive graph path.";
    }
    return "Loaded a fresh generated public graph snapshot, merged live evidence, then applied the requested client filters.";
  }
  return `Rebuilt the public graph because the generated snapshot fast path was unavailable (${resolution.fallbackReason ?? "unknown"}).`;
}

function summarizeStages(stageLog: Array<{ stage: string; platform: string }>): Record<string, number> {
  return stageLog.reduce<Record<string, number>>((counts, entry) => {
    const key = `${entry.platform}:${entry.stage}`;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function countStages(stageLog: Array<{ stage: string }>): Record<string, number> {
  return stageLog.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.stage] = (counts[entry.stage] ?? 0) + 1;
    return counts;
  }, {});
}

function attemptedPlatformsFromStages(stageLog: Array<{ stage: string; platform: string }>): Platform[] {
  return uniquePlatforms(
    stageLog
      .filter((entry) => entry.platform !== "all")
      .filter((entry) => entry.stage !== "skipped")
      .map((entry) => entry.platform)
  );
}

function unsupportedPlatformsFromStages(stageLog: Array<{ reason?: string; platform: string }>): Platform[] {
  return uniquePlatforms(
    stageLog
      .filter((entry) => entry.platform !== "all" && entry.reason === "adapter_not_wired")
      .map((entry) => entry.platform)
  );
}

function uniquePlatforms(platforms: string[]): Platform[] {
  const allowed = new Set<Platform>(PLATFORM_VALUES);
  return [...new Set(platforms)].filter((platform): platform is Platform => allowed.has(platform as Platform));
}

function countReadBackAcceptedRows(
  liveEvidenceRecords: LiveEvidenceRecord[],
  acceptedRows: LiveEvidenceRecord[]
): number {
  const readBackKeys = new Set(liveEvidenceRecords.map(evidenceKey));
  return [...new Set(acceptedRows.map(evidenceKey))].filter((key) => readBackKeys.has(key)).length;
}

function visibleEvidenceForAcceptedRows<T extends { entityId: string; platform: Platform; platformPostId?: string | null; sourceUrl: string }>(
  visibleEvidence: T[],
  acceptedRows: Array<{ entityId: string; platform: Platform; platformPostId?: string | null; sourceUrl: string }>
): T[] {
  const acceptedKeys = new Set(acceptedRows.map(evidenceKey));
  return visibleEvidence.filter((item) => acceptedKeys.has(evidenceKey(item)));
}

function hiddenEvidenceForAcceptedRows(
  hiddenEvidence: Array<{ sourceUrl: string; companyName: string; platform: Platform; reason: string }>,
  acceptedRows: LiveEvidenceRecord[],
  visibleEvidence: Array<{
    entityId: string;
    platform: Platform;
    platformPostId?: string | null;
    sourceUrl: string;
  }>
): Array<{ sourceUrl: string; companyName: string; platform: Platform; reason: string }> {
  const visibleKeys = new Set(visibleEvidence.map(evidenceKey));
  const hiddenByKey = new Map(hiddenEvidence.map((item) => [hiddenEvidenceKey(item), item]));

  return acceptedRows
    .filter((item) => !visibleKeys.has(evidenceKey(item)))
    .map((item) =>
      hiddenByKey.get(hiddenEvidenceKey(item)) ?? {
        sourceUrl: item.sourceUrl,
        companyName: item.companyName,
        platform: item.platform,
        reason: "hidden_by_client_filters"
      }
    );
}

function evidenceKey(item: { entityId: string; platform: Platform; platformPostId?: string | null; sourceUrl: string }): string {
  return `${item.entityId}:${item.platform}:${item.platformPostId ?? item.sourceUrl}`;
}

function hiddenEvidenceKey(item: { sourceUrl: string; companyName: string; platform: Platform }): string {
  return `${item.companyName}:${item.platform}:${item.sourceUrl}`;
}

type RefreshOutcomeStatus = "completed" | "partial" | "failed";

const NON_BLOCKING_REFRESH_REASONS = new Set([
  "author_handle_mismatch",
  "direct_x_url_not_batch_target",
  "direct_x_url_not_top_voice_target",
  "duplicate_accepted_live_evidence",
  "duplicate_direct_x_url",
  "founder_post_missing_company_mention",
  "invalid_direct_x_url",
  "invalid_native_x_status_url",
  "invalid_visible_metrics",
  "live_target_not_current",
  "missing_post_or_metrics",
  "no_post_id",
  "no_status_ids",
  "no_visible_metrics",
  "non_native_x_repost",
  "raw_live_record_unparseable",
  "raw_post_id_mismatch",
  "top_voice_post_missing_company_mention",
  "top_voice_recent_no_match",
  "top_voice_record_not_company_attached",
  "top_voice_target_not_current",
  "unsupported_live_platform",
  "unsupported_live_source",
  "unverified_live_record"
]);
const EXPLICITLY_REPORTED_BLOCKING_REFRESH_REASONS = new Set([
  "adapter_not_wired",
  "network_request_budget_exhausted",
  "refresh_cancelled",
  "refresh_deadline_exceeded",
  "target_cap",
  "top_voice_target_cap"
]);

function classifyRefreshOutcome(input: {
  acceptedCount: number;
  storedCount: number;
  readBackCount: number;
  visibleCount: number;
  failureReasonCounts: Record<string, number>;
  cancellationReason: LiveRefreshCancellationReason | null;
  networkRequests: number;
  networkRequestBudget: number | null;
  networkRequestBudgetExhausted: boolean;
}): { status: RefreshOutcomeStatus; errors: string[] } {
  const reasonEntries = Object.entries(input.failureReasonCounts)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1]);
  const unsupportedAdapterCount = input.failureReasonCounts.adapter_not_wired ?? 0;
  const targetCapCount = input.failureReasonCounts.target_cap ?? 0;
  const topVoiceTargetCapCount = input.failureReasonCounts.top_voice_target_cap ?? 0;
  const materialReasonEntries = reasonEntries.filter(
    ([reason]) =>
      !NON_BLOCKING_REFRESH_REASONS.has(reason) &&
      !EXPLICITLY_REPORTED_BLOCKING_REFRESH_REASONS.has(reason)
  );
  const completionErrors: string[] = [];

  if (input.cancellationReason) {
    completionErrors.push(
      `Live refresh ended with ${input.cancellationReason} before all requested work completed.`
    );
  }
  if (input.acceptedCount > input.storedCount) {
    completionErrors.push(
      `Live refresh accepted ${input.acceptedCount} row(s), but persisted only ${input.storedCount}; unpersisted rows cannot count as a completed refresh.`
    );
  }
  if (input.acceptedCount > input.readBackCount) {
    completionErrors.push(
      `Live refresh accepted ${input.acceptedCount} row(s), but only ${input.readBackCount} were read back from persisted live evidence; unverified rows cannot count as a completed refresh.`
    );
  }
  if (input.networkRequestBudgetExhausted) {
    const budget = input.networkRequestBudget === null
      ? `${input.networkRequests} request(s)`
      : `${input.networkRequests}/${input.networkRequestBudget} request(s)`;
    completionErrors.push(
      `Live refresh exhausted its network request budget after ${budget}, so some source work was not attempted.`
    );
  }
  if (targetCapCount > 0) {
    completionErrors.push(
      `Live refresh skipped ${targetCapCount} company/founder X target(s) because the target cap was reached.`
    );
  }
  if (topVoiceTargetCapCount > 0) {
    completionErrors.push(
      `Live refresh skipped ${topVoiceTargetCapCount} top-voice X target(s) because the target cap was reached.`
    );
  }
  if (unsupportedAdapterCount > 0) {
    completionErrors.push(
      `Live refresh could not run ${unsupportedAdapterCount} requested adapter stage(s) because they were not wired.`
    );
  }
  if (materialReasonEntries.length > 0) {
    const materialReasons = materialReasonEntries
      .slice(0, 8)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(", ");
    completionErrors.push(
      `Live refresh reported material provider, storage, or execution failure reason(s): ${materialReasons}.`
    );
  }

  if (input.acceptedCount > 0 && input.visibleCount > 0 && completionErrors.length === 0) {
    return { status: "completed", errors: [] };
  }

  if (input.acceptedCount > 0 && input.visibleCount > 0) {
    return {
      status: "partial",
      errors: completionErrors
    };
  }

  if (input.acceptedCount > 0) {
    return {
      status: "partial",
      errors: [
        `Live refresh accepted ${input.acceptedCount} row(s), but none were visible after the active batch/filter/top-voice graph was rebuilt.`,
        ...completionErrors
      ]
    };
  }

  if (input.cancellationReason) {
    return {
      status: "failed",
      errors: [
        `Live refresh ended with ${input.cancellationReason} without accepted evidence.`,
        ...completionErrors
      ]
    };
  }

  if (input.networkRequestBudgetExhausted && reasonEntries.length === 0) {
    return {
      status: "failed",
      errors: [
        "Live refresh exhausted its network request budget without accepted evidence.",
        ...completionErrors
      ]
    };
  }

  if (reasonEntries.length) {
    const topReasons = reasonEntries.slice(0, 4).map(([reason, count]) => `${reason}:${count}`).join(", ");
    return {
      status: "failed",
      errors: [
        `Live refresh finished without accepted evidence. Top reasons: ${topReasons}.`,
        ...completionErrors
      ]
    };
  }

  return {
    status: "failed",
    errors: ["Live refresh finished without accepted evidence and did not report a provider reason."]
  };
}

function normalizeRefreshCancellationReason(
  cancellationReason: LiveRefreshCancellationReason | null | undefined,
  failureReasonCounts: Record<string, number>
): LiveRefreshCancellationReason | null {
  if (cancellationReason) {
    return cancellationReason;
  }
  if ((failureReasonCounts.refresh_deadline_exceeded ?? 0) > 0) {
    return "refresh_deadline_exceeded";
  }
  if ((failureReasonCounts.refresh_cancelled ?? 0) > 0) {
    return "refresh_cancelled";
  }
  return null;
}

function sortLiveRecordsNewestFirst(left: { postedAt: string | null; last_checked_at: string }, right: { postedAt: string | null; last_checked_at: string }) {
  return Date.parse(right.postedAt ?? right.last_checked_at) - Date.parse(left.postedAt ?? left.last_checked_at);
}

function sortEvidenceNewestFirst(left: { postedAt: string; last_checked_at?: string }, right: { postedAt: string; last_checked_at?: string }) {
  return Date.parse(right.postedAt ?? right.last_checked_at ?? "") - Date.parse(left.postedAt ?? left.last_checked_at ?? "");
}
