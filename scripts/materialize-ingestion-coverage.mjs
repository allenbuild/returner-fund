#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { readFile, rename, unlink } from "node:fs/promises";
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
  const recentProofInput = options.recentProofManifest
    ? await loadRecentProofScopes(options.recentProofManifest, options.maxArtifactBytes)
    : { pairScopes: [], inputArtifacts: [] };
  const materialization = await materializeIngestionCoverage({
    ...campaign.materializerInput,
    pairScopes: [
      ...(campaign.materializerInput.pairScopes ?? []),
      ...recentProofInput.pairScopes
    ],
    inputArtifacts: [
      ...(campaign.materializerInput.inputArtifacts ?? []),
      ...recentProofInput.inputArtifacts
    ],
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

async function loadRecentProofScopes(manifestPath, maxArtifactBytes) {
  const absoluteManifestPath = resolve(manifestPath);
  const manifestBytes = await readBounded(absoluteManifestPath, maxArtifactBytes);
  const manifest = parseJson(manifestBytes, "recent proof manifest");
  if (manifest?.schemaVersion !== "recent-completion-proof-generator.v1") {
    throw new Error("recent proof manifest schemaVersion is unsupported.");
  }
  const generatedAt = canonicalTimestamp(
    manifest.generatedAt,
    "recent proof manifest.generatedAt"
  );
  const descriptor = manifest.artifacts?.recentCompletionProofs;
  if (!descriptor?.path || !descriptor?.sha256) {
    throw new Error("recent proof manifest must declare recentCompletionProofs.");
  }
  const proofPath = resolve(dirname(absoluteManifestPath), descriptor.path);
  const proofBytes = await readBounded(proofPath, maxArtifactBytes);
  const proofSha256 = sha256(proofBytes);
  if (proofSha256 !== descriptor.sha256) {
    throw new Error(
      `recent completion proofs sha256 mismatch: expected ${descriptor.sha256}, received ${proofSha256}.`
    );
  }
  if (descriptor.bytes !== undefined && descriptor.bytes !== proofBytes.length) {
    throw new Error(
      `recent completion proofs bytes mismatch: expected ${descriptor.bytes}, received ${proofBytes.length}.`
    );
  }
  const proofs = parseJson(proofBytes, "recent completion proofs");
  if (!Array.isArray(proofs)) throw new TypeError("recent completion proofs must be an array.");
  const pairScopes = proofs.map((proof, index) => {
    if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
      throw new TypeError(`recent completion proof ${index} must be an object.`);
    }
    if (!proof.receipt || proof.receipt.status !== "complete") {
      throw new Error(`recent completion proof ${proof.pairKey ?? index} is not complete.`);
    }
    return {
      batchSlug: proof.batchSlug,
      entityType: proof.entityType,
      entityId: proof.entityId,
      platform: proof.platform,
      pairKey: proof.pairKey,
      scope: { recentBackfillReceipt: proof.receipt }
    };
  }).sort((left, right) => left.pairKey.localeCompare(right.pairKey));
  return {
    pairScopes,
    inputArtifacts: [
      {
        kind: "recent_completion_proof_manifest",
        path: absoluteManifestPath,
        sha256: sha256(manifestBytes),
        observedAt: generatedAt
      },
      {
        kind: "recent_completion_proofs",
        path: proofPath,
        sha256: proofSha256,
        observedAt: generatedAt
      }
    ]
  };
}

async function readBounded(path, maxBytes) {
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) {
    throw new Error(`${path} exceeds maxArtifactBytes=${maxBytes}.`);
  }
  return bytes;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} is required.`);
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO timestamp.`);
  }
  return value;
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
    unresolvedPreviewLimit: 250,
    recentProofManifest: null
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
    } else if (argument.startsWith("--recent-proof-manifest=")) {
      options.recentProofManifest = argument.slice(24);
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
    `  --recent-proof-manifest=<path>  Hash-verify recent proofs and bind their receipts to pair scopes.\n` +
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
