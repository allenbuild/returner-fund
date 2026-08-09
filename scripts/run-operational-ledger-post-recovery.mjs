#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  appendValidationJournal,
  auditOperationalLedgerCandidates,
  buildCatalogOwnershipIndex,
  buildCurrentEvidenceIdentityIndex,
  buildRecoveryInputManifest,
  candidatesRequiringAnonymousValidation,
  extractOperationalLedgerCandidates,
  loadCurrentEvidenceSources,
  readValidationJournal,
  recoveryCheckpoint,
  sha256,
  stableStringify,
  validateAnonymousNativeCandidate,
  writeRecoveryArtifactAtomic
} from "./lib/operational-ledger-post-recovery.mjs";
import { loadAutonomousCatalogs } from "./lib/autonomous-ingestion-plan.mjs";

const DEFAULT_LEDGER_PATH = "outputs/public-ingestion-operational-ledger-current.json";
const DEFAULT_OUTPUT_DIR = "work/operational-ledger-post-recovery";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(helpText());
  process.exit(0);
}

const root = process.cwd();
const ledgerPath = resolve(root, args.ledger);
const outputDir = resolve(root, args.outputDir);
const candidatePath = resolve(outputDir, "promotion-candidate.json");
const summaryPath = resolve(outputDir, "summary.json");
const journalPath = resolve(outputDir, "validation-journal.ndjson");
const checkpointPath = resolve(outputDir, "checkpoint.json");

const ledgerBytes = await readFile(ledgerPath);
const ledger = JSON.parse(ledgerBytes.toString("utf8"));
const [catalogs, evidenceSources] = await Promise.all([
  loadAutonomousCatalogs(root),
  loadCurrentEvidenceSources(root)
]);
const manifest = buildRecoveryInputManifest({
  ledgerBytes,
  ledgerPath: repositoryPath(root, ledgerPath),
  evidenceSources,
  catalogs
});
const candidates = extractOperationalLedgerCandidates(ledger);
const currentEvidenceIndex = buildCurrentEvidenceIdentityIndex(evidenceSources);
const ownershipIndex = buildCatalogOwnershipIndex(catalogs);
const validationReceipts = await readValidationJournal(journalPath, {
  inputHash: manifest.inputHash
});
const validationCandidates = candidatesRequiringAnonymousValidation(
  candidates,
  currentEvidenceIndex
);

if (args.validate) {
  const artifact = auditOperationalLedgerCandidates({
    candidates,
    currentEvidenceIndex,
    ownershipIndex,
    validationReceipts,
    inputManifest: manifest
  });
  const expected = `${stableStringify(artifact, 2)}\n`;
  const actual = await readFile(candidatePath, "utf8");
  if (actual !== expected) {
    throw new Error(
      `${repositoryPath(root, candidatePath)} is stale; run the recovery command without --validate.`
    );
  }
  process.stdout.write(`${stableStringify({
    candidatePath: repositoryPath(root, candidatePath),
    sha256: sha256(Buffer.from(actual)),
    summary: artifact.summary,
    validated: true
  }, 2)}\n`);
  process.exit(0);
}

if (args.anonymousValidation) {
  let previousRequestAt = 0;
  let newValidations = 0;
  for (const candidate of validationCandidates) {
    if (validationReceipts.has(candidate.identity)) continue;
    if (newValidations >= args.maxAnonymousValidations) break;
    const elapsed = Date.now() - previousRequestAt;
    if (previousRequestAt && elapsed < args.minRequestIntervalMs) {
      await delay(args.minRequestIntervalMs - elapsed);
    }
    const receipt = await validateAnonymousNativeCandidate(candidate);
    previousRequestAt = Date.now();
    await appendValidationJournal(journalPath, {
      inputHash: manifest.inputHash,
      identity: candidate.identity,
      receipt
    });
    validationReceipts.set(candidate.identity, receipt);
    newValidations += 1;
    await writeRecoveryArtifactAtomic(checkpointPath, recoveryCheckpoint({
      inputHash: manifest.inputHash,
      pendingCandidates: validationCandidates,
      receipts: validationReceipts
    }));
  }
}

const artifact = auditOperationalLedgerCandidates({
  candidates,
  currentEvidenceIndex,
  ownershipIndex,
  validationReceipts,
  inputManifest: manifest
});
const candidateWrite = await writeRecoveryArtifactAtomic(candidatePath, artifact);
const summaryWrite = await writeRecoveryArtifactAtomic(summaryPath, {
  schemaVersion: artifact.schemaVersion,
  inputHash: manifest.inputHash,
  candidatePath: repositoryPath(root, candidatePath),
  candidateSha256: candidateWrite.sha256,
  anonymousValidationEnabled: args.anonymousValidation,
  authenticatedCollectionUsed: false,
  linkedinNetworkAccessUsed: false,
  summary: artifact.summary
});
const checkpointWrite = await writeRecoveryArtifactAtomic(checkpointPath, recoveryCheckpoint({
  inputHash: manifest.inputHash,
  pendingCandidates: validationCandidates,
  receipts: validationReceipts
}));

