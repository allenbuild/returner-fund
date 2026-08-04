import { createHash } from "node:crypto";

export const INGESTION_COVERAGE_SCHEMA_VERSION = "ingestion-coverage.v1";
export const INGESTION_CATALOG_MANIFEST_VERSION = "ingestion-catalog-manifest.v1";
export const INGESTION_RECENCY_POLICY_VERSION = "ingestion-recency.v1";
export const INGESTION_RECENCY_WINDOW_DAYS = 90;
export const INGESTION_TIMESTAMP_FUTURE_TOLERANCE_MS = 5 * 60_000;
export const INGESTION_RUN_COMPLETION_FRESHNESS_MS = 5 * 60_000;

export const INGESTION_CORE_PLATFORMS = Object.freeze([
  "github",
  "x",
  "instagram",
  "linkedin",
  "youtube",
  "product_hunt",
  "reddit",
  "hacker_news",
  "rss",
  "web"
]);

export const INGESTION_EXTENDED_ONLY_PLATFORMS = Object.freeze([
  "bilibili",
  "tiktok",
  "bluesky"
]);

export const INGESTION_COVERAGE_TERMINAL_STATUSES = Object.freeze([
  "collected",
  "verified_no_account",
  "blocked",
  "queued"
]);

export const INGESTION_BLOCKER_REASON_CODES = Object.freeze([
  "access_denied",
  "network_error",
  "captcha_required",
  "rate_limited",
  "multiple_access_blocks"
]);

export const INGESTION_QUEUED_REASON_CODES = Object.freeze([
  "missing_credentials",
  "manual_review_required",
  "no_match",
  "collector_unavailable",
  "not_applicable",
  "no_current_attempt",
  "missing_native_evidence",
  "ambiguous_legacy_outcome",
  "missing_exact_reason"
]);

const ALL_PLATFORMS = Object.freeze([
  ...INGESTION_CORE_PLATFORMS,
  ...INGESTION_EXTENDED_ONLY_PLATFORMS
]);
const ALL_PLATFORM_SET = new Set(ALL_PLATFORMS);
const TERMINAL_STATUS_SET = new Set(INGESTION_COVERAGE_TERMINAL_STATUSES);
const BLOCKER_REASON_CODE_SET = new Set(INGESTION_BLOCKER_REASON_CODES);
const DIRECT_BLOCKER_REASON_CODE_SET = new Set(
  INGESTION_BLOCKER_REASON_CODES.filter((code) => code !== "multiple_access_blocks")
);
const QUEUED_REASON_CODE_SET = new Set(INGESTION_QUEUED_REASON_CODES);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANONICAL_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GENERIC_TEXT = new Set([
  "blocked",
  "blocked_or_empty",
  "checked",
  "complete",
  "completed",
  "empty",
  "failed",
  "legacy",
  "n/a",
  "none",
  "queued",
  "unknown"
]);
const SERIALIZATION_STRATEGY = "normalized-evidence-registry+streamed-json.v1";

/**
 * Hash the canonical roster and account mappings supplied for one batch. The
 * caller-provided sourceHash field is deliberately excluded, so metadata can
 * never authenticate a changed denominator.
 */
export function computeIngestionCatalogSourceHash(catalog) {
  rejectCollectorSpecificShape(catalog, "catalog");
  const batchSlug = requiredText(catalog?.batchSlug, "catalog.batchSlug");
  if (!Array.isArray(catalog?.companies)) {
    throw new TypeError(`Catalog ${batchSlug} must contain a companies array.`);
  }
  const companies = catalog.companies.map((company) => {
    const companyId = requiredText(company?.id, `${batchSlug} company.id`);
    const companyName = requiredText(company?.name, `${companyId}.name`);
    if (!Array.isArray(company?.accounts ?? [])) {
      throw new TypeError(`${companyId}.accounts must be an array.`);
    }
    if (!Array.isArray(company?.founders ?? [])) {
      throw new TypeError(`${companyId}.founders must be an array.`);
    }
    return {
      id: companyId,
      name: companyName,
      accounts: canonicalCatalogHashAccounts(company.accounts ?? []),
      founders: company.founders.map((founder) => {
        const founderId = requiredText(founder?.id, `${companyId} founder.id`);
        if (!Array.isArray(founder?.accounts ?? [])) {
          throw new TypeError(`${founderId}.accounts must be an array.`);
        }
        return {
          id: founderId,
          name: requiredText(founder?.name, `${founderId}.name`),
          accounts: canonicalCatalogHashAccounts(founder.accounts ?? [])
        };
      }).sort(compareCanonicalCatalogEntities)
    };
  }).sort(compareCanonicalCatalogEntities);
  const payload = {
    version: INGESTION_CATALOG_MANIFEST_VERSION,
    batchSlug,
    companies
  };
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

/**
 * Normalized v1 input contract.
 *
 * This builder intentionally does not adapt collector-specific nested shapes.
 * Callers must flatten GitHub and other collector payloads into canonical task,
 * outcome, evidence, and account rows before invoking it.
 */
export function buildIngestionCoverageReceipt({
  runId,
  run,
  idempotencyKey,
  campaignKey,
  generatedAt,
  catalogs,
  expectedCatalogManifest,
  tasks = [],
  outcomes = [],
  evidence = [],
  pairScopes = [],
  multiAttributionReviews = []
} = {}) {
  const normalizedGeneratedAt = requiredIsoTimestamp(generatedAt, "generatedAt");
  const normalizedRun = normalizeRun({
    idempotencyKey: requiredText(
      run?.idempotencyKey ?? idempotencyKey,
      "run.idempotencyKey"
    ),
    campaignKey: requiredText(run?.campaignKey ?? campaignKey, "run.campaignKey"),
    startedAt: run?.startedAt,
    completedAt: run?.completedAt,
    ...(run?.recentCoverageCutoff
      ? { recentCoverageCutoff: run.recentCoverageCutoff }
      : {})
  }, normalizedGeneratedAt);
  const normalizedRunId = clean(runId) || normalizedRun.idempotencyKey;
  const recencyPolicy = buildRecencyPolicy(normalizedGeneratedAt, normalizedRun);
  const { owners, manifest } = normalizeCatalogs(catalogs);
  const normalizedExpectedManifest = normalizeExpectedCatalogManifest(expectedCatalogManifest);
  validateCatalogManifest(manifest, normalizedExpectedManifest);
  const pairs = buildPairMatrix(owners);

  for (const row of tasks ?? []) attachTask(pairs, row, {
    generatedAt: normalizedGeneratedAt,
    run: normalizedRun
  });
  for (const row of outcomes ?? []) attachOutcome(pairs, row, {
    generatedAt: normalizedGeneratedAt,
    run: normalizedRun
  });
  validateUniqueAttemptIds(pairs);
  for (const row of evidence ?? []) attachEvidence(pairs, row, {
    generatedAt: normalizedGeneratedAt,
    recencyPolicy,
    run: normalizedRun
  });
  correlateEvidenceAttemptWindows(pairs);
  for (const row of pairScopes ?? []) attachScope(pairs, row);

  const evidenceState = buildPhysicalEvidenceRegistry(pairs, recencyPolicy);
  const attributionReviews = buildMultiAttributionReviews(
    evidenceState.registry,
    multiAttributionReviews,
    normalizedGeneratedAt,
    normalizedRun
  );
  const attributionReviewsByEvidence = new Map(
    attributionReviews.map((review) => [review.evidenceKey, review])
  );
  const registryByKey = new Map(
    evidenceState.registry.map((entry) => [entry.evidenceKey, entry])
  );
  const finalizedPairs = [...pairs.values()]
    .map((pair) => finalizePair(pair, {
      generatedAt: normalizedGeneratedAt,
      recencyPolicy,
      registryByKey,
      evidenceKeysByPair: evidenceState.evidenceKeysByPair,
      attributionReviewsByEvidence,
      run: normalizedRun
    }))
    .sort((left, right) => left.pairKey.localeCompare(right.pairKey));

  const receipt = {
    schemaVersion: INGESTION_COVERAGE_SCHEMA_VERSION,
    runId: normalizedRunId,
    run: normalizedRun,
    generatedAt: normalizedGeneratedAt,
    recencyPolicy,
    catalogManifest: manifest,
    serialization: {
      strategy: SERIALIZATION_STRATEGY,
      normalizedEvidenceRegistry: true,
      pairEvidenceStoredAsReferences: true,
      recommendedMaxChunkCharacters: 65_536
    },
    inventory: buildInventory(owners, finalizedPairs),
    evidenceRegistry: evidenceState.registry,
    multiAttributionReviews: attributionReviews,
    summary: summarizeReceipt(finalizedPairs, evidenceState.registry),
    pairs: finalizedPairs
  };

  return validateIngestionCoverageReceipt(receipt, {
    expectedCatalogManifest: normalizedExpectedManifest
  });
}

/**
 * Validate a serialized receipt against an independently supplied canonical
 * catalog manifest. Requiring this parameter prevents the receipt denominator
 * from authenticating itself.
 */
export function validateIngestionCoverageReceipt(
  receipt,
  { expectedCatalogManifest } = {}
) {
  if (!isObject(receipt)) throw new TypeError("Coverage receipt must be an object.");
  if (receipt.schemaVersion !== INGESTION_COVERAGE_SCHEMA_VERSION) {
    throw new Error(
      `Coverage receipt schemaVersion must be ${INGESTION_COVERAGE_SCHEMA_VERSION}.`
    );
  }
  requiredText(receipt.runId, "receipt.runId");
  if (!isObject(receipt.run)) throw new TypeError("receipt.run must be an object.");
  requiredText(receipt.run.idempotencyKey, "receipt.run.idempotencyKey");
  requiredText(receipt.run.campaignKey, "receipt.run.campaignKey");
  const generatedAt = requiredIsoTimestamp(receipt.generatedAt, "receipt.generatedAt");
  const normalizedRun = normalizeRun(receipt.run, generatedAt);
  if (stableJson(receipt.run) !== stableJson(normalizedRun)) {
    throw new Error("receipt.run must use canonical run timing fields.");
  }
  validateRecencyPolicy(receipt.recencyPolicy, generatedAt, normalizedRun);
  const normalizedExpectedManifest = normalizeExpectedCatalogManifest(expectedCatalogManifest);
  validateCatalogManifest(receipt.catalogManifest, normalizedExpectedManifest);
  validateSerializationMetadata(receipt.serialization);
  if (!Array.isArray(receipt.pairs) || !receipt.pairs.length) {
    throw new TypeError("receipt.pairs must be a non-empty array.");
  }
  if (!Array.isArray(receipt.evidenceRegistry)) {
    throw new TypeError("receipt.evidenceRegistry must be an array.");
  }
  if (!Array.isArray(receipt.multiAttributionReviews)) {
    throw new TypeError("receipt.multiAttributionReviews must be an array.");
  }

  const pairIndex = validatePairMatrixStructure(receipt.pairs);
  const registryIndex = validateEvidenceRegistry(
    receipt.evidenceRegistry,
    pairIndex,
    receipt.recencyPolicy,
    generatedAt,
    normalizedRun
  );
  const reviewIndex = validateMultiAttributionReviews(
    receipt.multiAttributionReviews,
    registryIndex,
    generatedAt,
    normalizedRun
  );
  for (const pair of receipt.pairs) {
    validatePair(pair, {
      registryIndex,
      reviewIndex,
      generatedAt,
      recencyPolicy: receipt.recencyPolicy,
      run: normalizedRun
    });
  }
  validateUniqueSerializedAttemptIds(receipt.pairs);
  validateRegistryAttributionParity(receipt.pairs, receipt.evidenceRegistry);
  validateManifestCountsAgainstPairs(receipt.catalogManifest, receipt.pairs);

  const expectedInventory = buildInventoryFromReceipt(receipt.pairs);
  if (stableJson(receipt.inventory) !== stableJson(expectedInventory)) {
    throw new Error("receipt.inventory does not reconcile with the canonical pair/task matrix.");
  }
  const expectedSummary = summarizeReceipt(receipt.pairs, receipt.evidenceRegistry);
  if (stableJson(receipt.summary) !== stableJson(expectedSummary)) {
    throw new Error("receipt.summary does not reconcile exactly with pairs and evidenceRegistry.");
  }
  return receipt;
}

/**
 * Yield bounded JSON fragments. Evidence payloads are normalized once in the
 * receipt-wide registry, while pairs contain only registry keys. This avoids a
 * second monolithic JSON.stringify allocation for large 13-lane matrices.
 */
export function* streamIngestionCoverageReceiptJson(
  receipt,
  { expectedCatalogManifest, maxChunkCharacters = 65_536 } = {}
) {
  validateIngestionCoverageReceipt(receipt, { expectedCatalogManifest });
  if (!Number.isInteger(maxChunkCharacters) || maxChunkCharacters < 256) {
    throw new TypeError("maxChunkCharacters must be an integer of at least 256.");
  }
  const keys = Object.keys(receipt);
  yield "{";
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex];
    if (keyIndex) yield ",";
    yield `${JSON.stringify(key)}:`;
    const value = receipt[key];
    if (Array.isArray(value)) {
      yield "[";
      for (let index = 0; index < value.length; index += 1) {
        if (index) yield ",";
        yield* chunkString(JSON.stringify(value[index]), maxChunkCharacters);
      }
      yield "]";
    } else {
      yield* chunkString(JSON.stringify(value), maxChunkCharacters);
    }
  }
  yield "}";
}

export async function writeIngestionCoverageReceiptJson(
  receipt,
  { write, expectedCatalogManifest, maxChunkCharacters = 65_536 } = {}
) {
  if (typeof write !== "function") throw new TypeError("write must be an async chunk sink.");
  let chunks = 0;
  let characters = 0;
  for (const chunk of streamIngestionCoverageReceiptJson(receipt, {
    expectedCatalogManifest,
    maxChunkCharacters
  })) {
    await write(chunk);
    chunks += 1;
    characters += chunk.length;
  }
  return { chunks, characters, strategy: SERIALIZATION_STRATEGY };
}

function buildRecencyPolicy(generatedAt, run) {
  const coverageEnd = run?.recentCoverageCutoff ?? generatedAt;
  return {
    version: INGESTION_RECENCY_POLICY_VERSION,
    receiptTime: generatedAt,
    windowDays: INGESTION_RECENCY_WINDOW_DAYS,
    cutoffAt: new Date(
      Date.parse(coverageEnd) - INGESTION_RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1_000
    ).toISOString()
  };
}

function validateRecencyPolicy(policy, generatedAt, run) {
  if (!isObject(policy)) throw new TypeError("receipt.recencyPolicy must be an object.");
  const expected = buildRecencyPolicy(generatedAt, run);
  if (stableJson(policy) !== stableJson(expected)) {
    throw new Error(
      `receipt.recencyPolicy must be derived from the immutable recent coverage boundary using ${INGESTION_RECENCY_POLICY_VERSION}.`
    );
  }
}

function normalizeCatalogs(catalogs) {
  if (!Array.isArray(catalogs) || !catalogs.length) {
    throw new TypeError("catalogs must be a non-empty normalized canonical catalog array.");
  }
  const owners = [];
  const batches = [];
  const seenBatches = new Set();
  const seenOwners = new Set();
  for (const catalog of catalogs) {
    rejectCollectorSpecificShape(catalog, "catalog");
    const batchSlug = requiredText(catalog?.batchSlug, "catalog.batchSlug");
    if (seenBatches.has(batchSlug)) throw new Error(`Duplicate catalog batch ${batchSlug}.`);
    seenBatches.add(batchSlug);
    const sourcePath = requiredText(catalog?.sourcePath, `${batchSlug}.sourcePath`);
    const sourceVersion = requiredText(catalog?.sourceVersion, `${batchSlug}.sourceVersion`);
    const declaredSourceHash = requiredSha256(
      catalog?.sourceHash,
      `${batchSlug}.sourceHash`
    );
    const sourceHash = computeIngestionCatalogSourceHash(catalog);
    if (declaredSourceHash !== sourceHash) {
      throw new Error(
        `${batchSlug}.sourceHash does not match the canonical supplied roster and accounts.`
      );
    }
    if (!Array.isArray(catalog?.companies)) {
      throw new TypeError(`Catalog ${batchSlug} must contain a companies array.`);
    }
    let founderCount = 0;
    for (const company of catalog.companies) {
      const companyId = requiredText(company?.id, `${batchSlug} company.id`);
      const companyName = requiredText(company?.name, `${companyId}.name`);
      const companyRecord = { id: companyId, name: companyName };
      owners.push(normalizeOwner({
        batchSlug,
        company: companyRecord,
        entity: { type: "company", id: companyId, name: companyName },
        accounts: company?.accounts ?? []
      }, seenOwners));
      if (!Array.isArray(company?.founders ?? [])) {
        throw new TypeError(`${companyId}.founders must be an array.`);
      }
      for (const founder of company.founders ?? []) {
        founderCount += 1;
        const founderId = requiredText(founder?.id, `${companyId} founder.id`);
        const founderName = requiredText(founder?.name, `${founderId}.name`);
        owners.push(normalizeOwner({
          batchSlug,
          company: companyRecord,
          entity: { type: "founder", id: founderId, name: founderName },
          accounts: founder?.accounts ?? []
        }, seenOwners));
      }
    }
    batches.push({
      batchSlug,
      sourcePath,
      sourceVersion,
      sourceHash,
      companies: catalog.companies.length,
      founders: founderCount,
      entities: catalog.companies.length + founderCount
    });
  }
  return {
    owners: owners.sort((left, right) => ownerKey(left).localeCompare(ownerKey(right))),
    manifest: {
      version: INGESTION_CATALOG_MANIFEST_VERSION,
      batches: batches.sort((left, right) => left.batchSlug.localeCompare(right.batchSlug))
    }
  };
}

