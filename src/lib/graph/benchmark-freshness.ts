import type { GraphResponse } from "./types";

type BenchmarkGraph = Pick<GraphResponse, "fastestGaining">;

export function graphBenchmarkDatesAreFresh(graph: BenchmarkGraph, now = new Date()): boolean {
  const benchmarkRow = graph.fastestGaining.find(
    (row) => row.dod.benchmarkedAt || row.wow.benchmarkedAt
  );

  if (!benchmarkRow) {
    return true;
  }

  return (
    benchmarkDateMatchesTarget(benchmarkRow.dod.benchmarkedAt, now, 1) &&
    benchmarkDateMatchesTarget(benchmarkRow.wow.benchmarkedAt, now, 7)
  );
}

function benchmarkDateMatchesTarget(value: string | null, now: Date, daysBack: number): boolean {
  if (!value) {
    return true;
  }

  const benchmarkDate = new Date(value);
  if (!Number.isFinite(benchmarkDate.getTime())) {
    return false;
  }

  return localDayKey(benchmarkDate) === localDayKey(addLocalDays(startOfLocalDay(now), -daysBack));
}

function localDayKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}
