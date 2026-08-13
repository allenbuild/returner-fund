import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";
import {
  buildAutonomousPublicNativeAuthorResolver,
  buildLegacyPublicEvidenceBatchResolver,
  loadAutonomousCatalogs,
  mergePublicEvidenceSnapshots
} from "./autonomous-ingestion-plan.mjs";
import { adaptHistoricalBackfillCoverage } from "./historical-coverage-adapter.mjs";
import { hydratePublicEvidenceArtifactWithLoader } from "./public-evidence-artifact.mjs";

export const HISTORICAL_PUBLICATION_STAGING_VERSION =
  "historical-publication-staging.v1";
export const HISTORICAL_PUBLICATION_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

const HISTORICAL_PLATFORMS = new Set(["hacker_news", "rss", "web"]);
const DEFAULT_CANONICAL = "src/lib/social/public-evidence-current.json";
const DEFAULT_REFERENCES = Object.freeze([
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/a16z-speedrun-006-social-evidence.json"
]);

/**
 * Validate one completed historical journal and prepare an immutable,
 * stored-but-unpublished public-evidence staging package. The canonical file
 * is read and hash-checked before and after planning; it is never modified.
 */
export async function stageHistoricalBackfillPublication({
  root = process.cwd(),
  journalPath,
  canonicalPath = null,
  referencePaths = null,
  outputDir = null,
  stagedAt,
  dryRun = false,
  maxArtifactBytes = HISTORICAL_PUBLICATION_MAX_ARTIFACT_BYTES,
  catalogs: suppliedCatalogs = null,
  contentIdentityReferenceRows: suppliedReferenceRows = null,
  mergeSnapshots = mergePublicEvidenceSnapshots
} = {}) {
  const normalizedStagedAt = canonicalTimestamp(stagedAt, "stagedAt");
  validateByteLimit(maxArtifactBytes);
  const rootPath = await realpath(resolve(root));
  const journalRealPath = await realpath(resolve(requiredText(journalPath, "journalPath")));
  const canonicalRealPath = await realpath(resolve(
    canonicalPath ?? join(rootPath, DEFAULT_CANONICAL)
  ));
  const outputPath = outputDir ? resolve(outputDir) : null;
  if (!dryRun && !outputPath) throw new Error("outputDir is required unless dryRun=true.");
  if (outputPath) await assertPathDoesNotExist(outputPath, "outputDir");

  const journal = await inspectCompletedJournal(journalRealPath, maxArtifactBytes);
  if (journal.lastEvent.type !== "run_completed" ||
      journal.lastEvent.summary?.status !== "completed") {
    throw new Error("Historical journal must end in run_completed with summary.status=completed.");
  }
  if (Date.parse(journal.observedAt) > Date.parse(normalizedStagedAt)) {
    throw new Error("stagedAt cannot predate the final journal recordedAt.");
  }

  const canonicalSource = await readBoundedJson(
    canonicalRealPath,
    maxArtifactBytes,
    "canonical public snapshot"
  );
  const canonicalHashBefore = sha256(canonicalSource.bytes);
  let canonicalOperationalLedgerSource = null;
  const canonicalSnapshot = await hydratePublicEvidenceArtifactWithLoader(
    canonicalSource.value,
    {
      loadLedger: async (relativePath) => {
        const ledgerPath = resolve(rootPath, relativePath);
        canonicalOperationalLedgerSource = {
          path: ledgerPath,
          ...await readBoundedJson(
            ledgerPath,
            maxArtifactBytes,
            "canonical public operational ledger"
          )
        };
        return canonicalOperationalLedgerSource.bytes;
      }
    }
  );
  validatePublicSnapshot(canonicalSnapshot, "canonical public snapshot");

  const catalogs = suppliedCatalogs ?? await loadAutonomousCatalogs(rootPath);
  const catalogEntities = indexCatalogEntities(catalogs);
  const references = suppliedReferenceRows ?? await loadReferenceRows({
    rootPath,
    paths: referencePaths ?? DEFAULT_REFERENCES,
    maxArtifactBytes
  });
  const historical = await adaptHistoricalBackfillCoverage({
    journal: createReadStream(journalRealPath),
    artifact: {
      path: journalRealPath,
      sha256: journal.sha256,
      observedAt: journal.observedAt
    },
    generatedAt: normalizedStagedAt
  });
  if (!historical.provenance.journal.runCompleted ||
      historical.provenance.journal.terminalTargets !==
        historical.provenance.journal.expectedTargets) {
    throw new Error("Historical journal is not a fully terminal completed run.");
  }

  const translated = historical.collectorArtifacts.flatMap((artifact) =>
    artifact.snapshot.evidence.map((row) => translateHistoricalRow(row, {
      catalogEntities,
      journalSha256: journal.sha256
    }))
  );
  validateHistoricalAttribution(translated, historical.targetCoverage);

  const dedupe = dedupeHistoricalRows(translated, canonicalSnapshot);
  const candidateSnapshot = {
    source: {
      label: "Completed historical backfill stored-unpublished staging",
      fetchedAt: journal.observedAt,
      batchSlugs: [...new Set(dedupe.stored.map((row) => row.batchSlug))].sort()
    },
    evidence: dedupe.stored,
    needsReview: [],
    failures: [],
    attempts: {}
  };
  const resolveBatchSlug = buildLegacyPublicEvidenceBatchResolver(catalogs);
  const resolveNativeAuthor = buildAutonomousPublicNativeAuthorResolver(catalogs);
  const merged = mergeSnapshots([canonicalSnapshot, candidateSnapshot], {
    fetchedAt: journal.observedAt,
    durableStorageConfigured: false,
    resolveBatchSlug,
    resolveNativeAuthor,
    contentIdentityReferenceRows: references
  });
  validatePublicSnapshot(merged, "merged staging snapshot");

  const canonicalEvidenceIds = rowIdSet(canonicalSnapshot.evidence, "canonical evidence");
  const mergedEvidenceIds = rowIdSet(merged.evidence, "merged evidence");
  const removedCanonicalEvidence = canonicalSnapshot.evidence.filter(
    (row) => !mergedEvidenceIds.has(row.id)
  );
  if (removedCanonicalEvidence.length > 0) {
    throw new Error(
      `Historical staging would remove ${removedCanonicalEvidence.length} last-good canonical ` +
      `evidence row(s): ${removedCanonicalEvidence.slice(0, 10).map((row) => row.id).join(", ")}.`
    );
  }
  const addedPublishedEvidence = merged.evidence.filter((row) => !canonicalEvidenceIds.has(row.id));
  if (addedPublishedEvidence.length > 0) {
    throw new Error(
      `Historical staging unexpectedly made ${addedPublishedEvidence.length} row(s) publishable. ` +
      "New historical rows must remain stored_but_unpublished until separate validation."
    );
  }

  const candidateIds = new Set(dedupe.stored.map((row) => row.id));
  const canonicalReviewIds = rowIdSet(
    canonicalSnapshot.needsReview,
    "canonical review",
    { allowDuplicates: true }
  );
  const addedHistoricalReviews = merged.needsReview.filter((row) =>
    row.sourceEvidenceId && candidateIds.has(row.sourceEvidenceId) &&
    !canonicalReviewIds.has(row.id)
  ).map((row) => ({
    ...row,
    publicationPolicy: "stored_but_unpublished",
    historicalValidationStatus: "pending_publication_validation"
  }));
  const reviewedCandidateIds = new Set(
    merged.needsReview.map((row) => row.sourceEvidenceId).filter((id) => candidateIds.has(id))
  );
  if (reviewedCandidateIds.size !== dedupe.stored.length) {
    throw new Error(
      `Canonical merge accounted for ${reviewedCandidateIds.size}/${dedupe.stored.length} ` +
      "stored historical candidates."
    );
  }

  const stagedSnapshot = {
    ...canonicalSnapshot,
    source: {
      ...canonicalSnapshot.source,
      evidenceCount: canonicalSnapshot.evidence.length,
      needsReviewCount:
        canonicalSnapshot.needsReview.length + addedHistoricalReviews.length,
      historicalStaging: {
        schemaVersion: HISTORICAL_PUBLICATION_STAGING_VERSION,
        journalSha256: journal.sha256,
        observedAt: journal.observedAt,
        stagedAt: normalizedStagedAt,
        publicationPolicy: "stored_but_unpublished",
        storedRows: dedupe.stored.length
      }
    },
    // Preserve every canonical evidence and protected operational ledger
    // exactly. Only newly merge-classified review rows are appended.
    evidence: canonicalSnapshot.evidence,
    needsReview: [
      ...canonicalSnapshot.needsReview,
      ...addedHistoricalReviews
    ]
  };
  assertCanonicalLedgersPreserved(canonicalSnapshot, stagedSnapshot);

  const runnerTotals = normalizeRunnerTotals(journal.lastEvent.summary?.totals);
  const counts = {
    runnerAccepted: runnerTotals.accepted,
    runnerRejected: runnerTotals.rejected,
    runnerDuplicates: runnerTotals.duplicates,
    adapterAccepted: translated.length,
    adapterRejected: historical.rejectedEvidence.length,
    dedupedWithinHistorical: dedupe.withinHistorical.length,
    dedupedAgainstCanonical: dedupe.againstCanonical.length,
    dedupedTotal: dedupe.withinHistorical.length + dedupe.againstCanonical.length,
    storedButUnpublished: dedupe.stored.length,
    stagedReviewRowsAdded: addedHistoricalReviews.length,
    canonicalEvidencePreserved: canonicalSnapshot.evidence.length,
    canonicalReviewsPreserved: canonicalSnapshot.needsReview.length
  };
  if (counts.adapterAccepted + counts.adapterRejected !== counts.runnerAccepted) {
    throw new Error(
      `Historical adapter reconciled ${counts.adapterAccepted}+${counts.adapterRejected} ` +
      `rows against runnerAccepted=${counts.runnerAccepted}.`
    );
  }
  if (counts.storedButUnpublished + counts.dedupedTotal !== counts.adapterAccepted) {
    throw new Error("Historical staging accepted/deduped counts do not reconcile.");
  }

  const baseReceipt = {
    schemaVersion: HISTORICAL_PUBLICATION_STAGING_VERSION,
    status: dryRun ? "dry_run" : "staged",
    publicationStatus: "stored_but_unpublished",
    journal: {
      path: journalRealPath,
      sha256: journal.sha256,
      bytes: journal.bytes,
      observedAt: journal.observedAt,
      finalSequence: journal.lastEvent.sequence
    },
    canonical: {
      path: canonicalRealPath,
      sha256: canonicalHashBefore,
      bytes: canonicalSource.bytes.length,
      ...(canonicalOperationalLedgerSource ? {
        operationalLedger: {
          path: canonicalOperationalLedgerSource.path,
          sha256: sha256(canonicalOperationalLedgerSource.bytes),
          bytes: canonicalOperationalLedgerSource.bytes.length
        }
      } : {})
    },
    stagedAt: normalizedStagedAt,
    counts,
    byPlatform: summarizeByPlatform({
      accepted: translated,
      rejected: historical.rejectedEvidence,
      stored: dedupe.stored,
      deduped: [...dedupe.withinHistorical, ...dedupe.againstCanonical]
    }),
    byBatch: summarizeByBatch({
      accepted: translated,
      stored: dedupe.stored,
      deduped: [...dedupe.withinHistorical, ...dedupe.againstCanonical]
    })
  };

  let result = baseReceipt;
  if (!dryRun) {
    result = await writeStagingPackage({
      outputPath,
      stagedSnapshot,
      storedRows: dedupe.stored,
      adapterRejectedRows: historical.rejectedEvidence,
      dedupedRows: [...dedupe.withinHistorical, ...dedupe.againstCanonical],
      receipt: baseReceipt
    });
  }

  const canonicalHashAfter = sha256((await readBoundedJson(
    canonicalRealPath,
    maxArtifactBytes,
    "canonical public snapshot after staging"
  )).bytes);
  if (canonicalHashAfter !== canonicalHashBefore) {
    if (!dryRun && outputPath) await rm(outputPath, { recursive: true, force: true });
    throw new Error("Canonical public evidence changed during staging; staged output was discarded.");
  }
  if (canonicalOperationalLedgerSource) {
    const operationalLedgerHashAfter = sha256((await readBoundedJson(
      canonicalOperationalLedgerSource.path,
      maxArtifactBytes,
      "canonical public operational ledger after staging"
    )).bytes);
    if (operationalLedgerHashAfter !== result.canonical.operationalLedger.sha256) {
      if (!dryRun && outputPath) await rm(outputPath, { recursive: true, force: true });
      throw new Error(
        "Canonical public operational ledger changed during staging; staged output was discarded."
      );
    }
  }
  return {
    ...result,
    canonical: { ...result.canonical, sha256After: canonicalHashAfter }
  };
}

