import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyStoredBenchmarkMomentum, ensureBenchmarkMomentum } from "@/lib/graph/benchmarks";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import type { GraphResponse } from "@/lib/graph/types";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

describe("score benchmarks", () => {
  it("records daily and weekly score/rank baselines only when each interval is due", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yc-score-benchmarks-"));
    const storePath = path.join(tempDir, "s2026-score-benchmarks.json");
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const firstCompany = graph.leaderboard[0]!;

    const initial = ensureBenchmarkMomentum(graph, {
      storePath,
      now: new Date("2026-06-28T12:00:00.000Z")
    });
    const duplicate = ensureBenchmarkMomentum(graph, {
      storePath,
      now: new Date("2026-06-28T18:00:00.000Z")
    });
    const nextDay = ensureBenchmarkMomentum(withCompanyScore(graph, firstCompany.companyId, firstCompany.score + 5), {
      storePath,
      now: new Date("2026-06-29T12:01:00.000Z")
    });
    const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
      daily: unknown[];
      weekly: unknown[];
    };
    const updatedRow = nextDay.graph.fastestGaining.find((row) => row.companyId === firstCompany.companyId);

    expect(initial.recordedDaily).toBe(true);
    expect(initial.recordedWeekly).toBe(true);
    expect(duplicate.recordedDaily).toBe(false);
    expect(duplicate.recordedWeekly).toBe(false);
    expect(nextDay.recordedDaily).toBe(true);
    expect(nextDay.recordedWeekly).toBe(false);
    expect(store.daily).toHaveLength(2);
    expect(store.weekly).toHaveLength(1);
    expect(updatedRow?.dod.scoreDelta).toBe(5);
    expect(updatedRow?.dod.benchmarkedAt).toBe("2026-06-28T12:00:00.000Z");
    expect(updatedRow?.wow.scoreDelta).toBe(0);
    expect(updatedRow?.wow.benchmarkedAt).toBeNull();
  });

  it("keeps day-over-day comparisons pinned to the previous calendar day after today's snapshot exists", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yc-score-benchmarks-"));
    const storePath = path.join(tempDir, "s2026-score-benchmarks.json");
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const firstCompany = graph.leaderboard[0]!;

    ensureBenchmarkMomentum(graph, {
      storePath,
      now: new Date("2026-06-30T12:00:00.000Z")
    });

    const firstJulyRun = ensureBenchmarkMomentum(withCompanyScore(graph, firstCompany.companyId, firstCompany.score + 5), {
      storePath,
      now: new Date("2026-07-01T12:00:00.000Z")
    });
    const secondJulyRun = ensureBenchmarkMomentum(withCompanyScore(graph, firstCompany.companyId, firstCompany.score + 8), {
      storePath,
      now: new Date("2026-07-01T18:00:00.000Z")
    });
    const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
      daily: { recordedAt: string }[];
    };
    const firstJulyRow = firstJulyRun.graph.fastestGaining.find((row) => row.companyId === firstCompany.companyId);
    const secondJulyRow = secondJulyRun.graph.fastestGaining.find((row) => row.companyId === firstCompany.companyId);

    expect(firstJulyRun.recordedDaily).toBe(true);
    expect(secondJulyRun.recordedDaily).toBe(false);
    expect(store.daily.map((snapshot) => snapshot.recordedAt)).toEqual([
      "2026-06-30T12:00:00.000Z",
      "2026-07-01T12:00:00.000Z"
    ]);
    expect(firstJulyRow?.dod.scoreDelta).toBe(5);
    expect(firstJulyRow?.dod.benchmarkedAt).toBe("2026-06-30T12:00:00.000Z");
    expect(secondJulyRow?.dod.scoreDelta).toBe(8);
    expect(secondJulyRow?.dod.benchmarkedAt).toBe("2026-06-30T12:00:00.000Z");
  });

  it("uses the exact seven-days-prior calendar snapshot for week-over-week comparisons", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yc-score-benchmarks-"));
    const storePath = path.join(tempDir, "s2026-score-benchmarks.json");
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const firstCompany = graph.leaderboard[0]!;

    ensureBenchmarkMomentum(graph, {
      storePath,
      now: new Date("2026-06-24T12:00:00.000Z")
    });
    ensureBenchmarkMomentum(withCompanyScore(graph, firstCompany.companyId, firstCompany.score + 4), {
      storePath,
      now: new Date("2026-06-30T12:00:00.000Z")
    });

    const julyFirst = ensureBenchmarkMomentum(withCompanyScore(graph, firstCompany.companyId, firstCompany.score + 10), {
      storePath,
      now: new Date("2026-07-01T12:00:00.000Z")
    });
    const row = julyFirst.graph.fastestGaining.find((candidate) => candidate.companyId === firstCompany.companyId);

    expect(row?.dod.scoreDelta).toBe(6);
    expect(row?.dod.benchmarkedAt).toBe("2026-06-30T12:00:00.000Z");
    expect(row?.wow.scoreDelta).toBe(10);
    expect(row?.wow.benchmarkedAt).toBe("2026-06-24T12:00:00.000Z");
  });

  it("does not fake day-over-day momentum when the previous calendar day is missing", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yc-score-benchmarks-"));
    const storePath = path.join(tempDir, "s2026-score-benchmarks.json");
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const firstCompany = graph.leaderboard[0]!;

    ensureBenchmarkMomentum(graph, {
      storePath,
      now: new Date("2026-06-29T12:00:00.000Z")
    });

    const julyFirst = ensureBenchmarkMomentum(withCompanyScore(graph, firstCompany.companyId, firstCompany.score + 5), {
      storePath,
      now: new Date("2026-07-01T12:00:00.000Z")
    });
    const row = julyFirst.graph.fastestGaining.find((candidate) => candidate.companyId === firstCompany.companyId);

    expect(row?.dod.scoreDelta).toBe(0);
    expect(row?.dod.benchmarkedAt).toBeNull();
  });

  it("can apply stored momentum rows without recording a new benchmark during first paint", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yc-score-benchmarks-"));
    const storePath = path.join(tempDir, "s2026-score-benchmarks.json");
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const firstCompany = graph.leaderboard[0]!;

    ensureBenchmarkMomentum(graph, {
      storePath,
      now: new Date("2026-06-30T12:00:00.000Z")
    });

    const before = fs.readFileSync(storePath, "utf8");
    const hydrated = applyStoredBenchmarkMomentum(withCompanyScore(graph, firstCompany.companyId, firstCompany.score + 5), {
      storePath,
      now: new Date("2026-07-01T12:00:00.000Z")
    });
    const after = fs.readFileSync(storePath, "utf8");
    const row = hydrated.fastestGaining.find((candidate) => candidate.companyId === firstCompany.companyId);

    expect(row?.dod.scoreDelta).toBe(5);
    expect(row?.dod.benchmarkedAt).toBe("2026-06-30T12:00:00.000Z");
    expect(after).toBe(before);
  });
});

function withCompanyScore(graph: GraphResponse, companyId: string, score: number): GraphResponse {
  const leaderboard = graph.leaderboard
    .map((row) => (row.companyId === companyId ? { ...row, score } : row))
    .sort((left, right) => right.score - left.score)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  return {
    ...graph,
    leaderboard
  };
}
