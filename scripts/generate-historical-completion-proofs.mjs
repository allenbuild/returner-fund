#!/usr/bin/env node

import {
  HISTORICAL_COMPLETION_PROOF_GENERATOR_VERSION,
  generateHistoricalCompletionProofs
} from "./lib/historical-completion-proof-generator.mjs";

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (!options.journalPath) throw new Error("--journal=<pages.ndjson> is required.");
  if (!options.expectedJournalSha256) {
    throw new Error("--expected-sha256=<lowercase SHA-256> is required.");
  }
  if (!options.generatedAt) {
    throw new Error("--generated-at=<canonical ISO UTC> is required.");
  }
  if (!options.dryRun && !options.outputDir) {
    throw new Error("--output-dir=<new directory> is required unless --dry-run is set.");
  }
  const result = await generateHistoricalCompletionProofs({
    root: options.root,
    journalPath: options.journalPath,
    expectedJournalSha256: options.expectedJournalSha256,
    outputDir: options.outputDir,
    generatedAt: options.generatedAt,
    dryRun: options.dryRun,
    maxJournalBytes: options.maxJournalBytes,
    maxLineBytes: options.maxLineBytes,
    maxEvents: options.maxEvents
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    journalPath: null,
    expectedJournalSha256: null,
    outputDir: null,
    generatedAt: null,
    dryRun: false,
    help: false,
    maxJournalBytes: 512 * 1024 * 1024,
    maxLineBytes: 16 * 1024 * 1024,
    maxEvents: 250_000
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
    else if (flag === "--expected-sha256") options.expectedJournalSha256 = value;
    else if (flag === "--output-dir") options.outputDir = value;
    else if (flag === "--generated-at") options.generatedAt = value;
    else if (flag === "--max-journal-bytes") {
      options.maxJournalBytes = positiveInteger(value, flag);
    } else if (flag === "--max-line-bytes") {
      options.maxLineBytes = positiveInteger(value, flag);
    } else if (flag === "--max-events") {
      options.maxEvents = positiveInteger(value, flag);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
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
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${flag} must be a positive safe integer.`);
  }
  return number;
}

function helpText() {
  return `Usage: node scripts/generate-historical-completion-proofs.mjs [options]\n\n` +
    `Generates ${HISTORICAL_COMPLETION_PROOF_GENERATOR_VERSION} proofs only for ` +
    `source-exhausted targets in a completed, hash-verified historical journal.\n` +
    `Blocked, truncated, rejected-evidence, and manual targets are written as exclusions.\n\n` +
    `Required:\n` +
    `  --journal=<pages.ndjson>        Completed historical journal.\n` +
    `  --expected-sha256=<digest>       Previously pinned journal SHA-256.\n` +
    `  --generated-at=<ISO UTC>        Exact campaign coverage generation time.\n` +
    `  --output-dir=<new directory>    Immutable output directory unless --dry-run.\n\n` +
    `Options:\n` +
    `  --root=<path>                   Repository root (default current directory).\n` +
    `  --max-journal-bytes=<n>         Journal byte bound (default 536870912).\n` +
    `  --max-line-bytes=<n>            NDJSON line byte bound (default 16777216).\n` +
    `  --max-events=<n>                Event count bound (default 250000).\n` +
    `  --dry-run                       Validate and summarize without writing.\n` +
    `  --help                          Show this help.\n`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${JSON.stringify({
      event: "historical_completion_proofs.failed",
      error: error instanceof Error ? error.message : String(error)
    })}\n`);
    process.exitCode = 1;
  }
);
