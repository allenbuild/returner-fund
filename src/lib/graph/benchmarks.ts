import fs from "node:fs";
import path from "node:path";
import type { FastestGainingRow, GraphResponse, MomentumDelta } from "./types";

const WEEK_DAYS = 7;
// A missed publisher must not make both momentum controls disappear. Look back
// at most one additional scheduler cycle, never forward past the requested
// comparison day, and retain the observed timestamp on every delta.
const MAX_BASELINE_FALLBACK_DAYS = 6;
const CENTRAL_TIME_ZONE = "America/Chicago";
const CENTRAL_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

interface BenchmarkCompanySnapshot {
  companyId: string;
  companyName: string;
  score: number;
  rank: number;
}

interface BenchmarkSnapshot {
  recordedAt: string;
  scoringModelVersion?: string;
  inputGeneratedAt?: string;
  companies: BenchmarkCompanySnapshot[];
}

interface SelectedBenchmarkBaseline {
  snapshot: BenchmarkSnapshot;
  baselineSelection?: "latest_before_target";
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
  const scoringModelVersion = graphScoringModelVersion(graph);
  const dailyBaseline = selectDailyBaseline(store.daily, now, scoringModelVersion);
  const weeklyBaseline = selectWeeklyBaseline([...store.daily, ...store.weekly], now, scoringModelVersion);

  return {
    graph: {
      ...graph,
      fastestGaining: buildBenchmarkMomentumRows(graph, dailyBaseline, weeklyBaseline)
    },
    storePath,
    recordedDaily: false,
    recordedWeekly: false
  };
}