async function inspectCompletedJournal(path, maxBytes) {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) throw new TypeError("journalPath must be a regular file.");
  if (fileStat.size > maxBytes) {
    throw new Error(`Historical journal exceeds maxArtifactBytes=${maxBytes}.`);
  }
  const hash = createHash("sha256");
  let pending = "";
  let lastLine = null;
  let finalByte = null;
  let bytes = 0;
  for await (const rawChunk of createReadStream(path)) {
    const chunk = Buffer.from(rawChunk);
    hash.update(chunk);
    bytes += chunk.length;
    finalByte = chunk.at(-1);
    pending += chunk.toString("utf8");
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (line) lastLine = line;
    }
    if (Buffer.byteLength(pending, "utf8") > 16 * 1024 * 1024) {
      throw new Error("Historical journal final line exceeds 16 MiB.");
    }
  }
  if (bytes === 0) throw new Error("Historical journal is empty.");
  if (finalByte !== 0x0a || pending.length !== 0) {
    throw new Error("Historical journal must end with a complete newline-terminated event.");
  }
  let lastEvent;
  try {
    lastEvent = JSON.parse(lastLine);
  } catch (error) {
    throw new Error(`Historical journal final event is invalid JSON: ${error.message}`);
  }
  return {
    bytes,
    sha256: hash.digest("hex"),
    observedAt: canonicalTimestamp(lastEvent.recordedAt, "final journal recordedAt"),
    lastEvent
  };
}