process.stdout.write(`${stableStringify({
  candidate: {
    path: repositoryPath(root, candidatePath),
    bytes: candidateWrite.bytes,
    sha256: candidateWrite.sha256
  },
  checkpoint: {
    path: repositoryPath(root, checkpointPath),
    sha256: checkpointWrite.sha256
  },
  journal: repositoryPath(root, journalPath),
  safety: {
    authenticatedCollectionUsed: false,
    linkedinNetworkAccessUsed: false,
    anonymousValidationEnabled: args.anonymousValidation,
    anonymousEndpoints: args.anonymousValidation
      ? ["publish.twitter.com/oembed", "www.youtube.com/oembed"]
      : []
  },
  summary: artifact.summary,
  summaryArtifact: {
    path: repositoryPath(root, summaryPath),
    sha256: summaryWrite.sha256
  }
}, 2)}\n`);

function parseArgs(values) {
  const parsed = {
    ledger: DEFAULT_LEDGER_PATH,
    outputDir: DEFAULT_OUTPUT_DIR,
    anonymousValidation: false,
    validate: false,
    help: false,
    minRequestIntervalMs: 1_000,
    maxAnonymousValidations: 1_000
  };
  const seen = new Set();
  for (const value of values) {
    if (value === "--anonymous-validation") {
      assertUnique(seen, "anonymous-validation");
      parsed.anonymousValidation = true;
      continue;
    }
    if (value === "--validate") {
      assertUnique(seen, "validate");
      parsed.validate = true;
      continue;
    }
    if (value === "--help" || value === "-h") {
      parsed.help = true;
      continue;
    }
    const match = value.match(/^--([^=]+)=(.*)$/u);
    if (!match) throw new Error(`Expected --name=value; received ${value}`);
    const [, name, raw] = match;
    assertUnique(seen, name);
    if (name === "ledger") parsed.ledger = requiredText(raw, "--ledger");
    else if (name === "output-dir") parsed.outputDir = requiredText(raw, "--output-dir");
    else if (name === "min-request-interval-ms") {
      parsed.minRequestIntervalMs = boundedInteger(raw, name, 250, 60_000);
    } else if (name === "max-anonymous-validations") {
      parsed.maxAnonymousValidations = boundedInteger(raw, name, 0, 10_000);
    } else {
      throw new Error(`Unknown recovery argument: --${name}`);
    }
  }
  if (parsed.validate && parsed.anonymousValidation) {
    throw new Error("--validate is read-only and cannot be combined with --anonymous-validation.");
  }
  return parsed;
}

function helpText() {
  return `Usage: node scripts/run-operational-ledger-post-recovery.mjs [options]\n\n` +
    `Offline-first mining of the public-ingestion operational ledger for native X, LinkedIn, ` +
    `Instagram, and YouTube posts that are absent from every current evidence/review source.\n\n` +
    `Options:\n` +
    `  --ledger=<path>                    Ledger path (default: ${DEFAULT_LEDGER_PATH})\n` +
    `  --output-dir=<path>                Work output directory (default: ${DEFAULT_OUTPUT_DIR})\n` +
    `  --anonymous-validation             Use low-rate anonymous X/YouTube oEmbed only\n` +
    `  --min-request-interval-ms=<n>      Anonymous request spacing, minimum 250 ms\n` +
    `  --max-anonymous-validations=<n>    Resume-safe request cap\n` +
    `  --validate                         Rebuild in memory and verify candidate bytes\n` +
    `  --help                             Show help\n\n` +
    `The command never launches a browser, loads cookies, authenticates to a platform, or sends ` +
    `LinkedIn/Instagram requests. LinkedIn evidence is validated from immutable repository URLs ` +
    `and canonical account mappings only.\n`;
}

function assertUnique(seen, key) {
  if (seen.has(key)) throw new Error(`Duplicate argument: --${key}`);
  seen.add(key);
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} requires a non-empty value.`);
  return text;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!/^\d+$/u.test(String(value))) throw new Error(`--${label} must be an integer.`);
  const number = Number(value);
  if (number < minimum || number > maximum) {
    throw new Error(`--${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function repositoryPath(rootPath, absolutePath) {
  return relative(rootPath, absolutePath).replaceAll("\\", "/");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
