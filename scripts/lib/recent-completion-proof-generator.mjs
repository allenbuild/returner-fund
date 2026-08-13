import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { normalizeAutonomousIngestionCatalogs } from
  "./ingestion-coverage-adapter.mjs";
import {
  INGESTION_CORE_PLATFORMS,
  INGESTION_RECENCY_WINDOW_DAYS
} from "./ingestion-coverage-receipt.mjs";
import { INGESTION_COVERAGE_CAMPAIGN_VERSION } from
  "./ingestion-coverage-campaign.mjs";
import { PUBLIC_INGESTION_PROOF_ARTIFACT_VERSION } from
  "./public-ingestion-proof-artifact.mjs";

export const RECENT_COMPLETION_PROOF_GENERATOR_VERSION =
  "recent-completion-proof-generator.v1";
export const RECENT_NATIVE_WINDOW_PROOF_VERSION =
  "recent-native-window-proof.v1";
export const RECENT_NATIVE_PAGE_RECEIPT_VERSION =
  "recent-native-page-receipt.v1";
export const RECENT_COMPLETION_MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;

const SHA256 = /^[a-f0-9]{64}$/;
const CORE_PLATFORM_SET = new Set(INGESTION_CORE_PLATFORMS);
const PROOF_KEYS = new Set([
  "schemaVersion",
  "status",
  "coverageScope",
  "coveredFrom",
  "coveredThrough",
  "checkedAt",
  "sourceExhausted",
  "nextCursor",
  "truncated",
  "limitReached",
  "pageLimit",
  "pagesAttempted",
  "pagesFetched",
  "blockers",
  "requestJournal"
]);
const JOURNAL_DESCRIPTOR_KEYS = new Set(["path", "sha256", "observedAt"]);
const PAGE_KEYS = new Set([
  "schemaVersion",
  "sequence",
  "attemptKey",
  "pairKey",
  "requestedAt",
  "completedAt",
  "requestUrl",
  "status",
  "cursorIn",
  "cursorOut",
  "sourceExhausted",
  "responseSha256",
  "coverageFrom",
  "coverageThrough"
]);

const CONTRACT_CHANGES = Object.freeze([
  "Emit recentWindowProof schema recent-native-window-proof.v1 on every native pair attempt, with coverageScope=pair_all_native_targets and exact coveredFrom, coveredThrough, and checkedAt timestamps.",
  "Persist and package a hash-pinned NDJSON request journal for each attempt; every row must use recent-native-page-receipt.v1 and preserve the native request URL, response digest, page sequence, cursor input/output, and exact covered interval.",
  "Record a contiguous cursor chain beginning with cursorIn=null and ending with cursorOut=null plus sourceExhausted=true; a checked-empty, numeric count, or collected row is not exhaustion proof.",
  "Record pageLimit, pagesAttempted, pagesFetched, truncated, limitReached, blockers, and request errors. Completion requires every page fetched successfully below the configured cap with no blocker or truncation.",
  "Reconcile every sibling attempt for an entity-platform pair. A pair is complete only when every native target/account attempt carries a compatible full-window proof.",
  "Pin one immutable recentCoverageCutoff no later than run start. Every native request must begin at or after that cutoff and prove the exact 90-day window through it; attempt and campaign completion may occur later."
]);

/**
 * Audit a hash-pinned prepared campaign and emit recent-backfill receipts only
 * when every native attempt for a canonical pair has a hash-pinned, gap-free
 * request journal covering the complete versioned recent window.
 */