function translateHistoricalRow(row, { catalogEntities, journalSha256 }) {
  assertObject(row, "historical accepted evidence");
  const platform = requiredText(row.platform, "historical evidence.platform").toLowerCase();
  if (!HISTORICAL_PLATFORMS.has(platform)) {
    throw new Error(`Unsupported historical publication platform ${platform}.`);
  }
  const identity = [
    requiredText(row.batchSlug, "historical evidence.batchSlug"),
    requiredText(row.entityType, "historical evidence.entityType"),
    requiredText(row.entityId, "historical evidence.entityId")
  ];
  const catalog = catalogEntities.get(identity.join("\u0000"));
  if (!catalog) throw new Error(`Historical evidence references unknown canonical entity ${identity.join(":")}.`);
  const sourceUrl = canonicalHttpsUrl(row.canonicalUrl ?? row.sourceUrl, "historical evidence URL");
  const nativeId = requiredText(row.nativeId, "historical evidence.nativeId");
  const id = `historical-${sha256(stableJson([
    ...identity,
    platform,
    nativeId,
    sourceUrl
  ])).slice(0, 32)}`;
  return {
    id,
    batchSlug: identity[0],
    entityType: identity[1],
    entityId: identity[2],
    attachedCompanyId: catalog.companyId,
    entityName: catalog.entityName,
    companyName: catalog.companyName,
    companySlug: catalog.companySlug,
    platform,
    sourceUrl,
    canonicalUrl: sourceUrl,
    ...(platform === "hacker_news"
      ? { platformPostId: nativeId.replace(/^hn:/i, "") }
      : {}),
    nativeId,
    title: row.title ?? null,
    text: row.text ?? null,
    authorName: row.author ?? null,
    postedAt: canonicalTimestamp(row.publishedAt, `${id}.publishedAt`),
    publishedAt: canonicalTimestamp(row.publishedAt, `${id}.publishedAt`),
    first_seen_at: canonicalTimestamp(row.observedAt, `${id}.observedAt`),
    last_checked_at: canonicalTimestamp(row.observedAt, `${id}.observedAt`),
    metrics: {},
    review_state: "needs_review",
    publicationPolicy: "stored_but_unpublished",
    historicalValidationStatus: "pending_publication_validation",
    historicalDigest: requiredSha256(row.digest, `${id}.digest`),
    historicalTargetKey: requiredText(row.historicalTargetKey, `${id}.historicalTargetKey`),
    historicalOutboundUrl: row.historicalOutboundUrl ?? null,
    matchReason:
      "Validated completed historical journal row; held stored-but-unpublished pending separate scoring and publication validation.",
    rawVisibleText: stableJson({
      source: "historical_backfill_v2",
      journalSha256,
      historicalTargetKey: row.historicalTargetKey,
      historicalPageSequence: row.historicalPageSequence,
      discoveryMethod: row.discoveryMethod ?? null,
      outboundUrl: row.historicalOutboundUrl ?? null
    })
  };
}

