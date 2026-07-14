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
  let repairedCalendarSnapshots = ensureCalendarBenchmarkSnapshots(store, now);
  const dailyBaseline = selectDailyBaseline(store.daily, now);
  const weeklyBaseline = selectWeeklyBaseline([...store.daily, ...store.weekly], now);
  let recordedDaily = false;
  let recordedWeekly = false;
  const sameDayDailySnapshot = latestSnapshotOnSameDay(store.daily, now);

  if (currentSnapshot.companies.length && shouldRecordDailySnapshot(sameDayDailySnapshot, currentSnapshot)) {
    store.daily = upsertSnapshotForLocalDay(store.daily, currentSnapshot, now).slice(-MAX_DAILY_SNAPSHOTS);
    recordedDaily = true;
  }

  if (currentSnapshot.companies.length && shouldRecordWeeklySnapshot(store.weekly, now)) {
    store.weekly = [...store.weekly, currentSnapshot].slice(-MAX_WEEKLY_SNAPSHOTS);
    recordedWeekly = true;
  }

  if (repairedCalendarSnapshots || recordedDaily || recordedWeekly) {
    store.updatedAt = now.toISOString();
    try {
      writeBenchmarkStore(storePath, store);
    } catch (error) {
      console.error("Failed to persist score benchmark snapshot", error);
      repairedCalendarSnapshots = false;
      recordedDaily = false;
      recordedWeekly = false;
    }
  }

  return {
    graph: {
      ...graph,
      fastestGaining: buildBenchmarkMomentumRows(graph, dailyBaseline, weeklyBaseline, now)
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
  const dailyBaseline = selectDailyBaseline(store.daily, now);
  const weeklyBaseline = selectWeeklyBaseline([...store.daily, ...store.weekly], now);

  return {
    ...graph,
    fastestGaining: buildBenchmarkMomentumRows(graph, dailyBaseline, weeklyBaseline, now)
  };
}

export function benchmarkStoreVersion(batchSlug: string): string {
  const storePath = benchmarkStorePath(batchSlug);
  try {
    const stat = fs.statSync(storePath);
    return `${Math.round(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return "missing";
  }
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
      daily: Array.isArray(parsed.daily) ? parsed.daily.flatMap(normalizeBenchmarkSnapshot) : [],
      weekly: Array.isArray(parsed.weekly) ? parsed.weekly.flatMap(normalizeBenchmarkSnapshot) : []
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
    companies: normalizeBenchmarkCompanies(graph.leaderboard.map((row) => ({
      companyId: row.companyId,
      companyName: row.companyName,
      score: row.score,
      rank: row.rank
    })))
  };
}

function latestSnapshot(snapshots: BenchmarkSnapshot[]): BenchmarkSnapshot | null {
  return snapshots.reduce<BenchmarkSnapshot | null>((latest, snapshot) => {
    if (!latest) {
      return snapshot;
    }
    return new Date(snapshot.recordedAt).getTime() > new Date(latest.recordedAt).getTime() ? snapshot : latest;
  }, null);
}

function latestSnapshotOnSameDay(snapshots: BenchmarkSnapshot[], day: Date): BenchmarkSnapshot | null {
  return latestSnapshot(snapshots.filter((snapshot) => isSameLocalDay(new Date(snapshot.recordedAt), day)));
}

function shouldRecordDailySnapshot(
  existingSnapshot: BenchmarkSnapshot | null,
  currentSnapshot: BenchmarkSnapshot
): boolean {
  return !existingSnapshot || currentSnapshot.companies.length > existingSnapshot.companies.length;
}

function upsertSnapshotForLocalDay(
  snapshots: BenchmarkSnapshot[],
  snapshot: BenchmarkSnapshot,
  day: Date
): BenchmarkSnapshot[] {
  return sortSnapshots([
    ...snapshots.filter((candidate) => !isSameLocalDay(new Date(candidate.recordedAt), day)),
    snapshot
  ]);
}

function selectDailyBaseline(snapshots: BenchmarkSnapshot[], now: Date): BenchmarkSnapshot | null {
  return selectLatestBaselineOnLocalDay(snapshots, now, 1);
}

function selectWeeklyBaseline(snapshots: BenchmarkSnapshot[], now: Date): BenchmarkSnapshot | null {
  return selectLatestBaselineOnLocalDay(snapshots, now, 7);
}

function selectLatestBaselineOnLocalDay(
  snapshots: BenchmarkSnapshot[],
  now: Date,
  daysBack: number
): BenchmarkSnapshot | null {
  const targetDayStart = addLocalDays(startOfLocalDay(now), -daysBack);
  const targetDayEnd = addLocalDays(targetDayStart, 1);
  return latestSnapshot(
    snapshots.filter((snapshot) => {
      const recordedAt = new Date(snapshot.recordedAt).getTime();
      return (
        Number.isFinite(recordedAt) &&
        recordedAt >= targetDayStart.getTime() &&
        recordedAt < targetDayEnd.getTime()
      );
    })
  );
}

function ensureCalendarBenchmarkSnapshots(store: BenchmarkStore, now: Date): boolean {
  const currentDayStart = startOfLocalDay(now);
  let changed = false;

  for (let daysBack = 7; daysBack >= 1; daysBack -= 1) {
    const targetDayStart = addLocalDays(currentDayStart, -daysBack);
    if (latestSnapshotOnSameDay(store.daily, targetDayStart)) {
      continue;
    }

    const source = nearestSnapshotForCalendarDay([...store.daily, ...store.weekly], targetDayStart);
    if (!source) {
      continue;
    }

    store.daily.push(snapshotForCalendarDay(source, targetDayStart));
    changed = true;
  }

  if (changed) {
    store.daily = sortSnapshots(store.daily).slice(-MAX_DAILY_SNAPSHOTS);
  }

  return changed;
}

function nearestSnapshotForCalendarDay(
  snapshots: BenchmarkSnapshot[],
  targetDayStart: Date
): BenchmarkSnapshot | null {
  const targetDayEnd = addLocalDays(targetDayStart, 1);
  const prior = latestSnapshot(
    snapshots.filter((snapshot) => {
      const recordedAt = new Date(snapshot.recordedAt).getTime();
      return Number.isFinite(recordedAt) && recordedAt < targetDayStart.getTime();
    })
  );
  if (prior) {
    return prior;
  }

  return earliestSnapshot(
    snapshots.filter((snapshot) => {
      const recordedAt = new Date(snapshot.recordedAt).getTime();
      return Number.isFinite(recordedAt) && recordedAt >= targetDayEnd.getTime();
    })
  );
}

function snapshotForCalendarDay(source: BenchmarkSnapshot, targetDayStart: Date): BenchmarkSnapshot {
  return {
    recordedAt: targetDayStart.toISOString(),
    companies: source.companies.map((company) => ({ ...company }))
  };
}

function earliestSnapshot(snapshots: BenchmarkSnapshot[]): BenchmarkSnapshot | null {
  return snapshots.reduce<BenchmarkSnapshot | null>((earliest, snapshot) => {
    if (!earliest) {
      return snapshot;
    }
    return new Date(snapshot.recordedAt).getTime() < new Date(earliest.recordedAt).getTime() ? snapshot : earliest;
  }, null);
}

function sortSnapshots(snapshots: BenchmarkSnapshot[]): BenchmarkSnapshot[] {
  return [...snapshots].sort((left, right) => new Date(left.recordedAt).getTime() - new Date(right.recordedAt).getTime());
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
  weeklyBaseline: BenchmarkSnapshot | null,
  now: Date
): FastestGainingRow[] {
  const dailyByCompany = dailyBaseline ? snapshotIndex(dailyBaseline) : new Map<string, BenchmarkCompanySnapshot>();
  const weeklyByCompany = weeklyBaseline ? snapshotIndex(weeklyBaseline) : new Map<string, BenchmarkCompanySnapshot>();
  const dailyTargetAt = baselineTargetRecordedAt(now, 1);
  const weeklyTargetAt = baselineTargetRecordedAt(now, 7);

  return graph.leaderboard
    .map((row) => ({
      rank: 0,
      companyId: row.companyId,
      companyName: row.companyName,
      dod: deltaFor(row, dailyByCompany.get(row.companyId) ?? null, dailyBaseline?.recordedAt ?? dailyTargetAt),
      wow: deltaFor(row, weeklyByCompany.get(row.companyId) ?? null, weeklyBaseline?.recordedAt ?? weeklyTargetAt)
    }))
    .sort(momentumSort("dod"))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function baselineTargetRecordedAt(now: Date, daysBack: number): string {
  return addLocalDays(startOfLocalDay(now), -daysBack).toISOString();
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
      rightDelta.percentDelta - leftDelta.percentDelta ||
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
      .map((row) => {
        const benchmark = benchmarkByCompany.get(row.companyId);
        return benchmark
          ? {
              ...benchmark,
              companyName: row.companyName
            }
          : neutralBenchmarkRow(row);
      })
      .sort(momentumSort("dod"))
      .map((row, index) => ({ ...row, rank: index + 1 }))
  };
}

function neutralBenchmarkRow(row: GraphResponse["leaderboard"][number]): FastestGainingRow {
  return {
    rank: 0,
    companyId: row.companyId,
    companyName: row.companyName,
    dod: deltaFor(row, null, null),
    wow: deltaFor(row, null, null)
  };
}

function normalizeBenchmarkSnapshot(value: unknown): BenchmarkSnapshot[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const candidate = value as Partial<BenchmarkSnapshot>;
  if (typeof candidate.recordedAt !== "string" || !Array.isArray(candidate.companies)) {
    return [];
  }

  const recordedAt = new Date(candidate.recordedAt).getTime();
  if (!Number.isFinite(recordedAt)) {
    return [];
  }

  const companies = normalizeBenchmarkCompanies(candidate.companies);
  if (!companies.length) {
    return [];
  }

  return [{ recordedAt: candidate.recordedAt, companies }];
}

function normalizeBenchmarkCompanies(companies: unknown[]): BenchmarkCompanySnapshot[] {
  return companies
    .flatMap((company): BenchmarkCompanySnapshot[] => {
      if (!company || typeof company !== "object") {
        return [];
      }
      const snapshotCompany = company as Partial<BenchmarkCompanySnapshot>;
      if (
        typeof snapshotCompany.companyId !== "string" ||
        typeof snapshotCompany.companyName !== "string" ||
        typeof snapshotCompany.score !== "number" ||
        !Number.isFinite(snapshotCompany.score)
      ) {
        return [];
      }
      return [
        {
          companyId: snapshotCompany.companyId,
          companyName: snapshotCompany.companyName,
          score: snapshotCompany.score,
          rank: 0
        }
      ];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.companyName.localeCompare(right.companyName) ||
        left.companyId.localeCompare(right.companyId)
    )
    .map((company, index) => ({ ...company, rank: index + 1 }));
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
