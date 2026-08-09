import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const PUBLIC_EVIDENCE_ARTIFACT_MAX_BYTES = 75 * 1024 * 1024;
export const PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES = 75 * 1024 * 1024;
export const PUBLIC_EVIDENCE_REVIEW_LEDGER_MAX_BYTES = 75 * 1024 * 1024;
export const PUBLIC_EVIDENCE_LEGACY_MAX_BYTES = 128 * 1024 * 1024;
export const PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH =
  "outputs/public-ingestion-operational-ledger-current.json";
export const PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION =
  "public-ingestion-operational-ledger.v1";
export const PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_REFERENCE_VERSION =
  "public-evidence-operational-ledger-reference.v1";
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
  const operational = normalizeOperationalCollections(snapshot, {
    requireOwnProperties: true,
    label: "Public evidence snapshot"
  });
  const operationalLedger = {
    schemaVersion: PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION,
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
    counts: operationalCounts(operational)
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
    snapshot,
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
  const operational = normalizeOperationalCollections(ledger, {
    requireOwnProperties: true,
    label: "Public evidence operational ledger"
  });
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
  if (reference.schemaVersion !== PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_REFERENCE_VERSION) {
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
  if (ledger.schemaVersion !== PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_VERSION) {
    throw new Error(
      `Unsupported public evidence operational ledger version: ${ledger.schemaVersion ?? "missing"}.`
    );
  }
  const expected = new Set(["schemaVersion", ...PUBLIC_EVIDENCE_OPERATIONAL_KEYS]);
  const unexpected = Object.keys(ledger).filter((key) => !expected.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `Public evidence operational ledger contains unexpected keys: ${unexpected.join(", ")}.`
    );
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
