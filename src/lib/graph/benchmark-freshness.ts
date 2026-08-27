import { centralDayKey, isCurrentCentralDay } from "@/lib/time/central-day";
import type { GraphResponse } from "./types";

type BenchmarkGraph = Pick<GraphResponse, "fastestGaining" | "generatedAt" | "scoringContext">;

const MAX_BASELINE_FALLBACK_DAYS = 6;

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
  const benchmarkDateIsFresh = benchmarkDateMatchesTarget(
    delta.benchmarkedAt,
    now,
    daysBack,
    delta.baselineSelection
  );
  const observed =
    delta.baselineScore !== null &&
    Number.isFinite(delta.baselineScore) &&
    delta.baselineRank !== null &&
    Number.isFinite(delta.baselineRank) &&
    delta.baselineStatus === undefined &&
    benchmarkDateIsFresh;
  if (observed) return true;

  // A company may be new since an otherwise valid cohort snapshot. Preserve
  // the snapshot date while representing that company-specific baseline as
  // absent rather than rejecting the entire graph.
  const absentFromObservedSnapshot =
    delta.baselineScore === null &&
    delta.baselineRank === null &&
    delta.baselineStatus === "not_in_snapshot" &&
    benchmarkDateIsFresh &&
    delta.scoreDelta === 0 &&
    delta.percentDelta === 0 &&
    delta.rankDelta === 0;
  if (absentFromObservedSnapshot) return true;

  return (
    delta.baselineScore === null &&
    delta.baselineRank === null &&
    delta.benchmarkedAt === null &&
    delta.baselineSelection === undefined &&
    delta.baselineStatus === undefined &&
    delta.scoreDelta === 0 &&
    delta.percentDelta === 0 &&
    delta.rankDelta === 0
  );
}

function benchmarkDateMatchesTarget(
  value: string | null,
  now: Date,
  daysBack: number,
  baselineSelection: GraphResponse["fastestGaining"][number]["dod"]["baselineSelection"]
): boolean {
  if (!value) {
    return false;
  }

  const benchmarkDate = new Date(value);
  if (!Number.isFinite(benchmarkDate.getTime())) {
    return false;
  }

  const benchmarkDayKey = centralDayKey(benchmarkDate);
  const targetDayKey = offsetCentralDayKey(now, -daysBack);
  if (benchmarkDayKey === targetDayKey) {
    return baselineSelection === undefined;
  }

  return (
    baselineSelection === "latest_before_target" &&
    benchmarkDayKey !== null &&
    benchmarkDayKey < targetDayKey &&
    benchmarkDayKey >= offsetCentralDayKey(now, -(daysBack + MAX_BASELINE_FALLBACK_DAYS))
  );
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
