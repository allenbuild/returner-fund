import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyStoredBenchmarkMomentum } from "@/lib/graph/benchmarks";
import { applyClientGraphFilters } from "@/lib/graph/client-filters";
import type { GraphResponse } from "@/lib/graph/types";

const readRuntimeGraphSnapshotFile = vi.fn<(filename: string) => Promise<string>>();
const authenticateInsiderRequest = vi.fn(async () => null);
const loadUserInsiderConfiguration = vi.fn();

vi.mock("@/lib/graph/runtime-graph-snapshot-file", () => ({
  readRuntimeGraphSnapshotFile
}));
vi.mock("@/lib/social/user-insiders-server", () => ({
  authenticateInsiderRequest,
  loadUserInsiderConfiguration
}));

// Canonical graph reads must not even evaluate the modules that materialize the
// complete evidence corpus. Explicit diagnostic requests may import a heavy
// fallback lazily, but importing the public route itself must stay lightweight.
vi.mock("@/lib/graph/yc-spring-2026-dataset", () => forbiddenHeavyImport("yc-spring-2026-dataset"));
vi.mock("@/lib/graph/graph-builder", () => forbiddenHeavyImport("graph-builder"));
vi.mock("@/lib/graph/live-evidence-dataset", () => forbiddenHeavyImport("live-evidence-dataset"));
vi.mock("@/lib/graph/live-evidence-overlay", () => forbiddenHeavyImport("live-evidence-overlay"));
vi.mock("@/lib/ingestion/live-source-refresh", () => forbiddenHeavyImport("live-source-refresh"));

const snapshotBodies = new Map(
  ["s26.json", "s26-yc-partners.json", "s26-insiders.json"].map((filename) => [
    filename,
    neutralizePublishedMomentum(
      readFileSync(join(process.cwd(), "public", "graph", filename), "utf8")
    )
  ])
);
const PUBLISHED_GRAPH_TIME = new Date(
  new Date((JSON.parse(snapshotBodies.get("s26.json")!) as GraphResponse).generatedAt).getTime() + 1_000
);