function canonicalCatalogHashAccounts(accounts) {
  const normalized = accounts.map((account) => {
    const value = normalizeAccount(account);
    return {
      platform: value.platform,
      url: value.url,
      handle: value.handle,
      verificationStatus: value.verificationStatus
    };
  }).sort((left, right) =>
    left.platform.localeCompare(right.platform) ||
    left.url.localeCompare(right.url) ||
    nullableCompare(left.handle, right.handle) ||
    left.verificationStatus.localeCompare(right.verificationStatus)
  );
  const identities = new Set();
  for (const account of normalized) {
    const identity = `${account.platform}:${account.url}`;
    if (identities.has(identity)) {
      throw new Error(`Canonical catalog contains duplicate account ${identity}.`);
    }
    identities.add(identity);
  }
  return normalized;
}

function compareCanonicalCatalogEntities(left, right) {
  return left.id.localeCompare(right.id) || left.name.localeCompare(right.name);
}

function normalizeRun(value, generatedAt) {
  if (!isObject(value)) throw new TypeError("run must be an object.");
  const startedAt = requiredIsoTimestamp(value.startedAt, "run.startedAt");
  const completedAt = requiredIsoTimestamp(value.completedAt, "run.completedAt");
  if (Date.parse(startedAt) > Date.parse(completedAt)) {
    throw new Error("run.startedAt must not exceed run.completedAt.");
  }
  if (Date.parse(completedAt) > Date.parse(generatedAt)) {
    throw new Error("run.completedAt must not exceed receipt.generatedAt.");
  }
  if (
    Date.parse(generatedAt) - Date.parse(completedAt) >
    INGESTION_RUN_COMPLETION_FRESHNESS_MS
  ) {
    throw new Error("run.completedAt is stale relative to receipt.generatedAt.");
  }
  const recentCoverageCutoff = value.recentCoverageCutoff
    ? requiredIsoTimestamp(value.recentCoverageCutoff, "run.recentCoverageCutoff")
    : null;
  if (recentCoverageCutoff && Date.parse(recentCoverageCutoff) > Date.parse(startedAt)) {
    throw new Error("run.recentCoverageCutoff must be pinned no later than run.startedAt.");
  }
  return {
    idempotencyKey: requiredText(value.idempotencyKey, "run.idempotencyKey"),
    campaignKey: requiredText(value.campaignKey, "run.campaignKey"),
    startedAt,
    completedAt,
    ...(recentCoverageCutoff ? { recentCoverageCutoff } : {})
  };
}

function normalizeOwner(owner, seenOwners) {
  const key = ownerKey(owner);
  if (seenOwners.has(key)) throw new Error(`Duplicate canonical owner ${key}.`);
  seenOwners.add(key);
  if (!Array.isArray(owner.accounts)) throw new TypeError(`${key}.accounts must be an array.`);
  const accounts = owner.accounts
    .map((account) => normalizeAccount(account))
    .sort((left, right) => left.accountKey.localeCompare(right.accountKey));
  assertUniqueSorted(accounts, (account) => account.accountKey, `${key} canonical accounts`);
  return { ...owner, accounts };
}

function buildPairMatrix(owners) {
  const pairs = new Map();
  for (const owner of owners) {
    for (const platform of ALL_PLATFORMS) {
      const pairKey = coveragePairKey({
        batchSlug: owner.batchSlug,
        entityType: owner.entity.type,
        entityId: owner.entity.id,
        platform
      });
      const extendedOnly = INGESTION_EXTENDED_ONLY_PLATFORMS.includes(platform);
      const pair = {
        pairKey,
        matrixScope: extendedOnly ? "extended_only" : "core",
        batchSlug: owner.batchSlug,
        company: { ...owner.company },
        entity: { ...owner.entity },
        platform,
        applicability: {
          status: extendedOnly ? "collector_unavailable" : "applicable",
          reason: extendedOnly
            ? `${platform} is an extended-only lane without a configured normalized collector adapter.`
            : `${platform} is included in the core canonical ingestion matrix.`
        },
        catalogAccounts: owner.accounts.filter((account) => account.platform === platform),
        taskRows: [],
        outcomeRows: [],
        evidenceRows: [],
        suppliedScope: null
      };
      if (pairs.has(pairKey)) throw new Error(`Duplicate canonical pair ${pairKey}.`);
      pairs.set(pairKey, pair);
    }
  }
  return pairs;
}

function attachTask(pairs, row, { generatedAt, run }) {
  rejectCollectorSpecificShape(row, "task");
  const pair = resolvePair(pairs, row, "task");
  const account = accountFromNormalizedRow(row, pair.platform);
  if (account) mergeAccount(pair.catalogAccounts, account);
  const taskKey = requiredText(row?.taskKey, `${pair.pairKey} task.taskKey`);
  if (pair.taskRows.some((task) => task.taskKey === taskKey)) {
    throw new Error(`Duplicate taskKey ${taskKey} in ${pair.pairKey}.`);
  }
  const task = {
    taskKey,
    account,
    outcomes: []
  };
  if (hasAttemptFields(row)) {
    task.outcomes.push(normalizeOutcomeAttempt(row, { pair, generatedAt, run, account }));
  }
  pair.taskRows.push(task);
  updateApplicability(pair, row);
}

function attachOutcome(pairs, row, { generatedAt, run }) {
  rejectCollectorSpecificShape(row, "outcome");
  const pair = resolvePair(pairs, row, "outcome");
  const account = accountFromNormalizedRow(row, pair.platform);
  if (account) mergeAccount(pair.catalogAccounts, account);
  pair.outcomeRows.push(normalizeOutcomeAttempt(row, { pair, generatedAt, run, account }));
}

function attachEvidence(pairs, row, { generatedAt, recencyPolicy, run }) {
  rejectCollectorSpecificShape(row, "evidence");
  const pair = resolvePair(pairs, row, "evidence");
  pair.evidenceRows.push(normalizeEvidenceRow(row, {
    pair,
    generatedAt,
    recencyPolicy,
    run
  }));
}

function attachScope(pairs, row) {
  rejectCollectorSpecificShape(row, "scope");
  const pair = resolvePair(pairs, row, "scope");
  if (pair.suppliedScope) throw new Error(`Duplicate scope row for ${pair.pairKey}.`);
  pair.suppliedScope = isObject(row.scope) ? row.scope : row;
}

function resolvePair(pairs, row, label) {
  const batchSlug = requiredText(row?.batchSlug, `${label}.batchSlug`);
  const entityType = normalizeEntityType(row?.entityType);
  const entityId = requiredText(row?.entityId, `${label}.entityId`);
  const platform = normalizePlatform(row?.platform);
  const pairKey = coveragePairKey({ batchSlug, entityType, entityId, platform });
  const pair = pairs.get(pairKey);
  if (!pair) throw new Error(`${label} row does not resolve to canonical pair ${pairKey}.`);
  return pair;
}

function normalizeOutcomeAttempt(row, { pair, generatedAt, run, account = null }) {
  const startedAt = requiredIsoTimestamp(
    row?.startedAt,
    `${pair.pairKey} outcome.startedAt`
  );
  const checkedAt = requiredIsoTimestamp(row?.checkedAt, `${pair.pairKey} outcome.checkedAt`);
  assertTimestampWithinRun(startedAt, run, `${pair.pairKey} outcome.startedAt`);
  assertTimestampWithinRun(checkedAt, run, `${pair.pairKey} outcome.checkedAt`);
  if (Date.parse(startedAt) > Date.parse(checkedAt)) {
    throw new Error(`${pair.pairKey} outcome.startedAt must not exceed checkedAt.`);
  }
  const rawStatus = clean(row?.status);
  const rawReasonCode = clean(row?.reasonCode).toLowerCase() || null;
  const rawReason = clean(row?.reason);
  validateRawOutcomeContract(rawStatus, rawReasonCode, rawReason, pair.pairKey);
  const normalizedAccount = account ?? accountFromNormalizedRow(row, pair.platform);
  const absenceVerification = normalizeAbsenceVerification(
    row?.absenceVerification,
    { generatedAt, strict: false }
  );
  if (absenceVerification?.checkedAt) {
    const absenceCheckedAt = requiredIsoTimestamp(
      absenceVerification.checkedAt,
      `${pair.pairKey} absenceVerification.checkedAt`
    );
    assertTimestampWithinRun(
      absenceCheckedAt,
      run,
      `${pair.pairKey} absenceVerification.checkedAt`
    );
    if (
      Date.parse(absenceCheckedAt) < Date.parse(startedAt) ||
      Date.parse(absenceCheckedAt) > Date.parse(checkedAt)
    ) {
      throw new Error(`${pair.pairKey} absence verification must fall within its attempt.`);
    }
  }
  return {
    taskKey: clean(row?.taskKey) || null,
    account: normalizedAccount,
    attemptId: requiredText(row?.attemptId, `${pair.pairKey} outcome.attemptId`),
    attemptSequence: requiredNonNegativeInteger(
      row?.attemptSequence,
      `${pair.pairKey} outcome.attemptSequence`
    ),
    startedAt,
    checkedAt,
    rawStatus,
    rawReasonCode,
    rawReason,
    nextAction: clean(row?.nextAction),
    absenceVerification,
    profileReceipt: normalizeProfileReceipt(row?.profileReceipt, {
      pair,
      account: normalizedAccount,
      run,
      startedAt,
      checkedAt
    }),
    numericEvidenceCount: row?.nativeEvidenceCount === undefined
      ? null
      : requiredNonNegativeInteger(
          row.nativeEvidenceCount,
          `${pair.pairKey} outcome.nativeEvidenceCount`
        )
  };
}

function normalizeEvidenceRow(row, { pair, generatedAt, recencyPolicy, run }) {
  const platform = pair.platform;
  const nativeId = clean(row?.nativeId) || null;
  const canonicalUrl = clean(row?.canonicalUrl)
    ? canonicalizePlatformUrl(platform, row.canonicalUrl, { kind: "evidence" })
    : null;
  if (!nativeId && !canonicalUrl) {
    throw new Error(`${pair.pairKey} evidence requires nativeId or canonicalUrl.`);
  }
  const digest = requiredSha256(row?.digest, `${pair.pairKey} evidence.digest`);
  const publishedAt = requiredIsoTimestamp(
    row?.publishedAt,
    `${pair.pairKey} evidence.publishedAt`
  );
  const observedAt = requiredIsoTimestamp(
    row?.observedAt,
    `${pair.pairKey} evidence.observedAt`
  );
  assertNotTooFarFuture(publishedAt, generatedAt, `${pair.pairKey} evidence.publishedAt`);
  assertTimestampWithinRun(observedAt, run, `${pair.pairKey} evidence.observedAt`);
  const account = clean(row?.accountUrl)
    ? normalizeAccount({
        platform,
        url: row.accountUrl,
        verificationStatus: "unknown"
      })
    : null;
  return {
    pairKey: pair.pairKey,
    platform,
    nativeId,
    canonicalUrl,
    digest,
    publishedAt,
    recency: deriveRecency(publishedAt, recencyPolicy),
    observedAt,
    taskKey: clean(row?.taskKey) || null,
    attemptId: clean(row?.attemptId) || null,
    attemptStartedAt: null,
    attemptCheckedAt: null,
    accountIdentity: account?.identity ?? null,
    storedUnpublished: row?.storedUnpublished === true
  };
}

function correlateEvidenceAttemptWindows(pairs) {
  const attempts = new Map();
  for (const pair of pairs.values()) {
    for (const task of pair.taskRows) {
      for (const outcome of task.outcomes) {
        attempts.set(outcome.attemptId, {
          ...outcome,
          pairKey: pair.pairKey,
          taskKey: task.taskKey,
          account: outcome.account ?? task.account
        });
      }
    }
    for (const outcome of pair.outcomeRows) {
      attempts.set(outcome.attemptId, {
        ...outcome,
        pairKey: pair.pairKey
      });
    }
  }
  for (const pair of pairs.values()) {
    for (const row of pair.evidenceRows) {
      if (!row.attemptId) continue;
      const attempt = attempts.get(row.attemptId);
      if (!attempt) {
        throw new Error(`${row.pairKey} evidence references unknown attemptId ${row.attemptId}.`);
      }
      if (attempt.pairKey !== row.pairKey) {
        throw new Error(`${row.attemptId} evidence and attempt belong to different pairs.`);
      }
      if (row.taskKey && attempt.taskKey && row.taskKey !== attempt.taskKey) {
        throw new Error(`${row.attemptId} evidence taskKey does not match its attempt.`);
      }
      if (
        row.accountIdentity &&
        attempt.account?.identity &&
        row.accountIdentity !== attempt.account.identity
      ) {
        throw new Error(`${row.attemptId} evidence account does not match its attempt.`);
      }
      assertObservedWithinAttempt(row.observedAt, attempt, `${row.attemptId} evidence.observedAt`);
      row.attemptStartedAt = attempt.startedAt;
      row.attemptCheckedAt = attempt.checkedAt;
    }
  }
}

function normalizeProfileReceipt(value, { pair, account, run, startedAt, checkedAt }) {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) {
    throw new TypeError(`${pair.pairKey} profileReceipt must be an object.`);
  }
  const status = requiredText(value.status, `${pair.pairKey} profileReceipt.status`);
  if (status !== "scraped") {
    throw new Error(`${pair.pairKey} profileReceipt.status must be scraped.`);
  }
  const receiptCheckedAt = requiredIsoTimestamp(
    value.checkedAt,
    `${pair.pairKey} profileReceipt.checkedAt`
  );
  assertTimestampWithinRun(receiptCheckedAt, run, `${pair.pairKey} profileReceipt.checkedAt`);
  if (
    Date.parse(receiptCheckedAt) < Date.parse(startedAt) ||
    Date.parse(receiptCheckedAt) > Date.parse(checkedAt)
  ) {
    throw new Error(`${pair.pairKey} profileReceipt.checkedAt must fall within its attempt.`);
  }
  const profileUrl = canonicalizePlatformUrl(
    pair.platform,
    value.profileUrl,
    { kind: "account" }
  );
  if (account && profileUrl !== account.url) {
    throw new Error(`${pair.pairKey} profileReceipt.profileUrl does not match its task account.`);
  }
  return {
    receiptId: requiredText(value.receiptId, `${pair.pairKey} profileReceipt.receiptId`),
    status,
    checkedAt: receiptCheckedAt,
    profileUrl,
    digest: requiredSha256(value.digest, `${pair.pairKey} profileReceipt.digest`)
  };
}

function validateUniqueAttemptIds(pairs) {
  const seen = new Map();
  for (const pair of pairs.values()) {
    for (const task of pair.taskRows) {
      for (const outcome of task.outcomes) {
        assertUniqueAttemptId(seen, outcome.attemptId, pair.pairKey, task.taskKey);
      }
    }
    for (const outcome of pair.outcomeRows) {
      assertUniqueAttemptId(seen, outcome.attemptId, pair.pairKey, outcome.taskKey);
    }
  }
}

function assertUniqueAttemptId(seen, attemptId, pairKey, taskKey) {
  const prior = seen.get(attemptId);
  if (prior) {
    throw new Error(
      `Duplicate attemptId ${attemptId} appears in ${prior.pairKey}/${prior.taskKey ?? "unassigned"} and ${pairKey}/${taskKey ?? "unassigned"}.`
    );
  }
  seen.set(attemptId, { pairKey, taskKey });
}

function updateApplicability(pair, row) {
  const reasonCode = clean(row?.reasonCode).toLowerCase();
  const reason = clean(row?.reason);
  if (reasonCode === "not_applicable") {
    pair.applicability = {
      status: "not_applicable",
      reason: hasExactOperationalText(reason)
        ? reason
        : `${pair.pairKey} was explicitly marked not applicable by the normalized task plan.`
    };
  } else if (reasonCode === "collector_unavailable") {
    pair.applicability = {
      status: "collector_unavailable",
      reason: hasExactOperationalText(reason)
        ? reason
        : `${pair.pairKey} has no configured normalized collector adapter.`
    };
  }
}

