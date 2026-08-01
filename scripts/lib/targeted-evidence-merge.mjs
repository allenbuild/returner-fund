import { isListOrRoundupAttributionContext } from "./public-evidence-attribution.mjs";

const VALID_BATCH_SLUGS = new Set(["S2026", "S26", "A16ZSR006"]);
const TOP_VOICE_X_METRICS = new Set(["views", "likes", "replies", "reposts", "quotes", "saves"]);
export const TARGETED_HISTORICAL_ATTRIBUTION_RECONCILIATIONS_V1 = Object.freeze([
  historicalReconciliation({
    platform: "github",
    platformPostId: "CarbonCopyInc/carboncopy-mcp",
    staleEntityId: "company-blueprints",
    replacementEntityId: "company-hoplite",
    replacementCompanySlug: "hoplite",
    replacementCompanyName: "Hoplite",
    reason: "targeted_historical_reconciliation_v1:blueprints_to_hoplite"
  }),
  historicalReconciliation({
    platform: "github",
    platformPostId: "UseBylaw/typescript-sdk",
    staleEntityId: "company-bylaw",
    replacementEntityId: "company-definite",
    replacementCompanySlug: "definite",
    replacementCompanyName: "Definite",
    reason: "targeted_historical_reconciliation_v1:bylaw_to_definite"
  }),
  historicalReconciliation({
    platform: "linkedin",
    platformPostId: "7467251847137939459",
    staleEntityId: "company-vestris",
    replacementEntityType: "founder",
    replacementEntityId: "founder-vestris-aahil-valliani-verified-aahil-valliani",
    replacementEntityName: "Aahil Valliani",
    replacementCompanySlug: "vestris",
    replacementCompanyName: "Vestris",
    replacementAttachedCompanyId: "company-vestris",
    reason: "targeted_historical_reconciliation_v1:vestris_company_to_aahil_valliani"
  }),
  historicalReconciliation({
    platform: "linkedin",
    platformPostId: "7467271346683801600",
    staleEntityId: "company-vestris",
    replacementEntityType: "founder",
    replacementEntityId: "founder-vestris-joshua-tang-verified-joshua-tang",
    replacementEntityName: "Joshua Tang",
    replacementCompanySlug: "vestris",
    replacementCompanyName: "Vestris",
    replacementAttachedCompanyId: "company-vestris",
    reason: "targeted_historical_reconciliation_v1:vestris_company_to_joshua_tang"
  }),
  historicalReconciliation({
    platform: "x",
    platformPostId: "2076784195847008510",
    staleEntityId: "company-notyfi",
    replacementEntityId: "company-perceptron-ml",
    replacementEntityName: "Perceptron ML",
    replacementCompanySlug: "perceptron-ml",
    replacementCompanyName: "Perceptron ML",
    reason: "targeted_historical_reconciliation_v1:notyfi_to_perceptron_ml"
  }),
  historicalReconciliation({
    platform: "x",
    platformPostId: "2076105028398461223",
    staleEntityId: "company-truffle",
    replacementEntityId: "company-joinmarble",
    replacementEntityName: "Marble",
    replacementCompanySlug: "joinmarble",
    replacementCompanyName: "Marble",
    reason: "targeted_historical_reconciliation_v1:truffle_to_marble"
  })
]);

export const TARGETED_HISTORICAL_OWNER_PRESERVATIONS_V1 = Object.freeze([
  "2070249380159082981",
  "2071874544202404180",
  "2070648435456540856",
  "2076581927717642379"
].map((platformPostId) => historicalOwnerPreservation({
  platform: "x",
  platformPostId,
  entityId: "founder-mireye-shashwat-kapoor-678147",
  entityName: "Shashwat Kapoor",
  companySlug: "mireye",
  companyName: "Mireye",
  expectedAuthorHandle: "shshwt_",
  accountUrl: "https://x.com/shshwt_",
  reason: "targeted_historical_owner_v1:mireye_retired_founder_shashwat_kapoor"
})));

const TARGETED_HISTORICAL_ACTIONS_V1 = Object.freeze([
  ...TARGETED_HISTORICAL_ATTRIBUTION_RECONCILIATIONS_V1,
  ...TARGETED_HISTORICAL_OWNER_PRESERVATIONS_V1
]);

