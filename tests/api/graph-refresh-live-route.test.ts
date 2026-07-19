import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveEvidenceRecordToEvidenceItem } from "@/lib/graph/live-evidence-overlay";
import { TRACTION_SCORING_CONFIG } from "@/lib/graph/traction-scoring-config";
import type { GraphResponse } from "@/lib/graph/types";
import type { LiveEvidenceRecord, LiveSourceRefreshResult } from "@/lib/ingestion/live-source-refresh";

const generatedSnapshotRoots: string[] = [];
const FROZEN_ROUTE_NOW = "2026-07-20T20:50:00.000Z";
const FROZEN_ROUTE_NOW_PLUS_ONE_MS = "2026-07-20T20:50:00.001Z";
const FROZEN_SNAPSHOT_GENERATED_AT = "2026-07-20T20:45:00.000Z";
const FROZEN_STALE_SNAPSHOT_GENERATED_AT = "2026-07-20T04:00:00.000Z";

function jsonRequest(
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal
): Request {
  return new Request("http://localhost/api/graph/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal
  });
}

function rawRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/graph/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body
  });
}

function streamingRequest(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Request {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal,
    duplex: "half"
  };
  return new Request("http://localhost/api/graph/refresh", init);
}

function neverClosingBody(...chunks: Uint8Array[]): {
  stream: ReadableStream<Uint8Array>;
  cancel: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  return {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
      },
      cancel
    }),
    cancel
  };
}

