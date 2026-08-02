import { afterEach, describe, expect, it, vi } from "vitest";
import { clearGraphResponseCache } from "@/lib/graph/graph-response-cache";
import type { GraphResponse } from "@/lib/graph/types";

const HEAVY_GRAPH_TEST_TIMEOUT_MS = 90_000;

describe("GET /api/graph response-cache concurrency", () => {
  afterEach(() => {
    clearGraphResponseCache();
    vi.doUnmock("@/lib/graph/graph-builder");
    vi.doUnmock("@/lib/ingestion/live-source-refresh");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("coalesces identical cold builds without joining requests from different filters", async () => {
    let buildCount = 0;
    let buildCycleCount = 0;
    vi.doMock("@/lib/graph/graph-builder", async (importOriginal) => {
      const original = await importOriginal<typeof import("@/lib/graph/graph-builder")>();
      return {
        ...original,
        buildGraphResponse: (...args: Parameters<typeof original.buildGraphResponse>) => {
          buildCount += 1;
          if (args[0]?.topVoices === "off") buildCycleCount += 1;
          return original.buildGraphResponse(...args);
        }
      };
    });
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      loadLiveEvidenceRecords: vi.fn(async () => [])
    }));

    const { GET } = await import("@/app/api/graph/full/route");
    clearGraphResponseCache();

    const xUrl = "http://localhost/api/graph?batch=S2026&topVoices=insiders&platforms=x";
    const identical = await Promise.all([
      graphResponse(GET, xUrl),
      graphResponse(GET, xUrl)
    ]);

    expect(buildCycleCount).toBe(1);
    expect(buildCount).toBe(2);
    expect(identical[0].evidence.length).toBeGreaterThan(0);
    expect(identical[0].evidence.every((item) => item.platform === "x")).toBe(true);
    expect(identical[1].evidence.every((item) => item.platform === "x")).toBe(true);
    expect(identical[0].nodes.map((node) => node.entityId)).toEqual(
      identical[1].nodes.map((node) => node.entityId)
    );

    clearGraphResponseCache({ batchSlug: "S2026", topVoices: "insiders" });
    const githubUrl = "http://localhost/api/graph?batch=S2026&topVoices=insiders&platforms=github";
    const [xGraph, githubGraph] = await Promise.all([
      graphResponse(GET, xUrl),
      graphResponse(GET, githubUrl)
    ]);

    expect(buildCycleCount).toBe(3);
    expect(buildCount).toBe(6);
    expect(xGraph.evidence.length).toBeGreaterThan(0);
    expect(xGraph.evidence.every((item) => item.platform === "x")).toBe(true);
    expect(githubGraph.evidence.every((item) => item.platform === "github")).toBe(true);
    expect(githubGraph.evidence.map((item) => item.id)).not.toEqual(
      xGraph.evidence.map((item) => item.id)
    );
  }, HEAVY_GRAPH_TEST_TIMEOUT_MS);
});

async function graphResponse(
  GET: (request: Request) => Promise<Response>,
  url: string
): Promise<GraphResponse> {
  const diagnosticUrl = new URL(url);
  diagnosticUrl.searchParams.set("includeWhy", "1");
  const response = await GET(new Request(diagnosticUrl));
  expect(response.status).toBe(200);
  return response.json() as Promise<GraphResponse>;
}
