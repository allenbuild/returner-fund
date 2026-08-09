import {
  NEEDS_REVIEW_NATIVE_RECOVERY_VERSION,
  canonicalNativePost
} from "./needs-review-native-recovery.mjs";

const SUPPORTED_VALIDATION = Object.freeze({
  instagram: {
    kind: "instagram_profile_receipt",
    signal: "instagram_profile_receipt_author_match"
  },
  linkedin: {
    kind: "linkedin_primary_body",
    signal: "linkedin_primary_body_author_match"
  },
  x: {
    kind: "official_x_oembed",
    signal: "official_x_oembed_author_match"
  }
});

const PROTECTED_LEDGER_KEYS = Object.freeze([
  "attributionReconciliationLedger",
  "failures",
  "attempts",
  "discoveryAttempts",
  "sourceDiscoveryPaths"
]);

/**
 * Promote a recovery receipt without running the general content-deduplication
 * merge. A native object ID is the identity boundary: two different object IDs
 * remain two posts even when their visible text is identical.
 */
export function planNeedsReviewNativePromotion({
  canonical,
  candidate,
  currentSnapshots,
  resolveNativeAuthor
}) {
  const baselineEvidence = rows(canonical?.evidence, "canonical evidence");
  const baselineReview = rows(canonical?.needsReview, "canonical review");
  const candidateEvidence = rows(candidate?.evidence, "candidate evidence");
  if (candidate?.schemaVersion !== NEEDS_REVIEW_NATIVE_RECOVERY_VERSION) {
    throw new Error(
      `Candidate schema must be ${NEEDS_REVIEW_NATIVE_RECOVERY_VERSION}.`
    );
  }
  if (candidateEvidence.length === 0) {
    throw new Error("Recovery candidate must contain at least one evidence row.");
  }
  if ((candidate?.needsReview?.length ?? 0) !== 0) {
    throw new Error("Recovery candidate must not contain unresolved review rows.");
  }
  if (typeof resolveNativeAuthor !== "function") {
    throw new TypeError("resolveNativeAuthor must be a function.");
  }

  const currentIndex = physicalIndex(currentSnapshots);
  const canonicalIds = new Set(baselineEvidence.map(requiredRowId));
  const reviewRowsByKey = new Map();
  for (const row of baselineReview) {
    const physicalKey = canonicalNativePost(row)?.physicalKey;
    if (!physicalKey) continue;
    reviewRowsByKey.set(physicalKey, [...(reviewRowsByKey.get(physicalKey) ?? []), row]);
  }
  const candidateKeys = new Set();
  const candidateIds = new Set();
  const verified = [];

  for (const row of candidateEvidence) {
    const native = canonicalNativePost(row);
    if (!native) throw rowError(row, "does not have a supported canonical native URL");
    if (candidateKeys.has(native.physicalKey)) {
      throw rowError(row, `duplicates candidate physical post ${native.physicalKey}`);
    }
    candidateKeys.add(native.physicalKey);
    const id = requiredRowId(row);
    if (candidateIds.has(id)) throw rowError(row, `duplicates candidate id ${id}`);
    candidateIds.add(id);
    if (canonicalIds.has(id)) throw rowError(row, `collides with canonical id ${id}`);

    const reviewRows = reviewRowsByKey.get(native.physicalKey) ?? [];
    if (reviewRows.length === 0) {
      throw rowError(row, "is not present in the current review ledger");
    }
    const currentResolution = exactCurrentResolution(
      row,
      reviewRows,
      resolveNativeAuthor
    );
    assertRecoveryReceipt(row, native, currentResolution);
    for (const existing of currentIndex.get(native.physicalKey) ?? []) {
      assertSameOwner(row, existing, `existing ${native.physicalKey}`);
    }
    verified.push({ row, native });
  }

  const additions = verified
    .filter(({ native }) => !currentIndex.has(native.physicalKey))
    .map(({ row }) => row);
  const alreadyRepresented = verified
    .filter(({ native }) => currentIndex.has(native.physicalKey))
    .map(({ row }) => row);
  const resolvedReview = baselineReview.filter((row) => {
    const physicalKey = canonicalNativePost(row)?.physicalKey;
    return physicalKey && candidateKeys.has(physicalKey);
  });
  const retainedReview = baselineReview.filter((row) => {
    const physicalKey = canonicalNativePost(row)?.physicalKey;
    return !physicalKey || !candidateKeys.has(physicalKey);
  });
  const promoted = {
    ...canonical,
    source: {
      ...(canonical?.source ?? {}),
      fetchedAt: newestTimestamp(
        canonical?.source?.fetchedAt,
        candidate?.source?.fetchedAt
      ),
      evidenceCount: baselineEvidence.length + additions.length,
      needsReviewCount: retainedReview.length
    },
    evidence: [...baselineEvidence, ...additions],
    needsReview: retainedReview
  };

  for (const key of PROTECTED_LEDGER_KEYS) {
    if (JSON.stringify(promoted?.[key]) !== JSON.stringify(canonical?.[key])) {
      throw new Error(`Promotion unexpectedly changed protected ledger ${key}.`);
    }
  }
  const promotedKeys = promoted.evidence
    .map((row) => canonicalNativePost(row)?.physicalKey)
    .filter(Boolean);
  if (new Set(promotedKeys).size !== new Set([
    ...baselineEvidence
      .map((row) => canonicalNativePost(row)?.physicalKey)
      .filter(Boolean),
    ...additions.map((row) => canonicalNativePost(row).physicalKey)
  ]).size) {
    throw new Error("Promotion introduced a duplicate native physical post.");
  }

  return {
    promoted,
    additions,
    alreadyRepresented,
    resolvedReview,
    retainedReview,
    candidateCount: verified.length,
    zeroEngagementAdditions: additions.filter(isZeroEngagement).length,
    addedByBatch: countBy(additions, (row) => String(row.batchSlug)),
    addedByPlatform: countBy(additions, (row) => String(row.platform))
  };
}

