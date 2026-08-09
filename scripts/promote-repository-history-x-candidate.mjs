#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
import {
  auditRepositoryHistoryXCandidate,
  isVerifiedRepositoryHistoryXMetriclessEvidence,
  repositoryHistoryXTrustFailures
} from "./lib/repository-history-public-evidence-candidate.mjs";

const CANONICAL_RELATIVE_PATH = "src/lib/social/public-evidence-current.json";
const CURRENT_REFERENCE_PATHS = Object.freeze([
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/volume-evidence-current.json",
  "src/lib/social/a16z-speedrun-006-social-evidence.json",
  "src/lib/social/eden-robotics-verified-native-evidence.json"
]);
const PROTECTED_LEDGER_KEYS = Object.freeze([
  "attributionReconciliationLedger",
  "failures",
  "attempts",
  "discoveryAttempts",
  "sourceDiscoveryPaths"
]);

export function parseRepositoryHistoryPromotionArgs(rawArgs) {
  const parsed = { dryRun: false, write: false };
  const supported = new Set([
    "candidate",
    "receipt",
    "expected-total",
    "expected-s2026",
    "expected-s26"
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
  const candidate = required(parsed.candidate, "candidate");
  const expectedTotal = requiredInteger(parsed.expectedTotal, "expected-total", { min: 1 });
  const expectedS2026 = requiredInteger(parsed.expectedS2026, "expected-s2026", { min: 0 });
  const expectedS26 = requiredInteger(parsed.expectedS26, "expected-s26", { min: 0 });
  if (expectedS2026 + expectedS26 !== expectedTotal) {
    throw new Error("Expected cohort counts must sum to --expected-total.");
  }
  return {
    candidate,
    receipt: clean(parsed.receipt),
    expectedTotal,
    expectedByBatch: { S2026: expectedS2026, S26: expectedS26 },
    dryRun: parsed.dryRun,
    write: parsed.write
  };
}

export function planRepositoryHistoryXPromotion({
  canonical,
  candidate,
  merged,
  candidateGate,
  audit,
  expectedTotal,
  expectedByBatch
}) {
  const baselineEvidence = rows(canonical?.evidence, "canonical evidence");
  const baselineReviews = rows(canonical?.needsReview, "canonical review");
  const candidateEvidence = rows(candidate?.evidence, "candidate evidence");
  const canonicalIds = new Set(baselineEvidence.map((row) => required(row?.id, "canonical evidence id")));
  const candidateIds = new Set(candidateEvidence.map((row) => required(row?.id, "candidate evidence id")));
  const mergedEvidence = rows(merged?.evidence, "merged evidence");
  const additions = mergedEvidence.filter((row) => !canonicalIds.has(String(row?.id ?? "")));
  const addedIds = new Set(additions.map((row) => String(row?.id ?? "")));
  const missingCandidateIds = [...candidateIds].filter((id) => !addedIds.has(id));
  const unrelatedAdditionIds = [...addedIds].filter((id) => !candidateIds.has(id));
  const addedByBatch = countBy(additions, (row) => String(row?.batchSlug ?? "missing"));
  const candidateReviewIds = new Set(
    rows(candidateGate?.needsReview, "candidate-gate review")
      .map((row) => row?.sourceEvidenceId ?? row?.id)
      .filter(Boolean)
  );
  const trustFailures = additions.flatMap((row) => {
    const failures = repositoryHistoryXTrustFailures(row);
    return failures.length > 0 ? [{ id: row?.id ?? null, failures }] : [];
  });
  const allExpected = additions.length === expectedTotal &&
    missingCandidateIds.length === 0 &&
    unrelatedAdditionIds.length === 0 &&
    Object.entries(expectedByBatch).every(
      ([batch, count]) => Number(addedByBatch[batch] ?? 0) === Number(count)
    );
  if (
    audit?.duplicatePhysical !== 0 ||
    audit?.currentPhysicalCollisions !== 0 ||
    audit?.duplicateContent !== 0 ||
    audit?.duplicateIds !== 0 ||
    audit?.currentIdCollisions !== 0 ||
    audit?.trustFailures !== 0
  ) {
    throw new Error("Candidate audit did not prove zero duplicates and complete trust receipts.");
  }
  if ((candidateGate?.evidence?.length ?? 0) !== expectedTotal || candidateReviewIds.size !== 0) {
    throw new Error(
      `Candidate-only canonical gate accepted ${candidateGate?.evidence?.length ?? 0}/${expectedTotal} rows ` +
      `and produced ${candidateReviewIds.size} review rows.`
    );
  }
  if (
    Number(candidateGate?.source?.duplicateContentEvidenceCount ?? 0) !== 0 ||
    Number(candidateGate?.source?.duplicatePhysicalEvidenceCount ?? 0) !== 0
  ) {
    throw new Error("Existing merge gate found a physical or content duplicate in the candidate.");
  }
  if (!allExpected) {
    throw new Error(
      `Promotion did not produce exact expected additions: ${JSON.stringify({
        additions: additions.length,
        addedByBatch,
        missingCandidateIds,
        unrelatedAdditionIds
      })}`
    );
  }
  if (trustFailures.length > 0) {
    throw new Error(`Merged additions lost repository-history trust receipts: ${JSON.stringify(trustFailures)}.`);
  }

  const promoted = {
    ...canonical,
    source: {
      ...(canonical?.source ?? {}),
      fetchedAt: candidate?.source?.fetchedAt ?? canonical?.source?.fetchedAt,
      evidenceCount: baselineEvidence.length + additions.length,
      needsReviewCount: baselineReviews.length
    },
    evidence: [...baselineEvidence, ...additions],
    needsReview: baselineReviews
  };
  for (const key of PROTECTED_LEDGER_KEYS) {
    if (JSON.stringify(promoted?.[key]) !== JSON.stringify(canonical?.[key])) {
      throw new Error(`Promotion unexpectedly changed canonical ${key}.`);
    }
  }
  return {
    promoted,
    additions,
    addedByBatch,
    missingCandidateIds,
    unrelatedAdditionIds,
    candidateReviewCount: candidateReviewIds.size
  };
}

export async function promoteRepositoryHistoryXCandidate(
  rawArgs = process.argv.slice(2),
  dependencies = {}
) {
  const args = parseRepositoryHistoryPromotionArgs(rawArgs);
  const rootDir = path.resolve(dependencies.rootDir ?? process.cwd());
  const canonicalPath = path.resolve(
    dependencies.canonicalPath ?? path.join(rootDir, CANONICAL_RELATIVE_PATH)
  );
  const candidatePath = path.resolve(rootDir, args.candidate);
  const receiptPath = args.receipt ? path.resolve(rootDir, args.receipt) : null;
  if (candidatePath === canonicalPath) throw new Error("--candidate must not be canonical evidence.");

  const readFileImpl = dependencies.readFileImpl ?? readFile;
  const [canonicalArtifact, candidateBytes, catalogs, ...referenceBytes] = await Promise.all([
    readPublicEvidenceArtifact(canonicalPath, { rootDir }),
    readFileImpl(candidatePath),
    loadAutonomousCatalogs(rootDir),
    ...CURRENT_REFERENCE_PATHS.map((relativePath) => readFileImpl(path.join(rootDir, relativePath)))
  ]);
  const candidate = parseJson(candidateBytes, candidatePath);
  const references = referenceBytes.map((bytes, index) =>
    parseJson(bytes, path.join(rootDir, CURRENT_REFERENCE_PATHS[index]))
  );
  const currentSnapshots = [canonicalArtifact.snapshot, ...references];
  const audit = auditRepositoryHistoryXCandidate(candidate, {
    currentSnapshots,
    expectedTotal: args.expectedTotal,
    expectedByBatch: args.expectedByBatch
  });
  const resolveBatchSlug = buildLegacyPublicEvidenceBatchResolver(catalogs);
  const resolveNativeAuthor = buildAutonomousPublicNativeAuthorResolver(catalogs);
  const currentReferenceRows = currentSnapshots.flatMap((snapshot) => snapshot?.evidence ?? []);
  const mergeOptions = {
    fetchedAt: candidate?.source?.fetchedAt,
    durableStorageConfigured: false,
    resolveBatchSlug,
    resolveNativeAuthor,
    contentIdentityReferenceRows: currentReferenceRows,
    allowVerifiedMetriclessEvidence: isVerifiedRepositoryHistoryXMetriclessEvidence
  };
  const candidateGate = mergePublicEvidenceSnapshots([candidate], mergeOptions);
  const merged = mergePublicEvidenceSnapshots([canonicalArtifact.snapshot, candidate], mergeOptions);
  const plan = planRepositoryHistoryXPromotion({
    canonical: canonicalArtifact.snapshot,
    candidate,
    merged,
    candidateGate,
    audit,
    expectedTotal: args.expectedTotal,
    expectedByBatch: args.expectedByBatch
  });

  const canonicalHashBefore = canonicalArtifact.canonicalSha256;
  const currentCanonicalHash = sha256(await readFileImpl(canonicalPath));
  if (currentCanonicalHash !== canonicalHashBefore) {
    throw new Error("Canonical evidence changed during promotion planning.");
  }
  const receipt = {
    schemaVersion: 1,
    status: args.dryRun ? "dry_run" : "promoted",
    canonicalPath,
    candidatePath,
    candidateSha256: sha256(candidateBytes),
    baselineEvidence: canonicalArtifact.snapshot.evidence?.length ?? 0,
    candidateEvidence: candidate.evidence?.length ?? 0,
    addedEvidence: plan.additions.length,
    addedByBatch: plan.addedByBatch,
    addedReviews: plan.candidateReviewCount,
    removedEvidence: 0,
    duplicatePhysical: audit.duplicatePhysical + audit.currentPhysicalCollisions,
    duplicateContent: audit.duplicateContent,
    duplicateIds: audit.duplicateIds + audit.currentIdCollisions,
    zeroEngagementEvidence: audit.zeroEngagementEvidence,
    positiveEngagementEvidence: audit.positiveEngagementEvidence,
    candidateGateEvidence: candidateGate.evidence?.length ?? 0,
    candidateGateNeedsReview: candidateGate.needsReview?.length ?? 0,
    candidateGateDuplicatePhysical: candidateGate.source?.duplicatePhysicalEvidenceCount ?? 0,
    candidateGateDuplicateContent: candidateGate.source?.duplicateContentEvidenceCount ?? 0,
    canonicalHashBefore,
    canonicalHashAfter: canonicalHashBefore,
    operationalLedgerHashBefore: canonicalArtifact.ledgerSha256,
    operationalLedgerHashAfter: canonicalArtifact.ledgerSha256,
    audit
  };

  if (args.write) {
    const published = await writePublicEvidenceArtifactPairAtomic({
      rootDir,
      canonicalPath,
      snapshot: plan.promoted,
      expectedCanonicalSha256: canonicalArtifact.canonicalSha256,
      expectedLedgerSha256: canonicalArtifact.ledgerSha256
    });
    receipt.canonicalHashAfter = published.canonicalSha256;
    receipt.operationalLedgerHashAfter = published.ledgerSha256;
  }
  if (receiptPath) await atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  (dependencies.stdout ?? process.stdout).write(`${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function rows(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function countBy(items, keyFor) {
  const counts = {};
  for (const item of items) {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
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

function requiredInteger(value, name, { min }) {
  if (!/^\d+$/.test(String(value ?? ""))) throw new Error(`--${name}=... is required.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min) throw new Error(`--${name} must be at least ${min}.`);
  return number;
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

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  promoteRepositoryHistoryXCandidate().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
