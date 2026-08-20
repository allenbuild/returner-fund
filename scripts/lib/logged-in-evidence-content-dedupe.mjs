import {
  publicationTimesCompatible,
  sourceAuthorsCompatible,
  sourceContentIdentity
} from "./source-content-identity.mjs";
import {
  instagramDetailObservationMatchesMeta
} from "./logged-in-instagram-collection.mjs";
import { linkedinPostIsExplicitRepost } from "./logged-in-linkedin-collection.mjs";

const CONTENT_DUPLICATE_REASON = "same_platform_author_substantive_body";
const NATIVE_OWNER_FOUNDER_REASON = "native_owner_founder_account";
const INSTAGRAM_PRIMARY_OWNER_REASON = "instagram_collaboration_primary_native_owner";
const NON_NATIVE_LINKEDIN_REPOST_REASON = "non_native_linkedin_repost_wrapper";
const AMBIGUOUS_NATIVE_OWNER_REASON = "ambiguous_native_account_owner_mapping";
const METRICLESS_NATIVE_POST_REASON = "metricless_native_post";
const INVALID_NATIVE_POST_DATE_REASON = "invalid_native_post_date";

export function mergeLoggedInEvidenceRows(
  existingSnapshots = [],
  incomingSnapshots = []
) {
  const existingRows = existingSnapshots.flatMap((snapshot) => snapshot?.evidence ?? []);
  const incomingRows = incomingSnapshots.flatMap((snapshot) => {
    const batchSlug = snapshot?.source?.batchSlug ?? snapshot?.source?.batch_slug;
    return (snapshot?.evidence ?? []).map((row) => {
      if (row?.batchSlug || row?.batch_slug || !batchSlug) return row;
      return { ...row, batchSlug };
    });
  });
  return [...existingRows, ...incomingRows];
}

export function finalizeLoggedInEvidenceContent(
  rows,
  {
    defaultBatchSlug = null,
    resolveBatchSlug = null,
    existingNeedsReview = [],
    existingAttributionReconciliationLedger = []
  } = {}
) {
  const batchOptions = { defaultBatchSlug, resolveBatchSlug };
  const nativeOnly = quarantineNonNativeLinkedInReposts(rows, batchOptions);
  const eligibleNative = quarantineIneligibleNativeObservations(
    nativeOnly.evidence,
    batchOptions
  );
  const physical = dedupeNativePhysicalObservations(
    eligibleNative.evidence,
    batchOptions
  );
  const instagramOwnerResolved = resolveInstagramPrimaryPhysicalOwnership(
    physical,
    batchOptions
  );
  const ownerResolved = resolveFounderNativeAccountOwnership(
    instagramOwnerResolved.evidence,
    batchOptions
  );
  const byContent = new Map();
  const evidence = [];
  const duplicateReviews = [];

  for (const row of [...ownerResolved.evidence].sort(compareLoggedInContentPreference)) {
    const identity = loggedInContentIdentity(row);
    if (!identity) {
      evidence.push(row);
      continue;
    }
    const batchSlug = resolvedBatchSlug(row, batchOptions);
    const scope = [
      batchSlug ?? "unresolved-batch",
      row?.entityType ?? row?.entity_type ?? "company",
      row?.entityId ?? row?.entity_id ?? row?.companySlug ?? "unknown"
    ].join(":");
    const physical = [
      String(row?.platform ?? "").toLowerCase(),
      row?.platformPostId ?? row?.platform_post_id ?? row?.sourceUrl ?? row?.source_url
    ].join(":");
    let duplicate = null;
    for (const contentKey of identity.keys) {
      duplicate = (byContent.get(`${scope}:${contentKey}`) ?? []).find((candidate) =>
        candidate.physical !== physical &&
        sourceAuthorsCompatible(identity, candidate.identity) &&
        publicationTimesCompatible(identity, candidate.identity)
      ) ?? null;
      if (duplicate) break;
    }
    if (duplicate) {
      duplicateReviews.push(contentDuplicateReview(row, duplicate.row, identity, batchSlug));
      continue;
    }
    evidence.push(row);
    const indexed = { row, identity, physical };
    for (const contentKey of identity.keys) {
      const key = `${scope}:${contentKey}`;
      byContent.set(key, [...(byContent.get(key) ?? []), indexed]);
    }
  }

  const needsReview = dedupeRowsById([
    ...existingNeedsReview.map(normalizePersistedOwnerCollisionReview),
    ...nativeOnly.needsReview,
    ...eligibleNative.needsReview,
    ...instagramOwnerResolved.needsReview,
    ...ownerResolved.needsReview,
    ...duplicateReviews
  ]);
  const attributionReconciliationLedger = mergeLoggedInAttributionReconciliationLedgers(
    existingAttributionReconciliationLedger,
    instagramOwnerResolved.attributionReconciliationLedger,
    ownerResolved.attributionReconciliationLedger,
    needsReview.map((row) => row?.attributionReconciliationDirective)
  );
  return { evidence, needsReview, attributionReconciliationLedger };
}

