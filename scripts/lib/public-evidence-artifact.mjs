import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const PUBLIC_EVIDENCE_ARTIFACT_MAX_BYTES = 75 * 1024 * 1024;
export const PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES = 75 * 1024 * 1024;
export const PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_TARGET_BYTES = 60 * 1024 * 1024;
export const PUBLIC_EVIDENCE_OPERATIONAL_HISTORY_PER_IDENTITY = 2;
export const PUBLIC_EVIDENCE_REVIEW_LEDGER_MAX_BYTES = 75 * 1024 * 1024;
export const PUBLIC_EVIDENCE_LEGACY_MAX_BYTES = 128 * 1024 * 1024;
export const PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH =
  "outputs/public-ingestion-operational-ledger-current.json";
export const PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION =
  "public-ingestion-operational-ledger.v2";
export const PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_REFERENCE_VERSION =
  "public-evidence-operational-ledger-reference.v2";
export const PUBLIC_EVIDENCE_OPERATIONAL_RETENTION_VERSION =
  "public-evidence-operational-retention.v1";
export const PUBLIC_EVIDENCE_REVIEW_LEDGER_PATH =
  "outputs/public-ingestion-review-ledger-current.json";
export const PUBLIC_EVIDENCE_REVIEW_LEDGER_VERSION =
  "public-ingestion-review-ledger.v1";
export const PUBLIC_EVIDENCE_REVIEW_LEDGER_REFERENCE_VERSION =
  "public-evidence-review-ledger-reference.v1";

export const PUBLIC_EVIDENCE_OPERATIONAL_KEYS = Object.freeze([
  "failures",
  "attempts",
  "discoveryAttempts",
  "sourceDiscoveryPaths"
]);

export const PUBLIC_EVIDENCE_REVIEW_KEYS = Object.freeze([
  "attributionReconciliationLedger",
  "needsReview"
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LEGACY_PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION =
  "public-ingestion-operational-ledger.v1";
const LEGACY_PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_REFERENCE_VERSION =
  "public-evidence-operational-ledger-reference.v1";

export function serializeCompactPublicEvidenceArtifact(
  value,
  { maxBytes = PUBLIC_EVIDENCE_ARTIFACT_MAX_BYTES } = {}
) {
  const body = serializeCompactJson(value, "Public evidence artifact");
  assertPublicEvidenceArtifactSize(body, { maxBytes });
  return body;
}

export function serializeCompactPublicEvidenceOperationalLedger(
  value,
  { maxBytes = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES } = {}
) {
  const body = serializeCompactJson(value, "Public evidence operational ledger");
  assertPublicEvidenceOperationalLedgerSize(body, { maxBytes });
  return body;
}

export function serializeCompactPublicEvidenceReviewLedger(
  value,
  { maxBytes = PUBLIC_EVIDENCE_REVIEW_LEDGER_MAX_BYTES } = {}
) {
  const body = serializeCompactJson(value, "Public evidence review ledger");
  assertPublicEvidenceReviewLedgerSize(body, { maxBytes });
  return body;
}

export function assertPublicEvidenceArtifactSize(
  body,
  { maxBytes = PUBLIC_EVIDENCE_ARTIFACT_MAX_BYTES } = {}
) {
  return assertArtifactSize(body, maxBytes, "Public evidence artifact");
}

export function assertPublicEvidenceOperationalLedgerSize(
  body,
  { maxBytes = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES } = {}
) {
  return assertArtifactSize(body, maxBytes, "Public evidence operational ledger");
}

export function assertPublicEvidenceReviewLedgerSize(
  body,
  { maxBytes = PUBLIC_EVIDENCE_REVIEW_LEDGER_MAX_BYTES } = {}
) {
  return assertArtifactSize(body, maxBytes, "Public evidence review ledger");
}

/**
 * Keep every latest terminal receipt/task identity while bounding superseded
 * operational history. Canonical evidence and review evidence are deliberately
 * outside this transform.
 */
export function applyPublicEvidenceOperationalRetention(
  snapshot,
  {
    maxBytes = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES,
    targetBytes = Math.min(
      PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_TARGET_BYTES,
      maxBytes - 1
    ),
    historyPerIdentity = PUBLIC_EVIDENCE_OPERATIONAL_HISTORY_PER_IDENTITY,
    priorRetentionMetadata = []
  } = {}
) {
  assertPlainObject(snapshot, "Public evidence snapshot");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 1) {
    throw new TypeError(
      "Public evidence operational retention maxBytes must exceed one byte."
    );
  }
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0 || targetBytes >= maxBytes) {
    throw new TypeError(
      "Public evidence operational retention targetBytes must be positive and below maxBytes."
    );
  }
  if (!Number.isSafeInteger(historyPerIdentity) || historyPerIdentity < 1) {
    throw new TypeError(
      "Public evidence operational retention historyPerIdentity must be a positive safe integer."
    );
  }

  const operational = stableOperationalCollections(normalizeOperationalCollections(snapshot, {
    requireOwnProperties: true,
    label: "Public evidence snapshot"
  }));
  const inputCounts = operationalCounts(operational);
  const inputSha256 = digestOperationalCollections(operational);
  const currentRetention = snapshot?.source?.operationalRetention ?? null;
  if (
    reusableOperationalRetention(currentRetention, {
      operational,
      inputCounts,
      inputSha256,
      maxBytes,
      targetBytes,
      historyPerIdentity
    })
  ) {
    return publicEvidenceWithRetainedOperationalCollections(
      snapshot,
      operational,
      currentRetention
    );
  }

  const parents = retentionParentHistoryDigests([
    currentRetention,
    ...(Array.isArray(priorRetentionMetadata) ? priorRetentionMetadata : [])
  ]);
  const partitions = {
    failures: partitionOperationalRows(
      "failures",
      operational.failures,
      historyPerIdentity
    ),
    discoveryAttempts: partitionOperationalRows(
      "discoveryAttempts",
      operational.discoveryAttempts,
      historyPerIdentity
    ),
    sourceDiscoveryPaths: partitionOperationalRows(
      "sourceDiscoveryPaths",
      operational.sourceDiscoveryPaths,
      1
    )
  };
  const requiredEntries = Object.values(partitions).flatMap((partition) => partition.required);
  const optionalEntries = Object.values(partitions)
    .flatMap((partition) => partition.optional)
    .sort(compareOptionalRetentionEntry);
  const allEntries = Object.values(partitions).flatMap((partition) => partition.all);

  const candidateFor = (optionalCount) => buildOperationalRetentionCandidate({
    operational,
    inputCounts,
    inputSha256,
    requiredEntries,
    optionalEntries: optionalEntries.slice(0, optionalCount),
    allEntries,
    parentHistorySha256: parents,
    maxBytes,
    targetBytes,
    historyPerIdentity
  });

  const requiredCandidate = candidateFor(0);
  if (requiredCandidate.bytes >= maxBytes) {
    throw new Error(
      `Public evidence operational ledger requires ${requiredCandidate.bytes} bytes to preserve ` +
      `latest terminal coverage; it must remain below ${maxBytes} bytes.`
    );
  }

  let selected = requiredCandidate;
  const fullHistoryCandidate = candidateFor(optionalEntries.length);
  if (fullHistoryCandidate.bytes < targetBytes) {
    selected = fullHistoryCandidate;
  } else if (requiredCandidate.bytes < targetBytes && optionalEntries.length > 0) {
    let low = 0;
    let high = optionalEntries.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = candidateFor(middle);
      if (candidate.bytes < targetBytes) {
        low = middle;
        selected = candidate;
      } else {
        high = middle - 1;
      }
    }
    if (selected.optionalCount !== low) selected = candidateFor(low);
  }
  if (selected.bytes >= maxBytes) {
    throw new Error(
      `Public evidence operational retention produced ${selected.bytes} bytes; ` +
      `it must remain below ${maxBytes} bytes.`
    );
  }
  return publicEvidenceWithRetainedOperationalCollections(
    snapshot,
    selected.operational,
    selected.retention
  );
}

