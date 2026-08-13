import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { basename, dirname, join, resolve } from "node:path";

import { loadAutonomousCatalogs } from "./autonomous-ingestion-plan.mjs";
import { normalizeAutonomousIngestionCatalogs } from "./ingestion-coverage-adapter.mjs";
import {
  INGESTION_CORE_PLATFORMS,
  INGESTION_EXTENDED_ONLY_PLATFORMS
} from "./ingestion-coverage-receipt.mjs";

export const STORED_UNPUBLISHED_COVERAGE_BRIDGE_VERSION =
  "stored-unpublished-coverage-bridge.v1";
export const STORED_UNPUBLISHED_EXPECTED_PAIR_COUNT = 16_705;
export const STORED_UNPUBLISHED_MAX_INPUT_BYTES = 512 * 1024 * 1024;

const HISTORICAL_STAGING_VERSION = "historical-publication-staging.v1";
const HISTORICAL_PLATFORMS = new Set(["hacker_news", "rss", "web"]);
const GITHUB_EVIDENCE_CATEGORIES = new Set([
  "github_exhaustive_content_stored_unpublished",
  "github_exhaustive_repository_stored_or_shared_review"
]);
const GITHUB_BLOCKER_CATEGORY = "github_exhaustive_target_terminal_blocker";
const ALL_PLATFORMS = Object.freeze([
  ...INGESTION_CORE_PLATFORMS,
  ...INGESTION_EXTENDED_ONLY_PLATFORMS
]);
const SHA256 = /^[a-f0-9]{64}$/;
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Surface the exact contents of two immutable stored-but-unpublished ledgers
 * into one receipt for every canonical entity/platform pair. This function
 * never reads or writes a scoring-visible evidence artifact.
 */