describe("GET /api/graph published snapshot runtime", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(PUBLISHED_GRAPH_TIME);
    readRuntimeGraphSnapshotFile.mockImplementation(async (filename) => {
      const body = snapshotBodies.get(filename);
      if (!body) {
        throw Object.assign(new Error(`Missing test snapshot ${filename}`), { code: "ENOENT" });
      }
      return body;
    });
    const { clearGraphResponseCache } = await import("@/lib/graph/graph-response-cache");
    clearGraphResponseCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("rehydrates today's exact-model DoD baseline without changing the published graph", async () => {
    const published = snapshot("s26.json");
    const publishedScreenpipe = momentumRow(published, "company-screenpipe");
    const expectedScreenpipe = momentumRow(
      applyStoredBenchmarkMomentum(published, { now: PUBLISHED_GRAPH_TIME }),
      "company-screenpipe"
    );
    expect(publishedScreenpipe.dod.baselineScore).toBeNull();
    expect(expectedScreenpipe.dod.baselineScore).not.toBeNull();

    const { GET } = await import("@/app/api/graph/route");
    const response = await GET(new Request("http://localhost/api/graph?batch=S26"));
    const graph = await response.json() as GraphResponse;
    const screenpipe = momentumRow(graph, "company-screenpipe");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("x-graph-source")).toBe("published_snapshot");
    expect(readRuntimeGraphSnapshotFile).toHaveBeenCalledOnce();
    expect(readRuntimeGraphSnapshotFile).toHaveBeenCalledWith("s26.json");
    expect(graph.generatedAt).toBe(published.generatedAt);
    expect(graph.scoringContext).toEqual(published.scoringContext);
    expect(graph.nodes).toEqual(published.nodes);
    expect(graph.edges).toEqual(published.edges);
    expect(graph.evidence.map((item) => item.id).sort()).toEqual(
      published.evidence.map((item) => item.id).sort()
    );
    const publishedEvidence = new Map(published.evidence.map((item) => [item.id, item]));
    expect(graph.evidence.every((item) =>
      JSON.stringify(item) === JSON.stringify(publishedEvidence.get(item.id))
    )).toBe(true);
    expect(graph.leaderboard).toEqual(published.leaderboard);
    expect(screenpipe.dod).toEqual(expectedScreenpipe.dod);
    expect(screenpipe.dod.benchmarkedAt).not.toBeNull();
    expect(screenpipe.wow).toEqual(expectedScreenpipe.wow);
  }, 30_000);

  it("applies canonical display filters after benchmark hydration", async () => {
    const published = snapshot("s26-yc-partners.json");
    const benchmarked = applyStoredBenchmarkMomentum(published, {
      now: PUBLISHED_GRAPH_TIME
    });
    const expected = applyClientGraphFilters(benchmarked, {
      platforms: ["x"],
      industries: [],
      groupPartners: [],
      minScore: 60
    });
    const { GET } = await import("@/app/api/graph/route");
    const response = await GET(new Request(
      "http://localhost/api/graph?batch=S26&topVoices=yc_partners&platforms=x&minScore=60"
    ));
    const graph = await response.json() as GraphResponse;

    expect(response.status).toBe(200);
    expect(readRuntimeGraphSnapshotFile).toHaveBeenCalledWith("s26-yc-partners.json");
    expect(graph.selectedTopVoiceAudience.id).toBe("yc_partners");
    expect(canonicalProjection(graph)).toEqual(canonicalProjection(expected));
    expect(graph.nodes.every((node) => node.entityType !== "company" || node.score >= 60)).toBe(true);
  }, 30_000);

  it.each([
    ["off", "s26.json"],
    ["yc_partners", "s26-yc-partners.json"],
    ["insiders", "s26-insiders.json"]
  ] as const)(
    "selects the allowlisted %s audience snapshot",
    async (audience, filename) => {
      const { GET } = await import("@/app/api/graph/route");
      const suffix = audience === "off" ? "" : `&topVoices=${audience}`;
      const response = await GET(new Request(`http://localhost/api/graph?batch=S26${suffix}`));
      const graph = await response.json() as GraphResponse;

      expect(response.status).toBe(200);
      expect(readRuntimeGraphSnapshotFile).toHaveBeenCalledOnce();
      expect(readRuntimeGraphSnapshotFile).toHaveBeenCalledWith(filename);
      expect(graph.batch.slug).toBe("S26");
      expect(graph.selectedTopVoiceAudience.id).toBe(audience);
      expect(loadUserInsiderConfiguration).not.toHaveBeenCalled();
    },
    30_000
  );

  it.each(["..%2F..%2Fprivate", "constructor", "toString", "__proto__"])(
    "rejects unsupported batch %s before resolving a snapshot filename",
    async (batch) => {
    const { GET } = await import("@/app/api/graph/route");
    const response = await GET(new Request(
      `http://localhost/api/graph?batch=${batch}&topVoices=off`
    ));
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("invalid_query");
    expect(readRuntimeGraphSnapshotFile).not.toHaveBeenCalled();
    }
  );

  it("coalesces concurrent cold reads of the same published snapshot", async () => {
    let releaseRead: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    readRuntimeGraphSnapshotFile.mockImplementation(async (filename) => {
      await blocked;
      return snapshotBodies.get(filename)!;
    });
    const { GET } = await import("@/app/api/graph/route");
    const requests = [
      GET(new Request("http://localhost/api/graph?batch=S26")),
      GET(new Request("http://localhost/api/graph?batch=S26"))
    ];
    releaseRead?.();
    const responses = await Promise.all(requests);

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(readRuntimeGraphSnapshotFile).toHaveBeenCalledOnce();
  });

  it("stops a chunked CDN fallback before an oversized body is buffered", async () => {
    readRuntimeGraphSnapshotFile.mockRejectedValueOnce(
      Object.assign(new Error("missing local snapshot"), { code: "ENOENT" })
    );
    let cancelled = false;
    let pulls = 0;
    const chunk = new Uint8Array(11 * 1024 * 1024);
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls <= 2) {
            controller.enqueue(chunk);
          } else {
            controller.close();
          }
        },
        cancel() {
          cancelled = true;
        }
      },
      { highWaterMark: 0 }
    );
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const { loadPublishedGraphSnapshot } = await import(
      "@/lib/graph/published-graph-snapshot"
    );

    await expect(loadPublishedGraphSnapshot({
      batchSlug: "S26",
      audienceId: "off",
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).rejects.toThrow("exceeded the 20971520-byte limit");

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cancelled).toBe(true);
  });

  it.each(["includeRaw", "includeNonScoring", "includeWhy"] as const)(
    "isolates %s diagnostics behind the explicit heavy endpoint",
    async (diagnosticFlag) => {
      const { GET } = await import("@/app/api/graph/route");
      const request = new Request(
        `http://localhost/api/graph?batch=S26&${diagnosticFlag}=true`
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/api/graph/full");
      expect(location.searchParams.get("batch")).toBe("S26");
      expect(location.searchParams.get(diagnosticFlag)).toBe("true");
      expect(readRuntimeGraphSnapshotFile).not.toHaveBeenCalled();
    }
  );

  it("rejects unauthenticated production diagnostics before loading heavy modules", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("ENABLE_FULL_GRAPH_DIAGNOSTICS", "true");
    vi.stubEnv("ADMIN_INGESTION_SECRET", "test-admin-secret");
    vi.stubEnv("REFRESH_SECRET", "");
    const { GET } = await import("@/app/api/graph/full/route");
    const response = await GET(new Request(
      "https://www.returner.fund/api/graph/full?batch=S26&includeWhy=1"
    ));
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(401);
    expect(body.error?.code).toBe("graph_diagnostics_unauthorized");
    expect(response.headers.get("www-authenticate")).toContain("graph-diagnostics");
  });

  it("keeps full graph recomputation disabled on Vercel by default", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("ENABLE_FULL_GRAPH_DIAGNOSTICS", "");
    const { GET } = await import("@/app/api/graph/full/route");
    const response = await GET(new Request(
      "https://www.returner.fund/api/graph/full?batch=S26&includeWhy=1"
    ));
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(404);
    expect(body.error?.code).toBe("graph_diagnostics_disabled");
  });
});