function quarantineIneligibleNativeObservations(rows, options) {
  const evidence = [];
  const needsReview = [];

  for (const originalRow of rows ?? []) {
    const platform = String(originalRow?.platform ?? "").toLowerCase();
    const row = withDerivedNativePostedAt(originalRow, platform);
    if (!["x", "linkedin", "instagram"].includes(platform)) {
      evidence.push(row);
      continue;
    }

    if (
      row?.tractionStatus === "unscored" &&
      row?.sourceUrl &&
      row?.platformPostId
    ) {
      evidence.push(row);
      continue;
    }

    let reason = null;
    if (positiveMetricCount(row) === 0) {
      reason = METRICLESS_NATIVE_POST_REASON;
    } else {
      const publishedAt = Date.parse(row?.postedAt ?? row?.posted_at ?? "");
      if (!Number.isFinite(publishedAt)) {
        reason = INVALID_NATIVE_POST_DATE_REASON;
      }
    }

    if (!reason) {
      evidence.push(row);
      continue;
    }

    const batchSlug = resolvedBatchSlug(row, options);
    const entityId = row?.entityId ?? row?.entity_id ?? null;
    needsReview.push({
      id: [
        "ineligible-native",
        reason,
        platform,
        row?.platformPostId ?? row?.platform_post_id ?? row?.id ?? "unknown-post",
        entityId ?? "unknown-entity"
      ].join("-"),
      batchSlug: batchSlug ?? null,
      entityType: row?.entityType ?? row?.entity_type ?? null,
      entityId,
      entityName: row?.entityName ?? row?.companyName ?? null,
      companySlug: row?.companySlug ?? null,
      companyName: row?.companyName ?? null,
      platform,
      platformPostId: row?.platformPostId ?? row?.platform_post_id ?? null,
      candidateUrl: row?.sourceUrl ?? row?.source_url ?? null,
      sourceEvidenceId: row?.id ?? null,
      review_state: "needs_review",
      quarantineReasons: [reason],
      matchReason:
        `Quarantined during logged-in evidence finalization: ${reason}.`
    });
  }

  return { evidence, needsReview };
}

function withDerivedNativePostedAt(row, platform) {
  if (Number.isFinite(Date.parse(row?.postedAt ?? row?.posted_at ?? ""))) {
    return row;
  }
  const id =
    normalizedNativePostId(
      platform,
      row?.platformPostId ?? row?.platform_post_id
    ) ??
    nativePostIdFromUrl(platform, row?.sourceUrl ?? row?.source_url);
  if (!id || !/^\d+$/.test(id)) return row;

  try {
    const snowflake = BigInt(id);
    const timestamp =
      platform === "linkedin"
        ? Number(snowflake >> 22n)
        : platform === "x"
          ? Number((snowflake >> 22n) + 1_288_834_974_657n)
          : NaN;
    if (
      !Number.isFinite(timestamp) ||
      timestamp < Date.parse("2006-01-01T00:00:00.000Z") ||
      timestamp > Date.now() + 86_400_000
    ) {
      return row;
    }
    return { ...row, postedAt: new Date(timestamp).toISOString() };
  } catch {
    return row;
  }
}

function normalizePersistedOwnerCollisionReview(row) {
  if (
    !Array.isArray(row?.quarantineReasons) ||
    !row.quarantineReasons.includes("ambiguous_native_account_owner_mapping")
  ) {
    return row;
  }

  const targets = Array.isArray(row?.nativeAccountOwnerCollision?.targets)
    ? row.nativeAccountOwnerCollision.targets
    : [];
  const companyTargets = targets.filter(
    (target) =>
      target?.entityType === "company" &&
      typeof target?.entityId === "string" &&
      target.entityId.trim()
  );
  const companyEntityIds = new Set(
    companyTargets.map((target) => target.entityId.trim())
  );
  if (companyEntityIds.size !== 1) return row;

  const companyTarget = companyTargets[0];
  return {
    ...row,
    entityType: "company",
    entityId: companyTarget.entityId.trim(),
    entityName:
      companyTarget.entityName ??
      companyTarget.name ??
      companyTarget.companyName ??
      companyTarget.entityId.trim(),
    companySlug: companyTarget.companySlug ?? row.companySlug ?? null,
    companyName:
      companyTarget.companyName ??
      row.companyName ??
      companyTarget.entityName ??
      companyTarget.name ??
      null
  };
}