function buildPhysicalEvidenceRegistry(pairs, recencyPolicy) {
  const registryEntries = new Map();
  const aliasIndex = new Map();
  const rows = [...pairs.values()]
    .flatMap((pair) => pair.evidenceRows)
    .sort((left, right) =>
      Number(!left.nativeId) - Number(!right.nativeId) ||
      physicalEvidenceAliases(left)[0].localeCompare(physicalEvidenceAliases(right)[0]) ||
      left.pairKey.localeCompare(right.pairKey) ||
      nullableCompare(left.taskKey, right.taskKey) ||
      nullableCompare(left.attemptId, right.attemptId) ||
      left.observedAt.localeCompare(right.observedAt)
    );
  for (const row of rows) {
      const aliases = physicalEvidenceAliases(row);
      const existingKeys = unique(
        aliases.map((alias) => aliasIndex.get(alias)).filter(Boolean)
      );
      if (existingKeys.length > 1) {
        throw new Error(
          `${row.pairKey} evidence aliases join multiple physical registry entries: ${existingKeys.join(", ")}.`
        );
      }
      const evidenceKey = existingKeys[0] ?? aliases[0];
      let entry = registryEntries.get(evidenceKey);
      if (!entry) {
        entry = {
          evidenceKey,
          platform: row.platform,
          nativeId: row.nativeId,
          canonicalUrl: row.canonicalUrl,
          digest: row.digest,
          publishedAt: row.publishedAt,
          recency: deriveRecency(row.publishedAt, recencyPolicy),
          storedUnpublished: row.storedUnpublished,
          attributionSet: new Set(),
          sourceRefMap: new Map()
        };
        registryEntries.set(evidenceKey, entry);
      } else {
        mergePhysicalEvidenceEntry(entry, row);
      }
      for (const alias of aliases) aliasIndex.set(alias, evidenceKey);
      entry.attributionSet.add(row.pairKey);
      const sourceRef = {
        pairKey: row.pairKey,
        taskKey: row.taskKey,
        attemptId: row.attemptId,
        attemptStartedAt: row.attemptStartedAt,
        attemptCheckedAt: row.attemptCheckedAt,
        observedAt: row.observedAt,
        accountIdentity: row.accountIdentity
      };
      entry.sourceRefMap.set(stableJson(sourceRef), sourceRef);
  }

  const registry = [...registryEntries.values()]
    .map((entry) => ({
      evidenceKey: entry.evidenceKey,
      platform: entry.platform,
      nativeId: entry.nativeId,
      canonicalUrl: entry.canonicalUrl,
      digest: entry.digest,
      publishedAt: entry.publishedAt,
      recency: entry.recency,
      storedUnpublished: entry.storedUnpublished,
      attributions: [...entry.attributionSet].sort(),
      sourceRefs: [...entry.sourceRefMap.values()].sort(compareSourceRefs)
    }))
    .sort((left, right) => left.evidenceKey.localeCompare(right.evidenceKey));
  const evidenceKeysByPair = new Map();
  for (const entry of registry) {
    for (const pairKey of entry.attributions) {
      const keys = evidenceKeysByPair.get(pairKey) ?? [];
      keys.push(entry.evidenceKey);
      evidenceKeysByPair.set(pairKey, keys);
    }
  }
  return { registry, evidenceKeysByPair };
}

function mergePhysicalEvidenceEntry(entry, row) {
  if (entry.platform !== row.platform) {
    throw new Error(`${entry.evidenceKey} cannot span evidence platforms.`);
  }
  if (entry.digest !== row.digest) {
    throw new Error(`${entry.evidenceKey} has conflicting physical evidence digests.`);
  }
  if (entry.publishedAt !== row.publishedAt) {
    throw new Error(`${entry.evidenceKey} has conflicting native publication timestamps.`);
  }
  if (entry.nativeId && row.nativeId && entry.nativeId !== row.nativeId) {
    throw new Error(`${entry.evidenceKey} has conflicting native IDs.`);
  }
  if (entry.canonicalUrl && row.canonicalUrl && entry.canonicalUrl !== row.canonicalUrl) {
    throw new Error(`${entry.evidenceKey} has conflicting canonical URLs.`);
  }
  entry.nativeId ??= row.nativeId;
  entry.canonicalUrl ??= row.canonicalUrl;
  entry.storedUnpublished ||= row.storedUnpublished;
}

function buildMultiAttributionReviews(registry, suppliedRows, generatedAt, run) {
  if (!Array.isArray(suppliedRows)) {
    throw new TypeError("multiAttributionReviews must be an array.");
  }
  const supplied = new Map();
  for (const row of suppliedRows) {
    const evidenceKey = requiredText(row?.evidenceKey, "multiAttributionReview.evidenceKey");
    if (supplied.has(evidenceKey)) {
      throw new Error(`Duplicate multi-attribution review for ${evidenceKey}.`);
    }
    supplied.set(evidenceKey, row);
  }
  const reviews = [];
  for (const entry of registry) {
    const row = supplied.get(entry.evidenceKey);
    if (entry.attributions.length < 2) {
      if (row) throw new Error(`${entry.evidenceKey} does not require multi-attribution review.`);
      continue;
    }
    if (!row) {
      reviews.push({
        evidenceKey: entry.evidenceKey,
        attributionPairKeys: [...entry.attributions],
        status: "needs_review",
        reviewedAt: null,
        reason: `${entry.evidenceKey} is attributed to ${entry.attributions.length} canonical entity-platform pairs without an approval receipt.`,
        nextAction: `Review the attribution set for ${entry.evidenceKey} and record a dated approval or remove incorrect owners.`
      });
      continue;
    }
    const status = requiredText(row.status, `${entry.evidenceKey} review.status`);
    if (!["approved", "needs_review"].includes(status)) {
      throw new Error(`${entry.evidenceKey} review.status must be approved or needs_review.`);
    }
    const attributionPairKeys = sortedUniqueStrings(
      row.attributionPairKeys,
      `${entry.evidenceKey} review.attributionPairKeys`
    );
    if (stableJson(attributionPairKeys) !== stableJson(entry.attributions)) {
      throw new Error(`${entry.evidenceKey} review does not cover its exact attribution set.`);
    }
    const reviewedAt = row.reviewedAt === null || row.reviewedAt === undefined
      ? null
      : requiredIsoTimestamp(row.reviewedAt, `${entry.evidenceKey} review.reviewedAt`);
    if (status === "approved" && !reviewedAt) {
      throw new Error(`${entry.evidenceKey} approved review requires reviewedAt.`);
    }
    if (reviewedAt) {
      assertTimestampWithinRun(reviewedAt, run, `${entry.evidenceKey} review.reviewedAt`);
    }
    reviews.push({
      evidenceKey: entry.evidenceKey,
      attributionPairKeys,
      status,
      reviewedAt,
      reason: requireExactOperationalText(row.reason, `${entry.evidenceKey} review.reason`),
      nextAction: requireExactOperationalText(
        row.nextAction,
        `${entry.evidenceKey} review.nextAction`
      )
    });
  }
  for (const evidenceKey of supplied.keys()) {
    if (!registry.some((entry) => entry.evidenceKey === evidenceKey)) {
      throw new Error(`Multi-attribution review references unknown evidence ${evidenceKey}.`);
    }
  }
  return reviews.sort((left, right) => left.evidenceKey.localeCompare(right.evidenceKey));
}

function physicalEvidenceAliases(row) {
  const aliases = [];
  if (row.nativeId) {
    aliases.push(`${row.platform}:native:${encodeURIComponent(row.nativeId)}`);
  }
  if (row.canonicalUrl) {
    aliases.push(`${row.platform}:url:${encodeURIComponent(row.canonicalUrl)}`);
  }
  return aliases;
}

function compareSourceRefs(left, right) {
  return (
    left.pairKey.localeCompare(right.pairKey) ||
    nullableCompare(left.taskKey, right.taskKey) ||
    nullableCompare(left.attemptId, right.attemptId) ||
    nullableCompare(left.attemptStartedAt, right.attemptStartedAt) ||
    nullableCompare(left.attemptCheckedAt, right.attemptCheckedAt) ||
    left.observedAt.localeCompare(right.observedAt) ||
    nullableCompare(left.accountIdentity, right.accountIdentity)
  );
}

function deriveRecency(publishedAt, recencyPolicy) {
  return Date.parse(publishedAt) >= Date.parse(recencyPolicy.cutoffAt)
    ? "recent"
    : "historical";
}

function finalizePair(pair, context) {
  const accounts = pair.catalogAccounts
    .map((account) => ({ ...account }))
    .sort((left, right) => left.accountKey.localeCompare(right.accountKey));
  assertUniqueSorted(accounts, (account) => account.accountKey, `${pair.pairKey} accounts`);
  const tasks = materializeTasks(pair, accounts);
  assignOutcomesToTasks(pair, tasks);
  const pairEvidenceKeys = [...(context.evidenceKeysByPair.get(pair.pairKey) ?? [])];
  const accountOutcomes = tasks
    .map((task) => finalizeTaskOutcome(pair, task, tasks, context))
    .sort((left, right) => left.taskKey.localeCompare(right.taskKey));
  const terminal = aggregatePairTerminal(pair, accountOutcomes);
  const evidence = summarizePairEvidence(pairEvidenceKeys, context);
  const scope = normalizeScope(pair.suppliedScope, {
    pairKey: pair.pairKey,
    terminal,
    evidence,
    generatedAt: context.generatedAt,
    recencyPolicy: context.recencyPolicy,
    run: context.run
  });
  const rawStatuses = unique(
    accountOutcomes.map((outcome) => outcome.rawCollectorStatus).filter(Boolean)
  );
  const rawReasons = unique(
    accountOutcomes.map((outcome) => outcome.rawCollectorReason).filter(Boolean)
  );

  return {
    pairKey: pair.pairKey,
    matrixScope: pair.matrixScope,
    batchSlug: pair.batchSlug,
    company: pair.company,
    entity: pair.entity,
    platform: pair.platform,
    applicability: pair.applicability,
    mapping: {
      status: accounts.length ? "mapped" : "unmapped",
      accountCount: accounts.length,
      verifiedAccountCount: accounts.filter((account) => account.verified).length,
      accounts
    },
    terminal,
    accountOutcomes,
    evidence,
    scope,
    rawCollectorStatus: rawStatuses.length > 1 ? "mixed" : rawStatuses[0] ?? null,
    rawCollectorReason: rawReasons.length > 1 ? rawReasons.join(" | ") : rawReasons[0] ?? null
  };
}

function materializeTasks(pair, accounts) {
  const tasks = pair.taskRows.map((task) => ({
    taskKey: task.taskKey,
    account: canonicalPairAccount(accounts, task.account),
    outcomes: [...task.outcomes]
  }));
  for (const outcome of pair.outcomeRows) {
    if (!outcome.taskKey) continue;
    const outcomeAccount = canonicalPairAccount(accounts, outcome.account);
    const existing = tasks.find((task) => task.taskKey === outcome.taskKey);
    if (!existing) {
      tasks.push({ taskKey: outcome.taskKey, account: outcomeAccount, outcomes: [] });
      continue;
    }
    if (existing.account && outcomeAccount && !sameAccount(existing.account, outcomeAccount)) {
      throw new Error(
        `${pair.pairKey} taskKey ${outcome.taskKey} cannot span multiple accounts.`
      );
    }
    existing.account ??= outcomeAccount;
  }
  for (const account of accounts) {
    if (!tasks.some((task) => sameAccount(task.account, account))) {
      tasks.push({
        taskKey: syntheticTaskKey(pair.pairKey, account),
        account,
        outcomes: []
      });
    }
  }
  if (!tasks.length) {
    tasks.push({
      taskKey: syntheticTaskKey(pair.pairKey, null),
      account: null,
      outcomes: []
    });
  }
  tasks.sort((left, right) => left.taskKey.localeCompare(right.taskKey));
  assertUniqueSorted(tasks, (task) => task.taskKey, `${pair.pairKey} tasks`);
  return tasks;
}

function assignOutcomesToTasks(pair, tasks) {
  for (const outcome of pair.outcomeRows) {
    let candidates = [];
    if (outcome.taskKey) {
      candidates = tasks.filter((task) => task.taskKey === outcome.taskKey);
      if (!candidates.length) {
        const account = canonicalPairAccount(pair.catalogAccounts, outcome.account);
        const task = {
          taskKey: outcome.taskKey,
          account,
          outcomes: []
        };
        tasks.push(task);
        candidates = [task];
      }
    } else if (outcome.account) {
      candidates = tasks.filter((task) => sameAccount(task.account, outcome.account));
    } else {
      candidates = tasks.filter((task) => !task.account);
    }
    if (candidates.length !== 1) {
      throw new Error(
        `${pair.pairKey} outcome ${outcome.attemptId} requires an exact taskKey; account fallback resolved ${candidates.length} tasks.`
      );
    }
    const candidate = candidates[0];
    const outcomeAccount = canonicalPairAccount(pair.catalogAccounts, outcome.account);
    if (candidate.account && outcomeAccount && !sameAccount(candidate.account, outcomeAccount)) {
      throw new Error(
        `${pair.pairKey} taskKey ${candidate.taskKey} cannot collect attempts across accounts.`
      );
    }
    candidate.account ??= outcomeAccount;
    candidate.outcomes.push(outcome);
  }
  tasks.sort((left, right) => left.taskKey.localeCompare(right.taskKey));
  assertUniqueSorted(tasks, (task) => task.taskKey, `${pair.pairKey} tasks after outcome assignment`);
}

function finalizeTaskOutcome(pair, task, tasks, context) {
  const current = selectCurrentAttempt(task.outcomes, task.taskKey);
  if (!current) {
    return queuedTaskOutcome({
      task,
      reasonCode: pair.matrixScope === "extended_only"
        ? "collector_unavailable"
        : "no_current_attempt",
      reason: pair.matrixScope === "extended_only"
        ? `${task.taskKey} has no normalized collector for the extended-only ${pair.platform} lane.`
        : `${task.taskKey} has no dated current-attempt collector outcome.`,
      nextAction: pair.matrixScope === "extended_only"
        ? `Implement a normalized ${pair.platform} adapter, then execute ${task.taskKey}.`
        : `Execute ${task.taskKey} and record attemptId, sequence, checkedAt, structured reason code, and native evidence references.`
    });
  }

  const evidenceResolution = resolveCurrentAttemptEvidence(pair, task, tasks, current, context);
  const classification = classifyCurrentAttempt({
    current,
    task,
    pair,
    evidenceResolution
  });
  if (
    current.profileReceipt &&
    (!task.account || current.profileReceipt.profileUrl !== task.account.url)
  ) {
    throw new Error(`${task.taskKey} profileReceipt does not resolve to its task account.`);
  }
  return {
    taskKey: task.taskKey,
    accountKey: task.account?.accountKey ?? null,
    accountUrl: task.account?.url ?? null,
    attempt: {
      attemptId: current.attemptId,
      sequence: current.attemptSequence,
      startedAt: current.startedAt,
      checkedAt: current.checkedAt
    },
    profileScraped: current.profileReceipt?.status === "scraped",
    profileReceipt: current.profileReceipt,
    status: classification.status,
    reasonCode: classification.reasonCode,
    isTerminal: classification.status !== "queued",
    reason: classification.reason,
    nextAction: classification.nextAction,
    evidenceRefs: classification.status === "collected"
      ? evidenceResolution.approvedEvidenceKeys
      : [],
    pendingEvidenceRefs: evidenceResolution.pendingAttributionKeys,
    absenceVerification: classification.status === "verified_no_account"
      ? current.absenceVerification
      : null,
    rawCollectorStatus: current.rawStatus || null,
    rawCollectorReasonCode: current.rawReasonCode,
    rawCollectorReason: current.rawReason || null
  };
}

function selectCurrentAttempt(outcomes, taskKey) {
  if (!outcomes.length) return null;
  const ordered = [...outcomes].sort((left, right) =>
    left.attemptSequence - right.attemptSequence ||
    left.checkedAt.localeCompare(right.checkedAt) ||
    left.attemptId.localeCompare(right.attemptId)
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous.attemptSequence === current.attemptSequence ||
        previous.checkedAt === current.checkedAt) {
      throw new Error(
        `${taskKey} has tied attempt sequence or timestamp at ${current.attemptSequence}/${current.checkedAt}.`
      );
    }
    // Independent collectors can overlap for one canonical pair (for example,
    // a historical crawl may start while a public-search retry is in flight).
    // Sequence is assigned by completion order, so only completion timestamps
    // must be monotonic here; each attempt still independently enforces
    // startedAt <= checkedAt and both timestamps remain within the run.
    if (previous.attemptSequence < current.attemptSequence &&
        previous.checkedAt > current.checkedAt) {
      throw new Error(
        `${taskKey} attempt sequence and checkedAt ordering disagree: ` +
        `previous=${previous.attemptId}/${previous.attemptSequence}/${previous.startedAt}/${previous.checkedAt}; ` +
        `current=${current.attemptId}/${current.attemptSequence}/${current.startedAt}/${current.checkedAt}.`
      );
    }
  }
  return ordered.at(-1);
}

function resolveCurrentAttemptEvidence(pair, task, tasks, current, context) {
  const exact = [];
  const fallback = [];
  for (const entry of context.registryByKey.values()) {
    if (!entry.attributions.includes(pair.pairKey)) continue;
    for (const source of entry.sourceRefs) {
      if (source.pairKey !== pair.pairKey || source.attemptId !== current.attemptId) continue;
      assertObservedWithinAttempt(
        source.observedAt,
        current,
        `${entry.evidenceKey} sourceRef.observedAt`
      );
      if (source.taskKey === task.taskKey) {
        exact.push(entry.evidenceKey);
      } else if (!source.taskKey && source.accountIdentity && task.account &&
          source.accountIdentity === task.account.identity) {
        fallback.push(entry.evidenceKey);
      } else if (!source.taskKey && !source.accountIdentity && !task.account) {
        fallback.push(entry.evidenceKey);
      }
    }
  }
  const exactKeys = unique(exact).sort();
  let evidenceKeys = exactKeys;
  if (!evidenceKeys.length && fallback.length) {
    const matchingTasks = task.account
      ? tasks.filter((candidate) => sameAccount(candidate.account, task.account))
      : tasks.filter((candidate) => !candidate.account);
    if (matchingTasks.length === 1) evidenceKeys = unique(fallback).sort();
  }
  const pendingAttributionKeys = [];
  const approvedEvidenceKeys = [];
  for (const evidenceKey of evidenceKeys) {
    const entry = context.registryByKey.get(evidenceKey);
    const review = context.attributionReviewsByEvidence.get(evidenceKey);
    if (entry.attributions.length > 1 && review?.status !== "approved") {
      pendingAttributionKeys.push(evidenceKey);
    } else {
      approvedEvidenceKeys.push(evidenceKey);
    }
  }
  return {
    approvedEvidenceKeys,
    pendingAttributionKeys,
    allCurrentEvidenceKeys: evidenceKeys
  };
}

