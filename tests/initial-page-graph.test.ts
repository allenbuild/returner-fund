import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyClientGraphFilters } from "@/lib/graph/client-filters";

describe("initial page graph", () => {
  it("persists today's daily benchmark while hydrating stored momentum for first paint", async () => {
    const previousCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yc-initial-page-benchmarks-"));

    process.chdir(tempDir);
    vi.resetModules();

    try {
      const { ensureBenchmarkMomentum } = await import("@/lib/graph/benchmarks");
      const { buildGraphResponse } = await import("@/lib/graph/graph-builder");
      const { ycSpring2026GraphDataset } = await import("@/lib/graph/yc-spring-2026-dataset");
      const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
      const firstCompany = graph.leaderboard[0]!;

      const persisted = ensureBenchmarkMomentum(graph, {
        now: new Date("2026-06-30T12:00:00.000Z")
      });

      const storePath = persisted.storePath;
      const before = fs.readFileSync(storePath, "utf8");

      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));

      const { buildInitialPageGraph } = await import("@/lib/graph/initial-page-graph");
      const initialPageGraph = buildInitialPageGraph();
      const after = fs.readFileSync(storePath, "utf8");
      const store = JSON.parse(after) as { daily: { recordedAt: string }[] };
      const row = initialPageGraph.fastestGaining.find((candidate) => candidate.companyId === firstCompany.companyId);

      expect(row?.dod.benchmarkedAt).toBe("2026-06-30T12:00:00.000Z");
      expect(store.daily.map((snapshot) => snapshot.recordedAt)).toEqual([
        "2026-06-24T05:00:00.000Z",
        "2026-06-25T05:00:00.000Z",
        "2026-06-26T05:00:00.000Z",
        "2026-06-27T05:00:00.000Z",
        "2026-06-28T05:00:00.000Z",
        "2026-06-29T05:00:00.000Z",
        "2026-06-30T12:00:00.000Z",
        "2026-07-01T12:00:00.000Z"
      ]);
      expect(after).not.toBe(before);
    } finally {
      vi.useRealTimers();
      process.chdir(previousCwd);
      vi.resetModules();
    }
  });

  it("keeps the full map and ranking shell while trimming heavy evidence for first paint", async () => {
    const { buildInitialPageGraph } = await import("@/lib/graph/initial-page-graph");
    const graph = buildInitialPageGraph();

    expect(graph.batch.slug).toBe("S2026");
    expect(graph.nodes).toHaveLength(197);
    expect(graph.leaderboard).toHaveLength(197);
    expect(graph.fastestGaining).toHaveLength(197);
    expect(graph.evidence.length).toBeGreaterThan(0);
    expect(graph.evidence.length).toBeLessThanOrEqual(20);
  });

  it("honors requested batch and platform filters for direct initial page loads", async () => {
    const { buildInitialPageGraph } = await import("@/lib/graph/initial-page-graph");
    const graph = buildInitialPageGraph({ batchSlug: "A16ZSR006", platforms: ["youtube"] });

    expect(graph.batch.slug).toBe("A16ZSR006");
    expect(graph.nodes.some((node) => node.entityType === "company" && node.label === "SUN")).toBe(true);
    expect(graph.nodes.some((node) => node.entityType === "company" && node.label === "HeyClicky")).toBe(false);
    expect(graph.evidence.length).toBeGreaterThan(0);
    expect(graph.evidence.every((item) => item.platform === "youtube")).toBe(true);
  });

  it("keeps leaderboard top posts available after the first client filter pass", async () => {
    const { buildInitialPageGraph } = await import("@/lib/graph/initial-page-graph");
    const graph = buildInitialPageGraph();
    const filtered = applyClientGraphFilters(graph, {
      platforms: [],
      industries: [],
      groupPartners: [],
      minScore: 0
    });

    expect(
      filtered.leaderboard
        .filter((row) => row.score > 0)
        .slice(0, 12)
        .every((row) => row.biggestContribution)
    ).toBe(true);
  });
});
