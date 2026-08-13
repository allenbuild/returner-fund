#!/usr/bin/env node

import { resolve } from "node:path";

import {
  GITHUB_EXHAUSTIVE_BATCHES,
  buildGithubExhaustivePlan,
  materializeGithubExhaustiveJournal,
  runGithubExhaustiveBackfill
} from "./lib/github-exhaustive-backfill.mjs";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stdout.write(helpText());
  process.exit(0);
}

if (args.materializeOnly) {
  if (!args.outputDir) throw new Error("--materialize-only requires --output-dir.");
  const outputDir = resolve(args.outputDir);
  const summary = await materializeGithubExhaustiveJournal({
    journalPath: resolve(args.journal ?? `${outputDir}/events.ndjson`),
    outputDir,
    partitions: args.partitions
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(0);
}

const plan = await buildGithubExhaustivePlan(root, { batches: args.batches });
if (args.plan) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: plan.schemaVersion,
    runnerVersion: plan.runnerVersion,
    planHash: plan.planHash,
    batches: plan.batches,
    companiesEvaluated: plan.companiesEvaluated,
    foundersEvaluated: plan.foundersEvaluated,
    canonicalOwnersEvaluated: plan.canonicalOwnersEvaluated,
    verifiedAttributionTasks: plan.verifiedAttributionTasks,
    physicalTargets: plan.physicalTargets,
    ownerTargets: plan.ownerTargets,
    exactRepositoryTargets: plan.exactRepositoryTargets,
    catalogVerifiedMappings: plan.catalogVerifiedMappings,
    authoritativeReceiptOnlyMappings: plan.authoritativeReceiptOnlyMappings,
    excludedUnverifiedCatalogMappings: plan.excludedUnverifiedCatalogMappings,
    multiAttributionReviews: plan.multiAttributionReviews,
    sourceManifest: plan.sourceManifest,
    bounds: {
      fixedPageCap: null,
      pageSize: 100,
      perInvocationHttpAttemptBudget: args.maxHttpAttempts,
      recentActivityDays: args.activityDays,
      explanation:
        "Repository, release, and tag pagination continues until GitHub's Link relation is exhausted. " +
        "The per-invocation request budget pauses safely and is resumed from disk instead of truncating coverage."
    }
  }, null, 2)}\n`);
  process.exit(0);
}

if (args.resume && !args.outputDir && !args.runId) {
  throw new Error("--resume requires the prior --output-dir or --run-id.");
}
const runId = args.runId ?? `github-exhaustive-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outputDir = resolve(args.outputDir ?? `work/github-exhaustive-backfill/${safeSegment(runId)}`);
const controller = new AbortController();
let interrupted = false;
const interrupt = (signalName) => {
  if (interrupted) return;
  interrupted = true;
  controller.abort(new DOMException(`GitHub backfill interrupted by ${signalName}`, "AbortError"));
};
process.once("SIGINT", () => interrupt("SIGINT"));
process.once("SIGTERM", () => interrupt("SIGTERM"));