function buildOperationalRetentionCandidate({
  operational,
  inputCounts,
  inputSha256,
  requiredEntries,
  optionalEntries,
  allEntries,
  parentHistorySha256,
  maxBytes,
  targetBytes,
  historyPerIdentity
}) {
  const selectedTokens = new Set(
    [...requiredEntries, ...optionalEntries].map((entry) => entry.token)
  );
  const retainedRows = {
    failures: [],
    discoveryAttempts: [],
    sourceDiscoveryPaths: []
  };
  const prunedEntries = [];
  for (const entry of allEntries) {
    if (selectedTokens.has(entry.token)) retainedRows[entry.collection].push(entry);
    else prunedEntries.push(entry);
  }
  const retained = stableOperationalCollections({
    failures: retainedRows.failures.sort(compareRetainedOperationalEntry).map((entry) => entry.row),
    attempts: operational.attempts,
    discoveryAttempts: retainedRows.discoveryAttempts
      .sort(compareRetainedOperationalEntry)
      .map((entry) => entry.row),
    sourceDiscoveryPaths: retainedRows.sourceDiscoveryPaths
      .sort(compareRetainedOperationalEntry)
      .map((entry) => entry.row)
  });
  const retainedCounts = operationalCounts(retained);
  const requiredCounts = {
    failures: requiredEntries.filter((entry) => entry.collection === "failures").length,
    attempts: inputCounts.attempts,
    discoveryAttempts: requiredEntries.filter(
      (entry) => entry.collection === "discoveryAttempts"
    ).length,
    sourceDiscoveryPaths: requiredEntries.filter(
      (entry) => entry.collection === "sourceDiscoveryPaths"
    ).length
  };
  const historyCounts = subtractOperationalCounts(retainedCounts, requiredCounts);
  const prunedCounts = subtractOperationalCounts(inputCounts, retainedCounts);
  const prunedRowsSha256 = digestRetentionEntries(prunedEntries);
  const historySha256 = sha256(stableJsonStringify({
    schemaVersion: PUBLIC_EVIDENCE_OPERATIONAL_RETENTION_VERSION,
    parentHistorySha256,
    prunedCounts,
    prunedRowsSha256
  }));
  const retention = {
    schemaVersion: PUBLIC_EVIDENCE_OPERATIONAL_RETENTION_VERSION,
    strategy: "latest_terminal_plus_bounded_history",
    maxArtifactBytes: maxBytes,
    targetArtifactBytes: targetBytes,
    historyPerIdentity,
    inputCounts,
    requiredCounts,
    retainedCounts,
    historyCounts,
    prunedCounts,
    inputSha256,
    retainedSha256: digestOperationalCollections(retained),
    prunedRowsSha256,
    parentHistorySha256,
    historySha256
  };
  const ledger = {
    schemaVersion: PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION,
    retention,
    failures: retained.failures,
    attempts: retained.attempts,
    discoveryAttempts: retained.discoveryAttempts,
    sourceDiscoveryPaths: retained.sourceDiscoveryPaths
  };
  return {
    operational: retained,
    retention,
    optionalCount: optionalEntries.length,
    bytes: Buffer.byteLength(serializeCompactJson(
      ledger,
      "Public evidence operational ledger retention candidate"
    ))
  };
}

function partitionOperationalRows(collection, rows, retainedDepth) {
  const groups = new Map();
  for (const row of rows) {
    const stableRow = stableJsonValue(row);
    const identity = operationalRetentionIdentity(collection, stableRow);
    const digest = sha256(stableJsonStringify(stableRow));
    const entries = groups.get(identity) ?? [];
    entries.push({
      collection,
      identity,
      row: stableRow,
      digest,
      timestamp: operationalRowTimestamp(stableRow)
    });
    groups.set(identity, entries);
  }
  const all = [];
  const required = [];
  const optional = [];
  for (const identity of [...groups.keys()].sort((left, right) => left.localeCompare(right))) {
    const group = groups.get(identity).sort(compareNewestOperationalEntry);
    for (let index = 0; index < group.length; index += 1) {
      const entry = {
        ...group[index],
        token: `${collection}\u0000${identity}\u0000${index}\u0000${group[index].digest}`
      };
      all.push(entry);
      if (index === 0) required.push(entry);
      else if (index < retainedDepth) optional.push(entry);
    }
  }
  return { all, required, optional };
}

function operationalRetentionIdentity(collection, row) {
  const value = (...keys) => {
    for (const key of keys) {
      const text = String(row?.[key] ?? "").trim().toLowerCase();
      if (text) return text;
    }
    return "";
  };
  const batch = value("batchSlug", "batch_slug");
  const entityType = value("entityType", "entity_type", "discovered_entity_type") || "company";
  const entityId = value(
    "entityId",
    "entity_id",
    "discovered_entity_id",
    "company_id",
    "companySlug",
    "company_slug"
  );
  const platform = value("platform", "discovered_platform");
  const explicitId = value("id");
  if (collection === "failures") {
    const attemptKey = value("attemptKey", "attempt_key");
    if (attemptKey) return `attempt:${batch}:${attemptKey}`;
    const account = value(
      "accountUrl",
      "account_url",
      "sourceUrl",
      "source_url",
      "url"
    );
    if (entityId || account) {
      return `owner:${batch}:${platform}:${entityType}:${entityId}:${account}`;
    }
  } else if (collection === "discoveryAttempts") {
    const query = value("query");
    const source = value("source");
    if (entityId || query) {
      return `discovery:${batch}:${platform}:${entityType}:${entityId}:${source}:${query}`;
    }
  } else if (collection === "sourceDiscoveryPaths") {
    const sourceUrl = value("source_url", "sourceUrl");
    const discoveredUrl = value("discovered_url", "discoveredUrl");
    if (entityId || sourceUrl || discoveredUrl) {
      return `path:${batch}:${platform}:${entityType}:${entityId}:${sourceUrl}:${discoveredUrl}`;
    }
  }
  if (explicitId) return `id:${explicitId}`;
  return `row:${sha256(stableJsonStringify(row))}`;
}

function operationalRowTimestamp(row) {
  for (const key of [
    "checkedAt",
    "checked_at",
    "created_at",
    "createdAt",
    "last_checked_at",
    "lastCheckedAt",
    "observedAt",
    "fetchedAt"
  ]) {
    const parsed = Date.parse(row?.[key] ?? "");
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function compareNewestOperationalEntry(left, right) {
  return right.timestamp - left.timestamp ||
    right.digest.localeCompare(left.digest);
}

function compareOptionalRetentionEntry(left, right) {
  return compareNewestOperationalEntry(left, right) ||
    left.collection.localeCompare(right.collection) ||
    left.identity.localeCompare(right.identity);
}

function compareRetainedOperationalEntry(left, right) {
  return left.collection.localeCompare(right.collection) ||
    left.identity.localeCompare(right.identity) ||
    compareNewestOperationalEntry(left, right);
}

function stableOperationalCollections(operational) {
  const stableRows = (collection, rows) => rows
    .map((row) => ({
      row: stableJsonValue(row),
      identity: operationalRetentionIdentity(collection, row),
      timestamp: operationalRowTimestamp(row),
      digest: sha256(stableJsonStringify(row))
    }))
    .sort((left, right) =>
      left.identity.localeCompare(right.identity) ||
      right.timestamp - left.timestamp ||
      left.digest.localeCompare(right.digest)
    )
    .map((entry) => entry.row);
  return {
    failures: stableRows("failures", operational.failures),
    attempts: Object.fromEntries(
      Object.entries(operational.attempts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, stableJsonValue(value)])
    ),
    discoveryAttempts: stableRows("discoveryAttempts", operational.discoveryAttempts),
    sourceDiscoveryPaths: stableRows("sourceDiscoveryPaths", operational.sourceDiscoveryPaths)
  };
}

function digestOperationalCollections(operational) {
  const digest = createHash("sha256");
  for (const key of PUBLIC_EVIDENCE_OPERATIONAL_KEYS) {
    digest.update(`${key}\n`);
    if (key === "attempts") {
      for (const [attemptKey, attempt] of Object.entries(operational.attempts)) {
        digest.update(attemptKey);
        digest.update("\u0000");
        digest.update(stableJsonStringify(attempt));
        digest.update("\n");
      }
    } else {
      for (const row of operational[key]) {
        digest.update(stableJsonStringify(row));
        digest.update("\n");
      }
    }
  }
  return digest.digest("hex");
}

function digestRetentionEntries(entries) {
  const digest = createHash("sha256");
  for (const entry of [...entries].sort(compareRetainedOperationalEntry)) {
    digest.update(entry.collection);
    digest.update("\u0000");
    digest.update(entry.identity);
    digest.update("\u0000");
    digest.update(stableJsonStringify(entry.row));
    digest.update("\n");
  }
  return digest.digest("hex");
}

function retentionParentHistoryDigests(metadata) {
  return [...new Set(
    metadata
      .filter((value) => {
        try {
          validateOperationalRetentionMetadata(value);
          return true;
        } catch {
          return false;
        }
      })
      .map((value) => String(value?.historySha256 ?? ""))
      .filter((value) => SHA256_PATTERN.test(value))
  )].sort((left, right) => left.localeCompare(right));
}

function reusableOperationalRetention(metadata, {
  operational,
  inputCounts,
  inputSha256,
  maxBytes,
  targetBytes,
  historyPerIdentity
}) {
  if (!metadata || metadata.schemaVersion !== PUBLIC_EVIDENCE_OPERATIONAL_RETENTION_VERSION) {
    return false;
  }
  try {
    validateOperationalRetentionMetadata(metadata, operational);
  } catch {
    return false;
  }
  if (
    metadata.retainedSha256 !== inputSha256 ||
    JSON.stringify(metadata.retainedCounts) !== JSON.stringify(inputCounts) ||
    metadata.maxArtifactBytes !== maxBytes ||
    metadata.targetArtifactBytes !== targetBytes ||
    metadata.historyPerIdentity !== historyPerIdentity
  ) {
    return false;
  }
  const body = serializeCompactJson({
    schemaVersion: PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION,
    retention: metadata,
    failures: operational.failures,
    attempts: operational.attempts,
    discoveryAttempts: operational.discoveryAttempts,
    sourceDiscoveryPaths: operational.sourceDiscoveryPaths
  }, "Reusable public evidence operational ledger");
  return Buffer.byteLength(body) < maxBytes;
}

function publicEvidenceWithRetainedOperationalCollections(snapshot, operational, retention) {
  const source = {
    ...(snapshot.source ?? {}),
    failureCount: operational.failures.length,
    discoveryAttemptCount: operational.discoveryAttempts.length,
    sourceDiscoveryPathCount: operational.sourceDiscoveryPaths.length,
    attemptCount: Object.keys(operational.attempts).length,
    operationalRetention: retention
  };
  return {
    ...snapshot,
    source,
    failures: operational.failures,
    attempts: operational.attempts,
    discoveryAttempts: operational.discoveryAttempts,
    sourceDiscoveryPaths: operational.sourceDiscoveryPaths
  };
}

function subtractOperationalCounts(left, right) {
  return Object.fromEntries(
    PUBLIC_EVIDENCE_OPERATIONAL_KEYS.map((key) => [key, left[key] - right[key]])
  );
}

function stableJsonStringify(value) {
  return JSON.stringify(stableJsonValue(value));
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stableJsonValue(value[key])])
  );
}

