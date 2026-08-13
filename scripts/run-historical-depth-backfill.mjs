#!/usr/bin/env node

import { resolve } from "node:path";
import {
  HISTORICAL_DEPTH_LIMITS,
  buildHistoricalDepthPlan,
  runHistoricalDepthBackfill
} from "./lib/historical-depth-backfill.mjs";
import { HISTORICAL_DEPTH_PLATFORMS } from "./lib/historical-depth-targets.mjs";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const credentials = {
  youtubeApiKey: process.env.YOUTUBE_API_KEY,
  productHuntToken: process.env.PRODUCT_HUNT_TOKEN,
  redditAccessToken: process.env.REDDIT_ACCESS_TOKEN
};

if (args.help) {
  process.stdout.write(helpText());
  process.exit(0);
}

if (args.plan) {
  const plan = await buildHistoricalDepthPlan(root, {
    batches: args.batches,
    platforms: args.platforms,
    limits: args.limits,
    credentials
  });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}

const runId = args.runId ?? `historical-depth-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outputDir = resolve(args.outputDir ?? `work/historical-depth-backfill/${safeSegment(runId)}`);
const controller = new AbortController();
let interrupted = false;
const interrupt = (signalName) => {
  if (interrupted) return;
  interrupted = true;
  controller.abort(new DOMException(`Historical-depth backfill interrupted by ${signalName}`, "AbortError"));
};
process.once("SIGINT", () => interrupt("SIGINT"));
process.once("SIGTERM", () => interrupt("SIGTERM"));

try {
  const summary = await runHistoricalDepthBackfill({
    root,
    outputDir,
    batches: args.batches,
    platforms: args.platforms,
    limits: args.limits,
    credentials,
    resume: args.resume,
    signal: controller.signal
  });
  process.stdout.write(`${JSON.stringify({ outputDir, ...summary }, null, 2)}\n`);
} catch (error) {
  if (error?.name === "AbortError") {
    process.stderr.write(
      `Historical-depth backfill interrupted safely. Resume with --resume --output-dir=${JSON.stringify(outputDir)}.\n`
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
  const limitFlags = new Map([
    ["--global-concurrency", "globalConcurrency"],
    ["--host-pace-ms", "hostPaceMs"],
    ["--youtube-public-max-pages", "youtubePublicMaxPages"],
    ["--youtube-api-max-pages", "youtubeApiMaxPages"],
    ["--product-hunt-max-pages", "productHuntMaxPages"],
    ["--reddit-max-pages", "redditMaxPages"],
    ["--max-items-per-target", "maxItemsPerTarget"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan") result.plan = true;
    else if (argument === "--resume") result.resume = true;
    else if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--batches") result.batches = csv(requiredValue(argv, ++index, argument));
    else if (argument === "--platforms") result.platforms = csv(requiredValue(argv, ++index, argument));
    else if (argument === "--output-dir") result.outputDir = requiredValue(argv, ++index, argument);
    else if (argument === "--run-id") result.runId = requiredValue(argv, ++index, argument);
    else if (argument.startsWith("--batches=")) result.batches = csv(argument.slice("--batches=".length));
    else if (argument.startsWith("--platforms=")) result.platforms = csv(argument.slice("--platforms=".length));
    else if (argument.startsWith("--output-dir=")) result.outputDir = argument.slice("--output-dir=".length);
    else if (argument.startsWith("--run-id=")) result.runId = argument.slice("--run-id=".length);
    else {
      const [flag, inline] = argument.split("=", 2);
      const limitKey = limitFlags.get(flag);
      if (!limitKey) throw new Error(`Unknown historical-depth argument: ${argument}`);
      const rawValue = inline ?? requiredValue(argv, ++index, flag);
      const value = Number(rawValue);
      if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} requires a non-negative integer.`);
      result.limits[limitKey] = value;
    }
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
  if (values.length === 0) throw new Error("Comma-separated historical-depth filters cannot be empty.");
  return values;
}

function safeSegment(value) {
  const segment = String(value).trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!segment || segment === "." || segment === "..") throw new Error("--run-id must contain a safe path segment.");
  return segment;
}

function helpText() {
  return `Usage: node scripts/run-historical-depth-backfill.mjs [options]\n\n` +
    `Resumable historical recovery for verified YouTube, Product Hunt, and Reddit mappings.\n` +
    `Uses public/official endpoints only and never opens a signed-in browser session.\n\n` +
    `Credentials (environment only; never written to artifacts):\n` +
    `  YOUTUBE_API_KEY       Full official uploads-playlist history; otherwise RSS/public discovery only\n` +
    `  PRODUCT_HUNT_TOKEN    Required by Product Hunt's official GraphQL endpoint\n` +
    `  REDDIT_ACCESS_TOKEN   Optional approved OAuth token; anonymous JSON is tried when absent\n\n` +
    `Options:\n` +
    `  --plan                              Print exact denominators/request bounds; no network or writes\n` +
    `  --resume                            Resume the exact journal/configuration in --output-dir\n` +
    `  --batches=S2026,S26,A16ZSR006       Restrict canonical batches\n` +
    `  --platforms=${HISTORICAL_DEPTH_PLATFORMS.join(",")}\n` +
    `  --output-dir=PATH                   Explicit resumable output directory\n` +
    `  --run-id=ID                         Safe default output-directory suffix\n` +
    `  --global-concurrency=N              Maximum ${HISTORICAL_DEPTH_LIMITS.globalConcurrency}\n` +
    `  --host-pace-ms=N                    Default delay between requests to one host\n` +
    `  --youtube-public-max-pages=N        Bounded anonymous discovery pages\n` +
    `  --youtube-api-max-pages=N           Bounded official uploads-playlist pages\n` +
    `  --product-hunt-max-pages=N          Bounded official GraphQL pages\n` +
    `  --reddit-max-pages=N                At most 10 pages / 1,000 listing items\n` +
    `  --max-items-per-target=N            Hard per-target item bound\n` +
    `  --help                              Show this help\n`;
}