function classifyCurrentAttempt({ current, task, pair, evidenceResolution }) {
  const rawStatus = normalizeRawStatus(current.rawStatus);
  const taxonomy = classifyReasonTaxonomy(current.rawReasonCode, current.rawReason, rawStatus);
  if (
    rawStatus === "verified_no_account" ||
    ["checked_empty", "no_account", "not_found"].includes(rawStatus)
  ) {
    if (hasExhaustiveAbsenceVerification(current.absenceVerification)) {
      return {
        status: "verified_no_account",
        reasonCode: "exhaustive_absence_verified",
        reason: hasExactOperationalText(current.rawReason)
          ? current.rawReason
          : `Exhaustive dated absence verification completed for ${pair.pairKey}.`,
        nextAction: current.nextAction ||
          `Re-run absence verification for ${pair.pairKey} after canonical identity or official-link changes.`
      };
    }
    return queuedClassification({
      current,
      task,
      reasonCode: taxonomy.reasonCode === "missing_credentials"
        ? "missing_credentials"
        : "no_match",
      reason: hasExactOperationalText(current.rawReason)
        ? current.rawReason
        : `${task.taskKey} reported no account without exhaustive dated absence proof.`
    });
  }
  if (["completed", "collected", "success", "succeeded"].includes(rawStatus)) {
    if (evidenceResolution.pendingAttributionKeys.length) {
      return queuedClassification({
        current,
        task,
        reasonCode: "manual_review_required",
        reason: `${task.taskKey} produced evidence with unresolved multi-attribution review: ${evidenceResolution.pendingAttributionKeys.join(", ")}.`
      });
    }
    if (evidenceResolution.approvedEvidenceKeys.length) {
      return {
        status: "collected",
        reasonCode: "native_evidence_collected",
        reason: hasExactOperationalText(current.rawReason)
          ? current.rawReason
          : `${task.taskKey} collected ${evidenceResolution.approvedEvidenceKeys.length} deduplicated native evidence rows during ${current.attemptId}.`,
        nextAction: current.nextAction ||
          `Continue scheduled incremental ingestion for ${task.taskKey} and retain native IDs and digests.`
      };
    }
    return queuedClassification({
      current,
      task,
      reasonCode: "missing_native_evidence",
      reason: `${task.taskKey} reported ${rawStatus} but current attempt ${current.attemptId} has no linked native row ID and digest; numeric counts do not prove collection.`
    });
  }
  if (taxonomy.status === "blocked") {
    return {
      status: "blocked",
      reasonCode: taxonomy.reasonCode,
      reason: current.rawReason,
      nextAction: current.nextAction || blockerNextAction(taxonomy.reasonCode, task.taskKey)
    };
  }
  return queuedClassification({
    current,
    task,
    reasonCode: taxonomy.reasonCode,
    reason: hasExactOperationalText(current.rawReason)
      ? current.rawReason
      : `${task.taskKey} has unresolved current status ${rawStatus || "missing"} for attempt ${current.attemptId}.`
  });
}

function validateRawOutcomeContract(rawStatusValue, rawCodeValue, reason, label) {
  const rawStatus = normalizeRawStatus(rawStatusValue);
  const explicit = clean(rawCodeValue).toLowerCase();
  const successStatuses = new Set(["completed", "collected", "success", "succeeded"]);
  const absenceStatuses = new Set([
    "verified_no_account",
    "checked_empty",
    "no_account",
    "not_found"
  ]);
  const successCodes = new Set(["native_evidence_collected"]);
  const absenceCodes = new Set(["exhaustive_absence_verified"]);
  const nonSuccessCodes = new Set([
    ...INGESTION_BLOCKER_REASON_CODES,
    ...INGESTION_QUEUED_REASON_CODES
  ]);
  const signals = rawReasonSignals(reason);
  if (signals.size > 1) {
    throw new Error(
      `${label} outcome.reason contains contradictory operational signals: ${[...signals].sort().join(", ")}.`
    );
  }
  const inferred = [...signals][0] ?? null;
  if (successStatuses.has(rawStatus) && (nonSuccessCodes.has(explicit) || inferred)) {
    throw new Error(`${label} successful status contradicts its failure or queued reason.`);
  }
  if (
    absenceStatuses.has(rawStatus) &&
    ((nonSuccessCodes.has(explicit) && explicit !== "no_match") ||
      (inferred && inferred !== "no_match"))
  ) {
    throw new Error(`${label} absence status contradicts its failure or queued reason.`);
  }
  if (!successStatuses.has(rawStatus) && successCodes.has(explicit)) {
    throw new Error(`${label} non-success status contradicts native_evidence_collected.`);
  }
  if (!absenceStatuses.has(rawStatus) && absenceCodes.has(explicit)) {
    throw new Error(`${label} non-absence status contradicts exhaustive_absence_verified.`);
  }
  if (absenceStatuses.has(rawStatus) && successCodes.has(explicit)) {
    throw new Error(`${label} absence status contradicts native_evidence_collected.`);
  }
  if (explicit && inferred && explicit !== inferred) {
    throw new Error(
      `${label} reasonCode ${explicit} contradicts reason signal ${inferred}.`
    );
  }
}

function rawReasonSignals(reason) {
  const text = clean(reason);
  const signals = new Set();
  if (/(?:missing|absent|not configured|requires?)\b[^.]{0,80}\b(?:credential|token|api key|bearer|secret)|(?:credential|token|api key|bearer|secret)\b[^.]{0,80}\b(?:missing|absent|not configured|required)/i.test(text)) {
    signals.add("missing_credentials");
  }
  if (/manual review|needs review/i.test(text)) signals.add("manual_review_required");
  if (/captcha/i.test(text)) signals.add("captcha_required");
  const rateLimited = /(?:rate.?limit|\b429\b)/i.test(text);
  if (rateLimited) signals.add("rate_limited");
  // GitHub and several public APIs use HTTP 403 for exhausted rate limits;
  // once rate-limit language is present, do not misclassify the same status
  // as an independent access-denied signal.
  if (!rateLimited && /(?:access denied|forbidden|\b403\b|robots blocked)/i.test(text)) {
    signals.add("access_denied");
  }
  if (/(?:network|timeout|timed out|socket|econn|fetch failed|\b5\d\d\b)/i.test(text)) {
    signals.add("network_error");
  }
  if (/(?:no match|no result|not found|empty|no account|no posts?)/i.test(text)) {
    signals.add("no_match");
  }
  return signals;
}

function classifyReasonTaxonomy(rawCode, reason, rawStatus) {
  const explicit = clean(rawCode).toLowerCase();
  const text = clean(reason);
  if (/(?:missing|absent|not configured|requires?)\b[^.]{0,80}\b(?:credential|token|api key|bearer|secret)|(?:credential|token|api key|bearer|secret)\b[^.]{0,80}\b(?:missing|absent|not configured|required)|manual review|needs review/i.test(text)) {
    return {
      status: "queued",
      reasonCode: /review/i.test(text) ? "manual_review_required" : "missing_credentials"
    };
  }
  if (QUEUED_REASON_CODE_SET.has(explicit)) {
    return { status: "queued", reasonCode: explicit };
  }
  if (DIRECT_BLOCKER_REASON_CODE_SET.has(explicit)) {
    if (!hasExactOperationalText(reason)) {
      return { status: "queued", reasonCode: "missing_exact_reason" };
    }
    return { status: "blocked", reasonCode: explicit };
  }
  if (explicit && !["native_evidence_collected", "exhaustive_absence_verified"].includes(explicit)) {
    throw new Error(`Unknown structured collector reasonCode ${explicit}.`);
  }
  if (/captcha/i.test(text)) return exactBlock("captcha_required", text);
  if (/(?:rate.?limit|\b429\b)/i.test(text)) return exactBlock("rate_limited", text);
  if (/(?:access denied|forbidden|\b403\b|robots blocked)/i.test(text)) {
    return exactBlock("access_denied", text);
  }
  if (/(?:network|timeout|timed out|socket|econn|fetch failed|\b5\d\d\b)/i.test(text)) {
    return exactBlock("network_error", text);
  }
  if (/(?:no match|no result|not found|empty|no account|no posts?)/i.test(text)) {
    return { status: "queued", reasonCode: "no_match" };
  }
  if (["queued", "running", "needs_review", "requires_credentials", "manual_review"].includes(rawStatus)) {
    return {
      status: "queued",
      reasonCode: rawStatus === "requires_credentials"
        ? "missing_credentials"
        : "manual_review_required"
    };
  }
  if (["blocked_or_empty", "checked_empty", "empty", "failed", "skipped"].includes(rawStatus)) {
    return { status: "queued", reasonCode: "ambiguous_legacy_outcome" };
  }
  return { status: "queued", reasonCode: "manual_review_required" };
}

function exactBlock(reasonCode, reason) {
  return hasExactOperationalText(reason)
    ? { status: "blocked", reasonCode }
    : { status: "queued", reasonCode: "missing_exact_reason" };
}

function queuedClassification({ current, task, reasonCode, reason }) {
  return {
    status: "queued",
    reasonCode: QUEUED_REASON_CODE_SET.has(reasonCode)
      ? reasonCode
      : "manual_review_required",
    reason,
    nextAction: current.nextAction || queuedNextAction(reasonCode, task.taskKey)
  };
}

function queuedTaskOutcome({ task, reasonCode, reason, nextAction }) {
  return {
    taskKey: task.taskKey,
    accountKey: task.account?.accountKey ?? null,
    accountUrl: task.account?.url ?? null,
    attempt: null,
    profileScraped: false,
    profileReceipt: null,
    status: "queued",
    reasonCode,
    isTerminal: false,
    reason,
    nextAction,
    evidenceRefs: [],
    pendingEvidenceRefs: [],
    absenceVerification: null,
    rawCollectorStatus: null,
    rawCollectorReasonCode: null,
    rawCollectorReason: null
  };
}

function blockerNextAction(reasonCode, taskKey) {
  const actions = {
    access_denied: `Restore permitted public access for ${taskKey}, then retry the bounded collector.`,
    network_error: `Retry ${taskKey} after network health recovers and preserve the exact failure receipt if it repeats.`,
    captcha_required: `Queue ${taskKey} for a permitted non-personal access path or manual review without automating a signed-in account.`,
    rate_limited: `Retry ${taskKey} after the recorded rate-limit reset using bounded concurrency.`
  };
  return actions[reasonCode] ?? `Resolve every exact access blocker recorded for ${taskKey}, then retry.`;
}

function queuedNextAction(reasonCode, taskKey) {
  const actions = {
    missing_credentials: `Configure the required production credential for ${taskKey}, then execute a fresh dated attempt.`,
    no_match: `Review official identity sources for ${taskKey}; record exhaustive absence proof or a verified account mapping.`,
    missing_native_evidence: `Re-run ${taskKey} and persist native row IDs, digests, taskKey, and attemptId instead of a numeric count.`,
    ambiguous_legacy_outcome: `Re-run ${taskKey} to replace the ambiguous legacy outcome with a structured current-attempt receipt.`,
    missing_exact_reason: `Re-run ${taskKey} and record an exact structured access, network, captcha, rate, credential, no-match, or review reason.`
  };
  return actions[reasonCode] ?? `Manually review ${taskKey} and record a structured current-attempt outcome.`;
}

function aggregatePairTerminal(pair, outcomes) {
  const counts = countBy(outcomes, (outcome) => outcome.status);
  let status;
  if (counts.queued) status = "queued";
  else if (counts.blocked) status = "blocked";
  else if (counts.collected) status = "collected";
  else status = "verified_no_account";
  const relevantCodes = unique(
    outcomes.filter((outcome) => outcome.status === status).map((outcome) => outcome.reasonCode)
  );
  const reasonCode = status === "queued"
    ? relevantCodes.length === 1 ? relevantCodes[0] : "manual_review_required"
    : status === "blocked"
      ? relevantCodes.length === 1 ? relevantCodes[0] : "multiple_access_blocks"
      : status === "collected"
        ? "native_evidence_collected"
        : "exhaustive_absence_verified";
  const reason = outcomes.length === 1
    ? outcomes[0].reason
    : `${pair.pairKey} has ${outcomes.length} account/discovery tasks: ` +
      INGESTION_COVERAGE_TERMINAL_STATUSES
        .filter((candidate) => counts[candidate])
        .map((candidate) => `${counts[candidate]} ${candidate}`)
        .join(", ") + ".";
  const unresolved = outcomes.filter((outcome) =>
    ["queued", "blocked"].includes(outcome.status)
  );
  const nextAction = unresolved.length
    ? `Resolve ${unresolved.map((outcome) => outcome.taskKey).join(", ")} using their task-specific next actions before marking ${pair.pairKey} objective-complete.`
    : status === "collected"
      ? `Keep scheduled incremental ingestion current for ${pair.pairKey} and preserve physical evidence identities.`
      : `Repeat exhaustive absence verification for ${pair.pairKey} after canonical identity changes.`;
  return {
    status,
    reasonCode,
    isTerminal: status !== "queued",
    reason,
    nextAction,
    absenceVerification: status === "verified_no_account"
      ? outcomes[0].absenceVerification
      : null
  };
}

function summarizePairEvidence(evidenceKeys, context) {
  const entries = evidenceKeys.map((key) => context.registryByKey.get(key));
  const timestamps = entries.map((entry) => entry.publishedAt).sort();
  const recentEvidenceRefs = entries
    .filter((entry) => entry.recency === "recent")
    .map((entry) => entry.evidenceKey)
    .sort();
  const historicalEvidenceRefs = entries
    .filter((entry) => entry.recency === "historical")
    .map((entry) => entry.evidenceKey)
    .sort();
  return {
    // The receipt contract validates string arrays with ECMAScript code-unit
    // ordering. Registry rows use locale ordering for their own top-level
    // stream, so re-sort per-pair references instead of inheriting that order.
    evidenceRefs: [...evidenceKeys].sort(),
    recentEvidenceRefs,
    historicalEvidenceRefs,
    postCount: entries.length,
    recentPostCount: recentEvidenceRefs.length,
    historicalPostCount: historicalEvidenceRefs.length,
    storedUnpublishedCount: entries.filter((entry) => entry.storedUnpublished).length,
    pendingMultiAttributionCount: entries.filter((entry) =>
      entry.attributions.length > 1 &&
      context.attributionReviewsByEvidence.get(entry.evidenceKey)?.status !== "approved"
    ).length,
    oldestPublishedAt: timestamps[0] ?? null,
    newestPublishedAt: timestamps.at(-1) ?? null
  };
}

function normalizeScope(
  input,
  { pairKey, terminal, evidence = null, generatedAt, recencyPolicy, run }
) {
  const source = isObject(input) ? input : {};
  const recentBackfillReceipt = normalizeCoverageReceipt(
    source.recentBackfillReceipt,
    "recent_backfill",
    { generatedAt, pairKey, recencyPolicy, run }
  );
  const historicalBackfillReceipt = normalizeCoverageReceipt(
    source.historicalBackfillReceipt,
    "historical_backfill",
    { generatedAt, pairKey, recencyPolicy, run }
  );
  const storedUnpublishedReceipt = normalizeCoverageReceipt(
    source.storedUnpublishedReceipt,
    "stored_unpublished",
    { generatedAt, pairKey, recencyPolicy, run }
  );
  const schedulerReceipt = normalizeCoverageReceipt(
    source.schedulerReceipt,
    "scheduler",
    { generatedAt, pairKey, recencyPolicy, run }
  );
  const integrityChecks = normalizeIntegrityChecks(source.integrityChecks, {
    pairKey,
    run
  });
  const scope = {
    recentBackfillComplete: recentBackfillReceipt?.status === "complete",
    historicalBackfillComplete: historicalBackfillReceipt?.status === "complete",
    storedUnpublishedSurfaced: storedUnpublishedReceipt?.status === "complete",
    duplicatesVerified: integrityChecks.duplicates?.verified === true,
    attributionVerified: integrityChecks.attribution?.verified === true,
    timestampsVerified: integrityChecks.timestamps?.verified === true,
    scoringVerified: integrityChecks.scoring?.verified === true,
    integrityVerified: Object.values(integrityChecks).every((check) => check?.verified === true),
    scheduledIngestionCurrent: schedulerReceipt?.status === "current" &&
      Date.parse(schedulerReceipt.freshThrough) >= Date.parse(run.completedAt),
    receipts: {
      recentBackfill: recentBackfillReceipt,
      historicalBackfill: historicalBackfillReceipt,
      storedUnpublished: storedUnpublishedReceipt,
      scheduler: schedulerReceipt
    },
    integrityChecks,
    objectiveComplete: source.objectiveComplete === true
  };
  if (scope.objectiveComplete) {
    if (["queued", "blocked"].includes(terminal.status)) {
      throw new Error(`${pairKey} cannot be objectiveComplete while ${terminal.status}.`);
    }
    const missing = [
      ["recentBackfillReceipt", scope.recentBackfillComplete],
      ["historicalBackfillReceipt", scope.historicalBackfillComplete],
      ["storedUnpublishedReceipt", scope.storedUnpublishedSurfaced],
      ["duplicatesIntegrityReceipt", scope.duplicatesVerified],
      ["attributionIntegrityReceipt", scope.attributionVerified],
      ["timestampsIntegrityReceipt", scope.timestampsVerified],
      ["scoringIntegrityReceipt", scope.scoringVerified],
      ["freshSchedulerReceipt", scope.scheduledIngestionCurrent]
    ].filter(([, complete]) => !complete).map(([label]) => label);
    if (missing.length) {
      throw new Error(`${pairKey} cannot be objectiveComplete; missing ${missing.join(", ")}.`);
    }
    if ((evidence?.pendingMultiAttributionCount ?? 0) > 0) {
      throw new Error(`${pairKey} cannot be objectiveComplete with unresolved multi-attribution evidence.`);
    }
  }
  return scope;
}