/**
 * Extract the operational and review collections from one hydrated/legacy
 * public snapshot. The three returned JSON bodies are deterministic and individually
 * bounded below GitHub's 100 MiB hard limit.
 */
export function buildPublicEvidenceArtifactPair(
  snapshot,
  {
    ledgerRelativePath = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH,
    reviewLedgerRelativePath = PUBLIC_EVIDENCE_REVIEW_LEDGER_PATH,
    canonicalMaxBytes = PUBLIC_EVIDENCE_ARTIFACT_MAX_BYTES,
    ledgerMaxBytes = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES,
    reviewLedgerMaxBytes = PUBLIC_EVIDENCE_REVIEW_LEDGER_MAX_BYTES
  } = {}
) {
  assertPlainObject(snapshot, "Public evidence snapshot");
  const normalizedLedgerPath = validateLedgerRelativePath(
    ledgerRelativePath,
    "Public evidence operational ledger path"
  );
  const normalizedReviewLedgerPath = validateLedgerRelativePath(
    reviewLedgerRelativePath,
    "Public evidence review ledger path"
  );
  if (normalizedLedgerPath === normalizedReviewLedgerPath) {
    throw new Error("Public evidence operational and review ledgers must use different paths.");
  }
  if (
    Object.hasOwn(snapshot, "operationalLedgerRef") ||
    Object.hasOwn(snapshot, "reviewLedgerRef")
  ) {
    throw new Error(
      "Public evidence snapshot is already split; hydrate it before rebuilding the artifact set."
    );
  }
  const retainedSnapshot = applyPublicEvidenceOperationalRetention(snapshot, {
    maxBytes: ledgerMaxBytes
  });
  const operational = normalizeOperationalCollections(retainedSnapshot, {
    requireOwnProperties: true,
    label: "Retained public evidence snapshot"
  });
  const retention = retainedSnapshot.source.operationalRetention;
  const operationalLedger = {
    schemaVersion: PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION,
    retention,
    failures: operational.failures,
    attempts: operational.attempts,
    discoveryAttempts: operational.discoveryAttempts,
    sourceDiscoveryPaths: operational.sourceDiscoveryPaths
  };
  const ledgerBody = serializeCompactPublicEvidenceOperationalLedger(
    operationalLedger,
    { maxBytes: ledgerMaxBytes }
  );
  const operationalReference = {
    schemaVersion: PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_REFERENCE_VERSION,
    path: normalizedLedgerPath,
    sha256: sha256(ledgerBody),
    bytes: Buffer.byteLength(ledgerBody),
    counts: operationalCounts(operational),
    retention
  };
  const review = normalizeReviewCollections(snapshot, {
    requireOwnProperties: true,
    label: "Public evidence snapshot"
  });
  const reviewLedger = {
    schemaVersion: PUBLIC_EVIDENCE_REVIEW_LEDGER_VERSION,
    attributionReconciliationLedger: review.attributionReconciliationLedger,
    needsReview: review.needsReview
  };
  const reviewLedgerBody = serializeCompactPublicEvidenceReviewLedger(reviewLedger, {
    maxBytes: reviewLedgerMaxBytes
  });
  const reviewReference = {
    schemaVersion: PUBLIC_EVIDENCE_REVIEW_LEDGER_REFERENCE_VERSION,
    path: normalizedReviewLedgerPath,
    sha256: sha256(reviewLedgerBody),
    bytes: Buffer.byteLength(reviewLedgerBody),
    counts: reviewCounts(review)
  };
  const canonical = publicEvidenceWithoutExternalCollections(
    retainedSnapshot,
    operationalReference,
    reviewReference
  );
  const canonicalBody = serializeCompactPublicEvidenceArtifact(canonical, {
    maxBytes: canonicalMaxBytes
  });
  return {
    canonical,
    canonicalBody,
    canonicalSha256: sha256(canonicalBody),
    operationalLedger,
    ledgerBody,
    ledgerSha256: operationalReference.sha256,
    reference: operationalReference,
    operationalReference,
    reviewLedger,
    reviewLedgerBody,
    reviewLedgerSha256: reviewReference.sha256,
    reviewReference
  };
}

/**
 * Hydrate a split public snapshot from the exact ledger bytes named by its
 * reference. Legacy embedded snapshots remain readable during the migration.
 */
export function hydratePublicEvidenceArtifact(
  canonical,
  ledgerSource = null,
  {
    expectedLedgerPath = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH,
    ledgerMaxBytes = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES,
    reviewLedgerSource = null,
    expectedReviewLedgerPath = PUBLIC_EVIDENCE_REVIEW_LEDGER_PATH,
    reviewLedgerMaxBytes = PUBLIC_EVIDENCE_REVIEW_LEDGER_MAX_BYTES
  } = {}
) {
  assertPlainObject(canonical, "Public evidence artifact");
  if (
    Object.hasOwn(canonical, "reviewLedgerRef") &&
    !Object.hasOwn(canonical, "operationalLedgerRef")
  ) {
    throw new Error(
      "Public evidence review ledger reference requires an operational ledger reference."
    );
  }
  if (
    canonical.operationalLedgerRef?.path &&
    canonical.reviewLedgerRef?.path &&
    validateLedgerRelativePath(
      canonical.operationalLedgerRef.path,
      "Public evidence operational ledger path"
    ) ===
      validateLedgerRelativePath(
        canonical.reviewLedgerRef.path,
        "Public evidence review ledger path"
      )
  ) {
    throw new Error("Public evidence operational and review ledgers must use different paths.");
  }
  const operational = hydrateOperationalCollections(canonical, ledgerSource, {
    expectedLedgerPath,
    ledgerMaxBytes
  });
  const review = hydrateReviewCollections(canonical, reviewLedgerSource, {
    expectedReviewLedgerPath,
    reviewLedgerMaxBytes
  });
  const hydrated = {};
  for (const [key, value] of Object.entries(canonical)) {
    if (
      key !== "operationalLedgerRef" &&
      key !== "reviewLedgerRef" &&
      !PUBLIC_EVIDENCE_OPERATIONAL_KEYS.includes(key) &&
      !PUBLIC_EVIDENCE_REVIEW_KEYS.includes(key)
    ) {
      hydrated[key] = value;
    }
  }
  return { ...hydrated, ...review, ...operational };
}

