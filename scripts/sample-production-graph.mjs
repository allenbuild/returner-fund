#!/usr/bin/env node

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  captureProductionGraphSamples,
  readCoveragePairsFromFile
} from "./lib/production-graph-sampler.mjs";

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  for (const field of ["coverage", "baseUrl"]) {
    if (!options[field]) throw new Error(`--${flagName(field)} is required.`);
  }

  const coveragePairs = await readCoveragePairsFromFile(resolve(options.coverage), {
    maxBytes: options.maxCoverageBytes
  });
  const capture = await captureProductionGraphSamples({
    coveragePairs,
    baseUrl: options.baseUrl,
    artifactDigest: options.artifactDigest,
    revision: options.revision,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes
  });
  const json = `${JSON.stringify(capture, null, 2)}\n`;
  if (options.output) await atomicWriteJson(resolve(options.output), json);
  else process.stdout.write(json);
  return capture.status === "verified" ? 0 : 2;
}

function parseArgs(argv) {
  const options = {
    coverage: null,
    baseUrl: null,
    artifactDigest: null,
    revision: null,
    output: null,
    timeoutMs: 45_000,
    maxResponseBytes: 24 * 1024 * 1024,
    maxCoverageBytes: 256 * 1024 * 1024,
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
    if (flag === "coverage") options.coverage = value;
    else if (flag === "base-url") options.baseUrl = value;
    else if (flag === "artifact-digest") options.artifactDigest = value;
    else if (flag === "revision") options.revision = value;
    else if (flag === "output") options.output = value;
    else if (flag === "timeout-ms") options.timeoutMs = integer(value, flag);
    else if (flag === "max-response-bytes") options.maxResponseBytes = integer(value, flag);
    else if (flag === "max-coverage-bytes") options.maxCoverageBytes = integer(value, flag);
    else throw new Error(`Unknown argument: --${flag}`);
  }
  return options;
}

async function atomicWriteJson(path, json) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, json, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

function integer(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new TypeError(`--${label} must be an integer.`);
  return parsed;
}

function flagName(field) {
  return field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function helpText() {
  return `Usage: node scripts/sample-production-graph.mjs [options]\n\n` +
    `Read-only, fail-closed production sampler. It makes exactly three concurrent ` +
    `unauthenticated /api/graph requests (one per canonical batch), then verifies ` +
    `all 30 batch x core-platform cells against exact coverage pair keys.\n\n` +
    `Required:\n` +
    `  --coverage=<json>          Durable materialization or coverage receipt.\n` +
    `  --base-url=<https-url>     Production deployment origin.\n\n` +
    `Required to emit a productionSample proof:\n` +
    `  --artifact-digest=<sha256> Exact productionArtifact digest.\n` +
    `  --revision=<revision>      Exact deployed production revision.\n\n` +
    `Optional:\n` +
    `  --output=<json>            Atomically write the capture instead of stdout.\n` +
    `  --timeout-ms=<n>           Per-batch timeout; default 45000, maximum 60000.\n` +
    `  --max-response-bytes=<n>   Per-batch decoded limit; default 25165824.\n` +
    `  --max-coverage-bytes=<n>   Streaming input limit; default 268435456.\n`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${JSON.stringify({
      event: "production_graph_sampler.failed",
      error: error instanceof Error ? error.message : String(error)
    })}\n`);
    process.exitCode = 1;
  }
);