function normalizeCoverageReceipt(
  value,
  kind,
  { generatedAt, pairKey, recencyPolicy, run }
) {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) throw new TypeError(`${pairKey} ${kind} receipt must be an object.`);
  const receiptId = requiredText(value.receiptId, `${pairKey} ${kind}.receiptId`);
  const checkedAt = requiredIsoTimestamp(value.checkedAt, `${pairKey} ${kind}.checkedAt`);
  assertTimestampWithinRun(checkedAt, run, `${pairKey} ${kind}.checkedAt`);
  const reason = requireExactOperationalText(value.reason, `${pairKey} ${kind}.reason`);
  if (kind === "scheduler") {
    const status = requiredText(value.status, `${pairKey} scheduler.status`);
    if (!["current", "stale", "failed"].includes(status)) {
      throw new Error(`${pairKey} scheduler.status must be current, stale, or failed.`);
    }
    const freshThrough = requiredIsoTimestamp(
      value.freshThrough,
      `${pairKey} scheduler.freshThrough`
    );
    assertNotTooFarFuture(freshThrough, generatedAt, `${pairKey} scheduler.freshThrough`);
    if (status === "current" && Date.parse(checkedAt) < Date.parse(freshThrough)) {
      throw new Error(`${pairKey} current scheduler receipt predates freshThrough.`);
    }
    return { receiptId, status, checkedAt, freshThrough, reason };
  }
  const status = requiredText(value.status, `${pairKey} ${kind}.status`);
  if (!["complete", "partial", "failed"].includes(status)) {
    throw new Error(`${pairKey} ${kind}.status must be complete, partial, or failed.`);
  }
  if (kind === "recent_backfill") {
    const coveredFrom = requiredIsoTimestamp(
      value.coveredFrom,
      `${pairKey} recent_backfill.coveredFrom`
    );
    const coveredThrough = requiredIsoTimestamp(
      value.coveredThrough,
      `${pairKey} recent_backfill.coveredThrough`
    );
    if (coveredFrom !== recencyPolicy.cutoffAt) {
      throw new Error(`${pairKey} recent backfill must begin at the versioned recency cutoff.`);
    }
    if (Date.parse(coveredThrough) > Date.parse(generatedAt) + INGESTION_TIMESTAMP_FUTURE_TOLERANCE_MS) {
      throw new Error(`${pairKey} recent backfill coveredThrough is too far in the future.`);
    }
    const requiredCoveredThrough = run.recentCoverageCutoff ?? run.completedAt;
    if (status === "complete" && coveredThrough !== requiredCoveredThrough) {
      throw new Error(
        `${pairKey} complete recent backfill must end at the immutable recent coverage cutoff.`
      );
    }
    if (status === "complete" && Date.parse(checkedAt) < Date.parse(coveredThrough)) {
      throw new Error(`${pairKey} complete recent backfill receipt predates coveredThrough.`);
    }
    return { receiptId, status, checkedAt, coveredFrom, coveredThrough, reason };
  }
  if (kind === "historical_backfill") {
    const coveredThrough = requiredIsoTimestamp(
      value.coveredThrough,
      `${pairKey} historical_backfill.coveredThrough`
    );
    if (coveredThrough !== recencyPolicy.cutoffAt) {
      throw new Error(`${pairKey} historical backfill must reach the versioned recency cutoff.`);
    }
    const technicalLimit = requireExactOperationalText(
      value.technicalLimit,
      `${pairKey} historical_backfill.technicalLimit`
    );
    return { receiptId, status, checkedAt, coveredThrough, technicalLimit, reason };
  }
  const coveredThrough = requiredIsoTimestamp(
    value.coveredThrough,
    `${pairKey} stored_unpublished.coveredThrough`
  );
  assertNotTooFarFuture(coveredThrough, generatedAt, `${pairKey} stored_unpublished.coveredThrough`);
  if (status === "complete" && Date.parse(coveredThrough) < Date.parse(run.completedAt)) {
    throw new Error(`${pairKey} stored-unpublished receipt does not reach run completion.`);
  }
  if (status === "complete" && Date.parse(checkedAt) < Date.parse(coveredThrough)) {
    throw new Error(`${pairKey} stored-unpublished receipt predates coveredThrough.`);
  }
  const storedProofFields = [
    "surfacedCounts",
    "sourceProofSha256",
    "publicationPolicy",
    "scoringEligible"
  ];
  const hasStoredProof = storedProofFields.some((field) =>
    Object.hasOwn(value, field)
  );
  let storedProof = {};
  if (hasStoredProof) {
    for (const field of storedProofFields) {
      if (!Object.hasOwn(value, field)) {
        throw new Error(
          `${pairKey} stored_unpublished.${field} is required when surfaced proof metadata is present.`
        );
      }
    }
    if (!isObject(value.surfacedCounts)) {
      throw new TypeError(`${pairKey} stored_unpublished.surfacedCounts must be an object.`);
    }
    const counts = Object.fromEntries([
      "historicalEvidenceRows",
      "githubEvidenceAttributions",
      "githubBlockerReviews",
      "evidenceAttributions",
      "totalAttributedRows"
    ].map((field) => {
      const count = value.surfacedCounts[field];
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new TypeError(
          `${pairKey} stored_unpublished.surfacedCounts.${field} must be a non-negative safe integer.`
        );
      }
      return [field, count];
    }));
    if (typeof value.surfacedCounts.explicitZero !== "boolean") {
      throw new TypeError(
        `${pairKey} stored_unpublished.surfacedCounts.explicitZero must be boolean.`
      );
    }
    if (
      !Number.isSafeInteger(
        counts.historicalEvidenceRows + counts.githubEvidenceAttributions
      ) ||
      counts.evidenceAttributions !==
        counts.historicalEvidenceRows + counts.githubEvidenceAttributions
    ) {
      throw new Error(
        `${pairKey} stored_unpublished evidenceAttributions does not reconcile with its source counts.`
      );
    }
    if (
      !Number.isSafeInteger(counts.evidenceAttributions + counts.githubBlockerReviews) ||
      counts.totalAttributedRows !==
        counts.evidenceAttributions + counts.githubBlockerReviews
    ) {
      throw new Error(
        `${pairKey} stored_unpublished totalAttributedRows does not reconcile with evidence and review counts.`
      );
    }
    if (value.surfacedCounts.explicitZero !== (counts.totalAttributedRows === 0)) {
      throw new Error(
        `${pairKey} stored_unpublished explicitZero does not reconcile with totalAttributedRows.`
      );
    }
    if (value.publicationPolicy !== "proof_only_no_publication") {
      throw new Error(
        `${pairKey} stored_unpublished.publicationPolicy must be proof_only_no_publication.`
      );
    }
    if (value.scoringEligible !== false) {
      throw new Error(`${pairKey} stored_unpublished.scoringEligible must be false.`);
    }
    storedProof = {
      surfacedCounts: {
        ...counts,
        explicitZero: value.surfacedCounts.explicitZero
      },
      sourceProofSha256: requiredSha256(
        value.sourceProofSha256,
        `${pairKey} stored_unpublished.sourceProofSha256`
      ),
      publicationPolicy: value.publicationPolicy,
      scoringEligible: false
    };
  }
  return { receiptId, status, checkedAt, coveredThrough, reason, ...storedProof };
}

function normalizeIntegrityChecks(value, { pairKey, run }) {
  const source = isObject(value) ? value : {};
  return Object.fromEntries([
    "duplicates",
    "attribution",
    "timestamps",
    "scoring"
  ].map((dimension) => {
    const check = source[dimension];
    if (check === null || check === undefined) return [dimension, null];
    if (!isObject(check)) {
      throw new TypeError(`${pairKey} integrityChecks.${dimension} must be an object.`);
    }
    const checkedAt = requiredIsoTimestamp(
      check.checkedAt,
      `${pairKey} integrityChecks.${dimension}.checkedAt`
    );
    assertTimestampWithinRun(
      checkedAt,
      run,
      `${pairKey} integrityChecks.${dimension}.checkedAt`
    );
    return [dimension, {
      receiptId: requiredText(
        check.receiptId,
        `${pairKey} integrityChecks.${dimension}.receiptId`
      ),
      verified: check.verified === true,
      checkedAt,
      artifactDigest: requiredSha256(
        check.artifactDigest,
        `${pairKey} integrityChecks.${dimension}.artifactDigest`
      ),
      toolVersion: requiredText(
        check.toolVersion,
        `${pairKey} integrityChecks.${dimension}.toolVersion`
      ),
      dependencyHash: requiredSha256(
        check.dependencyHash,
        `${pairKey} integrityChecks.${dimension}.dependencyHash`
      ),
      reason: requireExactOperationalText(
        check.reason,
        `${pairKey} integrityChecks.${dimension}.reason`
      )
    }];
  }));
}

function buildInventory(owners, pairs) {
  const companies = owners.filter((owner) => owner.entity.type === "company").length;
  const founders = owners.length - companies;
  return {
    companies,
    founders,
    entities: owners.length,
    corePlatforms: [...INGESTION_CORE_PLATFORMS],
    extendedOnlyPlatforms: [...INGESTION_EXTENDED_ONLY_PLATFORMS],
    corePairCount: owners.length * INGESTION_CORE_PLATFORMS.length,
    extendedPairCount: owners.length * ALL_PLATFORMS.length,
    extendedOnlyPairCount: owners.length * INGESTION_EXTENDED_ONLY_PLATFORMS.length,
    taskCount: pairs.reduce((sum, pair) => sum + pair.accountOutcomes.length, 0),
    knownVerifiedAccounts: pairs.reduce(
      (sum, pair) => sum + pair.mapping.verifiedAccountCount,
      0
    ),
    mappedEntityPlatformPairs: pairs.filter((pair) => pair.mapping.accountCount > 0).length,
    multiAccountExtraTasks: pairs.reduce(
      (sum, pair) => sum + Math.max(0, pair.accountOutcomes.length - 1),
      0
    )
  };
}

function buildInventoryFromReceipt(pairs) {
  const entities = new Map();
  for (const pair of pairs) {
    entities.set(`${pair.batchSlug}:${pair.entity.type}:${pair.entity.id}`, pair.entity.type);
  }
  return buildInventory(
    [...entities.entries()].map(([key, type]) => ({
      entity: { type },
      key
    })),
    pairs
  );
}

function summarizeReceipt(pairs, registry) {
  const global = newSummaryAccumulator();
  const cellAccumulators = new Map();
  for (const pair of pairs) {
    addPairToAccumulator(global, pair);
    const cellKey = `${pair.batchSlug}\u0000${pair.platform}\u0000${pair.entity.type}`;
    const cell = cellAccumulators.get(cellKey) ?? newSummaryAccumulator();
    addPairToAccumulator(cell, pair);
    cellAccumulators.set(cellKey, cell);
  }
  for (const entry of registry) addEvidenceToAccumulator(global, entry);

  const batches = unique(pairs.map((pair) => pair.batchSlug)).sort();
  const byBatchPlatform = {};
  for (const batchSlug of batches) {
    const platforms = {};
    for (const platform of ALL_PLATFORMS) {
      const company = cellAccumulators.get(`${batchSlug}\u0000${platform}\u0000company`)
        ?? newSummaryAccumulator();
      const founder = cellAccumulators.get(`${batchSlug}\u0000${platform}\u0000founder`)
        ?? newSummaryAccumulator();
      platforms[platform] = {
        company: finalizeSummaryAccumulator(company),
        founder: finalizeSummaryAccumulator(founder),
        total: finalizeSummaryAccumulator(mergeSummaryAccumulators(company, founder))
      };
    }
    byBatchPlatform[batchSlug] = platforms;
  }
  const totals = finalizeSummaryAccumulator(global);
  return {
    ...totals,
    pairCount: totals.pairs,
    taskCount: pairs.reduce((sum, pair) => sum + pair.accountOutcomes.length, 0),
    terminalPairCount: totals.terminalPairs,
    objectiveCompletePairCount: totals.objectiveCompletePairs,
    nonTerminalPairCount: totals.pairs - totals.terminalPairs,
    objectiveIncompletePairCount: totals.pairs - totals.objectiveCompletePairs,
    physicalPosts: registry.length,
    physicalRecentPosts: registry.filter((entry) => entry.recency === "recent").length,
    physicalHistoricalPosts: registry.filter((entry) => entry.recency === "historical").length,
    storedUnpublishedPosts: registry.filter((entry) => entry.storedUnpublished).length,
    byBatchPlatform
  };
}

function newSummaryAccumulator() {
  return {
    pairs: 0,
    companyPairs: 0,
    founderPairs: 0,
    terminalPairs: 0,
    objectiveCompletePairs: 0,
    collectedPairs: 0,
    verifiedNoAccountPairs: 0,
    blockedPairs: 0,
    queuedPairs: 0,
    mappedPairs: 0,
    verifiedAccounts: 0,
    profileMappedSet: new Set(),
    profileScrapedSet: new Set(),
    evidenceSet: new Set(),
    recentSet: new Set(),
    historicalSet: new Set(),
    blockerTasks: 0,
    unresolvedTasks: 0
  };
}

function addPairToAccumulator(accumulator, pair) {
  accumulator.pairs += 1;
  accumulator[pair.entity.type === "company" ? "companyPairs" : "founderPairs"] += 1;
  if (pair.terminal.isTerminal) accumulator.terminalPairs += 1;
  if (pair.scope.objectiveComplete) accumulator.objectiveCompletePairs += 1;
  const statusField = {
    collected: "collectedPairs",
    verified_no_account: "verifiedNoAccountPairs",
    blocked: "blockedPairs",
    queued: "queuedPairs"
  }[pair.terminal.status];
  accumulator[statusField] += 1;
  if (pair.mapping.accountCount > 0) accumulator.mappedPairs += 1;
  accumulator.verifiedAccounts += pair.mapping.verifiedAccountCount;
  for (const account of pair.mapping.accounts) {
    accumulator.profileMappedSet.add(`${pair.pairKey}\u0000${account.accountKey}`);
  }
  for (const outcome of pair.accountOutcomes) {
    if (outcome.accountKey && outcome.profileScraped) {
      accumulator.profileScrapedSet.add(`${pair.pairKey}\u0000${outcome.accountKey}`);
    }
  }
  accumulator.blockerTasks += pair.accountOutcomes.filter((outcome) =>
    outcome.status === "blocked"
  ).length;
  accumulator.unresolvedTasks += pair.accountOutcomes.filter((outcome) =>
    ["blocked", "queued"].includes(outcome.status)
  ).length;
  for (const evidenceKey of pair.evidence.evidenceRefs) {
    accumulator.evidenceSet.add(evidenceKey);
  }
  for (const evidenceKey of pair.evidence.recentEvidenceRefs) {
    accumulator.recentSet.add(evidenceKey);
  }
  for (const evidenceKey of pair.evidence.historicalEvidenceRefs) {
    accumulator.historicalSet.add(evidenceKey);
  }
}

function addEvidenceToAccumulator(accumulator, entry) {
  accumulator.evidenceSet.add(entry.evidenceKey);
  accumulator[entry.recency === "recent" ? "recentSet" : "historicalSet"].add(entry.evidenceKey);
}

function mergeSummaryAccumulators(left, right) {
  const merged = newSummaryAccumulator();
  for (const field of [
    "pairs",
    "companyPairs",
    "founderPairs",
    "terminalPairs",
    "objectiveCompletePairs",
    "collectedPairs",
    "verifiedNoAccountPairs",
    "blockedPairs",
    "queuedPairs",
    "mappedPairs",
    "verifiedAccounts",
    "blockerTasks",
    "unresolvedTasks"
  ]) merged[field] = left[field] + right[field];
  for (const source of [left, right]) {
    for (const key of source.profileMappedSet) merged.profileMappedSet.add(key);
    for (const key of source.profileScrapedSet) merged.profileScrapedSet.add(key);
    for (const key of source.evidenceSet) merged.evidenceSet.add(key);
    for (const key of source.recentSet) merged.recentSet.add(key);
    for (const key of source.historicalSet) merged.historicalSet.add(key);
  }
  return merged;
}

function finalizeSummaryAccumulator(accumulator) {
  const profilesMapped = accumulator.profileMappedSet.size;
  const profilesScraped = accumulator.profileScrapedSet.size;
  if (profilesScraped > profilesMapped) {
    throw new Error("Profile scrape summary cannot exceed canonical mapped profiles.");
  }
  return {
    pairs: accumulator.pairs,
    companyPairs: accumulator.companyPairs,
    founderPairs: accumulator.founderPairs,
    terminalPairs: accumulator.terminalPairs,
    objectiveCompletePairs: accumulator.objectiveCompletePairs,
    collectedPairs: accumulator.collectedPairs,
    verifiedNoAccountPairs: accumulator.verifiedNoAccountPairs,
    blockedPairs: accumulator.blockedPairs,
    queuedPairs: accumulator.queuedPairs,
    mappedPairs: accumulator.mappedPairs,
    verifiedAccounts: accumulator.verifiedAccounts,
    profilesMapped,
    profilesScraped,
    posts: accumulator.evidenceSet.size,
    recentPosts: accumulator.recentSet.size,
    historicalPosts: accumulator.historicalSet.size,
    blockerTasks: accumulator.blockerTasks,
    unresolvedTasks: accumulator.unresolvedTasks,
    terminalCoveragePercent: percent(accumulator.terminalPairs, accumulator.pairs),
    objectiveCoveragePercent: percent(accumulator.objectiveCompletePairs, accumulator.pairs),
    mappingCoveragePercent: percent(accumulator.mappedPairs, accumulator.pairs),
    profileScrapeCoveragePercent: percent(
      profilesScraped,
      profilesMapped
    )
  };
}