function assertRecoveryReceipt(row, native, currentResolution) {
  const recovery = row?._needsReviewRecovery;
  if (
    recovery?.schemaVersion !== NEEDS_REVIEW_NATIVE_RECOVERY_VERSION ||
    recovery?.physicalKey !== native.physicalKey
  ) {
    throw rowError(row, "has a missing or mismatched recovery receipt");
  }
  if (
    row?.review_state !== "verified" ||
    row?.linkStatus !== "verified" ||
    row?.attributionStatus !== "verified" ||
    row?.attributionMode !== "account_owner" ||
    Number(row?.attributionVersion ?? 0) < 3
  ) {
    throw rowError(row, "is not fully verified for append-only promotion");
  }
  const expectedValidation = SUPPORTED_VALIDATION[native.platform];
  if (!expectedValidation) throw rowError(row, `uses unsupported platform ${native.platform}`);
  if (recovery.validation?.kind !== expectedValidation.kind) {
    throw rowError(row, `has invalid ${native.platform} validation receipt kind`);
  }
  if (!(row?.attributionSignals ?? []).includes("unique_native_author") ||
      !(row?.attributionSignals ?? []).includes(expectedValidation.signal)) {
    throw rowError(row, "is missing required native-author attribution signals");
  }

  const storedResolution = row?.nativeAuthorResolution;
  if (storedResolution?.status !== "matched" || currentResolution?.status !== "matched") {
    throw rowError(row, "does not resolve to one current native owner");
  }
  if (
    String(storedResolution.author?.platform) !== native.platform ||
    String(storedResolution.author?.key) !== String(currentResolution.author?.key)
  ) {
    throw rowError(row, "native author no longer matches the current catalog");
  }
  assertSameOwner(row, currentResolution.owner, "current catalog owner");
  assertSameOwner(row, storedResolution.owner, "stored recovery owner");
  assertMetrics(row);

  if (native.platform === "x") {
    const returned = canonicalNativePost({
      platform: "x",
      sourceUrl: recovery.validation?.returnedUrl
    });
    if (
      returned?.physicalKey !== native.physicalKey ||
      String(recovery.validation?.author) !== String(currentResolution.author?.key)
    ) {
      throw rowError(row, "has a mismatched official X receipt");
    }
  } else if (native.platform === "instagram") {
    if (
      String(recovery.validation?.shortcode) !== native.postId ||
      String(recovery.validation?.author) !== String(currentResolution.author?.key)
    ) {
      throw rowError(row, "has a mismatched Instagram receipt");
    }
  } else if (!String(recovery.validation?.text ?? "").trim()) {
    throw rowError(row, "has no verified LinkedIn primary body");
  }
}

