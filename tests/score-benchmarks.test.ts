import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyStoredBenchmarkMomentum,
  ensureBenchmarkMomentum,
  inheritCanonicalCompanyScoring,
  recordBenchmarkMomentum
} from "@/lib/graph/benchmarks";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import type { GraphResponse } from "@/lib/graph/types";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import { TRACTION_SCORING_CONFIG } from "@/lib/scoring/traction-config";

describe("score benchmarks", () => {
  it("records only observed snapshots and attaches model/input metadata", () => {
    const { graph, firstCompany, storePath } = benchmarkFixture();
    const firstAt = new Date("2026-06-28T12:00:00.000Z");
    const nextAt = new Date("2026-06-29T12:01:00.000Z");

    const initial = recordBenchmarkMomentum(graph, { storePath, now: firstAt });
    const duplicateRead = ensureBenchmarkMomentum(graph, {
      storePath,
      now: new Date("2026-06-28T18:00:00.000Z")
    });
    const nextDay = recordBenchmarkMomentum(
      withCompanyScore(graph, firstCompany.companyId, firstCompany.score + 5),
      { storePath, now: nextAt }
    );
    const store = readStore(storePath);
    const updatedRow = nextDay.graph.fastestGaining.find((row) => row.companyId === firstCompany.companyId);

    expect(initial.recordedDaily).toBe(true);
    expect(initial.recordedWeekly).toBe(true);
    expect(duplicateRead.recordedDaily).toBe(false);
    expect(duplicateRead.recordedWeekly).toBe(false);
    expect(nextDay.recordedDaily).toBe(true);
    expect(nextDay.recordedWeekly).toBe(false);
    expect(store.daily).toHaveLength(2);
    expect(store.weekly).toHaveLength(1);
    expect(store.daily[0]).toMatchObject({
      recordedAt: firstAt.toISOString(),
      scoringModelVersion: graph.scoringContext?.modelVersion,
      inputGeneratedAt: graph.generatedAt
    });
    expect(updatedRow?.dod.scoreDelta).toBe(5);
    expect(updatedRow?.dod.benchmarkedAt).toBe(firstAt.toISOString());
    expect(updatedRow?.wow.baselineScore).toBeNull();
    expect(updatedRow?.wow.benchmarkedAt).toBeNull();
  });

  it("keeps read helpers pure when history is missing or present", () => {
    const { graph, storePath } = benchmarkFixture();

    const missing = ensureBenchmarkMomentum(graph, {
      storePath,
      now: new Date("2026-07-01T12:00:00.000Z")
    });

    expect(fs.existsSync(storePath)).toBe(false);
    expect(missing.graph.fastestGaining[0]?.dod.benchmarkedAt).toBeNull();
    expect(missing.graph.fastestGaining[0]?.wow.benchmarkedAt).toBeNull();

    recordBenchmarkMomentum(graph, {
      storePath,
      now: new Date("2026-06-30T12:00:00.000Z")
    });
    const before = fs.readFileSync(storePath, "utf8");
    applyStoredBenchmarkMomentum(graph, {
      storePath,
      now: new Date("2026-07-01T12:00:00.000Z")
    });
    const after = fs.readFileSync(storePath, "utf8");

    expect(after).toBe(before);
  });

  it("uses the latest causal observation when a scheduled calendar snapshot is missed", () => {
    const { graph, firstCompany, storePath } = benchmarkFixture();

    recordBenchmarkMomentum(graph, {
      storePath,
      now: new Date("2026-06-29T12:00:00.000Z")
    });
    const julyFirst = recordBenchmarkMomentum(
      withCompanyScore(graph, firstCompany.companyId, firstCompany.score + 5),
      { storePath, now: new Date("2026-07-01T12:00:00.000Z") }
    );
    const store = readStore(storePath);
    const row = julyFirst.graph.fastestGaining.find((candidate) => candidate.companyId === firstCompany.companyId);

    expect(store.daily.map((snapshot) => snapshot.recordedAt)).toEqual([
      "2026-06-29T12:00:00.000Z",
      "2026-07-01T12:00:00.000Z"
    ]);
    expect(row?.dod.baselineScore).toBe(firstCompany.score);
    expect(row?.dod.scoreDelta).toBe(5);
    expect(row?.dod.benchmarkedAt).toBe("2026-06-29T12:00:00.000Z");
    expect(row?.dod.baselineSelection).toBe("latest_before_target");
    // The June 29 observation is later than the June 24 weekly target, so it
    // must never be used as a look-ahead baseline.
    expect(row?.wow.baselineScore).toBeNull();
    expect(row?.wow.benchmarkedAt).toBeNull();
  });

  it("bounds fallback history to one additional scheduler cycle", () => {
    const { graph, firstCompany, storePath } = benchmarkFixture();

    recordBenchmarkMomentum(graph, {
      storePath,
      now: new Date("2026-06-23T12:00:00.000Z")
    });
    const julyFirst = applyStoredBenchmarkMomentum(
      withCompanyScore(graph, firstCompany.companyId, firstCompany.score + 5),
      { storePath, now: new Date("2026-07-01T12:00:00.000Z") }
    );
    const row = julyFirst.fastestGaining.find(
      (candidate) => candidate.companyId === firstCompany.companyId
    );

    expect(row?.dod.baselineScore).toBeNull();
    expect(row?.dod.benchmarkedAt).toBeNull();
    expect(row?.wow.baselineScore).toBe(firstCompany.score);
    expect(row?.wow.benchmarkedAt).toBe("2026-06-23T12:00:00.000Z");
    expect(row?.wow.baselineSelection).toBe("latest_before_target");
  });

  it("uses exact observed Central calendar days for daily and weekly comparisons", () => {
    const { graph, firstCompany, storePath } = benchmarkFixture();

    recordBenchmarkMomentum(graph, {
      storePath,
      now: new Date("2026-06-24T12:00:00.000Z")
    });
    recordBenchmarkMomentum(withCompanyScore(graph, firstCompany.companyId, firstCompany.score + 4), {
      storePath,
      now: new Date("2026-06-30T12:00:00.000Z")
    });
    const julyFirst = recordBenchmarkMomentum(
      withCompanyScore(graph, firstCompany.companyId, firstCompany.score + 10),
      { storePath, now: new Date("2026-07-01T12:00:00.000Z") }
    );
    const row = julyFirst.graph.fastestGaining.find((candidate) => candidate.companyId === firstCompany.companyId);

    expect(row?.dod.scoreDelta).toBe(6);
    expect(row?.dod.benchmarkedAt).toBe("2026-06-30T12:00:00.000Z");
    expect(row?.wow.scoreDelta).toBe(10);
    expect(row?.wow.benchmarkedAt).toBe("2026-06-24T12:00:00.000Z");
  });

  it("uses Central day boundaries across the fall DST transition", () => {
    const { graph, firstCompany, storePath } = benchmarkFixture();

    recordBenchmarkMomentum(graph, {
      storePath,
      now: new Date("2026-11-01T05:30:00.000Z")
    });
    const nextCentralDay = recordBenchmarkMomentum(
      withCompanyScore(graph, firstCompany.companyId, firstCompany.score + 3),
      { storePath, now: new Date("2026-11-02T06:30:00.000Z") }
    );
    const row = nextCentralDay.graph.fastestGaining.find(
      (candidate) => candidate.companyId === firstCompany.companyId
    );

    expect(row?.dod.scoreDelta).toBe(3);
    expect(row?.dod.benchmarkedAt).toBe("2026-11-01T05:30:00.000Z");
  });

  it("does not replace an observed same-day snapshot", () => {
    const { graph, firstCompany, storePath } = benchmarkFixture();

    recordBenchmarkMomentum(graph, {
      storePath,
      now: new Date("2026-06-30T12:00:00.000Z")
    });
    recordBenchmarkMomentum(withCompanyScore(graph, firstCompany.companyId, firstCompany.score + 5), {
      storePath,
      now: new Date("2026-07-01T12:00:00.000Z")
    });
    const before = fs.readFileSync(storePath, "utf8");
    const repeated = recordBenchmarkMomentum(
      withCompanyScore(graph, firstCompany.companyId, firstCompany.score + 8),
      { storePath, now: new Date("2026-07-01T18:00:00.000Z") }
    );
    const row = repeated.graph.fastestGaining.find((candidate) => candidate.companyId === firstCompany.companyId);

    expect(repeated.recordedDaily).toBe(false);
    expect(fs.readFileSync(storePath, "utf8")).toBe(before);
    expect(row?.dod.scoreDelta).toBe(8);
    expect(row?.dod.benchmarkedAt).toBe("2026-06-30T12:00:00.000Z");
  });

  it("never compares scores from explicitly different scoring model versions", () => {
    const { graph, firstCompany, storePath } = benchmarkFixture();
    const oldModelGraph = withModelVersion(graph, "4.1.0");
    const newModelGraph = withModelVersion(graph, TRACTION_SCORING_CONFIG.version);

    recordBenchmarkMomentum(oldModelGraph, {
      storePath,
      now: new Date("2026-06-30T12:00:00.000Z")
    });
    const unmatched = applyStoredBenchmarkMomentum(
      withCompanyScore(newModelGraph, firstCompany.companyId, firstCompany.score + 5),
      { storePath, now: new Date("2026-07-01T12:00:00.000Z") }
    );
    const unmatchedRow = unmatched.fastestGaining.find((candidate) => candidate.companyId === firstCompany.companyId);

    expect(unmatchedRow?.dod.baselineScore).toBeNull();
    expect(unmatchedRow?.dod.benchmarkedAt).toBeNull();

    recordBenchmarkMomentum(newModelGraph, {
      storePath,
      now: new Date("2026-07-01T12:00:00.000Z")
    });
    const matched = applyStoredBenchmarkMomentum(
      withCompanyScore(newModelGraph, firstCompany.companyId, firstCompany.score + 7),
      { storePath, now: new Date("2026-07-02T12:00:00.000Z") }
    );
    const matchedRow = matched.fastestGaining.find((candidate) => candidate.companyId === firstCompany.companyId);

    expect(readStore(storePath).daily).toHaveLength(2);
    expect(matchedRow?.dod.scoreDelta).toBe(7);
    expect(matchedRow?.dod.benchmarkedAt).toBe("2026-07-01T12:00:00.000Z");
  });

  it("uses an observed unversioned baseline when no same-model migration snapshot exists", () => {
    const { graph, firstCompany, storePath } = benchmarkFixture();
    const legacySnapshot = {
      recordedAt: "2026-06-30T12:00:00.000Z",
      companies: graph.leaderboard.map((row) => ({
        companyId: row.companyId,
        companyName: row.companyName,
        score: row.score,
        rank: row.rank
      }))
    };
    writeStore(storePath, {
      version: 1,
      batchSlug: graph.batch.slug,
      updatedAt: legacySnapshot.recordedAt,
      daily: [legacySnapshot],
      weekly: []
    });

    const hydrated = applyStoredBenchmarkMomentum(
      withCompanyScore(graph, firstCompany.companyId, firstCompany.score + 5),
      { storePath, now: new Date("2026-07-01T12:00:00.000Z") }
    );
    const row = hydrated.fastestGaining.find((candidate) => candidate.companyId === firstCompany.companyId);

    expect(row?.dod.baselineScore).toBe(firstCompany.score);
    expect(row?.dod.scoreDelta).toBe(5);
    expect(row?.dod.benchmarkedAt).toBe(legacySnapshot.recordedAt);
  });

  it("preserves existing historical entries byte-for-value when appending", () => {
    const { graph, storePath } = benchmarkFixture();
    const legacySnapshot = {
      recordedAt: "2026-06-30T12:00:00.000Z",
      legacyMarker: "do-not-rewrite",
      companies: [
        {
          companyId: graph.leaderboard[0]!.companyId,
          companyName: graph.leaderboard[0]!.companyName,
          score: 10,
          rank: 99
        }
      ]
    };
    writeStore(storePath, {
      version: 1,
      batchSlug: graph.batch.slug,
      updatedAt: legacySnapshot.recordedAt,
      daily: [legacySnapshot],
      weekly: []
    });

    recordBenchmarkMomentum(graph, {
      storePath,
      now: new Date("2026-07-01T12:00:00.000Z")
    });
    const store = readStore(storePath);

    expect(store.daily[0]).toEqual(legacySnapshot);
    expect(store.daily).toHaveLength(2);
  });

  it("normalizes corrupt stored ranks from score order without mutating the file", () => {
    const { graph, storePath } = benchmarkFixture();
    const [firstCompany, secondCompany, thirdCompany] = graph.leaderboard;
    const snapshot = {
      recordedAt: "2026-06-30T12:00:00.000Z",
      scoringModelVersion: graph.scoringContext!.modelVersion,
      inputGeneratedAt: graph.generatedAt,
      companies: [
        { companyId: firstCompany.companyId, companyName: firstCompany.companyName, score: 10, rank: 24 },
        { companyId: secondCompany.companyId, companyName: secondCompany.companyName, score: 90, rank: 24 },
        { companyId: thirdCompany.companyId, companyName: thirdCompany.companyName, score: 50, rank: 24 }
      ]
    };
    writeStore(storePath, {
      version: 1,
      batchSlug: graph.batch.slug,
      updatedAt: snapshot.recordedAt,
      daily: [snapshot],
      weekly: []
    });
    const before = fs.readFileSync(storePath, "utf8");

    const hydrated = applyStoredBenchmarkMomentum(graph, {
      storePath,
      now: new Date("2026-07-01T12:00:00.000Z")
    });
    const firstRow = hydrated.fastestGaining.find((candidate) => candidate.companyId === firstCompany.companyId);
    const secondRow = hydrated.fastestGaining.find((candidate) => candidate.companyId === secondCompany.companyId);

    expect(firstRow?.dod.baselineRank).toBe(3);
    expect(secondRow?.dod.baselineRank).toBe(1);
    expect(fs.readFileSync(storePath, "utf8")).toBe(before);
  });

  it("ignores malformed model metadata instead of treating it as an observation", () => {
    const { graph, firstCompany, storePath } = benchmarkFixture();
    writeStore(storePath, {
      version: 1,
      batchSlug: graph.batch.slug,
      updatedAt: "2026-06-30T12:00:00.000Z",
      daily: [
        {
          recordedAt: "2026-06-30T12:00:00.000Z",
          scoringModelVersion: graph.scoringContext!.modelVersion,
          companies: [
            {
              companyId: firstCompany.companyId,
              companyName: firstCompany.companyName,
              score: firstCompany.score,
              rank: 1
            }
          ]
        }
      ],
      weekly: []
    });

    const hydrated = applyStoredBenchmarkMomentum(
      withCompanyScore(graph, firstCompany.companyId, firstCompany.score + 5),
      { storePath, now: new Date("2026-07-01T12:00:00.000Z") }
    );
    const row = hydrated.fastestGaining.find((candidate) => candidate.companyId === firstCompany.companyId);

    expect(row?.dod.baselineScore).toBeNull();
    expect(row?.dod.benchmarkedAt).toBeNull();
  });

  it("inherits canonical ranks and momentum without fabricating missing audience baselines", () => {
    const { graph } = benchmarkFixture();
    const companyRow = graph.leaderboard[2]!;
    const companyNode = graph.nodes.find((node) => node.entityId === companyRow.companyId)!;
    const localAudienceGraph: GraphResponse = {
      ...graph,
      nodes: [{ ...companyNode, score: 100, radius: 68 }],
      leaderboard: [{ ...companyRow, rank: 1, score: 100 }],
      fastestGaining: []
    };
    const inherited = inheritCanonicalCompanyScoring(localAudienceGraph, graph);
    const canonicalMomentum = graph.fastestGaining.find((row) => row.companyId === companyRow.companyId);

    expect(inherited.nodes[0]).toMatchObject({
      score: companyNode.score,
      radius: companyNode.radius,
      scoreBreakdown: companyNode.scoreBreakdown
    });
    expect(inherited.leaderboard[0]).toMatchObject({
      rank: companyRow.rank,
      score: companyRow.score
    });
    expect(inherited.fastestGaining).toEqual([canonicalMomentum]);
    expect(() => inheritCanonicalCompanyScoring(localAudienceGraph, {
      ...graph,
      fastestGaining: graph.fastestGaining.filter((row) => row.companyId !== companyRow.companyId)
    })).toThrow(`Canonical graph is missing scoring surfaces for ${companyRow.companyId}.`);
  });
});

function benchmarkFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yc-score-benchmarks-"));
  const storePath = path.join(tempDir, "s2026-score-benchmarks.json");
  const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
  return { graph, firstCompany: graph.leaderboard[0]!, storePath };
}

function readStore(storePath: string): {
  daily: Array<Record<string, unknown> & { recordedAt: string }>;
  weekly: Array<Record<string, unknown> & { recordedAt: string }>;
} {
  return JSON.parse(fs.readFileSync(storePath, "utf8"));
}

function writeStore(storePath: string, store: unknown): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function withCompanyScore(graph: GraphResponse, companyId: string, score: number): GraphResponse {
  const leaderboard = graph.leaderboard
    .map((row) => (row.companyId === companyId ? { ...row, score } : row))
    .sort((left, right) => right.score - left.score)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  return { ...graph, leaderboard };
}

function withModelVersion(graph: GraphResponse, modelVersion: string): GraphResponse {
  return {
    ...graph,
    scoringContext: graph.scoringContext
      ? { ...graph.scoringContext, modelVersion }
      : undefined
  };
}