export async function generateRecentCompletionProofs({
  root = process.cwd(),
  campaignManifestPath,
  expectedCampaignSha256,
  outputDir = null,
  dryRun = false,
  maxArtifactBytes = RECENT_COMPLETION_MAX_ARTIFACT_BYTES
} = {}) {
  const normalizedExpectedSha256 = requiredSha256(
    expectedCampaignSha256,
    "expectedCampaignSha256"
  );
  const maxBytes = positiveInteger(maxArtifactBytes, "maxArtifactBytes");
  if (maxBytes > RECENT_COMPLETION_MAX_ARTIFACT_BYTES) {
    throw new Error(
      `maxArtifactBytes cannot exceed ${RECENT_COMPLETION_MAX_ARTIFACT_BYTES}.`
    );
  }
  const rootPath = await realpath(resolve(root));
  const manifestPath = await realpath(resolveFromRoot(
    rootPath,
    requiredText(campaignManifestPath, "campaignManifestPath")
  ));
  const campaignRoot = await realpath(dirname(manifestPath));
  const outputPath = outputDir
    ? resolveFromRoot(rootPath, requiredText(outputDir, "outputDir"))
    : null;
  if (!dryRun && !outputPath) throw new Error("outputDir is required unless dryRun=true.");
  if (outputPath) await assertPathDoesNotExist(outputPath, "outputDir");

  const manifestFile = await readBoundedFile(manifestPath, maxBytes, "campaign manifest");
  if (manifestFile.sha256 !== normalizedExpectedSha256) {
    throw new Error(
      `Campaign manifest sha256 mismatch: expected ${normalizedExpectedSha256}, ` +
      `computed ${manifestFile.sha256}.`
    );
  }
  const manifest = parseJson(manifestFile.bytes, "campaign manifest");
  assertObject(manifest, "campaign manifest");
  if (![
    INGESTION_COVERAGE_CAMPAIGN_VERSION,
    PUBLIC_INGESTION_PROOF_ARTIFACT_VERSION
  ].includes(manifest.schemaVersion)) {
    throw new Error(`Unsupported recent-proof source schema ${manifest.schemaVersion}.`);
  }
  const generatedAt = canonicalTimestamp(manifest.generatedAt, "campaign.generatedAt");
  const coverageGeneratedAt = canonicalTimestamp(
    manifest.coverageGeneratedAt,
    "campaign.coverageGeneratedAt"
  );
  if (coverageGeneratedAt > generatedAt) {
    throw new Error("campaign.coverageGeneratedAt cannot exceed campaign.generatedAt.");
  }
  const coveredThrough = canonicalTimestamp(
    manifest.recentCoverageCutoff,
    "campaign.recentCoverageCutoff"
  );
  const coveredFrom = new Date(
    Date.parse(coveredThrough) -
      INGESTION_RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1_000
  ).toISOString();

  const runnerLogFile = await readDeclaredArtifact({
    campaignRoot,
    descriptor: manifest.artifacts?.runnerLog,
    maxBytes,
    label: "runner log"
  });
  const run = inspectRunnerLog(runnerLogFile.bytes, coverageGeneratedAt);
  if (coveredThrough > run.startedAt) {
    throw new Error(
      "campaign.recentCoverageCutoff must be pinned no later than run.startedAt."
    );
  }
  const catalogsFile = await readDeclaredArtifact({
    campaignRoot,
    descriptor: manifest.artifacts?.catalogs,
    maxBytes,
    label: "catalogs"
  });
  const catalogs = normalizeAutonomousIngestionCatalogs(
    parseJson(catalogsFile.bytes, "catalogs")
  );
  const matrix = canonicalCoreMatrix(catalogs);

  const collectorDescriptors = manifest.artifacts?.collectors;
  if (!Array.isArray(collectorDescriptors) || collectorDescriptors.length === 0) {
    throw new Error("Campaign must declare at least one collector artifact.");
  }
  const attemptsByPair = new Map([...matrix.keys()].map((pairKey) => [pairKey, []]));
  const collectorSources = [];
  let collectorAttemptRows = 0;
  for (const descriptor of collectorDescriptors) {
    const collectorFile = await readDeclaredArtifact({
      campaignRoot,
      descriptor,
      maxBytes,
      label: `collector ${descriptor?.path ?? "unknown"}`
    });
    const collector = parseJson(collectorFile.bytes, `collector ${descriptor.path}`);
    assertObject(collector, `collector ${descriptor.path}`);
    assertObject(collector.attempts, `collector ${descriptor.path}.attempts`);
    const sourceBatchSlug = optionalText(collector.source?.batchSlug);
    let rows = 0;
    for (const [objectKey, rawAttempt] of Object.entries(collector.attempts)) {
      assertObject(rawAttempt, `${descriptor.path}.attempts.${objectKey}`);
      const attempt = normalizeAttempt({
        rawAttempt,
        objectKey,
        sourceBatchSlug,
        descriptor
      });
      const bucket = attemptsByPair.get(attempt.pairKey);
      if (!bucket) {
        throw new Error(
          `${attempt.reference} maps to non-canonical core pair ${attempt.pairKey}.`
        );
      }
      bucket.push(attempt);
      rows += 1;
      collectorAttemptRows += 1;
    }
    collectorSources.push({
      path: descriptor.path,
      sha256: collectorFile.sha256,
      observedAt: canonicalTimestamp(descriptor.observedAt, `${descriptor.path}.observedAt`),
      attemptRows: rows
    });
  }
  collectorSources.sort((left, right) => left.path.localeCompare(right.path));

  const requestJournalCache = new Map();
  const proofs = [];
  const exclusions = [];
  for (const [pairKey, identity] of matrix) {
    const attempts = attemptsByPair.get(pairKey);
    const audit = await auditPairAttempts({
      pairKey,
      attempts,
      campaignRoot,
      run,
      coveredFrom,
      coveredThrough,
      maxBytes,
      requestJournalCache
    });
    if (!audit.eligible) {
      exclusions.push({
        ...identity,
        pairKey,
        attemptRows: attempts.length,
        proofBearingAttemptRows: attempts.filter((attempt) => attempt.proof).length,
        completedAttemptRows: attempts.filter((attempt) =>
          attempt.outcomeStatus === "completed"
        ).length,
        earliestCheckedAt: earliest(attempts.map((attempt) => attempt.checkedAt)),
        latestCheckedAt: latest(attempts.map((attempt) => attempt.checkedAt)),
        reasons: audit.reasons,
        attemptReferences: attempts.map((attempt) => attempt.reference).sort(),
        nextAction: nextActionFor(audit.reasons, pairKey)
      });
      continue;
    }
    const receipt = recentReceipt({
      campaignSha256: manifestFile.sha256,
      pairKey,
      coveredFrom,
      coveredThrough,
      checkedAt: run.completedAt,
      attempts: audit.validatedAttempts
    });
    proofs.push({
      ...identity,
      pairKey,
      receipt,
      sourceAttempts: audit.validatedAttempts.map((attempt) => ({
        collectorPath: attempt.collectorPath,
        collectorSha256: attempt.collectorSha256,
        attemptKey: attempt.attemptKey,
        requestJournalPath: attempt.requestJournal.path,
        requestJournalSha256: attempt.requestJournal.sha256
      })).sort(compareSourceAttempt)
    });
  }
  proofs.sort((left, right) => left.pairKey.localeCompare(right.pairKey));
  exclusions.sort((left, right) => left.pairKey.localeCompare(right.pairKey));

  const summary = summarize({ matrix, attemptsByPair, proofs, exclusions });
  const proofBody = `${stableJson(proofs)}\n`;
  const exclusionDocument = {
    schemaVersion: RECENT_COMPLETION_PROOF_GENERATOR_VERSION,
    campaignSha256: manifestFile.sha256,
    coveredFrom,
    coveredThrough,
    rows: exclusions
  };
  const exclusionBody = `${stableJson(exclusionDocument)}\n`;
  const proofDescriptor = descriptor({
    path: "recent-completion-proofs.json",
    body: proofBody,
    rows: proofs.length,
    observedAt: generatedAt
  });
  const exclusionDescriptor = descriptor({
    path: "recent-completion-exclusions.json",
    body: exclusionBody,
    rows: exclusions.length,
    observedAt: generatedAt
  });

  let mergedPairScopes = null;
  let pairScopesBody = null;
  let pairScopesDescriptor = null;
  const basePairScopesDescriptor = manifest.artifacts?.pairScopes ?? null;
  if (proofs.length > 0 && basePairScopesDescriptor) {
    const basePairScopesFile = await readDeclaredArtifact({
      campaignRoot,
      descriptor: basePairScopesDescriptor,
      maxBytes,
      label: "base pair scopes"
    });
    mergedPairScopes = mergePairScopes({
      rawRows: parseJson(basePairScopesFile.bytes, "base pair scopes"),
      matrix,
      proofs
    });
    pairScopesBody = `${stableJson(mergedPairScopes)}\n`;
    pairScopesDescriptor = descriptor({
      path: "pair-scopes.json",
      body: pairScopesBody,
      rows: mergedPairScopes.length,
      observedAt: generatedAt
    });
  }

  const manifestOutput = {
    schemaVersion: RECENT_COMPLETION_PROOF_GENERATOR_VERSION,
    status: proofs.length > 0 ? "generated_verified" : "no_qualifying_pairs",
    generatedAt,
    window: { coveredFrom, coveredThrough },
    run,
    sourceCampaign: {
      path: portablePath(rootPath, manifestPath),
      sha256: manifestFile.sha256,
      schemaVersion: manifest.schemaVersion,
      collectors: collectorSources
    },
    denominator: {
      canonicalCorePairs: matrix.size,
      collectorAttemptRows,
      pairsWithNativeAttempts: [...attemptsByPair.values()].filter((rows) => rows.length > 0).length,
      pairsWithoutNativeAttempts: [...attemptsByPair.values()].filter((rows) => rows.length === 0).length,
      completionEligiblePairs: proofs.length,
      excludedPairs: exclusions.length
    },
    summary,
    contractChangesRequired: CONTRACT_CHANGES,
    packagingDecision: proofs.length > 0 && pairScopesDescriptor
      ? "A merged pair-scopes artifact was generated and is eligible for a new immutable campaign package."
      : proofs.length > 0
        ? "Verified recent receipts were generated from the public-safe journal artifact; merge them into a separately authenticated private pair-scopes package before campaign materialization."
      : "No recent completion receipts were generated; do not create a new campaign package from this audit.",
    artifacts: {
      recentCompletionProofs: proofDescriptor,
      recentCompletionExclusions: exclusionDescriptor,
      ...(pairScopesDescriptor ? { pairScopes: pairScopesDescriptor } : {})
    }
  };
  const manifestBody = `${stableJson(manifestOutput)}\n`;
  const outputManifestDescriptor = descriptor({
    path: "recent-completion-proof-manifest.json",
    body: manifestBody,
    rows: 1,
    observedAt: generatedAt
  });

  if (!dryRun) {
    await writeImmutablePackage({
      outputPath,
      files: [
        [proofDescriptor.path, proofBody],
        [exclusionDescriptor.path, exclusionBody],
        ...(pairScopesDescriptor ? [[pairScopesDescriptor.path, pairScopesBody]] : []),
        [outputManifestDescriptor.path, manifestBody]
      ]
    });
  }
  return {
    schemaVersion: RECENT_COMPLETION_PROOF_GENERATOR_VERSION,
    status: manifestOutput.status,
    outputDir: outputPath,
    window: manifestOutput.window,
    denominator: manifestOutput.denominator,
    summary,
    contractChangesRequired: CONTRACT_CHANGES,
    packagingDecision: manifestOutput.packagingDecision,
    artifacts: {
      ...manifestOutput.artifacts,
      manifest: outputManifestDescriptor
    },
    dryRun
  };
}