function normalizeExpectedCatalogManifest(manifest) {
  if (!isObject(manifest)) {
    throw new TypeError(
      "expectedCatalogManifest is required; receipt catalog metadata cannot validate itself."
    );
  }
  if (manifest.version !== INGESTION_CATALOG_MANIFEST_VERSION) {
    throw new Error(
      `expectedCatalogManifest.version must be ${INGESTION_CATALOG_MANIFEST_VERSION}.`
    );
  }
  if (!Array.isArray(manifest.batches) || !manifest.batches.length) {
    throw new TypeError("expectedCatalogManifest.batches must be non-empty.");
  }
  const batches = manifest.batches.map((batch) => ({
    batchSlug: requiredText(batch?.batchSlug, "expected batchSlug"),
    sourcePath: requiredText(batch?.sourcePath, "expected sourcePath"),
    sourceVersion: requiredText(batch?.sourceVersion, "expected sourceVersion"),
    sourceHash: requiredSha256(batch?.sourceHash, "expected sourceHash"),
    companies: requiredNonNegativeInteger(batch?.companies, "expected companies"),
    founders: requiredNonNegativeInteger(batch?.founders, "expected founders"),
    entities: requiredNonNegativeInteger(batch?.entities, "expected entities")
  })).sort((left, right) => left.batchSlug.localeCompare(right.batchSlug));
  assertUniqueSorted(batches, (batch) => batch.batchSlug, "expected catalog batches");
  for (const batch of batches) {
    if (batch.entities !== batch.companies + batch.founders) {
      throw new Error(`${batch.batchSlug} expected entity count is inconsistent.`);
    }
  }
  return { version: INGESTION_CATALOG_MANIFEST_VERSION, batches };
}

function validateCatalogManifest(actual, expected) {
  const normalizedActual = normalizeExpectedCatalogManifest(actual);
  if (stableJson(normalizedActual) !== stableJson(expected)) {
    throw new Error(
      "receipt.catalogManifest does not match the independently expected source versions, hashes, and counts."
    );
  }
  if (stableJson(actual) !== stableJson(normalizedActual)) {
    throw new Error("receipt.catalogManifest must use canonical batch ordering and fields.");
  }
}

function validateSerializationMetadata(value) {
  const expected = {
    strategy: SERIALIZATION_STRATEGY,
    normalizedEvidenceRegistry: true,
    pairEvidenceStoredAsReferences: true,
    recommendedMaxChunkCharacters: 65_536
  };
  if (stableJson(value) !== stableJson(expected)) {
    throw new Error("receipt.serialization must declare the normalized bounded-streaming strategy.");
  }
}

function validatePairMatrixStructure(pairs) {
  const pairIndex = new Map();
  const entityPlatforms = new Map();
  let previousPairKey = null;
  for (const pair of pairs) {
    if (!isObject(pair)) throw new TypeError("Each receipt pair must be an object.");
    const batchSlug = requiredText(pair.batchSlug, "pair.batchSlug");
    if (!isObject(pair.company) || !isObject(pair.entity)) {
      throw new TypeError(`${pair.pairKey ?? "Pair"} must contain company and entity objects.`);
    }
    const companyId = requiredText(pair.company.id, "pair.company.id");
    requiredText(pair.company.name, "pair.company.name");
    const entityType = normalizeEntityType(pair.entity.type);
    const entityId = requiredText(pair.entity.id, "pair.entity.id");
    requiredText(pair.entity.name, "pair.entity.name");
    if (entityType === "company" && companyId !== entityId) {
      throw new Error(`${pair.pairKey} company entity id must equal company.id.`);
    }
    const platform = normalizePlatform(pair.platform);
    const expectedPairKey = coveragePairKey({ batchSlug, entityType, entityId, platform });
    if (pair.pairKey !== expectedPairKey) {
      throw new Error(`pairKey ${pair.pairKey} must equal ${expectedPairKey}.`);
    }
    if (pairIndex.has(pair.pairKey)) throw new Error(`Duplicate pairKey ${pair.pairKey}.`);
    if (previousPairKey !== null && previousPairKey.localeCompare(pair.pairKey) > 0) {
      throw new Error("receipt.pairs must use canonical pairKey ordering.");
    }
    previousPairKey = pair.pairKey;
    pairIndex.set(pair.pairKey, pair);
    const entityKey = `${batchSlug}:${entityType}:${entityId}`;
    const identity = entityPlatforms.get(entityKey) ?? {
      companyId,
      companyName: pair.company.name,
      entityName: pair.entity.name,
      platforms: new Set()
    };
    if (
      identity.companyId !== companyId ||
      identity.companyName !== pair.company.name ||
      identity.entityName !== pair.entity.name
    ) {
      throw new Error(`${entityKey} changes canonical identity within the pair matrix.`);
    }
    if (identity.platforms.has(platform)) {
      throw new Error(`${entityKey} repeats platform ${platform}.`);
    }
    identity.platforms.add(platform);
    entityPlatforms.set(entityKey, identity);
  }
  for (const [entityKey, identity] of entityPlatforms) {
    const missing = ALL_PLATFORMS.filter((platform) => !identity.platforms.has(platform));
    if (missing.length || identity.platforms.size !== ALL_PLATFORMS.length) {
      throw new Error(`${entityKey} lacks complete 13-platform coverage: ${missing.join(", ")}.`);
    }
  }
  return pairIndex;
}

function validateEvidenceRegistry(registry, pairIndex, recencyPolicy, generatedAt, run) {
  const index = new Map();
  let previousKey = null;
  for (const entry of registry) {
    if (!isObject(entry)) throw new TypeError("Evidence registry entries must be objects.");
    const platform = normalizePlatform(entry.platform);
    const nativeId = clean(entry.nativeId) || null;
    const canonicalUrl = entry.canonicalUrl === null
      ? null
      : canonicalizePlatformUrl(platform, entry.canonicalUrl, { kind: "evidence" });
    if (!nativeId && !canonicalUrl) throw new Error("Registry evidence requires nativeId or URL.");
    const aliases = physicalEvidenceAliases({ platform, nativeId, canonicalUrl });
    if (entry.evidenceKey !== aliases[0]) {
      throw new Error(`${entry.evidenceKey} does not match its canonical physical identity.`);
    }
    if (previousKey !== null && previousKey.localeCompare(entry.evidenceKey) > 0) {
      throw new Error("receipt.evidenceRegistry must use canonical evidenceKey ordering.");
    }
    previousKey = entry.evidenceKey;
    if (index.has(entry.evidenceKey)) throw new Error(`Duplicate registry key ${entry.evidenceKey}.`);
    requiredSha256(entry.digest, `${entry.evidenceKey}.digest`);
    const publishedAt = requiredIsoTimestamp(
      entry.publishedAt,
      `${entry.evidenceKey}.publishedAt`
    );
    assertNotTooFarFuture(publishedAt, generatedAt, `${entry.evidenceKey}.publishedAt`);
    if (entry.recency !== deriveRecency(publishedAt, recencyPolicy)) {
      throw new Error(`${entry.evidenceKey}.recency is not derived from the versioned cutoff.`);
    }
    if (typeof entry.storedUnpublished !== "boolean") {
      throw new TypeError(`${entry.evidenceKey}.storedUnpublished must be boolean.`);
    }
    const attributions = sortedUniqueStrings(
      entry.attributions,
      `${entry.evidenceKey}.attributions`
    );
    if (stableJson(attributions) !== stableJson(entry.attributions)) {
      throw new Error(`${entry.evidenceKey}.attributions must be canonically ordered.`);
    }
    for (const pairKey of attributions) {
      const pair = pairIndex.get(pairKey);
      if (!pair) throw new Error(`${entry.evidenceKey} references unknown pair ${pairKey}.`);
      if (pair.platform !== platform) {
        throw new Error(`${entry.evidenceKey} attribution ${pairKey} has the wrong platform.`);
      }
    }
    if (!Array.isArray(entry.sourceRefs) || !entry.sourceRefs.length) {
      throw new Error(`${entry.evidenceKey}.sourceRefs must be non-empty.`);
    }
    let previousRef = null;
    const refKeys = new Set();
    for (const source of entry.sourceRefs) {
      validateSourceRef(source, entry, pairIndex, generatedAt, run);
      const key = stableJson(source);
      if (refKeys.has(key)) throw new Error(`${entry.evidenceKey} repeats a sourceRef.`);
      refKeys.add(key);
      if (previousRef && compareSourceRefs(previousRef, source) > 0) {
        throw new Error(`${entry.evidenceKey}.sourceRefs must be canonically ordered.`);
      }
      previousRef = source;
    }
    index.set(entry.evidenceKey, entry);
  }
  return index;
}

function validateSourceRef(source, entry, pairIndex, generatedAt, run) {
  if (!isObject(source)) throw new TypeError(`${entry.evidenceKey} sourceRef must be an object.`);
  const pairKey = requiredText(source.pairKey, `${entry.evidenceKey} sourceRef.pairKey`);
  if (!entry.attributions.includes(pairKey) || !pairIndex.has(pairKey)) {
    throw new Error(`${entry.evidenceKey} sourceRef has unknown attribution ${pairKey}.`);
  }
  for (const field of [
    "taskKey",
    "attemptId",
    "attemptStartedAt",
    "attemptCheckedAt",
    "accountIdentity"
  ]) {
    if (!(source[field] === null || typeof source[field] === "string")) {
      throw new TypeError(`${entry.evidenceKey} sourceRef.${field} must be string or null.`);
    }
  }
  for (const field of ["taskKey", "attemptId"]) {
    if (typeof source[field] === "string") requiredText(source[field], `${entry.evidenceKey} sourceRef.${field}`);
  }
  if (source.accountIdentity !== null) {
    const prefix = `${entry.platform}:`;
    if (!source.accountIdentity.startsWith(prefix)) {
      throw new Error(`${entry.evidenceKey} sourceRef.accountIdentity has the wrong platform.`);
    }
    const rawUrl = source.accountIdentity.slice(prefix.length);
    const canonicalUrl = canonicalizePlatformUrl(entry.platform, rawUrl, { kind: "account" });
    if (source.accountIdentity !== `${entry.platform}:${canonicalUrl}`) {
      throw new Error(`${entry.evidenceKey} sourceRef.accountIdentity is not canonical.`);
    }
  }
  const observedAt = requiredIsoTimestamp(
    source.observedAt,
    `${entry.evidenceKey} sourceRef.observedAt`
  );
  assertTimestampWithinRun(observedAt, run, `${entry.evidenceKey} sourceRef.observedAt`);
  if (source.attemptId) {
    const attemptStartedAt = requiredIsoTimestamp(
      source.attemptStartedAt,
      `${entry.evidenceKey} sourceRef.attemptStartedAt`
    );
    const attemptCheckedAt = requiredIsoTimestamp(
      source.attemptCheckedAt,
      `${entry.evidenceKey} sourceRef.attemptCheckedAt`
    );
    assertTimestampWithinRun(
      attemptStartedAt,
      run,
      `${entry.evidenceKey} sourceRef.attemptStartedAt`
    );
    assertTimestampWithinRun(
      attemptCheckedAt,
      run,
      `${entry.evidenceKey} sourceRef.attemptCheckedAt`
    );
    if (Date.parse(attemptStartedAt) > Date.parse(attemptCheckedAt)) {
      throw new Error(`${entry.evidenceKey} sourceRef attempt window is inverted.`);
    }
    assertObservedWithinAttempt(
      observedAt,
      { startedAt: attemptStartedAt, checkedAt: attemptCheckedAt },
      `${entry.evidenceKey} sourceRef.observedAt`
    );
  } else if (source.attemptStartedAt !== null || source.attemptCheckedAt !== null) {
    throw new Error(`${entry.evidenceKey} sourceRef has an attempt window without attemptId.`);
  }
}

function validateMultiAttributionReviews(reviews, registryIndex, generatedAt, run) {
  const index = new Map();
  let previousKey = null;
  for (const review of reviews) {
    const evidenceKey = requiredText(review?.evidenceKey, "review.evidenceKey");
    if (previousKey !== null && previousKey.localeCompare(evidenceKey) > 0) {
      throw new Error("multiAttributionReviews must use canonical evidenceKey ordering.");
    }
    previousKey = evidenceKey;
    if (index.has(evidenceKey)) throw new Error(`Duplicate review ${evidenceKey}.`);
    const entry = registryIndex.get(evidenceKey);
    if (!entry || entry.attributions.length < 2) {
      throw new Error(`${evidenceKey} review does not resolve to multi-attributed evidence.`);
    }
    if (!['approved', 'needs_review'].includes(review.status)) {
      throw new Error(`${evidenceKey} review.status is invalid.`);
    }
    if (stableJson(review.attributionPairKeys) !== stableJson(entry.attributions)) {
      throw new Error(`${evidenceKey} review attribution set is not exact.`);
    }
    if (review.status === "approved") {
      const reviewedAt = requiredIsoTimestamp(review.reviewedAt, `${evidenceKey}.reviewedAt`);
      assertTimestampWithinRun(reviewedAt, run, `${evidenceKey}.reviewedAt`);
    } else if (review.reviewedAt !== null) {
      throw new Error(`${evidenceKey} needs_review must have reviewedAt=null.`);
    }
    requireExactOperationalText(review.reason, `${evidenceKey}.review.reason`);
    requireExactOperationalText(review.nextAction, `${evidenceKey}.review.nextAction`);
    index.set(evidenceKey, review);
  }
  for (const entry of registryIndex.values()) {
    if (entry.attributions.length > 1 && !index.has(entry.evidenceKey)) {
      throw new Error(`${entry.evidenceKey} requires explicit multi-attribution review.`);
    }
  }
  return index;
}

function validatePair(pair, context) {
  const expectedScope = INGESTION_CORE_PLATFORMS.includes(pair.platform)
    ? "core"
    : "extended_only";
  if (pair.matrixScope !== expectedScope) {
    throw new Error(`${pair.pairKey}.matrixScope must be ${expectedScope}.`);
  }
  validateApplicability(pair);
  validateMapping(pair);
  if (!Array.isArray(pair.accountOutcomes) || !pair.accountOutcomes.length) {
    throw new Error(`${pair.pairKey}.accountOutcomes must be non-empty.`);
  }
  let previousTaskKey = null;
  const taskKeys = new Set();
  for (const outcome of pair.accountOutcomes) {
    validateAccountOutcome(outcome, pair, context);
    if (taskKeys.has(outcome.taskKey)) {
      throw new Error(`${pair.pairKey} repeats taskKey ${outcome.taskKey}.`);
    }
    if (previousTaskKey !== null && previousTaskKey.localeCompare(outcome.taskKey) > 0) {
      throw new Error(`${pair.pairKey}.accountOutcomes must be canonically ordered.`);
    }
    previousTaskKey = outcome.taskKey;
    taskKeys.add(outcome.taskKey);
  }
  validateTerminal(pair.terminal, `${pair.pairKey}.terminal`, context.generatedAt);
  const expectedTerminal = aggregatePairTerminal(pair, pair.accountOutcomes);
  if (stableJson(pair.terminal) !== stableJson(expectedTerminal)) {
    throw new Error(`${pair.pairKey}.terminal does not reconcile exactly with tasks.`);
  }
  validatePairEvidence(pair.evidence, pair, context);
  if (pair.terminal.status === "verified_no_account" &&
      (pair.mapping.accountCount > 0 || pair.evidence.postCount > 0)) {
    throw new Error(`${pair.pairKey} verified_no_account conflicts with mappings or stored evidence.`);
  }
  validateScope(pair.scope, pair, context);
  const rawStatuses = unique(
    pair.accountOutcomes.map((outcome) => outcome.rawCollectorStatus).filter(Boolean)
  );
  const rawReasons = unique(
    pair.accountOutcomes.map((outcome) => outcome.rawCollectorReason).filter(Boolean)
  );
  const expectedRawStatus = rawStatuses.length > 1 ? "mixed" : rawStatuses[0] ?? null;
  const expectedRawReason = rawReasons.length > 1 ? rawReasons.join(" | ") : rawReasons[0] ?? null;
  if (
    pair.rawCollectorStatus !== expectedRawStatus ||
    pair.rawCollectorReason !== expectedRawReason
  ) {
    throw new Error(`${pair.pairKey} raw collector aggregate is not deterministic.`);
  }
}

function validateApplicability(pair) {
  if (!isObject(pair.applicability)) {
    throw new TypeError(`${pair.pairKey}.applicability must be an object.`);
  }
  if (!['applicable', 'not_applicable', 'collector_unavailable'].includes(pair.applicability.status)) {
    throw new Error(`${pair.pairKey}.applicability.status is invalid.`);
  }
  requireExactOperationalText(pair.applicability.reason, `${pair.pairKey}.applicability.reason`);
}