function forbiddenHeavyImport(moduleName: string): never {
  throw new Error(`Canonical graph route imported forbidden heavy module: ${moduleName}`);
}

function snapshot(filename: string): GraphResponse {
  return JSON.parse(snapshotBodies.get(filename)!) as GraphResponse;
}

function neutralizePublishedMomentum(raw: string): string {
  const graph = JSON.parse(raw) as GraphResponse;
  graph.fastestGaining = graph.fastestGaining
    .map((row) => ({
      ...row,
      dod: neutralDelta(row.dod.currentScore, row.dod.currentRank),
      wow: neutralDelta(row.wow.currentScore, row.wow.currentRank)
    }))
    .sort((left, right) =>
      right.dod.currentScore - left.dod.currentScore ||
      left.companyName.localeCompare(right.companyName) ||
      left.companyId.localeCompare(right.companyId)
    )
    .map((row, index) => ({ ...row, rank: index + 1 }));
  return JSON.stringify(graph);
}

function neutralDelta(currentScore: number, currentRank: number) {
  return {
    scoreDelta: 0,
    percentDelta: 0,
    rankDelta: 0,
    currentScore,
    currentRank,
    baselineScore: null,
    baselineRank: null,
    benchmarkedAt: null
  };
}

function momentumRow(graph: GraphResponse, companyId: string) {
  const row = graph.fastestGaining.find((candidate) => candidate.companyId === companyId);
  expect(row).toBeDefined();
  return row!;
}

function canonicalProjection(graph: GraphResponse) {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      entityId: node.entityId,
      score: node.score,
      platformScores: node.platformScores
    })),
    edges: graph.edges.map((edge) => edge.id),
    evidence: graph.evidence.map((item) => ({
      id: item.id,
      entityId: item.entityId,
      platform: item.platform,
      contributionScore: item.contributionScore
    })),
    leaderboard: graph.leaderboard.map((row) => ({
      rank: row.rank,
      companyId: row.companyId,
      score: row.score
    })),
    fastestGaining: graph.fastestGaining,
    scoringContext: graph.scoringContext
  };
}