export function recordBenchmarkMomentum(
  graph: GraphResponse,
  options: EnsureBenchmarkOptions = {}
): BenchmarkEnsureResult {
  const now = options.now ?? new Date();
  const storePath = options.storePath ?? benchmarkStorePath(graph.batch.slug);
  const store = readBenchmarkStore(storePath, graph.batch.slug);
  const persistedStore = readBenchmarkStoreForAppend(storePath, graph.batch.slug);
  const scoringModelVersion = graphScoringModelVersion(graph);
  const dailyBaseline = selectDailyBaseline(store.daily, now, scoringModelVersion);
  const weeklyBaseline = selectWeeklyBaseline([...store.daily, ...store.weekly], now, scoringModelVersion);
  const currentSnapshot = snapshotFromGraph(graph, now);
  let recordedDaily = false;
  let recordedWeekly = false;

  if (
    currentSnapshot.companies.length &&
    !latestSnapshotOnCentralDay(store.daily, now, scoringModelVersion)
  ) {
    persistedStore.daily = [...persistedStore.daily, currentSnapshot];
    recordedDaily = true;
  }

  if (
    currentSnapshot.companies.length &&
    shouldRecordWeeklySnapshot(store.weekly, now, scoringModelVersion)
  ) {
    persistedStore.weekly = [...persistedStore.weekly, currentSnapshot];
    recordedWeekly = true;
  }

  if (recordedDaily || recordedWeekly) {
    persistedStore.updatedAt = now.toISOString();
    try {
      writeBenchmarkStore(storePath, persistedStore);
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
  const scoringModelVersion = graphScoringModelVersion(graph);
  const dailyBaseline = selectDailyBaseline(store.daily, now, scoringModelVersion);
  const weeklyBaseline = selectWeeklyBaseline([...store.daily, ...store.weekly], now, scoringModelVersion);

  return {
    ...graph,
    fastestGaining: buildBenchmarkMomentumRows(graph, dailyBaseline, weeklyBaseline)
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

function readBenchmarkStoreForAppend(storePath: string, batchSlug: string): BenchmarkStore {
  if (!fs.existsSync(storePath)) {
    return emptyStore(batchSlug);
  }

  const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<BenchmarkStore>;
  if (
    parsed.version !== 1 ||
    parsed.batchSlug !== batchSlug ||
    typeof parsed.updatedAt !== "string" ||
    !Array.isArray(parsed.daily) ||
    !Array.isArray(parsed.weekly)
  ) {
    throw new Error(`Refusing to append to invalid benchmark store ${storePath}.`);
  }

  return parsed as BenchmarkStore;
}

function writeBenchmarkStore(storePath: string, store: BenchmarkStore): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const temporaryPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, storePath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.rmSync(temporaryPath, { force: true });
    }
  }
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
  const metadata = benchmarkSnapshotMetadata(graph);
  return {
    recordedAt: now.toISOString(),
    ...metadata,
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

function latestSnapshotOnCentralDay(
  snapshots: BenchmarkSnapshot[],
  day: Date,
  scoringModelVersion: string | undefined
): BenchmarkSnapshot | null {
  const dayKey = centralDayKey(day);
  return latestSnapshot(
    snapshots.filter(
      (snapshot) =>
        centralDayKey(new Date(snapshot.recordedAt)) === dayKey &&
        snapshotMatchesScoringModel(snapshot, scoringModelVersion)
    )
  );
}

function selectDailyBaseline(
  snapshots: BenchmarkSnapshot[],
  now: Date,
  scoringModelVersion: string | undefined
): SelectedBenchmarkBaseline | null {
  return selectLatestBaselineOnCentralDay(snapshots, now, 1, scoringModelVersion);
}

function selectWeeklyBaseline(
  snapshots: BenchmarkSnapshot[],
  now: Date,
  scoringModelVersion: string | undefined
): SelectedBenchmarkBaseline | null {
  return selectLatestBaselineOnCentralDay(snapshots, now, WEEK_DAYS, scoringModelVersion);
}

function selectLatestBaselineOnCentralDay(
  snapshots: BenchmarkSnapshot[],
  now: Date,
  daysBack: number,
  scoringModelVersion: string | undefined
): SelectedBenchmarkBaseline | null {
  for (let fallbackDays = 0; fallbackDays <= MAX_BASELINE_FALLBACK_DAYS; fallbackDays += 1) {
    const candidateDayKey = offsetCentralDayKey(now, -(daysBack + fallbackDays));
    const snapshotsOnCandidateDay = snapshots.filter(
      (snapshot) => centralDayKey(new Date(snapshot.recordedAt)) === candidateDayKey
    );
    const sameModelSnapshot = latestSnapshot(
      snapshotsOnCandidateDay.filter((snapshot) =>
        snapshotMatchesScoringModel(snapshot, scoringModelVersion)
      )
    );

    // Benchmark history predates model metadata. Prefer an exact model match,
    // but preserve observed legacy baselines during the v4 migration.
    // Explicitly versioned snapshots from another model remain ineligible.
    const snapshot = sameModelSnapshot ?? latestSnapshot(
      snapshotsOnCandidateDay.filter((candidate) => candidate.scoringModelVersion === undefined)
    );
    if (snapshot) {
      return {
        snapshot,
        ...(fallbackDays > 0
          ? { baselineSelection: "latest_before_target" as const }
          : {})
      };
    }
  }

  return null;
}

function shouldRecordWeeklySnapshot(
  snapshots: BenchmarkSnapshot[],
  now: Date,
  scoringModelVersion: string | undefined
): boolean {
  const latest = latestSnapshot(
    snapshots.filter((snapshot) => snapshotMatchesScoringModel(snapshot, scoringModelVersion))
  );
  if (!latest) {
    return true;
  }
  const latestDayKey = centralDayKey(new Date(latest.recordedAt));
  return latestDayKey !== null && latestDayKey <= offsetCentralDayKey(now, -WEEK_DAYS);
}

function buildBenchmarkMomentumRows(
  graph: GraphResponse,
  dailyBaseline: SelectedBenchmarkBaseline | null,
  weeklyBaseline: SelectedBenchmarkBaseline | null
): FastestGainingRow[] {
  const dailyByCompany = dailyBaseline
    ? snapshotIndex(dailyBaseline.snapshot)
    : new Map<string, BenchmarkCompanySnapshot>();
  const weeklyByCompany = weeklyBaseline
    ? snapshotIndex(weeklyBaseline.snapshot)
    : new Map<string, BenchmarkCompanySnapshot>();

  return graph.leaderboard
    .map((row) => ({
      rank: 0,
      companyId: row.companyId,
      companyName: row.companyName,
      dod: deltaFor(
        row,
        dailyByCompany.get(row.companyId) ?? null,
        dailyBaseline?.snapshot.recordedAt ?? null,
        dailyBaseline?.baselineSelection
      ),
      wow: deltaFor(
        row,
        weeklyByCompany.get(row.companyId) ?? null,
        weeklyBaseline?.snapshot.recordedAt ?? null,
        weeklyBaseline?.baselineSelection
      )
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
  benchmarkedAt: string | null,
  baselineSelection?: "latest_before_target"
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
    benchmarkedAt,
    ...(baselineSelection ? { baselineSelection } : {}),
    ...(baseline === null && benchmarkedAt !== null
      ? { baselineStatus: "not_in_snapshot" as const }
      : {})
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

export function inheritCanonicalCompanyScoring(
  graph: GraphResponse,
  canonicalGraph: GraphResponse
): GraphResponse {
  const canonicalNodes = new Map(
    canonicalGraph.nodes
      .filter((node) => node.entityType === "company")
      .map((node) => [node.entityId, node] as const)
  );
  const canonicalLeaderboard = new Map(
    canonicalGraph.leaderboard.map((row) => [row.companyId, row] as const)
  );
  const canonicalMomentum = new Map(
    canonicalGraph.fastestGaining.map((row) => [row.companyId, row] as const)
  );
  const visibleCompanyIds = graph.nodes
    .filter((node) => node.entityType === "company")
    .map((node) => node.entityId);

  for (const companyId of visibleCompanyIds) {
    if (
      !canonicalNodes.has(companyId) ||
      !canonicalLeaderboard.has(companyId) ||
      !canonicalMomentum.has(companyId)
    ) {
      throw new Error(`Canonical graph is missing scoring surfaces for ${companyId}.`);
    }
  }

  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.entityType !== "company") {
        return node;
      }
      const canonical = canonicalNodes.get(node.entityId)!;
      return {
        ...node,
        score: canonical.score,
        previousScore: canonical.previousScore,
        scoreDelta: canonical.scoreDelta,
        radius: canonical.radius,
        topPlatform: canonical.topPlatform,
        platformScores: canonical.platformScores,
        scoreBreakdown: canonical.scoreBreakdown
      };
    }),
    leaderboard: graph.leaderboard.map((row) => {
      const canonical = canonicalLeaderboard.get(row.companyId);
      if (!canonical) {
        throw new Error(`Canonical graph is missing a leaderboard row for ${row.companyId}.`);
      }
      return {
        ...row,
        rank: canonical.rank,
        score: canonical.score,
        topPlatform: canonical.topPlatform
      };
    }),
    fastestGaining: canonicalGraph.fastestGaining.filter((row) =>
      visibleCompanyIds.includes(row.companyId)
    ),
    generatedAt: canonicalGraph.generatedAt,
    scoringContext: canonicalGraph.scoringContext
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

  const metadata = normalizeBenchmarkSnapshotMetadata(candidate);
  if (metadata === null) {
    return [];
  }

  return [{ recordedAt: candidate.recordedAt, ...metadata, companies }];
}

function normalizeBenchmarkCompanies(companies: unknown[]): BenchmarkCompanySnapshot[] {
  const sorted = companies
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
    );
  let rank = 0;
  let previousScore: number | null = null;

  return sorted.map((company, index) => {
    if (previousScore === null || company.score !== previousScore) {
      rank = index + 1;
    }
    previousScore = company.score;
    return { ...company, rank };
  });
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function benchmarkSnapshotMetadata(
  graph: GraphResponse
): Pick<BenchmarkSnapshot, "scoringModelVersion" | "inputGeneratedAt"> | Record<string, never> {
  const scoringModelVersion = graphScoringModelVersion(graph);
  if (!scoringModelVersion) {
    return {};
  }

  const inputGeneratedAt = graph.generatedAt;
  const responseBuiltAt = graph.scoringContext?.responseBuiltAt;
  if (!isValidTimestamp(inputGeneratedAt) || !isValidTimestamp(responseBuiltAt)) {
    throw new Error("Cannot record a model-aware benchmark without valid graph generation timestamps.");
  }
  if (new Date(inputGeneratedAt).getTime() !== new Date(responseBuiltAt).getTime()) {
    throw new Error("Graph generatedAt and scoringContext.responseBuiltAt must identify the same input.");
  }

  return { scoringModelVersion, inputGeneratedAt };
}

function normalizeBenchmarkSnapshotMetadata(
  candidate: Partial<BenchmarkSnapshot>
): Pick<BenchmarkSnapshot, "scoringModelVersion" | "inputGeneratedAt"> | Record<string, never> | null {
  const hasModelVersion = candidate.scoringModelVersion !== undefined;
  const hasInputGeneratedAt = candidate.inputGeneratedAt !== undefined;
  if (!hasModelVersion && !hasInputGeneratedAt) {
    return {};
  }
  if (
    typeof candidate.scoringModelVersion !== "string" ||
    !candidate.scoringModelVersion.trim() ||
    typeof candidate.inputGeneratedAt !== "string" ||
    !isValidTimestamp(candidate.inputGeneratedAt)
  ) {
    return null;
  }
  return {
    scoringModelVersion: candidate.scoringModelVersion,
    inputGeneratedAt: candidate.inputGeneratedAt
  };
}

function graphScoringModelVersion(graph: GraphResponse): string | undefined {
  const value = graph.scoringContext?.modelVersion;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function snapshotMatchesScoringModel(
  snapshot: BenchmarkSnapshot,
  scoringModelVersion: string | undefined
): boolean {
  return snapshot.scoringModelVersion === scoringModelVersion;
}

function isValidTimestamp(value: string | undefined): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function centralDayKey(date: Date): string | null {
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  const parts = Object.fromEntries(
    CENTRAL_DAY_FORMATTER.formatToParts(date).map((part) => [part.type, part.value])
  );
  return parts.year && parts.month && parts.day
    ? `${parts.year}-${parts.month}-${parts.day}`
    : null;
}

function offsetCentralDayKey(date: Date, days: number): string {
  const dayKey = centralDayKey(date);
  if (!dayKey) {
    throw new Error("Cannot calculate a benchmark day from an invalid date.");
  }
  const [year, month, day] = dayKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1, day! + days, 12));
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0")
  ].join("-");
}
