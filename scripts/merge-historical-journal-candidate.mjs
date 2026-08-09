#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";

import {
  buildAutonomousPublicNativeAuthorResolver,
  buildLegacyPublicEvidenceBatchResolver,
  loadAutonomousCatalogs,
  mergePublicEvidenceSnapshots
} from "./lib/autonomous-ingestion-plan.mjs";
import {
  readPublicEvidenceArtifact,
  writePublicEvidenceArtifactPairAtomic
} from "./lib/public-evidence-artifact.mjs";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const journalPath = resolve(root, required(args.journal, "journal"));
const canonicalPath = resolve(root, args.canonical ?? "src/lib/social/public-evidence-current.json");
const observedAt = args.observedAt ?? new Date().toISOString();
const writeMode = args.write === true;
const dryRun = args.dryRun === true;
if (writeMode === dryRun) throw new Error("Pass exactly one of --dry-run or --write.");

const [canonicalArtifact, catalogs] = await Promise.all([
  readPublicEvidenceArtifact(canonicalPath, { rootDir: root }),
  loadAutonomousCatalogs(root)
]);
const extracted = [];
let lastType = null;
let completedSummary = null;
let initialEvent = null;
let lastSequence = 0;
const completedTargets = new Map();
const lines = createInterface({ input: createReadStream(journalPath), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const event = JSON.parse(line);
  if (!Number.isInteger(event.sequence) || event.sequence !== lastSequence + 1) {
    throw new Error(`Historical journal sequence is not contiguous at ${event.sequence ?? "missing"}; expected ${lastSequence + 1}.`);
  }
  lastSequence = event.sequence;
  if (event.type === "run_initialized") initialEvent = event;
  lastType = event.type ?? null;
  if (event.type === "page_checkpoint") extracted.push(...(event.evidence ?? []));
  if (event.type === "target_completed") completedTargets.set(event.targetKey, event.receipt);
  if (event.type === "run_completed") completedSummary = event.summary ?? event;
}
const checkpointPath = resolve(dirname(journalPath), "checkpoint-current.json");
let checkpoint = null;
try {
  checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
} catch (error) {
  if (writeMode) throw new Error(`Cannot verify historical checkpoint ${checkpointPath}: ${error.message}`);
}
const expectedTargetKeys = new Set(initialEvent?.config?.targetKeys ?? []);
const expectedFingerprint = initialEvent?.configFingerprint ?? null;
const terminalKeysMatch = expectedTargetKeys.size > 0
  && completedTargets.size === expectedTargetKeys.size
  && [...expectedTargetKeys].every((key) => completedTargets.has(key));
const summaryCountsMatch = Boolean(
  completedSummary
  && completedSummary.targetPlatformPairs === expectedTargetKeys.size
  && completedSummary.completedTargetPlatformPairs === completedTargets.size
  && completedSummary.totals?.targets === completedTargets.size
);
const checkpointMatches = !checkpoint || (
  checkpoint.configFingerprint === expectedFingerprint
  && checkpoint.lastSequence === lastSequence
  && Object.keys(checkpoint.completed ?? {}).length === completedTargets.size
  && [...expectedTargetKeys].every((key) => Object.prototype.hasOwnProperty.call(checkpoint.completed ?? {}, key))
);
const complete = lastType === "run_completed"
  && completedSummary?.status === "completed"
  && terminalKeysMatch
  && summaryCountsMatch
  && checkpointMatches;
const summary = {
  status: complete ? (writeMode ? "written" : "dry_run") : "incomplete_resumable",
  journalPath,
  lastType,
  complete,
  extractedEvidence: extracted.length,
  journalLastSequence: lastSequence,
  expectedTargetPlatformPairs: expectedTargetKeys.size,
  terminalTargetPlatformPairs: completedTargets.size,
  terminalKeysMatch,
  summaryCountsMatch,
  checkpointMatches,
  baselineEvidence: canonicalArtifact.snapshot.evidence?.length ?? 0,
  observedAt
};
if (!complete) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (writeMode) process.exitCode = 2;
} else {
  const baselineEvidence = structuredClone(canonicalArtifact.snapshot.evidence ?? []);
  const merged = mergePublicEvidenceSnapshots(
    [canonicalArtifact.snapshot, {
      source: { label: "Historical journal candidate", fetchedAt: observedAt },
      evidence: extracted
    }],
    {
      fetchedAt: observedAt,
      durableStorageConfigured: false,
      resolveBatchSlug: buildLegacyPublicEvidenceBatchResolver(catalogs),
      resolveNativeAuthor: buildAutonomousPublicNativeAuthorResolver(catalogs),
      contentIdentityReferenceRows: baselineEvidence
    }
  );
  const mergedWithBaseline = preserveBaselineEvidence(merged, baselineEvidence);
  if ((mergedWithBaseline.evidence?.length ?? 0) < baselineEvidence.length) {
    throw new Error(`Refusing to merge: evidence would shrink from ${baselineEvidence.length} to ${mergedWithBaseline.evidence.length}.`);
  }
  Object.assign(summary, {
    mergedEvidence: mergedWithBaseline.evidence?.length ?? 0,
    addedEvidence: (mergedWithBaseline.evidence?.length ?? 0) - baselineEvidence.length,
    mergedNeedsReview: mergedWithBaseline.needsReview?.length ?? 0,
    mergedFailures: mergedWithBaseline.failures?.length ?? 0
  });
  if (writeMode) {
    const published = await writePublicEvidenceArtifactPairAtomic({
      rootDir: root,
      canonicalPath,
      snapshot: mergedWithBaseline,
      expectedCanonicalSha256: canonicalArtifact.canonicalSha256,
      expectedLedgerSha256: canonicalArtifact.ledgerSha256,
      expectedReviewLedgerSha256: canonicalArtifact.reviewLedgerSha256
    });
    summary.canonicalSha256 = published.canonicalSha256;
    summary.ledgerSha256 = published.ledgerSha256;
    summary.reviewLedgerSha256 = published.reviewLedgerSha256;
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function preserveBaselineEvidence(snapshot, baselineEvidence) {
  const baselineIds = new Set(baselineEvidence.map((row) => String(row?.id ?? "")));
  const additions = (snapshot.evidence ?? []).filter((row) => !baselineIds.has(String(row?.id ?? "")));
  return {
    ...snapshot,
    evidence: [...baselineEvidence, ...additions]
  };
}

function parseArgs(argv) {
  const result = { journal: null, canonical: null, observedAt: null, dryRun: false, write: false };
  for (const arg of argv) {
    if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--write") result.write = true;
    else if (arg.startsWith("--journal=")) result.journal = arg.slice("--journal=".length);
    else if (arg.startsWith("--canonical=")) result.canonical = arg.slice("--canonical=".length);
    else if (arg.startsWith("--observed-at=")) result.observedAt = arg.slice("--observed-at=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function required(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`--${name}=... is required.`);
  return text;
}
