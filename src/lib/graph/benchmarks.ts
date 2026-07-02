import fs from "node:fs";
import path from "node:path";
import type { FastestGainingRow, GraphResponse, MomentumDelta } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MAX_DAILY_SNAPSHOTS = 45;
const MAX_WEEKLY_SNAPSHOTS = 20;

interface BenchmarkCompanySnapshot {
  companyId: string;
  companyName: string;
  score: number;
  rank: number;
}

interface BenchmarkSnapshot {
  recordedAt: string;
  companies: BenchmarkCompanySnapshot[];
}

interface BenchmarkStore {
  version: 1;
  batchSlug: string;
  updatedAt: string;
  daily: BenchmarkSnapshot[];
  weekly: BenchmarkSnapshot[];
}

interface EnsureBenchmarkOptions {
  now?: Date;
  storePath?: string;
}

export interface BenchmarkEnsureResult {
  graph: GraphResponse;
  storePath: string;
  recordedDaily: boolean;
  recordedWeekly: boolean;
}

export function ensureBenchmarkMomentum(
  graph: GraphResponse,
  options: EnsureBenchmarkOptions = {}
): BenchmarkEnsureResult {
  const now = options.now ?? new Date();
  const storePath = options.storePath ?? benchmarkStorePath(graph.batch.slug);
  const store = readBenchmarkStore(storePath, graph.batch.slug);
  const currentSnapshot = snapshotFromGraph(graph, now);
  const dailyBaseline = selectCalendarBaseline(store.daily, now, 1);
  const weeklyBaseline = selectCalendarBaseline([...store.daily, ...store.weekly], now, 7);
  let recordedDaily = false;
  let recordedWeekly = false;

  if (!latestSnapshotOnSameDay(store.daily, now)) {
    store.daily = [...store.daily, currentSnapshot].slice(-MAX_DAILY_SNAPSHOTS);
    recordedDaily = true;
  }

  if (shouldRecordWeeklySnapshot(store.weekly, now)) {
    store.weekly = [...store.weekly, currentSnapshot].slice(-MAX_WEEKLY_SNAPSHOTS);
    recordedWeekly = true;
  }

  if (recordedDaily || recordedWeekly) {
    store.updatedAt = now.toISOString();
    try {
      writeBenchmarkStore(storePath, store);
    } catch (error) {
      console.error("Failed to persist score benchmark snapshot", error);
      recordedDaily = false;
      recordedWeekly = false;
    }
  }

  return {
    graph: {
      ...graph,
      fastestGaining: buildBenchmarkMomentumRows(graph, dailyBaseline, weeklyBaseline)
    },
    storePath,
    recordedDaily,
    recordedWeekly
  };
}

export function applyStoredBenchmarkMomentum(
  graph: GraphResponse,
  options: EnsureBenchmarkOptions = {}
): GraphResponse {
  const now = options.now ?? new Date();
  const storePath = options.storePath ?? benchmarkStorePath(graph.batch.slug);
  const store = readBenchmarkStore(storePath, graph.batch.slug);
  const dailyBaseline = selectCalendarBaseline(store.daily, now, 1);
  const weeklyBaseline = selectCalendarBaseline([...store.daily, ...store.weekly], now, 7);

  return {
    ...graph,
    fastestGaining: buildBenchmarkMomentumRows(graph, dailyBaseline, weeklyBaseline)
  };
}

function benchmarkStorePath(batchSlug: string): string {
  return path.join(process.cwd(), "outputs", "benchmarks", `${batchSlug.toLowerCase()}-score-benchmarks.json`);
}

function readBenchmarkStore(storePath: string, batchSlug: string): BenchmarkStore {
  if (!fs.existsSync(storePath)) {
    return emptyStore(batchSlug);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<BenchmarkStore>;
    return {
      version: 1,
      batchSlug,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      daily: Array.isArray(parsed.daily) ? parsed.daily.filter(isBenchmarkSnapshot) : [],
      weekly: Array.isArray(parsed.weekly) ? parsed.weekly.filter(isBenchmarkSnapshot) : []
    };
  } catch {
    return emptyStore(batchSlug);
  }
}

function writeBenchmarkStore(storePath: string, store: BenchmarkStore): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function emptyStore(batchSlug: string): BenchmarkStore {
  return {
    version: 1,
    batchSlug,
    updatedAt: new Date(0).toISOString(),
    daily: [],
    weekly: []
  };
}

function snapshotFromGraph(graph: GraphResponse, now: Date): BenchmarkSnapshot {
  return {
    recordedAt: now.toISOString(),
    companies: graph.leaderboard.map((row) => ({
      companyId: row.companyId,
      companyName: row.companyName,
      score: row.score,
      rank: row.rank
    }))
  };
}