function quarantineNonNativeLinkedInReposts(rows, options) {
  const evidence = [];
  const needsReview = [];

  for (const row of rows ?? []) {
    if (
      String(row?.platform ?? "").toLowerCase() === "linkedin" &&
      linkedinPostIsExplicitRepost({
        rawText: row?.rawVisibleText ?? row?.raw_visible_text,
        body: row?.text
      })
    ) {
      const batchSlug = resolvedBatchSlug(row, options);
      const entityId = row?.entityId ?? row?.entity_id ?? null;
      needsReview.push({
        id: `non-native-linkedin-repost-${row?.id ?? row?.platformPostId ?? entityId}`,
        batchSlug: batchSlug ?? null,
        entityType: row?.entityType ?? row?.entity_type ?? null,
        entityId,
        entityName: row?.entityName ?? row?.companyName ?? null,
        companySlug: row?.companySlug ?? null,
        companyName: row?.companyName ?? null,
        platform: "linkedin",
        platformPostId: row?.platformPostId ?? row?.platform_post_id ?? null,
        candidateUrl: row?.sourceUrl ?? row?.source_url ?? null,
        sourceEvidenceId: row?.id ?? null,
        review_state: "needs_review",
        quarantineReasons: [NON_NATIVE_LINKEDIN_REPOST_REASON],
        matchReason:
          `Quarantined during logged-in evidence finalization: ${NON_NATIVE_LINKEDIN_REPOST_REASON}.`
      });
      continue;
    }
    evidence.push(row);
  }

  return { evidence, needsReview };
}

export function mergeLoggedInAttributionReconciliationLedgers(...ledgers) {
  const byTarget = new Map();
  for (const directive of ledgers.flatMap((ledger) => ledger ?? [])) {
    const stale = directive?.staleAttribution;
    if (!directive?.platform || !stale?.batchSlug || !stale?.entityId) continue;
    const key = [
      String(directive.platform).toLowerCase(),
      directive.platformPostId ?? directive.sourceUrl,
      stale.batchSlug,
      stale.entityType ?? "company",
      stale.entityId,
      stale.attributionType ?? "subject"
    ].join(":");
    const previous = byTarget.get(key);
    if (!previous || (previous.disposition === "quarantined" && directive.disposition === "reattributed")) {
      byTarget.set(key, directive);
    }
  }
  return [...byTarget.values()].sort(compareReconciliationDirective);
}

function contentDuplicateReview(row, retained, identity, batchSlug) {
  const directive = batchSlug && (row?.entityId ?? row?.entity_id)
    ? {
        platform: String(row?.platform ?? "").toLowerCase(),
        sourceUrl: row?.sourceUrl ?? row?.source_url ?? null,
        platformPostId: row?.platformPostId ?? row?.platform_post_id ?? null,
        disposition: "quarantined",
        reason: CONTENT_DUPLICATE_REASON,
        staleAttribution: {
          batchSlug,
          entityType: row?.entityType ?? row?.entity_type ?? "company",
          entityId: row?.entityId ?? row?.entity_id,
          attributionType: row?.attributionType ?? row?.attribution_type ?? "subject"
        }
      }
    : null;
  return {
    id: `content-duplicate-${row.id ?? row.platformPostId ?? row.platform_post_id}`,
    batchSlug: batchSlug ?? null,
    entityType: row?.entityType ?? row?.entity_type ?? null,
    entityId: row?.entityId ?? row?.entity_id ?? null,
    entityName: row?.entityName ?? row?.companyName ?? null,
    companySlug: row?.companySlug ?? null,
    companyName: row?.companyName ?? null,
    platform: row?.platform ?? null,
    platformPostId: row?.platformPostId ?? row?.platform_post_id ?? null,
    candidateUrl: row?.sourceUrl ?? row?.source_url ?? null,
    sourceEvidenceId: row?.id ?? null,
    review_state: "needs_review",
    quarantineReasons: [CONTENT_DUPLICATE_REASON],
    duplicateEvidenceIdentity: {
      duplicateOfId: retained?.id ?? null,
      duplicateOfSourceUrl: retained?.sourceUrl ?? retained?.source_url ?? null,
      duplicateOfPlatformPostId: retained?.platformPostId ?? retained?.platform_post_id ?? null,
      contentBodySha256: identity.bodySha256
    },
    matchReason: `Quarantined during logged-in evidence finalization: ${CONTENT_DUPLICATE_REASON}.`,
    ...(directive ? { attributionReconciliationDirective: directive } : {})
  };
}

function dedupeNativePhysicalObservations(rows, options) {
  const byPhysicalAttribution = new Map();
  const ungrouped = [];

  for (const row of rows ?? []) {
    const physical = nativePhysicalIdentity(row);
    const entityId = row?.entityId ?? row?.entity_id;
    if (!physical || !entityId) {
      ungrouped.push(row);
      continue;
    }
    const key = [
      resolvedBatchSlug(row, options) ?? "unresolved-batch",
      row?.entityType ?? row?.entity_type ?? "company",
      entityId,
      physical
    ].join(":");
    byPhysicalAttribution.set(key, [...(byPhysicalAttribution.get(key) ?? []), row]);
  }

  return [
    ...ungrouped,
    ...[...byPhysicalAttribution.values()].map(strongestPhysicalObservation)
  ];
}