export async function buildStoredUnpublishedCoverageBridge({
  root = process.cwd(),
  historicalManifestPath,
  githubReceiptPath,
  outputDir = null,
  generatedAt,
  dryRun = false,
  expectedPairCount = STORED_UNPUBLISHED_EXPECTED_PAIR_COUNT,
  maxInputBytes = STORED_UNPUBLISHED_MAX_INPUT_BYTES,
  catalogs: suppliedCatalogs = null
} = {}) {
  const normalizedGeneratedAt = canonicalTimestamp(generatedAt, "generatedAt");
  positiveInteger(expectedPairCount, "expectedPairCount");
  positiveInteger(maxInputBytes, "maxInputBytes");
  const rootPath = await realpath(resolve(root));
  const historicalManifestRealPath = await realpath(resolveFromRoot(
    rootPath,
    requiredText(historicalManifestPath, "historicalManifestPath")
  ));
  const githubReceiptRealPath = await realpath(resolveFromRoot(
    rootPath,
    requiredText(githubReceiptPath, "githubReceiptPath")
  ));
  const outputPath = outputDir ? resolveFromRoot(rootPath, outputDir) : null;
  if (!dryRun && !outputPath) throw new Error("outputDir is required unless dryRun=true.");
  if (outputPath) await assertPathDoesNotExist(outputPath, "outputDir");

  const loadedCatalogs = suppliedCatalogs ?? await loadAutonomousCatalogs(rootPath);
  const catalogs = normalizeAutonomousIngestionCatalogs(loadedCatalogs);
  const matrix = buildCanonicalPairMatrix(catalogs);
  if (matrix.pairs.size !== expectedPairCount) {
    throw new Error(
      `Canonical pair denominator is ${matrix.pairs.size}; expected exact ${expectedPairCount}.`
    );
  }

  const historicalManifestFile = await readBoundedJson(
    historicalManifestRealPath,
    maxInputBytes,
    "historical staging manifest"
  );
  const historicalManifest = validateHistoricalManifest(
    historicalManifestFile.value,
    normalizedGeneratedAt
  );
  const historicalLedgerPath = await resolveDeclaredSibling(
    historicalManifestRealPath,
    historicalManifest.artifacts.storedUnpublished.path,
    "historical stored-unpublished ledger"
  );

  const githubReceiptFile = await readBoundedJson(
    githubReceiptRealPath,
    maxInputBytes,
    "GitHub exhaustive staging receipt"
  );
  const githubReceipt = validateGithubReceipt(
    githubReceiptFile.value,
    normalizedGeneratedAt,
    matrix.inventory
  );
  const githubLedgerPath = await resolveDeclaredSibling(
    githubReceiptRealPath,
    githubReceipt.outputs.storedEvidenceReview.filename,
    "GitHub stored-evidence review ledger"
  );

  const pairCounts = new Map(
    [...matrix.pairs].map(([pairKey, identity]) => [pairKey, {
      ...identity,
      historicalEvidenceRows: 0,
      githubEvidenceAttributions: 0,
      githubBlockerReviews: 0
    }])
  );
  const historicalAudit = await auditHistoricalLedger({
    path: historicalLedgerPath,
    descriptor: historicalManifest.artifacts.storedUnpublished,
    pairCounts,
    maxInputBytes
  });
  const githubAudit = await auditGithubLedger({
    path: githubLedgerPath,
    descriptor: githubReceipt.outputs.storedEvidenceReview,
    pairCounts,
    maxInputBytes
  });

  const sourceProof = {
    schemaVersion: STORED_UNPUBLISHED_COVERAGE_BRIDGE_VERSION,
    generatedAt: normalizedGeneratedAt,
    catalogs: matrix.catalogProof,
    historical: {
      manifestPath: historicalManifestRealPath,
      manifestSha256: sha256(historicalManifestFile.bytes),
      ledgerPath: historicalLedgerPath,
      ledgerSha256: historicalAudit.sha256,
      ledgerRows: historicalAudit.rows,
      stagedAt: historicalManifest.stagedAt
    },
    github: {
      receiptPath: githubReceiptRealPath,
      receiptFileSha256: sha256(githubReceiptFile.bytes),
      receiptCoreSha256: githubReceipt.receiptSha256,
      ledgerPath: githubLedgerPath,
      ledgerSha256: githubAudit.sha256,
      ledgerRows: githubAudit.rows,
      stagedAt: githubReceipt.generatedAt
    }
  };
  const sourceProofSha256 = sha256(stableJson(sourceProof));
  const pairScopes = [...pairCounts.values()]
    .sort((left, right) => left.pairKey.localeCompare(right.pairKey))
    .map((pair) => buildPairScope(pair, {
      generatedAt: normalizedGeneratedAt,
      sourceProofSha256
    }));

  if (pairScopes.length !== expectedPairCount ||
      new Set(pairScopes.map((row) => row.pairKey)).size !== expectedPairCount) {
    throw new Error("Stored-unpublished bridge did not emit one unique row per canonical pair.");
  }

  const summaries = summarizePairScopes(pairScopes, matrix.inventory);
  const manifestCore = {
    schemaVersion: STORED_UNPUBLISHED_COVERAGE_BRIDGE_VERSION,
    status: dryRun ? "dry_run" : "staged",
    productionEligible: false,
    scoringEligible: false,
    publicationAction: "none",
    generatedAt: normalizedGeneratedAt,
    sourceProofSha256,
    sources: sourceProof,
    denominator: {
      canonicalPairs: pairScopes.length,
      canonicalOwners: matrix.inventory.owners,
      companies: matrix.inventory.companies,
      founders: matrix.inventory.founders,
      platforms: ALL_PLATFORMS.length
    },
    counts: {
      historicalLedgerRows: historicalAudit.rows,
      githubLedgerRows: githubAudit.rows,
      historicalEvidenceAttributions: summaries.historicalEvidenceRows,
      githubEvidenceAttributions: summaries.githubEvidenceAttributions,
      githubBlockerReviews: summaries.githubBlockerReviews,
      totalEvidenceAttributions:
        summaries.historicalEvidenceRows + summaries.githubEvidenceAttributions,
      totalSurfacedAttributions:
        summaries.historicalEvidenceRows +
        summaries.githubEvidenceAttributions +
        summaries.githubBlockerReviews,
      explicitZeroPairs: summaries.explicitZeroPairs,
      nonzeroPairs: pairScopes.length - summaries.explicitZeroPairs
    },
    byPlatform: summaries.byPlatform,
    byBatch: summaries.byBatch,
    invariants: {
      bothLedgersFullyTraversed: true,
      everyCanonicalPairHasReceipt: true,
      zeroMeansBothNamedLedgersChecked: true,
      rawEvidenceCopied: false,
      scoredRowsEmitted: 0,
      publishedRowsEmitted: 0
    }
  };

  if (dryRun) return manifestCore;
  return writeBridgePackage({ outputPath, pairScopes, manifestCore });
}

