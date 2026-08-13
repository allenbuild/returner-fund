#!/usr/bin/env node

import {
  PAIR_INTEGRITY_EXPECTED_PAIR_COUNT,
  PAIR_INTEGRITY_MAX_INPUT_BYTES,
  buildPairIntegrityProofBridge
} from "./lib/pair-integrity-proof-bridge.mjs";

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (!options.storedCoverageManifestPath) {
    throw new Error("--stored-coverage-manifest=<path> is required.");
  }
  if (!options.scoringAuditPath) throw new Error("--scoring-audit=<path> is required.");
  if (!options.generatedAt) throw new Error("--generated-at=<canonical ISO UTC> is required.");
  if (!options.dryRun && !options.outputDir) {
    throw new Error("--output-dir=<new directory> is required unless --dry-run is set.");
  }
  const result = await buildPairIntegrityProofBridge({
    root: options.root,
    storedCoverageManifestPath: options.storedCoverageManifestPath,
    scoringAuditPath: options.scoringAuditPath,
    outputDir: options.outputDir,
    generatedAt: options.generatedAt,
    dryRun: options.dryRun,
    expectedPairCount: options.expectedPairCount,
    maxInputBytes: options.maxInputBytes
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    storedCoverageManifestPath: null,
    scoringAuditPath: null,
    outputDir: null,
    generatedAt: null,
    dryRun: false,
    help: false,
    expectedPairCount: PAIR_INTEGRITY_EXPECTED_PAIR_COUNT,
    maxInputBytes: PAIR_INTEGRITY_MAX_INPUT_BYTES
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
    else if (flag === "--stored-coverage-manifest") options.storedCoverageManifestPath = value;
    else if (flag === "--scoring-audit") options.scoringAuditPath = value;
    else if (flag === "--output-dir") options.outputDir = value;
    else if (flag === "--generated-at") options.generatedAt = value;
    else if (flag === "--expected-pairs") options.expectedPairCount = positiveInteger(value, flag);
    else if (flag === "--max-input-bytes") options.maxInputBytes = positiveInteger(value, flag);
    else throw new Error(`Unknown argument: ${argument}`);
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
  return `Usage: node scripts/build-pair-integrity-proof.mjs [options]\n\n` +
    `Adds fail-closed duplicate, attribution, timestamp, and scoring receipts to every canonical pair.\n` +
    `The command writes only a fresh work directory; canonical and production artifacts stay read-only.\n\n` +
    `Required:\n` +
    `  --stored-coverage-manifest=<path>  Hash-pinned stored-unpublished coverage manifest.\n` +
    `  --scoring-audit=<path>             Fresh V4 recomputation diagnostic artifact.\n` +
    `  --generated-at=<ISO UTC>           Explicit deterministic proof time.\n` +
    `  --output-dir=<new directory>       Immutable output directory unless --dry-run.\n\n` +
    `Options:\n` +
    `  --root=<path>                      Repository root (default current directory).\n` +
    `  --expected-pairs=<n>               Exact denominator (default ${PAIR_INTEGRITY_EXPECTED_PAIR_COUNT}).\n` +
    `  --max-input-bytes=<n>              Per-file bound (default ${PAIR_INTEGRITY_MAX_INPUT_BYTES}).\n` +
    `  --dry-run                          Validate and summarize without writing.\n` +
    `  --help                             Show this help.\n`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${JSON.stringify({
      event: "pair_integrity_proof.failed",
      error: error instanceof Error ? error.message : String(error)
    })}\n`);
    process.exitCode = 1;
  }
);
