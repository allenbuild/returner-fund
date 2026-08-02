import { afterEach, describe, expect, it, vi } from "vitest";

const HEAVY_GRAPH_TEST_TIMEOUT_MS = 90_000;

describe("GET /api/graph live persistence reliability", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/graph/graph-response-cache");
    vi.doUnmock("@/lib/ingestion/live-source-refresh");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns a truthful server error instead of a graph without persisted live evidence", async () => {
    const getOrBuildCachedGraphResponse = vi.fn();
    vi.doMock("@/lib/graph/graph-response-cache", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/graph/graph-response-cache")>()),
      getOrBuildCachedGraphResponse
    }));
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      loadLiveEvidenceRecords: vi.fn(async () => {
        throw Object.assign(new Error("persisted snapshot is unreadable"), { code: "EACCES" });
      })
    }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { GET } = await import("@/app/api/graph/full/route");
    const response = await GET(new Request(
      "http://localhost/api/graph/full?batch=S2026&includeWhy=1"
    ));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toMatchObject({
      status: "failed",
      error: { code: "live_evidence_reload_failed" }
    });
    expect(body.errors.join(" ")).toContain("could not be reloaded");
    expect(body.nodes).toBeUndefined();
    expect(getOrBuildCachedGraphResponse).not.toHaveBeenCalled();
  }, HEAVY_GRAPH_TEST_TIMEOUT_MS);

  it("preserves the legitimate no-live-snapshot path when persistence reports ENOENT", async () => {
    const graph = { marker: "graph-built-without-live-snapshot" };
    const getOrBuildCachedGraphResponse = vi.fn(async () => graph);
    vi.doMock("@/lib/graph/graph-response-cache", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/graph/graph-response-cache")>()),
      getOrBuildCachedGraphResponse
    }));
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      loadLiveEvidenceRecords: vi.fn(async () => {
        throw Object.assign(new Error("no live snapshot"), { code: "ENOENT" });
      })
    }));

    const { GET } = await import("@/app/api/graph/full/route");
    const response = await GET(new Request(
      "http://localhost/api/graph/full?batch=S2026&includeWhy=1"
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(graph);
    expect(getOrBuildCachedGraphResponse).toHaveBeenCalledTimes(1);
  }, HEAVY_GRAPH_TEST_TIMEOUT_MS);
});