const TARGETED_HISTORICAL_ATTRIBUTION_BY_KEY = new Map(
  TARGETED_HISTORICAL_ACTIONS_V1.map((entry) => [
    historicalReconciliationKey(entry),
    entry
  ])
);
const TARGETED_HISTORICAL_ATTRIBUTION_BY_UNSCOPED_KEY = uniqueHistoricalReconciliationIndex(
  TARGETED_HISTORICAL_ACTIONS_V1,
  historicalReconciliationUnscopedKey
);

/**
 * Merge rebased repository state, pre-rebase local state, and the isolated
 * evidence produced by this Top Voice run. Only the isolated run is treated as
 * untrusted input; legacy repository rows are preserved unless their native URL
 * and explicit post ID contradict one another.
 */
export function mergeTargetedEvidenceSnapshots(
  existingSnapshots,
  isolatedRunSnapshot,
  {
    resolveBatchSlug = null,
    resolveEntityAttribution = null,
    validateEntityAttribution = null,
    mergedAt = new Date().toISOString()
  } = {}
) {
  const existing = (existingSnapshots ?? []).filter(isSnapshot);
  if (!isSnapshot(isolatedRunSnapshot)) {
    throw new Error("Top Voice publication requires an isolated evidence snapshot with an evidence array.");
  }

  const evidenceByKey = new Map();
  const quarantines = [];
  const reattributions = [];
  let duplicateRows = 0;
  let acceptedRunRows = 0;

  const accept = (row, { strictRun = false, ordinal = 0 } = {}) => {
    const staleBatchSlug = resolveBatchSlug ? resolveBatchSlug(row) : explicitBatchSlug(row);
    const reconciliation = targetedHistoricalAttributionReconciliation(row, staleBatchSlug);
    const preservesRetiredHistoricalOwner = reconciliation?.action === "preserve_historical_owner";
    const historicalCandidateRow = reconciliation
      ? applyTargetedHistoricalAttributionReconciliation(row, reconciliation)
      : row;
    const historicalBatchSlug = resolveBatchSlug
      ? resolveBatchSlug(historicalCandidateRow)
      : explicitBatchSlug(historicalCandidateRow);
    const entityResolution = !preservesRetiredHistoricalOwner && typeof resolveEntityAttribution === "function"
      ? resolveEntityAttribution(historicalCandidateRow, historicalBatchSlug)
      : null;
    const candidateRow = entityResolution?.rejected
      ? historicalCandidateRow
      : entityResolution?.row ?? historicalCandidateRow;
    const batchSlug = resolveBatchSlug ? resolveBatchSlug(candidateRow) : explicitBatchSlug(candidateRow);
    const scopedRow = withTargetedBatch(candidateRow, batchSlug);
    const identity = physicalPostIdentity(scopedRow);
    const reasons = entityResolution?.rejected
      ? [entityResolution.reason]
      : strictRun
        ? validateIsolatedTopVoiceRow(
            scopedRow,
            batchSlug,
            identity,
            resolveBatchSlug,
            validateEntityAttribution
          )
        : validateLegacyTargetedRow(
            scopedRow,
            batchSlug,
            identity,
            preservesRetiredHistoricalOwner ? null : validateEntityAttribution
          );

    if (reasons.length > 0) {
      quarantines.push(quarantineRow(scopedRow, batchSlug, reasons, ordinal));
      return;
    }

    const key = evidenceIdentityKey(scopedRow, batchSlug, identity.value);
    const previous = evidenceByKey.get(key);
    if (!previous) {
      evidenceByKey.set(key, scopedRow);
    } else {
      duplicateRows += 1;
      evidenceByKey.set(key, fresherEvidence(previous, scopedRow));
    }
    if (reconciliation && !preservesRetiredHistoricalOwner) {
      reattributions.push(targetedHistoricalReconciliationDirective(row, scopedRow, reconciliation));
    } else if (entityResolution?.changedTarget) {
      reattributions.push(targetedCanonicalReconciliationDirective(
        row,
        scopedRow,
        staleBatchSlug,
        entityResolution.reason
      ));
    }
    if (strictRun) acceptedRunRows += 1;
  };

  let ordinal = 0;
  for (const snapshot of existing) {
    for (const row of snapshot.evidence) accept(row, { ordinal: ordinal++ });
  }
  for (const row of isolatedRunSnapshot.evidence) {
    accept(row, { strictRun: true, ordinal: ordinal++ });
  }

  const existingReviews = existing.flatMap((snapshot) => snapshot.needsReview ?? []);
  const runReviews = isolatedRunSnapshot.needsReview ?? [];
  const uniqueQuarantines = dedupeReviewRows(quarantines, resolveBatchSlug);
  const needsReview = dedupeReviewRows(
    [...existingReviews, ...runReviews, ...uniqueQuarantines],
    resolveBatchSlug
  );
  const attributionReconciliationLedger = targetedAttributionReconciliationLedger([
    ...existing.flatMap((snapshot) => snapshot.attributionReconciliationLedger ?? []),
    ...(isolatedRunSnapshot.attributionReconciliationLedger ?? []),
    ...existingReviews.map((row) => row.attributionReconciliationDirective),
    ...runReviews.map((row) => row.attributionReconciliationDirective),
    ...uniqueQuarantines.map((row) => row.attributionReconciliationDirective),
    ...reattributions
  ]);
  const evidence = [...evidenceByKey.values()].sort(compareEvidence);
  const reasonCounts = countQuarantineReasons(uniqueQuarantines);
  const allSnapshots = [...existing, isolatedRunSnapshot];

  return {
    source: {
      ...existing.at(-1)?.source,
      label: existing.at(-1)?.source?.label ?? "Targeted long-run public evidence",
      fetchedAt: freshestIso(allSnapshots.map((snapshot) => snapshot.source?.fetchedAt), mergedAt),
      notes: uniqueStrings([
        ...existing.flatMap((snapshot) => snapshot.source?.notes ?? []),
        ...(isolatedRunSnapshot.source?.notes ?? []),
        "Autonomous Top Voice rows are captured in an isolated run artifact and semantically merged after publication rebase."
      ]),
      targetedMergeAudit: {
        mergedAt,
        existingSnapshots: existing.length,
        existingInputRows: existing.reduce((total, snapshot) => total + snapshot.evidence.length, 0),
        isolatedRunInputRows: isolatedRunSnapshot.evidence.length,
        acceptedRunRows,
        duplicateRows,
        quarantinedRows: uniqueQuarantines.length,
        canonicalReattributedRows: attributionReconciliationLedger.filter(
          (row) => row.disposition === "reattributed"
        ).length,
        quarantineReasonCounts: reasonCounts,
        attributionReconciliationCount: attributionReconciliationLedger.length,
        outputEvidenceRows: evidence.length,
        outputNeedsReviewRows: needsReview.length
      }
    },
    evidence,
    needsReview,
    attributionReconciliationLedger
  };
}

