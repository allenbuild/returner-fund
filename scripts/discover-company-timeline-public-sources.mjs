#!/usr/bin/env node

import { resolve } from "node:path";
import { loadCanonicalTimelinePublicDiscoveryInventory } from "../src/lib/timeline/backfill.ts";
import {
  DEFAULT_TIMELINE_PUBLIC_DISCOVERY_PATH,
  runFileBackedTimelinePublicDiscovery,
} from "../src/lib/timeline/file-discovery.ts";

const options = parseArguments(process.argv.slice(2));
const rootDir = resolve(options.rootDir ?? process.cwd());
const inventory = await loadCanonicalTimelinePublicDiscoveryInventory(rootDir);
const receipt = await runFileBackedTimelinePublicDiscovery({
  companies: inventory.companies,
  inventorySha256: inventory.inventorySha256,
  outputPath: resolve(rootDir, options.outputPath ?? DEFAULT_TIMELINE_PUBLIC_DISCOVERY_PATH),
  env: process.env,
  budgetMs: options.budgetMs,
  concurrency: options.concurrency,
  maxCompanies: options.maxCompanies,
  perFetchTimeoutMs: options.perFetchTimeoutMs,
  logger: (message, data) => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), message, ...data })}\n`),
});
process.stdout.write(`${JSON.stringify(receipt)}\n`);

function parseArguments(args) {
  const options = {};
  for (const argument of args) {
    if (argument.startsWith("--root=")) options.rootDir = value(argument, "--root");
    else if (argument.startsWith("--output=")) options.outputPath = value(argument, "--output");
    else if (argument.startsWith("--budget-ms=")) options.budgetMs = integer(argument, "--budget-ms", 10_000, 600_000);
    else if (argument.startsWith("--concurrency=")) options.concurrency = integer(argument, "--concurrency", 1, 4);
    else if (argument.startsWith("--max-companies=")) options.maxCompanies = integer(argument, "--max-companies", 1, 50);
    else if (argument.startsWith("--per-fetch-timeout-ms=")) {
      options.perFetchTimeoutMs = integer(argument, "--per-fetch-timeout-ms", 1_000, 12_000);
    } else if (argument === "--help") {
      process.stdout.write([
        "Usage: discover-company-timeline-public-sources.mjs [options]",
        "  --root=<path>                  Repository root (defaults to cwd)",
        "  --output=<path>                Root-relative discovery snapshot path",
        "  --budget-ms=<n>                Total bounded runtime (10000-600000)",
        "  --concurrency=<n>              Concurrent companies (1-4)",
        "  --max-companies=<n>            Maximum companies in this shard (1-50)",
        "  --per-fetch-timeout-ms=<n>     Per-request timeout (1000-12000)",
      ].join("\n") + "\n");
      process.exit(0);
    } else throw new TypeError(`Unknown public Timeline discovery argument: ${argument}`);
  }
  return options;
}

function integer(argument, flag, minimum, maximum) {
  const parsed = Number(value(argument, flag));
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${flag} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function value(argument, flag) {
  const parsed = argument.slice(argument.indexOf("=") + 1).trim();
  if (!parsed) throw new TypeError(`${flag} requires a value.`);
  return parsed;
}