export async function hydratePublicEvidenceArtifactWithLoader(
  canonical,
  {
    loadLedger,
    loadReviewLedger,
    expectedLedgerPath = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH,
    ledgerMaxBytes = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES,
    expectedReviewLedgerPath = PUBLIC_EVIDENCE_REVIEW_LEDGER_PATH,
    reviewLedgerMaxBytes = PUBLIC_EVIDENCE_REVIEW_LEDGER_MAX_BYTES
  } = {}
) {
  assertPlainObject(canonical, "Public evidence artifact");
  let ledgerSource = null;
  let reviewLedgerSource = null;
  if (Object.hasOwn(canonical, "operationalLedgerRef")) {
    if (typeof loadLedger !== "function") {
      throw new TypeError("loadLedger must be a function for a split public evidence artifact.");
    }
    validateOperationalLedgerReference(canonical.operationalLedgerRef, {
      expectedLedgerPath
    });
    ledgerSource = await loadLedger(canonical.operationalLedgerRef.path);
  }
  if (Object.hasOwn(canonical, "reviewLedgerRef")) {
    const reviewLoader = loadReviewLedger ?? loadLedger;
    if (typeof reviewLoader !== "function") {
      throw new TypeError(
        "loadReviewLedger or loadLedger must be a function for a split public evidence review ledger."
      );
    }
    validateReviewLedgerReference(canonical.reviewLedgerRef, {
      expectedReviewLedgerPath
    });
    reviewLedgerSource = await reviewLoader(canonical.reviewLedgerRef.path);
  }
  return hydratePublicEvidenceArtifact(canonical, ledgerSource, {
    expectedLedgerPath,
    ledgerMaxBytes,
    reviewLedgerSource,
    expectedReviewLedgerPath,
    reviewLedgerMaxBytes
  });
}

export async function readPublicEvidenceArtifact(
  canonicalPath,
  {
    rootDir = process.cwd(),
    expectedLedgerPath = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH,
    expectedReviewLedgerPath = PUBLIC_EVIDENCE_REVIEW_LEDGER_PATH,
    readFileImpl = readFile
  } = {}
) {
  const rootPath = resolve(rootDir);
  const resolvedCanonicalPath = resolve(rootPath, canonicalPath);
  const canonicalBytes = sourceBytes(await readFileImpl(resolvedCanonicalPath));
  const canonical = parseJsonSource(canonicalBytes, `Public evidence artifact ${resolvedCanonicalPath}`);
  const split = Boolean(
    canonical &&
      (Object.hasOwn(canonical, "operationalLedgerRef") ||
        Object.hasOwn(canonical, "reviewLedgerRef"))
  );
  const fullySplit = Boolean(
    canonical &&
      Object.hasOwn(canonical, "operationalLedgerRef") &&
      Object.hasOwn(canonical, "reviewLedgerRef")
  );
  assertPublicEvidenceArtifactSize(canonicalBytes, {
    maxBytes: fullySplit ? PUBLIC_EVIDENCE_ARTIFACT_MAX_BYTES : PUBLIC_EVIDENCE_LEGACY_MAX_BYTES
  });
  let ledgerBytes = null;
  let ledgerPath = null;
  let reviewLedgerBytes = null;
  let reviewLedgerPath = null;
  const snapshot = await hydratePublicEvidenceArtifactWithLoader(canonical, {
    expectedLedgerPath,
    expectedReviewLedgerPath,
    loadLedger: async (relativePath) => {
      const resolvedPath = resolveArtifactPath(rootPath, relativePath);
      const bytes = sourceBytes(await readFileImpl(resolvedPath));
      if (canonical.operationalLedgerRef?.path === relativePath) {
        ledgerPath = resolvedPath;
        ledgerBytes = bytes;
      } else if (canonical.reviewLedgerRef?.path === relativePath) {
        reviewLedgerPath = resolvedPath;
        reviewLedgerBytes = bytes;
      }
      return bytes;
    }
  });
  return {
    snapshot,
    canonical,
    canonicalPath: resolvedCanonicalPath,
    canonicalBytes,
    canonicalSha256: sha256(canonicalBytes),
    ledgerPath,
    ledgerBytes,
    ledgerSha256: ledgerBytes ? sha256(ledgerBytes) : null,
    reference: canonical.operationalLedgerRef ?? null,
    reviewLedgerPath,
    reviewLedgerBytes,
    reviewLedgerSha256: reviewLedgerBytes ? sha256(reviewLedgerBytes) : null,
    reviewReference: canonical.reviewLedgerRef ?? null,
    split,
    fullySplit
  };
}

/**
 * Publish a verified artifact set. All temporary files are parsed and hash-checked
 * before either destination changes. The ledger is installed first and the
 * canonical reference last; a recoverable rename failure rolls the ledger
 * back, while an abrupt crash is detected by fail-closed hydration.
 */
