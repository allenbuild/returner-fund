#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const CENTRAL_TIME_ZONE = "America/Chicago";
const DEFAULT_MODEL_VERSION = "4.2.0";
const DEFAULT_SOURCE_DATE = "2026-08-05";
const DEFAULT_TARGET_DATES = ["2026-08-06", "2026-08-07", "2026-08-08"];
const BATCHES = ["S2026", "S26", "A16ZSR006"];
const GRAPH_FILES_BY_BATCH = new Map([
  ["S2026", ["s2026.json", "s2026-yc-partners.json", "s2026-insiders.json"]],
  ["S26", ["s26.json", "s26-yc-partners.json", "s26-insiders.json"]],
  ["A16ZSR006", ["a16zsr006.json", "a16zsr006-yc-partners.json", "a16zsr006-insiders.json"]]
]);
const centralDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: CENTRAL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

export async function main(rawArgs = process.argv.slice(2)) {
  const args = parseArgs(rawArgs);
  const result = await repairBenchmarkHistory(args);
  const graphResult = args.rebuildPublicGraphs
    ? await rebuildPublicGraphMomentum(args)
    : null;
  const payload = graphResult ? { ...result, publicGraphs: graphResult } : result;
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

export async function repairBenchmarkHistory({
  rootDir = process.cwd(),
  sourceDate = DEFAULT_SOURCE_DATE,
  targetDates = DEFAULT_TARGET_DATES,
  scoringModelVersion = DEFAULT_MODEL_VERSION,
  write = false
} = {}) {
  assertCentralDate(sourceDate, "source date");
  if (!Array.isArray(targetDates) || targetDates.length === 0) {
    throw new Error("At least one target date is required.");
  }
  for (const targetDate of targetDates) {
    assertCentralDate(targetDate, "target date");
    if (targetDate <= sourceDate) {
      throw new Error(`Target date ${targetDate} must be after source date ${sourceDate}.`);
    }
  }
  if (typeof scoringModelVersion !== "string" || !scoringModelVersion.trim()) {
    throw new Error("A scoring model version is required.");
  }

  const batches = [];
  for (const batchSlug of BATCHES) {
    const targetPath = path.join(
      rootDir,
      "outputs",
      "benchmarks",
      `${batchSlug.toLowerCase()}-score-benchmarks.json`
    );
    const history = JSON.parse(await readFile(targetPath, "utf8"));
    assertHistory(history, batchSlug, targetPath);
    const sourceSnapshot = latestSnapshotOnCentralDate(
      history.daily,
      sourceDate,
      scoringModelVersion
    );
    if (!sourceSnapshot) {
      throw new Error(
        `${targetPath} has no ${scoringModelVersion} daily snapshot for ${sourceDate}; refusing to infer a baseline.`
      );
    }

    const existingDates = new Set(
      history.daily
        .filter((snapshot) => snapshot?.scoringModelVersion === scoringModelVersion)
        .map((snapshot) => centralDayKey(snapshot.recordedAt))
        .filter(Boolean)
    );
    const insertedDates = targetDates.filter((targetDate) => !existingDates.has(targetDate));
    const nextHistory = insertedDates.length === 0
      ? history
      : {
          ...history,
          daily: [...history.daily, ...insertedDates.map((targetDate) =>
            recoveredSnapshot(sourceSnapshot, sourceDate, targetDate)
          )].sort(compareSnapshots)
        };

    if (write && nextHistory !== history) {
      await writeJsonAtomically(targetPath, nextHistory);
    }

    batches.push({
      batchSlug,
      targetPath,
      sourceRecordedAt: sourceSnapshot.recordedAt,
      insertedDates,
      alreadyPresentDates: targetDates.filter((targetDate) => existingDates.has(targetDate))
    });
  }

  return {
    status: write ? "repaired" : "dry-run",
    sourceDate,
    targetDates,
    scoringModelVersion,
    batches
  };
}

export async function rebuildPublicGraphMomentum({
  rootDir = process.cwd(),
  write = false
} = {}) {
  const batches = [];

  for (const batchSlug of BATCHES) {
    const filenames = GRAPH_FILES_BY_BATCH.get(batchSlug);
    const historyPath = path.join(
      rootDir,
      "outputs",
      "benchmarks",
      `${batchSlug.toLowerCase()}-score-benchmarks.json`
    );
    const history = JSON.parse(await readFile(historyPath, "utf8"));
    assertHistory(history, batchSlug, historyPath);
    const entries = await Promise.all(filenames.map(async (filename) => {
      const targetPath = path.join(rootDir, "public", "graph", filename);
      return { filename, targetPath, graph: JSON.parse(await readFile(targetPath, "utf8")) };
    }));
    const base = entries[0];
    assertGraph(base.graph, base.targetPath, batchSlug);
    const canonicalRows = buildMomentumRows(base.graph, history);
    const baseCompanyIds = new Set(base.graph.leaderboard.map((row) => row.companyId));
    if (canonicalRows.length !== baseCompanyIds.size) {
      throw new Error(`${base.targetPath} did not produce a complete momentum row set.`);
    }

    const writes = entries.map(({ filename, targetPath, graph }) => {
      assertGraph(graph, targetPath, batchSlug);
      const visibleCompanyIds = new Set(graph.leaderboard.map((row) => row.companyId));
      const nextGraph = {
        ...graph,
        fastestGaining: canonicalRows.filter((row) => visibleCompanyIds.has(row.companyId))
      };
      return { filename, targetPath, graph: nextGraph };
    });

    if (write) {
      await Promise.all(writes.map(({ targetPath, graph }) => writeJsonAtomically(targetPath, graph, false)));
    }

    const example = canonicalRows.find((row) => row.wow.benchmarkedAt !== null) ?? null;
    batches.push({
      batchSlug,
      files: filenames,
      generatedAt: base.graph.generatedAt,
      weekOverWeekBaseline: example?.wow.benchmarkedAt ?? null,
      comparableRows: canonicalRows.filter((row) => row.wow.benchmarkedAt !== null).length
    });
  }

  return { status: write ? "rebuilt" : "dry-run", batches };
}

function buildMomentumRows(graph, history) {
  const now = new Date(graph.generatedAt);
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Graph generatedAt must be a valid timestamp.");
  }
  const modelVersion = graph.scoringContext?.modelVersion;
  if (typeof modelVersion !== "string" || !modelVersion) {
    throw new Error("Graph scoringContext.modelVersion is required.");
  }
  const dailyBaseline = selectBaseline(history.daily, now, 1, modelVersion);
  const weeklyBaseline = selectBaseline([...history.daily, ...history.weekly], now, 7, modelVersion);
  const dailyByCompany = snapshotCompanies(dailyBaseline);
  const weeklyByCompany = snapshotCompanies(weeklyBaseline);

  return graph.leaderboard
    .map((row) => ({
      rank: 0,
      companyId: row.companyId,
      companyName: row.companyName,
      dod: deltaFor(row, dailyByCompany.get(row.companyId) ?? null, dailyBaseline?.recordedAt ?? null),
      wow: deltaFor(row, weeklyByCompany.get(row.companyId) ?? null, weeklyBaseline?.recordedAt ?? null)
    }))
    .sort(momentumSort)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function selectBaseline(snapshots, now, daysBack, modelVersion) {
  const targetDate = offsetCentralDate(centralDayKey(now), -daysBack);
  const matchingModel = snapshots.filter((snapshot) =>
    snapshot?.scoringModelVersion === modelVersion &&
    centralDayKey(snapshot.recordedAt) === targetDate
  );
  const legacy = snapshots.filter((snapshot) =>
    snapshot?.scoringModelVersion === undefined &&
    centralDayKey(snapshot.recordedAt) === targetDate
  );
  return latestSnapshot(matchingModel) ?? latestSnapshot(legacy);
}

function snapshotCompanies(snapshot) {
  return new Map((snapshot?.companies ?? []).map((company) => [company.companyId, company]));
}

function deltaFor(current, baseline, benchmarkedAt) {
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

function momentumSort(left, right) {
  return (
    right.dod.scoreDelta - left.dod.scoreDelta ||
    right.dod.percentDelta - left.dod.percentDelta ||
    right.dod.rankDelta - left.dod.rankDelta ||
    right.dod.currentScore - left.dod.currentScore ||
    left.companyName.localeCompare(right.companyName)
  );
}

function offsetCentralDate(dayKey, offsetDays) {
  if (!dayKey) throw new Error("Cannot calculate a benchmark day from an invalid timestamp.");
  const [year, month, day] = dayKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays, 12));
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function assertGraph(graph, targetPath, batchSlug) {
  if (
    !graph ||
    graph.batch?.slug !== batchSlug ||
    !Array.isArray(graph.leaderboard) ||
    !Array.isArray(graph.fastestGaining)
  ) {
    throw new Error(`Invalid graph artifact at ${targetPath}.`);
  }
}

function recoveredSnapshot(sourceSnapshot, sourceDate, targetDate) {
  return {
    ...sourceSnapshot,
    // Noon UTC always falls on the requested Central calendar day, including
    // both sides of daylight-saving changes. The original graph timestamp is
    // deliberately retained so the recovered data remains auditable.
    recordedAt: `${targetDate}T12:00:00.000Z`,
    recovery: {
      method: "source-stable-snapshot",
      sourceCentralDate: sourceDate,
      sourceRecordedAt: sourceSnapshot.recordedAt,
      sourceInputGeneratedAt: sourceSnapshot.inputGeneratedAt ?? null
    }
  };
}

function latestSnapshotOnCentralDate(snapshots, targetDate, scoringModelVersion) {
  return snapshots
    .filter((snapshot) =>
      snapshot?.scoringModelVersion === scoringModelVersion &&
      centralDayKey(snapshot.recordedAt) === targetDate
    )
    .sort(compareSnapshots)
    .at(-1) ?? null;
}

function latestSnapshot(snapshots) {
  return snapshots.reduce(
    (latest, snapshot) => !latest || Date.parse(snapshot.recordedAt) > Date.parse(latest.recordedAt)
      ? snapshot
      : latest,
    null
  );
}

function compareSnapshots(left, right) {
  return Date.parse(left.recordedAt) - Date.parse(right.recordedAt);
}

function assertHistory(history, batchSlug, targetPath) {
  if (
    !history ||
    history.version !== 1 ||
    history.batchSlug !== batchSlug ||
    !Array.isArray(history.daily) ||
    !Array.isArray(history.weekly)
  ) {
    throw new Error(`Invalid benchmark history at ${targetPath}.`);
  }
}

function centralDayKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(
    centralDateFormatter.formatToParts(date).filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function writeJsonAtomically(targetPath, value, pretty = true) {
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`, "utf8");
  await rename(temporaryPath, targetPath);
}

function parseArgs(rawArgs) {
  const args = {
    rootDir: process.cwd(),
    sourceDate: DEFAULT_SOURCE_DATE,
    targetDates: DEFAULT_TARGET_DATES,
    scoringModelVersion: DEFAULT_MODEL_VERSION,
    rebuildPublicGraphs: false,
    write: false
  };

  for (const arg of rawArgs) {
    if (arg === "--write") {
      args.write = true;
      continue;
    }
    if (arg === "--rebuild-public-graphs") {
      args.rebuildPublicGraphs = true;
      continue;
    }
    if (arg.startsWith("--root=")) {
      args.rootDir = path.resolve(arg.slice("--root=".length));
      continue;
    }
    if (arg.startsWith("--source-date=")) {
      args.sourceDate = arg.slice("--source-date=".length);
      continue;
    }
    if (arg.startsWith("--target-dates=")) {
      args.targetDates = arg.slice("--target-dates=".length).split(",").map((value) => value.trim()).filter(Boolean);
      continue;
    }
    if (arg.startsWith("--scoring-model-version=")) {
      args.scoringModelVersion = arg.slice("--scoring-model-version=".length);
      continue;
    }
    throw new Error(`Unknown benchmark-history repair argument: ${arg}`);
  }
  return args;
}

function assertCentralDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new Error(`Invalid ${label}: ${value}.`);
  }
}

const isDirectExecution = process.argv[1] &&
  path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