function resolveInstagramPrimaryPhysicalOwnership(rows, options) {
  const byPhysicalCompany = new Map();
  const ungrouped = [];

  for (const row of rows ?? []) {
    const entityType = row?.entityType ?? row?.entity_type;
    const companySlug = nonBlank(row?.companySlug ?? row?.company_slug);
    const physical = nativePhysicalIdentity(row);
    if (
      String(row?.platform ?? "").toLowerCase() !== "instagram" ||
      !["company", "founder"].includes(entityType) ||
      !companySlug ||
      !physical
    ) {
      ungrouped.push(row);
      continue;
    }
    const key = [
      resolvedBatchSlug(row, options) ?? "unresolved-batch",
      companySlug,
      physical
    ].join(":");
    byPhysicalCompany.set(key, [
      ...(byPhysicalCompany.get(key) ?? []),
      row
    ]);
  }

  const evidence = [...ungrouped];
  const needsReview = [];
  const attributionReconciliationLedger = [];

  for (const group of byPhysicalCompany.values()) {
    if (group.length < 2) {
      evidence.push(...group);
      continue;
    }

    const primaryHandles = new Set(
      group.map(instagramPrimaryAuthorHandle).filter(Boolean)
    );
    if (primaryHandles.size !== 1) {
      evidence.push(...group);
      continue;
    }

    const [primaryHandle] = primaryHandles;
    const primaryRows = group.filter(
      (row) => instagramAttributedAccountHandle(row) === primaryHandle
    );
    const primaryEntityIds = new Set(
      primaryRows
        .map((row) => row?.entityId ?? row?.entity_id)
        .filter(Boolean)
    );
    if (primaryRows.length !== 1 || primaryEntityIds.size !== 1) {
      evidence.push(...group);
      continue;
    }

    const alignedObservations = group.filter(
      instagramObservationMatchesCapturedMeta
    );
    const donor = strongestPhysicalObservation(
      alignedObservations.length ? alignedObservations : group
    );
    const retained = mergeInstagramPhysicalObservation(primaryRows[0], donor);
    evidence.push(retained);
    for (const stale of group) {
      if (
        (stale?.entityType ?? stale?.entity_type) ===
          (retained?.entityType ?? retained?.entity_type) &&
        (stale?.entityId ?? stale?.entity_id) ===
          (retained?.entityId ?? retained?.entity_id)
      ) {
        continue;
      }
      const review = instagramPrimaryOwnerReview(
        stale,
        retained,
        resolvedBatchSlug(stale, options),
        primaryHandle
      );
      needsReview.push(review);
      attributionReconciliationLedger.push(
        review.attributionReconciliationDirective
      );
    }
  }

  return { evidence, needsReview, attributionReconciliationLedger };
}

function instagramObservationMatchesCapturedMeta(row) {
  const payload = parseLoggedInVisiblePayload(
    row?.rawVisibleText ?? row?.raw_visible_text
  );
  return instagramDetailObservationMatchesMeta(payload?.detail);
}

function mergeInstagramPhysicalObservation(owner, donor) {
  if (!donor || donor === owner) return owner;
  const physicalFields = [
    "title",
    "text",
    "postedAt",
    "metrics",
    "contributionScore",
    "mediaUrls",
    "mediaUrl",
    "last_updated_at"
  ];
  const merged = { ...owner };
  for (const field of physicalFields) {
    if (donor[field] !== undefined && donor[field] !== null) {
      merged[field] = donor[field];
    }
  }

  const ownerPayload = parseLoggedInVisiblePayload(
    owner?.rawVisibleText ?? owner?.raw_visible_text
  );
  const donorPayload = parseLoggedInVisiblePayload(
    donor?.rawVisibleText ?? donor?.raw_visible_text
  );
  if (ownerPayload && donorPayload) {
    merged.rawVisibleText = JSON.stringify({
      ...ownerPayload,
      ...(donorPayload.gridUrl
        ? { gridUrl: donorPayload.gridUrl }
        : donorPayload.gridItem
          ? { gridItem: donorPayload.gridItem }
          : {}),
      ...(donorPayload.detail ? { detail: donorPayload.detail } : {})
    });
  }
  return merged;
}

