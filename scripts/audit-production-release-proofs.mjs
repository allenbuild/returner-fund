#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { auditProductionReleaseProofs } from
  "./lib/production-release-proof-audit.mjs";

const MAX_INPUT_BYTES = 128 * 1024 * 1024;

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  for (const field of [
    "releaseProofs",
    "catalogs",
    "expectedManifest",
    "runStartedAt",
    "generatedAt"
  ]) {
    if (!options[field]) throw new Error(`--${flagName(field)} is required.`);
  }
  const [releaseProofs, catalogs, expectedCatalogManifest] = await Promise.all([
    readBoundedJson(options.releaseProofs, "release proofs"),
    readBoundedJson(options.catalogs, "catalogs"),
    readBoundedJson(options.expectedManifest, "expected manifest")
  ]);
  const result = auditProductionReleaseProofs({
    releaseProofs,
    catalogs,
    expectedCatalogManifest,
    runStartedAt: options.runStartedAt,
    generatedAt: options.generatedAt
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

function parseArgs(argv) {
  const options = {
    releaseProofs: null,
    catalogs: null,
    expectedManifest: null,
    runStartedAt: null,
    generatedAt: null,
    help: false
  };
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const equals = argument.indexOf("=");
    if (!argument.startsWith("--") || equals < 3) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const flag = argument.slice(2, equals);
    const value = argument.slice(equals + 1);
    if (flag === "release-proofs") options.releaseProofs = value;
    else if (flag === "catalogs") options.catalogs = value;
    else if (flag === "expected-manifest") options.expectedManifest = value;
    else if (flag === "run-started-at") options.runStartedAt = value;
    else if (flag === "generated-at") options.generatedAt = value;
    else throw new Error(`Unknown argument: --${flag}`);
  }
  return options;
}

async function readBoundedJson(path, label) {
  const absolutePath = resolve(path);
  const metadata = await stat(absolutePath);
  if (!metadata.isFile() || metadata.size > MAX_INPUT_BYTES) {
    throw new Error(`${label} must be a regular file no larger than ${MAX_INPUT_BYTES} bytes.`);
  }
  const bytes = await readFile(absolutePath);
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function flagName(field) {
  return field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function helpText() {
  return `Usage: node scripts/audit-production-release-proofs.mjs [options]\n\n` +
    `Fail-closed validation for all four production release receipts plus every ` +
    `canonical batch x core-platform sample cell.\n\n` +
    `Required:\n` +
    `  --release-proofs=<json>    Four ingestion-production-release-proof.v1 receipts.\n` +
    `  --catalogs=<json>          Normalized campaign catalogs artifact.\n` +
    `  --expected-manifest=<json> Independently derived catalog manifest artifact.\n` +
    `  --run-started-at=<ISO UTC> Campaign read-window start.\n` +
    `  --generated-at=<ISO UTC>   Release-proof read-window end.\n`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${JSON.stringify({
      event: "production_release_proof_audit.failed",
      error: error instanceof Error ? error.message : String(error)
    })}\n`);
    process.exitCode = 1;
  }
);
