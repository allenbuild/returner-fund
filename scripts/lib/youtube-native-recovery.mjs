import { createHash } from "node:crypto";

export const YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION =
  "youtube-native-recovery.v1";
export const YOUTUBE_NATIVE_RECOVERY_JOURNAL_VERSION =
  "youtube-native-recovery-journal.v1";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const TRUSTED_RECEIPT_SOURCES = new Set([
  "manual_official_yc_embed_adjudication_v1",
  "native_youtube_channel_feed_v1",
  "native_youtube_direct_verification_v1",
  "official_a16z_company_page_embed_v1",
  "official_yc_company_page_embed_v1",
  "scheduled_youtube_atom_v1",
  "youtube_native_profile_api_v1",
  "youtube_watch_player_microformat"
]);
const OFFICIAL_ANCHOR = /(?:discovered\s+from\s+(?:the\s+)?official\s+company\s+website|exact\s+official\s+(?:company|yc|a16z)|official\s+(?:company|yc|a16z)(?:\s+company)?\s+page|(?:embedded|embed)\s+(?:in|on|by)\s+(?:the\s+)?(?:exact\s+)?official|company\s+page\s+(?:embedded|embed))/iu;

export function normalizeYouTubeVideo(value) {
  const explicit = String(
    typeof value === "object" && value !== null
      ? value.platformPostId ?? value.platform_post_id ?? value.nativeId ?? ""
      : ""
  ).trim();
  const raw = typeof value === "object" && value !== null
    ? value.sourceUrl ?? value.source_url ?? value.canonicalUrl ??
      value.candidateUrl ?? value.url ?? null
    : value;
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    if (!VIDEO_ID.test(explicit)) return null;
    return {
      platform: "youtube",
      videoId: explicit,
      physicalKey: `youtube:${explicit}`,
      route: "watch",
      canonicalUrl: `https://www.youtube.com/watch?v=${explicit}`
    };
  }
  const host = url.hostname.replace(/^www\./iu, "").toLowerCase();
  const path = safeDecode(url.pathname);
  let videoId = null;
  let route = "watch";
  if (host === "youtu.be") {
    videoId = path.split("/").filter(Boolean)[0] ?? null;
  } else if (["youtube.com", "m.youtube.com"].includes(host)) {
    if (path === "/watch") {
      videoId = url.searchParams.get("v");
    } else {
      const match = path.match(/^\/(shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/iu);
      route = match?.[1]?.toLowerCase() ?? route;
      videoId = match?.[2] ?? null;
    }
  }
  if (!videoId && VIDEO_ID.test(explicit)) videoId = explicit;
  if (!videoId || !VIDEO_ID.test(videoId)) return null;
  if (explicit && VIDEO_ID.test(explicit) && explicit !== videoId) return null;
  return {
    platform: "youtube",
    videoId,
    physicalKey: `youtube:${videoId}`,
    route,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`
  };
}

export function extractYouTubeChannelReceipt(row, oembed = null) {
  const keys = new Set();
  const channelIds = new Set();
  const handles = new Set();
  const authorNames = new Set();
  const rawObject = parseRawObject(row?.rawVisibleText);
  const raw = rawText(row?.rawVisibleText);

  for (const value of [
    row?.youtubeChannelUrl,
    row?.accountUrl,
    row?.authorUrl,
    rawObject?.ownerProfileUrl,
    rawObject?.post?.authorUrl,
    rawObject?.receipt?.authorUrl,
    oembed?.authorUrl,
    oembed?.author_url
  ]) {
    addYouTubeAccountUrl(value, { keys, channelIds, handles });
  }
  for (const value of [
    row?.youtubeChannelId,
    row?.channelId,
    rawObject?.channelId,
    rawObject?.post?.channelId
  ]) {
    addChannelId(value, { keys, channelIds });
  }
  for (const match of raw.matchAll(
    /"(?:browseId|channelId)"\s*:\s*"(UC[A-Za-z0-9_-]{8,})"/gu
  )) {
    addChannelId(match[1], { keys, channelIds });
  }
  for (const match of raw.matchAll(
    /"canonicalBaseUrl"\s*:\s*"\/@([^"/?#]+)"/gu
  )) {
    addHandle(match[1], { keys, handles });
  }
  for (const match of raw.matchAll(
    /https?:\\?\/\\?\/(?:www\.)?youtube\.com\\?\/@([A-Za-z0-9_.-]+)/giu
  )) {
    addHandle(match[1], { keys, handles });
  }

  for (const value of [
    row?.youtubeChannelName,
    row?.authorName,
    rawObject?.author,
    rawObject?.ownerChannelName,
    rawObject?.post?.authorName,
    rawObject?.receipt?.authorName,
    oembed?.authorName,
    oembed?.author_name
  ]) {
    addAuthorName(value, authorNames);
  }
  for (const match of raw.matchAll(
    /"(?:author|ownerChannelName|youtubeChannelName)"\s*:\s*"([^"\\]{2,160})"/gu
  )) {
    addAuthorName(match[1], authorNames);
  }
  for (const match of raw.matchAll(
    /"(?:longBylineText|ownerText)"[\s\S]{0,600}?"text"\s*:\s*"([^"\\]{2,160})"/gu
  )) {
    addAuthorName(match[1], authorNames);
  }

  return {
    keys: [...keys].sort(),
    channelIds: [...channelIds].sort(),
    handles: [...handles].sort(),
    authorNames: [...authorNames].sort(),
    authorUrl: nullableText(oembed?.authorUrl ?? oembed?.author_url),
    authorName: nullableText(oembed?.authorName ?? oembed?.author_name)
  };
}

export function buildCurrentYouTubeOwnerCatalog(catalogs) {
  const byKey = new Map();
  const byScopedEntity = new Map();
  const byEntityId = new Map();
  const companies = new Map();
  const byNormalizedName = new Map();

  for (const catalog of catalogs ?? []) {
    const batchSlug = normalizeBatchSlug(catalog?.slug);
    if (!batchSlug) continue;
    for (const company of catalog?.companies ?? []) {
      const companyId = clean(company?.sourceKey);
      if (!companyId) continue;
      const companyOwner = ownerRecord({
        batchSlug,
        entityType: "company",
        entityId: companyId,
        entityName: clean(company?.name),
        companyId,
        companyName: clean(company?.name),
        companySlug: companySlug(company),
        websiteUrl: clean(company?.websiteUrl),
        profileUrl: clean(company?.profileUrl),
        accounts: company?.accounts
      });
      addOwner(companyOwner);
      const companyEntry = { company: companyOwner, founders: [] };
      companies.set(companyKey(batchSlug, companyId), companyEntry);
      for (const founder of company?.founders ?? []) {
        const founderId = clean(founder?.sourceKey);
        if (!founderId) continue;
        const founderOwner = ownerRecord({
          batchSlug,
          entityType: "founder",
          entityId: founderId,
          entityName: clean(founder?.name),
          companyId,
          companyName: clean(company?.name),
          companySlug: companyOwner.companySlug,
          websiteUrl: clean(founder?.websiteUrl),
          profileUrl: clean(founder?.profileUrl),
          accounts: founder?.accounts
        });
        addOwner(founderOwner);
        companyEntry.founders.push(founderOwner);
      }
      companyEntry.founders.sort((left, right) => left.key.localeCompare(right.key));
    }
  }
  for (const values of byEntityId.values()) values.sort(compareOwner);
  for (const values of byNormalizedName.values()) values.sort(compareOwner);
  return { byKey, byScopedEntity, byEntityId, companies, byNormalizedName };

  function addOwner(owner) {
    byKey.set(owner.key, owner);
    byScopedEntity.set(scopedEntityKey(owner.batchSlug, owner.entityType, owner.entityId), owner);
    const entityMatches = byEntityId.get(owner.entityId) ?? [];
    entityMatches.push(owner);
    byEntityId.set(owner.entityId, entityMatches);
    const nameMatches = byNormalizedName.get(owner.normalizedName) ?? [];
    nameMatches.push(owner);
    byNormalizedName.set(owner.normalizedName, nameMatches);
  }
}

export function resolveAttachedOwner(row, catalog, { fallbackBatchSlug = null } = {}) {
  const batchSlug = normalizeBatchSlug(
    row?.batchSlug ?? row?.batch_slug ?? fallbackBatchSlug
  );
  const entityType = normalizeEntityType(row?.entityType ?? row?.entity_type);
  const entityId = clean(
    row?.entityId ?? row?.entity_id ?? row?.nativeAuthorResolution?.owner?.entityId
  );
  if (batchSlug && entityType && entityId) {
    const direct = catalog?.byScopedEntity?.get(
      scopedEntityKey(batchSlug, entityType, entityId)
    );
    if (direct) return direct;
  }
  if (entityId) {
    const matches = catalog?.byEntityId?.get(entityId) ?? [];
    if (matches.length === 1) return matches[0];
  }
  return null;
}

export function buildTrustedYouTubeChannelIndex({ catalogs, trustedRows = [] }) {
  const owners = buildCurrentYouTubeOwnerCatalog(catalogs);
  const channels = new Map();
  const rejectedTrustRows = [];

  for (const owner of owners.byKey.values()) {
    for (const account of owner.accounts) {
      if (account.platform !== "youtube" || account.verified !== true) continue;
      const receipt = extractYouTubeChannelReceipt({
        youtubeChannelUrl: account.url,
        accountUrl: account.url,
        youtubeChannelId: account.accountId,
        authorHandle: account.handle
      });
      for (const key of receipt.keys) addChannel(key, owner, {
        method: "current_verified_cohort_roster",
        sourcePath: "current_catalog",
        sourceRowId: account.sourceKey ?? null
      });
    }
  }

  for (const entry of trustedRows ?? []) {
    const row = entry?.row ?? entry;
    if (!isTrustedYouTubeReceiptRow(row)) continue;
    const owner = resolveAttachedOwner(row, owners, {
      fallbackBatchSlug: entry?.fallbackBatchSlug ?? null
    });
    const receipt = extractYouTubeChannelReceipt(row);
    if (!owner || receipt.keys.length === 0) {
      rejectedTrustRows.push({
        sourcePath: entry?.sourcePath ?? null,
        rowId: row?.id ?? null,
        reason: !owner ? "trusted_row_current_owner_unresolved" : "trusted_row_channel_unresolved"
      });
      continue;
    }
    for (const key of receipt.keys) addChannel(key, owner, {
      method: trustedRowMethod(row),
      sourcePath: entry?.sourcePath ?? null,
      sourceRowId: row?.id ?? null
    });
  }
  return { owners, channels, rejectedTrustRows };

  function addChannel(channelKey, owner, receipt) {
    const record = channels.get(channelKey) ?? new Map();
    const current = record.get(owner.key) ?? { owner, receipts: [] };
    current.receipts.push(receipt);
    current.receipts = dedupeByStableValue(current.receipts).sort(compareTrustReceipt);
    record.set(owner.key, current);
    channels.set(channelKey, record);
  }
}

export function isTrustedYouTubeReceiptRow(row) {
  if (normalizePlatform(row?.platform) !== "youtube") return false;
  const state = String(row?.review_state ?? row?.reviewState ?? "").toLowerCase();
  const attribution = String(row?.attributionStatus ?? "").toLowerCase();
  if (state !== "verified") return false;
  if (attribution && attribution !== "verified") return false;
  if (row?.attributionMode === "account_owner") return true;
  if (row?.nativeAuthorResolution?.status === "matched") return true;
  const rawObject = parseRawObject(row?.rawVisibleText);
  const source = String(
    row?.attributionProvenance ?? rawObject?.source ?? ""
  ).toLowerCase();
  return TRUSTED_RECEIPT_SOURCES.has(source) &&
    Boolean(
      row?.youtubeChannelId ?? row?.youtubeChannelUrl ?? row?.accountUrl ??
      rawObject?.channelId ?? rawObject?.post?.channelId ?? rawObject?.post?.authorUrl
    );
}

export function buildYouTubeCandidatePool({
  reviewRows = [],
  operationalCandidates = [],
  historicalOccurrences = [],
  currentEvidenceRows = []
}) {
  const currentEvidenceVideoIds = new Set();
  for (const row of currentEvidenceRows) {
    if (normalizePlatform(row?.platform) !== "youtube") continue;
    const native = normalizeYouTubeVideo(row);
    if (native) currentEvidenceVideoIds.add(native.videoId);
  }
  const candidates = new Map();
  const rejected = [];

  for (const row of reviewRows) {
    addOccurrence({ sourceKind: "current_review", sourcePath: null, row });
  }
  for (const candidate of operationalCandidates) {
    if (normalizePlatform(candidate?.platform) !== "youtube") continue;
    const row = operationalCandidateRow(candidate);
    addOccurrence({
      sourceKind: "current_operational_ledger",
      sourcePath: "outputs/public-ingestion-operational-ledger-current.json",
      row,
      provenance: candidate.provenance ?? []
    });
  }
  for (const occurrence of historicalOccurrences) {
    addOccurrence({ ...occurrence, sourceKind: "repository_history" });
  }

  const values = [...candidates.values()].map((candidate) => ({
    ...candidate,
    occurrences: candidate.occurrences
      .sort(compareOccurrence)
      .map(publicOccurrence),
    preferred: publicOccurrence(candidate.preferred)
  })).sort((left, right) => left.videoId.localeCompare(right.videoId));
  return {
    candidates: values,
    currentEvidenceVideoIds,
    rejected: rejected.sort((left, right) =>
      String(left.rowId ?? "").localeCompare(String(right.rowId ?? ""))
    )
  };

  function addOccurrence(occurrence) {
    const row = occurrence?.row;
    if (normalizePlatform(row?.platform) !== "youtube") return;
    const native = normalizeYouTubeVideo(row);
    if (!native) {
      rejected.push({
        sourceKind: occurrence.sourceKind,
        sourcePath: occurrence.sourcePath ?? null,
        rowId: row?.id ?? null,
        reason: "not_native_youtube_video"
      });
      return;
    }
    if (currentEvidenceVideoIds.has(native.videoId)) return;
    const normalized = {
      sourceKind: occurrence.sourceKind,
      sourcePath: occurrence.sourcePath ?? null,
      commit: occurrence.commit ?? null,
      committedAt: occurrence.committedAt ?? null,
      sourceIndex: occurrence.sourceIndex ?? null,
      provenance: occurrence.provenance ?? [],
      row
    };
    const current = candidates.get(native.videoId) ?? {
      ...native,
      occurrences: [],
      preferred: normalized
    };
    current.occurrences.push(normalized);
    if (occurrenceRank(normalized) > occurrenceRank(current.preferred)) {
      current.preferred = normalized;
    }
    candidates.set(native.videoId, current);
  }
}

export function candidateNeedsAnonymousValidation(candidate, context) {
  const preliminary = preliminaryOwnership(candidate, context);
  if (preliminary.status === "potential") return true;
  if (
    preliminary.reason === "youtube_native_author_not_exact_current_owner" &&
    candidateHasOfficialAnchor(candidate)
  ) return true;
  if (candidate.occurrences.some((entry) =>
    entry.sourceKind === "current_operational_ledger"
  )) return true;
  return false;
}

export function resolveYouTubeCandidateOwnership(candidate, {
  trustedIndex,
  validationReceipt = null
}) {
  if (validationReceipt?.status !== "verified") {
    return rejectionDecision(validationReceipt?.status === "not_found"
      ? "youtube_video_not_found"
      : "anonymous_youtube_validation_missing");
  }
  if (
    validationReceipt.providerName !== "YouTube" ||
    validationReceipt.type !== "video" ||
    !clean(validationReceipt.title)
  ) {
    return rejectionDecision("anonymous_youtube_oembed_invalid_video");
  }
  const preliminary = preliminaryOwnership(candidate, {
    trustedIndex,
    validationReceipt
  });
  if (preliminary.status !== "potential") {
    return rejectionDecision(preliminary.reason, preliminary.details);
  }
  return {
    accepted: true,
    owner: preliminary.owner,
    method: preliminary.method,
    channelReceipt: preliminary.channelReceipt,
    trustReceipts: preliminary.trustReceipts,
    validationReceipt,
    reasons: []
  };
}

export function buildYouTubePromotionArtifact({
  candidates,
  trustedIndex,
  validationReceipts,
  inputManifest,
  sourceAudit = null
}) {
  const evidence = [];
  const rejectedCandidates = [];
  const seen = new Set();
  for (const candidate of candidates ?? []) {
    const decision = resolveYouTubeCandidateOwnership(candidate, {
      trustedIndex,
      validationReceipt: validationReceipts.get(candidate.videoId) ?? null
    });
    if (!decision.accepted) {
      rejectedCandidates.push({
        videoId: candidate.videoId,
        physicalKey: candidate.physicalKey,
        reason: decision.reason,
        details: decision.details ?? null,
        sources: occurrenceSourceSummary(candidate.occurrences)
      });
      continue;
    }
    if (seen.has(candidate.physicalKey)) {
      throw new Error(`Duplicate accepted YouTube physical key: ${candidate.physicalKey}`);
    }
    seen.add(candidate.physicalKey);
    evidence.push(promotionEvidence(candidate, decision));
  }
  evidence.sort((left, right) =>
    left.batchSlug.localeCompare(right.batchSlug) ||
    left.entityType.localeCompare(right.entityType) ||
    left.entityId.localeCompare(right.entityId) ||
    left.platformPostId.localeCompare(right.platformPostId)
  );
  rejectedCandidates.sort((left, right) => left.videoId.localeCompare(right.videoId));
  const byCohort = countBy(evidence, (row) => row.batchSlug);
  const byOwnerType = countBy(evidence, (row) => row.entityType);
  const byTrustMethod = countBy(
    evidence,
    (row) => row._youtubeNativeRecovery.trustMethod
  );
  const zeroEngagement = evidence.filter((row) => !hasPositiveMetrics(row.metrics)).length;
  return {
    schemaVersion: YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
    source: {
      collector: "current_review_operational_and_repository_history_youtube_recovery",
      inputHash: inputManifest?.inputHash ?? null,
      authenticatedAccessUsed: false,
      browserAccessUsed: false,
      linkedinAccessUsed: false,
      anonymousEndpoint: "www.youtube.com/oembed"
    },
    counts: {
      total: evidence.length,
      byCohort,
      byPlatform: evidence.length > 0 ? { youtube: evidence.length } : {},
      byOwnerType,
      byTrustMethod,
      zeroEngagement,
      rejected: rejectedCandidates.length
    },
    inputManifest,
    sourceAudit,
    evidence,
    needsReview: [],
    attributionReconciliationLedger: [],
    failures: [],
    attempts: {},
    discoveryAttempts: [],
    sourceDiscoveryPaths: [],
    rejectedCandidates
  };
}

export async function validateAnonymousYouTubeVideo(candidate, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  userAgent = "ReturnerFundYouTubeRecovery/1.0"
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Anonymous YouTube validation requires fetch.");
  }
  const endpoint = new URL("https://www.youtube.com/oembed");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("url", candidate.canonicalUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      headers: { accept: "application/json", "user-agent": userAgent },
      redirect: "follow",
      signal: controller.signal
    });
    if (response.status === 404) {
      return validationReceipt(candidate, "not_found", { httpStatus: 404 });
    }
    if (!response.ok) {
      return validationReceipt(candidate, "failed", {
        httpStatus: response.status,
        reason: `youtube_oembed_http_${response.status}`
      });
    }
    const body = await response.json();
    return validationReceipt(candidate, "verified", {
      httpStatus: response.status,
      title: nullableText(body?.title),
      authorName: nullableText(body?.author_name),
      authorUrl: nullableText(body?.author_url),
      type: nullableText(body?.type),
      providerName: nullableText(body?.provider_name),
      thumbnailUrl: nullableText(body?.thumbnail_url)
    });
  } catch (error) {
    return validationReceipt(candidate, "failed", {
      httpStatus: null,
      reason: error?.name === "AbortError"
        ? "youtube_oembed_timeout"
        : "youtube_oembed_network_error",
      errorClass: error?.name ?? "Error"
    });
  } finally {
    clearTimeout(timer);
  }
}

export function buildYouTubeRecoveryInputManifest(value) {
  const manifest = sortDeep(value);
  return {
    ...manifest,
    inputHash: sha256(stableStringify(manifest))
  };
}

export function stableStringify(value, space = 0) {
  return JSON.stringify(sortDeep(value), null, space);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function preliminaryOwnership(candidate, { trustedIndex, validationReceipt = null }) {
  const preferredRow = candidate.preferred?.row ?? {};
  const attachedOwners = compatibleAttachedOwners(candidate, trustedIndex.owners);
  if (attachedOwners.length === 0) {
    return {
      status: "rejected",
      reason: "current_cohort_owner_unresolved",
      details: null
    };
  }
  const channelReceipt = extractYouTubeChannelReceipt(preferredRow, validationReceipt);
  const mapped = new Map();
  const foreign = new Map();
  for (const channelKey of channelReceipt.keys) {
    for (const [ownerKey, record] of trustedIndex.channels.get(channelKey) ?? []) {
      if (attachedOwners.some((owner) => sameCompany(owner, record.owner))) {
        mapped.set(ownerKey, record);
      } else {
        foreign.set(ownerKey, record.owner);
      }
    }
  }
  if (mapped.size === 1) {
    const record = [...mapped.values()][0];
    return {
      status: "potential",
      owner: record.owner,
      method: "trusted_current_channel_owner",
      channelReceipt,
      trustReceipts: record.receipts
    };
  }
  if (mapped.size > 1) {
    return {
      status: "rejected",
      reason: "youtube_channel_maps_to_multiple_current_owners",
      details: { ownerKeys: [...mapped.keys()].sort() }
    };
  }
  if (foreign.size > 0) {
    return {
      status: "rejected",
      reason: "youtube_channel_maps_to_different_current_company",
      details: { ownerKeys: [...foreign.keys()].sort() }
    };
  }

  if (!candidateHasOfficialAnchor(candidate)) {
    return {
      status: "rejected",
      reason: "youtube_native_owner_lacks_official_anchor",
      details: null
    };
  }
  const namedOwners = exactNamedOwners(
    channelReceipt.authorNames,
    attachedOwners,
    trustedIndex.owners,
    candidate
  );
  if (namedOwners.length === 1) {
    return {
      status: "potential",
      owner: namedOwners[0],
      method: "official_anchor_exact_native_author",
      channelReceipt,
      trustReceipts: candidateOfficialAnchorReceipts(candidate)
    };
  }
  return {
    status: "rejected",
    reason: namedOwners.length > 1
      ? "youtube_exact_author_maps_to_multiple_current_owners"
      : "youtube_native_author_not_exact_current_owner",
    details: {
      authorNames: channelReceipt.authorNames,
      attachedOwnerKeys: attachedOwners.map((owner) => owner.key)
    }
  };
}

function compatibleAttachedOwners(candidate, owners) {
  const result = new Map();
  for (const occurrence of candidate.occurrences ?? []) {
    const attached = resolveAttachedOwner(
      occurrence.row,
      owners,
      { fallbackBatchSlug: occurrence.fallbackBatchSlug ?? null }
    );
    if (!attached) continue;
    const company = owners.companies.get(
      companyKey(attached.batchSlug, attached.companyId)
    );
    if (!company) continue;
    result.set(company.company.key, company.company);
    for (const founder of company.founders) result.set(founder.key, founder);
  }
  return [...result.values()].sort(compareOwner);
}

function exactNamedOwners(authorNames, compatibleOwners, ownerCatalog, candidate) {
  const compatible = new Map(compatibleOwners.map((owner) => [owner.key, owner]));
  const result = new Map();
  for (const authorName of authorNames) {
    const globalMatches = ownerCatalog.byNormalizedName.get(authorName) ?? [];
    if (globalMatches.length !== 1) continue;
    const owner = globalMatches[0];
    if (!compatible.has(owner.key)) continue;
    if (!isDistinctiveOwnerName(owner, candidate)) continue;
    result.set(owner.key, owner);
  }
  return [...result.values()].sort(compareOwner);
}

function isDistinctiveOwnerName(owner, candidate) {
  const value = owner.normalizedName;
  const tokens = value.split(" ").filter(Boolean);
  if (owner.entityType === "founder") return tokens.length >= 2 && value.length >= 7;
  return (tokens.length >= 2 && value.length >= 7) ||
    /\d/u.test(value) ||
    (tokens.length === 1 && currentReviewHasOfficialAnchor(candidate));
}

function currentReviewHasOfficialAnchor(candidate) {
  return (candidate.occurrences ?? []).some((entry) => {
    if (entry.sourceKind !== "current_review") return false;
    const row = entry.row ?? {};
    const rawObject = parseRawObject(row.rawVisibleText);
    return OFFICIAL_ANCHOR.test(String(row.matchReason ?? "")) ||
      Boolean(
        row.officialYcProfileUrl ?? row.officialA16zProfileUrl ??
        rawObject?.officialYcProfileUrl ?? rawObject?.officialA16zProfileUrl
      );
  });
}

function candidateHasOfficialAnchor(candidate) {
  return (candidate.occurrences ?? []).some((entry) => {
    const row = entry.row ?? {};
    const rawObject = parseRawObject(row.rawVisibleText);
    const source = String(
      row.attributionProvenance ?? rawObject?.source ?? ""
    ).toLowerCase();
    return OFFICIAL_ANCHOR.test(String(row.matchReason ?? "")) ||
      TRUSTED_RECEIPT_SOURCES.has(source) ||
      Boolean(
        row.officialYcProfileUrl ?? row.officialA16zProfileUrl ??
        rawObject?.officialYcProfileUrl ?? rawObject?.officialA16zProfileUrl
      );
  });
}

function candidateOfficialAnchorReceipts(candidate) {
  return (candidate.occurrences ?? [])
    .filter((entry) => {
      const row = entry.row ?? {};
      const rawObject = parseRawObject(row.rawVisibleText);
      const source = String(
        row.attributionProvenance ?? rawObject?.source ?? ""
      ).toLowerCase();
      return OFFICIAL_ANCHOR.test(String(row.matchReason ?? "")) ||
        TRUSTED_RECEIPT_SOURCES.has(source) ||
        Boolean(row.officialYcProfileUrl ?? rawObject?.officialYcProfileUrl);
    })
    .map((entry) => ({
      method: "official_profile_or_company_site_anchor",
      sourceKind: entry.sourceKind,
      sourcePath: entry.sourcePath ?? null,
      sourceRowId: entry.row?.id ?? null,
      matchReason: nullableText(entry.row?.matchReason)
    }))
    .sort(compareTrustReceipt);
}

function promotionEvidence(candidate, decision) {
  const original = candidate.preferred?.row ?? {};
  const owner = decision.owner;
  const metrics = normalizedMetrics(original.metrics);
  const zeroEngagement = !hasPositiveMetrics(metrics);
  const checkedAt = decision.validationReceipt.checkedAt ??
    original.last_checked_at ?? original.lastCheckedAt ?? null;
  const title = decision.validationReceipt.title ?? original.title ?? original.text ??
    `YouTube video ${candidate.videoId}`;
  const authorUrl = decision.validationReceipt.authorUrl ??
    decision.channelReceipt.authorUrl ?? original.youtubeChannelUrl ?? original.accountUrl ?? null;
  const channelId = decision.channelReceipt.channelIds[0] ?? null;
  const accountHandle = youtubeHandleFromUrl(authorUrl);
  const firstSeen = original.first_seen_at ?? original.firstSeenAt ?? checkedAt;
  const id = clean(original.id) ??
    `youtube-${owner.entityId}-${candidate.videoId.toLowerCase()}`;
  const attributionSignals = [...new Set([
    ...(Array.isArray(original.attributionSignals) ? original.attributionSignals : []),
    "official_youtube_oembed_author_match",
    "unique_native_author",
    decision.method,
    ...(zeroEngagement ? ["zero_engagement_explicit_trust_receipt"] : [])
  ])].sort();
  return {
    id,
    batchSlug: owner.batchSlug,
    entityType: owner.entityType,
    entityId: owner.entityId,
    entityName: owner.entityName,
    ...(owner.entityType === "founder" ? { founderName: owner.entityName } : {}),
    companySlug: owner.companySlug,
    companyName: owner.companyName,
    platform: "youtube",
    title,
    text: clean(original.text) ?? title,
    sourceUrl: candidate.canonicalUrl,
    platformPostId: candidate.videoId,
    ...(authorUrl ? {
      accountUrl: authorUrl,
      youtubeChannelUrl: authorUrl
    } : {}),
    ...(channelId ? { youtubeChannelId: channelId } : {}),
    ...(decision.validationReceipt.authorName
      ? {
          authorName: decision.validationReceipt.authorName,
          youtubeChannelName: decision.validationReceipt.authorName
        }
      : {}),
    ...(accountHandle ? { authorHandle: accountHandle } : {}),
    postedAt: original.postedAt ?? original.publishedAt ?? null,
    metrics,
    contributionScore: zeroEngagement
      ? 0
      : finiteNonnegative(original.contributionScore, 0),
    ...(decision.validationReceipt.thumbnailUrl
      ? {
          thumbnailUrl: decision.validationReceipt.thumbnailUrl,
          thumbnailSource: "youtube"
        }
      : {}),
    review_state: "verified",
    linkStatus: "verified",
    ...(checkedAt ? { linkCheckedAt: checkedAt } : {}),
    matchReason:
      "Exact current cohort company/founder owns the native YouTube channel; the native video was verified through anonymous official YouTube oEmbed.",
    first_seen_at: firstSeen,
    last_checked_at: checkedAt,
    last_updated_at: original.last_updated_at ?? original.lastUpdatedAt ?? checkedAt,
    attributionStatus: "verified",
    attributionMode: "account_owner",
    attributionVersion: Math.max(3, Number(original.attributionVersion ?? 0)),
    attributionSignals,
    attributionDescriptorMatches: Array.isArray(original.attributionDescriptorMatches)
      ? original.attributionDescriptorMatches
      : [],
    attributionProvenance: YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
    nativeAuthorResolution: {
      status: "matched",
      reason: decision.method,
      author: {
        platform: "youtube",
        keys: decision.channelReceipt.keys,
        name: decision.validationReceipt.authorName,
        url: decision.validationReceipt.authorUrl
      },
      owner: publicOwner(owner)
    },
    rawVisibleText: {
      source: YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
      videoId: candidate.videoId,
      oembed: {
        title: decision.validationReceipt.title,
        authorName: decision.validationReceipt.authorName,
        authorUrl: decision.validationReceipt.authorUrl,
        providerName: decision.validationReceipt.providerName,
        type: decision.validationReceipt.type
      },
      trust: {
        method: decision.method,
        channelKeys: decision.channelReceipt.keys,
        receipts: decision.trustReceipts
      },
      sourceOccurrences: occurrenceSourceSummary(candidate.occurrences),
      metricsReceipt: zeroEngagement
        ? "no_positive_public_metrics_observed_zero_engagement_explicitly_permitted"
        : "preserved_nonnegative_public_metrics_from_existing_candidate"
    },
    _youtubeNativeRecovery: {
      schemaVersion: YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
      physicalKey: candidate.physicalKey,
      trustMethod: decision.method,
      zeroEngagement,
      validation: decision.validationReceipt
    }
  };
}

function operationalCandidateRow(candidate) {
  const context = bestOperationalContext(candidate?.provenance ?? []);
  return {
    id: `operational-youtube-${candidate?.platformPostId ?? "unknown"}`,
    batchSlug: context?.batchSlug ?? null,
    entityType: context?.entityType ?? null,
    entityId: context?.entityId ?? null,
    entityName: context?.entityName ?? null,
    companySlug: context?.companySlug ?? null,
    companyName: context?.companyName ?? null,
    platform: "youtube",
    sourceUrl: candidate?.canonicalUrl,
    platformPostId: candidate?.platformPostId,
    title: null,
    text: null,
    metrics: candidate?.metrics ?? {},
    matchReason: context?.matchReason ?? null,
    review_state: "needs_review",
    rawVisibleText: {
      source: "current_public_operational_ledger",
      provenance: candidate?.provenance ?? []
    }
  };
}

function bestOperationalContext(provenance) {
  return [...provenance].sort((left, right) =>
    operationalContextRank(right?.context) - operationalContextRank(left?.context) ||
    stableStringify(left).localeCompare(stableStringify(right))
  )[0]?.context ?? null;
}

function operationalContextRank(context) {
  return [context?.batchSlug, context?.entityType, context?.entityId]
    .filter(Boolean).length;
}

function occurrenceRank(occurrence) {
  const kind = {
    current_review: 4,
    current_operational_ledger: 3,
    repository_history: 2
  }[occurrence.sourceKind] ?? 1;
  const row = occurrence.row ?? {};
  const richness = Object.keys(row).length;
  const verified = String(row.review_state ?? "").toLowerCase() === "verified" ? 1 : 0;
  const rawLength = rawText(row.rawVisibleText).length;
  return kind * 1_000_000_000 + verified * 100_000_000 +
    Math.min(richness, 999) * 100_000 + Math.min(rawLength, 99_999);
}

function publicOccurrence(occurrence) {
  return {
    sourceKind: occurrence.sourceKind,
    sourcePath: occurrence.sourcePath ?? null,
    commit: occurrence.commit ?? null,
    committedAt: occurrence.committedAt ?? null,
    sourceIndex: occurrence.sourceIndex ?? null,
    fallbackBatchSlug: occurrence.fallbackBatchSlug ?? null,
    provenance: occurrence.provenance ?? [],
    row: occurrence.row
  };
}

function compareOccurrence(left, right) {
  return String(left.sourceKind).localeCompare(String(right.sourceKind)) ||
    String(left.sourcePath ?? "").localeCompare(String(right.sourcePath ?? "")) ||
    String(left.commit ?? "").localeCompare(String(right.commit ?? "")) ||
    Number(left.sourceIndex ?? -1) - Number(right.sourceIndex ?? -1) ||
    String(left.row?.id ?? "").localeCompare(String(right.row?.id ?? ""));
}

function occurrenceSourceSummary(occurrences) {
  return dedupeByStableValue((occurrences ?? []).map((entry) => ({
    sourceKind: entry.sourceKind,
    sourcePath: entry.sourcePath ?? null,
    sourceRowId: entry.row?.id ?? null,
    commit: entry.commit ?? null
  }))).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
}

function trustedRowMethod(row) {
  if (row?.nativeAuthorResolution?.status === "matched") {
    return "existing_trusted_native_author_resolution";
  }
  if (row?.attributionMode === "account_owner") {
    return "existing_verified_account_owner_evidence";
  }
  const rawObject = parseRawObject(row?.rawVisibleText);
  return String(row?.attributionProvenance ?? rawObject?.source ??
    "existing_trusted_youtube_receipt");
}

function ownerRecord(input) {
  const entityName = clean(input.entityName) ?? clean(input.companyName) ?? input.entityId;
  return {
    ...input,
    entityName,
    key: scopedEntityKey(input.batchSlug, input.entityType, input.entityId),
    normalizedName: normalizeName(entityName),
    accounts: (input.accounts ?? []).map((account) => ({
      sourceKey: clean(account?.sourceKey ?? account?.id),
      platform: normalizePlatform(account?.platform),
      handle: clean(account?.handle),
      url: clean(account?.url),
      accountId: clean(account?.accountId),
      verified: account?.verified === true ||
        String(account?.reviewState ?? account?.review_state ?? "").toLowerCase() === "verified"
    })).sort((left, right) =>
      String(left.platform).localeCompare(String(right.platform)) ||
      String(left.url).localeCompare(String(right.url))
    )
  };
}

function publicOwner(owner) {
  return {
    batchSlug: owner.batchSlug,
    entityType: owner.entityType,
    entityId: owner.entityId,
    entityName: owner.entityName,
    companyId: owner.companyId,
    companyName: owner.companyName,
    companySlug: owner.companySlug
  };
}

function sameCompany(left, right) {
  return left?.batchSlug === right?.batchSlug && left?.companyId === right?.companyId;
}

function validationReceipt(candidate, status, values) {
  return {
    schemaVersion: YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
    videoId: candidate.videoId,
    physicalKey: candidate.physicalKey,
    canonicalUrl: candidate.canonicalUrl,
    status,
    checkedAt: new Date().toISOString(),
    ...values
  };
}

function rejectionDecision(reason, details = null) {
  return { accepted: false, reason, details, reasons: [reason] };
}

function addYouTubeAccountUrl(value, output) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    return;
  }
  const host = url.hostname.replace(/^www\./iu, "").toLowerCase();
  if (!["youtube.com", "m.youtube.com"].includes(host)) return;
  const parts = safeDecode(url.pathname).split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() === "channel" && parts[1]) {
    addChannelId(parts[1], output);
  } else if (parts[0]?.startsWith("@")) {
    addHandle(parts[0].slice(1), output);
  } else if (["c", "user"].includes(parts[0]?.toLowerCase()) && parts[1]) {
    const valueKey = compactIdentity(parts[1]);
    if (valueKey) output.keys.add(`${parts[0].toLowerCase()}:${valueKey}`);
  }
}

function addChannelId(value, output) {
  const id = String(value ?? "").trim();
  if (!/^UC[A-Za-z0-9_-]{8,}$/u.test(id)) return;
  const normalized = id.toLowerCase();
  output.channelIds.add(id);
  output.keys.add(`channel:${normalized}`);
}

function addHandle(value, output) {
  const handle = compactIdentity(value);
  if (!handle) return;
  output.handles.add(handle);
  output.keys.add(`handle:${handle}`);
}

function addAuthorName(value, output) {
  const name = normalizeName(value);
  if (name) output.add(name);
}

function youtubeHandleFromUrl(value) {
  try {
    const parts = new URL(String(value ?? "")).pathname.split("/").filter(Boolean);
    return parts[0]?.startsWith("@") ? parts[0].slice(1) : null;
  } catch {
    return null;
  }
}

function normalizedMetrics(value) {
  const metrics = {};
  for (const [key, raw] of Object.entries(value ?? {})) {
    const number = Number(raw);
    if (Number.isFinite(number) && number >= 0) metrics[key] = number;
  }
  if (Object.keys(metrics).length === 0) {
    return { views: 0, likes: 0, comments: 0 };
  }
  return Object.fromEntries(Object.entries(metrics).sort(([left], [right]) => left.localeCompare(right)));
}

function hasPositiveMetrics(metrics) {
  return Object.values(metrics ?? {}).some((value) => Number(value) > 0);
}

function finiteNonnegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function countBy(values, selector) {
  const counts = {};
  for (const value of values) {
    const key = String(selector(value) ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeBatchSlug(value) {
  const slug = String(value ?? "").trim().toUpperCase();
  if (["S2026", "S26", "A16ZSR006"].includes(slug)) return slug;
  if (slug === "SUMMER 2026") return "S26";
  return null;
}

function normalizeEntityType(value) {
  const type = String(value ?? "").trim().toLowerCase();
  return ["company", "founder"].includes(type) ? type : null;
}

function normalizePlatform(value) {
  const platform = String(value ?? "").trim().toLowerCase();
  return platform === "youtube" ? platform : null;
}

function companySlug(company) {
  return clean(company?.slug) ?? clean(company?.companySlug) ??
    clean(company?.sourceKey)?.replace(/^company-/u, "") ?? null;
}

function companyKey(batchSlug, companyId) {
  return `${batchSlug}|${companyId}`;
}

function scopedEntityKey(batchSlug, entityType, entityId) {
  return `${batchSlug}|${entityType}|${entityId}`;
}

function compareOwner(left, right) {
  return left.key.localeCompare(right.key);
}

function compareTrustReceipt(left, right) {
  return stableStringify(left).localeCompare(stableStringify(right));
}

function dedupeByStableValue(values) {
  return [...new Map(values.map((value) => [stableStringify(value), value])).values()];
}

function parseRawObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rawText(value) {
  return typeof value === "string" ? value : stableStringify(value ?? "");
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^A-Za-z0-9]+/gu, " ")
    .trim()
    .toLowerCase();
}

function compactIdentity(value) {
  return normalizeName(value).replaceAll(" ", "") || null;
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function nullableText(value) {
  return clean(value);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortDeep(value[key])])
    );
  }
  return value;
}