function buildCanonicalPairMatrix(catalogs) {
  const pairs = new Map();
  let companies = 0;
  let founders = 0;
  for (const catalog of catalogs) {
    for (const company of catalog.companies) {
      companies += 1;
      addOwner(company.id, "company", company.name, catalog.batchSlug);
      for (const founder of company.founders) {
        founders += 1;
        addOwner(founder.id, "founder", founder.name, catalog.batchSlug);
      }
    }
  }
  function addOwner(entityId, entityType, entityName, batchSlug) {
    for (const platform of ALL_PLATFORMS) {
      const pairKey = coveragePairKey({ batchSlug, entityType, entityId, platform });
      if (pairs.has(pairKey)) throw new Error(`Duplicate canonical pair ${pairKey}.`);
      pairs.set(pairKey, { pairKey, batchSlug, entityType, entityId, entityName, platform });
    }
  }
  const catalogProof = catalogs.map((catalog) => ({
    batchSlug: catalog.batchSlug,
    sourcePath: catalog.sourcePath,
    sourceVersion: catalog.sourceVersion,
    sourceHash: requiredSha256(catalog.sourceHash, `${catalog.batchSlug}.sourceHash`),
    companies: catalog.companies.length,
    founders: catalog.companies.reduce((sum, company) => sum + company.founders.length, 0)
  }));
  return {
    pairs,
    catalogProof,
    inventory: { companies, founders, owners: companies + founders }
  };
}

function validateHistoricalManifest(value, generatedAt) {
  assertObject(value, "historical staging manifest");
  if (value.schemaVersion !== HISTORICAL_STAGING_VERSION || value.status !== "staged") {
    throw new Error("Historical staging manifest is not a completed immutable staging receipt.");
  }
  if (value.publicationStatus !== "stored_but_unpublished") {
    throw new Error("Historical staging manifest is not stored_but_unpublished.");
  }
  const stagedAt = canonicalTimestamp(value.stagedAt, "historical manifest.stagedAt");
  assertNotAfter(stagedAt, generatedAt, "historical manifest.stagedAt");
  const descriptor = normalizeLedgerDescriptor(
    value.artifacts?.storedUnpublished,
    "historical manifest.artifacts.storedUnpublished",
    { pathField: "path" }
  );
  if (descriptor.format !== "ndjson") throw new Error("Historical stored ledger must be NDJSON.");
  if (descriptor.rows !== exactNonnegativeInteger(
    value.counts?.storedButUnpublished,
    "historical manifest.counts.storedButUnpublished"
  )) {
    throw new Error("Historical stored ledger row count conflicts with its manifest total.");
  }
  return { ...value, stagedAt, artifacts: { ...value.artifacts, storedUnpublished: descriptor } };
}

function validateGithubReceipt(value, generatedAt, inventory) {
  assertObject(value, "GitHub exhaustive staging receipt");
  if (value.schemaVersion !== 1 || value.status !== "staged_not_published" ||
      value.productionEligible !== false) {
    throw new Error("GitHub receipt is not a fail-closed staged_not_published receipt.");
  }
  const stagedAt = canonicalTimestamp(value.generatedAt, "GitHub receipt.generatedAt");
  assertNotAfter(stagedAt, generatedAt, "GitHub receipt.generatedAt");
  const declaredReceiptSha = requiredSha256(value.receiptSha256, "GitHub receipt.receiptSha256");
  const core = { ...value };
  delete core.receiptSha256;
  if (sha256(stableJson(core)) !== declaredReceiptSha) {
    throw new Error("GitHub receipt self-hash does not match its exact receipt core.");
  }
  for (const [field, expected] of [
    ["companiesEvaluated", inventory.companies],
    ["foundersEvaluated", inventory.founders],
    ["canonicalOwnersEvaluated", inventory.owners]
  ]) {
    if (exactNonnegativeInteger(value.denominators?.[field], `GitHub denominators.${field}`) !== expected) {
      throw new Error(`GitHub denominator ${field} does not match the canonical catalog.`);
    }
  }
  const descriptor = normalizeLedgerDescriptor(
    value.outputs?.storedEvidenceReview,
    "GitHub outputs.storedEvidenceReview",
    { pathField: "filename" }
  );
  if (descriptor.publicationState !== "stored_but_unpublished" ||
      descriptor.scoringEligible !== false) {
    throw new Error("GitHub review ledger descriptor is scoring- or publication-eligible.");
  }
  if (descriptor.rows !== exactNonnegativeInteger(
    value.evidence?.storedEvidenceReviewRows,
    "GitHub evidence.storedEvidenceReviewRows"
  )) {
    throw new Error("GitHub review ledger row count conflicts with its receipt total.");
  }
  return {
    ...value,
    generatedAt: stagedAt,
    receiptSha256: declaredReceiptSha,
    outputs: { ...value.outputs, storedEvidenceReview: descriptor }
  };
}