function validateMapping(pair) {
  const mapping = pair.mapping;
  if (!isObject(mapping) || !Array.isArray(mapping.accounts)) {
    throw new TypeError(`${pair.pairKey}.mapping must contain accounts.`);
  }
  if (mapping.accountCount !== mapping.accounts.length) {
    throw new Error(`${pair.pairKey}.mapping.accountCount is incorrect.`);
  }
  let previousKey = null;
  let verified = 0;
  const keys = new Set();
  for (const account of mapping.accounts) {
    const normalized = normalizeAccount(account);
    if (stableJson(normalized) !== stableJson(account)) {
      throw new Error(`${pair.pairKey} account is not canonically serialized.`);
    }
    if (account.platform !== pair.platform) {
      throw new Error(`${pair.pairKey} contains ${account.platform} mapping.`);
    }
    if (keys.has(account.accountKey)) throw new Error(`${pair.pairKey} repeats accountKey.`);
    if (previousKey !== null && previousKey.localeCompare(account.accountKey) > 0) {
      throw new Error(`${pair.pairKey}.mapping.accounts must be canonically ordered.`);
    }
    previousKey = account.accountKey;
    keys.add(account.accountKey);
    if (account.verified) verified += 1;
  }
  if (mapping.verifiedAccountCount !== verified) {
    throw new Error(`${pair.pairKey}.mapping.verifiedAccountCount is incorrect.`);
  }
  if (mapping.status !== (mapping.accountCount ? "mapped" : "unmapped")) {
    throw new Error(`${pair.pairKey}.mapping.status is inconsistent.`);
  }
}

function validateAccountOutcome(outcome, pair, context) {
  if (!isObject(outcome)) throw new TypeError(`${pair.pairKey} task outcome must be an object.`);
  requiredText(outcome.taskKey, `${pair.pairKey} outcome.taskKey`);
  validateStatusAndTaxonomy(outcome, `${outcome.taskKey}`);
  requireExactOperationalText(outcome.reason, `${outcome.taskKey}.reason`);
  requireExactOperationalText(outcome.nextAction, `${outcome.taskKey}.nextAction`);
  if (typeof outcome.profileScraped !== "boolean") {
    throw new TypeError(`${outcome.taskKey}.profileScraped must be boolean.`);
  }
  validateRawOutcomeContract(
    outcome.rawCollectorStatus,
    outcome.rawCollectorReasonCode,
    outcome.rawCollectorReason,
    outcome.taskKey
  );
  if (outcome.attempt === null) {
    if (outcome.profileScraped || outcome.profileReceipt !== null || outcome.status !== "queued") {
      throw new Error(`${outcome.taskKey} lacks an attempt but claims scraped or terminal.`);
    }
  } else {
    if (!isObject(outcome.attempt)) throw new TypeError(`${outcome.taskKey}.attempt is invalid.`);
    requiredText(outcome.attempt.attemptId, `${outcome.taskKey}.attempt.attemptId`);
    requiredNonNegativeInteger(outcome.attempt.sequence, `${outcome.taskKey}.attempt.sequence`);
    const startedAt = requiredIsoTimestamp(
      outcome.attempt.startedAt,
      `${outcome.taskKey}.attempt.startedAt`
    );
    const checkedAt = requiredIsoTimestamp(
      outcome.attempt.checkedAt,
      `${outcome.taskKey}.attempt.checkedAt`
    );
    assertTimestampWithinRun(startedAt, context.run, `${outcome.taskKey}.attempt.startedAt`);
    assertTimestampWithinRun(checkedAt, context.run, `${outcome.taskKey}.attempt.checkedAt`);
    if (Date.parse(startedAt) > Date.parse(checkedAt)) {
      throw new Error(`${outcome.taskKey}.attempt.startedAt must not exceed checkedAt.`);
    }
    const account = pair.mapping.accounts.find((candidate) =>
      candidate.accountKey === outcome.accountKey
    ) ?? null;
    const normalizedProfileReceipt = normalizeProfileReceipt(outcome.profileReceipt, {
      pair,
      account,
      run: context.run,
      startedAt,
      checkedAt
    });
    if (stableJson(normalizedProfileReceipt) !== stableJson(outcome.profileReceipt)) {
      throw new Error(`${outcome.taskKey}.profileReceipt must be canonically serialized.`);
    }
    if (outcome.profileScraped !== Boolean(normalizedProfileReceipt)) {
      throw new Error(`${outcome.taskKey}.profileScraped must derive from profileReceipt.`);
    }
  }
  if (!Array.isArray(outcome.evidenceRefs)) {
    throw new TypeError(`${outcome.taskKey}.evidenceRefs must be an array.`);
  }
  const evidenceRefs = sortedUniqueStrings(
    outcome.evidenceRefs,
    `${outcome.taskKey}.evidenceRefs`,
    { allowEmpty: true }
  );
  if (stableJson(evidenceRefs) !== stableJson(outcome.evidenceRefs)) {
    throw new Error(`${outcome.taskKey}.evidenceRefs must be unique and canonically ordered.`);
  }
  const pendingEvidenceRefs = sortedUniqueStrings(
    outcome.pendingEvidenceRefs,
    `${outcome.taskKey}.pendingEvidenceRefs`,
    { allowEmpty: true }
  );
  if (stableJson(pendingEvidenceRefs) !== stableJson(outcome.pendingEvidenceRefs)) {
    throw new Error(`${outcome.taskKey}.pendingEvidenceRefs must be unique and canonically ordered.`);
  }
  for (const evidenceKey of pendingEvidenceRefs) {
    const entry = context.registryIndex.get(evidenceKey);
    if (!entry?.attributions.includes(pair.pairKey) ||
        context.reviewIndex.get(evidenceKey)?.status !== "needs_review") {
      throw new Error(`${outcome.taskKey} pending evidence lacks an unresolved attribution review.`);
    }
  }
  if (outcome.status === "collected" && !outcome.evidenceRefs.length) {
    throw new Error(`${outcome.taskKey} cannot be collected from numeric counts or stale corpus evidence.`);
  }
  if (outcome.status !== "collected" && outcome.evidenceRefs.length) {
    throw new Error(`${outcome.taskKey} non-collected outcome cannot claim evidenceRefs.`);
  }
  for (const evidenceKey of outcome.evidenceRefs) {
    const entry = context.registryIndex.get(evidenceKey);
    if (!entry || !entry.attributions.includes(pair.pairKey)) {
      throw new Error(`${outcome.taskKey} references non-attributed evidence ${evidenceKey}.`);
    }
    if (entry.attributions.length > 1 &&
        context.reviewIndex.get(evidenceKey)?.status !== "approved") {
      throw new Error(`${outcome.taskKey} claims evidence with unresolved attribution review.`);
    }
    const exactSources = entry.sourceRefs.filter((source) =>
      source.pairKey === pair.pairKey &&
      source.taskKey === outcome.taskKey &&
      source.attemptId === outcome.attempt?.attemptId
    );
    const exactSource = exactSources.length > 0;
    const fallbackSources = !exactSource && outcome.accountKey &&
      pair.accountOutcomes.filter((candidate) => candidate.accountKey === outcome.accountKey).length === 1 &&
      entry.sourceRefs.filter((source) =>
        source.pairKey === pair.pairKey &&
        source.taskKey === null &&
        source.attemptId === outcome.attempt?.attemptId &&
        source.accountIdentity === pair.mapping.accounts.find(
          (account) => account.accountKey === outcome.accountKey
        )?.identity
      ) || [];
    const accountFallback = fallbackSources.length > 0;
    if (!exactSource && !accountFallback) {
      throw new Error(`${outcome.taskKey} evidence ${evidenceKey} is not linked to its current attempt.`);
    }
    for (const source of [...exactSources, ...fallbackSources]) {
      if (
        source.attemptStartedAt !== outcome.attempt.startedAt ||
        source.attemptCheckedAt !== outcome.attempt.checkedAt
      ) {
        throw new Error(`${evidenceKey} sourceRef attempt window does not match current attempt.`);
      }
      assertObservedWithinAttempt(
        source.observedAt,
        {
          startedAt: outcome.attempt.startedAt,
          checkedAt: outcome.attempt.checkedAt
        },
        `${evidenceKey} sourceRef.observedAt`
      );
    }
  }
  if (outcome.status === "verified_no_account") {
    if (outcome.accountKey || outcome.accountUrl || pair.mapping.accountCount) {
      throw new Error(`${outcome.taskKey} verified_no_account conflicts with a known mapping.`);
    }
    const normalizedAbsence = assertExhaustiveAbsenceVerification(
      outcome.absenceVerification,
      `${outcome.taskKey}.absenceVerification`,
      context.generatedAt
    );
    if (stableJson(normalizedAbsence) !== stableJson(outcome.absenceVerification)) {
      throw new Error(`${outcome.taskKey}.absenceVerification must be canonically ordered.`);
    }
    assertObservedWithinAttempt(
      normalizedAbsence.checkedAt,
      {
        startedAt: outcome.attempt.startedAt,
        checkedAt: outcome.attempt.checkedAt
      },
      `${outcome.taskKey}.absenceVerification.checkedAt`
    );
  } else if (outcome.absenceVerification !== null) {
    throw new Error(`${outcome.taskKey} may retain absence verification only when verified_no_account.`);
  }
  if (outcome.accountKey) {
    const account = pair.mapping.accounts.find((candidate) =>
      candidate.accountKey === outcome.accountKey
    );
    if (!account || account.url !== outcome.accountUrl) {
      throw new Error(`${outcome.taskKey} does not resolve to its mapping account.`);
    }
  } else if (outcome.accountUrl !== null) {
    throw new Error(`${outcome.taskKey} has accountUrl without accountKey.`);
  }
  if (outcome.attempt) {
    const recomputed = classifyCurrentAttempt({
      current: {
        attemptId: outcome.attempt.attemptId,
        attemptSequence: outcome.attempt.sequence,
        startedAt: outcome.attempt.startedAt,
        checkedAt: outcome.attempt.checkedAt,
        rawStatus: outcome.rawCollectorStatus ?? "",
        rawReasonCode: outcome.rawCollectorReasonCode,
        rawReason: outcome.rawCollectorReason ?? "",
        nextAction: outcome.nextAction,
        absenceVerification: outcome.absenceVerification,
        profileReceipt: outcome.profileReceipt,
        numericEvidenceCount: null
      },
      task: { taskKey: outcome.taskKey },
      pair,
      evidenceResolution: {
        approvedEvidenceKeys: outcome.evidenceRefs,
        pendingAttributionKeys: outcome.pendingEvidenceRefs,
        allCurrentEvidenceKeys: [...outcome.evidenceRefs, ...outcome.pendingEvidenceRefs]
      }
    });
    if (
      outcome.status !== recomputed.status ||
      outcome.reasonCode !== recomputed.reasonCode ||
      outcome.reason !== recomputed.reason ||
      outcome.nextAction !== recomputed.nextAction
    ) {
      throw new Error(`${outcome.taskKey} status does not match its current raw collector attempt.`);
    }
  }
}

function validateStatusAndTaxonomy(value, label, { aggregate = false } = {}) {
  if (!TERMINAL_STATUS_SET.has(value.status)) {
    throw new Error(`${label}.status is invalid.`);
  }
  if (value.isTerminal !== (value.status !== "queued")) {
    throw new Error(`${label}.isTerminal is inconsistent.`);
  }
  const blockerCodes = aggregate ? BLOCKER_REASON_CODE_SET : DIRECT_BLOCKER_REASON_CODE_SET;
  if (value.status === "blocked" && !blockerCodes.has(value.reasonCode)) {
    throw new Error(`${label} blocked status requires an exact access/network/captcha/rate reason code.`);
  }
  if (value.status === "queued" && !QUEUED_REASON_CODE_SET.has(value.reasonCode)) {
    throw new Error(`${label} queued status requires a queued taxonomy reason code.`);
  }
  if (value.status === "collected" && value.reasonCode !== "native_evidence_collected") {
    throw new Error(`${label} collected status requires native_evidence_collected.`);
  }
  if (value.status === "verified_no_account" &&
      value.reasonCode !== "exhaustive_absence_verified") {
    throw new Error(`${label} verified absence taxonomy is invalid.`);
  }
}

function validateTerminal(terminal, label, generatedAt) {
  if (!isObject(terminal)) throw new TypeError(`${label} must be an object.`);
  validateStatusAndTaxonomy(terminal, label, { aggregate: true });
  requireExactOperationalText(terminal.reason, `${label}.reason`);
  requireExactOperationalText(terminal.nextAction, `${label}.nextAction`);
  if (terminal.status === "verified_no_account") {
    const normalizedAbsence = assertExhaustiveAbsenceVerification(
      terminal.absenceVerification,
      `${label}.absenceVerification`,
      generatedAt
    );
    if (stableJson(normalizedAbsence) !== stableJson(terminal.absenceVerification)) {
      throw new Error(`${label}.absenceVerification must be canonically ordered.`);
    }
  } else if (terminal.absenceVerification !== null) {
    throw new Error(`${label}.absenceVerification must be null unless verified_no_account.`);
  }
}

function validatePairEvidence(evidence, pair, context) {
  if (!isObject(evidence)) throw new TypeError(`${pair.pairKey}.evidence must be an object.`);
  const evidenceRefs = sortedUniqueStrings(
    evidence.evidenceRefs,
    `${pair.pairKey}.evidence.evidenceRefs`,
    { allowEmpty: true }
  );
  if (stableJson(evidenceRefs) !== stableJson(evidence.evidenceRefs)) {
    throw new Error(`${pair.pairKey}.evidence.evidenceRefs must be canonically ordered.`);
  }
  if (evidence.oldestPublishedAt !== null) {
    requiredIsoTimestamp(evidence.oldestPublishedAt, `${pair.pairKey}.evidence.oldestPublishedAt`);
  }
  if (evidence.newestPublishedAt !== null) {
    requiredIsoTimestamp(evidence.newestPublishedAt, `${pair.pairKey}.evidence.newestPublishedAt`);
  }
  if (evidence.oldestPublishedAt && evidence.newestPublishedAt &&
      Date.parse(evidence.oldestPublishedAt) > Date.parse(evidence.newestPublishedAt)) {
    throw new Error(`${pair.pairKey} oldestPublishedAt exceeds newestPublishedAt.`);
  }
  const expected = summarizePairEvidence(evidence.evidenceRefs, {
    registryByKey: context.registryIndex,
    attributionReviewsByEvidence: context.reviewIndex
  });
  if (stableJson(evidence) !== stableJson(expected)) {
    throw new Error(`${pair.pairKey}.evidence does not reconcile with the physical registry.`);
  }
  for (const evidenceKey of evidence.evidenceRefs) {
    const entry = context.registryIndex.get(evidenceKey);
    if (!entry?.attributions.includes(pair.pairKey)) {
      throw new Error(`${pair.pairKey} references evidence without exact attribution.`);
    }
  }
}

function validateScope(scope, pair, context) {
  if (!isObject(scope)) throw new TypeError(`${pair.pairKey}.scope must be an object.`);
  const normalized = normalizeScope({
    recentBackfillReceipt: scope.receipts?.recentBackfill,
    historicalBackfillReceipt: scope.receipts?.historicalBackfill,
    storedUnpublishedReceipt: scope.receipts?.storedUnpublished,
    schedulerReceipt: scope.receipts?.scheduler,
    integrityChecks: scope.integrityChecks,
    objectiveComplete: scope.objectiveComplete
  }, {
    pairKey: pair.pairKey,
    terminal: pair.terminal,
    evidence: pair.evidence,
    generatedAt: context.generatedAt,
    recencyPolicy: context.recencyPolicy,
    run: context.run
  });
  if (stableJson(scope) !== stableJson(normalized)) {
    throw new Error(`${pair.pairKey}.scope flags must be derived from concrete dated receipts.`);
  }
}

function validateRegistryAttributionParity(pairs, registry) {
  const registryIndex = new Map(registry.map((entry) => [entry.evidenceKey, entry]));
  const pairRefs = new Map(pairs.map((pair) => [
    pair.pairKey,
    new Set(pair.evidence.evidenceRefs)
  ]));
  for (const entry of registry) {
    for (const pairKey of entry.attributions) {
      if (!pairRefs.get(pairKey)?.has(entry.evidenceKey)) {
        throw new Error(`${entry.evidenceKey} registry attribution is absent from pair ${pairKey}.`);
      }
    }
  }
  for (const [pairKey, refs] of pairRefs) {
    for (const evidenceKey of refs) {
      const entry = registryIndex.get(evidenceKey);
      if (!entry?.attributions.includes(pairKey)) {
        throw new Error(`${pairKey} evidence reference lacks registry attribution.`);
      }
    }
  }
}

function validateUniqueSerializedAttemptIds(pairs) {
  const seen = new Map();
  for (const pair of pairs) {
    for (const outcome of pair.accountOutcomes) {
      if (!outcome.attempt) continue;
      assertUniqueAttemptId(
        seen,
        outcome.attempt.attemptId,
        pair.pairKey,
        outcome.taskKey
      );
    }
  }
}

function validateManifestCountsAgainstPairs(manifest, pairs) {
  const ownerMapByBatch = new Map();
  for (const pair of pairs) {
    const owners = ownerMapByBatch.get(pair.batchSlug) ?? new Map();
    owners.set(
      `${pair.entity.type}:${pair.entity.id}`,
      pair.entity.type
    );
    ownerMapByBatch.set(pair.batchSlug, owners);
  }
  for (const batch of manifest.batches) {
    const owners = ownerMapByBatch.get(batch.batchSlug) ?? new Map();
    const companies = [...owners.values()].filter((type) => type === "company").length;
    const founders = owners.size - companies;
    if (
      batch.companies !== companies ||
      batch.founders !== founders ||
      batch.entities !== owners.size
    ) {
      throw new Error(`${batch.batchSlug} pair denominator does not match catalog manifest counts.`);
    }
  }
  const receiptBatches = [...ownerMapByBatch.keys()].sort();
  const manifestBatches = manifest.batches.map((batch) => batch.batchSlug);
  if (stableJson(receiptBatches) !== stableJson(manifestBatches)) {
    throw new Error("Pair matrix batch set does not match catalog manifest batch set.");
  }
}

