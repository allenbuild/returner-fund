#!/usr/bin/env node

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  captureProductionReleaseProofBundle
} from "./lib/production-release-proof-bundle.mjs";
import { readCoveragePairsFromFile } from "./lib/production-graph-sampler.mjs";

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  for (const name of [
    "catalogs",
    "expectedManifest",
    "coverage",
    "artifactRoot",
    "revision",
    "baseUrl",
    "deploymentAttestation"
  ]) {
    if (!options[name]) throw new Error(`--${flagName(name)}=<value> is required.`);
  }

  const root = resolve(options.artifactRoot);
  const [catalogs, expectedCatalogManifest, deploymentAttestation, coveragePairs] =
    await Promise.all([
      readBoundedJson(resolve(options.catalogs), options.maxInputBytes, "catalogs"),
      readBoundedJson(
        resolve(options.expectedManifest),
        options.maxInputBytes,
        "expected manifest"
      ),
      readBoundedJson(
        resolve(options.deploymentAttestation),
        options.maxInputBytes,
        "deployment attestation"
      ),
      readCoveragePairsFromFile(resolve(options.coverage), {
        maxBytes: options.maxCoverageBytes
      })
    ]);

  const bundle = await captureProductionReleaseProofBundle({
    rootDir: root,
    catalogs,
    expectedCatalogManifest,
    coveragePairs,
    artifactManifestPath: options.graphManifest
      ? resolve(options.graphManifest)
      : undefined,
    graphDir: options.graphDir ? resolve(options.graphDir) : undefined,
    benchmarkDir: options.benchmarkDir ? resolve(options.benchmarkDir) : undefined,
    deployedRevision: options.revision,
    productionBaseUrl: options.baseUrl,
    deploymentAttestation,
    timeoutMs: options.timeoutMs,
    maxManifestBytes: options.maxManifestBytes,
    maxGraphResponseBytes: options.maxGraphResponseBytes
  });
  const body = `${JSON.stringify(bundle, null, 2)}\n`;
  if (options.output) await atomicWrite(resolve(options.output), body);
  else process.stdout.write(body);
  return bundle.status === "verified" ? 0 : 2;
}

function parseArgs(argv) {
  const options = {
    catalogs: null,
    expectedManifest: null,
    coverage: null,
    artifactRoot: null,
    graphManifest: null,
    graphDir: null,
    benchmarkDir: null,
    revision: null,
    baseUrl: null,
    deploymentAttestation: null,
    output: null,
    timeoutMs: 45_000,
    maxInputBytes: 128 * 1024 * 1024,
    maxCoverageBytes: 256 * 1024 * 1024,
    maxManifestBytes: 4 * 1024 * 1024,
    maxGraphResponseBytes: 24 * 1024 * 1024,
    help: false
  };
  const names = new Map([
    ["catalogs", "catalogs"],
    ["expected-manifest", "expectedManifest"],
    ["coverage", "coverage"],
    ["artifact-root", "artifactRoot"],
    ["graph-manifest", "graphManifest"],
    ["graph-dir", "graphDir"],
    ["benchmark-dir", "benchmarkDir"],
    ["revision", "revision"],
    ["base-url", "baseUrl"],
    ["deployment-attestation", "deploymentAttestation"],
    ["output", "output"]
  ]);
  const integers = new Map([
    ["timeout-ms", "timeoutMs"],
    ["max-input-bytes", "maxInputBytes"],
    ["max-coverage-bytes", "maxCoverageBytes"],
    ["max-manifest-bytes", "maxManifestBytes"],
    ["max-graph-response-bytes", "maxGraphResponseBytes"]
  ]);
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
    if (!value) throw new Error(`--${flag} requires a value.`);
    if (names.has(flag)) options[names.get(flag)] = value;
    else if (integers.has(flag)) options[integers.get(flag)] = positiveInteger(value, flag);
    else throw new Error(`Unknown argument: --${flag}`);
  }
  return options;
}

async function readBoundedJson(path, maxBytes, label) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file.`);
  if (metadata.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`);
  const bytes = await readFile(path);
  if (bytes.length !== metadata.size) throw new Error(`${label} changed while being read.`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new SyntaxError(`${label} is invalid JSON: ${error.message}`);
  }
}

async function atomicWrite(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, body, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`--${label} must be a positive safe integer.`);
  }
  return number;
}

function flagName(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function helpText() {
  return `Usage: node scripts/capture-production-release-proof-bundle.mjs [options]\n\n` +
    `Fail-closed post-deploy capture. It validates exact rebuilt graph bytes, ` +
    `independent deployment metadata, an anonymous live manifest, and all 30 ` +
    `batch-platform production samples before emitting any of the four release receipts.\n\n` +
    `Required:\n` +
    `  --catalogs=<json>                 Exact canonical catalogs.\n` +
    `  --expected-manifest=<json>        Independent expected-catalog manifest.\n` +
    `  --coverage=<json>                 Measured coverage receipt/materialization.\n` +
    `  --artifact-root=<dir>             Root containing public/graph and outputs/benchmarks.\n` +
    `  --revision=<git-sha>              Exact deployed lowercase Git revision.\n` +
    `  --base-url=<https-url>            Production origin; no credentials allowed.\n` +
    `  --deployment-attestation=<json>   Independent verified deployment metadata.\n\n` +
    `Optional:\n` +
    `  --output=<json>                   Atomically write the capture; otherwise stdout.\n` +
    `  --graph-manifest=<json>           Override public/graph/manifest.json.\n` +
    `  --graph-dir=<dir>                 Override rebuilt graph directory.\n` +
    `  --benchmark-dir=<dir>             Override rebuilt benchmark directory.\n` +
    `  --timeout-ms=<n>                  Anonymous request timeout (max 60000).\n`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${JSON.stringify({
      event: "production_release_proof_bundle.failed",
      error: error instanceof Error ? error.message : String(error)
    })}\n`);
    process.exitCode = 1;
  }
);