function canonicalCoreMatrix(catalogs) {
  const matrix = new Map();
  for (const catalog of catalogs) {
    for (const company of catalog.companies) {
      addEntity(matrix, catalog.batchSlug, "company", company.id);
      for (const founder of company.founders) {
        addEntity(matrix, catalog.batchSlug, "founder", founder.id);
      }
    }
  }
  return new Map([...matrix].sort(([left], [right]) => left.localeCompare(right)));
}

function addEntity(matrix, batchSlug, entityType, entityId) {
  for (const platform of INGESTION_CORE_PLATFORMS) {
    const identity = { batchSlug, entityType, entityId, platform };
    const pairKey = pairKeyFor(identity);
    if (matrix.has(pairKey)) throw new Error(`Duplicate canonical pair ${pairKey}.`);
    matrix.set(pairKey, identity);
  }
}

function normalizeAttempt({ rawAttempt, objectKey, sourceBatchSlug, descriptor }) {
  const batchSlug = requiredText(
    rawAttempt.batchSlug ?? sourceBatchSlug,
    `${descriptor.path}.${objectKey}.batchSlug`
  );
  const platform = requiredText(rawAttempt.platform, `${descriptor.path}.${objectKey}.platform`)
    .toLowerCase();
  if (!CORE_PLATFORM_SET.has(platform)) {
    throw new Error(`${descriptor.path}.${objectKey} has unsupported core platform ${platform}.`);
  }
  const entityType = requiredText(
    rawAttempt.entityType,
    `${descriptor.path}.${objectKey}.entityType`
  );
  if (!new Set(["company", "founder"]).has(entityType)) {
    throw new Error(`${descriptor.path}.${objectKey} has unsupported entityType ${entityType}.`);
  }
  const entityId = requiredText(rawAttempt.entityId, `${descriptor.path}.${objectKey}.entityId`);
  const checkedAt = optionalCanonicalTimestamp(
    rawAttempt.checkedAt,
    `${descriptor.path}.${objectKey}.checkedAt`
  );
  return {
    pairKey: pairKeyFor({ batchSlug, entityType, entityId, platform }),
    batchSlug,
    entityType,
    entityId,
    platform,
    attemptKey: requiredText(
      rawAttempt.attemptKey ?? objectKey,
      `${descriptor.path}.${objectKey}.attemptKey`
    ),
    objectKey,
    reference: `${descriptor.path}#${objectKey}`,
    collectorPath: descriptor.path,
    collectorSha256: requiredSha256(descriptor.sha256, `${descriptor.path}.sha256`),
    status: optionalText(rawAttempt.status),
    outcomeStatus: optionalText(rawAttempt.outcomeStatus),
    checkedAt,
    recentWindowCoverageCutoff: optionalCanonicalTimestamp(
      rawAttempt.recentWindowCoverageCutoff,
      `${descriptor.path}.${objectKey}.recentWindowCoverageCutoff`
    ),
    error: optionalText(rawAttempt.error),
    blocker: optionalText(rawAttempt.blocker),
    proof: rawAttempt.recentWindowProof ?? null,
    legacyWindowFields: [
      "coveredFrom",
      "coveredThrough",
      "sourceExhausted",
      "nextCursor",
      "truncated",
      "limitReached"
    ].some((key) => Object.hasOwn(rawAttempt, key))
  };
}

