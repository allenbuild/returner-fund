import { describe, expect, it } from "vitest";
import { graphBenchmarkDatesAreFresh } from "@/lib/graph/benchmark-freshness";
import type { GraphResponse } from "@/lib/graph/types";

describe("graph benchmark freshness", () => {
  it("accepts benchmark dates for yesterday and seven days back", () => {
    const now = new Date(2026, 6, 14, 12);

    expect(
      graphBenchmarkDatesAreFresh(
        benchmarkGraph(localDateIso(now, -1), localDateIso(now, -7)),
        now
      )
    ).toBe(true);
  });

  it("rejects stale benchmark dates from older static graph snapshots", () => {
    const now = new Date(2026, 6, 14, 12);

    expect(
      graphBenchmarkDatesAreFresh(
        benchmarkGraph(localDateIso(now, -2), localDateIso(now, -8)),
        now
      )
    ).toBe(false);
  });
});

function benchmarkGraph(dodBenchmarkedAt: string, wowBenchmarkedAt: string): Pick<GraphResponse, "fastestGaining"> {
  return {
    fastestGaining: [
      {
        rank: 1,
        companyId: "company-1",
        companyName: "Company 1",
        dod: {
          scoreDelta: 1,
          percentDelta: 1,
          rankDelta: 0,
          currentScore: 51,
          currentRank: 1,
          baselineScore: 50,
          baselineRank: 1,
          benchmarkedAt: dodBenchmarkedAt
        },
        wow: {
          scoreDelta: 7,
          percentDelta: 14,
          rankDelta: 1,
          currentScore: 51,
          currentRank: 1,
          baselineScore: 44,
          baselineRank: 2,
          benchmarkedAt: wowBenchmarkedAt
        }
      }
    ]
  };
}

function localDateIso(base: Date, dayOffset: number): string {
  const date = new Date(base);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}
