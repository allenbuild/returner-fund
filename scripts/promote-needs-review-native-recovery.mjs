#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadAutonomousCatalogs } from "./lib/autonomous-ingestion-plan.mjs";
import { buildPublicNativeAuthorResolver } from "./lib/public-evidence-attribution.mjs";
import {
  readPublicEvidenceArtifact,
  writePublicEvidenceArtifactPairAtomic
} from "./lib/public-evidence-artifact.mjs";
import { planNeedsReviewNativePromotion } from "./lib/needs-review-native-promotion.mjs";

const CANONICAL_PATH = "src/lib/social/public-evidence-current.json";
const REFERENCE_PATHS = Object.freeze([
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/volume-evidence-current.json",
  "src/lib/social/a16z-speedrun-006-social-evidence.json",
  "src/lib/social/eden-robotics-verified-native-evidence.json"
]);

export function parseNeedsReviewPromotionArgs(rawArgs) {
  const parsed = { dryRun: false, write: false };
  const supported = new Set([
    "candidate",
    "candidate-sha256",
    "receipt",
    "expected-candidates",
    "expected-additions",
    "expected-resolved-review"
  ]);
  for (const argument of rawArgs) {
    if (argument === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (argument === "--write") {
      parsed.write = true;
      continue;
    }
    const match = argument.match(/^--([^=]+)=(.*)$/);
    if (!match || !supported.has(match[1])) throw new Error(`Unknown argument: ${argument}`);
    parsed[toCamelCase(match[1])] = match[2];
  }
  if (parsed.dryRun === parsed.write) throw new Error("Pass exactly one of --dry-run or --write.");
  const candidateSha256 = required(parsed.candidateSha256, "candidate-sha256");
  if (!/^[a-f0-9]{64}$/.test(candidateSha256)) {
    throw new Error("--candidate-sha256 must be a lowercase SHA-256 hash.");
  }
  return {
    candidate: required(parsed.candidate, "candidate"),
    candidateSha256,
    receipt: clean(parsed.receipt),
    expectedCandidates: integer(parsed.expectedCandidates, "expected-candidates"),
    expectedAdditions: integer(parsed.expectedAdditions, "expected-additions"),
    expectedResolvedReview: integer(parsed.expectedResolvedReview, "expected-resolved-review"),
    dryRun: parsed.dryRun,
    write: parsed.write
  };
}

export async function promoteNeedsReviewNativeRecovery(
  rawArgs = process.argv.slice(2),
  dependencies = {}
) {
  const args = parseNeedsReviewPromotionArgs(rawArgs);
  const rootDir = path.resolve(dependencies.rootDir ?? process.cwd());
  const canonicalPath = path.resolve(rootDir, CANONICAL_PATH);
  const candidatePath = path.resolve(rootDir, args.candidate);
  if (candidatePath === canonicalPath) throw new Error("--candidate must not be canonical evidence.");
  const readFileImpl = dependencies.readFileImpl ?? readFile;
  const [canonicalArtifact, candidateBytes, catalogs, ...referenceBytes] = await Promise.all([
    readPublicEvidenceArtifact(canonicalPath, { rootDir, readFileImpl }),
    readFileImpl(candidatePath),
    loadAutonomousCatalogs(rootDir),
    ...REFERENCE_PATHS.map((relativePath) => readFileImpl(path.join(rootDir, relativePath)))
  ]);
  const actualCandidateSha256 = sha256(candidateBytes);
  if (actualCandidateSha256 !== args.candidateSha256) {
    throw new Error(
      `Candidate SHA-256 mismatch: expected ${args.candidateSha256}, received ${actualCandidateSha256}.`
    );
  }
  const candidate = parseJson(candidateBytes, candidatePath);
  const references = referenceBytes.map((bytes, index) =>
    parseJson(bytes, path.join(rootDir, REFERENCE_PATHS[index]))
  );
  const plan = planNeedsReviewNativePromotion({
    canonical: canonicalArtifact.snapshot,
    candidate,
    currentSnapshots: [canonicalArtifact.snapshot, ...references],
    resolveNativeAuthor: buildPublicNativeAuthorResolver(catalogs)
  });
  assertExpected(plan.candidateCount, args.expectedCandidates, "candidate rows");
  assertExpected(plan.additions.length, args.expectedAdditions, "net-new additions");
  assertExpected(
    plan.resolvedReview.length,
    args.expectedResolvedReview,
    "resolved review rows"
  );

  const receipt = {
    schemaVersion: 1,
    status: args.dryRun ? "dry_run" : "promoted",
    canonicalPath,
    candidatePath,
    candidateSha256: actualCandidateSha256,
    candidateEvidence: plan.candidateCount,
    addedEvidence: plan.additions.length,
    alreadyRepresented: plan.alreadyRepresented.length,
    resolvedReview: plan.resolvedReview.length,
    retainedReview: plan.retainedReview.length,
    removedEvidence: 0,
    zeroEngagementAdditions: plan.zeroEngagementAdditions,
    addedByBatch: plan.addedByBatch,
    addedByPlatform: plan.addedByPlatform,
    canonicalHashBefore: canonicalArtifact.canonicalSha256,
    canonicalHashAfter: canonicalArtifact.canonicalSha256,
    operationalLedgerHashBefore: canonicalArtifact.ledgerSha256,
    operationalLedgerHashAfter: canonicalArtifact.ledgerSha256,
    reviewLedgerHashBefore: canonicalArtifact.reviewLedgerSha256,
    reviewLedgerHashAfter: canonicalArtifact.reviewLedgerSha256
  };
  if (args.write) {
    const published = await (dependencies.publishArtifact ?? writePublicEvidenceArtifactPairAtomic)({
      rootDir,
      canonicalPath,
      snapshot: plan.promoted,
      expectedCanonicalSha256: canonicalArtifact.canonicalSha256,
      expectedLedgerSha256: canonicalArtifact.ledgerSha256,
      expectedReviewLedgerSha256: canonicalArtifact.reviewLedgerSha256
    });
    receipt.canonicalHashAfter = published.canonicalSha256;
    receipt.operationalLedgerHashAfter = published.ledgerSha256;
    receipt.reviewLedgerHashAfter = published.reviewLedgerSha256;
  }
  if (args.receipt) {
    await atomicWrite(path.resolve(rootDir, args.receipt), `${JSON.stringify(receipt, null, 2)}\n`);
  }
  (dependencies.stdout ?? process.stdout).write(`${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function parseJson(bytes, sourcePath) {
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes));
  } catch (error) {
    throw new Error(`Invalid JSON in ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function atomicWrite(outputPath, body) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporary, body);
  await rename(temporary, outputPath);
}

function assertExpected(actual, expected, label) {
  if (actual !== expected) throw new Error(`Expected ${expected} ${label}; received ${actual}.`);
}

function integer(value, name) {
  if (!/^\d+$/.test(String(value ?? ""))) throw new Error(`--${name}=... is required.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`--${name} must be non-negative.`);
  return result;
}

function required(value, name) {
  const text = clean(value);
  if (!text) throw new Error(`--${name}=... is required.`);
  return text;
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  promoteNeedsReviewNativeRecovery().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
