import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureBenchmarkMomentum } from "@/lib/graph/benchmarks";
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
    expect(updatedRow?.wow.scoreDelta).toBe(5);
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