export function physicalPostIdentity(row) {
  const platform = String(row?.platform ?? "").toLowerCase();
  const explicit = normalizePostId(row?.platformPostId ?? row?.platform_post_id);
  const native = nativePostIdentity(platform, row?.sourceUrl ?? row?.source_url);
  return {
    value: native?.postId ?? explicit ?? canonicalUrl(row?.sourceUrl ?? row?.source_url) ?? `row:${row?.id ?? "unknown"}`,
    native,
    explicit,
    // The autonomous isolated lane currently emits X rows. Other platforms can
    // legitimately use an explicit child/comment ID while their URL path names
    // the parent post, so only X has a strict one-ID URL grammar here.
    conflict: platform === "x" && Boolean(native?.postId && explicit && native.postId !== explicit)
  };
}

function validateIsolatedTopVoiceRow(
  row,
  batchSlug,
  identity,
  resolveBatchSlug,
  validateEntityAttribution
) {
  const reasons = [];
  if (!batchSlug || !VALID_BATCH_SLUGS.has(batchSlug)) reasons.push("missing_or_invalid_batch_scope");
  if (!["company", "founder"].includes(row?.entityType) || !nonempty(row?.entityId) || !nonempty(row?.companyName)) {
    reasons.push("invalid_entity_attribution");
  }
  if (resolveBatchSlug && batchSlug && resolveBatchSlug(row) !== batchSlug) {
    reasons.push("batch_entity_attribution_mismatch");
  }
  if (validateEntityAttribution && batchSlug && !validateEntityAttribution(row, batchSlug)) {
    reasons.push("entity_not_in_canonical_batch_catalog");
  }
  if (row?.platform !== "x") reasons.push("unsupported_top_voice_platform");
  if (!identity.native || identity.native.platform !== "x") reasons.push("invalid_native_x_post_url");
  if (!identity.explicit) reasons.push("missing_platform_post_id");
  if (identity.conflict) reasons.push("native_url_platform_post_id_conflict");
  if (row?.review_state !== "verified" || row?.linkStatus !== "verified") {
    reasons.push("unverified_post_level_evidence");
  }

  const metricReason = visibleMetricFailure(row?.metrics);
  if (metricReason) reasons.push(metricReason);

  const raw = parseJsonObject(row?.rawVisibleText);
  const rawPostId = normalizePostId(raw?.post?.id);
  if (!raw || !["live_x_profile", "live_x_top_voice_profile"].includes(raw.source)) {
    reasons.push("invalid_live_source_provenance");
  }
  if (!rawPostId || rawPostId !== identity.explicit || rawPostId !== identity.native?.postId) {
    reasons.push("raw_post_id_mismatch");
  }
  if (raw?.profile?.batchSlug !== batchSlug) reasons.push("raw_batch_scope_mismatch");
  return [...new Set(reasons)];
}