async function auditPairAttempts({
  pairKey,
  attempts,
  campaignRoot,
  run,
  coveredFrom,
  coveredThrough,
  maxBytes,
  requestJournalCache
}) {
  if (attempts.length === 0) {
    return { eligible: false, reasons: ["no_native_collector_attempt"] };
  }
  const reasons = new Set();
  const validatedAttempts = [];
  if (attempts.some((attempt) => !attempt.checkedAt)) {
    reasons.add("attempt_checked_at_missing");
  }
  if (attempts.some((attempt) =>
    attempt.checkedAt && attempt.checkedAt < coveredThrough
  )) {
    reasons.add("attempt_checked_before_window_end");
  }
  if (attempts.some((attempt) =>
    attempt.recentWindowCoverageCutoff !== coveredThrough
  )) {
    reasons.add("attempt_immutable_cutoff_mismatch");
  }
  if (attempts.some((attempt) => !attempt.proof)) {
    reasons.add("attempt_contract_missing_recent_window_proof");
  }
  for (const attempt of attempts.filter((candidate) => candidate.proof)) {
    const audit = await auditAttemptProof({
      pairKey,
      attempt,
      campaignRoot,
      run,
      coveredFrom,
      coveredThrough,
      maxBytes,
      requestJournalCache
    });
    for (const reason of audit.reasons) reasons.add(reason);
    if (audit.validated) validatedAttempts.push(audit.validated);
  }
  if (validatedAttempts.length !== attempts.length) {
    reasons.add("not_every_sibling_attempt_is_proved");
  }
  return {
    eligible: reasons.size === 0,
    reasons: [...reasons].sort(),
    validatedAttempts
  };
}