function resolveFounderNativeAccountOwnership(rows, options) {
  const byOwnerPath = new Map();
  const ungrouped = [];

  for (const row of rows ?? []) {
    const entityType = row?.entityType ?? row?.entity_type;
    const companySlug = nonBlank(row?.companySlug ?? row?.company_slug);
    const physical = nativePhysicalIdentity(row);
    const account = nativeAccountIdentity(row);
    if (!["company", "founder"].includes(entityType) || !companySlug || !physical || !account) {
      ungrouped.push(row);
      continue;
    }
    const key = [
      resolvedBatchSlug(row, options) ?? "unresolved-batch",
      companySlug,
      physical,
      account
    ].join(":");
    byOwnerPath.set(key, [...(byOwnerPath.get(key) ?? []), row]);
  }

  const evidence = [...ungrouped];
  const needsReview = [];
  const attributionReconciliationLedger = [];

  for (const group of byOwnerPath.values()) {
    const founderRows = group.filter((row) => (row?.entityType ?? row?.entity_type) === "founder");
    const founderEntityIds = new Set(founderRows.map((row) => row?.entityId ?? row?.entity_id).filter(Boolean));
    const companyRows = group.filter((row) => (row?.entityType ?? row?.entity_type) === "company");

    // Multiple founders sharing one catalog account are ambiguous. Fail closed
    // instead of guessing which founder owns the native timeline.
    if (founderEntityIds.size > 1) {
      for (const row of group) {
        needsReview.push(
          ambiguousNativeOwnerReview(
            row,
            group,
            resolvedBatchSlug(row, options)
          )
        );
      }
      continue;
    }

    if (companyRows.length === 0 || founderEntityIds.size !== 1) {
      evidence.push(...group);
      continue;
    }

    const founder = strongestPhysicalObservation(founderRows);
    evidence.push(founder);
    for (const stale of companyRows) {
      const review = nativeOwnerReview(stale, founder, resolvedBatchSlug(stale, options));
      needsReview.push(review);
      attributionReconciliationLedger.push(review.attributionReconciliationDirective);
    }
  }

  return { evidence, needsReview, attributionReconciliationLedger };
}

function instagramPrimaryOwnerReview(
  stale,
  replacement,
  batchSlug,
  primaryHandle
) {
  const platformPostId =
    stale?.platformPostId ?? stale?.platform_post_id ?? null;
  const staleEntityType =
    stale?.entityType ?? stale?.entity_type ?? "company";
  const staleEntityId = stale?.entityId ?? stale?.entity_id;
  const replacementEntityType =
    replacement?.entityType ?? replacement?.entity_type ?? "company";
  const replacementEntityId =
    replacement?.entityId ?? replacement?.entity_id;
  const directive = {
    platform: "instagram",
    sourceUrl: stale?.sourceUrl ?? stale?.source_url ?? null,
    platformPostId,
    disposition: "reattributed",
    reason: INSTAGRAM_PRIMARY_OWNER_REASON,
    staleAttribution: {
      batchSlug,
      entityType: staleEntityType,
      entityId: staleEntityId,
      attributionType:
        stale?.attributionType ?? stale?.attribution_type ?? "subject"
    },
    replacementAttribution: {
      batchSlug,
      entityType: replacementEntityType,
      entityId: replacementEntityId,
      attributionType:
        replacement?.attributionType ??
        replacement?.attribution_type ??
        "subject"
    }
  };
  return {
    id: [
      "instagram-primary-owner",
      platformPostId ?? "unknown-post",
      staleEntityId ?? "unknown-entity"
    ].join("-"),
    batchSlug,
    entityType: staleEntityType,
    entityId: staleEntityId,
    entityName: stale?.entityName ?? stale?.companyName ?? null,
    companySlug: stale?.companySlug ?? null,
    companyName: stale?.companyName ?? null,
    platform: "instagram",
    platformPostId,
    candidateUrl: stale?.sourceUrl ?? stale?.source_url ?? null,
    sourceEvidenceId: stale?.id ?? null,
    review_state: "needs_review",
    quarantineReasons: [INSTAGRAM_PRIMARY_OWNER_REASON],
    duplicateEvidenceIdentity: {
      duplicateOfId: replacement?.id ?? null,
      duplicateOfSourceUrl:
        replacement?.sourceUrl ?? replacement?.source_url ?? null,
      duplicateOfPlatformPostId:
        replacement?.platformPostId ??
        replacement?.platform_post_id ??
        null
    },
    instagramPrimaryOwner: {
      handle: primaryHandle,
      evidence: "captured_post_permalink_or_description"
    },
    matchReason:
      `Reattributed during logged-in evidence finalization: ${INSTAGRAM_PRIMARY_OWNER_REASON}.`,
    attributionReconciliationDirective: directive
  };
}

