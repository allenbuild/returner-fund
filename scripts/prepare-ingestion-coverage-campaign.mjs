#!/usr/bin/env node

import {
  AUTONOMOUS_COVERAGE_BATCH_LAYOUT,
  PREPARED_CAMPAIGN_MAX_ARTIFACT_BYTES,
  prepareIngestionCoverageCampaign
} from "./lib/prepare-ingestion-coverage-campaign.mjs";

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  for (const [flag, value] of [
    ["--campaign-dir", options.campaignDir],
    ["--output-dir", options.outputDir],
    ["--idempotency-key", options.idempotencyKey],
    ["--campaign-key", options.campaignKey],
    ["--materialized-at", options.materializedAt]
  ]) {
    if (!value) throw new Error(`${flag}=<value> is required.`);
  }

  const result = await prepareIngestionCoverageCampaign({
    root: options.root,
    campaignDir: options.campaignDir,
    outputDir: options.outputDir,
    idempotencyKey: options.idempotencyKey,
    campaignKey: options.campaignKey,
    batchSlugs: options.batchSlugs,
    materializedAt: options.materializedAt,
    historicalJournalPath: options.historicalJournalPath,
    historicalCompletionProofsPath: options.historicalCompletionProofsPath,
    historicalDepthJournalPath: options.historicalDepthJournalPath,
    historicalDepthCompletionProofsPath: options.historicalDepthCompletionProofsPath,
    pairScopesPath: options.pairScopesPath,
    maxArtifactBytes: options.maxArtifactBytes
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    campaignDir: null,
    outputDir: null,
    idempotencyKey: null,
    campaignKey: null,
    batchSlugs: AUTONOMOUS_COVERAGE_BATCH_LAYOUT.map((batch) => batch.slug),
    materializedAt: null,
    historicalJournalPath: null,
    historicalCompletionProofsPath: null,
    historicalDepthJournalPath: null,
    historicalDepthCompletionProofsPath: null,
    pairScopesPath: null,
    maxArtifactBytes: PREPARED_CAMPAIGN_MAX_ARTIFACT_BYTES,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const [flag, inlineValue] = splitFlag(argument);
    const value = inlineValue ?? requiredValue(argv, ++index, flag);
    if (flag === "--root") options.root = value;
    else if (flag === "--campaign-dir") options.campaignDir = value;
    else if (flag === "--output-dir") options.outputDir = value;
    else if (flag === "--idempotency-key") options.idempotencyKey = value;
    else if (flag === "--campaign-key") options.campaignKey = value;
    else if (flag === "--batches") options.batchSlugs = csv(value, flag);
    else if (flag === "--materialized-at") options.materializedAt = value;
    else if (flag === "--historical-journal") options.historicalJournalPath = value;
    else if (flag === "--historical-completion-proofs") {
      options.historicalCompletionProofsPath = value;
    } else if (flag === "--historical-depth-journal") {
      options.historicalDepthJournalPath = value;
    } else if (flag === "--historical-depth-completion-proofs") {
      options.historicalDepthCompletionProofsPath = value;
    } else if (flag === "--pair-scopes") {
      options.pairScopesPath = value;
    } else if (flag === "--max-artifact-bytes") {
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

function csv(value, flag) {
  const values = String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`${flag} must not be empty.`);
  return values;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive safe integer.`);
  }
  return parsed;
}

function helpText() {
  const batches = AUTONOMOUS_COVERAGE_BATCH_LAYOUT.map((batch) => batch.slug).join(",");
  return `Usage: node scripts/prepare-ingestion-coverage-campaign.mjs [required options]\n\n` +
    `Packages only the exact autonomous outputs, shards, and public checkpoints named by the canonical runner layout.\n` +
    `It never treats an artifact directory, file count, or modification time as proof of collection.\n\n` +
    `Required:\n` +
    `  --campaign-dir=<path>                 Completed/resumable autonomous campaign directory.\n` +
    `  --output-dir=<path>                   New immutable package directory; must not exist.\n` +
    `  --idempotency-key=<key>               Exact autonomous run/task-plan key.\n` +
    `  --campaign-key=<key>                  Stable logical coverage campaign key.\n` +
    `  --materialized-at=<ISO UTC>           Explicit canonical timestamp for deterministic output.\n\n` +
    `Options:\n` +
    `  --root=<path>                         Repository root (default: current directory).\n` +
    `  --batches=${batches}  Explicit canonical batches (default: all).\n` +
    `  --historical-journal=<pages.ndjson>   Include only a journal ending in run_completed.\n` +
    `  --historical-completion-proofs=<json> Optional explicit proof array; requires the journal.\n` +
    `  --historical-depth-journal=<pages.ndjson> Include the completed YouTube/Product Hunt/Reddit depth journal.\n` +
    `  --historical-depth-completion-proofs=<json> Optional depth proof array; requires the depth journal.\n` +
    `  --pair-scopes=<json>                  Include the exact full stored-unpublished pair-scope matrix.\n` +
    `  --max-artifact-bytes=<n>              Per-file safety cap (default ${PREPARED_CAMPAIGN_MAX_ARTIFACT_BYTES}).\n` +
    `  --help                                Show this help.\n`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${JSON.stringify({
      event: "ingestion_coverage_campaign.prepare_failed",
      error: error instanceof Error ? error.message : String(error)
    })}\n`);
    process.exitCode = 1;
  }
);