function validateLegacyTargetedRow(row, batchSlug, identity, validateEntityAttribution) {
  const reasons = [];
  if (!batchSlug || !VALID_BATCH_SLUGS.has(batchSlug)) reasons.push("missing_or_invalid_batch_scope");
  if (identity.conflict) reasons.push("native_url_platform_post_id_conflict");
  if (validateEntityAttribution && batchSlug && !validateEntityAttribution(row, batchSlug)) {
    reasons.push("entity_not_in_canonical_batch_catalog");
  }
  reasons.push(...legacyTargetedAttributionReasons(row, batchSlug));
  return [...new Set(reasons)];
}

function legacyTargetedAttributionReasons(row, batchSlug) {
  if (String(row?.platform ?? "").toLowerCase() !== "linkedin") return [];
  return isListOrRoundupAttributionContext(batchSlug, targetedAttributionText(row))
    ? ["third_party_cohort_roundup_list_entry_only"]
    : [];
}

function historicalReconciliation({
  platform,
  platformPostId,
  staleEntityId,
  replacementEntityId,
  replacementEntityType = "company",
  replacementEntityName = null,
  replacementCompanySlug,
  replacementCompanyName,
  replacementAttachedCompanyId = replacementEntityId,
  reason
}) {
  return Object.freeze({
    version: 1,
    action: "reattribute",
    platform,
    platformPostId,
    staleAttribution: Object.freeze({
      batchSlug: "S26",
      entityType: "company",
      entityId: staleEntityId
    }),
    replacementAttribution: Object.freeze({
      batchSlug: "S26",
      entityType: replacementEntityType,
      entityId: replacementEntityId,
      entityName: replacementEntityName,
      companySlug: replacementCompanySlug,
      companyName: replacementCompanyName,
      attachedCompanyId: replacementAttachedCompanyId
    }),
    reason
  });
}

function historicalOwnerPreservation({
  platform,
  platformPostId,
  entityId,
  entityName,
  companySlug,
  companyName,
  expectedAuthorHandle,
  accountUrl,
  reason
}) {
  return Object.freeze({
    version: 1,
    action: "preserve_historical_owner",
    platform,
    platformPostId,
    staleAttribution: Object.freeze({
      batchSlug: "S26",
      entityType: "founder",
      entityId
    }),
    historicalOwner: Object.freeze({
      status: "retired_founder",
      currentRosterMember: false,
      entityType: "founder",
      entityId,
      entityName,
      companySlug,
      companyName,
      expectedAuthorHandle,
      accountUrl
    }),
    reason
  });
}