describe("POST /api/graph/refresh live evidence validation", () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("@/lib/graph/graph-builder");
    vi.doUnmock("@/lib/graph/yc-spring-2026-dataset");
    vi.doUnmock("@/lib/ingestion/live-source-refresh");
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
    await Promise.all(
      generatedSnapshotRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it("returns 400 for malformed JSON without starting a refresh", async () => {
    const runLiveSourceRefresh = vi.fn();
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh
    }));

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(rawRequest('{"action":"refresh"'));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("malformed_json");
    expect(body.errors).toEqual(["Request body must be valid JSON."]);
    expect(runLiveSourceRefresh).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid body, platform, audience, and source target scopes", async () => {
    const testCases = [
      {
        name: "unknown body fields",
        body: { action: "refresh", unexpected: true },
        errorPath: "body"
      },
      {
        name: "unknown platforms",
        body: { action: "refresh", platforms: ["myspace"] },
        errorPath: "platforms.0"
      },
      {
        name: "unknown audiences",
        body: { action: "refresh", topVoices: "everyone" },
        errorPath: "topVoices"
      },
      {
        name: "non-X source URLs",
        body: { action: "refresh", platforms: ["x"], sourceUrls: ["https://example.com/status/2077045452579778664"] },
        errorPath: "sourceUrls.0"
      },
      {
        name: "source URLs outside the selected platform scope",
        body: {
          action: "refresh",
          platforms: ["github"],
          sourceUrls: ["https://x.com/screenpipe/status/2077045452579778664"]
        },
        errorPath: "sourceUrls"
      },
      {
        name: "too many direct source targets",
        body: {
          action: "refresh",
          platforms: ["x"],
          sourceUrls: Array.from(
            { length: 21 },
            (_, index) => `https://x.com/screenpipe/status/${20_000_000_000 + index}`
          )
        },
        errorPath: "sourceUrls"
      }
    ];
    const { POST } = await import("../../src/app/api/graph/refresh/route");

    for (const testCase of testCases) {
      const response = await POST(jsonRequest(testCase.body));
      const body = await response.json();

      expect(response.status, testCase.name).toBe(400);
      expect(body.error.code, testCase.name).toBe("invalid_request");
      expect(body.errors.join(" "), testCase.name).toContain(testCase.errorPath);
    }
  });

  it("returns 413 before parsing a request body over the byte limit", async () => {
    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(rawRequest(JSON.stringify({ padding: "x".repeat(70_000) })));
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.error.code).toBe("request_body_too_large");
  });

  it("returns 408 when a request body stream never closes, without awaiting hostile cancellation", async () => {
    vi.useFakeTimers();
    const runLiveSourceRefresh = vi.fn();
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh
    }));
    const { stream, cancel } = neverClosingBody(
      new TextEncoder().encode('{"action":"refresh"}')
    );

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const responsePromise = POST(streamingRequest(stream));
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await responsePromise;
    const body = await response.json();

    expect(response.status).toBe(408);
    expect(body.error.code).toBe("request_body_timed_out");
    expect(body.errors.join(" ")).toContain("not received within");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(runLiveSourceRefresh).not.toHaveBeenCalled();
  });

  it("returns 400 when the request is aborted while its body stream remains open", async () => {
    const runLiveSourceRefresh = vi.fn();
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh
    }));
    const requestController = new AbortController();
    const { stream, cancel } = neverClosingBody(
      new TextEncoder().encode('{"action":"refresh"}')
    );

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const responsePromise = POST(streamingRequest(stream, requestController.signal));
    requestController.abort(new DOMException("Client disconnected", "AbortError"));
    const response = await responsePromise;
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("request_body_aborted");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(runLiveSourceRefresh).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized streaming body even when it has no content length and never closes", async () => {
    const runLiveSourceRefresh = vi.fn();
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh
    }));
    const { stream, cancel } = neverClosingBody(new Uint8Array(70_000));

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(streamingRequest(stream));
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.error.code).toBe("request_body_too_large");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(runLiveSourceRefresh).not.toHaveBeenCalled();
  });

  it("returns 415 for a non-JSON content type", async () => {
    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(rawRequest("action=refresh", { "content-type": "text/plain" }));
    const body = await response.json();

    expect(response.status).toBe(415);
    expect(body.error.code).toBe("unsupported_media_type");
  });

  it("fails closed without a production secret while leaving unconfigured development usable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GRAPH_REFRESH_SECRET", "");
    vi.stubEnv("REFRESH_SECRET", "");

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh" }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("refresh_secret_not_configured");

    vi.stubEnv("NODE_ENV", "development");
    const developmentResponse = await POST(rawRequest('{"action":"refresh"'));
    const developmentBody = await developmentResponse.json();
    expect(developmentResponse.status).toBe(400);
    expect(developmentBody.error.code).toBe("malformed_json");
  });

  it("requires a configured secret outside local development and normalizes bounded direct targets", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("GRAPH_REFRESH_SECRET", "route-test-secret");
    const runLiveSourceRefresh = vi.fn(async () => emptyRefreshResult());
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh,
      loadLiveEvidenceRecords: vi.fn(async () => [])
    }));

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const unauthorized = await POST(jsonRequest({ action: "refresh", platforms: ["x"] }));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("Bearer");

    const response = await POST(jsonRequest(
      {
        action: "refresh",
        platforms: ["x"],
        sourceUrls: ["https://twitter.com/ScreenPipe/status/2077045452579778664?s=20"]
      },
      { authorization: "Bearer route-test-secret" }
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(runLiveSourceRefresh).toHaveBeenCalledWith(expect.objectContaining({
      xSourceUrls: ["https://x.com/screenpipe/status/2077045452579778664"],
      maxXTargets: 219,
      maxTopVoiceXTargets: 219
    }));
    expect(body.refreshSummary).toMatchObject({
      stageCounts: { task_created: 1, dropped: 1 },
      stageSummary: { "all:task_created": 1, "x:dropped": 1 },
      targetScope: {
        directSourceUrlCount: 1,
        maxSourceUrls: 20,
        profileTargetLimit: 219,
        totalTargetLimit: 220
      },
      timings: {
        liveRefreshMs: expect.any(Number),
        graphMs: expect.any(Number),
        totalMs: expect.any(Number)
      }
    });
    expect(body.refreshRequest.disposition).toBe("executed");
  });

  it("keeps loopback development refresh usable without exposing or sending the configured secret", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("GRAPH_REFRESH_SECRET", "server-only-development-secret");
    const runLiveSourceRefresh = vi.fn(async () => emptyRefreshResult());
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh
    }));

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", platforms: ["x"] }));

    expect(response.status).toBe(200);
    expect(runLiveSourceRefresh).toHaveBeenCalledTimes(1);
  });

  it("fails before source scanning when local production would use process-local persistence", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("GRAPH_REFRESH_SECRET", "route-test-secret");
    const runLiveSourceRefresh = vi.fn();
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh
    }));

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(
      jsonRequest(
        { action: "refresh", platforms: ["x"] },
        { authorization: "Bearer route-test-secret" }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("refresh_storage_not_configured");
    expect(runLiveSourceRefresh).not.toHaveBeenCalled();
  });

  it("forwards request cancellation to ingestion and never reports a completed refresh", async () => {
    const requestController = new AbortController();
    const refreshStarted = deferred<void>();
    let ingestionSignal: AbortSignal | undefined;
    const runLiveSourceRefresh = vi.fn((options: { signal?: AbortSignal }) => {
      ingestionSignal = options.signal;
      refreshStarted.resolve(undefined);
      return new Promise<LiveSourceRefreshResult>((_resolve, reject) => {
        const rejectForAbort = () => reject(
          options.signal?.reason ?? new DOMException("Request cancelled", "AbortError")
        );
        if (options.signal?.aborted) {
          rejectForAbort();
          return;
        }
        options.signal?.addEventListener("abort", rejectForAbort, { once: true });
      });
    });
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const responsePromise = POST(jsonRequest(
      { action: "refresh", platforms: ["x"] },
      {},
      requestController.signal
    ));
    await refreshStarted.promise;
    requestController.abort(new DOMException("Client disconnected", "AbortError"));

    const response = await responsePromise;
    const body = await response.json();

    expect(ingestionSignal).toBeDefined();
    expect(ingestionSignal).not.toBe(requestController.signal);
    expect(ingestionSignal?.aborted).toBe(true);
    expect(response.status).toBe(499);
    expect(body).toMatchObject({
      status: "failed",
      error: { code: "refresh_cancelled" },
      refreshSummary: { status: "failed", cancellationReason: "refresh_cancelled" }
    });
    expect(JSON.stringify(body)).not.toContain('"status":"completed"');
  });

  it("times out identical joiners, aborts ingestion, releases the slot, and permits a later refresh", async () => {
    vi.useFakeTimers();
    let invocation = 0;
    let firstSignal: AbortSignal | undefined;
    const runLiveSourceRefresh = vi.fn((options: { signal?: AbortSignal }) => {
      invocation += 1;
      if (invocation > 1) {
        return Promise.resolve(emptyRefreshResult());
      }
      firstSignal = options.signal;
      return new Promise<ReturnType<typeof emptyRefreshResult>>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      });
    });
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh
    }));

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const requestBody = { action: "refresh", platforms: ["x"] };
    const firstResponsePromise = POST(jsonRequest(requestBody));
    await vi.waitFor(() => expect(runLiveSourceRefresh).toHaveBeenCalledTimes(1));
    const joinedResponsePromise = POST(jsonRequest(requestBody));

    await vi.advanceTimersByTimeAsync(40_000);
    const [firstResponse, joinedResponse] = await Promise.all([firstResponsePromise, joinedResponsePromise]);
    const [firstBody, joinedBody] = await Promise.all([firstResponse.json(), joinedResponse.json()]);

    expect(firstSignal?.aborted).toBe(true);
    expect(firstResponse.status).toBe(504);
    expect(joinedResponse.status).toBe(504);
    expect(firstBody.error.code).toBe("refresh_timed_out");
    expect(joinedBody.error.code).toBe("refresh_timed_out");
    expect(joinedBody.refreshRequest.disposition).toBe("joined");

    await vi.runAllTicks();
    const nextResponse = await POST(jsonRequest({ action: "refresh", platforms: ["x"], minScore: 1 }));
    expect(nextResponse.status).toBe(200);
    expect(runLiveSourceRefresh).toHaveBeenCalledTimes(2);
  });

  it("joins an identical in-flight refresh instead of running ingestion twice", async () => {
    const refreshGate = deferred<ReturnType<typeof emptyRefreshResult>>();
    const runLiveSourceRefresh = vi.fn(() => refreshGate.promise);
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh,
      loadLiveEvidenceRecords: vi.fn(async () => [])
    }));

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const firstResponsePromise = POST(jsonRequest({ action: "refresh", platforms: ["x"] }));
    await vi.waitFor(() => expect(runLiveSourceRefresh).toHaveBeenCalledTimes(1));
    const joinedResponsePromise = POST(jsonRequest({ platforms: ["x"], action: "refresh" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runLiveSourceRefresh).toHaveBeenCalledTimes(1);

    refreshGate.resolve(emptyRefreshResult());
    const [firstResponse, joinedResponse] = await Promise.all([firstResponsePromise, joinedResponsePromise]);
    const [firstBody, joinedBody] = await Promise.all([firstResponse.json(), joinedResponse.json()]);

    expect(firstResponse.status).toBe(200);
    expect(joinedResponse.status).toBe(200);
    expect(runLiveSourceRefresh).toHaveBeenCalledTimes(1);
    expect(firstBody.runId).toBe(joinedBody.runId);
    expect(firstBody.refreshRequest.disposition).toBe("executed");
    expect(joinedBody.refreshRequest.disposition).toBe("joined");
    expect(joinedBody.refreshRequest.idempotencyKey).toBe(firstBody.refreshRequest.idempotencyKey);
  });

  it("returns 429 for a different request while a refresh is in flight", async () => {
    const refreshGate = deferred<ReturnType<typeof emptyRefreshResult>>();
    const runLiveSourceRefresh = vi.fn(() => refreshGate.promise);
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh,
      loadLiveEvidenceRecords: vi.fn(async () => [])
    }));

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const activeResponsePromise = POST(jsonRequest({ action: "refresh", platforms: ["x"] }));
    await vi.waitFor(() => expect(runLiveSourceRefresh).toHaveBeenCalledTimes(1));

    const rejectedResponse = await POST(jsonRequest({ action: "ingest", platforms: ["x"] }));
    const rejectedBody = await rejectedResponse.json();
    expect(rejectedResponse.status).toBe(429);
    expect(rejectedResponse.headers.get("retry-after")).toBe("5");
    expect(rejectedBody.error.code).toBe("refresh_in_progress");
    expect(rejectedBody.refreshRequest.disposition).toBe("rejected_in_flight");

    refreshGate.resolve(emptyRefreshResult());
    await activeResponsePromise;
    expect(runLiveSourceRefresh).toHaveBeenCalledTimes(1);
  });

  it("contains unexpected refresh failures as structured 500 responses", async () => {
    const runLiveSourceRefresh = vi.fn(async () => {
      throw new Error("provider exploded");
    });
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh
    }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", platforms: ["x"] }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.error.code).toBe("refresh_failed");
    expect(body.refreshSummary).toMatchObject({
      status: "failed",
      stageCounts: {},
      stageSummary: {},
      timings: {
        liveRefreshMs: expect.any(Number),
        graphMs: 0,
        totalMs: expect.any(Number)
      }
    });
    expect(body.refreshRequest.disposition).toBe("executed");
  });

  it("returns a refresh summary proving newest live evidence was ingested and made visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_ROUTE_NOW));
    await mockV4GeneratedSnapshot("s26.json");
    const record = screenpipeRecord();
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>();
      return {
        ...actual,
        runLiveSourceRefresh: vi.fn(async () => ({
          ...emptyRefreshResult(),
          runId: "test-live-refresh",
          generatedAt: "2026-07-14T17:00:00.000Z",
          acceptedEvidence: [record],
          storedEvidence: [record],
          stageLog: [
            {
              stage: "accepted",
              platform: "x",
              sourceUrl: record.sourceUrl,
              companyName: record.companyName,
              message: "Accepted Screenpipe test post.",
              at: "2026-07-14T17:00:00.000Z"
            }
          ],
          sourceSnapshots: {
            targetedEvidencePath: "test-targeted.json",
            targetedEvidenceBefore: 0,
            targetedEvidenceAfter: 1
          },
          platformRows: { x: 1 },
          failureReasonCounts: {}
        })),
        loadLiveEvidenceRecords: vi.fn(async () => [record])
      };
    });
    const buildGraphResponse = vi.fn(() => {
      throw new Error("fresh snapshot fast path must not rebuild the graph");
    });
    vi.doMock("@/lib/graph/graph-builder", () => ({
      buildGraphResponse,
      clearTopVoiceRollupCache: vi.fn()
    }));

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({
      action: "refresh",
      batchSlug: "S26",
      platforms: ["x"],
      edgeTypes: ["same_group_partner"]
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(buildGraphResponse).not.toHaveBeenCalled();
    expect(body.status).toBe("completed");
    expect(body.errors).toEqual([]);
    expect(body.refreshSummary).toMatchObject({
      status: "completed",
      requestedPlatforms: ["x"],
      attemptedPlatforms: ["x"],
      unsupportedPlatforms: [],
      acceptedRows: 1,
      storedRows: 1,
      readBackRows: 1,
      visibleRows: 1,
      graphSource: "generated_public_snapshot",
      fastPath: "generated_public_snapshot",
      appliedFilters: {
        platforms: ["x"],
        edgeTypes: ["same_group_partner"]
      }
    });
    expect(body.refreshSummary.newestIngestedEvidence[0]).toMatchObject({
      companyName: "screenpipe",
      platform: "x",
      sourceUrl: "https://x.com/screenpipe/status/2077045452579778664"
    });
    expect(body.refreshSummary.newestVisibleEvidence[0]).toMatchObject({
      companyName: "screenpipe",
      platform: "x",
      sourceUrl: "https://x.com/screenpipe/status/2077045452579778664"
    });
    expect(JSON.stringify(body.graph)).toContain("2077045452579778664");
    expect(body.graph.edges.every((edge: { edgeType: string }) => edge.edgeType === "same_group_partner")).toBe(true);
  });

  it.each([
    { reason: "http_500", label: "provider HTTP failure" },
    { reason: "verified_social_overrides_read_failed", label: "verified override storage failure" }
  ])("returns partial with surfaced reasons when accepted visible rows coexist with a $label", async ({ reason }) => {
    await mockV4GeneratedSnapshot("s26.json");
    const record = screenpipeRecord();
    const refreshResult = refreshResultWithRecord(record, {
      failureReasonCounts: { [reason]: 1 }
    });
    refreshResult.stageLog.push({
      stage: "dropped",
      platform: "x",
      reason,
      message: `Adversarial material failure: ${reason}.`,
      at: FROZEN_ROUTE_NOW
    });
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh: vi.fn(async () => refreshResult),
      loadLiveEvidenceRecords: vi.fn(async () => [record])
    }));

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", batchSlug: "S26", platforms: ["x"] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("partial");
    expect(body.refreshSummary).toMatchObject({
      status: "partial",
      acceptedRows: 1,
      storedRows: 1,
      readBackRows: 1,
      visibleRows: 1,
      failureReasonCounts: { [reason]: 1 }
    });
    expect(body.errors.join(" ")).toContain(reason);
    expect(body.errors).not.toEqual([]);
    expect(body.logs[0]).not.toContain(" completed ");
  });

  it("keeps expected per-target drops nonblocking when persisted accepted evidence is visible", async () => {
    await mockV4GeneratedSnapshot("s26.json");
    const record = screenpipeRecord();
    const refreshResult = refreshResultWithRecord(record, {
      failureReasonCounts: { no_status_ids: 4 }
    });
    refreshResult.stageLog.push({
      stage: "dropped",
      platform: "x",
      reason: "no_status_ids",
      count: 4,
      message: "Four other targets exposed no post-level status IDs.",
      at: FROZEN_ROUTE_NOW
    });
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh: vi.fn(async () => refreshResult),
      loadLiveEvidenceRecords: vi.fn(async () => [record])
    }));

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", batchSlug: "S26", platforms: ["x"] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("completed");
    expect(body.errors).toEqual([]);
    expect(body.refreshSummary).toMatchObject({
      status: "completed",
      acceptedRows: 1,
      storedRows: 1,
      readBackRows: 1,
      visibleRows: 1,
      failureReasonCounts: { no_status_ids: 4 }
    });
  });

  it("fails closed when persisted evidence cannot be reloaded after refresh", async () => {
    const record = screenpipeRecord();
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh: vi.fn(async () => refreshResultWithRecord(record)),
      loadLiveEvidenceRecords: vi.fn(async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      })
    }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", batchSlug: "S26", platforms: ["x"] }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("refresh_persisted_evidence_reload_failed");
    expect(body.errors.join(" ")).toContain("persisted_live_evidence_reload_failed");
    expect(body.refreshSummary).toMatchObject({
      status: "failed",
      acceptedRows: 1,
      storedRows: 1,
      readBackRows: 0,
      visibleRows: 0,
      failureReasonCounts: { persisted_live_evidence_reload_failed: 1 }
    });
    expect(body.graph).toBeUndefined();
  });

  it("does not claim completion when a visible snapshot row was not read back from live persistence", async () => {
    await mockV4GeneratedSnapshot("s26.json");
    const record = screenpipeRecord();
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh: vi.fn(async () => refreshResultWithRecord(record)),
      loadLiveEvidenceRecords: vi.fn(async () => [])
    }));

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", batchSlug: "S26", platforms: ["x"] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("partial");
    expect(body.refreshSummary).toMatchObject({
      status: "partial",
      acceptedRows: 1,
      storedRows: 1,
      readBackRows: 0,
      visibleRows: 1
    });
    expect(body.errors.join(" ")).toContain("only 0 were read back");
    expect(body.logs[0]).not.toContain(" completed ");
  });

  it("returns partial when accepted visible evidence was not persisted", async () => {
    await mockV4GeneratedSnapshot("s26.json");
    const record = screenpipeRecord();
    const runLiveSourceRefresh = vi.fn(async () => refreshResultWithRecord(record, {
      storedEvidence: [],
      sourceSnapshots: {
        targetedEvidencePath: "test-targeted.json",
        targetedEvidenceBefore: 1,
        targetedEvidenceAfter: 1
      }
    }));
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh,
      loadLiveEvidenceRecords: vi.fn(async () => [record])
    }));

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", batchSlug: "S26", platforms: ["x"] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("partial");
    expect(body.refreshSummary).toMatchObject({
      status: "partial",
      acceptedRows: 1,
      storedRows: 0,
      visibleRows: 1
    });
    expect(body.errors.join(" ")).toContain("persisted only 0");
    expect(body.logs[0]).toContain("finished with partial results");
    expect(body.logs[0]).not.toContain(" completed ");
  });

  it.each([
    {
      label: "company target cap",
      reason: "target_cap",
      failureReasonCounts: { target_cap: 7, top_voice_target_cap: 0 },
      networkRequestBudgetExhausted: false,
      expectedError: "target cap"
    },
    {
      label: "top-voice target cap",
      reason: "top_voice_target_cap",
      failureReasonCounts: { target_cap: 0, top_voice_target_cap: 3 },
      networkRequestBudgetExhausted: false,
      expectedError: "target cap"
    },
    {
      label: "network request budget",
      reason: "network_request_budget_exhausted",
      failureReasonCounts: { target_cap: 0, top_voice_target_cap: 0 },
      networkRequestBudgetExhausted: true,
      expectedError: "network request budget"
    },
    {
      label: "live refresh deadline cancellation",
      reason: "refresh_deadline_exceeded",
      failureReasonCounts: { target_cap: 0, top_voice_target_cap: 0 },
      networkRequestBudgetExhausted: false,
      expectedError: "refresh_deadline_exceeded"
    }
  ])("returns partial instead of completed after $label", async ({
    reason,
    failureReasonCounts,
    networkRequestBudgetExhausted,
    expectedError
  }) => {
    await mockV4GeneratedSnapshot("s26.json");
    const record = screenpipeRecord();
    const refreshResult = refreshResultWithRecord(record, {
      cancellationReason: reason === "refresh_deadline_exceeded" ? "refresh_deadline_exceeded" : null,
      networkRequests: networkRequestBudgetExhausted ? 100 : 8,
      networkRequestBudgetExhausted,
      failureReasonCounts
    });
    refreshResult.stageLog.push({
      stage: "skipped",
      platform: reason === "network_request_budget_exhausted" ? "all" : "x",
      count: 1,
      reason,
      message: `Test run stopped early because of ${reason}.`,
      at: FROZEN_ROUTE_NOW
    });
    const runLiveSourceRefresh = vi.fn(async () => refreshResult);
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh,
      loadLiveEvidenceRecords: vi.fn(async () => [record])
    }));

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", batchSlug: "S26", platforms: ["x"] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("partial");
    expect(body.refreshSummary).toMatchObject({
      status: "partial",
      acceptedRows: 1,
      storedRows: 1,
      visibleRows: 1,
      networkRequestBudgetExhausted
    });
    expect(body.errors.join(" ")).toContain(expectedError);
    expect(body.logs[0]).not.toContain(" completed ");
  });

  it("uses the matching fresh top-voice snapshot when no live evidence needs rebuilding", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_ROUTE_NOW));
    await mockV4GeneratedSnapshot("s26-insiders.json");
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh: vi.fn(async () => emptyRefreshResult()),
      loadLiveEvidenceRecords: vi.fn(async () => [])
    }));
    const buildGraphResponse = vi.fn(() => {
      throw new Error("fresh top-voice snapshot fast path must not rebuild the graph");
    });
    vi.doMock("@/lib/graph/graph-builder", () => ({
      buildGraphResponse,
      clearTopVoiceRollupCache: vi.fn()
    }));

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({
      action: "refresh",
      batchSlug: "S26",
      platforms: ["x"],
      topVoices: "insiders"
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(buildGraphResponse).not.toHaveBeenCalled();
    expect(body.graph.selectedTopVoiceAudience.id).toBe("insiders");
    expect(body.refreshSummary).toMatchObject({
      graphSource: "generated_public_snapshot",
      fastPath: "static_top_voice_noop"
    });
  });

  it("lets live top-voice evidence participate in the top-voice graph instead of being hidden after filtering", async () => {
    const record = insiderScreenpipeRecord();
    await mockV4GeneratedSnapshot("s26-insiders.json");
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>();
      return {
        ...actual,
        runLiveSourceRefresh: vi.fn(async () => ({
          ...emptyRefreshResult(),
          runId: "test-live-insider-refresh",
          generatedAt: "2026-07-14T17:10:00.000Z",
          acceptedEvidence: [record],
          storedEvidence: [record],
          stageLog: [
            {
              stage: "accepted",
              platform: "x",
              sourceUrl: record.sourceUrl,
              companyName: record.companyName,
              message: "Accepted Sam Altman mentioning Screenpipe.",
              at: "2026-07-14T17:10:00.000Z"
            }
          ],
          sourceSnapshots: {
            targetedEvidencePath: "test-targeted.json",
            targetedEvidenceBefore: 0,
            targetedEvidenceAfter: 1
          },
          platformRows: { x: 1 },
          failureReasonCounts: {}
        })),
        loadLiveEvidenceRecords: vi.fn(async () => [record])
      };
    });

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", batchSlug: "S26", platforms: ["x"], topVoices: "insiders" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.graph.selectedTopVoiceAudience.id).toBe("insiders");
    expect(body.refreshSummary).toMatchObject({
      graphSource: "rebuild",
      snapshotFallbackReason: "top_voice_live_evidence_requires_rebuild"
    });
    expect(body.graph.nodes.some((node: { entityId: string }) => node.entityId === "company-screenpipe")).toBe(true);
    expect(body.graph.evidence[0]).toMatchObject({
      sourceUrl: "https://x.com/sama/status/2077000000000000001",
      attachedCompanyName: "screenpipe",
      topVoice: expect.objectContaining({
        displayName: "Sam Altman",
        audienceId: "insiders"
      })
    });
    expect(body.refreshSummary.newestVisibleEvidence[0]).toMatchObject({
      companyName: "screenpipe",
      platform: "x",
      sourceUrl: "https://x.com/sama/status/2077000000000000001"
    });
  });

  it("does not replace existing live top-voice evidence with the static no-op snapshot", async () => {
    const record = insiderScreenpipeRecord();
    const rebuiltGraph = await insiderGraphWithRecord(record);
    await mockV4GeneratedSnapshot("s26-insiders.json");
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>();
      return {
        ...actual,
        runLiveSourceRefresh: vi.fn(async () => ({
          ...emptyRefreshResult(),
          runId: "test-live-insider-no-new-rows",
          generatedAt: "2026-07-14T17:12:00.000Z",
          acceptedEvidence: [],
          storedEvidence: [],
          stageLog: [
            {
              stage: "dropped",
              platform: "x",
              target: "sama",
              sourceUrl: "https://x.com/sama",
              reason: "top_voice_recent_no_match",
              message: "No new matching insider post was found.",
              at: "2026-07-14T17:12:00.000Z"
            }
          ],
          sourceSnapshots: {
            targetedEvidencePath: "test-targeted.json",
            targetedEvidenceBefore: 1,
            targetedEvidenceAfter: 1
          },
          platformRows: {},
          failureReasonCounts: { top_voice_recent_no_match: 1 }
        })),
        loadLiveEvidenceRecords: vi.fn(async () => [record])
      };
    });
    const buildGraphResponse = vi.fn(() => rebuiltGraph);
    mockFallbackGraphModules(buildGraphResponse);

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", batchSlug: "S26", platforms: ["x"], topVoices: "insiders" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(buildGraphResponse).toHaveBeenCalledTimes(2);
    expect(body.refreshSummary.fastPath).toBeUndefined();
    expect(body.refreshSummary).toMatchObject({
      graphSource: "rebuild",
      snapshotFallbackReason: "top_voice_live_evidence_requires_rebuild"
    });
    expect(body.graph.nodes.some((node: { entityId: string }) => node.entityId === "company-screenpipe")).toBe(true);
    expect(JSON.stringify(body.graph.evidence)).toContain("2077000000000000001");
  });

  it("rebuilds safely for missing, stale, legacy, incomplete, and invalid generated snapshots", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_ROUTE_NOW));
    const rebuiltGraph = withV4SnapshotContract(await graphFixture("s26-insiders.json"));
    const staleGeneratedAt = FROZEN_STALE_SNAPSHOT_GENERATED_AT;
    const staleGraph: GraphResponse = {
      ...rebuiltGraph,
      generatedAt: staleGeneratedAt,
      scoringContext: { ...rebuiltGraph.scoringContext!, responseBuiltAt: staleGeneratedAt }
    };
    const legacyGraph = structuredClone(rebuiltGraph);
    legacyGraph.scoringContext!.modelId = "traction-score";
    for (const node of legacyGraph.nodes) {
      node.scoreBreakdown!.modelId = "traction-score";
    }
    const incompleteBreakdownGraph = structuredClone(rebuiltGraph);
    delete (incompleteBreakdownGraph.nodes[0]!.scoreBreakdown as { calibration?: unknown }).calibration;
    const contradictoryGraph = structuredClone(rebuiltGraph);
    contradictoryGraph.nodes[0]!.scoreBreakdown!.totalScore = contradictoryGraph.nodes[0]!.score === 100
      ? 99
      : contradictoryGraph.nodes[0]!.score + 1;
    const temporaryRoot = await mkdtemp(join(tmpdir(), "returner-fund-refresh-route-"));
    const snapshotDirectory = join(temporaryRoot, "public", "graph");
    const snapshotPath = join(snapshotDirectory, "s26-insiders.json");
    await mkdir(snapshotDirectory, { recursive: true });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(temporaryRoot);
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh: vi.fn(async () => emptyRefreshResult()),
      loadLiveEvidenceRecords: vi.fn(async () => [])
    }));
    const buildGraphResponse = vi.fn(() => rebuiltGraph);
    mockFallbackGraphModules(buildGraphResponse);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const fallbackCases = [
      { label: "missing", reason: "missing_or_unreadable", snapshot: null },
      { label: "stale", reason: "stale", snapshot: JSON.stringify(staleGraph) },
      { label: "legacy model", reason: "invalid_structure", snapshot: JSON.stringify(legacyGraph) },
      {
        label: "incomplete v4 breakdown",
        reason: "invalid_structure",
        snapshot: JSON.stringify(incompleteBreakdownGraph)
      },
      {
        label: "contradictory v4 score",
        reason: "invalid_structure",
        snapshot: JSON.stringify(contradictoryGraph)
      },
      { label: "invalid JSON", reason: "invalid_json", snapshot: "{not-json" }
    ] as const;

    try {
      for (const fallbackCase of fallbackCases) {
        if (fallbackCase.snapshot !== null) {
          await writeFile(snapshotPath, fallbackCase.snapshot, "utf8");
        }
        const response = await POST(jsonRequest({
          action: "refresh",
          batchSlug: "S26",
          platforms: ["x"],
          topVoices: "insiders"
        }));
        const body = await response.json();

        expect(response.status, fallbackCase.label).toBe(200);
        expect(body.refreshSummary.fastPath, fallbackCase.label).toBeUndefined();
        expect(body.refreshSummary, fallbackCase.label).toMatchObject({
          graphSource: "rebuild",
          snapshotFallbackReason: fallbackCase.reason
        });
        expect(body.logs.join(" ")).not.toContain("returned the generated public top-voice graph snapshot");
      }
    } finally {
      cwd.mockRestore();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
    expect(buildGraphResponse).toHaveBeenCalledTimes(fallbackCases.length * 2);
  });

  it("returns failed when live refresh completes without accepted evidence", async () => {
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>();
      return {
        ...actual,
        runLiveSourceRefresh: vi.fn(async () => ({
          ...emptyRefreshResult(),
          runId: "test-empty-live-refresh",
          generatedAt: "2026-07-14T17:20:00.000Z",
          acceptedEvidence: [],
          storedEvidence: [],
          stageLog: [
            {
              stage: "dropped",
              platform: "x",
              target: "screenpipe",
              reason: "no_status_ids",
              sourceUrl: "https://x.com/screenpipe",
              message: "No post-level X status URLs were visible.",
              at: "2026-07-14T17:20:00.000Z"
            }
          ],
          sourceSnapshots: {
            targetedEvidencePath: "test-targeted.json",
            targetedEvidenceBefore: 0,
            targetedEvidenceAfter: 0
          },
          platformRows: {},
          failureReasonCounts: {
            no_status_ids: 1
          }
        })),
        loadLiveEvidenceRecords: vi.fn(async () => [])
      };
    });

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", batchSlug: "S26", platforms: ["x"] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("failed");
    expect(body.errors[0]).toContain("Live refresh finished without accepted evidence");
    expect(body.refreshSummary).toMatchObject({
      status: "failed",
      requestedPlatforms: ["x"],
      attemptedPlatforms: ["x"],
      unsupportedPlatforms: [],
      acceptedRows: 0,
      storedRows: 0,
      visibleRows: 0
    });
    expect(body.refreshSummary.failureReasonCounts).toMatchObject({ no_status_ids: 1 });
  });

  it("returns failed and reports unsupported platforms when no requested adapter is wired", async () => {
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>();
      return {
        ...actual,
        runLiveSourceRefresh: vi.fn(async () => ({
          ...emptyRefreshResult(),
          runId: "test-unsupported-live-refresh",
          generatedAt: "2026-07-14T17:25:00.000Z",
          acceptedEvidence: [],
          storedEvidence: [],
          stageLog: [
            {
              stage: "skipped",
              platform: "github",
              reason: "adapter_not_wired",
              message: "GitHub real-time adapter is not wired.",
              at: "2026-07-14T17:25:00.000Z"
            }
          ],
          sourceSnapshots: {
            targetedEvidencePath: "test-targeted.json",
            targetedEvidenceBefore: 0,
            targetedEvidenceAfter: 0
          },
          platformRows: {},
          failureReasonCounts: {
            adapter_not_wired: 1
          }
        })),
        loadLiveEvidenceRecords: vi.fn(async () => [])
      };
    });

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", batchSlug: "S26", platforms: ["github"] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("failed");
    expect(body.refreshSummary).toMatchObject({
      requestedPlatforms: ["github"],
      attemptedPlatforms: [],
      unsupportedPlatforms: ["github"],
      acceptedRows: 0,
      visibleRows: 0
    });
    expect(body.errors[0]).toContain("adapter_not_wired:1");
  });

  it("accepts TikTok and Bluesky requests and reports their adapters as not wired", async () => {
    await mockV4GeneratedSnapshot("s26.json");
    const runLiveSourceRefresh = vi.fn(async () => ({
      ...emptyRefreshResult(),
      runId: "test-new-platform-stubs",
      stageLog: [
        {
          stage: "skipped",
          platform: "tiktok",
          reason: "adapter_not_wired",
          message: "TikTok real-time adapter is not wired.",
          at: FROZEN_ROUTE_NOW
        },
        {
          stage: "skipped",
          platform: "bluesky",
          reason: "adapter_not_wired",
          message: "Bluesky real-time adapter is not wired.",
          at: FROZEN_ROUTE_NOW_PLUS_ONE_MS
        }
      ],
      failureReasonCounts: { adapter_not_wired: 2 }
    }));
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      runLiveSourceRefresh,
      loadLiveEvidenceRecords: vi.fn(async () => [])
    }));

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({
      action: "refresh",
      batchSlug: "S26",
      platforms: ["tiktok", "bluesky"]
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(runLiveSourceRefresh).toHaveBeenCalledWith(expect.objectContaining({
      platforms: ["tiktok", "bluesky"]
    }));
    expect(body.refreshSummary).toMatchObject({
      requestedPlatforms: ["tiktok", "bluesky"],
      attemptedPlatforms: [],
      unsupportedPlatforms: ["tiktok", "bluesky"],
      failureReasonCounts: { adapter_not_wired: 2 }
    });
    expect(body.error).toBeUndefined();
    expect(body.errors[0]).toContain("adapter_not_wired:2");
  });
});

