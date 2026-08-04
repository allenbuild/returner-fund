#!/usr/bin/env node

import { resolve } from "node:path";
import {
  HISTORICAL_BACKFILL_PLATFORMS,
  buildHistoricalBackfillPlan,
  runHistoricalBackfill
} from "./lib/historical-backfill.mjs";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stdout.write(helpText());
  process.exit(0);
}

if (args.plan) {
  const plan = await buildHistoricalBackfillPlan(root, {
    batches: args.batches,
    platforms: args.platforms
  });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}

const runId = args.runId ?? `historical-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outputDir = resolve(args.outputDir ?? `work/historical-backfill/${safeSegment(runId)}`);
const controller = new AbortController();
let interrupted = false;
const interrupt = (signalName) => {
  if (interrupted) return;
  interrupted = true;
  controller.abort(new DOMException(`Historical backfill interrupted by ${signalName}`, "AbortError"));
};
process.once("SIGINT", () => interrupt("SIGINT"));
process.once("SIGTERM", () => interrupt("SIGTERM"));

try {
  const summary = await runHistoricalBackfill({
    root,
    outputDir,
    batches: args.batches,
    platforms: args.platforms,
    limits: args.limits,
    resume: args.resume,
    signal: controller.signal
  });
  process.stdout.write(`${JSON.stringify({ outputDir, ...summary }, null, 2)}\n`);
} catch (error) {
  if (error?.name === "AbortError") {
    process.stderr.write(
      `Historical backfill interrupted safely. Resume with --resume --output-dir=${JSON.stringify(outputDir)}.\n`
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
    help: false,
    batches: null,
    platforms: null,
    outputDir: null,
    runId: null,
    limits: {}
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan") result.plan = true;
    else if (argument === "--resume") result.resume = true;
    else if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--batches") result.batches = csv(requiredValue(argv, ++index, argument));
    else if (argument === "--platforms") result.platforms = csv(requiredValue(argv, ++index, argument));
    else if (argument === "--output-dir") result.outputDir = requiredValue(argv, ++index, argument);
    else if (argument === "--run-id") result.runId = requiredValue(argv, ++index, argument);
    else if (argument.startsWith("--site-max-depth=")) result.limits.siteMaxDepth = positiveNumber(argument, "--site-max-depth");
    else if (argument.startsWith("--site-max-urls=")) result.limits.siteMaxUrls = positiveNumber(argument, "--site-max-urls");
    else if (argument.startsWith("--site-max-responses=")) result.limits.siteMaxResponses = positiveNumber(argument, "--site-max-responses");
    else if (argument.startsWith("--site-max-items=")) result.limits.siteMaxItems = positiveNumber(argument, "--site-max-items");
    else if (argument.startsWith("--global-concurrency=")) result.limits.globalConcurrency = positiveNumber(argument, "--global-concurrency");
    else if (argument.startsWith("--batches=")) result.batches = csv(argument.slice("--batches=".length));
    else if (argument.startsWith("--platforms=")) result.platforms = csv(argument.slice("--platforms=".length));
    else if (argument.startsWith("--output-dir=")) result.outputDir = argument.slice("--output-dir=".length);
    else if (argument.startsWith("--run-id=")) result.runId = argument.slice("--run-id=".length);
    else throw new Error(`Unknown historical backfill argument: ${argument}`);
  }
  return result;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function csv(value) {
  const values = String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
  if (values.length === 0) throw new Error("Comma-separated historical filters cannot be empty.");
  return values;
}

function safeSegment(value) {
  const segment = String(value).trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!segment || segment === "." || segment === "..") throw new Error("--run-id must contain a safe path segment.");
  return segment;
}

function helpText() {
  return `Usage: node scripts/run-historical-backfill.mjs [options]\n\n` +
    `Credential-free historical recovery for company Hacker News, RSS, sitemap, and official web history.\n` +
    `It never opens or uses a signed-in browser session.\n\n` +
    `Options:\n` +
    `  --plan                    Print catalog denominators and worst-case request bounds; no network or writes\n` +
    `  --resume                  Resume the exact journal/configuration in --output-dir\n` +
    `  --batches=S2026,S26       Restrict canonical batches (default: every configured batch)\n` +
    `  --platforms=${HISTORICAL_BACKFILL_PLATFORMS.join(",")}\n` +
    `                            Restrict providers (default: all historical providers)\n` +
    `  --output-dir=PATH         Explicit resumable output directory\n` +
    `  --run-id=ID               Safe default output-directory suffix\n` +
    `  --site-max-depth=N        Raise bounded official-site crawl depth (default: 3)\n` +
    `  --site-max-urls=N         Raise bounded official-site URL queue (default: 200)\n` +
    `  --site-max-responses=N    Raise bounded official-site response count (default: 40)\n` +
    `  --site-max-items=N        Raise bounded official-site item count (default: 2000)\n` +
    `  --global-concurrency=N    Historical worker pool size, max 8 (default: 8)\n` +
    `  --help                    Show this help\n`;
}

function positiveNumber(argument, flag) {
  const value = Number(argument.slice(`${flag}=`.length));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag}=N requires a positive integer.`);
  return value;
}
