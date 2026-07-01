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
  const dailyBaseline = latestSnapshot(store.daily) ?? currentSnapshot;
  const weeklyBaseline = latestSnapshot(store.weekly) ?? currentSnapshot;
  let recordedDaily = false;
  let recordedWeekly = false;

  if (shouldRecordSnapshot(dailyBaseline, now, DAY_MS)) {
    store.daily = [...store.daily, currentSnapshot].slice(-MAX_DAILY_SNAPSHOTS);
    recordedDaily = true;
  } else if (!store.daily.length) {
    store.daily = [currentSnapshot];
    recordedDaily = true;
  }

  if (shouldRecordSnapshot(weeklyBaseline, now, WEEK_MS)) {
    store.weekly = [...store.weekly, currentSnapshot].slice(-MAX_WEEKLY_SNAPSHOTS);
    recordedWeekly = true;
  } else if (!store.weekly.length) {
    store.weekly = [currentSnapshot];
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

function shouldRecordSnapshot(snapshot: BenchmarkSnapshot, now: Date, intervalMs: number): boolean {
  const recordedAt = new Date(snapshot.recordedAt).getTime();
  return Number.isFinite(recordedAt) && now.getTime() - recordedAt >= intervalMs;
}

function buildBenchmarkMomentumRows(
  graph: GraphResponse,
  dailyBaseline: BenchmarkSnapshot,
  weeklyBaseline: BenchmarkSnapshot
): FastestGainingRow[] {
  const dailyByCompany = snapshotIndex(dailyBaseline);
  const weeklyByCompany = snapshotIndex(weeklyBaseline);

  return graph.leaderboard
    .map((row) => ({
      rank: 0,
      companyId: row.companyId,
      companyName: row.companyName,
      dod: deltaFor(row, dailyByCompany.get(row.companyId) ?? null, dailyBaseline.recordedAt),
      wow: deltaFor(row, weeklyByCompany.get(row.companyId) ?? null, weeklyBaseline.recordedAt)
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
