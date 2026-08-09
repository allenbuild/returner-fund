#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAutonomousPublicNativeAuthorResolver,
  buildLegacyPublicEvidenceBatchResolver,
  loadAutonomousCatalogs,
  mergePublicEvidenceSnapshots
} from "./lib/autonomous-ingestion-plan.mjs";
import {
  canonicalInstagramPostUrl,
  instagramPostIdFromUrl
} from "./lib/logged-in-instagram-collection.mjs";
import {
  hydratePublicEvidenceArtifactWithLoader,
  writePublicEvidenceArtifactPairAtomic
} from "./lib/public-evidence-artifact.mjs";

const CANONICAL_RELATIVE_PATH = "src/lib/social/public-evidence-current.json";
const REFERENCE_RELATIVE_PATHS = Object.freeze([
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/a16z-speedrun-006-social-evidence.json"
]);
const SUPPORTED_BATCHES = new Set(["S26", "S2026", "A16ZSR006"]);
const SUPPORTED_PLATFORMS = new Set(["instagram"]);
const ABSOLUTE_MAX_ADDITIONS = 1_000;
const PROTECTED_LEDGER_KEYS = Object.freeze([
  "attributionReconciliationLedger",
  "failures",
  "attempts",
  "discoveryAttempts",
  "sourceDiscoveryPaths"
]);

