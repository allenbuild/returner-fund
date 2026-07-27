import { describe, expect, it } from "vitest";
import { graphBenchmarkDatesAreFresh } from "@/lib/graph/benchmark-freshness";
import type { GraphResponse } from "@/lib/graph/types";

describe("graph benchmark freshness", () => {
  it("accepts observed benchmark dates for yesterday and seven Central days back", () => {
    const now = new Date("2026-07-14T17:00:00.000Z");

    expect(
      graphBenchmarkDatesAreFresh(
        benchmarkGraph(now, dayOffsetIso(now, -1), dayOffsetIso(now, -7)),
        now
      )
    ).toBe(true);
  });

  it("rejects stale benchmark dates from older static graph snapshots", () => {
    const now = new Date("2026-07-14T17:00:00.000Z");

    expect(
      graphBenchmarkDatesAreFresh(
        benchmarkGraph(now, dayOffsetIso(now, -2), dayOffsetIso(now, -8)),
        now
      )
    ).toBe(false);
  });

  it("accepts an honest unavailable history window and rejects a synthesized date without a baseline", () => {
    const now = new Date("2026-07-14T17:00:00.000Z");

    expect(
      graphBenchmarkDatesAreFresh(
        benchmarkGraph(now, null, null, { observed: false }),
        now
      )
    ).toBe(true);
    expect(
      graphBenchmarkDatesAreFresh(
        benchmarkGraph(now, dayOffsetIso(now, -1), dayOffsetIso(now, -7), { observed: false }),
        now
      )
    ).toBe(false);
  });

  it("accepts a current day-over-day observation while week-over-week is honestly unavailable", () => {
    const now = new Date("2026-07-14T17:00:00.000Z");
    const graph = benchmarkGraph(now, dayOffsetIso(now, -1), dayOffsetIso(now, -7));
    graph.fastestGaining[0]!.wow = unavailableDelta(graph.fastestGaining[0]!.wow);

    expect(graphBenchmarkDatesAreFresh(graph, now)).toBe(true);
  });

  it("requires current, internally consistent scoring model generation metadata", () => {
    const now = new Date("2026-07-14T17:00:00.000Z");
    const dates = [dayOffsetIso(now, -1), dayOffsetIso(now, -7)] as const;
    const missingContext = benchmarkGraph(now, ...dates);
    missingContext.scoringContext = undefined;
    const mismatchedInput = benchmarkGraph(now, ...dates);
    mismatchedInput.scoringContext = {
      ...mismatchedInput.scoringContext!,
      responseBuiltAt: dayOffsetIso(now, -1)
    };
    const staleGeneration = benchmarkGraph(now, ...dates);
    staleGeneration.generatedAt = dayOffsetIso(now, -1);
    staleGeneration.scoringContext = {
      ...staleGeneration.scoringContext!,
      responseBuiltAt: staleGeneration.generatedAt
    };

    expect(graphBenchmarkDatesAreFresh(missingContext, now)).toBe(false);
    expect(graphBenchmarkDatesAreFresh(mismatchedInput, now)).toBe(false);
    expect(graphBenchmarkDatesAreFresh(staleGeneration, now)).toBe(false);
  });

  it("checks every momentum row rather than trusting only the first", () => {
    const now = new Date("2026-07-14T17:00:00.000Z");
    const graph = benchmarkGraph(now, dayOffsetIso(now, -1), dayOffsetIso(now, -7));
    graph.fastestGaining.push({
      ...graph.fastestGaining[0]!,
      companyId: "company-2",
      companyName: "Company 2",
      dod: { ...graph.fastestGaining[0]!.dod, benchmarkedAt: null }
    });

    expect(graphBenchmarkDatesAreFresh(graph, now)).toBe(false);
  });

  it("uses Central calendar dates across the fall DST transition", () => {
    const now = new Date("2026-11-02T06:30:00.000Z");
    const graph = benchmarkGraph(
      now,
      "2026-11-01T05:30:00.000Z",
      "2026-10-26T05:30:00.000Z"
    );

    expect(graphBenchmarkDatesAreFresh(graph, now)).toBe(true);
  });
});

function benchmarkGraph(
  now: Date,
  dodBenchmarkedAt: string | null,
  wowBenchmarkedAt: string | null,
  { observed = true }: { observed?: boolean } = {}
): Pick<GraphResponse, "fastestGaining" | "generatedAt" | "scoringContext"> {
  const baselineScore = observed ? 50 : null;
  const baselineRank = observed ? 1 : null;
  return {
    generatedAt: now.toISOString(),
    scoringContext: {
      modelId: "traction-score",
      modelVersion: "4.0.1",
      modelName: "Traction score",
      scoreScope: "all_platforms",
      selectedPlatforms: [],
      responseBuiltAt: now.toISOString(),
      evidenceAsOf: null
    },
    fastestGaining: [
      {
        rank: 1,
        companyId: "company-1",
        companyName: "Company 1",
        dod: {
          scoreDelta: observed ? 1 : 0,
          percentDelta: observed ? 2 : 0,
          rankDelta: 0,
          currentScore: 51,
          currentRank: 1,
          baselineScore,
          baselineRank,
          benchmarkedAt: dodBenchmarkedAt
        },
        wow: {
          scoreDelta: observed ? 1 : 0,
          percentDelta: observed ? 2 : 0,
          rankDelta: 0,
          currentScore: 51,
          currentRank: 1,
          baselineScore,
          baselineRank,
          benchmarkedAt: wowBenchmarkedAt
        }
      }
    ]
  };
}

function dayOffsetIso(base: Date, dayOffset: number): string {
  const date = new Date(base);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString();
}

function unavailableDelta(
  delta: GraphResponse["fastestGaining"][number]["wow"]
): GraphResponse["fastestGaining"][number]["wow"] {
  return {
    ...delta,
    scoreDelta: 0,
    percentDelta: 0,
    rankDelta: 0,
    baselineScore: null,
    baselineRank: null,
    benchmarkedAt: null
  };
}