function targetedHistoricalAttributionReconciliation(row, batchSlug) {
  const nativePostId = exactHistoricalNativePostId(row);
  if (!nativePostId) return null;
  const partial = {
    platform: String(row?.platform ?? "").toLowerCase(),
    platformPostId: nativePostId,
    staleAttribution: {
      batchSlug,
      entityType: row?.entityType ?? row?.entity_type ?? "company",
      entityId: row?.entityId ?? row?.entity_id
    }
  };
  const reconciliation = (batchSlug
    ? TARGETED_HISTORICAL_ATTRIBUTION_BY_KEY.get(historicalReconciliationKey(partial))
    : TARGETED_HISTORICAL_ATTRIBUTION_BY_UNSCOPED_KEY.get(
        historicalReconciliationUnscopedKey(partial)
      )) ?? null;
  return reconciliation?.action === "preserve_historical_owner" &&
    !historicalOwnerSignalsMatch(row, reconciliation.historicalOwner)
    ? null
    : reconciliation;
}

function historicalReconciliationKey(entry) {
  const stale = entry.staleAttribution;
  return [
    String(entry.platform ?? "").toLowerCase(),
    String(entry.platformPostId ?? "").toLowerCase(),
    stale?.batchSlug ?? "",
    stale?.entityType ?? "",
    stale?.entityId ?? ""
  ].join(":");
}

function historicalReconciliationUnscopedKey(entry) {
  const stale = entry.staleAttribution;
  return [
    String(entry.platform ?? "").toLowerCase(),
    String(entry.platformPostId ?? "").toLowerCase(),
    stale?.entityType ?? "",
    stale?.entityId ?? ""
  ].join(":");
}

function uniqueHistoricalReconciliationIndex(entries, keyFor) {
  const index = new Map();
  const ambiguous = new Set();
  for (const entry of entries) {
    const key = keyFor(entry);
    if (index.has(key)) ambiguous.add(key);
    else index.set(key, entry);
  }
  for (const key of ambiguous) index.delete(key);
  return index;
}

function exactHistoricalNativePostId(row) {
  const platform = String(row?.platform ?? "").toLowerCase();
  const explicit = normalizePostId(row?.platformPostId ?? row?.platform_post_id);
  const native = nativePostIdentity(platform, row?.sourceUrl ?? row?.source_url)?.postId ??
    (platform === "github" ? nativeGithubRepositoryIdentity(row?.sourceUrl ?? row?.source_url) : null);
  if (!native || (explicit && explicit.toLowerCase() !== native.toLowerCase())) return null;
  return native;
}

function historicalOwnerSignalsMatch(row, historicalOwner) {
  const expected = normalizeHistoricalHandle(historicalOwner?.expectedAuthorHandle);
  if (!expected) return false;
  const raw = parseJsonObject(row?.rawVisibleText);
  const handles = new Set([
    historicalXAuthorFromUrl(row?.sourceUrl ?? row?.source_url),
    historicalXAuthorFromUrl(row?.accountUrl ?? row?.account_url),
    row?.authorHandle,
    row?.author_handle,
    raw?.profile?.username,
    raw?.profile?.handle,
    raw?.post?.authorHandle,
    raw?.post?.author_handle
  ].map(normalizeHistoricalHandle).filter(Boolean));
  return handles.size === 1 && handles.has(expected);
}

function historicalXAuthorFromUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (!["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) return null;
    const handle = decodeURIComponent(url.pathname).split("/").filter(Boolean)[0];
    return handle?.toLowerCase() === "i" ? null : handle;
  } catch {
    return null;
  }
}

function normalizeHistoricalHandle(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/^@/, "").toLowerCase() || null;
}