function validateHistoricalAttribution(rows, targetCoverage) {
  const targets = new Map(targetCoverage.map((target) => [target.targetKey, target]));
  for (const row of rows) {
    const target = targets.get(row.historicalTargetKey);
    if (!target) throw new Error(`${row.id} references unknown historical target.`);
    for (const [field, actual, expected] of [
      ["batchSlug", row.batchSlug, target.batchSlug],
      ["entityType", row.entityType, target.entityType],
      ["entityId", row.entityId, target.entityId],
      ["platform", row.platform, target.platform]
    ]) {
      if (actual !== expected) {
        throw new Error(
          `${row.historicalTargetKey} staged evidence ${field}=${actual} does not match target ${expected}.`
        );
      }
    }
  }
}

function dedupeHistoricalRows(rows, canonical) {
  const canonicalKeys = new Set([
    ...(canonical.evidence ?? []),
    ...(canonical.needsReview ?? [])
  ].map(stagingPhysicalKey).filter(Boolean));
  const accepted = new Map();
  const withinHistorical = [];
  const againstCanonical = [];
  for (const row of [...rows].sort(compareHistoricalRows)) {
    const key = stagingPhysicalKey(row);
    if (!key) throw new Error(`${row.id} has no deterministic physical identity.`);
    if (canonicalKeys.has(key)) {
      againstCanonical.push(dedupeRecord(row, key, "already_stored_in_canonical_snapshot"));
      continue;
    }
    const previous = accepted.get(key);
    if (previous) {
      withinHistorical.push(dedupeRecord(row, key, "duplicate_historical_physical_identity"));
      continue;
    }
    accepted.set(key, row);
  }
  return { stored: [...accepted.values()], withinHistorical, againstCanonical };
}