export async function writePublicEvidenceArtifactPairAtomic({
  rootDir = process.cwd(),
  canonicalPath,
  snapshot,
  ledgerRelativePath = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH,
  reviewLedgerRelativePath = PUBLIC_EVIDENCE_REVIEW_LEDGER_PATH,
  expectedCanonicalSha256,
  expectedLedgerSha256,
  expectedReviewLedgerSha256,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  renameImpl = rename,
  removeImpl = rm,
  mkdirImpl = mkdir,
  statImpl = stat
} = {}) {
  const rootPath = resolve(rootDir);
  const resolvedCanonicalPath = resolve(
    rootPath,
    requiredText(canonicalPath, "canonicalPath")
  );
  const normalizedLedgerPath = validateLedgerRelativePath(
    ledgerRelativePath,
    "Public evidence operational ledger path"
  );
  const normalizedReviewLedgerPath = validateLedgerRelativePath(
    reviewLedgerRelativePath,
    "Public evidence review ledger path"
  );
  const resolvedLedgerPath = resolveArtifactPath(rootPath, normalizedLedgerPath);
  const resolvedReviewLedgerPath = resolveArtifactPath(
    rootPath,
    normalizedReviewLedgerPath
  );
  const pair = buildPublicEvidenceArtifactPair(snapshot, {
    ledgerRelativePath: normalizedLedgerPath,
    reviewLedgerRelativePath: normalizedReviewLedgerPath
  });
  const currentCanonical = await readOptionalBytes(resolvedCanonicalPath, readFileImpl);
  const currentLedger = await readOptionalBytes(resolvedLedgerPath, readFileImpl);
  const currentReviewLedger = await readOptionalBytes(
    resolvedReviewLedgerPath,
    readFileImpl
  );
  assertExpectedHash(
    currentCanonical,
    expectedCanonicalSha256,
    "Canonical public evidence artifact"
  );
  assertExpectedHash(
    currentLedger,
    expectedLedgerSha256,
    "Public evidence operational ledger"
  );
  assertExpectedHash(
    currentReviewLedger,
    expectedReviewLedgerSha256,
    "Public evidence review ledger"
  );
  const canonicalMode = await existingMode(resolvedCanonicalPath, statImpl, 0o644);
  const ledgerMode = await existingMode(resolvedLedgerPath, statImpl, canonicalMode);
  const reviewLedgerMode = await existingMode(
    resolvedReviewLedgerPath,
    statImpl,
    canonicalMode
  );
  await Promise.all([
    mkdirImpl(dirname(resolvedCanonicalPath), { recursive: true }),
    mkdirImpl(dirname(resolvedLedgerPath), { recursive: true }),
    mkdirImpl(dirname(resolvedReviewLedgerPath), { recursive: true })
  ]);
  const nonce = `${process.pid}-${randomUUID()}`;
  const canonicalTemporary = `${resolvedCanonicalPath}.${nonce}.tmp`;
  const ledgerTemporary = `${resolvedLedgerPath}.${nonce}.tmp`;
  const reviewLedgerTemporary = `${resolvedReviewLedgerPath}.${nonce}.tmp`;
  let ledgerPublished = false;
  let reviewLedgerPublished = false;
  let canonicalPublished = false;
  try {
    await Promise.all([
      writeFileImpl(canonicalTemporary, pair.canonicalBody, {
        flag: "wx",
        mode: canonicalMode
      }),
      writeFileImpl(ledgerTemporary, pair.ledgerBody, {
        flag: "wx",
        mode: ledgerMode
      }),
      writeFileImpl(reviewLedgerTemporary, pair.reviewLedgerBody, {
        flag: "wx",
        mode: reviewLedgerMode
      })
    ]);
    const [temporaryCanonical, temporaryLedger, temporaryReviewLedger] = await Promise.all([
      readFileImpl(canonicalTemporary),
      readFileImpl(ledgerTemporary),
      readFileImpl(reviewLedgerTemporary)
    ]);
    verifyArtifactSetBytes(
      temporaryCanonical,
      temporaryLedger,
      temporaryReviewLedger,
      pair
    );
    await assertUnchanged(
      resolvedCanonicalPath,
      currentCanonical,
      readFileImpl,
      "Canonical public evidence artifact"
    );
    await assertUnchanged(
      resolvedLedgerPath,
      currentLedger,
      readFileImpl,
      "Public evidence operational ledger"
    );
    await assertUnchanged(
      resolvedReviewLedgerPath,
      currentReviewLedger,
      readFileImpl,
      "Public evidence review ledger"
    );
    await renameImpl(ledgerTemporary, resolvedLedgerPath);
    ledgerPublished = true;
    await renameImpl(reviewLedgerTemporary, resolvedReviewLedgerPath);
    reviewLedgerPublished = true;
    await renameImpl(canonicalTemporary, resolvedCanonicalPath);
    canonicalPublished = true;
  } catch (error) {
    if (!canonicalPublished && (ledgerPublished || reviewLedgerPublished)) {
      const rollbackErrors = [];
      if (reviewLedgerPublished) {
        try {
          await restoreArtifact({
            path: resolvedReviewLedgerPath,
            previous: currentReviewLedger,
            mode: reviewLedgerMode,
            writeFileImpl,
            renameImpl,
            removeImpl
          });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (ledgerPublished) {
        try {
          await restoreArtifact({
            path: resolvedLedgerPath,
            previous: currentLedger,
            mode: ledgerMode,
            writeFileImpl,
            renameImpl,
            removeImpl
          });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Public evidence artifact-set publication failed and ledger rollback also failed."
        );
      }
    }
    throw error;
  } finally {
    await Promise.all([
      removeImpl(canonicalTemporary, { force: true }),
      removeImpl(ledgerTemporary, { force: true }),
      removeImpl(reviewLedgerTemporary, { force: true })
    ]);
  }
  const [publishedCanonical, publishedLedger, publishedReviewLedger] = await Promise.all([
    readFileImpl(resolvedCanonicalPath),
    readFileImpl(resolvedLedgerPath),
    readFileImpl(resolvedReviewLedgerPath)
  ]);
  verifyArtifactSetBytes(
    publishedCanonical,
    publishedLedger,
    publishedReviewLedger,
    pair
  );
  return {
    ...pair,
    canonicalPath: resolvedCanonicalPath,
    ledgerPath: resolvedLedgerPath,
    reviewLedgerPath: resolvedReviewLedgerPath
  };
}

/**
 * Publish only the canonical member of an existing split artifact set. This is
 * used by enrichers that mutate canonical evidence fields but must preserve
 * the operational ledger byte-for-byte. Both files are hash-checked before
 * the atomic rename so a stale checkpoint cannot overwrite concurrent work.
 */
export async function writePublicEvidenceCanonicalArtifactAtomic({
  rootDir = process.cwd(),
  canonicalPath,
  canonical,
  expectedCanonicalSha256,
  expectedLedgerSha256,
  expectedReviewLedgerSha256,
  expectedLedgerPath = PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH,
  expectedReviewLedgerPath = PUBLIC_EVIDENCE_REVIEW_LEDGER_PATH,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  renameImpl = rename,
  removeImpl = rm,
  mkdirImpl = mkdir,
  statImpl = stat
} = {}) {
  const rootPath = resolve(rootDir);
  const resolvedCanonicalPath = resolve(
    rootPath,
    requiredText(canonicalPath, "canonicalPath")
  );
  assertPlainObject(canonical, "Canonical public evidence artifact");
  if (!Object.hasOwn(canonical, "operationalLedgerRef")) {
    throw new Error(
      "Canonical-only publication requires an existing split public evidence artifact."
    );
  }

  const normalizedLedgerPath = validateLedgerRelativePath(
    expectedLedgerPath,
    "Public evidence operational ledger path"
  );
  validateOperationalLedgerReference(canonical.operationalLedgerRef, {
    expectedLedgerPath: normalizedLedgerPath
  });
  const resolvedLedgerPath = resolveArtifactPath(
    rootPath,
    canonical.operationalLedgerRef.path
  );
  const hasReviewLedger = Object.hasOwn(canonical, "reviewLedgerRef");
  const normalizedReviewLedgerPath = validateLedgerRelativePath(
    expectedReviewLedgerPath,
    "Public evidence review ledger path"
  );
  if (hasReviewLedger) {
    validateReviewLedgerReference(canonical.reviewLedgerRef, {
      expectedReviewLedgerPath: normalizedReviewLedgerPath
    });
  }
  const resolvedReviewLedgerPath = hasReviewLedger
    ? resolveArtifactPath(rootPath, canonical.reviewLedgerRef.path)
    : null;
  const [currentCanonical, currentLedger, currentReviewLedger] = await Promise.all([
    readOptionalBytes(resolvedCanonicalPath, readFileImpl),
    readOptionalBytes(resolvedLedgerPath, readFileImpl),
    resolvedReviewLedgerPath
      ? readOptionalBytes(resolvedReviewLedgerPath, readFileImpl)
      : Promise.resolve(null)
  ]);
  if (currentCanonical === null) {
    throw new Error("Canonical public evidence artifact is missing.");
  }
  if (currentLedger === null) {
    throw new Error("Public evidence operational ledger is missing.");
  }
  if (hasReviewLedger && currentReviewLedger === null) {
    throw new Error("Public evidence review ledger is missing.");
  }
  if (
    expectedCanonicalSha256 === undefined ||
    expectedLedgerSha256 === undefined ||
    (hasReviewLedger && expectedReviewLedgerSha256 === undefined)
  ) {
    throw new TypeError(
      "Canonical-only publication requires initial canonical and all referenced ledger SHA-256 values."
    );
  }
  assertExpectedHash(
    currentCanonical,
    expectedCanonicalSha256,
    "Canonical public evidence artifact"
  );
  assertExpectedHash(
    currentReviewLedger,
    expectedReviewLedgerSha256,
    "Public evidence review ledger"
  );
  assertExpectedHash(
    currentLedger,
    expectedLedgerSha256,
    "Public evidence operational ledger"
  );

  const currentCanonicalValue = parseJsonSource(
    currentCanonical,
    "Current canonical public evidence artifact"
  );
  if (!Object.hasOwn(currentCanonicalValue, "operationalLedgerRef")) {
    throw new Error(
      "Canonical-only publication cannot replace a legacy public evidence artifact."
    );
  }
  validateOperationalLedgerReference(currentCanonicalValue.operationalLedgerRef, {
    expectedLedgerPath: normalizedLedgerPath
  });
  if (
    JSON.stringify(currentCanonicalValue.operationalLedgerRef) !==
    JSON.stringify(canonical.operationalLedgerRef)
  ) {
    throw new Error(
      "Canonical-only publication must preserve the operational ledger reference exactly."
    );
  }
  if (hasReviewLedger !== Object.hasOwn(currentCanonicalValue, "reviewLedgerRef")) {
    throw new Error(
      "Canonical-only publication must preserve whether a review ledger reference exists."
    );
  }
  if (hasReviewLedger) {
    validateReviewLedgerReference(currentCanonicalValue.reviewLedgerRef, {
      expectedReviewLedgerPath: normalizedReviewLedgerPath
    });
    if (
      JSON.stringify(currentCanonicalValue.reviewLedgerRef) !==
      JSON.stringify(canonical.reviewLedgerRef)
    ) {
      throw new Error(
        "Canonical-only publication must preserve the review ledger reference exactly."
      );
    }
  }

  // This validates the hash, byte count, schema, and row counts without
  // changing either referenced ledger.
  hydratePublicEvidenceArtifact(canonical, currentLedger, {
    expectedLedgerPath: normalizedLedgerPath,
    reviewLedgerSource: currentReviewLedger,
    expectedReviewLedgerPath: normalizedReviewLedgerPath
  });
  const canonicalBody = serializeCompactPublicEvidenceArtifact(canonical);
  const canonicalSha256 = sha256(canonicalBody);
  const ledgerSha256 = sha256(currentLedger);
  const reviewLedgerSha256 = currentReviewLedger
    ? sha256(currentReviewLedger)
    : null;
  const canonicalMode = await existingMode(resolvedCanonicalPath, statImpl, 0o644);
  await mkdirImpl(dirname(resolvedCanonicalPath), { recursive: true });
  const canonicalTemporary = `${resolvedCanonicalPath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFileImpl(canonicalTemporary, canonicalBody, {
      flag: "wx",
      mode: canonicalMode
    });
    const temporaryCanonical = await readFileImpl(canonicalTemporary);
    if (sha256(temporaryCanonical) !== canonicalSha256) {
      throw new Error(
        "Temporary canonical public evidence artifact did not match its planned SHA-256."
      );
    }
    hydratePublicEvidenceArtifact(
      parseJsonSource(temporaryCanonical, "Temporary canonical public evidence artifact"),
      currentLedger,
      {
        expectedLedgerPath: normalizedLedgerPath,
        reviewLedgerSource: currentReviewLedger,
        expectedReviewLedgerPath: normalizedReviewLedgerPath
      }
    );
    await assertUnchanged(
      resolvedCanonicalPath,
      currentCanonical,
      readFileImpl,
      "Canonical public evidence artifact"
    );
    if (resolvedReviewLedgerPath) {
      await assertUnchanged(
        resolvedReviewLedgerPath,
        currentReviewLedger,
        readFileImpl,
        "Public evidence review ledger"
      );
    }
    await assertUnchanged(
      resolvedLedgerPath,
      currentLedger,
      readFileImpl,
      "Public evidence operational ledger"
    );
    await renameImpl(canonicalTemporary, resolvedCanonicalPath);
  } finally {
    await removeImpl(canonicalTemporary, { force: true });
  }

  const [publishedCanonical, publishedLedger, publishedReviewLedger] = await Promise.all([
    readFileImpl(resolvedCanonicalPath),
    readFileImpl(resolvedLedgerPath),
    resolvedReviewLedgerPath
      ? readFileImpl(resolvedReviewLedgerPath)
      : Promise.resolve(null)
  ]);
  if (sha256(publishedCanonical) !== canonicalSha256) {
    throw new Error(
      "Published canonical public evidence artifact did not match its planned SHA-256."
    );
  }
  if (sha256(publishedLedger) !== ledgerSha256) {
    throw new Error(
      "Public evidence operational ledger changed during canonical-only publication."
    );
  }
  if (
    publishedReviewLedger &&
    sha256(publishedReviewLedger) !== reviewLedgerSha256
  ) {
    throw new Error(
      "Public evidence review ledger changed during canonical-only publication."
    );
  }
  hydratePublicEvidenceArtifact(
    parseJsonSource(publishedCanonical, "Published canonical public evidence artifact"),
    publishedLedger,
    {
      expectedLedgerPath: normalizedLedgerPath,
      reviewLedgerSource: publishedReviewLedger,
      expectedReviewLedgerPath: normalizedReviewLedgerPath
    }
  );
  return {
    canonical,
    canonicalBody,
    canonicalSha256,
    canonicalPath: resolvedCanonicalPath,
    ledgerPath: resolvedLedgerPath,
    ledgerSha256,
    reference: canonical.operationalLedgerRef,
    reviewLedgerPath: resolvedReviewLedgerPath,
    reviewLedgerSha256,
    reviewReference: canonical.reviewLedgerRef ?? null
  };
}

function verifyArtifactSetBytes(
  canonicalSource,
  ledgerSource,
  reviewLedgerSource,
  expectedPair
) {
  const canonicalBytes = sourceBytes(canonicalSource);
  const ledgerBytes = sourceBytes(ledgerSource);
  const reviewLedgerBytes = sourceBytes(reviewLedgerSource);
  if (sha256(canonicalBytes) !== expectedPair.canonicalSha256) {
    throw new Error("Published public evidence artifact did not match its planned SHA-256.");
  }
  if (sha256(ledgerBytes) !== expectedPair.ledgerSha256) {
    throw new Error("Published public evidence operational ledger did not match its planned SHA-256.");
  }
  if (sha256(reviewLedgerBytes) !== expectedPair.reviewLedgerSha256) {
    throw new Error("Published public evidence review ledger did not match its planned SHA-256.");
  }
  const canonical = parseJsonSource(canonicalBytes, "Published public evidence artifact");
  hydratePublicEvidenceArtifact(canonical, ledgerBytes, {
    reviewLedgerSource: reviewLedgerBytes
  });
}

function publicEvidenceWithoutExternalCollections(
  snapshot,
  operationalReference,
  reviewReference
) {
  const result = {};
  let insertedReferences = false;
  for (const [key, value] of Object.entries(snapshot)) {
    if (
      PUBLIC_EVIDENCE_OPERATIONAL_KEYS.includes(key) ||
      PUBLIC_EVIDENCE_REVIEW_KEYS.includes(key) ||
      key === "operationalLedgerRef" ||
      key === "reviewLedgerRef"
    ) {
      continue;
    }
    result[key] = value;
    if (key === "source") {
      result.operationalLedgerRef = operationalReference;
      result.reviewLedgerRef = reviewReference;
      insertedReferences = true;
    }
  }
  if (!insertedReferences) {
    return {
      operationalLedgerRef: operationalReference,
      reviewLedgerRef: reviewReference,
      ...result
    };
  }
  return result;
}

function normalizeOperationalCollections(value, { requireOwnProperties, label }) {
  const defaults = {
    failures: [],
    attempts: {},
    discoveryAttempts: [],
    sourceDiscoveryPaths: []
  };
  if (requireOwnProperties) {
    for (const key of PUBLIC_EVIDENCE_OPERATIONAL_KEYS) {
      if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required.`);
    }
  }
  const result = Object.fromEntries(
    PUBLIC_EVIDENCE_OPERATIONAL_KEYS.map((key) => [key, value[key] ?? defaults[key]])
  );
  for (const key of ["failures", "discoveryAttempts", "sourceDiscoveryPaths"]) {
    if (!Array.isArray(result[key])) throw new TypeError(`${label}.${key} must be an array.`);
  }
  assertPlainObject(result.attempts, `${label}.attempts`);
  return result;
}