function exactCurrentResolution(row, reviewRows, resolveNativeAuthor) {
  const expected = row?.nativeAuthorResolution;
  const matches = reviewRows
    .map((reviewRow) => resolveNativeAuthor(reviewRow))
    .filter((resolution) =>
      resolution?.status === "matched" &&
      String(resolution.author?.platform) === String(expected?.author?.platform) &&
      String(resolution.author?.key) === String(expected?.author?.key) &&
      ownerMatches(expected?.owner, resolution.owner)
    );
  const unique = new Map(matches.map((resolution) => [
    [
      resolution.author?.platform,
      resolution.author?.key,
      resolution.owner?.batchSlug,
      resolution.owner?.entityType,
      resolution.owner?.entityId
    ].join(":"),
    resolution
  ]));
  if (unique.size !== 1) {
    throw rowError(row, "does not resolve from its current review receipt to one native owner");
  }
  return [...unique.values()][0];
}

function ownerMatches(left, right) {
  return [
    "batchSlug",
    "entityType",
    "entityId",
    "entityName",
    "companySlug",
    "companyName"
  ].every((field) => String(left?.[field] ?? "") === String(right?.[field] ?? ""));
}

function assertSameOwner(row, owner, label) {
  const fields = [
    ["batchSlug", row?.batchSlug, owner?.batchSlug],
    ["entityType", row?.entityType, owner?.entityType],
    ["entityId", row?.entityId, owner?.entityId],
    ["entityName", row?.entityName, owner?.entityName],
    ["companySlug", row?.companySlug, owner?.companySlug],
    ["companyName", row?.companyName, owner?.companyName]
  ];
  const mismatch = fields.find(([, left, right]) => String(left ?? "") !== String(right ?? ""));
  if (mismatch) {
    throw rowError(row, `${label} disagrees on ${mismatch[0]}`);
  }
}

function assertMetrics(row) {
  if (!row?.metrics || typeof row.metrics !== "object" || Array.isArray(row.metrics)) {
    throw rowError(row, "metrics must be an object");
  }
  for (const [name, value] of Object.entries(row.metrics)) {
    if (!Number.isFinite(Number(value)) || Number(value) < 0) {
      throw rowError(row, `metric ${name} is not a non-negative number`);
    }
  }
  if (!Number.isFinite(Number(row?.contributionScore)) || Number(row.contributionScore) < 0) {
    throw rowError(row, "contributionScore is not a non-negative number");
  }
}

function physicalIndex(snapshots) {
  const index = new Map();
  for (const snapshot of snapshots ?? []) {
    for (const row of snapshot?.evidence ?? []) {
      const physicalKey = canonicalNativePost(row)?.physicalKey;
      if (!physicalKey) continue;
      index.set(physicalKey, [...(index.get(physicalKey) ?? []), row]);
    }
  }
  return index;
}

function rows(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requiredRowId(row) {
  const id = String(row?.id ?? "").trim();
  if (!id) throw new Error("Evidence row is missing an id.");
  return id;
}

function rowError(row, message) {
  return new Error(`Recovery row ${row?.id ?? "unknown"} ${message}.`);
}

function isZeroEngagement(row) {
  return Object.values(row?.metrics ?? {}).every((value) => Number(value) === 0) &&
    Number(row?.contributionScore ?? 0) === 0;
}

function countBy(items, keyFor) {
  const counts = {};
  for (const item of items) {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) =>
    left.localeCompare(right)
  ));
}

function newestTimestamp(left, right) {
  const candidates = [left, right].filter((value) =>
    Number.isFinite(Date.parse(String(value ?? "")))
  );
  return candidates.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? left ?? right ?? null;
}
