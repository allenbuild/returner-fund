import { isListOrRoundupAttributionContext } from "./public-evidence-attribution.mjs";

const VALID_BATCH_SLUGS = new Set(["S2026", "S26", "A16ZSR006"]);
const TOP_VOICE_X_METRICS = new Set(["views", "likes", "replies", "reposts", "quotes", "saves"]);

/**
 * Merge rebased repository state, pre-rebase local state, and the isolated
 * evidence produced by this Top Voice run. Only the isolated run is treated as
 * untrusted input; legacy repository rows are preserved unless their native URL
 * and explicit post ID contradict one another.
 */
export function mergeTargetedEvidenceSnapshots(
  existingSnapshots,
  isolatedRunSnapshot,
  { resolveBatchSlug = null, validateEntityAttribution = null, mergedAt = new Date().toISOString() } = {}
) {
  const existing = (existingSnapshots ?? []).filter(isSnapshot);
  if (!isSnapshot(isolatedRunSnapshot)) {
    throw new Error("Top Voice publication requires an isolated evidence snapshot with an evidence array.");
  }

  const evidenceByKey = new Map();
  const quarantines = [];
  let duplicateRows = 0;
  let acceptedRunRows = 0;

  const accept = (row, { strictRun = false, ordinal = 0 } = {}) => {
    const batchSlug = resolveBatchSlug ? resolveBatchSlug(row) : explicitBatchSlug(row);
    const scopedRow = withTargetedBatch(row, batchSlug);
    const identity = physicalPostIdentity(scopedRow);
    const reasons = strictRun
      ? validateIsolatedTopVoiceRow(
          scopedRow,
          batchSlug,
          identity,
          resolveBatchSlug,
          validateEntityAttribution
        )
      : validateLegacyTargetedRow(scopedRow, batchSlug, identity, validateEntityAttribution);

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
    if (strictRun) acceptedRunRows += 1;
  };

  let ordinal = 0;
  for (const snapshot of existing) {
    for (const row of snapshot.evidence) accept(row, { ordinal: ordinal++ });
  }
  for (const row of isolatedRunSnapshot.evidence) {
    accept(row, { strictRun: true, ordinal: ordinal++ });
  }

  const uniqueQuarantines = dedupeReviewRows(quarantines, resolveBatchSlug);
  const attributionReconciliationLedger = targetedAttributionReconciliationLedger(uniqueQuarantines);
  const existingReviews = existing.flatMap((snapshot) => snapshot.needsReview ?? []);
  const runReviews = isolatedRunSnapshot.needsReview ?? [];
  const needsReview = dedupeReviewRows(
    [...existingReviews, ...runReviews, ...uniqueQuarantines],
    resolveBatchSlug
  );
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

function targetedAttributionReconciliationLedger(quarantines) {
  const byKey = new Map();
  for (const row of quarantines) {
    const directive = row?.attributionReconciliationDirective;
    if (!directive) continue;
    const stale = directive.staleAttribution;
    const key = [
      directive.platform,
      directive.platformPostId,
      stale.batchSlug,
      stale.entityType,
      stale.entityId,
      stale.attributionType
    ].join(":");
    if (!byKey.has(key)) byKey.set(key, directive);
  }
  return [...byKey.values()].sort((left, right) =>
    String(left.platform).localeCompare(String(right.platform)) ||
    String(left.platformPostId).localeCompare(String(right.platformPostId)) ||
    String(left.staleAttribution?.batchSlug).localeCompare(String(right.staleAttribution?.batchSlug)) ||
    String(left.staleAttribution?.entityId).localeCompare(String(right.staleAttribution?.entityId))
  );
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