function operationalCounts(operational) {
  return {
    failures: operational.failures.length,
    attempts: Object.keys(operational.attempts).length,
    discoveryAttempts: operational.discoveryAttempts.length,
    sourceDiscoveryPaths: operational.sourceDiscoveryPaths.length
  };
}

function normalizeReviewCollections(value, { requireOwnProperties, label }) {
  const defaults = {
    attributionReconciliationLedger: [],
    needsReview: []
  };
  if (requireOwnProperties) {
    for (const key of PUBLIC_EVIDENCE_REVIEW_KEYS) {
      if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required.`);
    }
  }
  const result = Object.fromEntries(
    PUBLIC_EVIDENCE_REVIEW_KEYS.map((key) => [key, value[key] ?? defaults[key]])
  );
  for (const key of PUBLIC_EVIDENCE_REVIEW_KEYS) {
    if (!Array.isArray(result[key])) throw new TypeError(`${label}.${key} must be an array.`);
  }
  return result;
}

function reviewCounts(review) {
  return {
    attributionReconciliationLedger: review.attributionReconciliationLedger.length,
    needsReview: review.needsReview.length
  };
}

function hydrateOperationalCollections(
  canonical,
  ledgerSource,
  { expectedLedgerPath, ledgerMaxBytes }
) {
  const reference = canonical.operationalLedgerRef;
  if (reference === undefined) {
    return normalizeOperationalCollections(canonical, {
      requireOwnProperties: false,
      label: "Legacy public evidence artifact"
    });
  }
  for (const key of PUBLIC_EVIDENCE_OPERATIONAL_KEYS) {
    if (Object.hasOwn(canonical, key)) {
      throw new Error(`Split public evidence artifact must not embed ${key}.`);
    }
  }
  validateOperationalLedgerReference(reference, { expectedLedgerPath });
  if (ledgerSource === null || ledgerSource === undefined) {
    throw new Error(`Public evidence operational ledger is required at ${reference.path}.`);
  }
  const ledgerBody = sourceBytes(ledgerSource);
  assertPublicEvidenceOperationalLedgerSize(ledgerBody, { maxBytes: ledgerMaxBytes });
  validateReferencedBytes(ledgerBody, reference, "Public evidence operational ledger");
  const ledger = parseJsonSource(ledgerBody, "Public evidence operational ledger");
  validateOperationalLedger(ledger);
  const expectedLedgerVersion = reference.schemaVersion ===
    PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_REFERENCE_VERSION
    ? PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION
    : LEGACY_PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION;
  if (ledger.schemaVersion !== expectedLedgerVersion) {
    throw new Error(
      `Public evidence operational ledger/reference version mismatch: ` +
      `${ledger.schemaVersion} vs ${reference.schemaVersion}.`
    );
  }
  const operational = normalizeOperationalCollections(ledger, {
    requireOwnProperties: true,
    label: "Public evidence operational ledger"
  });
  if (ledger.schemaVersion === PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION) {
    validateOperationalRetentionMetadata(ledger.retention, operational);
    if (JSON.stringify(reference.retention) !== JSON.stringify(ledger.retention)) {
      throw new Error(
        "Public evidence operational ledger retention metadata does not match its reference."
      );
    }
    if (
      JSON.stringify(canonical?.source?.operationalRetention) !==
      JSON.stringify(ledger.retention)
    ) {
      throw new Error(
        "Public evidence operational ledger retention metadata does not match canonical source metadata."
      );
    }
  }
  assertReferencedCounts(
    operationalCounts(operational),
    reference.counts,
    PUBLIC_EVIDENCE_OPERATIONAL_KEYS,
    "Public evidence operational ledger"
  );
  return operational;
}

function hydrateReviewCollections(
  canonical,
  reviewLedgerSource,
  { expectedReviewLedgerPath, reviewLedgerMaxBytes }
) {
  const reference = canonical.reviewLedgerRef;
  if (reference === undefined) {
    return normalizeReviewCollections(canonical, {
      requireOwnProperties: false,
      label: "Legacy public evidence artifact"
    });
  }
  for (const key of PUBLIC_EVIDENCE_REVIEW_KEYS) {
    if (Object.hasOwn(canonical, key)) {
      throw new Error(`Split public evidence artifact must not embed ${key}.`);
    }
  }
  validateReviewLedgerReference(reference, { expectedReviewLedgerPath });
  if (reviewLedgerSource === null || reviewLedgerSource === undefined) {
    throw new Error(`Public evidence review ledger is required at ${reference.path}.`);
  }
  const reviewLedgerBody = sourceBytes(reviewLedgerSource);
  assertPublicEvidenceReviewLedgerSize(reviewLedgerBody, {
    maxBytes: reviewLedgerMaxBytes
  });
  validateReferencedBytes(reviewLedgerBody, reference, "Public evidence review ledger");
  const reviewLedger = parseJsonSource(
    reviewLedgerBody,
    "Public evidence review ledger"
  );
  validateReviewLedger(reviewLedger);
  const review = normalizeReviewCollections(reviewLedger, {
    requireOwnProperties: true,
    label: "Public evidence review ledger"
  });
  assertReferencedCounts(
    reviewCounts(review),
    reference.counts,
    PUBLIC_EVIDENCE_REVIEW_KEYS,
    "Public evidence review ledger"
  );
  return review;
}

function validateReferencedBytes(bytes, reference, label) {
  if (bytes.length !== reference.bytes) {
    throw new Error(
      `${label} byte count mismatch: expected ${reference.bytes}, received ${bytes.length}.`
    );
  }
  const actualHash = sha256(bytes);
  if (actualHash !== reference.sha256) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${reference.sha256}, received ${actualHash}.`
    );
  }
}

