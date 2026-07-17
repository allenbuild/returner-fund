import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphResponse } from "@/lib/graph/types";

describe("GET /api/graph Central-day cache", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("@/lib/graph/graph-response-cache");
    vi.doUnmock("@/lib/ingestion/live-source-refresh");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("rotates the cache key at summer Central midnight and caps the prior TTL", async () => {
    vi.useFakeTimers();
    const cachedGraph = { cached: true } as unknown as GraphResponse;
    const getOrBuildCachedGraphResponse = vi.fn(
      async (_options: {
        cacheKey: string;
        ttlMs: number;
        scope: { batchSlug: string; topVoices: string };
      }) => cachedGraph
    );

    vi.doMock("@/lib/graph/graph-response-cache", () => ({
      getOrBuildCachedGraphResponse,
      getCachedGraphResponse: vi.fn(),
      setCachedGraphResponse: vi.fn(),
      clearGraphResponseCache: vi.fn()
    }));
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      loadLiveEvidenceRecords: vi.fn(async () => [])
    }));

    const { GET } = await import("@/app/api/graph/route");

    vi.setSystemTime(new Date("2026-07-05T04:59:59.500Z"));
    await GET(new Request("http://localhost/api/graph?batch=S2026"));

    vi.setSystemTime(new Date("2026-07-05T05:00:00.000Z"));
    await GET(new Request("http://localhost/api/graph?batch=S2026"));

    const beforeOptions = getOrBuildCachedGraphResponse.mock.calls[0]![0];
    const afterOptions = getOrBuildCachedGraphResponse.mock.calls[1]![0];
    const before = JSON.parse(beforeOptions.cacheKey) as Record<string, unknown>;
    const after = JSON.parse(afterOptions.cacheKey) as Record<string, unknown>;

    expect(before.benchmarkCentralDay).toBe("2026-07-04");
    expect(after.benchmarkCentralDay).toBe("2026-07-05");
    expect(before).not.toHaveProperty("benchmarkLocalDay");
    expect(beforeOptions.ttlMs).toBe(500);
    expect(afterOptions.ttlMs).toBe(60_000);
    expect(beforeOptions.scope).toEqual({ batchSlug: "S2026", topVoices: "off" });
  });
});