async function auditHistoricalLedger({ path, descriptor, pairCounts, maxInputBytes }) {
  const seenIds = new Set();
  const seenAttributions = new Set();
  return auditNdjson(path, {
    maxInputBytes,
    label: "historical stored-unpublished ledger",
    descriptor,
    onRow(row, index) {
      assertObject(row, `historical ledger row ${index}`);
      const id = requiredText(row.id, `historical row ${index}.id`);
      if (seenIds.has(id)) throw new Error(`Duplicate historical stored row id ${id}.`);
      seenIds.add(id);
      const platform = requiredText(row.platform, `${id}.platform`).toLowerCase();
      if (!HISTORICAL_PLATFORMS.has(platform)) {
        throw new Error(`Historical stored row ${id} has unsupported platform ${platform}.`);
      }
      assertStoredUnpublishedHistoricalRow(row, id);
      const pair = resolveExactPair(pairCounts, {
        batchSlug: row.batchSlug,
        entityType: row.entityType,
        entityId: row.entityId,
        platform
      }, `historical row ${id}`);
      const physical = requiredText(
        row.nativeId ?? row.canonicalUrl ?? row.sourceUrl,
        `${id}.physicalIdentity`
      );
      const attribution = `${pair.pairKey}\u0000${physical}`;
      if (seenAttributions.has(attribution)) {
        throw new Error(`Duplicate historical attribution ${pair.pairKey} for ${physical}.`);
      }
      seenAttributions.add(attribution);
      pair.historicalEvidenceRows += 1;
    }
  });
}

async function auditGithubLedger({ path, descriptor, pairCounts, maxInputBytes }) {
  const seenReviewIds = new Set();
  const seenEvidenceIds = new Set();
  return auditNdjson(path, {
    maxInputBytes,
    label: "GitHub stored-evidence review ledger",
    descriptor,
    onRow(row, index) {
      assertObject(row, `GitHub review row ${index}`);
      const reviewId = requiredText(row.reviewId, `GitHub review row ${index}.reviewId`);
      if (seenReviewIds.has(reviewId)) throw new Error(`Duplicate GitHub reviewId ${reviewId}.`);
      seenReviewIds.add(reviewId);
      if (row.publicationState !== "stored_but_unpublished" || row.scoringEligible !== false) {
        throw new Error(`GitHub review ${reviewId} is scoring- or publication-eligible.`);
      }
      const category = requiredText(row.category, `${reviewId}.category`);
      if (GITHUB_EVIDENCE_CATEGORIES.has(category)) {
        auditGithubEvidenceReview(row, reviewId, pairCounts, seenEvidenceIds);
      } else if (category === GITHUB_BLOCKER_CATEGORY) {
        auditGithubBlockerReview(row, reviewId, pairCounts);
      } else {
        throw new Error(`GitHub review ${reviewId} has unsupported category ${category}.`);
      }
    }
  });
}