async function mockV4GeneratedSnapshot(filename: string): Promise<GraphResponse> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FROZEN_ROUTE_NOW));
  const snapshot = withV4SnapshotContract(
    await graphFixture(filename),
    FROZEN_SNAPSHOT_GENERATED_AT
  );
  const root = await mkdtemp(join(tmpdir(), "returner-fund-v4-snapshot-"));
  const snapshotDirectory = join(root, "public", "graph");
  await mkdir(snapshotDirectory, { recursive: true });
  await writeFile(join(snapshotDirectory, filename), JSON.stringify(snapshot), "utf8");
  generatedSnapshotRoots.push(root);
  vi.spyOn(process, "cwd").mockReturnValue(root);
  return snapshot;
}

function withV4SnapshotContract(
  graph: GraphResponse,
  generatedAt = FROZEN_SNAPSHOT_GENERATED_AT
): GraphResponse {
  return {
    ...graph,
    generatedAt,
    fastestGaining: graph.fastestGaining.map((row) => ({
      ...row,
      dod: { ...row.dod, benchmarkedAt: null },
      wow: { ...row.wow, benchmarkedAt: null }
    })),
    nodes: graph.nodes.map((node) => {
      const absoluteScore = node.score;
      const existing = node.scoreBreakdown;
      const referencedEvidence = graph.evidence.filter((item) => node.evidenceIds.includes(item.id));
      const scoredEvidence = referencedEvidence.filter((item) => item.contributionScore > 0);
      const platformsWithEvidence = existing?.platformsWithEvidence ?? Object.keys(node.platformScores).length;
      const scoredEvidenceCount = existing?.weightedPlatforms.reduce(
        (sum, platform) => sum + platform.evidenceCount,
        0
      ) ?? scoredEvidence.length;
      const scoreBreakdown: NonNullable<typeof node.scoreBreakdown> = {
        modelId: "returner-traction",
        modelVersion: "4.0.0",
        modelName: "returner-traction-v4-canonical",
        totalScore: node.score,
        absoluteScore,
        weightedAvailableScore: existing?.weightedAvailableScore ?? absoluteScore,
        coverageFactor: existing?.coverageFactor ?? (absoluteScore > 0 ? 1 : 0),
        platformsWithEvidence,
        totalSupportedPlatforms: existing?.totalSupportedPlatforms ?? 0,
        platformScores: existing?.platformScores ?? node.platformScores,
        weightedPlatforms: (existing?.weightedPlatforms ?? []).map((platform) => ({
          ...platform,
          configuredWeight: TRACTION_SCORING_CONFIG.platformWeights[platform.platform] ?? 0
        })),
        signalFamilyScores: existing?.signalFamilyScores ?? {
          reach: 0,
          engagement: 0,
          developerAdoption: 0,
          launchAndCommunity: 0,
          momentum: 0
        },
        confidence: {
          level: scoredEvidence.length ? "medium" : "low",
          value: scoredEvidence.length ? 0.5 : 0,
          reasons: [],
          scoredEvidenceCount: Math.max(scoredEvidenceCount, platformsWithEvidence),
          datedEvidenceCount: scoredEvidence.filter(
            (item) => item.publishedAtPrecision !== "unknown" && Number.isFinite(Date.parse(item.postedAt))
          ).length,
          verifiedLinkCount: scoredEvidence.filter((item) => item.linkStatus === "verified").length
        },
        calibration: {
          method: "none",
          cohortSize: 0,
          percentile: null,
          inputScore: absoluteScore
        },
        limitations: existing?.limitations ?? [],
        evidenceAsOf: existing?.evidenceAsOf ?? null,
        explanation: existing?.explanation ?? "Refresh route v4 contract fixture."
      };
      return { ...node, scoreBreakdown };
    }),
    scoringContext: {
      modelId: "returner-traction",
      modelVersion: "4.0.0",
      modelName: "returner-traction-v4-canonical",
      scoreScope: "all_platforms",
      selectedPlatforms: [],
      responseBuiltAt: generatedAt,
      evidenceAsOf: null
    }
  };
}