async function auditAttemptProof({
  pairKey,
  attempt,
  campaignRoot,
  run,
  coveredFrom,
  coveredThrough,
  maxBytes,
  requestJournalCache
}) {
  const proof = attempt.proof;
  assertObject(proof, `${attempt.reference}.recentWindowProof`);
  assertKnownKeys(proof, PROOF_KEYS, `${attempt.reference}.recentWindowProof`);
  const reasons = new Set();
  if (proof.schemaVersion !== RECENT_NATIVE_WINDOW_PROOF_VERSION) {
    reasons.add("proof_schema_incompatible");
  }
  if (proof.status !== "complete") reasons.add("proof_status_not_complete");
  if (proof.coverageScope !== "pair_all_native_targets") {
    reasons.add("proof_scope_not_pair_complete");
  }
  const proofCoveredFrom = safeTimestamp(
    proof.coveredFrom,
    `${attempt.reference}.coveredFrom`,
    reasons,
    "proof_covered_from_invalid"
  );
  const proofCoveredThrough = safeTimestamp(
    proof.coveredThrough,
    `${attempt.reference}.coveredThrough`,
    reasons,
    "proof_covered_through_invalid"
  );
  const proofCheckedAt = safeTimestamp(
    proof.checkedAt,
    `${attempt.reference}.checkedAt`,
    reasons,
    "proof_checked_at_invalid"
  );
  if (proofCoveredFrom && proofCoveredFrom !== coveredFrom) {
    reasons.add("proof_window_start_gap");
  }
  if (proofCoveredThrough && proofCoveredThrough !== coveredThrough) {
    reasons.add("proof_window_end_gap");
  }
  if (proofCheckedAt && proofCheckedAt !== attempt.checkedAt) {
    reasons.add("proof_checked_at_attempt_mismatch");
  }
  if (proofCheckedAt && proofCheckedAt < coveredThrough) {
    reasons.add("proof_checked_before_coverage_cutoff");
  }
  if (
    proofCheckedAt &&
    (proofCheckedAt < run.startedAt || proofCheckedAt > run.completedAt)
  ) {
    reasons.add("proof_checked_at_outside_run");
  }
  if (proof.sourceExhausted !== true) reasons.add("source_not_exhausted");
  if (proof.nextCursor !== null) reasons.add("cursor_remaining");
  if (proof.truncated !== false) reasons.add("history_truncated");
  if (proof.limitReached !== false) reasons.add("page_limit_reached_or_ambiguous");
  if (attempt.status !== "done" || attempt.outcomeStatus !== "completed") {
    reasons.add("attempt_not_successfully_completed");
  }
  if (attempt.error || attempt.blocker) reasons.add("attempt_blocker_or_error_present");
  const blockers = normalizeTextArray(proof.blockers, `${attempt.reference}.blockers`);
  if (blockers.length > 0) reasons.add("proof_blocker_present");
  const pageLimit = safePositiveInteger(
    proof.pageLimit,
    `${attempt.reference}.pageLimit`,
    reasons,
    "page_limit_invalid"
  );
  const pagesAttempted = safeNonNegativeInteger(
    proof.pagesAttempted,
    `${attempt.reference}.pagesAttempted`,
    reasons,
    "pages_attempted_invalid"
  );
  const pagesFetched = safeNonNegativeInteger(
    proof.pagesFetched,
    `${attempt.reference}.pagesFetched`,
    reasons,
    "pages_fetched_invalid"
  );
  if (pagesAttempted !== null && pagesFetched !== null && pagesAttempted !== pagesFetched) {
    reasons.add("not_every_attempted_page_was_fetched");
  }
  if (pageLimit !== null && pagesFetched !== null && pagesFetched >= pageLimit) {
    reasons.add("page_limit_reached_or_ambiguous");
  }

  let requestJournal = null;
  try {
    requestJournal = normalizeJournalDescriptor(
      proof.requestJournal,
      `${attempt.reference}.requestJournal`
    );
  } catch {
    reasons.add("request_journal_descriptor_invalid");
  }
  let journalAudit = null;
  if (requestJournal) {
    journalAudit = await auditRequestJournal({
      campaignRoot,
      descriptor: requestJournal,
      attempt,
      pairKey,
      run,
      coveredFrom,
      coveredThrough,
      maxBytes,
      cache: requestJournalCache
    });
    for (const reason of journalAudit.reasons) reasons.add(reason);
    if (requestJournal.observedAt !== proofCheckedAt) {
      reasons.add("request_journal_observation_not_checked_at");
    }
    if (pagesAttempted !== null && journalAudit.rows !== pagesAttempted) {
      reasons.add("request_journal_page_count_mismatch");
    }
  }
  return {
    reasons: [...reasons].sort(),
    validated: reasons.size === 0 ? {
      collectorPath: attempt.collectorPath,
      collectorSha256: attempt.collectorSha256,
      attemptKey: attempt.attemptKey,
      checkedAt: proofCheckedAt,
      requestJournal: {
        ...requestJournal,
        rows: journalAudit.rows
      }
    } : null
  };
}

async function auditRequestJournal({
  campaignRoot,
  descriptor,
  attempt,
  pairKey,
  run,
  coveredFrom,
  coveredThrough,
  maxBytes,
  cache
}) {
  const cacheKey = stableJson(descriptor);
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    return auditPageRows(cached.rows, {
      attempt,
      pairKey,
      run,
      coveredFrom,
      coveredThrough,
      descriptor
    });
  }
  const reasons = [];
  let file;
  try {
    const path = await resolveDeclaredPath(campaignRoot, descriptor.path, "request journal");
    file = await readBoundedFile(path, maxBytes, `request journal ${descriptor.path}`);
  } catch {
    return { rows: 0, reasons: ["request_journal_unreadable"] };
  }
  if (file.sha256 !== descriptor.sha256) {
    return { rows: 0, reasons: ["request_journal_sha256_mismatch"] };
  }
  let rows;
  try {
    rows = parseNdjson(file.bytes, `request journal ${descriptor.path}`);
  } catch {
    return { rows: 0, reasons: ["request_journal_invalid_ndjson"] };
  }
  cache.set(cacheKey, { rows });
  const audit = auditPageRows(rows, {
    attempt,
    pairKey,
    run,
    coveredFrom,
    coveredThrough,
    descriptor
  });
  return { rows: rows.length, reasons: [...new Set([...reasons, ...audit.reasons])].sort() };
}