function stagingPhysicalKey(row) {
  const platform = String(row?.platform ?? "").toLowerCase();
  if (!HISTORICAL_PLATFORMS.has(platform)) return null;
  const batch = String(row?.batchSlug ?? row?.batch_slug ?? "").toUpperCase();
  const companySlug = String(row?.companySlug ?? row?.company_slug ?? "").toLowerCase();
  if (!batch || !companySlug) return null;
  let physical;
  if (platform === "hacker_news") {
    const explicit = String(
      row?.platformPostId ?? row?.nativeId ?? row?.platform_post_id ?? ""
    ).replace(/^hn:/i, "");
    const urlId = hackerNewsId(row?.sourceUrl ?? row?.candidateUrl ?? row?.canonicalUrl);
    physical = /^\d+$/.test(explicit) ? explicit : urlId;
    if (explicit && urlId && explicit !== urlId) {
      throw new Error(`Hacker News physical identity mismatch for ${row?.id ?? "unknown row"}.`);
    }
  } else {
    physical = normalizedPhysicalUrl(
      row?.sourceUrl ?? row?.candidateUrl ?? row?.canonicalUrl ?? row?.url
    );
  }
  return physical ? `${batch}:${companySlug}:${platform}:${physical}` : null;
}

function dedupeRecord(row, physicalKey, reason) {
  return {
    id: row.id,
    batchSlug: row.batchSlug,
    entityType: row.entityType,
    entityId: row.entityId,
    companySlug: row.companySlug,
    platform: row.platform,
    sourceUrl: row.sourceUrl,
    nativeId: row.nativeId,
    physicalKey,
    reason
  };
}

function indexCatalogEntities(catalogs) {
  const index = new Map();
  for (const catalog of catalogs) {
    for (const company of catalog.companies ?? []) {
      const companySlug = catalogCompanySlug(company.sourceKey);
      index.set(`${catalog.slug}\u0000company\u0000${company.sourceKey}`, {
        companyId: company.sourceKey,
        companyName: company.name,
        companySlug,
        entityName: company.name
      });
      for (const founder of company.founders ?? []) {
        index.set(`${catalog.slug}\u0000founder\u0000${founder.sourceKey}`, {
          companyId: company.sourceKey,
          companyName: company.name,
          companySlug,
          entityName: founder.name
        });
      }
    }
  }
  return index;
}