function latestSnapshot(snapshots: BenchmarkSnapshot[]): BenchmarkSnapshot | null {
  return snapshots[snapshots.length - 1] ?? null;
}

function latestSnapshotOnSameDay(snapshots: BenchmarkSnapshot[], day: Date): BenchmarkSnapshot | null {
  return latestSnapshot(snapshots.filter((snapshot) => isSameLocalDay(new Date(snapshot.recordedAt), day)));
}

function selectCalendarBaseline(snapshots: BenchmarkSnapshot[], now: Date, daysBack: number): BenchmarkSnapshot | null {
  const targetDay = addLocalDays(startOfLocalDay(now), -daysBack);
  return latestSnapshot(snapshots.filter((snapshot) => isSameLocalDay(new Date(snapshot.recordedAt), targetDay)));
}

function shouldRecordWeeklySnapshot(snapshots: BenchmarkSnapshot[], now: Date): boolean {
  const latest = latestSnapshot(snapshots);
  if (!latest) {
    return true;
  }
  const recordedAt = new Date(latest.recordedAt).getTime();
  return Number.isFinite(recordedAt) && now.getTime() - recordedAt >= WEEK_MS;
}

function buildBenchmarkMomentumRows(
  graph: GraphResponse,
  dailyBaseline: BenchmarkSnapshot | null,
  weeklyBaseline: BenchmarkSnapshot | null
): FastestGainingRow[] {
  const dailyByCompany = dailyBaseline ? snapshotIndex(dailyBaseline) : new Map<string, BenchmarkCompanySnapshot>();
  const weeklyByCompany = weeklyBaseline ? snapshotIndex(weeklyBaseline) : new Map<string, BenchmarkCompanySnapshot>();

  return graph.leaderboard
    .map((row) => ({
      rank: 0,
      companyId: row.companyId,
      companyName: row.companyName,
      dod: deltaFor(row, dailyByCompany.get(row.companyId) ?? null, dailyBaseline?.recordedAt ?? null),
      wow: deltaFor(row, weeklyByCompany.get(row.companyId) ?? null, weeklyBaseline?.recordedAt ?? null)
    }))
    .sort(momentumSort("dod"))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function snapshotIndex(snapshot: BenchmarkSnapshot): Map<string, BenchmarkCompanySnapshot> {
  return new Map(snapshot.companies.map((company) => [company.companyId, company]));
}

function deltaFor(
  current: GraphResponse["leaderboard"][number],
  baseline: BenchmarkCompanySnapshot | null,
  benchmarkedAt: string | null
): MomentumDelta {
  const baselineScore = baseline?.score ?? null;
  const baselineRank = baseline?.rank ?? null;
  const scoreDelta = baselineScore === null ? 0 : round(current.score - baselineScore);

  return {
    scoreDelta,
    percentDelta: baselineScore === null ? 0 : round((scoreDelta / Math.max(baselineScore, 1)) * 100),
    rankDelta: baselineRank === null ? 0 : baselineRank - current.rank,
    currentScore: current.score,
    currentRank: current.rank,
    baselineScore,
    baselineRank,
    benchmarkedAt
  };
}

export function momentumSort(period: "dod" | "wow") {
  return (left: FastestGainingRow, right: FastestGainingRow): number => {
    const leftDelta = left[period];
    const rightDelta = right[period];
    return (
      rightDelta.scoreDelta - leftDelta.scoreDelta ||
      rightDelta.rankDelta - leftDelta.rankDelta ||
      rightDelta.currentScore - leftDelta.currentScore ||
      left.companyName.localeCompare(right.companyName)
    );
  };
}

export function applyBenchmarkMomentumRows(
  graph: GraphResponse,
  benchmarkRows: FastestGainingRow[]
): GraphResponse {
  const benchmarkByCompany = new Map(benchmarkRows.map((row) => [row.companyId, row]));

  return {
    ...graph,
    fastestGaining: graph.leaderboard
      .flatMap((row) => {
        const benchmark = benchmarkByCompany.get(row.companyId);
        if (!benchmark) {
          return [];
        }
        return [
          {
            ...benchmark,
            companyName: row.companyName
          }
        ];
      })
      .sort(momentumSort("dod"))
      .map((row, index) => ({ ...row, rank: index + 1 }))
  };
}

function isBenchmarkSnapshot(value: unknown): value is BenchmarkSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<BenchmarkSnapshot>;
  return typeof candidate.recordedAt === "string" && Array.isArray(candidate.companies);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}