function auditPageRows(rows, context) {
  const reasons = new Set();
  if (rows.length === 0) return { rows: 0, reasons: ["request_journal_empty"] };
  let previousCursor = null;
  const intervals = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    try {
      assertObject(row, `request journal row ${index + 1}`);
      assertKnownKeys(row, PAGE_KEYS, `request journal row ${index + 1}`);
      if (row.schemaVersion !== RECENT_NATIVE_PAGE_RECEIPT_VERSION) {
        reasons.add("page_receipt_schema_incompatible");
      }
      if (positiveInteger(row.sequence, `row ${index + 1}.sequence`) !== index + 1) {
        reasons.add("page_sequence_gap");
      }
      if (requiredText(row.attemptKey, `row ${index + 1}.attemptKey`) !==
          context.attempt.attemptKey) {
        reasons.add("page_attempt_identity_mismatch");
      }
      if (requiredText(row.pairKey, `row ${index + 1}.pairKey`) !== context.pairKey) {
        reasons.add("page_pair_identity_mismatch");
      }
      const requestedAt = canonicalTimestamp(row.requestedAt, `row ${index + 1}.requestedAt`);
      const completedAt = canonicalTimestamp(row.completedAt, `row ${index + 1}.completedAt`);
      if (requestedAt < context.run.startedAt || completedAt > context.run.completedAt ||
          completedAt < requestedAt) {
        reasons.add("page_timing_outside_run");
      }
      if (requestedAt < context.coveredThrough) {
        reasons.add("page_requested_before_coverage_cutoff");
      }
      requireHttpsUrl(row.requestUrl, `row ${index + 1}.requestUrl`);
      if (row.status !== "success") reasons.add("page_request_not_successful");
      requiredSha256(row.responseSha256, `row ${index + 1}.responseSha256`);
      const cursorIn = nullableText(row.cursorIn, `row ${index + 1}.cursorIn`);
      const cursorOut = nullableText(row.cursorOut, `row ${index + 1}.cursorOut`);
      if (cursorIn !== previousCursor) reasons.add("cursor_chain_gap");
      previousCursor = cursorOut;
      const from = canonicalTimestamp(row.coverageFrom, `row ${index + 1}.coverageFrom`);
      const through = canonicalTimestamp(row.coverageThrough, `row ${index + 1}.coverageThrough`);
      if (from > through) reasons.add("page_coverage_interval_invalid");
      intervals.push({ from, through });
      if (index < rows.length - 1 && row.sourceExhausted !== false) {
        reasons.add("source_exhausted_before_final_page");
      }
      if (index === rows.length - 1 && row.sourceExhausted !== true) {
        reasons.add("final_page_not_source_exhausted");
      }
    } catch {
      reasons.add("page_receipt_structurally_invalid");
    }
  }
  if (previousCursor !== null) reasons.add("cursor_remaining");
  if (!intervalsCoverWindow(intervals, context.coveredFrom, context.coveredThrough)) {
    reasons.add("page_coverage_time_gap");
  }
  return { rows: rows.length, reasons: [...reasons].sort() };
}

function intervalsCoverWindow(intervals, coveredFrom, coveredThrough) {
  if (intervals.length === 0) return false;
  const sorted = [...intervals].sort((left, right) =>
    left.from.localeCompare(right.from) || left.through.localeCompare(right.through)
  );
  if (sorted[0].from !== coveredFrom) return false;
  let frontier = sorted[0].through;
  for (const interval of sorted.slice(1)) {
    if (interval.from > frontier) return false;
    if (interval.through > frontier) frontier = interval.through;
  }
  return frontier === coveredThrough;
}

function recentReceipt({
  campaignSha256,
  pairKey,
  coveredFrom,
  coveredThrough,
  checkedAt,
  attempts
}) {
  const sourceBindings = attempts.map((attempt) => ({
    collectorSha256: attempt.collectorSha256,
    attemptKey: attempt.attemptKey,
    requestJournalSha256: attempt.requestJournal.sha256
  })).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const receiptId = `recent-${sha256(stableJson({
    version: RECENT_COMPLETION_PROOF_GENERATOR_VERSION,
    campaignSha256,
    pairKey,
    coveredFrom,
    coveredThrough,
    sourceBindings
  })).slice(0, 40)}`;
  return {
    receiptId,
    status: "complete",
    checkedAt,
    coveredFrom,
    coveredThrough,
    reason:
      `Every hash-pinned native request journal for ${attempts.length} sibling attempt(s) ` +
      "has contiguous time segments, a gap-free cursor chain, an explicit terminal native " +
      "boundary, and no blocker, cap, or truncation."
  };
}