function normalizeAbsenceVerification(value, { generatedAt, strict }) {
  if (!isObject(value)) return null;
  const normalized = {
    receiptId: clean(value.receiptId) || null,
    exhaustive: value.exhaustive === true,
    checkedAt: clean(value.checkedAt) || null,
    checkedSources: sortedUniqueStrings(
      value.checkedSources ?? [],
      "absenceVerification.checkedSources",
      { allowEmpty: true }
    ),
    method: clean(value.method) || null
  };
  if (strict) {
    assertExhaustiveAbsenceVerification(
      normalized,
      "absenceVerification",
      generatedAt
    );
  }
  return normalized;
}

function assertExhaustiveAbsenceVerification(value, label, generatedAt) {
  const normalized = normalizeAbsenceVerification(value, {
    generatedAt,
    strict: false
  });
  if (!normalized?.exhaustive) {
    throw new Error(`${label} must set exhaustive=true; empty/no-match results are not absence proof.`);
  }
  requiredText(normalized.receiptId, `${label}.receiptId`);
  const checkedAt = requiredIsoTimestamp(normalized.checkedAt, `${label}.checkedAt`);
  assertNotTooFarFuture(checkedAt, generatedAt, `${label}.checkedAt`);
  if (!normalized.checkedSources.length) {
    throw new Error(`${label}.checkedSources must name every native and official source checked.`);
  }
  requireExactOperationalText(normalized.method, `${label}.method`);
  return normalized;
}

function hasExhaustiveAbsenceVerification(value) {
  try {
    assertExhaustiveAbsenceVerification(value, "absenceVerification", "9999-12-31T23:59:59.999Z");
    return true;
  } catch {
    return false;
  }
}

function normalizeAccount(account, forcedPlatform = null) {
  if (!isObject(account)) throw new TypeError("Account mapping must be an object.");
  rejectCollectorSpecificShape(account, "account");
  const platform = normalizePlatform(forcedPlatform ?? account.platform);
  const url = canonicalizePlatformUrl(
    platform,
    requiredText(account.url, "account.url"),
    { kind: "account" }
  );
  const identity = `${platform}:${url}`;
  const verificationStatus = normalizeVerificationStatus(account);
  return {
    accountKey: `${platform}:${encodeURIComponent(url)}`,
    platform,
    url,
    handle: clean(account.handle) || null,
    verificationStatus,
    verified: verificationStatus === "verified",
    identity
  };
}

function canonicalizePlatformUrl(platform, rawUrl, { kind }) {
  let url;
  try {
    url = new URL(requiredText(rawUrl, `${platform} ${kind} URL`));
  } catch {
    throw new TypeError(`${platform} ${kind} URL must be an absolute URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error(`${platform} ${kind} URL must use credential-free HTTPS and the default port.`);
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const allowed = platformAllowedHosts(platform);
  if (allowed && !allowed.has(host)) {
    throw new Error(`${platform} ${kind} URL host ${host} is not allowed.`);
  }
  url.hostname = canonicalPlatformHost(platform, host);
  url.hash = "";
  const parts = url.pathname.split("/").filter(Boolean).map((part) =>
    decodeURIComponent(part)
  );
  if (kind === "account" && parts.some((part) => /[/?#]/.test(part))) {
    throw new Error(`${platform} account URL contains an encoded path separator.`);
  }

  if (platform === "hacker_news" && kind === "account") {
    if (url.pathname !== "/user" || !url.searchParams.has("id")) {
      throw new Error("Hacker News account URL must be https://news.ycombinator.com/user?id=<username>.");
    }
    const id = requiredText(url.searchParams.get("id"), "Hacker News user id");
    url.search = "";
    url.searchParams.set("id", id);
    return url.toString();
  }
  if (platform === "youtube" && kind === "account") {
    const isHandle = parts.length === 1 && parts[0].startsWith("@");
    const isChannelPath = parts.length === 2 && ["channel", "c", "user"].includes(parts[0]);
    if (host === "youtu.be" || (!isHandle && !isChannelPath)) {
      throw new Error("YouTube account URL must identify a handle, channel, custom channel, or user.");
    }
    // Channel IDs and legacy user/custom IDs are case-sensitive. Handles are
    // normalized case-insensitively by YouTube.
    if (parts[0].startsWith("@")) parts[0] = parts[0].toLowerCase();
    url.pathname = `/${parts.map(encodeURIComponentPreservingAt).join("/")}`;
    url.search = "";
    return trimRootSlash(url.toString());
  }
  if (platform === "github" && kind === "account") {
    if (![1, 2].includes(parts.length) ||
        ["issues", "pull", "pulls", "commit", "commits", "releases", "actions"].includes(parts[0].toLowerCase())) {
      throw new Error("GitHub account URL must identify an owner or owner/repository, not content.");
    }
    url.pathname = `/${parts.map((part) => encodeURIComponent(part.toLowerCase())).join("/")}`;
    url.search = "";
    return trimRootSlash(url.toString());
  }
  if (["x", "instagram"].includes(platform) && kind === "account") {
    const reserved = platform === "x"
      ? new Set(["home", "explore", "search", "notifications", "messages", "i"])
      : new Set(["p", "reel", "reels", "tv", "stories", "explore"]);
    if (parts.length !== 1 || reserved.has(parts[0].toLowerCase())) {
      throw new Error(`${platform} account URL must identify one profile, not content.`);
    }
    url.pathname = `/${encodeURIComponent(parts[0].toLowerCase())}`;
    url.search = "";
    return trimRootSlash(url.toString());
  }
  if (platform === "reddit" && kind === "account") {
    if (parts.length !== 2 || !["user", "u", "r"].includes(parts[0].toLowerCase())) {
      throw new Error("Reddit account URL must identify exactly one user or subreddit.");
    }
    const namespace = parts[0].toLowerCase() === "u" ? "user" : parts[0].toLowerCase();
    url.pathname = `/${namespace}/${encodeURIComponent(parts[1].toLowerCase())}`;
    url.search = "";
    return trimRootSlash(url.toString());
  }
  if (platform === "tiktok" && kind === "account") {
    if (parts.length !== 1 || !parts[0].startsWith("@")) {
      throw new Error("TikTok account URL must identify exactly one @handle profile.");
    }
    url.pathname = `/${encodeURIComponentPreservingAt(parts[0].toLowerCase())}`;
    url.search = "";
    return trimRootSlash(url.toString());
  }
  if (platform === "bluesky" && kind === "account") {
    if (parts.length !== 2 || parts[0].toLowerCase() !== "profile") {
      throw new Error("Bluesky account URL must identify exactly one /profile/<handle> profile.");
    }
    url.pathname = `/profile/${encodeURIComponent(parts[1].toLowerCase())}`;
    url.search = "";
    return trimRootSlash(url.toString());
  }
  if (platform === "linkedin" && kind === "account") {
    if (parts.length !== 2 || !["company", "in", "school"].includes(parts[0].toLowerCase())) {
      throw new Error("LinkedIn account URL must identify exactly one company, person, or school profile.");
    }
    // LinkedIn profile slugs are case-insensitive. Catalogs and public
    // collectors can legitimately preserve different display casing for the
    // same profile, so bind the account identity to the lowercase native slug.
    url.pathname = `/${parts[0].toLowerCase()}/${encodeURIComponent(parts[1].toLowerCase())}`;
    url.search = "";
    return trimRootSlash(url.toString());
  }
  if (platform === "product_hunt" && kind === "account") {
    const valid = (parts.length === 1 && parts[0].startsWith("@")) ||
      (parts.length === 2 && parts[0].toLowerCase() === "products");
    if (!valid) {
      throw new Error("Product Hunt account URL must identify a maker or product profile, not a post.");
    }
    url.pathname = `/${parts.map(encodeURIComponentPreservingAt).join("/")}`;
    url.search = "";
    return trimRootSlash(url.toString());
  }
  if (platform === "bilibili" && kind === "account") {
    if (!parts.length || parts.length > 2 || ["video", "bangumi"].includes(parts[0].toLowerCase())) {
      throw new Error("Bilibili account URL must identify a creator profile, not content.");
    }
    url.pathname = `/${parts.map(encodeURIComponent).join("/")}`;
    url.search = "";
    return trimRootSlash(url.toString());
  }
  if (["rss", "web"].includes(platform)) {
    url.pathname = normalizePreservedPath(url.pathname);
    sortSearchParams(url);
    return trimRootSlash(url.toString());
  }
  url.pathname = normalizePreservedPath(url.pathname);
  sortSearchParams(url);
  return trimRootSlash(url.toString());
}

function platformAllowedHosts(platform) {
  const hosts = {
    github: new Set(["github.com"]),
    x: new Set(["x.com", "twitter.com"]),
    instagram: new Set(["instagram.com"]),
    linkedin: new Set(["linkedin.com"]),
    youtube: new Set(["youtube.com", "youtu.be"]),
    product_hunt: new Set(["producthunt.com"]),
    reddit: new Set(["reddit.com", "old.reddit.com"]),
    hacker_news: new Set(["news.ycombinator.com"]),
    bilibili: new Set(["bilibili.com", "space.bilibili.com"]),
    tiktok: new Set(["tiktok.com"]),
    bluesky: new Set(["bsky.app"])
  };
  return hosts[platform] ?? null;
}

function canonicalPlatformHost(platform, host) {
  if (platform === "x" && host === "twitter.com") return "x.com";
  if (platform === "reddit" && host === "old.reddit.com") return "reddit.com";
  return host;
}

function accountFromNormalizedRow(row, platform) {
  if (row?.account === null || row?.account === undefined) return null;
  if (!isObject(row.account)) throw new TypeError("row.account must be a normalized account object.");
  return normalizeAccount({ ...row.account, platform }, platform);
}

function normalizeVerificationStatus(account) {
  const status = clean(account.verificationStatus).toLowerCase();
  if (status === "verified" || account.verified === true) return "verified";
  if (["needs_review", "rejected"].includes(status)) return status;
  return "unknown";
}

function mergeAccount(accounts, candidate) {
  const existing = accounts.find((account) => account.identity === candidate.identity);
  if (!existing) {
    accounts.push(candidate);
    accounts.sort((left, right) => left.accountKey.localeCompare(right.accountKey));
    return;
  }
  if (existing.handle && candidate.handle) {
    if (existing.handle.toLowerCase() !== candidate.handle.toLowerCase()) {
      throw new Error(`${existing.identity} has conflicting account handles.`);
    }
    existing.handle = [existing.handle, candidate.handle].sort((left, right) =>
      left.localeCompare(right)
    )[0];
  } else {
    existing.handle ??= candidate.handle;
  }
  if (
    (existing.verificationStatus === "rejected") !==
    (candidate.verificationStatus === "rejected")
  ) {
    throw new Error(`${existing.identity} has conflicting rejected and accepted review states.`);
  }
  const rank = { unknown: 0, needs_review: 1, verified: 2, rejected: 3 };
  existing.verificationStatus = rank[candidate.verificationStatus] >
    rank[existing.verificationStatus]
    ? candidate.verificationStatus
    : existing.verificationStatus;
  existing.verified = existing.verificationStatus === "verified";
}

function canonicalPairAccount(accounts, candidate) {
  if (!candidate) return null;
  return accounts.find((account) => sameAccount(account, candidate)) ?? candidate;
}

function sameAccount(left, right) {
  if (!left || !right) return left === right;
  return left.identity === right.identity;
}

function normalizePreservedPath(pathname) {
  const normalized = pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  return normalized.split("/").map((part) => {
    if (!part) return "";
    return encodeURIComponent(decodeURIComponent(part));
  }).join("/");
}

function sortSearchParams(url) {
  const entries = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
  );
  url.search = "";
  for (const [key, value] of entries) url.searchParams.append(key, value);
}

function encodeURIComponentPreservingAt(value) {
  return encodeURIComponent(value).replace(/^%40/i, "@");
}

function trimRootSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function coveragePairKey({ batchSlug, entityType, entityId, platform }) {
  return [batchSlug, entityType, entityId, platform]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function syntheticTaskKey(pairKey, account) {
  return `${pairKey}:${account ? `account:${encodeURIComponent(account.identity)}` : "discovery"}`;
}

function ownerKey(owner) {
  return `${owner.batchSlug}:${owner.entity.type}:${owner.entity.id}`;
}

function normalizePlatform(value) {
  const normalized = clean(value).toLowerCase().replace(/-/g, "_");
  if (!ALL_PLATFORM_SET.has(normalized)) {
    throw new Error(`Unsupported normalized coverage platform ${value ?? "missing"}.`);
  }
  return normalized;
}

function normalizeEntityType(value) {
  const normalized = clean(value).toLowerCase();
  if (!["company", "founder"].includes(normalized)) {
    throw new Error(`entityType must be company or founder; received ${value ?? "missing"}.`);
  }
  return normalized;
}

function normalizeRawStatus(value) {
  return clean(value).toLowerCase().replace(/[ -]+/g, "_");
}

function hasAttemptFields(row) {
  return ["attemptId", "attemptSequence", "startedAt", "checkedAt", "profileReceipt"].some((field) =>
    row?.[field] !== undefined
  );
}

function rejectCollectorSpecificShape(value, label) {
  if (!isObject(value)) return;
  if (
    Object.hasOwn(value, "githubUrl") ||
    Object.hasOwn(value, "github_url") ||
    Object.hasOwn(value, "github") ||
    Object.hasOwn(value, "collectorPayload")
  ) {
    throw new Error(
      `${label} contains collector-specific nested fields; use an explicit normalized adapter before building a coverage receipt.`
    );
  }
}

function requiredText(value, label) {
  const normalized = clean(value);
  if (!normalized) throw new TypeError(`${label} is required.`);
  return normalized;
}

function requiredSha256(value, label) {
  const normalized = requiredText(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  }
  return normalized;
}

function requiredIsoTimestamp(value, label) {
  const normalized = requiredText(value, label);
  if (!CANONICAL_ISO_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a millisecond-precision UTC ISO timestamp.`);
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== normalized) {
    throw new TypeError(`${label} must be a real calendar timestamp.`);
  }
  return normalized;
}

function assertNotTooFarFuture(value, generatedAt, label) {
  if (Date.parse(value) > Date.parse(generatedAt) + INGESTION_TIMESTAMP_FUTURE_TOLERANCE_MS) {
    throw new Error(`${label} exceeds the receipt-time future tolerance.`);
  }
}

function assertTimestampWithinRun(value, run, label) {
  const timestamp = Date.parse(value);
  if (timestamp < Date.parse(run.startedAt) || timestamp > Date.parse(run.completedAt)) {
    throw new Error(`${label} must fall within the current run window.`);
  }
}

function assertObservedWithinAttempt(value, attempt, label) {
  const timestamp = Date.parse(value);
  if (
    timestamp < Date.parse(attempt.startedAt) ||
    timestamp > Date.parse(attempt.checkedAt) + INGESTION_TIMESTAMP_FUTURE_TOLERANCE_MS
  ) {
    throw new Error(
      `${label} must correlate with its current attempt window ` +
      `(observedAt=${value}, startedAt=${attempt.startedAt}, checkedAt=${attempt.checkedAt}).`
    );
  }
}

function requiredNonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return number;
}

function requireExactOperationalText(value, label) {
  const normalized = clean(value);
  if (!hasExactOperationalText(normalized)) {
    throw new Error(`${label} must contain an exact reason or concrete next action.`);
  }
  return normalized;
}

function hasExactOperationalText(value) {
  const normalized = clean(value);
  return normalized.length >= 12 && !GENERIC_TEXT.has(normalized.toLowerCase());
}

function sortedUniqueStrings(values, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && !values.length)) {
    throw new TypeError(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array.`);
  }
  const normalized = values.map((value) => requiredText(value, `${label} entry`)).sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} must not contain duplicates.`);
  }
  return normalized;
}

function assertUniqueSorted(values, keyFor, label) {
  let previous = null;
  const keys = new Set();
  for (const value of values) {
    const key = keyFor(value);
    if (keys.has(key)) throw new Error(`${label} contains duplicate ${key}.`);
    if (previous !== null && previous.localeCompare(key) > 0) {
      throw new Error(`${label} must be canonically ordered.`);
    }
    keys.add(key);
    previous = key;
  }
}

function percent(numerator, denominator) {
  return denominator ? Number(((numerator / denominator) * 100).toFixed(4)) : null;
}

function chunkString(value, maxChunkCharacters) {
  return (function* chunks() {
    let offset = 0;
    while (offset < value.length) {
      let end = Math.min(offset + maxChunkCharacters, value.length);
      if (
        end < value.length &&
        isHighSurrogate(value.charCodeAt(end - 1)) &&
        isLowSurrogate(value.charCodeAt(end))
      ) {
        end -= 1;
      }
      yield value.slice(offset, end);
      offset = end;
    }
  })();
}

function isHighSurrogate(code) {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code) {
  return code >= 0xDC00 && code <= 0xDFFF;
}

function nullableCompare(left, right) {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  return String(left).localeCompare(String(right));
}

function unique(values) {
  return [...new Set(values)];
}

function countBy(values, keyFor) {
  const counts = {};
  for (const value of values) {
    const key = keyFor(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function clean(value) {
  return String(value ?? "").trim();
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
