import {
  YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
  buildTrustedYouTubeChannelIndex,
  extractYouTubeChannelReceipt,
  normalizeYouTubeVideo,
  resolveAttachedOwner,
  resolveYouTubeCandidateOwnership,
  stableStringify
} from "./youtube-native-recovery.mjs";

const TRUST_METHODS = new Set([
  "official_anchor_exact_native_author",
  "trusted_current_channel_owner"
]);
const PROTECTED_LEDGER_KEYS = Object.freeze([
  "attributionReconciliationLedger",
  "failures",
  "attempts",
  "discoveryAttempts",
  "sourceDiscoveryPaths"
]);
const RECOVERY_RECEIPT_KEYS = Object.freeze([
  "physicalKey",
  "schemaVersion",
  "trustMethod",
  "validation",
  "zeroEngagement"
]);
const VALIDATION_RECEIPT_KEYS = Object.freeze([
  "authorName",
  "authorUrl",
  "canonicalUrl",
  "checkedAt",
  "httpStatus",
  "physicalKey",
  "providerName",
  "schemaVersion",
  "status",
  "thumbnailUrl",
  "title",
  "type",
  "videoId"
]);

/**
 * Plan an append-only promotion of a pinned YouTube recovery artifact.
 *
 * The physical YouTube video ID is the identity boundary. Current cohort and
 * channel ownership are recomputed from the current catalogs and current
 * trusted evidence; stored candidate ownership is never accepted by itself.
 */