function mergePairScopes({ rawRows, matrix, proofs }) {
  if (!Array.isArray(rawRows)) throw new TypeError("base pair scopes must be an array.");
  const proofByPair = new Map(proofs.map((proof) => [proof.pairKey, proof.receipt]));
  const seen = new Set();
  const output = rawRows.map((rawRow, index) => {
    assertObject(rawRow, `base pair scope ${index}`);
    const pairKey = pairKeyFor(rawRow);
    if (seen.has(pairKey)) throw new Error(`Duplicate base pair scope ${pairKey}.`);
    seen.add(pairKey);
    const receipt = proofByPair.get(pairKey);
    if (!receipt) return structuredClone(rawRow);
    const scope = isObject(rawRow.scope) ? structuredClone(rawRow.scope) : {};
    if (scope.recentBackfillReceipt) {
      throw new Error(`${pairKey} already has a recentBackfillReceipt.`);
    }
    scope.recentBackfillReceipt = structuredClone(receipt);
    proofByPair.delete(pairKey);
    return { ...structuredClone(rawRow), scope };
  });
  for (const pairKey of matrix.keys()) {
    if (!seen.has(pairKey)) throw new Error(`Base pair scopes omit canonical core pair ${pairKey}.`);
  }
  if (proofByPair.size > 0) {
    throw new Error(`Base pair scopes omit ${proofByPair.size} proofed pair(s).`);
  }
  output.sort((left, right) => pairKeyFor(left).localeCompare(pairKeyFor(right)));
  return output;
}

function summarize({ matrix, attemptsByPair, proofs, exclusions }) {
  const eligible = new Set(proofs.map((proof) => proof.pairKey));
  const exclusionsByPair = new Map(exclusions.map((row) => [row.pairKey, row]));
  const byPlatform = {};
  const byBatch = {};
  for (const [pairKey, identity] of matrix) {
    const attempts = attemptsByPair.get(pairKey);
    incrementSummary(byPlatform, identity.platform, attempts, eligible.has(pairKey));
    incrementSummary(byBatch, identity.batchSlug, attempts, eligible.has(pairKey));
  }
  const exclusionReasons = {};
  for (const row of exclusionsByPair.values()) {
    for (const reason of row.reasons) {
      exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1;
    }
  }
  return {
    byPlatform: sortedObject(byPlatform),
    byBatch: sortedObject(byBatch),
    exclusionReasons: sortedObject(exclusionReasons)
  };
}

function incrementSummary(output, key, attempts, isEligible) {
  const row = output[key] ??= {
    canonicalPairs: 0,
    pairsWithNativeAttempts: 0,
    pairsWithoutNativeAttempts: 0,
    attemptRows: 0,
    completedAttemptRows: 0,
    proofBearingAttemptRows: 0,
    legacyWindowFieldAttemptRows: 0,
    completionEligiblePairs: 0,
    excludedPairs: 0,
    latestCheckedAt: null
  };
  row.canonicalPairs += 1;
  row[attempts.length > 0 ? "pairsWithNativeAttempts" : "pairsWithoutNativeAttempts"] += 1;
  row.attemptRows += attempts.length;
  row.completedAttemptRows += attempts.filter((attempt) =>
    attempt.outcomeStatus === "completed"
  ).length;
  row.proofBearingAttemptRows += attempts.filter((attempt) => attempt.proof).length;
  row.legacyWindowFieldAttemptRows += attempts.filter((attempt) =>
    attempt.legacyWindowFields
  ).length;
  row[isEligible ? "completionEligiblePairs" : "excludedPairs"] += 1;
  row.latestCheckedAt = latest([
    row.latestCheckedAt,
    ...attempts.map((attempt) => attempt.checkedAt)
  ]);
}

function nextActionFor(reasons, pairKey) {
  if (reasons.includes("no_native_collector_attempt")) {
    return `Create and run an exact native target for ${pairKey}, then persist the versioned request journal.`;
  }
  if (reasons.includes("attempt_contract_missing_recent_window_proof")) {
    return `Rerun every native attempt for ${pairKey} after the immutable recent cutoff with recent-native-window-proof.v1 and hash-pinned page receipts through that exact cutoff.`;
  }
  return `Resolve ${reasons.join(", ")} for ${pairKey} and rerun the fail-closed recent proof audit.`;
}

function inspectRunnerLog(bytes, expectedCompletedAt) {
  const rows = parseNdjson(bytes, "runner log");
  const started = rows.filter((row) => row.eventType === "run.started");
  const completed = rows.filter((row) => row.eventType === "run.completed");
  if (started.length !== 1 || completed.length !== 1) {
    throw new Error("Runner log must contain exactly one run.started and run.completed.");
  }
  const startedAt = canonicalTimestamp(started[0].createdAt, "run.started.createdAt");
  const completedAt = canonicalTimestamp(completed[0].createdAt, "run.completed.createdAt");
  if (completedAt !== expectedCompletedAt || startedAt > completedAt) {
    throw new Error("Runner log timing does not reconcile with campaign coverageGeneratedAt.");
  }
  return { startedAt, completedAt };
}