function catalogCompanySlug(sourceKey) {
  return String(sourceKey ?? "")
    .replace(/^company-/, "")
    .replace(/^a16z-speedrun-006-/, "");
}

async function loadReferenceRows({ rootPath, paths, maxArtifactBytes }) {
  const rows = [];
  for (const rawPath of paths) {
    const path = resolve(rootPath, rawPath);
    const source = await readBoundedJson(path, maxArtifactBytes, `reference ${rawPath}`);
    assertObject(source.value, `reference ${rawPath}`);
    if (!Array.isArray(source.value.evidence)) {
      throw new TypeError(`reference ${rawPath}.evidence must be an array.`);
    }
    rows.push(...source.value.evidence);
  }
  return rows;
}

async function writeStagingPackage({
  outputPath,
  stagedSnapshot,
  storedRows,
  adapterRejectedRows,
  dedupedRows,
  receipt
}) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(temporary, { recursive: false });
  try {
    const artifacts = {};
    artifacts.stagedPublicSnapshot = await writeJsonArtifact(
      temporary,
      "public-evidence-staged.json",
      stagedSnapshot,
      receipt.stagedAt
    );
    artifacts.storedUnpublished = await writeNdjsonArtifact(
      temporary,
      "historical-stored-unpublished.ndjson",
      storedRows,
      receipt.journal.observedAt
    );
    artifacts.adapterRejected = await writeNdjsonArtifact(
      temporary,
      "historical-adapter-rejected.ndjson",
      adapterRejectedRows,
      receipt.journal.observedAt
    );
    artifacts.deduplicated = await writeNdjsonArtifact(
      temporary,
      "historical-deduplicated.ndjson",
      dedupedRows,
      receipt.journal.observedAt
    );
    const manifest = { ...receipt, outputDir: outputPath, artifacts };
    await writeFile(join(temporary, "staging-manifest.json"), `${stableJson(manifest)}\n`, {
      mode: 0o600,
      flag: "wx"
    });
    await rename(temporary, outputPath);
    return { ...manifest, manifestPath: join(outputPath, "staging-manifest.json") };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function writeJsonArtifact(root, path, value, observedAt) {
  const destination = join(root, path);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(destination, body, { mode: 0o600, flag: "wx" });
  return descriptor(path, Buffer.byteLength(body), sha256(body), observedAt, "json");
}

async function writeNdjsonArtifact(root, path, rows, observedAt) {
  const destination = join(root, path);
  const stream = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for (const row of rows) {
      const line = `${stableJson(row)}\n`;
      hash.update(line);
      bytes += Buffer.byteLength(line);
      if (!stream.write(line)) await once(stream, "drain");
    }
    stream.end();
    await once(stream, "finish");
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return descriptor(path, bytes, hash.digest("hex"), observedAt, "ndjson", rows.length);
}

function descriptor(path, bytes, digest, observedAt, format, rows = null) {
  return {
    path,
    sha256: digest,
    bytes,
    observedAt: canonicalTimestamp(observedAt, `${path}.observedAt`),
    format,
    ...(rows === null ? {} : { rows })
  };
}

function validatePublicSnapshot(value, label, { requireOperationalLedgers = true } = {}) {
  assertObject(value, label);
  for (const field of ["evidence", "needsReview"]) {
    if (!Array.isArray(value[field])) throw new TypeError(`${label}.${field} must be an array.`);
  }
  if (requireOperationalLedgers) {
    if (!Array.isArray(value.failures ?? [])) throw new TypeError(`${label}.failures must be an array.`);
    if (!value.attempts || typeof value.attempts !== "object" || Array.isArray(value.attempts)) {
      throw new TypeError(`${label}.attempts must be an object.`);
    }
  }
}

function assertCanonicalLedgersPreserved(canonical, staged) {
  for (const key of [
    "evidence",
    "attributionReconciliationLedger",
    "failures",
    "attempts",
    "discoveryAttempts",
    "sourceDiscoveryPaths"
  ]) {
    if (stableJson(canonical[key] ?? (key === "attempts" ? {} : [])) !==
        stableJson(staged[key] ?? (key === "attempts" ? {} : []))) {
      throw new Error(`Staging unexpectedly changed canonical ${key}.`);
    }
  }
  const prefix = staged.needsReview.slice(0, canonical.needsReview.length);
  if (stableJson(prefix) !== stableJson(canonical.needsReview)) {
    throw new Error("Staging did not preserve the canonical review ledger prefix.");
  }
}

function rowIdSet(rows, label, { allowDuplicates = false } = {}) {
  const result = new Set();
  for (const row of rows ?? []) {
    const id = requiredText(row?.id, `${label} row.id`);
    if (!allowDuplicates && result.has(id)) throw new Error(`${label} contains duplicate id ${id}.`);
    result.add(id);
  }
  return result;
}

function normalizeRunnerTotals(value) {
  assertObject(value, "run_completed.summary.totals");
  return {
    accepted: nonNegativeInteger(value.accepted, "runner totals.accepted"),
    rejected: nonNegativeInteger(value.rejected, "runner totals.rejected"),
    duplicates: nonNegativeInteger(value.duplicates, "runner totals.duplicates")
  };
}

function summarizeByPlatform({ accepted, rejected, stored, deduped }) {
  const result = Object.fromEntries([...HISTORICAL_PLATFORMS].sort().map((platform) => [
    platform,
    { adapterAccepted: 0, adapterRejected: 0, storedButUnpublished: 0, deduped: 0 }
  ]));
  for (const row of accepted) result[row.platform].adapterAccepted += 1;
  for (const row of rejected) {
    const platform = targetPlatform(row.targetKey);
    if (result[platform]) result[platform].adapterRejected += 1;
  }
  for (const row of stored) result[row.platform].storedButUnpublished += 1;
  for (const row of deduped) result[row.platform].deduped += 1;
  return result;
}

function summarizeByBatch({ accepted, stored, deduped }) {
  const batches = new Set([
    ...accepted.map((row) => row.batchSlug),
    ...stored.map((row) => row.batchSlug),
    ...deduped.map((row) => row.batchSlug)
  ]);
  const result = Object.fromEntries([...batches].sort().map((batch) => [
    batch,
    { adapterAccepted: 0, storedButUnpublished: 0, deduped: 0 }
  ]));
  for (const row of accepted) result[row.batchSlug].adapterAccepted += 1;
  for (const row of stored) result[row.batchSlug].storedButUnpublished += 1;
  for (const row of deduped) result[row.batchSlug].deduped += 1;
  return result;
}

async function readBoundedJson(path, maxBytes, label) {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) throw new TypeError(`${label} must be a regular file.`);
  if (fileStat.size > maxBytes) throw new Error(`${label} exceeds maxArtifactBytes=${maxBytes}.`);
  const bytes = await readFile(path);
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    throw new Error(`${label} contains invalid JSON: ${error.message}`);
  }
}

