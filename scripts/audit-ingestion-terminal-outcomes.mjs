#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  buildIngestionTerminalOutcomeAudit
} from "./lib/ingestion-terminal-outcome-audit.mjs";

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  for (const [key, flag] of [
    ["materialization", "--materialization"],
    ["historicalManifest", "--historical-manifest"],
    ["recentManifest", "--recent-manifest"]
  ]) {
    if (!options[key]) throw new Error(`${flag}=<path> is required.`);
  }
  const { audit, gapLedgerBody, markdown } =
    await buildIngestionTerminalOutcomeAudit({
      root: options.root,
      materializationPath: options.materialization,
      historicalManifestPath: options.historicalManifest,
      recentManifestPath: options.recentManifest,
      maxPairBytes: options.maxPairBytes,
      reportLimits: {
        maxManifestBytes: options.maxManifestBytes,
        maxProofArtifactBytes: options.maxProofArtifactBytes,
        maxCapturedMaterializationValueBytes: options.maxCapturedValueBytes
      }
    });
  const writes = [];
  if (options.summaryOutput) {
    writes.push(writeAtomic(
      options.summaryOutput,
      `${JSON.stringify(audit, null, 2)}\n`,
      options.force
    ));
  }
  if (options.ledgerOutput) {
    writes.push(writeAtomic(options.ledgerOutput, gapLedgerBody, options.force));
  }
  if (options.markdownOutput) {
    writes.push(writeAtomic(options.markdownOutput, markdown, options.force));
  }
  await Promise.all(writes);
  if (!options.summaryOutput && !options.ledgerOutput && !options.markdownOutput) {
    process.stdout.write(options.format === "json"
      ? `${JSON.stringify(audit, null, 2)}\n`
      : markdown);
  }
  process.stderr.write(`${JSON.stringify({
    event: "ingestion_terminal_outcomes.audited",
    runId: audit.runId,
    status: audit.status,
    complete: audit.complete,
    auditedCorePairs: audit.audited.corePairs,
    compliantPairs: audit.audited.compliantPairs,
    gapPairs: audit.audited.nonCompliantPairs,
    structurallyUndocumentedPairs: audit.audited.structurallyUndocumentedPairs,
    contradictoryPairs: audit.audited.contradictoryPairs,
    auditPayloadSha256: audit.provenance.auditPayloadSha256,
    summaryOutput: options.summaryOutput ? resolve(options.summaryOutput) : null,
    ledgerOutput: options.ledgerOutput ? resolve(options.ledgerOutput) : null,
    markdownOutput: options.markdownOutput ? resolve(options.markdownOutput) : null
  })}\n`);
  return audit.complete || options.allowGaps ? 0 : 2;
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
    summaryOutput: null,
    ledgerOutput: null,
    markdownOutput: null,
    format: "markdown",
    force: false,
    allowGaps: false,
    help: false,
    maxPairBytes: 4 * 1024 * 1024,
    maxManifestBytes: 8 * 1024 * 1024,
    maxProofArtifactBytes: 32 * 1024 * 1024,
    maxCapturedValueBytes: 16 * 1024 * 1024
  };
  for (const argument of argv) {
    if (argument === "--force") options.force = true;
    else if (argument === "--allow-gaps") options.allowGaps = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument.startsWith("--root=")) options.root = argument.slice(7);
    else if (argument.startsWith("--materialization=")) {
      options.materialization = argument.slice(18);
    } else if (argument.startsWith("--historical-manifest=")) {
      options.historicalManifest = argument.slice(22);
    } else if (argument.startsWith("--recent-manifest=")) {
      options.recentManifest = argument.slice(18);
    } else if (argument.startsWith("--summary-output=")) {
      options.summaryOutput = argument.slice(17);
    } else if (argument.startsWith("--ledger-output=")) {
      options.ledgerOutput = argument.slice(16);
    } else if (argument.startsWith("--markdown-output=")) {
      options.markdownOutput = argument.slice(18);
    } else if (argument.startsWith("--format=")) {
      options.format = argument.slice(9);
      if (!["json", "markdown"].includes(options.format)) {
        throw new Error("--format must be json or markdown.");
      }
    } else if (argument.startsWith("--max-pair-bytes=")) {
      options.maxPairBytes = positiveInteger(argument.slice(17), argument);
    } else if (argument.startsWith("--max-manifest-bytes=")) {
      options.maxManifestBytes = positiveInteger(argument.slice(21), argument);
    } else if (argument.startsWith("--max-proof-artifact-bytes=")) {
      options.maxProofArtifactBytes = positiveInteger(argument.slice(27), argument);
    } else if (argument.startsWith("--max-captured-value-bytes=")) {
      options.maxCapturedValueBytes = positiveInteger(argument.slice(27), argument);
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
  return `Usage: node scripts/audit-ingestion-terminal-outcomes.mjs [inputs] [options]\n\n` +
    `Required:\n` +
    `  --materialization=<path>       Coverage materialization JSON.\n` +
    `  --historical-manifest=<path>   Immutable historical proof manifest.\n` +
    `  --recent-manifest=<path>       Immutable recent proof manifest.\n\n` +
    `Options:\n` +
    `  --summary-output=<path>        Atomically write JSON summary.\n` +
    `  --ledger-output=<path>         Atomically write gap-only NDJSON ledger.\n` +
    `  --markdown-output=<path>       Atomically write Markdown summary.\n` +
    `  --format=json|markdown         Stdout format without explicit outputs.\n` +
    `  --root=<path>                  Root for manifest-declared paths.\n` +
    `  --allow-gaps                   Exit 0 after writing an incomplete audit.\n` +
    `  --force                        Replace explicit output files.\n` +
    `  --max-pair-bytes=<n>           Per-pair streaming safety cap.\n` +
    `  --help                         Show this help.\n`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${JSON.stringify({
      event: "ingestion_terminal_outcomes.failed",
      complete: false,
      error: error instanceof Error ? error.message : String(error)
    })}\n`);
    process.exitCode = 1;
  }
);