function auditGithubEvidenceReview(row, reviewId, pairCounts, seenEvidenceIds) {
  const evidenceId = requiredText(row.contentIdentity?.evidenceId, `${reviewId}.contentIdentity.evidenceId`);
  if (seenEvidenceIds.has(evidenceId)) {
    throw new Error(`Duplicate GitHub stored evidence identity ${evidenceId}.`);
  }
  seenEvidenceIds.add(evidenceId);
  if (!requiredText(row.contentIdentity?.kind, `${reviewId}.contentIdentity.kind`).startsWith("github_")) {
    throw new Error(`GitHub review ${reviewId} has a non-GitHub content kind.`);
  }
  if (!Array.isArray(row.ownerCandidates) || row.ownerCandidates.length === 0) {
    throw new Error(`GitHub evidence review ${reviewId} has no owner candidates.`);
  }
  const seenPairs = new Set();
  for (const [index, candidate] of row.ownerCandidates.entries()) {
    assertObject(candidate, `${reviewId}.ownerCandidates[${index}]`);
    if (candidate.platform !== undefined && candidate.platform !== "github") {
      throw new Error(`GitHub review ${reviewId} declares non-GitHub platform ${candidate.platform}.`);
    }
    const pair = resolveExactPair(pairCounts, {
      batchSlug: candidate.batchSlug,
      entityType: candidate.entityType,
      entityId: candidate.entityId,
      platform: "github"
    }, `${reviewId}.ownerCandidates[${index}]`);
    if (seenPairs.has(pair.pairKey)) {
      throw new Error(`Duplicate GitHub attribution ${reviewId} -> ${pair.pairKey}.`);
    }
    seenPairs.add(pair.pairKey);
    if (candidate.entityName !== undefined && candidate.entityName !== pair.entityName) {
      throw new Error(`GitHub attribution ${reviewId} entityName conflicts with ${pair.pairKey}.`);
    }
    pair.githubEvidenceAttributions += 1;
  }
}

function auditGithubBlockerReview(row, reviewId, pairCounts) {
  if (!Array.isArray(row.attributionTaskKeys) || row.attributionTaskKeys.length === 0) {
    throw new Error(`GitHub blocker ${reviewId} has no attributionTaskKeys.`);
  }
  const seenPairs = new Set();
  for (const [index, taskKey] of row.attributionTaskKeys.entries()) {
    const identity = parseGithubAttributionTaskKey(taskKey, `${reviewId}.attributionTaskKeys[${index}]`);
    const pair = resolveExactPair(pairCounts, { ...identity, platform: "github" }, reviewId);
    if (seenPairs.has(pair.pairKey)) {
      throw new Error(`Duplicate GitHub blocker attribution ${reviewId} -> ${pair.pairKey}.`);
    }
    seenPairs.add(pair.pairKey);
    pair.githubBlockerReviews += 1;
  }
}

function assertStoredUnpublishedHistoricalRow(row, id) {
  if (
    row.publicationPolicy !== "stored_but_unpublished" ||
    row.historicalValidationStatus !== "pending_publication_validation" ||
    row.review_state !== "needs_review" ||
    row.scoringEligible === true
  ) {
    throw new Error(`Historical row ${id} is scoring- or publication-eligible.`);
  }
}

function resolveExactPair(pairCounts, identity, label) {
  const batchSlug = requiredText(identity.batchSlug, `${label}.batchSlug`);
  const entityType = requiredText(identity.entityType, `${label}.entityType`).toLowerCase();
  if (!new Set(["company", "founder"]).has(entityType)) {
    throw new Error(`${label} has unsupported entityType ${entityType}.`);
  }
  const entityId = requiredText(identity.entityId, `${label}.entityId`);
  const platform = requiredText(identity.platform, `${label}.platform`).toLowerCase();
  if (!ALL_PLATFORMS.includes(platform)) throw new Error(`${label} has unknown platform ${platform}.`);
  const pairKey = coveragePairKey({ batchSlug, entityType, entityId, platform });
  const pair = pairCounts.get(pairKey);
  if (!pair) throw new Error(`${label} does not resolve to canonical pair ${pairKey}.`);
  return pair;
}

function parseGithubAttributionTaskKey(value, label) {
  const taskKey = requiredText(value, label);
  const match = taskKey.match(/^([^:]+):(company|founder):([^:]+):(https:\/\/github\.com\/.+)$/i);
  if (!match) throw new Error(`${label} is not an exact GitHub attribution task key.`);
  return { batchSlug: match[1], entityType: match[2].toLowerCase(), entityId: match[3] };
}

