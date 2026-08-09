#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

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
const campaignDir = resolve(root, required(args, "campaignDir", "campaign-dir"));
const canonicalPath = resolve(root, args.canonical ?? "src/lib/social/public-evidence-current.json");
const observedAt = args.observedAt ?? new Date().toISOString();
const writeMode = args.write === true;
if (writeMode === (args.dryRun === true)) {
  throw new Error("Pass exactly one of --dry-run or --write.");
}

const [canonicalArtifact, catalogs] = await Promise.all([
  readPublicEvidenceArtifact(canonicalPath, { rootDir: root }),
  loadAutonomousCatalogs(root)
]);
const entries = (await readdir(campaignDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /^checkpoint-public-.*\.json$/u.test(entry.name))
  .sort((left, right) => left.name.localeCompare(right.name));
if (entries.length === 0) throw new Error(`No public checkpoint files found in ${campaignDir}.`);

const candidates = await Promise.all(entries.map(async (entry) => {
  const payload = JSON.parse(await readFile(join(campaignDir, entry.name), "utf8"));
  return {
    ...payload,
    source: {
      label: `Checkpoint candidate ${entry.name}`,
      fetchedAt: observedAt,
      batchSlugs: [...new Set((payload.evidence ?? []).map((row) => row.batchSlug).filter(Boolean))]
    }
  };
}));
const resolveBatchSlug = buildLegacyPublicEvidenceBatchResolver(catalogs);
const resolveNativeAuthor = buildAutonomousPublicNativeAuthorResolver(catalogs);
const baselineEvidence = structuredClone(canonicalArtifact.snapshot.evidence ?? []);
const merged = mergePublicEvidenceSnapshots(
  [canonicalArtifact.snapshot, ...candidates],
  {
    fetchedAt: observedAt,
    durableStorageConfigured: false,
    resolveBatchSlug,
    resolveNativeAuthor,
    contentIdentityReferenceRows: baselineEvidence
  }
);

const mergedWithBaseline = preserveBaselineEvidence(merged, baselineEvidence);
if ((mergedWithBaseline.evidence ?? []).length < baselineEvidence.length) {
  throw new Error(
    `Refusing to merge: evidence would shrink from ${baselineEvidence.length} to ${mergedWithBaseline.evidence.length}.`
  );
}
const summary = {
  status: writeMode ? "written" : "dry_run",
  campaignDir,
  checkpointFiles: entries.map((entry) => entry.name),
  baselineEvidence: baselineEvidence.length,
  candidateEvidence: candidates.reduce((sum, snapshot) => sum + (snapshot.evidence?.length ?? 0), 0),
  mergedEvidence: mergedWithBaseline.evidence?.length ?? 0,
  addedEvidence: (mergedWithBaseline.evidence?.length ?? 0) - baselineEvidence.length,
  mergedNeedsReview: mergedWithBaseline.needsReview?.length ?? 0,
  mergedFailures: mergedWithBaseline.failures?.length ?? 0,
  mergedAttempts: Object.keys(mergedWithBaseline.attempts ?? {}).length,
  mergedDiscoveryAttempts: mergedWithBaseline.discoveryAttempts?.length ?? 0,
  mergedSourceDiscoveryPaths: mergedWithBaseline.sourceDiscoveryPaths?.length ?? 0,
  observedAt,
  nativeAuthorshipGate: true
};

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

function preserveBaselineEvidence(snapshot, baselineEvidence) {
  const baselineIds = new Set(baselineEvidence.map((row) => String(row?.id ?? "")));
  const additions = (snapshot.evidence ?? []).filter((row) => !baselineIds.has(String(row?.id ?? "")));
  return {
    ...snapshot,
    evidence: [...baselineEvidence, ...additions]
  };
}

function parseArgs(argv) {
  const result = { dryRun: false, write: false, canonical: null, campaignDir: null, observedAt: null };
  for (const arg of argv) {
    if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--write") result.write = true;
    else if (arg.startsWith("--campaign-dir=")) result.campaignDir = arg.slice("--campaign-dir=".length);
    else if (arg.startsWith("--canonical=")) result.canonical = arg.slice("--canonical=".length);
    else if (arg.startsWith("--observed-at=")) result.observedAt = arg.slice("--observed-at=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function required(args, key, flag = key) {
  const value = String(args[key] ?? "").trim();
  if (!value) throw new Error(`--${flag}=... is required.`);
  return value;
}