function mockFallbackGraphModules(buildGraphResponse: () => GraphResponse): void {
  vi.doMock("@/lib/graph/graph-builder", () => ({
    buildGraphResponse,
    clearTopVoiceRollupCache: vi.fn()
  }));
  vi.doMock("@/lib/graph/yc-spring-2026-dataset", () => ({
    YC_SPRING_2026_BATCH_SLUG: "S2026",
    YC_SUMMER_2026_BATCH_SLUG: "S26",
    yc2026GraphDataset: {
      batches: [],
      companies: [],
      founders: [],
      evidence: [],
      needsReview: [],
      platformStatus: [],
      mode: "official_snapshot"
    }
  }));
}

async function graphFixture(filename: string): Promise<GraphResponse> {
  return JSON.parse(readFileSync(join(process.cwd(), "public", "graph", filename), "utf8")) as GraphResponse;
}

async function insiderGraphWithRecord(record: LiveEvidenceRecord): Promise<GraphResponse> {
  const [insiderGraph, unfilteredGraph] = await Promise.all([
    graphFixture("s26-insiders.json"),
    graphFixture("s26.json")
  ]);
  const companyNode = unfilteredGraph.nodes.find((node) => node.entityId === record.entityId);
  const leaderboardRow = unfilteredGraph.leaderboard.find((row) => row.companyId === record.entityId);
  if (!companyNode || !leaderboardRow) {
    throw new Error(`Missing ${record.entityId} in the S26 graph fixture.`);
  }

  const evidence = {
    ...liveEvidenceRecordToEvidenceItem(record),
    attachedCompanyId: record.entityId,
    topVoice: {
      audienceId: "insiders" as const,
      memberId: "sam-altman",
      displayName: "Sam Altman",
      category: "insider",
      weight: 1,
      matchedBy: "platform handle sama",
      originalContributionScore: record.contributionScore
    }
  };
  const score = Math.min(100, Math.max(1, Math.round(record.contributionScore)));
  const node = {
    ...companyNode,
    score,
    previousScore: score,
    scoreDelta: 0,
    topPlatform: "x" as const,
    evidenceIds: [evidence.id],
    topVoiceScore: score,
    topVoiceConnectionCount: 1,
    selectedTopVoiceAudience: insiderGraph.selectedTopVoiceAudience
  };
  const momentum = {
    scoreDelta: 0,
    percentDelta: 0,
    rankDelta: 0,
    currentScore: score,
    currentRank: 1,
    baselineScore: score,
    baselineRank: 1,
    benchmarkedAt: null
  };

  return {
    ...insiderGraph,
    nodes: [node],
    edges: [],
    evidence: [evidence],
    leaderboard: [
      {
        ...leaderboardRow,
        rank: 1,
        score,
        topPlatform: "x",
        biggestContribution: evidence,
        topVoiceScore: score,
        topVoiceConnectionCount: 1
      }
    ],
    fastestGaining: [
      {
        rank: 1,
        companyId: record.entityId,
        companyName: record.companyName,
        dod: momentum,
        wow: momentum
      }
    ]
  };
}

