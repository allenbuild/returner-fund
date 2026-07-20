import {
  publicationTimesCompatible,
  sourceAuthorsCompatible,
  sourceContentIdentity
} from "./source-content-identity.mjs";

const CONTENT_DUPLICATE_REASON = "same_platform_author_substantive_body";

export function finalizeLoggedInEvidenceContent(
  rows,
  {
    defaultBatchSlug = null,
    resolveBatchSlug = null,
    existingNeedsReview = [],
    existingAttributionReconciliationLedger = []
  } = {}
) {
  const byContent = new Map();
  const evidence = [];
  const duplicateReviews = [];

  for (const row of [...(rows ?? [])].sort(compareLoggedInContentPreference)) {
    const identity = loggedInContentIdentity(row);
    if (!identity) {
      evidence.push(row);
      continue;
    }
    const batchSlug = row?.batchSlug ?? row?.batch_slug ??
      (typeof resolveBatchSlug === "function" ? resolveBatchSlug(row) : null) ??
      defaultBatchSlug;
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

  const needsReview = dedupeRowsById([...existingNeedsReview, ...duplicateReviews]);
  const attributionReconciliationLedger = mergeLoggedInAttributionReconciliationLedgers(
    existingAttributionReconciliationLedger,
    needsReview.map((row) => row?.attributionReconciliationDirective)
  );
  return { evidence, needsReview, attributionReconciliationLedger };
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