export function planYouTubeNativePromotion({
  canonical,
  candidate,
  currentSnapshots,
  catalogs
}) {
  const baselineEvidence = requiredRows(canonical?.evidence, "canonical evidence");
  const baselineReview = requiredRows(canonical?.needsReview, "canonical review");
  const candidateEvidence = requiredRows(candidate?.evidence, "candidate evidence");
  assertCandidateEnvelope(candidate, candidateEvidence);

  const snapshots = Array.isArray(currentSnapshots) && currentSnapshots.length > 0
    ? currentSnapshots
    : [canonical];
  const trustedRows = snapshots.flatMap((snapshot) =>
    requiredRows(snapshot?.evidence, "current reference evidence")
  );
  const trustedIndex = buildTrustedYouTubeChannelIndex({ catalogs, trustedRows });
  const currentVideoIndex = physicalVideoIndex(snapshots);
  const reviewByVideo = reviewVideoIndex(baselineReview);
  const baselineIds = new Set(baselineEvidence.map(requiredRowId));
  const candidateIds = new Set();
  const candidateVideos = new Set();
  const resolvedReviewRows = new Set();
  const verified = [];

  for (const row of candidateEvidence) {
    const native = assertCandidateRow(row);
    const id = requiredRowId(row);
    if (candidateIds.has(id)) throw rowError(row, `duplicates candidate id ${id}`);
    if (candidateVideos.has(native.videoId)) {
      throw rowError(row, `duplicates candidate YouTube video ${native.videoId}`);
    }
    if (baselineIds.has(id)) throw rowError(row, `collides with canonical id ${id}`);
    candidateIds.add(id);
    candidateVideos.add(native.videoId);

    const currentOwner = resolveAttachedOwner(row, trustedIndex.owners);
    if (!currentOwner) throw rowError(row, "does not resolve to a current cohort owner");
    assertSameOwner(row, currentOwner, "current cohort owner");
    assertSameOwner(
      row,
      row?.nativeAuthorResolution?.owner,
      "stored native-author owner"
    );

    const exactReviewRows = (reviewByVideo.get(native.videoId) ?? []).filter((reviewRow) => {
      const reviewOwner = resolveAttachedOwner(reviewRow, trustedIndex.owners);
      return reviewOwner && ownerMatches(currentOwner, reviewOwner);
    });
    if (exactReviewRows.length === 0) {
      throw rowError(row, "has no exact current-owner duplicate in the review ledger");
    }

    const decision = resolveYouTubeCandidateOwnership({
      ...native,
      preferred: { row },
      occurrences: exactReviewRows.map((reviewRow) => ({
        sourceKind: "current_review",
        sourcePath: null,
        row: reviewRow
      }))
    }, {
      trustedIndex,
      validationReceipt: row._youtubeNativeRecovery.validation
    });
    if (!decision.accepted) {
      throw rowError(row, `fails current owner/channel reconciliation: ${decision.reason}`);
    }
    if (decision.method !== row._youtubeNativeRecovery.trustMethod) {
      throw rowError(
        row,
        `current trust method changed from ${row._youtubeNativeRecovery.trustMethod} to ${decision.method}`
      );
    }
    assertSameOwner(row, decision.owner, "current reconciled channel owner");
    assertCurrentChannel(row, decision.channelReceipt);

    for (const existing of currentVideoIndex.get(native.videoId) ?? []) {
      const existingOwner = resolveAttachedOwner(existing.row, trustedIndex.owners);
      if (!existingOwner) {
        throw rowError(
          row,
          `current ${existing.sourceLabel} video ${native.videoId} has no resolvable owner`
        );
      }
      assertSameOwner(
        row,
        existingOwner,
        `current ${existing.sourceLabel} video ${native.videoId}`
      );
    }
    for (const reviewRow of exactReviewRows) resolvedReviewRows.add(reviewRow);
    verified.push({ row, native });
  }

  const additions = verified
    .filter(({ native }) => !currentVideoIndex.has(native.videoId))
    .map(({ row }) => row);
  const alreadyRepresented = verified
    .filter(({ native }) => currentVideoIndex.has(native.videoId))
    .map(({ row }) => row);
  const resolvedReview = baselineReview.filter((row) => resolvedReviewRows.has(row));
  const retainedReview = baselineReview.filter((row) => !resolvedReviewRows.has(row));
  const promoted = {
    ...canonical,
    source: {
      ...(canonical?.source ?? {}),
      fetchedAt: newestTimestamp(
        canonical?.source?.fetchedAt,
        ...candidateEvidence.map((row) => row?.last_checked_at ?? row?.linkCheckedAt)
      ),
      evidenceCount: baselineEvidence.length + additions.length,
      needsReviewCount: retainedReview.length
    },
    evidence: [...baselineEvidence, ...additions],
    needsReview: retainedReview
  };

  assertAppendOnlyEvidence(baselineEvidence, promoted.evidence, additions);
  for (const key of PROTECTED_LEDGER_KEYS) {
    if (stableStringify(promoted?.[key]) !== stableStringify(canonical?.[key])) {
      throw new Error(`YouTube promotion unexpectedly changed protected ledger ${key}.`);
    }
  }

  return {
    promoted,
    additions,
    alreadyRepresented,
    resolvedReview,
    retainedReview,
    candidateCount: verified.length,
    reconciledOwnerCount: verified.length,
    zeroEngagementAdditions: additions.filter(isZeroEngagement).length,
    addedByBatch: countBy(additions, (row) => String(row.batchSlug)),
    addedByPlatform: countBy(additions, (row) => String(row.platform)),
    currentReferenceVideoCount: currentVideoIndex.size
  };
}

