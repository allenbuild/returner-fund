#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  buildIngestionCoverageReport
} from "./lib/ingestion-coverage-report.mjs";

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  for (const [key, label] of [
    ["materialization", "--materialization"],
    ["historicalManifest", "--historical-manifest"],
    ["recentManifest", "--recent-manifest"]
  ]) {
    if (!options[key]) throw new Error(`${label}=<path> is required.`);
  }

  const { report, markdown } = await buildIngestionCoverageReport({
    root: options.root,
    materializationPath: options.materialization,
    historicalManifestPath: options.historicalManifest,
    recentManifestPath: options.recentManifest,
    maxManifestBytes: options.maxManifestBytes,
    maxProofArtifactBytes: options.maxProofArtifactBytes,
    maxCapturedMaterializationValueBytes:
      options.maxCapturedMaterializationValueBytes
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const writes = [];
  if (options.jsonOutput) {
    writes.push(writeAtomic(options.jsonOutput, json, options.force));
  }
  if (options.markdownOutput) {
    writes.push(writeAtomic(options.markdownOutput, markdown, options.force));
  }
  await Promise.all(writes);
  if (!options.jsonOutput && !options.markdownOutput) {
    process.stdout.write(options.format === "json" ? json : markdown);
  }
  process.stderr.write(`${JSON.stringify({
    event: "ingestion_coverage.reported",
    runId: report.runId,
    reportPayloadSha256: report.provenance.reportPayloadSha256,
    productionReleaseStatus: report.productionReleaseStatus.status,
    fullIngestionCoverageStatus: report.fullIngestionCoverageStatus.status,
    objectiveComplete: report.objectiveComplete,
    jsonOutput: options.jsonOutput ? resolve(options.jsonOutput) : null,
    markdownOutput: options.markdownOutput ? resolve(options.markdownOutput) : null
  })}\n`);
  return report.objectiveComplete || options.allowIncomplete ? 0 : 2;
}

async function writeAtomic(path, body, force) {
  const destination = resolve(path);
  if (existsSync(destination) && !force) {
    throw new Error(`Output already exists: ${destination}. Pass --force to replace it.`);
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = resolve(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    await writeFile(temporary, body, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    materialization: null,
    historicalManifest: null,
    recentManifest: null,
    jsonOutput: null,
    markdownOutput: null,
    format: "markdown",
    force: false,
    allowIncomplete: false,
    help: false,
    maxManifestBytes: 8 * 1024 * 1024,
    maxProofArtifactBytes: 32 * 1024 * 1024,
    maxCapturedMaterializationValueBytes: 16 * 1024 * 1024
  };
  for (const argument of argv) {
    if (argument === "--force") options.force = true;
    else if (argument === "--allow-incomplete") options.allowIncomplete = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument.startsWith("--root=")) options.root = argument.slice(7);
    else if (argument.startsWith("--materialization=")) {
      options.materialization = argument.slice(18);
    } else if (argument.startsWith("--historical-manifest=")) {
      options.historicalManifest = argument.slice(22);
    } else if (argument.startsWith("--recent-manifest=")) {
      options.recentManifest = argument.slice(18);
    } else if (argument.startsWith("--json-output=")) {
      options.jsonOutput = argument.slice(14);
    } else if (argument.startsWith("--markdown-output=")) {
      options.markdownOutput = argument.slice(18);
    } else if (argument.startsWith("--format=")) {
      options.format = argument.slice(9);
      if (!["json", "markdown"].includes(options.format)) {
        throw new Error("--format must be json or markdown.");
      }
    } else if (argument.startsWith("--max-manifest-bytes=")) {
      options.maxManifestBytes = positiveInteger(argument.slice(21), argument);
    } else if (argument.startsWith("--max-proof-artifact-bytes=")) {
      options.maxProofArtifactBytes = positiveInteger(argument.slice(27), argument);
    } else if (argument.startsWith("--max-captured-value-bytes=")) {
      options.maxCapturedMaterializationValueBytes = positiveInteger(
        argument.slice(27),
        argument
      );
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label.split("=")[0]} must be a positive safe integer.`);
  }
  return number;
}

function helpText() {
  return `Usage: node scripts/report-ingestion-coverage.mjs [required inputs] [options]\n\n` +
    `Required:\n` +
    `  --materialization=<path>       Coverage materialization JSON.\n` +
    `  --historical-manifest=<path>   Immutable historical proof manifest.\n` +
    `  --recent-manifest=<path>       Immutable recent proof manifest.\n\n` +
    `Options:\n` +
    `  --json-output=<path>           Atomically write the measured JSON report.\n` +
    `  --markdown-output=<path>       Atomically write the Markdown report.\n` +
    `  --format=json|markdown         Stdout format when no output path is supplied.\n` +
    `  --root=<path>                  Root for manifest-declared paths (default cwd).\n` +
    `  --force                        Replace explicit output files.\n` +
    `  --allow-incomplete             Exit 0 for an incomplete objective (default exit 2).\n` +
    `  --max-manifest-bytes=<n>       Manifest/catalog JSON safety cap.\n` +
    `  --max-proof-artifact-bytes=<n> Proof/exclusion JSON safety cap.\n` +
    `  --max-captured-value-bytes=<n> Per-summary-field streaming capture cap.\n` +
    `  --help                         Show this help.\n`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${JSON.stringify({
      event: "ingestion_coverage.report_failed",
      objectiveComplete: false,
      error: error instanceof Error ? error.message : String(error)
    })}\n`);
    process.exitCode = 1;
  }
);