function emptyRefreshResult(): LiveSourceRefreshResult {
  return {
    runId: "test-empty-refresh",
    generatedAt: "2026-07-16T12:00:00.000Z",
    cancellationReason: null,
    networkRequests: 0,
    networkRequestBudget: 100,
    networkRequestBudgetExhausted: false,
    acceptedEvidence: [],
    storedEvidence: [],
    stageLog: [
      {
        stage: "task_created",
        platform: "all",
        message: "Test refresh started.",
        at: "2026-07-16T12:00:00.000Z"
      },
      {
        stage: "dropped",
        platform: "x",
        reason: "no_status_ids",
        message: "No test status IDs were found.",
        at: "2026-07-16T12:00:00.001Z"
      }
    ],
    sourceSnapshots: {
      targetedEvidencePath: "test-targeted.json",
      targetedEvidenceBefore: 0,
      targetedEvidenceAfter: 0
    },
    platformRows: {},
    failureReasonCounts: { no_status_ids: 1 }
  };
}

function refreshResultWithRecord(
  record: LiveEvidenceRecord,
  overrides: Partial<LiveSourceRefreshResult> = {}
): LiveSourceRefreshResult {
  return {
    ...emptyRefreshResult(),
    runId: "test-live-refresh-with-record",
    generatedAt: FROZEN_ROUTE_NOW,
    networkRequests: 1,
    acceptedEvidence: [record],
    storedEvidence: [record],
    stageLog: [
      {
        stage: "accepted",
        platform: "x",
        sourceUrl: record.sourceUrl,
        companyName: record.companyName,
        message: "Accepted adversarial route-test evidence.",
        at: FROZEN_ROUTE_NOW
      }
    ],
    sourceSnapshots: {
      targetedEvidencePath: "test-targeted.json",
      targetedEvidenceBefore: 0,
      targetedEvidenceAfter: 1
    },
    platformRows: { x: 1 },
    failureReasonCounts: {},
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function screenpipeRecord(): LiveEvidenceRecord {
  return {
    id: "live-x-company-screenpipe-2077045452579778664",
    entityType: "company",
    entityId: "company-screenpipe",
    companyName: "screenpipe",
    platform: "x",
    title: "introducing screenpipe",
    sourceUrl: "https://x.com/screenpipe/status/2077045452579778664",
    platformPostId: "2077045452579778664",
    text: "introducing screenpipe: it records and learns how you work and turns it into a searchable memory, SOPs, and AI agents",
    thumbnailUrl: "https://pbs.twimg.com/screenpipe-demo.jpg",
    thumbnailSource: "x_media",
    mediaUrl: "https://video.twimg.com/screenpipe-demo.mp4",
    mediaUrls: ["https://video.twimg.com/screenpipe-demo.mp4"],
    media_urls: ["https://video.twimg.com/screenpipe-demo.mp4"],
    media_posters: ["https://pbs.twimg.com/screenpipe-demo.jpg"],
    linkStatus: "verified",
    linkCheckedAt: "2026-07-14T17:00:00.000Z",
    rawVisibleText: JSON.stringify({
      source: "live_x_profile",
      post: {
        author: {
          screen_name: "screenpipe",
          name: "screenpipe (YC S26)",
          url: "https://x.com/screenpipe"
        }
      }
    }),
    postedAt: "2026-07-14T15:00:00.000Z",
    metrics: {
      views: 116000,
      likes: 697,
      comments: 74,
      replies: 74,
      reposts: 104,
      saves: 1000
    },
    contributionScore: 90,
    review_state: "verified",
    matchReason: "Live manual refresh verified a native X post from official @screenpipe for screenpipe.",
    first_seen_at: "2026-07-14T17:00:00.000Z",
    last_checked_at: "2026-07-14T17:00:00.000Z",
    last_updated_at: "2026-07-14T15:00:00.000Z"
  };
}

function insiderScreenpipeRecord(): LiveEvidenceRecord {
  return {
    id: "live-x-company-screenpipe-2077000000000000001",
    entityType: "company",
    entityId: "company-screenpipe",
    companyName: "screenpipe",
    platform: "x",
    title: "screenpipe is making local-first AI agents more useful",
    sourceUrl: "https://x.com/sama/status/2077000000000000001",
    platformPostId: "2077000000000000001",
    text: "screenpipe is making local-first AI agents more useful.",
    thumbnailUrl: null,
    thumbnailSource: null,
    mediaUrl: null,
    mediaUrls: [],
    media_urls: [],
    media_posters: [],
    linkStatus: "verified",
    linkCheckedAt: "2026-07-14T17:10:00.000Z",
    rawVisibleText: JSON.stringify({
      source: "live_x_top_voice_profile",
      post: {
        author: {
          screen_name: "sama",
          name: "Sam Altman",
          url: "https://x.com/sama"
        },
        text: "screenpipe is making local-first AI agents more useful."
      }
    }),
    postedAt: "2026-07-14T16:30:00.000Z",
    metrics: {
      views: 150000,
      likes: 900,
      comments: 90,
      replies: 90,
      reposts: 120
    },
    contributionScore: 96,
    review_state: "verified",
    matchReason: "Live manual refresh verified a native X post from insider @sama mentioning screenpipe.",
    first_seen_at: "2026-07-14T17:10:00.000Z",
    last_checked_at: "2026-07-14T17:10:00.000Z",
    last_updated_at: "2026-07-14T16:30:00.000Z"
  };
}
