import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphResponse } from "@/lib/graph/types";
import { emptyInsiderConfiguration } from "@/lib/social/user-insiders";

const authenticateInsiderRequest = vi.fn();
const loadUserInsiderConfiguration = vi.fn();
const clearGraphResponseCache = vi.fn();
const reportGenerator = vi.fn();
const applyStoredBenchmarkMomentum = vi.fn((graph: GraphResponse) => graph);

vi.mock("@/lib/social/user-insiders-server", () => ({
  authenticateInsiderRequest,
  loadUserInsiderConfiguration
}));
vi.mock("@/lib/graph/graph-response-cache", () => ({ clearGraphResponseCache }));
vi.mock("@/lib/graph/benchmarks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/graph/benchmarks")>()),
  applyStoredBenchmarkMomentum
}));

describe("POST /api/insiders/recompute", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invalidates derived-score caches from stored evidence without regenerating a report", async () => {
    authenticateInsiderRequest.mockResolvedValue({ client: {}, userId: "user-a" });
    loadUserInsiderConfiguration.mockResolvedValue({
      ...emptyInsiderConfiguration(),
      version: 7
    });
    const { POST } = await import("@/app/api/insiders/recompute/route");

    const response = await POST(new Request("http://localhost/api/insiders/recompute", {
      method: "POST",
      headers: { Authorization: "Bearer token" }
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "recomputed",
      configurationVersion: 7,
      source: "published_snapshot",
      reportRegenerated: false
    });
    expect(body.graph).toMatchObject({
      batch: { slug: "S2026" },
      selectedTopVoiceAudience: { id: "insiders" },
      insiderConfigurationVersion: 7
    });
    const ploy = (body.graph as GraphResponse).nodes.find(
      (node) => node.entityId === "company-ploy"
    );
    expect(ploy?.insiderScoreBreakdown).toMatchObject({
      publishedInsiderInfluence: 25,
      weightedInsiderSubtotal: 25,
      insiderScoreAdjustment: 0,
      configurationVersion: 7
    });
    expect(ploy?.insiderScoreBreakdown?.finalScore).toBe(
      ploy?.insiderScoreBreakdown?.baseScore
    );
    expect(ploy?.score).toBe(ploy?.insiderScoreBreakdown?.finalScore);
    expect(Buffer.byteLength(JSON.stringify(body.graph))).toBeLessThan(4 * 1024 * 1024);
    expect(applyStoredBenchmarkMomentum).toHaveBeenCalledOnce();
    expect(clearGraphResponseCache).toHaveBeenCalledOnce();
    expect(reportGenerator).not.toHaveBeenCalled();
  }, 30_000);

  it("hydrates exact-model benchmark history before personalizing scores", async () => {
    authenticateInsiderRequest.mockResolvedValue({ client: {}, userId: "user-a" });
    loadUserInsiderConfiguration.mockResolvedValue({
      ...emptyInsiderConfiguration(),
      version: 11,
      weightOverrides: { "paul-graham": 1 }
    });
    const benchmarkedAt = "2026-07-27T07:36:27.759Z";
    applyStoredBenchmarkMomentum.mockImplementationOnce((graph) => ({
      ...graph,
      fastestGaining: graph.fastestGaining.map((row) => ({
        ...row,
        dod: {
          ...row.dod,
          baselineScore: row.dod.currentScore - 2,
          baselineRank: row.dod.currentRank + 1,
          benchmarkedAt
        }
      }))
    }));
    const { POST } = await import("@/app/api/insiders/recompute/route");

    const response = await POST(new Request("http://localhost/api/insiders/recompute", {
      method: "POST",
      headers: {
        Authorization: "Bearer token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ batchSlug: "S2026", insiderIds: [] })
    }));
    const body = await response.json() as { graph: GraphResponse };

    expect(response.status).toBe(200);
    expect(applyStoredBenchmarkMomentum).toHaveBeenCalledOnce();
    expect(body.graph.fastestGaining.length).toBeGreaterThan(0);
    expect(body.graph.fastestGaining.every((row) =>
      row.dod.baselineScore !== null &&
      row.dod.baselineRank !== null &&
      row.dod.benchmarkedAt === benchmarkedAt
    )).toBe(true);
  }, 30_000);

  it("applies saved weights to the returned graph without importing the full graph builder", async () => {
    authenticateInsiderRequest.mockResolvedValue({ client: {}, userId: "user-a" });
    loadUserInsiderConfiguration.mockResolvedValue({
      ...emptyInsiderConfiguration(),
      version: 8,
      weightOverrides: { "paul-graham": 1 }
    });
    const { POST } = await import("@/app/api/insiders/recompute/route");

    const response = await POST(new Request("http://localhost/api/insiders/recompute", {
      method: "POST",
      headers: {
        Authorization: "Bearer token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ batchSlug: "S2026", insiderIds: [] })
    }));
    const body = await response.json() as { graph: GraphResponse };

    expect(response.status).toBe(200);
    const paulCompany = body.graph.nodes.find((node) =>
      node.topVoiceConnections?.some((connection) => connection.memberId === "paul-graham")
    );
    const paulMatch = paulCompany?.insiderScoreBreakdown?.matches.find(
      (match) => match.memberId === "paul-graham"
    );
    expect(paulMatch).toMatchObject({ effectiveWeight: 1, included: true });
    const ploy = body.graph.nodes.find((node) => node.entityId === "company-ploy");
    const ployRow = body.graph.leaderboard.find((row) => row.companyId === "company-ploy");
    expect(ploy?.insiderScoreBreakdown).toMatchObject({
      publishedInsiderInfluence: 25,
      weightedInsiderSubtotal: 1,
      insiderScoreAdjustment: -24,
      configurationVersion: 8
    });
    const expectedFinalScore = Math.max(
      0,
      (ploy?.insiderScoreBreakdown?.baseScore ?? 0) - 24
    );
    expect(ploy?.insiderScoreBreakdown?.finalScore).toBe(expectedFinalScore);
    expect(ploy?.score).toBe(expectedFinalScore);
    expect(ployRow?.score).toBe(expectedFinalScore);
    expect(body.graph.insiderConfigurationVersion).toBe(8);
  }, 30_000);

  it("discovers eligible published evidence for a user-added insider", async () => {
    authenticateInsiderRequest.mockResolvedValue({ client: {}, userId: "user-a" });
    loadUserInsiderConfiguration.mockResolvedValue({
      ...emptyInsiderConfiguration(),
      version: 9,
      addedInsiders: [{
        personId: "user:hacker_news:avipeltz",
        displayName: "Avi Peltz",
        aliases: ["Avi Peltz"],
        handles: { hacker_news: ["avipeltz"] },
        category: "insider",
        weight: 4,
        active: true,
        source: "user-added"
      }]
    });
    const { POST } = await import("@/app/api/insiders/recompute/route");

    const response = await POST(new Request("http://localhost/api/insiders/recompute", {
      method: "POST",
      headers: {
        Authorization: "Bearer token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ batchSlug: "S2026", insiderIds: [] })
    }));
    const body = await response.json() as { graph: GraphResponse };

    expect(response.status).toBe(200);
    const superset = body.graph.nodes.find((node) => node.entityId === "company-superset");
    const addedConnection = superset?.topVoiceConnections?.find(
      (connection) => connection.memberId === "user:hacker_news:avipeltz"
    );
    expect(addedConnection).toMatchObject({
      memberId: "user:hacker_news:avipeltz",
      weight: 4
    });
    expect(addedConnection?.evidenceCount).toBeGreaterThanOrEqual(1);
    expect(addedConnection?.platforms).toContain("hacker_news");
    expect(superset?.insiderScoreBreakdown?.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        memberId: "user:hacker_news:avipeltz",
        effectiveWeight: 4,
        included: true
      })
    ]));
  }, 30_000);

  it("rejects selected IDs that are not enabled in the saved configuration", async () => {
    authenticateInsiderRequest.mockResolvedValue({ client: {}, userId: "user-a" });
    loadUserInsiderConfiguration.mockResolvedValue(emptyInsiderConfiguration());
    const { POST } = await import("@/app/api/insiders/recompute/route");
    const response = await POST(new Request("http://localhost/api/insiders/recompute", {
      method: "POST",
      headers: {
        Authorization: "Bearer token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ batchSlug: "S2026", insiderIds: ["not-enabled"] })
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_insider_selection" }
    });
    expect(clearGraphResponseCache).not.toHaveBeenCalled();
  }, 30_000);

  it("rejects unsupported batches before reading snapshots", async () => {
    authenticateInsiderRequest.mockResolvedValue({ client: {}, userId: "user-a" });
    const { POST } = await import("@/app/api/insiders/recompute/route");
    const response = await POST(new Request("http://localhost/api/insiders/recompute", {
      method: "POST",
      headers: {
        Authorization: "Bearer token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ batchSlug: "unknown", insiderIds: [] })
    }));
    expect(response.status).toBe(400);
    expect(loadUserInsiderConfiguration).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    authenticateInsiderRequest.mockResolvedValue(null);
    const { POST } = await import("@/app/api/insiders/recompute/route");
    const response = await POST(new Request("http://localhost/api/insiders/recompute", {
      method: "POST"
    }));
    expect(response.status).toBe(401);
    expect(clearGraphResponseCache).not.toHaveBeenCalled();
  });
});
