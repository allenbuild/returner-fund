#!/usr/bin/env node

import {
  HISTORICAL_PUBLICATION_MAX_ARTIFACT_BYTES,
  stageHistoricalBackfillPublication
} from "./lib/historical-publication-staging.mjs";

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (!options.journalPath) throw new Error("--journal=<pages.ndjson> is required.");
  if (!options.stagedAt) throw new Error("--staged-at=<canonical ISO UTC> is required.");
  if (!options.dryRun && !options.outputDir) {
    throw new Error("--output-dir=<new directory> is required unless --dry-run is set.");
  }
  const receipt = await stageHistoricalBackfillPublication({
    root: options.root,
    journalPath: options.journalPath,
    canonicalPath: options.canonicalPath,
    outputDir: options.outputDir,
    stagedAt: options.stagedAt,
    dryRun: options.dryRun,
    maxArtifactBytes: options.maxArtifactBytes
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return 0;
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    journalPath: null,
    canonicalPath: null,
    outputDir: null,
    stagedAt: null,
    dryRun: false,
    help: false,
    maxArtifactBytes: HISTORICAL_PUBLICATION_MAX_ARTIFACT_BYTES
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const [flag, inline] = splitFlag(argument);
    const value = inline ?? requiredValue(argv, ++index, flag);
    if (flag === "--root") options.root = value;
    else if (flag === "--journal") options.journalPath = value;
    else if (flag === "--canonical") options.canonicalPath = value;
    else if (flag === "--output-dir") options.outputDir = value;
    else if (flag === "--staged-at") options.stagedAt = value;
    else if (flag === "--max-artifact-bytes") {
      options.maxArtifactBytes = positiveInteger(value, flag);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function splitFlag(argument) {
  if (!argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
  const equals = argument.indexOf("=");
  return equals < 0
    ? [argument, null]
    : [argument.slice(0, equals), argument.slice(equals + 1)];
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive safe integer.`);
  }
  return parsed;
}

function helpText() {
  return `Usage: node scripts/stage-historical-publication.mjs [options]\n\n` +
    `Validates one completed historical journal and builds an immutable stored-but-unpublished staging package.\n` +
    `The canonical public snapshot is never modified.\n\n` +
    `Required:\n` +
    `  --journal=<pages.ndjson>    Completed historical-backfill journal.\n` +
    `  --staged-at=<ISO UTC>       Explicit deterministic staging timestamp.\n` +
    `  --output-dir=<directory>    New staging directory (not required with --dry-run).\n\n` +
    `Options:\n` +
    `  --root=<path>               Repository root (default current directory).\n` +
    `  --canonical=<path>          Canonical public snapshot override.\n` +
    `  --dry-run                   Validate and print exact counts without writing.\n` +
    `  --max-artifact-bytes=<n>    Per-file safety limit (default ${HISTORICAL_PUBLICATION_MAX_ARTIFACT_BYTES}).\n` +
    `  --help                      Show this help.\n`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${JSON.stringify({
      event: "historical_publication_staging.failed",
      error: error instanceof Error ? error.message : String(error)
    })}\n`);
    process.exitCode = 1;
  }
);