function assertCandidateEnvelope(candidate, evidence) {
  if (candidate?.schemaVersion !== YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION) {
    throw new Error(
      `Candidate schema must be ${YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION}.`
    );
  }
  if (evidence.length === 0) throw new Error("YouTube candidate evidence must not be empty.");
  if (requiredRows(candidate?.needsReview, "candidate review").length !== 0) {
    throw new Error("YouTube candidate must not contain unresolved review rows.");
  }
  if (
    candidate?.source?.collector !==
      "current_review_operational_and_repository_history_youtube_recovery" ||
    candidate?.source?.anonymousEndpoint !== "www.youtube.com/oembed" ||
    candidate?.source?.authenticatedAccessUsed !== false ||
    candidate?.source?.browserAccessUsed !== false ||
    candidate?.source?.linkedinAccessUsed !== false ||
    candidate?.source?.inputHash !== candidate?.inputManifest?.inputHash ||
    candidate?.inputManifest?.schemaVersion !== YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION
  ) {
    throw new Error("YouTube candidate has an incomplete or unsafe source receipt.");
  }
  for (const key of PROTECTED_LEDGER_KEYS) {
    const value = candidate?.[key];
    const empty = key === "attempts"
      ? isPlainObject(value) && Object.keys(value).length === 0
      : Array.isArray(value) && value.length === 0;
    if (!empty) throw new Error(`YouTube candidate protected ledger ${key} must be empty.`);
  }
  const rejected = requiredRows(candidate?.rejectedCandidates, "candidate rejections");
  const expectedCounts = {
    total: evidence.length,
    byCohort: countBy(evidence, (row) => String(row.batchSlug)),
    byPlatform: { youtube: evidence.length },
    byOwnerType: countBy(evidence, (row) => String(row.entityType)),
    byTrustMethod: countBy(
      evidence,
      (row) => String(row?._youtubeNativeRecovery?.trustMethod)
    ),
    zeroEngagement: evidence.filter(isZeroEngagement).length,
    rejected: rejected.length
  };
  if (stableStringify(candidate?.counts) !== stableStringify(expectedCounts)) {
    throw new Error("YouTube candidate count receipt does not match its rows.");
  }
}

function assertCandidateRow(row) {
  if (row?.platform !== "youtube") throw rowError(row, "is not a YouTube row");
  const native = normalizeYouTubeVideo(row);
  if (!native) throw rowError(row, "does not identify one native YouTube video");
  if (
    row.sourceUrl !== native.canonicalUrl ||
    row.platformPostId !== native.videoId
  ) {
    throw rowError(row, "does not use its exact canonical YouTube video ID and URL");
  }
  const recovery = row?._youtubeNativeRecovery;
  assertExactKeys(recovery, RECOVERY_RECEIPT_KEYS, row, "recovery receipt");
  if (
    recovery.schemaVersion !== YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION ||
    recovery.physicalKey !== native.physicalKey ||
    !TRUST_METHODS.has(recovery.trustMethod)
  ) {
    throw rowError(row, "has a mismatched recovery identity or trust method");
  }
  const validation = recovery.validation;
  assertExactKeys(validation, VALIDATION_RECEIPT_KEYS, row, "validation receipt");
  if (
    validation.schemaVersion !== YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION ||
    validation.videoId !== native.videoId ||
    validation.physicalKey !== native.physicalKey ||
    validation.canonicalUrl !== native.canonicalUrl ||
    validation.status !== "verified" ||
    validation.httpStatus !== 200 ||
    validation.providerName !== "YouTube" ||
    validation.type !== "video" ||
    !clean(validation.title) ||
    !clean(validation.authorName) ||
    !Number.isFinite(Date.parse(String(validation.checkedAt ?? "")))
  ) {
    throw rowError(row, "has an invalid anonymous YouTube validation receipt");
  }
  const validationChannel = extractYouTubeChannelReceipt({}, validation);
  if (validationChannel.keys.length === 0) {
    throw rowError(row, "validation author URL is not a native YouTube channel");
  }
  assertThumbnail(row, validation, native);

  if (
    row?.review_state !== "verified" ||
    row?.linkStatus !== "verified" ||
    row?.attributionStatus !== "verified" ||
    row?.attributionMode !== "account_owner" ||
    Number(row?.attributionVersion ?? 0) < 3 ||
    row?.attributionProvenance !== YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION
  ) {
    throw rowError(row, "is not fully verified for append-only promotion");
  }
  if (
    row.title !== validation.title ||
    row.authorName !== validation.authorName ||
    row.youtubeChannelName !== validation.authorName ||
    row.accountUrl !== validation.authorUrl ||
    row.youtubeChannelUrl !== validation.authorUrl
  ) {
    throw rowError(row, "does not exactly preserve the YouTube oEmbed author receipt");
  }
  const expectedHandle = youtubeHandle(validation.authorUrl);
  if (expectedHandle && row.authorHandle !== expectedHandle) {
    throw rowError(row, "does not preserve the native YouTube author handle");
  }

  const resolution = row?.nativeAuthorResolution;
  if (
    resolution?.status !== "matched" ||
    resolution?.reason !== recovery.trustMethod ||
    resolution?.author?.platform !== "youtube" ||
    resolution?.author?.name !== validation.authorName ||
    resolution?.author?.url !== validation.authorUrl
  ) {
    throw rowError(row, "has an incomplete stored native-author resolution");
  }
  const storedKeys = sortedUniqueStrings(resolution?.author?.keys);
  const receiptKeys = extractYouTubeChannelReceipt(row, validation).keys;
  if (
    storedKeys.length === 0 ||
    stableStringify(storedKeys) !== stableStringify(receiptKeys)
  ) {
    throw rowError(row, "stored native channel keys do not match the receipt");
  }

  const signals = Array.isArray(row?.attributionSignals) ? row.attributionSignals : [];
  for (const signal of [
    "official_youtube_oembed_author_match",
    "unique_native_author",
    recovery.trustMethod
  ]) {
    if (!signals.includes(signal)) throw rowError(row, `is missing attribution signal ${signal}`);
  }
  assertMetrics(row);
  const zeroEngagement = !hasPositiveMetrics(row.metrics);
  if (recovery.zeroEngagement !== zeroEngagement) {
    throw rowError(row, "has a mismatched zero-engagement receipt");
  }
  if (
    signals.includes("zero_engagement_explicit_trust_receipt") !== zeroEngagement
  ) {
    throw rowError(row, "has a mismatched zero-engagement attribution signal");
  }
  if (zeroEngagement && Number(row.contributionScore) !== 0) {
    throw rowError(row, "must keep zero engagement at contribution score 0");
  }
  assertRawReceipt(row, validation, recovery, storedKeys, zeroEngagement);
  return native;
}