function nativeGithubRepositoryIdentity(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    if (url.hostname.replace(/^www\./, "").toLowerCase() !== "github.com") return null;
    return decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "").match(/^([^/]+\/[^/]+)$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function applyTargetedHistoricalAttributionReconciliation(row, reconciliation) {
  if (reconciliation.action === "preserve_historical_owner") {
    const historicalOwner = reconciliation.historicalOwner;
    return {
      ...row,
      batchSlug: "S26",
      entityType: historicalOwner.entityType,
      entityId: historicalOwner.entityId,
      entityName: historicalOwner.entityName,
      companySlug: historicalOwner.companySlug,
      companyName: historicalOwner.companyName,
      attachedCompanyId: `company-${historicalOwner.companySlug}`,
      historicalOwner: {
        status: historicalOwner.status,
        currentRosterMember: historicalOwner.currentRosterMember,
        entityType: historicalOwner.entityType,
        entityId: historicalOwner.entityId,
        entityName: historicalOwner.entityName,
        companySlug: historicalOwner.companySlug,
        companyName: historicalOwner.companyName,
        platform: reconciliation.platform,
        accountUrl: historicalOwner.accountUrl
      },
      historicalAttributionReason: reconciliation.reason
    };
  }
  const replacement = reconciliation.replacementAttribution;
  return {
    ...row,
    batchSlug: replacement.batchSlug,
    entityType: replacement.entityType,
    entityId: replacement.entityId,
    ...(replacement.entityName ? { entityName: replacement.entityName } : {}),
    companySlug: replacement.companySlug,
    companyName: replacement.companyName,
    attachedCompanyId: replacement.attachedCompanyId,
    previousAttribution: {
      batchSlug: reconciliation.staleAttribution.batchSlug,
      entityType: reconciliation.staleAttribution.entityType,
      entityId: row?.entityId ?? row?.entity_id,
      companySlug: row?.companySlug ?? row?.company_slug ?? null,
      companyName: row?.companyName ?? row?.company_name ?? null
    },
    attributionReconciliationReason: reconciliation.reason
  };
}

function targetedHistoricalReconciliationDirective(originalRow, replacementRow, reconciliation) {
  const identity = physicalPostIdentity(originalRow);
  return {
    platform: String(originalRow?.platform ?? "").toLowerCase(),
    sourceUrl: canonicalUrl(originalRow?.sourceUrl ?? originalRow?.source_url),
    platformPostId: identity.value,
    disposition: "reattributed",
    reason: reconciliation.reason,
    staleAttribution: {
      ...reconciliation.staleAttribution,
      entityId: originalRow?.entityId ?? originalRow?.entity_id,
      attributionType: originalRow?.attributionType ?? originalRow?.attribution_type ?? "subject"
    },
    replacementAttribution: {
      batchSlug: reconciliation.replacementAttribution.batchSlug,
      entityType: reconciliation.replacementAttribution.entityType,
      entityId: replacementRow.entityId,
      attributionType: replacementRow?.attributionType ?? replacementRow?.attribution_type ?? "subject"
    }
  };
}

function targetedCanonicalReconciliationDirective(originalRow, replacementRow, staleBatchSlug, reason) {
  const identity = physicalPostIdentity(originalRow);
  return {
    platform: String(originalRow?.platform ?? "").toLowerCase(),
    sourceUrl: canonicalUrl(originalRow?.sourceUrl ?? originalRow?.source_url),
    platformPostId: identity.value,
    disposition: "reattributed",
    reason,
    staleAttribution: {
      batchSlug: staleBatchSlug,
      entityType: originalRow?.entityType ?? originalRow?.entity_type ?? "company",
      entityId: originalRow?.entityId ?? originalRow?.entity_id,
      attributionType: originalRow?.attributionType ?? originalRow?.attribution_type ?? "subject"
    },
    replacementAttribution: {
      batchSlug: replacementRow.batchSlug,
      entityType: replacementRow.entityType,
      entityId: replacementRow.entityId,
      attributionType: replacementRow?.attributionType ?? replacementRow?.attribution_type ?? "subject"
    }
  };
}

function targetedAttributionText(row) {
  const raw = parseJsonObject(row?.rawVisibleText);
  return uniqueStrings([
    row?.title,
    row?.text,
    raw?.post?.rawText,
    raw?.post?.text
  ]).join("\n");
}

function visibleMetricFailure(metrics) {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return "missing_visible_metrics";
  const entries = Object.entries(metrics);
  if (entries.some(([key]) => !TOP_VOICE_X_METRICS.has(key))) return "unsupported_visible_metric";
  if (entries.some(([, value]) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    return "invalid_visible_metric_value";
  }
  return entries.some(([, value]) => value > 0) ? null : "missing_positive_visible_metric";
}

function nativePostIdentity(platform, rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl ?? ""));
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
  let match;
  if (platform === "x" && ["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) {
    match = path.match(/^\/(?:[A-Za-z0-9_]+|i\/web)\/status\/(\d+)$/i);
  } else if (platform === "linkedin" && (host === "linkedin.com" || host.endsWith(".linkedin.com"))) {
    const commentUrn = url.searchParams.get("commentUrn");
    match = commentUrn?.match(/,(\d{10,})\)?$/) ?? path.match(/(?:urn:li:activity:|activity-)(\d{10,})(?:-[^/]*)?$/i);
  } else if (platform === "instagram" && (host === "instagram.com" || host.endsWith(".instagram.com"))) {
    match = path.match(/^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)$/i);
  } else if (platform === "youtube" && ["youtube.com", "m.youtube.com"].includes(host)) {
    match = path.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]+)$/i);
    if (!match && path === "/watch") match = String(url.searchParams.get("v") ?? "").match(/^([A-Za-z0-9_-]+)$/);
  } else if (platform === "youtube" && host === "youtu.be") {
    match = path.match(/^\/([A-Za-z0-9_-]+)$/);
  } else if (platform === "reddit" && (host === "reddit.com" || host.endsWith(".reddit.com"))) {
    match = path.match(/\/comments\/([A-Za-z0-9]+)/i);
  } else if (platform === "hacker_news" && host === "news.ycombinator.com" && path === "/item") {
    match = String(url.searchParams.get("id") ?? "").match(/^(\d+)$/);
  } else if (platform === "product_hunt" && (host === "producthunt.com" || host.endsWith(".producthunt.com"))) {
    match = path.match(/^\/posts\/([^/]+)$/i);
  } else if (platform === "github" && host === "github.com") {
    match = path.match(/^\/([^/]+\/[^/]+\/(?:issues|pull|commit|releases\/tag)\/[^/]+)$/i);
  }
  return match?.[1] ? { platform, postId: String(match[1]) } : null;
}