export function parsePromotionArgs(rawArgs) {
  const parsed = { dryRun: false };
  const seen = new Set();

  for (const argument of rawArgs) {
    if (argument === "--dry-run") {
      if (seen.has("dry-run")) throw new Error("Duplicate --dry-run argument.");
      seen.add("dry-run");
      parsed.dryRun = true;
      continue;
    }
    const match = argument.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Expected --name=value or --dry-run; received ${argument}`);
    const [, name, rawValue] = match;
    if (!["candidate", "batch", "platform", "max-added"].includes(name)) {
      throw new Error(`Unknown promotion argument: --${name}`);
    }
    if (seen.has(name)) throw new Error(`Duplicate --${name} argument.`);
    seen.add(name);
    parsed[name === "max-added" ? "maxAdded" : name] = rawValue.trim();
  }

  const candidate = requiredText(parsed.candidate, "--candidate");
  const batch = requiredText(parsed.batch, "--batch").toUpperCase();
  const platform = requiredText(parsed.platform, "--platform").toLowerCase();
  if (!SUPPORTED_BATCHES.has(batch)) {
    throw new Error(`--batch must be one of ${[...SUPPORTED_BATCHES].join(", ")}.`);
  }
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error("--platform currently supports only instagram.");
  }
  if (!/^\d+$/.test(String(parsed.maxAdded ?? ""))) {
    throw new Error("--max-added must be a non-negative integer.");
  }
  const maxAdded = Number(parsed.maxAdded);
  if (!Number.isSafeInteger(maxAdded) || maxAdded > ABSOLUTE_MAX_ADDITIONS) {
    throw new Error(`--max-added must not exceed ${ABSOLUTE_MAX_ADDITIONS}.`);
  }

  return { candidate, batch, platform, maxAdded, dryRun: parsed.dryRun };
}

export function planPublicEvidenceBatchPromotion({
  canonical,
  merged,
  batch,
  platform,
  maxAdded
}) {
  if (!SUPPORTED_BATCHES.has(batch) || !SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`Unsupported promotion scope ${batch ?? "missing"}/${platform ?? "missing"}.`);
  }
  if (
    !Number.isSafeInteger(maxAdded) ||
    maxAdded < 0 ||
    maxAdded > ABSOLUTE_MAX_ADDITIONS
  ) {
    throw new Error(`Promotion maxAdded must be between 0 and ${ABSOLUTE_MAX_ADDITIONS}.`);
  }
  const canonicalEvidence = rows(canonical?.evidence, "canonical evidence");
  const canonicalReviews = rows(canonical?.needsReview, "canonical review");
  const mergedEvidence = rows(merged?.evidence, "merged evidence");
  const mergedReviews = rows(merged?.needsReview, "merged review");
  const canonicalEvidenceById = indexRowsById(canonicalEvidence, "canonical evidence");
  // Legacy canonical review ledgers can contain the same review id more than
  // once for distinct historical observations. They are append-only context,
  // not scoring evidence: preserve every existing row and its byte-order.
  const canonicalReviewIds = collectRowIds(canonicalReviews, "canonical review");
  const mergedEvidenceById = indexRowsById(mergedEvidence, "merged evidence");

  const removedEvidence = canonicalEvidence.filter((row) => !mergedEvidenceById.has(row.id));
  if (removedEvidence.length > 0) {
    throw new Error(
      `Promotion would remove ${removedEvidence.length} canonical evidence row(s): ` +
      removedEvidence.slice(0, 5).map((row) => row.id).join(", ")
    );
  }

  const addedEvidence = mergedEvidence.filter((row) => !canonicalEvidenceById.has(row.id));
  if (addedEvidence.length > maxAdded) {
    throw new Error(
      `Promotion would add ${addedEvidence.length} evidence row(s), above --max-added=${maxAdded}.`
    );
  }

  // A candidate that contributes no scoring evidence is intentionally a true
  // no-op. Quarantines or contextual reviews alone never rewrite canonical.
  if (addedEvidence.length === 0) {
    return {
      status: "no_op",
      promoted: canonical,
      addedEvidence: [],
      addedReviews: [],
      removedEvidence: []
    };
  }

  for (const row of addedEvidence) {
    assertPromotableEvidenceRow(row, { batch, platform });
  }

  const addedReviews = stableNewRowsById(
    mergedReviews,
    canonicalReviewIds,
    "merged review"
  );
  if (addedReviews.length > maxAdded) {
    throw new Error(
      `Promotion would add ${addedReviews.length} review row(s), above --max-added=${maxAdded}.`
    );
  }
  for (const row of addedReviews) {
    assertPromotableReviewRow(row, { batch, platform });
  }

  const promotedEvidence = [...canonicalEvidence, ...addedEvidence];
  const promotedReviews = [...canonicalReviews, ...addedReviews];
  const promoted = {
    ...canonical,
    source: updateCanonicalSource(canonical, merged, {
      evidence: promotedEvidence,
      needsReview: promotedReviews,
      addedReviews
    }),
    evidence: promotedEvidence,
    needsReview: promotedReviews
  };
  assertProtectedLedgersUnchanged(canonical, promoted);

  return {
    status: "planned",
    promoted,
    addedEvidence,
    addedReviews,
    removedEvidence: []
  };
}

export async function promotePublicEvidenceBatch(
  rawArgs = process.argv.slice(2),
  dependencies = {}
) {
  const args = parsePromotionArgs(rawArgs);
  const rootDir = path.resolve(dependencies.rootDir ?? process.cwd());
  const canonicalPath = path.resolve(
    dependencies.canonicalPath ?? path.join(rootDir, CANONICAL_RELATIVE_PATH)
  );
  const candidatePath = path.resolve(rootDir, args.candidate);
  if (candidatePath === canonicalPath) {
    throw new Error("--candidate must not be the canonical public evidence file.");
  }

  const readFileImpl = dependencies.readFileImpl ?? readFile;
  const writeFileImpl = dependencies.writeFileImpl ?? writeFile;
  const renameImpl = dependencies.renameImpl ?? rename;
  const removeImpl = dependencies.removeImpl ?? rm;
  const statImpl = dependencies.statImpl ?? stat;
  const mergeSnapshots = dependencies.mergeSnapshots ?? mergePublicEvidenceSnapshots;
  const loadCatalogs = dependencies.loadCatalogs ?? loadAutonomousCatalogs;
  const buildBatchResolver = dependencies.buildBatchResolver ?? buildLegacyPublicEvidenceBatchResolver;
  const buildNativeAuthorResolver = dependencies.buildNativeAuthorResolver ?? buildAutonomousPublicNativeAuthorResolver;
  const referencePaths = dependencies.referencePaths ?? REFERENCE_RELATIVE_PATHS.map(
    (relativePath) => path.join(rootDir, relativePath)
  );
  const stdout = dependencies.stdout ?? process.stdout;

  const canonicalBytes = await readFileImpl(canonicalPath);
  const canonicalHash = sha256(canonicalBytes);
  const [candidateBytes, catalogs, ...referenceBytes] = await Promise.all([
    readFileImpl(candidatePath),
    loadCatalogs(rootDir),
    ...referencePaths.map((referencePath) => readFileImpl(referencePath))
  ]);
  const canonicalDocument = parseJson(canonicalBytes, canonicalPath);
  let canonicalOperationalLedgerBytes = null;
  let canonicalReviewLedgerBytes = null;
  const canonical = await hydratePublicEvidenceArtifactWithLoader(
    canonicalDocument,
    {
      loadLedger: async (relativePath) => {
        const bytes = await readFileImpl(path.resolve(rootDir, relativePath));
        if (canonicalDocument.reviewLedgerRef?.path === relativePath) {
          canonicalReviewLedgerBytes = bytes;
        } else {
          canonicalOperationalLedgerBytes = bytes;
        }
        return bytes;
      }
    }
  );
  const candidate = parseJson(candidateBytes, candidatePath);
  const references = referenceBytes.map((bytes, index) =>
    parseJson(bytes, referencePaths[index])
  );
  const merged = mergeSnapshots([canonical, candidate], {
    fetchedAt: candidate?.source?.fetchedAt ?? new Date().toISOString(),
    durableStorageConfigured: false,
    resolveBatchSlug: buildBatchResolver(catalogs),
    resolveNativeAuthor: buildNativeAuthorResolver(catalogs),
    contentIdentityReferenceRows: references.flatMap((snapshot) => snapshot.evidence ?? [])
  });
  const plan = planPublicEvidenceBatchPromotion({
    canonical,
    merged,
    batch: args.batch,
    platform: args.platform,
    maxAdded: args.maxAdded
  });

  await assertCanonicalHash(canonicalPath, canonicalHash, readFileImpl);
  const baseReceipt = {
    canonicalPath,
    candidatePath,
    batch: args.batch,
    platform: args.platform,
    maxAdded: args.maxAdded,
    addedEvidence: plan.addedEvidence.length,
    addedReviews: plan.addedReviews.length,
    removedEvidence: plan.removedEvidence.length,
    canonicalHashBefore: canonicalHash,
    operationalLedgerHashBefore: canonicalOperationalLedgerBytes
      ? sha256(canonicalOperationalLedgerBytes)
      : null,
    reviewLedgerHashBefore: canonicalReviewLedgerBytes
      ? sha256(canonicalReviewLedgerBytes)
      : null
  };

  if (plan.status === "no_op") {
    return writeReceipt(stdout, {
      status: "no_op",
      ...baseReceipt,
      canonicalHashAfter: canonicalHash
    });
  }
  if (args.dryRun) {
    return writeReceipt(stdout, {
      status: "dry_run",
      ...baseReceipt,
      canonicalHashAfter: canonicalHash
    });
  }

  const published = await writePublicEvidenceArtifactPairAtomic({
    rootDir,
    canonicalPath,
    snapshot: plan.promoted,
    expectedCanonicalSha256: canonicalHash,
    expectedLedgerSha256: canonicalOperationalLedgerBytes
      ? sha256(canonicalOperationalLedgerBytes)
      : null,
    expectedReviewLedgerSha256: canonicalReviewLedgerBytes
      ? sha256(canonicalReviewLedgerBytes)
      : null,
    readFileImpl,
    writeFileImpl,
    renameImpl,
    removeImpl,
    statImpl
  });

  return writeReceipt(stdout, {
    status: "promoted",
    ...baseReceipt,
    canonicalHashAfter: sha256(await readFileImpl(canonicalPath)),
    operationalLedgerHashAfter: published.ledgerSha256,
    reviewLedgerHashAfter: published.reviewLedgerSha256
  });
}

function assertPromotableEvidenceRow(row, { batch, platform }) {
  const rowBatch = String(row?.batchSlug ?? row?.batch_slug ?? "").trim();
  const rowPlatform = String(row?.platform ?? "").trim();
  if (rowBatch !== batch) {
    throw new Error(`Added evidence ${row.id} has batch ${rowBatch || "missing"}; expected ${batch}.`);
  }
  if (rowPlatform !== platform) {
    throw new Error(`Added evidence ${row.id} has platform ${rowPlatform || "missing"}; expected ${platform}.`);
  }
  if (!isExactNativeInstagramPost(row)) {
    throw new Error(`Added evidence ${row.id} is not an exact native Instagram post URL.`);
  }
  const score = Number(row?.contributionScore);
  if (!Number.isFinite(score) || score <= 0) {
    throw new Error(`Added evidence ${row.id} must have a positive contributionScore.`);
  }
  const nativeOwner = row?.nativeAuthorResolution?.owner;
  const sameCanonicalCompany =
    String(nativeOwner?.batchSlug ?? "").trim() === batch &&
    String(nativeOwner?.companySlug ?? "") === String(row?.companySlug ?? "");
  const exactAccountOwner =
    nativeOwner?.entityType === (row?.entityType ?? "company") &&
    nativeOwner?.entityId === row?.entityId;
  if (
    row?.review_state !== "verified" ||
    row?.attributionStatus !== "verified" ||
    row?.nativeAuthorResolution?.status !== "matched" ||
    !sameCanonicalCompany ||
    (row?.attributionMode === "account_owner" && !exactAccountOwner) ||
    !Array.isArray(row?.attributionSignals) ||
    row.attributionSignals.length === 0
  ) {
    throw new Error(`Added evidence ${row.id} does not have fully verified canonical attribution.`);
  }
}

function assertPromotableReviewRow(row, { batch, platform }) {
  const rowBatch = String(row?.batchSlug ?? row?.batch_slug ?? "").trim();
  const rowPlatform = String(row?.platform ?? "").trim();
  if (rowBatch !== batch || rowPlatform !== platform) {
    throw new Error(
      `Added review ${row.id} must be scoped to ${batch}/${platform}; received ` +
      `${rowBatch || "missing"}/${rowPlatform || "missing"}.`
    );
  }
  if (!["needs_review", "rejected"].includes(row?.review_state)) {
    throw new Error(`Added review ${row.id} has invalid review_state ${row?.review_state ?? "missing"}.`);
  }
}

function isExactNativeInstagramPost(row) {
  const sourceUrl = String(row?.sourceUrl ?? "");
  if (!canonicalInstagramPostUrl(sourceUrl)) return false;
  try {
    const parsed = new URL(sourceUrl);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const pathName = parsed.pathname.replace(/\/+$/, "");
    if (
      parsed.protocol !== "https:" ||
      host !== "instagram.com" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !/^\/(?:p|reel|tv)\/[A-Za-z0-9_-]+$/i.test(pathName)
    ) return false;
    const postId = instagramPostIdFromUrl(sourceUrl);
    return Boolean(postId) && String(row?.platformPostId ?? "") === postId;
  } catch {
    return false;
  }
}

function updateCanonicalSource(canonical, merged, { evidence, needsReview, addedReviews }) {
  const canonicalSource = canonical?.source ?? {};
  const addedQuarantines = addedReviews.filter(
    (row) => Array.isArray(row?.quarantineReasons) && row.quarantineReasons.length > 0
  ).length;
  const addedContentDuplicates = addedReviews.filter(
    (row) => row?.quarantineReasons?.includes("same_platform_author_substantive_body")
  ).length;
  const addedPhysicalDuplicates = addedReviews.filter(
    (row) => row?.quarantineReasons?.includes("same_rollup_physical_post_identity")
  ).length;
  return {
    ...canonicalSource,
    fetchedAt: merged?.source?.fetchedAt ?? canonicalSource.fetchedAt,
    evidenceCount: evidence.length,
    needsReviewCount: needsReview.length,
    quarantinedEvidenceCount: Number(canonicalSource.quarantinedEvidenceCount ?? 0) + addedQuarantines,
    duplicateContentEvidenceCount:
      Number(canonicalSource.duplicateContentEvidenceCount ?? 0) + addedContentDuplicates,
    duplicatePhysicalEvidenceCount:
      Number(canonicalSource.duplicatePhysicalEvidenceCount ?? 0) + addedPhysicalDuplicates,
    attributionReconciliationCount: rows(
      canonical?.attributionReconciliationLedger,
      "canonical attribution reconciliation"
    ).length,
    failureCount: rows(canonical?.failures, "canonical failure").length,
    discoveryAttemptCount: rows(canonical?.discoveryAttempts, "canonical discovery attempt").length,
    sourceDiscoveryPathCount: rows(
      canonical?.sourceDiscoveryPaths,
      "canonical source discovery path"
    ).length,
    attemptCount: objectEntries(canonical?.attempts, "canonical attempts").length
  };
}

function assertProtectedLedgersUnchanged(canonical, promoted) {
  for (const key of PROTECTED_LEDGER_KEYS) {
    if (JSON.stringify(canonical?.[key]) !== JSON.stringify(promoted?.[key])) {
      throw new Error(`Promotion unexpectedly changed canonical ${key}.`);
    }
  }
}

function rows(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function objectEntries(value, label) {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return Object.entries(value);
}

function indexRowsById(items, label) {
  const index = new Map();
  for (const row of items) {
    const id = requiredText(row?.id, `${label} row id`);
    if (index.has(id)) throw new Error(`${label} contains duplicate id ${id}.`);
    index.set(id, row);
  }
  return index;
}

function collectRowIds(items, label) {
  const ids = new Set();
  for (const row of items) ids.add(requiredText(row?.id, `${label} row id`));
  return ids;
}

function stableNewRowsById(items, existingIds, label) {
  const added = [];
  const seen = new Set(existingIds);
  for (const row of items) {
    const id = requiredText(row?.id, `${label} row id`);
    if (seen.has(id)) continue;
    seen.add(id);
    added.push(row);
  }
  return added;
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function parseJson(bytes, sourcePath) {
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes));
  } catch (error) {
    throw new Error(`Invalid JSON in ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertCanonicalHash(canonicalPath, expectedHash, readFileImpl) {
  if (sha256(await readFileImpl(canonicalPath)) !== expectedHash) {
    throw new Error("Canonical evidence changed during promotion; refusing to overwrite concurrent work.");
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeReceipt(stdout, receipt) {
  stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  promotePublicEvidenceBatch().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