function ambiguousNativeOwnerReview(row, group, batchSlug) {
  const platform = String(row?.platform ?? "").toLowerCase();
  const platformPostId =
    row?.platformPostId ?? row?.platform_post_id ?? null;
  const entityId = row?.entityId ?? row?.entity_id ?? null;
  const accountIdentity = nativeAccountIdentity(row);
  const entityIds = [
    ...new Set(
      group
        .map((candidate) => candidate?.entityId ?? candidate?.entity_id)
        .filter(Boolean)
    )
  ].sort();
  return {
    id: [
      "ambiguous-native-owner",
      platform || "unknown-platform",
      platformPostId ?? "unknown-post",
      entityId ?? "unknown-entity"
    ].join("-"),
    batchSlug,
    entityType: row?.entityType ?? row?.entity_type ?? null,
    entityId,
    entityName: row?.entityName ?? row?.companyName ?? null,
    companySlug: row?.companySlug ?? row?.company_slug ?? null,
    companyName: row?.companyName ?? null,
    platform,
    platformPostId,
    candidateUrl: row?.sourceUrl ?? row?.source_url ?? null,
    sourceEvidenceId: row?.id ?? null,
    review_state: "needs_review",
    quarantineReasons: [AMBIGUOUS_NATIVE_OWNER_REASON],
    matchReason:
      "Quarantined during logged-in evidence finalization because one native account path and physical post mapped to multiple founders.",
    nativeAccountOwnerCollision: {
      accountIdentity,
      entityIds,
      sourceEvidenceIds: group.map((candidate) => candidate?.id).filter(Boolean)
    }
  };
}

function nativeOwnerReview(stale, replacement, batchSlug) {
  const platform = String(stale?.platform ?? "").toLowerCase();
  const platformPostId = stale?.platformPostId ?? stale?.platform_post_id ?? null;
  const staleEntityId = stale?.entityId ?? stale?.entity_id;
  const replacementEntityId = replacement?.entityId ?? replacement?.entity_id;
  const directive = {
    platform,
    sourceUrl: stale?.sourceUrl ?? stale?.source_url ?? null,
    platformPostId,
    disposition: "reattributed",
    reason: NATIVE_OWNER_FOUNDER_REASON,
    staleAttribution: {
      batchSlug,
      entityType: "company",
      entityId: staleEntityId,
      attributionType: stale?.attributionType ?? stale?.attribution_type ?? "subject"
    },
    replacementAttribution: {
      batchSlug,
      entityType: "founder",
      entityId: replacementEntityId,
      attributionType: replacement?.attributionType ?? replacement?.attribution_type ?? "subject"
    }
  };
  return {
    id: `native-owner-${platform}-${platformPostId}-${staleEntityId}`,
    batchSlug,
    entityType: "company",
    entityId: staleEntityId,
    entityName: stale?.entityName ?? stale?.companyName ?? null,
    companySlug: stale?.companySlug ?? null,
    companyName: stale?.companyName ?? null,
    platform,
    platformPostId,
    candidateUrl: stale?.sourceUrl ?? stale?.source_url ?? null,
    sourceEvidenceId: stale?.id ?? null,
    review_state: "needs_review",
    quarantineReasons: [NATIVE_OWNER_FOUNDER_REASON],
    duplicateEvidenceIdentity: {
      duplicateOfId: replacement?.id ?? null,
      duplicateOfSourceUrl: replacement?.sourceUrl ?? replacement?.source_url ?? null,
      duplicateOfPlatformPostId: replacement?.platformPostId ?? replacement?.platform_post_id ?? null
    },
    matchReason:
      `Reattributed during logged-in evidence finalization: ${NATIVE_OWNER_FOUNDER_REASON}.`,
    attributionReconciliationDirective: directive
  };
}

function strongestPhysicalObservation(rows) {
  return [...rows].sort(comparePhysicalObservationPreference)[0];
}