function evidenceIdentityKey(row, batchSlug, physicalIdentity) {
  return [
    batchSlug ?? "legacy-unscoped",
    row?.entityType ?? row?.entity_type ?? "unknown-entity-type",
    row?.entityId ?? row?.entity_id ?? "unknown-entity",
    row?.platform ?? "unknown-platform",
    physicalIdentity
  ].join(":");
}

function quarantineRow(row, batchSlug, reasons, ordinal) {
  const sourceEvidenceId = String(row?.id ?? `isolated-row-${ordinal}`);
  const identity = physicalPostIdentity(row);
  const reconciliationDirective = batchSlug && identity.value
    ? {
        platform: String(row?.platform ?? "").toLowerCase(),
        sourceUrl: canonicalUrl(row?.sourceUrl ?? row?.source_url),
        platformPostId: identity.value,
        disposition: "quarantined",
        reason: reasons.join(";"),
        staleAttribution: {
          batchSlug,
          entityType: row?.entityType ?? row?.entity_type ?? "company",
          entityId: row?.entityId ?? row?.entity_id,
          attributionType: row?.attributionType ?? row?.attribution_type ?? "subject"
        }
      }
    : null;
  return {
    id: `quarantine-${sourceEvidenceId}-${ordinal}`,
    batchSlug: batchSlug ?? null,
    entityType: row?.entityType ?? row?.entity_type ?? null,
    entityId: row?.entityId ?? row?.entity_id ?? null,
    entityName: row?.companyName ?? row?.company_name ?? null,
    platform: row?.platform ?? null,
    platformPostId: row?.platformPostId ?? row?.platform_post_id ?? null,
    candidateUrl: row?.sourceUrl ?? row?.source_url ?? null,
    review_state: "needs_review",
    sourceEvidenceId,
    quarantineReasons: reasons,
    matchReason: `Quarantined during targeted evidence publication: ${reasons.join(", ")}.`,
    ...(reconciliationDirective
      ? { attributionReconciliationDirective: reconciliationDirective }
      : {})
  };
}