try {
  const summary = await runGithubExhaustiveBackfill({
    root,
    outputDir,
    plan,
    resume: args.resume,
    limits: {
      globalConcurrency: args.workers,
      maxHttpAttemptsPerRun: args.maxHttpAttempts,
      recentActivityDays: args.activityDays
    },
    signal: controller.signal
  });
  const materialization = args.materialize
    ? await materializeGithubExhaustiveJournal({
        journalPath: `${outputDir}/events.ndjson`,
        outputDir,
        partitions: args.partitions
      })
    : null;
  process.stdout.write(`${JSON.stringify({ outputDir, ...summary, materialization }, null, 2)}\n`);
} catch (error) {
  if (error?.name === "AbortError") {
    process.stderr.write(
      `GitHub backfill interrupted safely. Resume with --resume --output-dir=${JSON.stringify(outputDir)}.\n`
    );
    process.exitCode = 130;
  } else {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const result = {
    plan: false,
    resume: false,
    materialize: false,
    materializeOnly: false,
    help: false,
    batches: null,
    outputDir: null,
    runId: null,
    journal: null,
    workers: 4,
    maxHttpAttempts: 10_000,
    activityDays: 90,
    partitions: 128
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan") result.plan = true;
    else if (argument === "--resume") result.resume = true;
    else if (argument === "--materialize") result.materialize = true;
    else if (argument === "--materialize-only") result.materializeOnly = true;
    else if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--batches") result.batches = csv(requiredValue(argv, ++index, argument));
    else if (argument === "--output-dir") result.outputDir = requiredValue(argv, ++index, argument);
    else if (argument === "--run-id") result.runId = requiredValue(argv, ++index, argument);
    else if (argument === "--journal") result.journal = requiredValue(argv, ++index, argument);
    else if (argument === "--workers") result.workers = positiveInteger(requiredValue(argv, ++index, argument), argument);
    else if (argument === "--max-http-attempts") result.maxHttpAttempts = positiveInteger(requiredValue(argv, ++index, argument), argument);
    else if (argument === "--activity-days") result.activityDays = positiveInteger(requiredValue(argv, ++index, argument), argument);
    else if (argument === "--partitions") result.partitions = positiveInteger(requiredValue(argv, ++index, argument), argument);
    else if (argument.startsWith("--batches=")) result.batches = csv(argument.slice("--batches=".length));
    else if (argument.startsWith("--output-dir=")) result.outputDir = argument.slice("--output-dir=".length);
    else if (argument.startsWith("--run-id=")) result.runId = argument.slice("--run-id=".length);
    else if (argument.startsWith("--journal=")) result.journal = argument.slice("--journal=".length);
    else if (argument.startsWith("--workers=")) result.workers = positiveInteger(argument.slice("--workers=".length), "--workers");
    else if (argument.startsWith("--max-http-attempts=")) result.maxHttpAttempts = positiveInteger(argument.slice("--max-http-attempts=".length), "--max-http-attempts");
    else if (argument.startsWith("--activity-days=")) result.activityDays = positiveInteger(argument.slice("--activity-days=".length), "--activity-days");
    else if (argument.startsWith("--partitions=")) result.partitions = positiveInteger(argument.slice("--partitions=".length), "--partitions");
    else throw new Error(`Unknown GitHub exhaustive backfill argument: ${argument}`);
  }
  if (result.workers > 4) throw new Error("--workers cannot exceed the safe maximum of 4.");
  if (result.partitions < 2 || result.partitions > 4096) {
    throw new Error("--partitions must be between 2 and 4096.");
  }
  return result;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function positiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${flag} must be a positive integer.`);
  return number;
}

function csv(value) {
  const values = String(value).split(",").map((entry) => entry.trim().toUpperCase()).filter(Boolean);
  if (values.length === 0) throw new Error("Comma-separated batch filters cannot be empty.");
  const invalid = values.filter((batch) => !GITHUB_EXHAUSTIVE_BATCHES.includes(batch));
  if (invalid.length > 0) throw new Error(`Unsupported GitHub batch(es): ${invalid.join(", ")}.`);
  return [...new Set(values)];
}

function safeSegment(value) {
  const segment = String(value).trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!segment || segment === "." || segment === "..") throw new Error("--run-id must contain a safe path segment.");
  return segment;
}

function helpText() {
  return `Usage: node scripts/run-github-exhaustive-backfill.mjs [options]\n\n` +
    `Read-only, resumable exhaustive GitHub recovery for every verified mapped account.\n` +
    `It uses the GitHub REST API only and never opens a signed-in browser session.\n\n` +
    `Options:\n` +
    `  --plan                         Print exact mapping denominators and request bounds; no network or writes\n` +
    `  --resume                       Resume the exact plan and activity window in --output-dir\n` +
    `  --batches=${GITHUB_EXHAUSTIVE_BATCHES.join(",")}\n` +
    `                                 Restrict canonical batches (default: all)\n` +
    `  --workers=1..4                 Safe API concurrency (default: 4)\n` +
    `  --max-http-attempts=N          Per-invocation budget; resume continues without truncation (default: 10000)\n` +
    `  --activity-days=N              Default-branch commit window fixed at run start (default: 90)\n` +
    `  --output-dir=PATH              Explicit checkpoint and journal directory\n` +
    `  --run-id=ID                    Safe default output-directory suffix\n` +
    `  --materialize                  External-memory dedupe after the run invocation\n` +
    `  --materialize-only             Materialize an existing journal without network access\n` +
    `  --journal=PATH                 Journal for --materialize-only (default: OUTPUT/events.ndjson)\n` +
    `  --partitions=2..4096           External-memory materialization partitions (default: 128)\n` +
    `  --help                         Show this help\n\n` +
    `GITHUB_TOKEN is optional and only raises REST API rate limits. Private/internal repositories and draft releases\n` +
    `visible through token scopes are rejected and never retained.\n`;
}