function assertReferencedCounts(actual, expected, keys, label) {
  for (const key of keys) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `${label} ${key} count mismatch: expected ${expected[key]}, received ${actual[key]}.`
      );
    }
  }
}

function validateOperationalLedgerReference(reference, { expectedLedgerPath }) {
  assertPlainObject(reference, "Public evidence operational ledger reference");
  if (![PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_REFERENCE_VERSION,
    LEGACY_PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_REFERENCE_VERSION]
    .includes(reference.schemaVersion)) {
    throw new Error(
      `Unsupported public evidence operational ledger reference version: ${reference.schemaVersion ?? "missing"}.`
    );
  }
  const normalizedPath = validateLedgerRelativePath(
    reference.path,
    "Public evidence operational ledger path"
  );
  if (
    normalizedPath !==
    validateLedgerRelativePath(
      expectedLedgerPath,
      "Public evidence operational ledger path"
    )
  ) {
    throw new Error(
      `Public evidence operational ledger path must be ${expectedLedgerPath}; received ${normalizedPath}.`
    );
  }
  if (!SHA256_PATTERN.test(String(reference.sha256 ?? ""))) {
    throw new Error("Public evidence operational ledger reference requires a lowercase SHA-256.");
  }
  if (!Number.isSafeInteger(reference.bytes) || reference.bytes <= 0) {
    throw new Error("Public evidence operational ledger reference bytes must be positive.");
  }
  assertPlainObject(reference.counts, "Public evidence operational ledger reference counts");
  for (const key of PUBLIC_EVIDENCE_OPERATIONAL_KEYS) {
    if (!Number.isSafeInteger(reference.counts[key]) || reference.counts[key] < 0) {
      throw new Error(`Public evidence operational ledger reference count ${key} is invalid.`);
    }
  }
  if (reference.schemaVersion === PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_REFERENCE_VERSION) {
    validateOperationalRetentionMetadata(reference.retention);
  } else if (Object.hasOwn(reference, "retention")) {
    throw new Error(
      "Legacy public evidence operational ledger references must not contain retention metadata."
    );
  }
}

function validateReviewLedgerReference(reference, { expectedReviewLedgerPath }) {
  assertPlainObject(reference, "Public evidence review ledger reference");
  if (reference.schemaVersion !== PUBLIC_EVIDENCE_REVIEW_LEDGER_REFERENCE_VERSION) {
    throw new Error(
      `Unsupported public evidence review ledger reference version: ${reference.schemaVersion ?? "missing"}.`
    );
  }
  const normalizedPath = validateLedgerRelativePath(
    reference.path,
    "Public evidence review ledger path"
  );
  if (
    normalizedPath !==
    validateLedgerRelativePath(
      expectedReviewLedgerPath,
      "Public evidence review ledger path"
    )
  ) {
    throw new Error(
      `Public evidence review ledger path must be ${expectedReviewLedgerPath}; received ${normalizedPath}.`
    );
  }
  if (!SHA256_PATTERN.test(String(reference.sha256 ?? ""))) {
    throw new Error("Public evidence review ledger reference requires a lowercase SHA-256.");
  }
  if (!Number.isSafeInteger(reference.bytes) || reference.bytes <= 0) {
    throw new Error("Public evidence review ledger reference bytes must be positive.");
  }
  assertPlainObject(reference.counts, "Public evidence review ledger reference counts");
  for (const key of PUBLIC_EVIDENCE_REVIEW_KEYS) {
    if (!Number.isSafeInteger(reference.counts[key]) || reference.counts[key] < 0) {
      throw new Error(`Public evidence review ledger reference count ${key} is invalid.`);
    }
  }
}

function validateOperationalLedger(ledger) {
  assertPlainObject(ledger, "Public evidence operational ledger");
  if (![PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION,
    LEGACY_PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION]
    .includes(ledger.schemaVersion)) {
    throw new Error(
      `Unsupported public evidence operational ledger version: ${ledger.schemaVersion ?? "missing"}.`
    );
  }
  const expected = new Set([
    "schemaVersion",
    ...(ledger.schemaVersion === PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION
      ? ["retention"]
      : []),
    ...PUBLIC_EVIDENCE_OPERATIONAL_KEYS
  ]);
  const unexpected = Object.keys(ledger).filter((key) => !expected.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `Public evidence operational ledger contains unexpected keys: ${unexpected.join(", ")}.`
    );
  }
  if (ledger.schemaVersion === PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION) {
    validateOperationalRetentionMetadata(ledger.retention);
  }
}