function buildPairScope(pair, { generatedAt, sourceProofSha256 }) {
  const evidenceCount = pair.historicalEvidenceRows + pair.githubEvidenceAttributions;
  const reviewCount = pair.githubBlockerReviews;
  const total = evidenceCount + reviewCount;
  const pairDigest = sha256(`${sourceProofSha256}\u0000${pair.pairKey}`);
  return {
    pairKey: pair.pairKey,
    batchSlug: pair.batchSlug,
    entityType: pair.entityType,
    entityId: pair.entityId,
    platform: pair.platform,
    scope: {
      storedUnpublishedReceipt: {
        receiptId: `stored-unpublished:${pairDigest.slice(0, 32)}`,
        status: "complete",
        checkedAt: generatedAt,
        coveredThrough: generatedAt,
        reason:
          `Both hash-pinned historical and GitHub stored-unpublished ledgers were fully traversed; ` +
          `surfaced ${total} attributed row(s): ${pair.historicalEvidenceRows} historical evidence, ` +
          `${pair.githubEvidenceAttributions} GitHub evidence, and ${reviewCount} GitHub blocker review(s). ` +
          "A zero count proves only that both named ledgers were checked.",
        surfacedCounts: {
          historicalEvidenceRows: pair.historicalEvidenceRows,
          githubEvidenceAttributions: pair.githubEvidenceAttributions,
          githubBlockerReviews: reviewCount,
          evidenceAttributions: evidenceCount,
          totalAttributedRows: total,
          explicitZero: total === 0
        },
        sourceProofSha256,
        publicationPolicy: "proof_only_no_publication",
        scoringEligible: false
      }
    }
  };
}

function summarizePairScopes(rows, inventory) {
  const byPlatform = Object.fromEntries(ALL_PLATFORMS.map((platform) => [platform, emptySummary()]));
  const byBatch = {};
  const totals = emptySummary();
  let explicitZeroPairs = 0;
  for (const row of rows) {
    const counts = row.scope.storedUnpublishedReceipt.surfacedCounts;
    if (counts.explicitZero) explicitZeroPairs += 1;
    addSummary(totals, counts);
    addSummary(byPlatform[row.platform], counts);
    byPlatform[row.platform].pairs += 1;
    byBatch[row.batchSlug] ??= emptySummary();
    addSummary(byBatch[row.batchSlug], counts);
    byBatch[row.batchSlug].pairs += 1;
  }
  for (const summary of Object.values(byPlatform)) summary.explicitZeroPairs =
    summary.pairs - summary.nonzeroPairs;
  for (const summary of Object.values(byBatch)) summary.explicitZeroPairs =
    summary.pairs - summary.nonzeroPairs;
  return { ...totals, explicitZeroPairs, byPlatform, byBatch, inventory };
}

function emptySummary() {
  return {
    pairs: 0,
    nonzeroPairs: 0,
    explicitZeroPairs: 0,
    historicalEvidenceRows: 0,
    githubEvidenceAttributions: 0,
    githubBlockerReviews: 0
  };
}

function addSummary(summary, counts) {
  summary.historicalEvidenceRows += counts.historicalEvidenceRows;
  summary.githubEvidenceAttributions += counts.githubEvidenceAttributions;
  summary.githubBlockerReviews += counts.githubBlockerReviews;
  if (!counts.explicitZero) summary.nonzeroPairs += 1;
}

async function auditNdjson(path, { maxInputBytes, label, descriptor, onRow }) {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) throw new TypeError(`${label} must be a regular file.`);
  if (fileStat.size > maxInputBytes) throw new Error(`${label} exceeds maxInputBytes=${maxInputBytes}.`);
  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let rows = 0;
  let finalByte = null;
  for await (const rawChunk of createReadStream(path)) {
    const chunk = Buffer.from(rawChunk);
    hash.update(chunk);
    finalByte = chunk.at(-1);
    pending += decoder.write(chunk);
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch (error) {
        throw new Error(`${label} row ${rows + 1} is invalid JSON: ${error.message}`);
      }
      rows += 1;
      onRow(row, rows);
    }
    if (Buffer.byteLength(pending, "utf8") > 16 * 1024 * 1024) {
      throw new Error(`${label} contains a line larger than 16 MiB.`);
    }
  }
  pending += decoder.end();
  if (fileStat.size > 0 && (finalByte !== 0x0a || pending.length !== 0)) {
    throw new Error(`${label} must end with a complete newline-terminated row.`);
  }
  const digest = hash.digest("hex");
  if (digest !== descriptor.sha256) throw new Error(`${label} SHA-256 does not match its stage receipt.`);
  if (rows !== descriptor.rows) throw new Error(`${label} rows=${rows}; receipt declares ${descriptor.rows}.`);
  if (fileStat.size !== descriptor.bytes && descriptor.bytes !== null) {
    throw new Error(`${label} bytes=${fileStat.size}; receipt declares ${descriptor.bytes}.`);
  }
  return { sha256: digest, rows, bytes: fileStat.size };
}