function targetedAttributionReconciliationLedger(directives) {
  const byKey = new Map();
  for (const directive of directives) {
    if (!directive || typeof directive !== "object") continue;
    const stale = directive.staleAttribution;
    if (!stale || typeof stale !== "object") continue;
    const key = [
      String(directive.platform ?? "").toLowerCase(),
      normalizePostId(directive.platformPostId) ?? canonicalUrl(directive.sourceUrl) ?? "unknown-post",
      stale.batchSlug ?? "legacy-unscoped",
      stale.entityType ?? "unknown-entity-type",
      stale.entityId ?? "unknown-entity",
      stale.attributionType ?? "subject"
    ].join(":");
    const previous = byKey.get(key);
    if (!previous || reconciliationDispositionRank(directive) > reconciliationDispositionRank(previous)) {
      byKey.set(key, directive);
    }
  }
  return [...byKey.values()].sort((left, right) =>
    String(left.platform).localeCompare(String(right.platform)) ||
    String(left.platformPostId).localeCompare(String(right.platformPostId)) ||
    String(left.staleAttribution?.batchSlug).localeCompare(String(right.staleAttribution?.batchSlug)) ||
    String(left.staleAttribution?.entityId).localeCompare(String(right.staleAttribution?.entityId))
  );
}

function reconciliationDispositionRank(directive) {
  return directive?.disposition === "reattributed" ? 2 : directive?.disposition === "quarantined" ? 1 : 0;
}

function fresherEvidence(left, right) {
  const preferred = evidenceFreshness(right) > evidenceFreshness(left) ? right : left;
  const firstSeen = earliestIso(left?.first_seen_at, right?.first_seen_at);
  return firstSeen ? { ...preferred, first_seen_at: firstSeen } : preferred;
}

function evidenceFreshness(row) {
  return Math.max(
    ...[row?.metricsCheckedAt, row?.last_checked_at, row?.linkCheckedAt, row?.last_updated_at, row?.first_seen_at, row?.postedAt]
      .map((value) => Date.parse(value ?? ""))
      .filter(Number.isFinite),
    Number.NEGATIVE_INFINITY
  );
}

function compareEvidence(left, right) {
  const timeDifference = evidenceFreshness(right) - evidenceFreshness(left);
  return timeDifference || String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function dedupeReviewRows(rows, resolveBatchSlug) {
  const byKey = new Map();
  for (const row of rows) {
    const batch = explicitBatchSlug(row) ?? resolveBatchSlug?.(row) ?? "legacy-unscoped";
    const identity = physicalPostIdentity({
      ...row,
      sourceUrl: row?.candidateUrl ?? row?.sourceUrl,
      platformPostId: row?.platformPostId
    });
    const key = evidenceIdentityKey(row, batch, identity.value);
    const previous = byKey.get(key);
    if (!previous || evidenceFreshness(row) >= evidenceFreshness(previous)) byKey.set(key, row);
  }
  return [...byKey.values()].sort((left, right) => String(left?.id ?? "").localeCompare(String(right?.id ?? "")));
}

function countQuarantineReasons(rows) {
  const counts = {};
  for (const row of rows) {
    for (const reason of row.quarantineReasons ?? []) counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function explicitBatchSlug(row) {
  return row?.batchSlug ?? row?.batch_slug ?? null;
}

function withTargetedBatch(row, batchSlug) {
  const { batchSlug: _camelBatch, batch_slug: _snakeBatch, ...rest } = row ?? {};
  return batchSlug ? { ...rest, batchSlug } : rest;
}

function normalizePostId(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function canonicalUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_|trk$|trkInfo$|lipi$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isSnapshot(value) {
  return Boolean(value && typeof value === "object" && Array.isArray(value.evidence));
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function freshestIso(values, fallback) {
  const valid = values
    .map((value) => ({ value, time: Date.parse(value ?? "") }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((left, right) => right.time - left.time);
  return valid[0]?.value ?? fallback;
}

function earliestIso(left, right) {
  const candidates = [left, right]
    .map((value) => ({ value, time: Date.parse(value ?? "") }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time);
  return candidates[0]?.value ?? null;
}