function comparePhysicalObservationPreference(left, right) {
  const ranked = [
    verifiedObservation(left) - verifiedObservation(right),
    explicitUrlIdentityAgreement(left) - explicitUrlIdentityAgreement(right),
    positiveMetricCount(left) - positiveMetricCount(right),
    observationFreshness(left) - observationFreshness(right),
    observationRichness(left) - observationRichness(right)
  ];
  for (const difference of ranked) {
    if (difference) return difference > 0 ? -1 : 1;
  }
  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function verifiedObservation(row) {
  return row?.review_state === "verified" ? 1 : 0;
}

function explicitUrlIdentityAgreement(row) {
  const explicit = normalizedNativePostId(row?.platform, row?.platformPostId ?? row?.platform_post_id);
  const fromUrl = nativePostIdFromUrl(row?.platform, row?.sourceUrl ?? row?.source_url);
  return explicit && fromUrl && explicit === fromUrl ? 1 : 0;
}

function positiveMetricCount(row) {
  return Object.values(row?.metrics ?? {}).filter((value) => Number(value) > 0).length;
}

function observationFreshness(row) {
  for (const value of [
    row?.last_checked_at,
    row?.checkedAt,
    row?.last_updated_at,
    row?.first_seen_at
  ]) {
    const timestamp = Date.parse(value ?? "");
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function observationRichness(row) {
  return [
    nonBlank(row?.accountUrl) ? 1 : 0,
    nonBlank(row?.authorHandle) || nonBlank(row?.authorName) ? 1 : 0,
    Array.isArray(row?.mediaUrls) ? row.mediaUrls.length : 0,
    String(row?.rawVisibleText ?? "").length,
    String(row?.text ?? "").length
  ].reduce((total, value) => total + value, 0);
}

function nativePhysicalIdentity(row) {
  const platform = String(row?.platform ?? "").toLowerCase();
  const explicit = normalizedNativePostId(platform, row?.platformPostId ?? row?.platform_post_id);
  if (!explicit) return null;
  const fromUrl = nativePostIdFromUrl(platform, row?.sourceUrl ?? row?.source_url);
  if (fromUrl && fromUrl !== explicit) return null;
  return `${platform}:post:${explicit}`;
}

function normalizedNativePostId(platform, value) {
  const supplied = nonBlank(value);
  if (!supplied) return null;
  const normalizedPlatform = String(platform ?? "").toLowerCase();
  if (["x", "tiktok"].includes(normalizedPlatform)) {
    return /^\d+$/.test(supplied) ? supplied : null;
  }
  if (normalizedPlatform === "linkedin") {
    return supplied.match(/(?:activity[-:]|urn:li:activity:)?(\d+)$/i)?.[1] ?? null;
  }
  if (normalizedPlatform === "instagram") {
    return /^[A-Za-z0-9_-]+$/.test(supplied) ? supplied : null;
  }
  if (normalizedPlatform === "bluesky") {
    return supplied;
  }
  return null;
}

function nativePostIdFromUrl(platform, value) {
  const sourceUrl = nonBlank(value);
  if (!sourceUrl) return null;
  try {
    const url = new URL(sourceUrl);
    const normalizedPlatform = String(platform ?? "").toLowerCase();
    if (normalizedPlatform === "x") {
      if (!["x.com", "twitter.com", "mobile.twitter.com"].includes(url.hostname.toLowerCase())) return null;
      return url.pathname.match(/^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/(\d+)/i)?.[1] ?? null;
    }
    if (normalizedPlatform === "instagram") {
      if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return null;
      return url.pathname.match(/^\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i)?.[1] ?? null;
    }
    if (normalizedPlatform === "linkedin") {
      if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
      return (
        url.pathname.match(/^\/feed\/update\/urn:li:activity:(\d+)/i)?.[1] ??
        url.pathname.match(/activity[-:](\d+)/i)?.[1] ??
        null
      );
    }
    if (normalizedPlatform === "tiktok") {
      if (!/(^|\.)tiktok\.com$/i.test(url.hostname)) return null;
      return url.pathname.match(/^\/@[A-Za-z0-9._-]+\/video\/(\d+)/i)?.[1] ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

function nativeAccountIdentity(row) {
  const rawUrl = nonBlank(row?.accountUrl ?? row?.account_url);
  if (rawUrl) return canonicalNativeAccountUrl(row?.platform, rawUrl);
  if (!hasNativeTimelineProvenance(row)) return null;
  const platform = String(row?.platform ?? "").toLowerCase();
  const sourceUrl = nonBlank(row?.sourceUrl ?? row?.source_url);
  if (platform !== "x" || !sourceUrl) return null;
  try {
    const url = new URL(sourceUrl);
    if (!["x.com", "twitter.com", "mobile.twitter.com"].includes(url.hostname.toLowerCase())) return null;
    const handle = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/\d+/i)?.[1];
    return handle ? `x:https://x.com/${handle.toLowerCase()}` : null;
  } catch {
    return null;
  }
}

function instagramPrimaryAuthorHandle(row) {
  const raw = parseLoggedInVisiblePayload(row?.rawVisibleText);
  if (!raw) return null;
  const handles = new Set();
  const permalinkHandle = instagramProfileScopedPostHandle(
    raw?.gridUrl?.rawHref
  );
  if (permalinkHandle) handles.add(permalinkHandle);
  const descriptionHandle = instagramDescriptionAuthorHandle(
    raw?.detail?.description
  );
  if (descriptionHandle) handles.add(descriptionHandle);
  return handles.size === 1 ? [...handles][0] : null;
}

function instagramAttributedAccountHandle(row) {
  const accountUrl = nonBlank(row?.accountUrl ?? row?.account_url);
  if (!accountUrl) return null;
  try {
    const url = new URL(accountUrl);
    if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return null;
    return normalizeInstagramHandle(
      url.pathname.split("/").filter(Boolean)[0]
    );
  } catch {
    return null;
  }
}

function instagramProfileScopedPostHandle(value) {
  const rawUrl = nonBlank(value);
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(
      /^\/([A-Za-z0-9._]+)\/(?:p|reel|tv)\/[A-Za-z0-9_-]+/i
    );
    return normalizeInstagramHandle(match?.[1]);
  } catch {
    return null;
  }
}

function instagramDescriptionAuthorHandle(value) {
  const description = nonBlank(value);
  if (!description) return null;
  return normalizeInstagramHandle(
    description.match(
      /\s-\s+([A-Za-z0-9._]+)\s+on\s+[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4}\s*:/u
    )?.[1]
  );
}

function normalizeInstagramHandle(value) {
  const handle = nonBlank(value)?.replace(/^@/, "").toLowerCase();
  return handle && /^[a-z0-9._]+$/.test(handle) ? handle : null;
}

function canonicalNativeAccountUrl(platform, value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.hostname === "twitter.com" || url.hostname === "mobile.twitter.com") {
      url.hostname = "x.com";
    }
    url.pathname = url.pathname.replace(/\/+$/, "").toLowerCase();
    return `${String(platform ?? "").toLowerCase()}:${url.toString()}`;
  } catch {
    return null;
  }
}

function hasNativeTimelineProvenance(row) {
  return /\b(?:authenticated read-only x adapter timeline collection|read-only x browser timeline scrape)\b/i
    .test(String(row?.matchReason ?? ""));
}

function resolvedBatchSlug(row, { defaultBatchSlug = null, resolveBatchSlug = null } = {}) {
  return row?.batchSlug ?? row?.batch_slug ??
    (typeof resolveBatchSlug === "function" ? resolveBatchSlug(row) : null) ??
    defaultBatchSlug;
}

function nonBlank(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function loggedInContentIdentity(row) {
  // The logged-in store still contains legacy profile-fragment observations.
  // Content retirement is allowed only for rows with an explicit native item
  // identity; profile fragments remain outside this physical-post dedupe lane.
  if (!(row?.platformPostId ?? row?.platform_post_id)) return null;
  const raw = parseLoggedInVisiblePayload(row?.rawVisibleText);
  return sourceContentIdentity({
    platform: row?.platform,
    authorName: row?.authorName ?? row?.voiceName ?? raw?.post?.authorName ??
      raw?.profile?.name ?? raw?.name ?? raw?.author?.name,
    authorHandle: row?.authorHandle ?? raw?.post?.authorHandle ?? raw?.profile?.username ??
      raw?.author?.handle ?? raw?.author?.username ?? raw?.author?.screen_name ??
      (typeof raw?.author === "string" ? raw.author : null),
    authorUrl: row?.authorUrl ?? raw?.profile?.url ?? raw?.author?.url,
    accountUrl: row?.accountUrl,
    sourceUrl: row?.sourceUrl,
    fallbackAuthorName: row?.entityName ?? row?.companyName,
    body: row?.text,
    postedAt: row?.postedAt
  });
}

function parseLoggedInVisiblePayload(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function compareLoggedInContentPreference(left, right) {
  const leftPlatform = String(left?.platform ?? "").toLowerCase();
  const rightPlatform = String(right?.platform ?? "").toLowerCase();
  const platformDifference = leftPlatform.localeCompare(rightPlatform);
  if (platformDifference) return platformDifference;
  const leftEntity = `${left?.entityType ?? left?.entity_type ?? "company"}:${left?.entityId ?? left?.entity_id ?? left?.companySlug ?? ""}`;
  const rightEntity = `${right?.entityType ?? right?.entity_type ?? "company"}:${right?.entityId ?? right?.entity_id ?? right?.companySlug ?? ""}`;
  const entityDifference = leftEntity.localeCompare(rightEntity);
  if (entityDifference) return entityDifference;
  const leftId = String(left?.platformPostId ?? left?.platform_post_id ?? "");
  const rightId = String(right?.platformPostId ?? right?.platform_post_id ?? "");
  if (leftPlatform === "x" &&
      /^\d+$/.test(leftId) && /^\d+$/.test(rightId)) {
    if (BigInt(leftId) < BigInt(rightId)) return -1;
    if (BigInt(leftId) > BigInt(rightId)) return 1;
  }
  const leftSeen = Date.parse(left?.first_seen_at ?? "");
  const rightSeen = Date.parse(right?.first_seen_at ?? "");
  if (Number.isFinite(leftSeen) !== Number.isFinite(rightSeen)) return Number.isFinite(leftSeen) ? -1 : 1;
  if (Number.isFinite(leftSeen) && leftSeen !== rightSeen) return leftSeen - rightSeen;
  return String(left?.id ?? leftId).localeCompare(String(right?.id ?? rightId));
}

function dedupeRowsById(rows) {
  const byId = new Map();
  for (const row of rows ?? []) {
    if (row?.id) byId.set(row.id, row);
  }
  return [...byId.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function compareReconciliationDirective(left, right) {
  return String(left.platform).localeCompare(String(right.platform)) ||
    String(left.platformPostId ?? left.sourceUrl).localeCompare(String(right.platformPostId ?? right.sourceUrl)) ||
    String(left.staleAttribution?.batchSlug).localeCompare(String(right.staleAttribution?.batchSlug)) ||
    String(left.staleAttribution?.entityId).localeCompare(String(right.staleAttribution?.entityId));
}
