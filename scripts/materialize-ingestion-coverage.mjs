#!/usr/bin/env node

import { createWriteStream, existsSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { once } from "node:events";
import {
  DEFAULT_INGESTION_COVERAGE_ARTIFACT_LIMIT_BYTES,
  loadIngestionCoverageCampaign
} from "./lib/ingestion-coverage-campaign.mjs";
import {
  materializeIngestionCoverage,
  writeIngestionCoverageMaterializationJson
} from "./lib/ingestion-coverage-materializer.mjs";

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (!options.manifest) throw new Error("--manifest=<path> is required.");

  const campaign = await loadIngestionCoverageCampaign(options.manifest, {
    maxArtifactBytes: options.maxArtifactBytes
  });
  const materialization = await materializeIngestionCoverage({
    ...campaign.materializerInput,
    unresolvedPreviewLimit: options.unresolvedPreviewLimit
  });
  const writeResult = options.output
    ? await writeOutputFile({
      output: options.output,
      force: options.force,
      materialization,
      expectedCatalogManifest: campaign.expectedCatalogManifest
    })
    : await writeOutputStream({
      stream: process.stdout,
      materialization,
      expectedCatalogManifest: campaign.expectedCatalogManifest
    });

  process.stderr.write(`${JSON.stringify({
    event: "ingestion_coverage.materialized",
    runId: materialization.runId,
    output: options.output ? resolve(options.output) : "stdout",
    sha256: writeResult.sha256,
    productionReleaseStatus: materialization.productionReleaseStatus.status,
    fullIngestionCoverageStatus: materialization.fullIngestionCoverageStatus.status,
    objectiveComplete: materialization.objectiveComplete
  })}\n`);

  if (!materialization.objectiveComplete && !options.allowIncomplete) return 2;
  return 0;
}

async function writeOutputFile({
  output,
  force,
  materialization,
  expectedCatalogManifest
}) {
  const absoluteOutput = resolve(output);
  if (existsSync(absoluteOutput) && !force) {
    throw new Error(`Output already exists: ${absoluteOutput}. Pass --force to replace it.`);
  }
  const temporaryPath = resolve(
    dirname(absoluteOutput),
    `.${basename(absoluteOutput)}.${process.pid}.${Date.now()}.tmp`
  );
  const stream = createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
  try {
    const result = await writeOutputStream({
      stream,
      materialization,
      expectedCatalogManifest,
      close: true
    });
    await rename(temporaryPath, absoluteOutput);
    return result;
  } catch (error) {
    stream.destroy();
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function writeOutputStream({
  stream,
  materialization,
  expectedCatalogManifest,
  close = false
}) {
  const result = await writeIngestionCoverageMaterializationJson(materialization, {
    expectedCatalogManifest,
    write: async (chunk) => {
      if (!stream.write(chunk)) await once(stream, "drain");
    }
  });
  if (close) {
    stream.end();
    await once(stream, "finish");
  }
  return result;
}

function parseArgs(argv) {
  const options = {
    manifest: null,
    output: null,
    force: false,
    allowIncomplete: false,
    help: false,
    maxArtifactBytes: DEFAULT_INGESTION_COVERAGE_ARTIFACT_LIMIT_BYTES,
    unresolvedPreviewLimit: 250
  };
  for (const argument of argv) {
    if (argument === "--force") options.force = true;
    else if (argument === "--allow-incomplete") options.allowIncomplete = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument.startsWith("--manifest=")) options.manifest = argument.slice(11);
    else if (argument.startsWith("--output=")) options.output = argument.slice(9);
    else if (argument.startsWith("--max-artifact-bytes=")) {
      options.maxArtifactBytes = positiveInteger(
        argument.slice(21),
        "--max-artifact-bytes"
      );
    } else if (argument.startsWith("--unresolved-preview-limit=")) {
      options.unresolvedPreviewLimit = nonNegativeInteger(
        argument.slice(27),
        "--unresolved-preview-limit"
      );
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return parsed;
}

function helpText() {
  return `Usage: node scripts/materialize-ingestion-coverage.mjs --manifest=<path> [options]\n\n` +
    `Required campaign inputs are hash-pinned; the CLI never discovers success from directory counts.\n\n` +
    `Options:\n` +
    `  --output=<path>                 Atomically write JSON instead of stdout.\n` +
    `  --force                         Replace an existing explicit output path.\n` +
    `  --allow-incomplete              Exit 0 after writing an incomplete matrix (default exit 2).\n` +
    `  --max-artifact-bytes=<n>        Per-file safety cap (default 134217728).\n` +
    `  --unresolved-preview-limit=<n>  Bounded summary preview; all rows remain in coverageReceipt.pairs.\n` +
    `  --help                          Show this help.\n`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${JSON.stringify({
      event: "ingestion_coverage.failed",
      objectiveComplete: false,
      error: error instanceof Error ? error.message : String(error)
    })}\n`);
    process.exitCode = 1;
  }
);