function assertRawReceipt(row, validation, recovery, channelKeys, zeroEngagement) {
  const raw = row?.rawVisibleText;
  if (!isPlainObject(raw)) throw rowError(row, "has no structured raw trust receipt");
  if (
    raw.source !== YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION ||
    raw.videoId !== validation.videoId ||
    raw?.oembed?.title !== validation.title ||
    raw?.oembed?.authorName !== validation.authorName ||
    raw?.oembed?.authorUrl !== validation.authorUrl ||
    raw?.oembed?.providerName !== validation.providerName ||
    raw?.oembed?.type !== validation.type ||
    raw?.trust?.method !== recovery.trustMethod ||
    stableStringify(sortedUniqueStrings(raw?.trust?.channelKeys)) !==
      stableStringify(channelKeys) ||
    !Array.isArray(raw?.trust?.receipts) ||
    raw.trust.receipts.length === 0 ||
    !Array.isArray(raw?.sourceOccurrences) ||
    raw.sourceOccurrences.length === 0
  ) {
    throw rowError(row, "has an incomplete or mismatched structured trust receipt");
  }
  const expectedMetricReceipt = zeroEngagement
    ? "no_positive_public_metrics_observed_zero_engagement_explicitly_permitted"
    : "preserved_nonnegative_public_metrics_from_existing_candidate";
  if (raw.metricsReceipt !== expectedMetricReceipt) {
    throw rowError(row, "has a mismatched metric receipt");
  }
}

function assertThumbnail(row, validation, native) {
  if (
    row?.thumbnailSource !== "youtube" ||
    row?.thumbnailUrl !== validation.thumbnailUrl
  ) {
    throw rowError(row, "does not preserve the YouTube validation thumbnail");
  }
  try {
    const url = new URL(validation.thumbnailUrl);
    if (
      url.hostname !== "i.ytimg.com" ||
      !url.pathname.includes(`/vi/${native.videoId}/`)
    ) {
      throw new Error("invalid thumbnail");
    }
  } catch {
    throw rowError(row, "has a thumbnail that does not match its YouTube video ID");
  }
}