async function assertPathDoesNotExist(path, label) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists: ${path}.`);
}

function normalizedPhysicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_|source$|si$|feature$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function hackerNewsId(value) {
  try {
    const url = new URL(value);
    return url.hostname === "news.ycombinator.com" && url.pathname === "/item" &&
      /^\d+$/.test(url.searchParams.get("id") ?? "")
      ? url.searchParams.get("id")
      : null;
  } catch {
    return null;
  }
}

function canonicalHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(requiredText(value, label));
  } catch {
    throw new TypeError(`${label} must be an absolute URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error(`${label} must use credential-free HTTPS and the default port.`);
  }
  return normalizedPhysicalUrl(url.toString());
}

function compareHistoricalRows(left, right) {
  return stagingPhysicalKey(left).localeCompare(stagingPhysicalKey(right)) ||
    left.id.localeCompare(right.id);
}

function targetPlatform(targetKey) {
  return String(targetKey ?? "").split(":").at(-1);
}

function requiredSha256(value, label) {
  const text = requiredText(value, label);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new TypeError(`${label} must be lowercase SHA-256.`);
  return text;
}

function canonicalTimestamp(value, label) {
  const text = requiredText(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new TypeError(`${label} must be a canonical ISO-8601 UTC timestamp.`);
  }
  return text;
}

function validateByteLimit(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("maxArtifactBytes must be a positive safe integer.");
  }
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return number;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
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
