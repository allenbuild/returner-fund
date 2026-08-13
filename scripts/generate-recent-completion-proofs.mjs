#!/usr/bin/env node

import {
  RECENT_COMPLETION_MAX_ARTIFACT_BYTES,
  RECENT_COMPLETION_PROOF_GENERATOR_VERSION,
  generateRecentCompletionProofs
} from "./lib/recent-completion-proof-generator.mjs";

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (!options.campaignManifestPath) {
    throw new Error("--campaign=<campaign.json> is required.");
  }
  if (!options.expectedCampaignSha256) {
    throw new Error("--expected-sha256=<lowercase SHA-256> is required.");
  }
  if (!options.dryRun && !options.outputDir) {
    throw new Error("--output-dir=<new directory> is required unless --dry-run is set.");
  }
  const result = await generateRecentCompletionProofs({
    root: options.root,
    campaignManifestPath: options.campaignManifestPath,
    expectedCampaignSha256: options.expectedCampaignSha256,
    outputDir: options.outputDir,
    dryRun: options.dryRun,
    maxArtifactBytes: options.maxArtifactBytes
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    campaignManifestPath: null,
    expectedCampaignSha256: null,
    outputDir: null,
    maxArtifactBytes: RECENT_COMPLETION_MAX_ARTIFACT_BYTES,
    dryRun: false,
    help: false
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
    else if (flag === "--campaign") options.campaignManifestPath = value;
    else if (flag === "--expected-sha256") options.expectedCampaignSha256 = value;
    else if (flag === "--output-dir") options.outputDir = value;
    else if (flag === "--max-artifact-bytes") {
      options.maxArtifactBytes = positiveInteger(value, flag);
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
  return `Usage: node scripts/generate-recent-completion-proofs.mjs [options]\n\n` +
    `Runs ${RECENT_COMPLETION_PROOF_GENERATOR_VERSION} against a hash-pinned prepared campaign.\n` +
    `A pair qualifies only when every sibling native attempt has a hash-pinned, gap-free ` +
    `request journal covering the exact versioned recent window.\n\n` +
    `Required:\n` +
    `  --campaign=<campaign.json>       Prepared ingestion campaign manifest.\n` +
    `  --expected-sha256=<digest>       Previously pinned campaign-manifest SHA-256.\n` +
    `  --output-dir=<new directory>     Immutable audit/proof directory unless --dry-run.\n\n` +
    `Options:\n` +
    `  --root=<path>                    Repository root (default current directory).\n` +
    `  --max-artifact-bytes=<n>         Per-artifact bound (default ` +
      `${RECENT_COMPLETION_MAX_ARTIFACT_BYTES}).\n` +
    `  --dry-run                        Validate and summarize without writing.\n` +
    `  --help                           Show this help.\n`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${JSON.stringify({
      event: "recent_completion_proofs.failed",
      error: error instanceof Error ? error.message : String(error)
    })}\n`);
    process.exitCode = 1;
  }
);