async function writeBridgePackage({ outputPath, pairScopes, manifestCore }) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(temporary, { recursive: false });
  try {
    const pairBody = `${stableJson(pairScopes)}\n`;
    const pairDescriptor = {
      path: "pair-scopes.json",
      format: "json",
      rows: pairScopes.length,
      bytes: Buffer.byteLength(pairBody),
      sha256: sha256(pairBody),
      observedAt: manifestCore.generatedAt
    };
    await writeFile(join(temporary, pairDescriptor.path), pairBody, { mode: 0o600, flag: "wx" });
    const manifest = {
      ...manifestCore,
      outputDir: outputPath,
      artifacts: { pairScopes: pairDescriptor }
    };
    const manifestBody = `${stableJson(manifest)}\n`;
    await writeFile(
      join(temporary, "stored-unpublished-coverage-manifest.json"),
      manifestBody,
      { mode: 0o600, flag: "wx" }
    );
    await rename(temporary, outputPath);
    return {
      ...manifest,
      manifestPath: join(outputPath, "stored-unpublished-coverage-manifest.json"),
      manifestSha256: sha256(manifestBody)
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function normalizeLedgerDescriptor(value, label, { pathField }) {
  assertObject(value, label);
  const declaredPath = requiredText(value[pathField], `${label}.${pathField}`);
  return {
    ...value,
    [pathField]: declaredPath,
    path: pathField === "path" ? declaredPath : undefined,
    filename: pathField === "filename" ? declaredPath : undefined,
    sha256: requiredSha256(value.sha256, `${label}.sha256`),
    rows: exactNonnegativeInteger(value.rows ?? value.rowCount, `${label}.rows`),
    bytes: value.bytes === undefined
      ? null
      : exactNonnegativeInteger(value.bytes, `${label}.bytes`),
    format: value.format ?? (pathField === "filename" ? "ndjson" : null)
  };
}

async function resolveDeclaredSibling(receiptPath, declaredPath, label) {
  if (basename(declaredPath) !== declaredPath || declaredPath.includes("\\")) {
    throw new Error(`${label} descriptor must name one sibling file without traversal.`);
  }
  const candidate = resolve(dirname(receiptPath), declaredPath);
  const real = await realpath(candidate);
  if (dirname(real) !== dirname(receiptPath)) {
    throw new Error(`${label} resolves outside its immutable staging directory.`);
  }
  return real;
}

async function readBoundedJson(path, maxBytes, label) {
  const info = await stat(path);
  if (!info.isFile()) throw new TypeError(`${label} must be a regular file.`);
  if (info.size > maxBytes) throw new Error(`${label} exceeds maxInputBytes=${maxBytes}.`);
  const bytes = await readFile(path);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
  return { bytes, value };
}

async function assertPathDoesNotExist(path, label) {
  try {
    await stat(path);
    throw new Error(`${label} already exists: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function coveragePairKey({ batchSlug, entityType, entityId, platform }) {
  return [batchSlug, entityType, entityId, platform]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function resolveFromRoot(root, path) {
  return resolve(root, path);
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string" || !CANONICAL_ISO.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO UTC timestamp.`);
  }
  return value;
}

function assertNotAfter(value, upperBound, label) {
  if (Date.parse(value) > Date.parse(upperBound)) {
    throw new Error(`${label} cannot be later than generatedAt.`);
  }
}

function exactNonnegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer.`);
  }
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return number;
}

function requiredText(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new TypeError(`${label} must be non-empty text.`);
  return text;
}

function requiredSha256(value, label) {
  const digest = requiredText(value, label).toLowerCase();
  if (!SHA256.test(digest)) throw new TypeError(`${label} must be lowercase SHA-256.`);
  return digest;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}