async function readDeclaredArtifact({ campaignRoot, descriptor, maxBytes, label }) {
  assertObject(descriptor, `${label} descriptor`);
  const path = await resolveDeclaredPath(
    campaignRoot,
    requiredText(descriptor.path, `${label}.path`),
    label
  );
  const file = await readBoundedFile(path, maxBytes, label);
  const expectedSha256 = requiredSha256(descriptor.sha256, `${label}.sha256`);
  if (file.sha256 !== expectedSha256) {
    throw new Error(`${label} sha256 mismatch: expected ${expectedSha256}, got ${file.sha256}.`);
  }
  return { ...file, path };
}

async function resolveDeclaredPath(campaignRoot, rawPath, label) {
  const resolved = resolve(campaignRoot, requiredText(rawPath, `${label}.path`));
  if (!isWithin(campaignRoot, resolved)) {
    throw new Error(`${label} path escapes the campaign root.`);
  }
  const actual = await realpath(resolved);
  if (!isWithin(campaignRoot, actual)) {
    throw new Error(`${label} resolves outside the campaign root.`);
  }
  return actual;
}

async function readBoundedFile(path, maxBytes, label) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file.`);
  if (metadata.size > maxBytes) {
    throw new Error(`${label} exceeds maxArtifactBytes=${maxBytes}.`);
  }
  const bytes = await readFile(path);
  if (bytes.length !== metadata.size) throw new Error(`${label} changed while being read.`);
  return { bytes, sha256: sha256(bytes) };
}

function normalizeJournalDescriptor(value, label) {
  assertObject(value, label);
  assertKnownKeys(value, JOURNAL_DESCRIPTOR_KEYS, label);
  return {
    path: requiredText(value.path, `${label}.path`),
    sha256: requiredSha256(value.sha256, `${label}.sha256`),
    observedAt: canonicalTimestamp(value.observedAt, `${label}.observedAt`)
  };
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function parseNdjson(bytes, label) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error(`${label} must end with a newline.`);
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) throw new Error(`${label} contains a blank row.`);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${label} row ${index + 1} is not valid JSON.`);
    }
  });
}

async function writeImmutablePackage({ outputPath, files }) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(temporaryPath, { recursive: false, mode: 0o700 });
  try {
    await Promise.all(files.map(([path, body]) =>
      writeFile(resolve(temporaryPath, path), body, { flag: "wx", mode: 0o600 })
    ));
    await assertPathDoesNotExist(outputPath, "outputDir");
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true });
    throw error;
  }
}

async function assertPathDoesNotExist(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists: ${path}`);
}

function descriptor({ path, body, rows, observedAt }) {
  return {
    path,
    format: "json",
    rows,
    bytes: Buffer.byteLength(body),
    sha256: sha256(body),
    observedAt
  };
}

function compareSourceAttempt(left, right) {
  return left.collectorPath.localeCompare(right.collectorPath) ||
    left.attemptKey.localeCompare(right.attemptKey);
}

function safeTimestamp(value, label, reasons, reason) {
  try {
    return canonicalTimestamp(value, label);
  } catch {
    reasons.add(reason);
    return null;
  }
}

function safePositiveInteger(value, label, reasons, reason) {
  try {
    return positiveInteger(value, label);
  } catch {
    reasons.add(reason);
    return null;
  }
}

function safeNonNegativeInteger(value, label, reasons, reason) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    reasons.add(reason);
    return null;
  }
  return number;
}

function normalizeTextArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return [...new Set(value.map((entry, index) =>
    requiredText(entry, `${label}[${index}]`)
  ))].sort();
}

function pairKeyFor(value) {
  return [
    requiredText(value.batchSlug, "pair.batchSlug"),
    requiredText(value.entityType, "pair.entityType"),
    requiredText(value.entityId, "pair.entityId"),
    requiredText(value.platform, "pair.platform").toLowerCase()
  ].join(":");
}

function earliest(values) {
  return values.filter(Boolean).sort()[0] ?? null;
}

function latest(values) {
  return values.filter(Boolean).sort().at(-1) ?? null;
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right)
  ));
}

function requireHttpsUrl(value, label) {
  const text = requiredText(value, label);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError(`${label} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new TypeError(`${label} must be a credential-free HTTPS URL.`);
  }
  for (const key of new Set(url.searchParams.keys())) {
    if (
      /^(?:access[_-]?token|api[_-]?key|auth|authorization|bearer|cookie|credential|key|password|secret|session(?:id)?|sig(?:nature)?|token|x-api-key)$/i.test(key) ||
      url.searchParams.getAll(key).length !== 1
    ) {
      throw new TypeError(`${label} contains a forbidden or duplicate query parameter.`);
    }
  }
  return text;
}

function nullableText(value, label) {
  if (value === null) return null;
  return requiredText(value, label);
}

function optionalCanonicalTimestamp(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return canonicalTimestamp(value, label);
}

function canonicalTimestamp(value, label) {
  const text = requiredText(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  }
  return text;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return number;
}

function requiredSha256(value, label) {
  const text = requiredText(value, label);
  if (!SHA256.test(text)) throw new TypeError(`${label} must be a lowercase SHA-256.`);
  return text;
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function optionalText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function assertObject(value, label) {
  if (!isObject(value)) throw new TypeError(`${label} must be an object.`);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field ${key}.`);
  }
}

function isWithin(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function resolveFromRoot(root, path) {
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

function portablePath(root, path) {
  const rel = relative(root, path);
  return isWithin(root, path) ? rel : path;
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