function assertCurrentChannel(row, channelReceipt) {
  const storedKeys = sortedUniqueStrings(row?.nativeAuthorResolution?.author?.keys);
  if (
    !channelReceipt ||
    stableStringify(channelReceipt.keys) !== stableStringify(storedKeys)
  ) {
    throw rowError(row, "current channel keys no longer match the stored receipt");
  }
}

function assertAppendOnlyEvidence(baseline, promoted, additions) {
  if (promoted.length !== baseline.length + additions.length) {
    throw new Error("YouTube promotion did not preserve append-only evidence length.");
  }
  for (let index = 0; index < baseline.length; index += 1) {
    if (stableStringify(promoted[index]) !== stableStringify(baseline[index])) {
      throw new Error(`YouTube promotion changed existing evidence row ${index}.`);
    }
  }
  const baselineVideos = new Set(
    baseline.map((row) => normalizeYouTubeVideo(row)?.videoId).filter(Boolean)
  );
  for (const row of additions) {
    const videoId = normalizeYouTubeVideo(row)?.videoId;
    if (!videoId || baselineVideos.has(videoId)) {
      throw new Error(`YouTube promotion introduced duplicate video ${videoId ?? "unknown"}.`);
    }
    baselineVideos.add(videoId);
  }
}

function physicalVideoIndex(snapshots) {
  const index = new Map();
  for (let sourceIndex = 0; sourceIndex < snapshots.length; sourceIndex += 1) {
    const snapshot = snapshots[sourceIndex];
    for (const row of requiredRows(snapshot?.evidence, "current reference evidence")) {
      const native = normalizeYouTubeVideo(row);
      if (!native || row?.platform !== "youtube") continue;
      const values = index.get(native.videoId) ?? [];
      values.push({
        row,
        sourceLabel: sourceIndex === 0 ? "canonical" : `reference ${sourceIndex}`
      });
      index.set(native.videoId, values);
    }
  }
  return index;
}

function reviewVideoIndex(reviewRows) {
  const index = new Map();
  for (const row of reviewRows) {
    const native = normalizeYouTubeVideo(row);
    if (!native || row?.platform !== "youtube") continue;
    index.set(native.videoId, [...(index.get(native.videoId) ?? []), row]);
  }
  return index;
}

function assertMetrics(row) {
  if (!isPlainObject(row?.metrics)) throw rowError(row, "metrics must be an object");
  for (const [name, raw] of Object.entries(row.metrics)) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw rowError(row, `metric ${name} is not a non-negative number`);
    }
  }
  const score = Number(row?.contributionScore);
  if (!Number.isFinite(score) || score < 0) {
    throw rowError(row, "contributionScore is not a non-negative number");
  }
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
  const mismatch = fields.find(([, left, right]) =>
    String(left ?? "") !== String(right ?? "")
  );
  if (mismatch) throw rowError(row, `${label} disagrees on ${mismatch[0]}`);
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

function assertExactKeys(value, expectedKeys, row, label) {
  if (!isPlainObject(value)) throw rowError(row, `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw rowError(row, `${label} does not match the exact schema`);
  }
}

function requiredRows(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requiredRowId(row) {
  const id = clean(row?.id);
  if (!id) throw new Error("YouTube evidence row is missing an id.");
  return id;
}

function isZeroEngagement(row) {
  return !hasPositiveMetrics(row?.metrics) && Number(row?.contributionScore) === 0;
}

function hasPositiveMetrics(metrics) {
  return Object.values(metrics ?? {}).some((value) => Number(value) > 0);
}

function youtubeHandle(value) {
  try {
    const part = new URL(String(value ?? "")).pathname.split("/").filter(Boolean)[0];
    return part?.startsWith("@") ? part.slice(1) : null;
  } catch {
    return null;
  }
}

function sortedUniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].sort();
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

function newestTimestamp(...values) {
  const timestamps = values.filter((value) => Number.isFinite(Date.parse(String(value ?? ""))));
  return timestamps.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function rowError(row, message) {
  return new Error(`YouTube recovery row ${row?.id ?? "unknown"} ${message}.`);
}
