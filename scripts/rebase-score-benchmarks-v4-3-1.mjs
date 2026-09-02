#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_MODEL_VERSION = "4.3.0";
const TARGET_MODEL_VERSION = "4.3.1";
const SCORE_FACTOR = 0.95;
const HEADLINE_TARGET = 95;
const CENTRAL_TIME_ZONE = "America/Chicago";
const BATCHES = Object.freeze(["S2026", "S26", "A16ZSR006"]);
const SCORE_CALIBRATION = Object.freeze({
  kind: "linear_model_rebase",
  sourceModelVersion: SOURCE_MODEL_VERSION,
  factor: SCORE_FACTOR,
  headlineTarget: HEADLINE_TARGET,
  rounding: "nearest_integer"
});
const CENTRAL_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_TIME_ZONE,
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

export async function main(rawArgs = process.argv.slice(2)) {
  const args = parseArgs(rawArgs);
  const result = await rebaseScoreBenchmarks({
    rootDir: args.rootDir,
    write: args.write,
    beforeCentralDay: args.beforeCentralDay
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export async function rebaseScoreBenchmarks({
  rootDir = process.cwd(),
  write = false,
  beforeCentralDay
} = {}) {
  const resolvedRoot = path.resolve(rootDir);
  if (beforeCentralDay !== undefined) {
    assertCentralDay(beforeCentralDay, "beforeCentralDay");
  }

  const batches = [];
  for (const batchSlug of BATCHES) {
    const targetPath = path.join(
      resolvedRoot,
      "outputs",
      "benchmarks",
      `${batchSlug.toLowerCase()}-score-benchmarks.json`
    );
    const store = JSON.parse(await readFile(targetPath, "utf8"));
    assertBenchmarkStore(store, batchSlug, targetPath);

    const daily = rebaseSeries(store.daily, { beforeCentralDay });
    const weekly = rebaseSeries(store.weekly, { beforeCentralDay });
    const changed = daily.inserted > 0 || weekly.inserted > 0;
    const nextStore = changed
      ? {
          ...store,
          daily: daily.snapshots,
          weekly: weekly.snapshots
        }
      : store;

    if (write && changed) {
      await writeJsonAtomically(targetPath, nextStore);
    }

    batches.push({
      batchSlug,
      targetPath,
      insertedDaily: daily.inserted,
      insertedWeekly: weekly.inserted,
      skippedExistingDailyDays: daily.skippedExistingDays,
      skippedExistingWeeklyDays: weekly.skippedExistingDays
    });
  }

  return {
    status: write ? "rebased" : "dry-run",
    sourceModelVersion: SOURCE_MODEL_VERSION,
    targetModelVersion: TARGET_MODEL_VERSION,
    scoreCalibration: SCORE_CALIBRATION,
    ...(beforeCentralDay ? { beforeCentralDay } : {}),
    batches
  };
}

function rebaseSeries(snapshots, { beforeCentralDay } = {}) {
  const targetDays = new Set(
    snapshots
      .filter((snapshot) => snapshot?.scoringModelVersion === TARGET_MODEL_VERSION)
      .map((snapshot) => centralDayKey(snapshot.recordedAt))
      .filter(Boolean)
  );
  const latestSourceByDay = new Map();

  for (const snapshot of snapshots) {
    if (snapshot?.scoringModelVersion !== SOURCE_MODEL_VERSION) continue;
    const day = centralDayKey(snapshot.recordedAt);
    if (!day || (beforeCentralDay && day >= beforeCentralDay)) continue;
    assertSourceSnapshot(snapshot);
    const prior = latestSourceByDay.get(day);
    if (!prior || Date.parse(snapshot.recordedAt) > Date.parse(prior.recordedAt)) {
      latestSourceByDay.set(day, snapshot);
    }
  }

  const projected = [];
  const skippedExistingDays = [];
  for (const [day, source] of [...latestSourceByDay.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (targetDays.has(day)) {
      skippedExistingDays.push(day);
      continue;
    }
    projected.push(projectSnapshot(source));
  }

  return {
    snapshots: sortSnapshotsChronologically([...snapshots, ...projected]),
    inserted: projected.length,
    skippedExistingDays
  };
}

function projectSnapshot(source) {
  return {
    ...source,
    scoringModelVersion: TARGET_MODEL_VERSION,
    scoreCalibration: { ...SCORE_CALIBRATION },
    companies: rankCompanies(
      source.companies.map((company) => ({
        ...company,
        score: scaledScore(company.score)
      }))
    )
  };
}

function scaledScore(score) {
  return Math.max(0, Math.min(HEADLINE_TARGET, Math.round(score * SCORE_FACTOR)));
}

function rankCompanies(companies) {
  const sorted = [...companies].sort(
    (left, right) =>
      right.score - left.score ||
      left.companyName.localeCompare(right.companyName) ||
      left.companyId.localeCompare(right.companyId)
  );
  let rank = 0;
  let previousScore = null;
  return sorted.map((company, index) => {
    if (previousScore === null || company.score !== previousScore) {
      rank = index + 1;
    }
    previousScore = company.score;
    return { ...company, rank };
  });
}

function sortSnapshotsChronologically(snapshots) {
  return snapshots
    .map((snapshot, originalIndex) => ({ snapshot, originalIndex }))
    .sort(
      (left, right) =>
        Date.parse(left.snapshot.recordedAt) - Date.parse(right.snapshot.recordedAt) ||
        left.originalIndex - right.originalIndex
    )
    .map(({ snapshot }) => snapshot);
}

function assertBenchmarkStore(store, batchSlug, targetPath) {
  if (
    !store ||
    typeof store !== "object" ||
    store.version !== 1 ||
    store.batchSlug !== batchSlug ||
    typeof store.updatedAt !== "string" ||
    !isIsoTimestamp(store.updatedAt) ||
    !Array.isArray(store.daily) ||
    !Array.isArray(store.weekly)
  ) {
    throw new Error(`Refusing to rebase invalid benchmark store ${targetPath}.`);
  }
}

function assertSourceSnapshot(snapshot) {
  if (
    !isIsoTimestamp(snapshot.recordedAt) ||
    !isIsoTimestamp(snapshot.inputGeneratedAt) ||
    !Array.isArray(snapshot.companies)
  ) {
    throw new Error("Cannot rebase an invalid 4.3.0 benchmark snapshot.");
  }
  for (const company of snapshot.companies) {
    if (
      !company ||
      typeof company !== "object" ||
      typeof company.companyId !== "string" ||
      typeof company.companyName !== "string" ||
      !Number.isFinite(company.score) ||
      company.score < 0 ||
      company.score > 100
    ) {
      throw new Error(`Cannot rebase invalid 4.3.0 company row at ${snapshot.recordedAt}.`);
    }
  }
}

function centralDayKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(
    CENTRAL_DAY_FORMATTER.formatToParts(date).map((part) => [part.type, part.value])
  );
  return parts.year && parts.month && parts.day
    ? `${parts.year}-${parts.month}-${parts.day}`
    : null;
}

function assertCentralDay(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${label} must be a valid calendar day.`);
  }
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

async function writeJsonAtomically(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function parseArgs(rawArgs) {
  const args = {
    rootDir: process.cwd(),
    write: false,
    beforeCentralDay: undefined
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--write") {
      args.write = true;
      continue;
    }
    if (arg === "--root") {
      args.rootDir = requiredValue(rawArgs, ++index, "--root");
      continue;
    }
    if (arg.startsWith("--root=")) {
      args.rootDir = arg.slice("--root=".length);
      continue;
    }
    if (arg === "--before-central-day") {
      args.beforeCentralDay = requiredValue(rawArgs, ++index, "--before-central-day");
      continue;
    }
    if (arg.startsWith("--before-central-day=")) {
      args.beforeCentralDay = arg.slice("--before-central-day=".length);
      continue;
    }
    throw new Error(`Unknown benchmark rebase argument: ${arg}`);
  }
  return args;
}

function requiredValue(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