function validateOperationalRetentionMetadata(metadata, operational = null) {
  assertPlainObject(metadata, "Public evidence operational retention metadata");
  if (metadata.schemaVersion !== PUBLIC_EVIDENCE_OPERATIONAL_RETENTION_VERSION) {
    throw new Error(
      `Unsupported public evidence operational retention version: ${metadata.schemaVersion ?? "missing"}.`
    );
  }
  const expected = new Set([
    "schemaVersion",
    "strategy",
    "maxArtifactBytes",
    "targetArtifactBytes",
    "historyPerIdentity",
    "inputCounts",
    "requiredCounts",
    "retainedCounts",
    "historyCounts",
    "prunedCounts",
    "inputSha256",
    "retainedSha256",
    "prunedRowsSha256",
    "parentHistorySha256",
    "historySha256"
  ]);
  const unexpected = Object.keys(metadata).filter((key) => !expected.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `Public evidence operational retention metadata contains unexpected keys: ${unexpected.join(", ")}.`
    );
  }
  if (metadata.strategy !== "latest_terminal_plus_bounded_history") {
    throw new Error("Public evidence operational retention strategy is invalid.");
  }
  for (const key of ["maxArtifactBytes", "targetArtifactBytes", "historyPerIdentity"]) {
    if (!Number.isSafeInteger(metadata[key]) || metadata[key] <= 0) {
      throw new Error(`Public evidence operational retention ${key} is invalid.`);
    }
  }
  if (metadata.targetArtifactBytes >= metadata.maxArtifactBytes) {
    throw new Error(
      "Public evidence operational retention targetArtifactBytes must be below maxArtifactBytes."
    );
  }
  for (const countName of [
    "inputCounts",
    "requiredCounts",
    "retainedCounts",
    "historyCounts",
    "prunedCounts"
  ]) {
    assertPlainObject(
      metadata[countName],
      `Public evidence operational retention ${countName}`
    );
    for (const key of PUBLIC_EVIDENCE_OPERATIONAL_KEYS) {
      if (!Number.isSafeInteger(metadata[countName][key]) || metadata[countName][key] < 0) {
        throw new Error(
          `Public evidence operational retention ${countName}.${key} is invalid.`
        );
      }
    }
  }
  for (const key of PUBLIC_EVIDENCE_OPERATIONAL_KEYS) {
    if (
      metadata.requiredCounts[key] + metadata.historyCounts[key] !==
      metadata.retainedCounts[key]
    ) {
      throw new Error(
        `Public evidence operational retention retained count equation failed for ${key}.`
      );
    }
    if (
      metadata.retainedCounts[key] + metadata.prunedCounts[key] !==
      metadata.inputCounts[key]
    ) {
      throw new Error(
        `Public evidence operational retention input count equation failed for ${key}.`
      );
    }
  }
  for (const key of [
    "inputSha256",
    "retainedSha256",
    "prunedRowsSha256",
    "historySha256"
  ]) {
    if (!SHA256_PATTERN.test(String(metadata[key] ?? ""))) {
      throw new Error(`Public evidence operational retention ${key} is invalid.`);
    }
  }
  if (!Array.isArray(metadata.parentHistorySha256)) {
    throw new TypeError(
      "Public evidence operational retention parentHistorySha256 must be an array."
    );
  }
  const normalizedParents = [...new Set(metadata.parentHistorySha256)]
    .sort((left, right) => String(left).localeCompare(String(right)));
  if (
    normalizedParents.length !== metadata.parentHistorySha256.length ||
    normalizedParents.some((value, index) =>
      value !== metadata.parentHistorySha256[index] || !SHA256_PATTERN.test(String(value))
    )
  ) {
    throw new Error(
      "Public evidence operational retention parent history digests must be unique sorted SHA-256 values."
    );
  }
  const expectedHistorySha256 = sha256(stableJsonStringify({
    schemaVersion: PUBLIC_EVIDENCE_OPERATIONAL_RETENTION_VERSION,
    parentHistorySha256: metadata.parentHistorySha256,
    prunedCounts: metadata.prunedCounts,
    prunedRowsSha256: metadata.prunedRowsSha256
  }));
  if (metadata.historySha256 !== expectedHistorySha256) {
    throw new Error("Public evidence operational retention history SHA-256 is invalid.");
  }
  if (operational) {
    const counts = operationalCounts(operational);
    if (JSON.stringify(counts) !== JSON.stringify(metadata.retainedCounts)) {
      throw new Error(
        "Public evidence operational retention retained counts do not match the ledger."
      );
    }
    if (digestOperationalCollections(operational) !== metadata.retainedSha256) {
      throw new Error(
        "Public evidence operational retention retained SHA-256 does not match the ledger."
      );
    }
  }
}

function validateReviewLedger(ledger) {
  assertPlainObject(ledger, "Public evidence review ledger");
  if (ledger.schemaVersion !== PUBLIC_EVIDENCE_REVIEW_LEDGER_VERSION) {
    throw new Error(
      `Unsupported public evidence review ledger version: ${ledger.schemaVersion ?? "missing"}.`
    );
  }
  const expected = new Set(["schemaVersion", ...PUBLIC_EVIDENCE_REVIEW_KEYS]);
  const unexpected = Object.keys(ledger).filter((key) => !expected.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `Public evidence review ledger contains unexpected keys: ${unexpected.join(", ")}.`
    );
  }
}

function validateLedgerRelativePath(value, label = "Public evidence ledger path") {
  const path = requiredText(value, label).replace(/\\/g, "/");
  if (isAbsolute(path) || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`Unsafe ${label.toLowerCase()}: ${path}.`);
  }
  return path.replace(/^\.\//, "");
}

function resolveArtifactPath(rootPath, relativePath) {
  const normalized = validateLedgerRelativePath(relativePath);
  const resolved = resolve(rootPath, normalized);
  const child = relative(rootPath, resolved);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Public evidence operational ledger escapes repository root: ${relativePath}.`);
  }
  return resolved;
}

function assertArtifactSize(body, maxBytes, label) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError(`${label} maxBytes must be a positive safe integer.`);
  }
  const bytes = Buffer.isBuffer(body)
    ? body.length
    : Buffer.byteLength(String(body), "utf8");
  if (bytes >= maxBytes) {
    throw new Error(`${label} is ${bytes} bytes; it must remain below ${maxBytes} bytes.`);
  }
  return bytes;
}

function serializeCompactJson(value, label) {
  const json = JSON.stringify(value);
  if (typeof json !== "string") throw new TypeError(`${label} must be JSON serializable.`);
  return `${json}\n`;
}

function parseJsonSource(source, label) {
  try {
    return JSON.parse(sourceBytes(source).toString("utf8"));
  } catch (error) {
    throw new Error(
      `${label} is malformed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

function sourceBytes(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

async function readOptionalBytes(path, readFileImpl) {
  try {
    return sourceBytes(await readFileImpl(path));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertExpectedHash(bytes, expected, label) {
  if (expected === undefined) return;
  if (expected === null) {
    if (bytes !== null) throw new Error(`${label} appeared during publication.`);
    return;
  }
  if (!SHA256_PATTERN.test(String(expected))) {
    throw new TypeError(`${label} expected SHA-256 is invalid.`);
  }
  const actual = bytes === null ? null : sha256(bytes);
  if (actual !== expected) {
    throw new Error(`${label} changed before publication; expected ${expected}, received ${actual ?? "missing"}.`);
  }
}

async function assertUnchanged(path, expectedBytes, readFileImpl, label) {
  const current = await readOptionalBytes(path, readFileImpl);
  const expectedHash = expectedBytes === null ? null : sha256(expectedBytes);
  const currentHash = current === null ? null : sha256(current);
  if (expectedHash !== currentHash) {
    throw new Error(`${label} changed during pair publication; refusing to overwrite concurrent work.`);
  }
}

async function existingMode(path, statImpl, fallback) {
  try {
    return (await statImpl(path)).mode & 0o777;
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function restoreArtifact({
  path,
  previous,
  mode,
  writeFileImpl,
  renameImpl,
  removeImpl
}) {
  if (previous === null) {
    await removeImpl(path, { force: true });
    return;
  }
  const temporary = `${path}.${process.pid}-${randomUUID()}.rollback.tmp`;
  try {
    await writeFileImpl(temporary, previous, { flag: "wx", mode });
    await renameImpl(temporary, path);
  } finally {
    await removeImpl(temporary, { force: true });
  }
}
