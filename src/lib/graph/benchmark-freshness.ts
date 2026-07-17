import { centralDayKey, isCurrentCentralDay } from "@/lib/time/central-day";
import type { GraphResponse } from "./types";

type BenchmarkGraph = Pick<GraphResponse, "fastestGaining" | "generatedAt" | "scoringContext">;

export function graphBenchmarkDatesAreFresh(graph: BenchmarkGraph, now = new Date()): boolean {
  if (!graph.fastestGaining.length || !graphGenerationMetadataIsFresh(graph, now)) {
    return false;
  }

  return graph.fastestGaining.every(
    (benchmarkRow) =>
      benchmarkDeltaIsFreshOrUnavailable(benchmarkRow.dod, now, 1) &&
      benchmarkDeltaIsFreshOrUnavailable(benchmarkRow.wow, now, 7)
  );
}

function graphGenerationMetadataIsFresh(graph: BenchmarkGraph, now: Date): boolean {
  const modelVersion = graph.scoringContext?.modelVersion;
  const responseBuiltAt = graph.scoringContext?.responseBuiltAt;
  if (!modelVersion?.trim() || !responseBuiltAt) {
    return false;
  }

  const generatedTime = Date.parse(graph.generatedAt);
  const responseBuiltTime = Date.parse(responseBuiltAt);
  return (
    Number.isFinite(generatedTime) &&
    Number.isFinite(responseBuiltTime) &&
    generatedTime === responseBuiltTime &&
    generatedTime <= now.getTime() &&
    isCurrentCentralDay(new Date(generatedTime), now)
  );
}

function benchmarkDeltaIsFreshOrUnavailable(
  delta: GraphResponse["fastestGaining"][number]["dod"],
  now: Date,
  daysBack: number
): boolean {
  const observed =
    delta.baselineScore !== null &&
    Number.isFinite(delta.baselineScore) &&
    delta.baselineRank !== null &&
    Number.isFinite(delta.baselineRank) &&
    benchmarkDateMatchesTarget(delta.benchmarkedAt, now, daysBack);
  if (observed) return true;

  return (
    delta.baselineScore === null &&
    delta.baselineRank === null &&
    delta.benchmarkedAt === null &&
    delta.scoreDelta === 0 &&
    delta.percentDelta === 0 &&
    delta.rankDelta === 0
  );
}

function benchmarkDateMatchesTarget(value: string | null, now: Date, daysBack: number): boolean {
  if (!value) {
    return false;
  }

  const benchmarkDate = new Date(value);
  if (!Number.isFinite(benchmarkDate.getTime())) {
    return false;
  }

  return centralDayKey(benchmarkDate) === offsetCentralDayKey(now, -daysBack);
}

function offsetCentralDayKey(date: Date, days: number): string {
  const dayKey = centralDayKey(date);
  if (!dayKey) {
    return "invalid";
  }
  const [year, month, day] = dayKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1, day! + days, 12));
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0")
  ].join("-");
}
