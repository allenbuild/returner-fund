import { createHash } from "node:crypto";

export const FIRST_PARTY_RECOVERY_COHORTS = Object.freeze([
  "S2026",
  "S26",
  "A16ZSR006",
]);

export const FIRST_PARTY_REFERENCE_PATHS = Object.freeze([
  "src/lib/social/public-evidence-current.json",
  "src/lib/social/volume-evidence-current.json",
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/a16z-speedrun-006-social-evidence.json",
]);

export const FIRST_PARTY_CURRENT_CANDIDATE_PATHS = Object.freeze([
  "outputs/public-ingestion-review-ledger-current.json",
  "outputs/ingest-public-s2026.json",
  "outputs/source-hunt/a16z-tenth-pass.json",
  "outputs/source-hunt/final-cleanup-report.json",
  "outputs/source-hunt/rejected-candidates.json",
  "outputs/source-hunt/s26-regular-zero-sol-ultra.json",
  "outputs/source-hunt/s2026-yc-partners-followup-sol-ultra.json",
  "public/graph/s2026.json",
  "public/graph/s26.json",
  "public/graph/a16zsr006.json",
]);

export const FIRST_PARTY_HISTORY_PATHS = Object.freeze([
  "src/lib/social/public-evidence-current.json",
  "src/lib/social/volume-evidence-current.json",
  "outputs/public-ingestion-review-ledger-current.json",
  "outputs/ingest-public-s2026.json",
  "public/graph/s2026.json",
  "public/graph/s26.json",
  "public/graph/a16zsr006.json",
]);

const SUPPORTED_PLATFORMS = new Set(["rss", "web"]);
const TRACKING_QUERY_KEYS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "referrer",
  "source",
]);
const GENERIC_PAGE_SEGMENTS = new Set([
  "about",
  "account",
  "accounts",
  "api",
  "authors",
  "careers",
  "career",
  "company",
  "contact",
  "docs",
  "documentation",
  "download",
  "downloads",
  "features",
  "help",
  "home",
  "legal",
  "login",
  "newsletter",
  "people",
  "press",
  "pricing",
  "privacy",
  "product",
  "products",
  "profile",
  "register",
  "resources",
  "security",
  "signup",
  "solutions",
  "support",
  "team",
  "terms",
]);
const COLLECTION_PAGE_SEGMENTS = new Set([
  "archive",
  "archives",
  "author",
  "authors",
  "categories",
  "category",
  "feed",
  "feeds",
  "label",
  "labels",
  "search",
  "tag",
  "tags",
  "topics",
]);
const POST_CONTAINER_SEGMENTS = new Set([
  "advisories",
  "advisory",
  "article",
  "articles",
  "blog",
  "blogs",
  "case-studies",
  "case-study",
  "changelog",
  "customer-stories",
  "customers",
  "engineering",
  "guide",
  "guides",
  "insight",
  "insights",
  "journal",
  "learn",
  "news",
  "newsroom",
  "post",
  "posts",
  "press-release",
  "press-releases",
  "releases",
  "research",
  "stories",
  "story",
  "updates",
]);
const ASSET_EXTENSION =
  /\.(?:avif|css|gif|ico|jpe?g|js|json|map|mp3|mp4|pdf|png|svg|webm|webp|xml)$/i;
const GENERIC_TITLE =
  /^(?:(?:example|sample|test|untitled)(?:\b|$)|about|blog|careers?|changelog|contact|documentation|guides?|home|learn|newsletter|news|press|privacy|resources?|security|support|terms|updates?)$|\b(?:example|sample)\b.*\btemplate\b/i;
const HARD_REJECTION_SIGNAL =
  /(?:ambiguous|author[_ -]?conflict|foreign|invalid[_ -]?link|off[_ -]?domain|third[_ -]?party|unmapped|wrong[_ -]?company)/i;

export function buildOfficialDomainCatalog(graphSnapshots) {
  const byScopedEntity = new Map();
  const byScopedCompanySlug = new Map();
  const byScopedCompanyName = new Map();
  const batchesByEntityId = new Map();

  for (const graph of graphSnapshots ?? []) {
    const graphBatch = normalizeBatchSlug(
      graph?.batch?.slug ?? graph?.batchSlug,
    );
    for (const node of graph?.nodes ?? []) {
      if (node?.entityType !== "company") continue;
      const batchSlug = normalizeBatchSlug(node?.batchSlug) ?? graphBatch;
      const entityId = clean(node?.entityId);
      const companyName = clean(node?.label);
      const websiteUrl = normalizeUrl(node?.websiteUrl);
      const officialHost = hostFromUrl(websiteUrl);
      if (
        !batchSlug ||
        !entityId ||
        !companyName ||
        !websiteUrl ||
        !officialHost
      )
        continue;

      const companySlug = companySlugFrom(node, entityId);
      const company = addOwner({
        batchSlug,
        entityType: "company",
        entityId,
        entityName: companyName,
        companyId: entityId,
        companyName,
        companySlug,
        websiteUrl,
        officialHosts: [officialHost],
      });
      byScopedCompanySlug.set(scopedKey(batchSlug, companySlug), company);
      byScopedCompanyName.set(
        scopedKey(batchSlug, normalizeName(companyName)),
        company,
      );

      for (const founder of node?.founders ?? []) {
        const founderId = clean(founder?.id);
        const founderName = clean(founder?.name);
        if (!founderId || !founderName) continue;
        addOwner({
          batchSlug,
          entityType: "founder",
          entityId: founderId,
          entityName: founderName,
          companyId: entityId,
          companyName,
          companySlug,
          websiteUrl,
          officialHosts: [officialHost],
        });
      }
    }
  }

  return {
    byScopedEntity,
    byScopedCompanySlug,
    byScopedCompanyName,
    batchesByEntityId,
  };

  function addOwner(input) {
    const owner = {
      ...input,
      officialHosts: [...new Set(input.officialHosts)].sort(),
    };
    byScopedEntity.set(scopedKey(owner.batchSlug, owner.entityId), owner);
    const batches = batchesByEntityId.get(owner.entityId) ?? new Set();
    batches.add(owner.batchSlug);
    batchesByEntityId.set(owner.entityId, batches);
    return owner;
  }
}

export function resolveOfficialDomainOwner(
  row,
  catalog,
  { fallbackBatchSlug = null } = {},
) {
  const batchSlug =
    normalizeBatchSlug(row?.batchSlug ?? row?.batch_slug) ??
    normalizeBatchSlug(fallbackBatchSlug);
  const entityId = clean(
    row?.entityId ??
      row?.entity_id ??
      row?.nativeAuthorResolution?.owner?.entityId,
  );
  if (entityId) {
    if (batchSlug) {
      const owner = catalog?.byScopedEntity?.get(
        scopedKey(batchSlug, entityId),
      );
      if (owner) return owner;
    } else {
      const batches = catalog?.batchesByEntityId?.get(entityId);
      if (batches?.size === 1) {
        return (
          catalog.byScopedEntity.get(scopedKey([...batches][0], entityId)) ??
          null
        );
      }
    }
  }
  if (!batchSlug) return null;

  const companySlug = normalizeSlug(row?.companySlug ?? row?.company_slug);
  if (companySlug) {
    const owner = catalog?.byScopedCompanySlug?.get(
      scopedKey(batchSlug, companySlug),
    );
    if (owner) return owner;
  }
  const companyName = normalizeName(
    row?.companyName ?? row?.company_name ?? row?.attachedCompanyName,
  );
  return companyName
    ? (catalog?.byScopedCompanyName?.get(scopedKey(batchSlug, companyName)) ??
        null)
    : null;
}

export function buildFirstPartyReferenceIndex(documents) {
  const urlKeys = new Set();
  const contentKeys = new Set();
  let rows = 0;
  for (const document of documents ?? []) {
    for (const row of extractFirstPartyRows(document)) {
      rows += 1;
      const url = normalizeUrl(urlFromRow(row));
      if (url) urlKeys.add(url);
      const content = authoredContentFingerprint(row);
      if (content) contentKeys.add(content);
    }
  }
  return { rows, urlKeys, contentKeys };
}

export function evaluateFirstPartyAuthoredPost(
  row,
  {
    catalog,
    referenceIndex = { urlKeys: new Set(), contentKeys: new Set() },
    sourcePath = null,
    sourceKind = "current_artifact",
    fallbackBatchSlug = historyPathBatchSlug(sourcePath),
    observedAt = null,
  } = {},
) {
  const reasons = [];
  const platform = normalizePlatform(row?.platform);
  if (!SUPPORTED_PLATFORMS.has(platform))
    reasons.push("unsupported_recovery_platform");

  const owner = catalog
    ? resolveOfficialDomainOwner(row, catalog, { fallbackBatchSlug })
    : null;
  if (!owner) reasons.push("current_cohort_owner_not_resolved");

  const explicitBatchSlug = normalizeBatchSlug(
    row?.batchSlug ?? row?.batch_slug,
  );
  const pathBatchSlug = historyPathBatchSlug(sourcePath);
  if (
    explicitBatchSlug &&
    pathBatchSlug &&
    explicitBatchSlug !== pathBatchSlug
  ) {
    reasons.push("path_batch_scope_conflict");
  }

  const rawUrl = urlFromRow(row);
  const sourceUrl = normalizeUrl(rawUrl);
  if (!sourceUrl) reasons.push("stable_article_url_missing");
  const sourceHost = hostFromUrl(sourceUrl);
  if (
    owner &&
    sourceHost &&
    !matchesOfficialHost(sourceHost, owner.officialHosts)
  ) {
    reasons.push("outside_current_official_domain");
  }

  const title = clean(row?.title ?? row?.name);
  const text = authoredTextFromRow(row);
  const postedAt = timestampValue(
    row?.postedAt ??
      row?.publishedAt ??
      row?.published_at ??
      row?.createdAt ??
      row?.created_at ??
      row?.datePublished,
  );
  const observationAt = preferredTimestamp([
    row?.first_seen_at,
    row?.observedAt,
    row?.last_checked_at,
    row?.linkCheckedAt,
    observedAt,
  ]);
  if (!observationAt) reasons.push("observation_time_missing");
  if (!title || title.length < 8 || GENERIC_TITLE.test(title))
    reasons.push("authored_title_missing");
  if (!text || normalizeText(text).length < 20)
    reasons.push("authored_text_missing");
  if (!postedAt) reasons.push("publication_date_missing");
  if (
    postedAt &&
    observationAt &&
    Date.parse(postedAt) > Date.parse(observationAt)
  ) {
    reasons.push("publication_date_after_observation");
  }

  const urlClassification = sourceUrl
    ? classifyAuthoredPostUrl(sourceUrl, {
        platform,
        officialWebsiteUrl: owner?.websiteUrl,
        title,
      })
    : { accepted: false, reasons: ["stable_article_url_missing"] };
  reasons.push(...urlClassification.reasons);

  const reviewSignals = [
    row?.matchReason,
    row?.reason,
    ...(Array.isArray(row?.quarantineReasons) ? row.quarantineReasons : []),
    row?.nativeAuthorResolution?.reason,
  ]
    .filter(Boolean)
    .join(" ");
  if (HARD_REJECTION_SIGNAL.test(reviewSignals))
    reasons.push("source_has_hard_attribution_rejection");
  if (row?.linkStatus === "invalid") reasons.push("source_link_marked_invalid");

  if (owner?.entityType === "founder") {
    const authorName = normalizeName(
      row?.authorName ?? row?.author?.name ?? row?.byline ?? row?.creator,
    );
    if (!authorName || authorName !== normalizeName(owner.entityName)) {
      reasons.push("founder_byline_not_proven");
    }
  }

  const urlKey = sourceUrl;
  const contentKey = authoredContentFingerprint({
    ...row,
    title,
    text,
    postedAt,
  });
  if (urlKey && referenceIndex?.urlKeys?.has(urlKey))
    reasons.push("already_in_current_evidence");
  if (contentKey && referenceIndex?.contentKeys?.has(contentKey)) {
    reasons.push("content_already_in_current_evidence");
  }

  const accepted = reasons.length === 0;
  const candidate = accepted
    ? projectFirstPartyCandidate({
        row,
        owner,
        platform,
        sourceUrl,
        title,
        text,
        postedAt,
        sourcePath,
        sourceKind,
        contentKey,
        sourceHost,
        observationAt,
      })
    : null;

  return {
    accepted,
    reasons: [...new Set(reasons)].sort(),
    owner,
    platform,
    sourceUrl,
    contentKey,
    candidate,
    sourcePath,
    sourceKind,
  };
}

export function classifyAuthoredPostUrl(
  value,
  { platform = null, officialWebsiteUrl = null, title = null } = {},
) {
  const reasons = [];
  const normalized = normalizeUrl(value);
  if (!normalized)
    return { accepted: false, reasons: ["stable_article_url_missing"] };
  if (
    /redacted(?:[-_ ]public)?(?:[-_ ]token)?/i.test(
      decodeURIComponentSafe(normalized),
    )
  ) {
    return { accepted: false, reasons: ["redacted_article_url_not_stable"] };
  }
  const url = new URL(normalized);
  const segments = url.pathname
    .split("/")
    .map((segment) => decodeURIComponentSafe(segment).trim().toLowerCase())
    .filter(Boolean);
  const official = normalizeUrl(officialWebsiteUrl);

  if (official && equivalentPageUrl(normalized, official))
    reasons.push("official_homepage_not_post");
  if (segments.length === 0) reasons.push("official_homepage_not_post");
  if (
    segments.length === 1 &&
    /^(?:[a-z]{2}(?:-[a-z]{2})?)$/i.test(segments[0])
  ) {
    reasons.push("localized_homepage_not_post");
  }
  if (ASSET_EXTENSION.test(url.pathname)) reasons.push("asset_url_not_post");
  if (segments.some((segment) => COLLECTION_PAGE_SEGMENTS.has(segment))) {
    reasons.push("collection_or_search_page_not_post");
  }
  if (segments.length === 1 && GENERIC_PAGE_SEGMENTS.has(segments[0])) {
    reasons.push("generic_website_page_not_post");
  }

  const hasPostContainer = segments.some((segment) =>
    POST_CONTAINER_SEGMENTS.has(segment),
  );
  if (
    segments.some((segment) => GENERIC_PAGE_SEGMENTS.has(segment)) &&
    !hasPostContainer
  ) {
    reasons.push("generic_website_page_not_post");
  }
  if (segments.length === 1 && hasPostContainer) {
    reasons.push("collection_or_search_page_not_post");
  }
  const hasDatePath = segments.some((segment) => /^20\d{2}$/.test(segment));
  const hasStableSlug =
    segments.length >= 1 &&
    !GENERIC_PAGE_SEGMENTS.has(segments.at(-1)) &&
    !COLLECTION_PAGE_SEGMENTS.has(segments.at(-1)) &&
    /[a-z0-9]/i.test(segments.at(-1)) &&
    segments.at(-1).length >= 4;
  if (platform === "web" && !hasPostContainer && !hasDatePath) {
    reasons.push("generic_web_page_without_post_path");
  }
  if (!hasStableSlug) reasons.push("stable_article_slug_missing");
  if (title && GENERIC_TITLE.test(String(title).trim()))
    reasons.push("generic_page_title_not_post");

  return {
    accepted: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
    normalizedUrl: normalized,
    hasPostContainer,
    hasDatePath,
  };
}

export function reconcileFirstPartyCandidates(
  evaluations,
  { referenceIndex } = {},
) {
  const accepted = (evaluations ?? [])
    .filter((evaluation) => evaluation?.accepted && evaluation?.candidate)
    .sort(compareEvaluations);
  const rejected = (evaluations ?? []).filter(
    (evaluation) => !evaluation?.accepted,
  );
  const byUrl = new Map();
  const duplicateUrlRows = [];
  for (const evaluation of accepted) {
    const existing = byUrl.get(evaluation.sourceUrl);
    if (!existing) {
      byUrl.set(evaluation.sourceUrl, evaluation);
      continue;
    }
    duplicateUrlRows.push(evaluation);
    if (candidateQuality(evaluation) > candidateQuality(existing)) {
      byUrl.set(evaluation.sourceUrl, evaluation);
    }
  }

  const byContent = new Map();
  const duplicateContentRows = [];
  for (const evaluation of [...byUrl.values()].sort(compareEvaluations)) {
    if (!evaluation.contentKey) {
      byContent.set(`url:${evaluation.sourceUrl}`, evaluation);
      continue;
    }
    const existing = byContent.get(evaluation.contentKey);
    if (!existing) {
      byContent.set(evaluation.contentKey, evaluation);
      continue;
    }
    duplicateContentRows.push(evaluation);
    if (candidateQuality(evaluation) > candidateQuality(existing)) {
      byContent.set(evaluation.contentKey, evaluation);
    }
  }

  const finalEvaluations = [...byContent.values()].sort(compareEvaluations);
  const evidence = finalEvaluations.map((evaluation) => evaluation.candidate);
  const urls = evidence.map((row) => normalizeUrl(row.sourceUrl));
  const contentKeys = evidence.map(authoredContentFingerprint).filter(Boolean);
  const referenceUrlOverlap = urls.filter((url) =>
    referenceIndex?.urlKeys?.has(url),
  );
  const referenceContentOverlap = contentKeys.filter((key) =>
    referenceIndex?.contentKeys?.has(key),
  );

  return {
    evidence,
    finalEvaluations,
    audit: {
      evaluatedRows: evaluations?.length ?? 0,
      acceptedBeforeDeduplication: accepted.length,
      rejectedRows: rejected.length,
      duplicateCandidateUrls: duplicateUrlRows.length,
      duplicateCandidateContent: duplicateContentRows.length,
      finalCandidates: evidence.length,
      uniqueCandidateUrls: new Set(urls).size,
      uniqueCandidateContent: new Set(contentKeys).size,
      referenceUrlOverlap: referenceUrlOverlap.length,
      referenceContentOverlap: referenceContentOverlap.length,
      zeroDuplicateAudit:
        evidence.length === new Set(urls).size &&
        contentKeys.length === new Set(contentKeys).size &&
        referenceUrlOverlap.length === 0 &&
        referenceContentOverlap.length === 0,
      rejectionCounts: countRejections(rejected),
    },
  };
}

export function buildFirstPartyPromotionArtifact({
  baselineCommit,
  generatedAt,
  sources,
  reconciliation,
  scanAudit = {},
}) {
  const evidence = [...(reconciliation?.evidence ?? [])].sort(
    compareCandidateRows,
  );
  const byCohort = {};
  const byPlatform = {};
  const byCohortSource = {};
  let zeroEngagement = 0;
  for (const row of evidence) {
    byCohort[row.batchSlug] = (byCohort[row.batchSlug] ?? 0) + 1;
    byPlatform[row.platform] = (byPlatform[row.platform] ?? 0) + 1;
    const source = row._recoveryProvenance?.sourceKind ?? "unknown";
    const key = `${row.batchSlug}:${source}`;
    byCohortSource[key] = (byCohortSource[key] ?? 0) + 1;
    if (Object.values(row.metrics ?? {}).every((value) => Number(value) === 0))
      zeroEngagement += 1;
  }
  return {
    schemaVersion: "first-party-authored-post-promotion-candidate.v1",
    generatedAt,
    baselineCommit,
    constraints: {
      networkMode: "offline_or_anonymous_public_only",
      linkedinAccess: false,
      exactCurrentOfficialDomainRequired: true,
      stableArticleItemUrlRequired: true,
      titleTextDateProvenanceRequired: true,
      zeroEngagementPermittedWithProvenance: true,
      canonicalArtifactsModified: false,
    },
    sources: [...new Set(sources ?? [])].sort(),
    counts: {
      total: evidence.length,
      zeroEngagement,
      byCohort: sortRecord(byCohort),
      byPlatform: sortRecord(byPlatform),
      byCohortSource: sortRecord(byCohortSource),
    },
    audit: {
      ...scanAudit,
      ...reconciliation.audit,
    },
    evidence,
  };
}

export function extractFirstPartyRows(document) {
  const rows = [];
  const seenObjects = new Set();
  visit(document);
  return rows;

  function visit(value) {
    if (!value || typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (looksLikeFirstPartyRow(value)) rows.push(value);
    for (const child of Object.values(value)) visit(child);
  }
}

export function authoredContentFingerprint(row) {
  const title = normalizeText(row?.title ?? row?.name);
  const text = normalizeText(authoredTextFromRow(row));
  if (!title || text.length < 20) return null;
  return sha256(`${title}\n${text}`);
}

export function normalizeUrl(value) {
  const raw = clean(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.pathname =
      url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function stableJson(value) {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

function projectFirstPartyCandidate({
  row,
  owner,
  platform,
  sourceUrl,
  title,
  text,
  postedAt,
  sourcePath,
  sourceKind,
  contentKey,
  sourceHost,
  observationAt,
}) {
  const metrics = normalizeMetrics(row?.metrics ?? row?.counts);
  const checkedAt = preferredTimestamp([
    row?.last_checked_at,
    row?.linkCheckedAt,
    row?.first_seen_at,
    observationAt,
  ]);
  const firstSeenAt =
    preferredTimestamp([row?.first_seen_at, observationAt, checkedAt]) ??
    postedAt;
  const lastUpdatedAt = timestampAtOrBefore(
    row?.last_updated_at ?? row?.updatedAt ?? row?.updated_at,
    observationAt,
  ) ?? postedAt;
  const id = `first-party-${platform}-${sha256(
    `${owner.batchSlug}|${owner.entityId}|${sourceUrl}`,
  ).slice(0, 24)}`;
  return {
    id,
    batchSlug: owner.batchSlug,
    entityType: owner.entityType,
    entityId: owner.entityId,
    entityName: owner.entityName,
    companySlug: owner.companySlug,
    companyName: owner.companyName,
    platform,
    title: boundedText(title, 300),
    sourceUrl,
    platformPostId: sourceUrl,
    text: boundedText(text, 2_000),
    rawVisibleText: stableJson({
      recovery: "first_party_authored_post",
      sourcePath,
      sourceKind,
      officialWebsiteUrl: owner.websiteUrl,
      officialHost: sourceHost,
      sourceEvidenceId: clean(row?.id),
      title,
      postedAt,
      observedAt: observationAt,
      zeroEngagementAccepted: Object.values(metrics).every(
        (value) => Number(value) === 0,
      ),
    }).trim(),
    postedAt,
    publishedAtPrecision: publicationPrecisionFromRow(row, postedAt),
    metrics,
    contributionScore: finiteNumber(row?.contributionScore) ?? 0,
    review_state: "verified",
    linkStatus: "verified",
    ...(checkedAt
      ? { linkCheckedAt: checkedAt, last_checked_at: checkedAt }
      : {}),
    first_seen_at: firstSeenAt,
    last_updated_at: lastUpdatedAt,
    matchReason:
      `Verified first-party ${platform.toUpperCase()} authored item on the current official ` +
      `${owner.companyName} domain; title, text, date, and stable item URL are preserved.`,
    attributionVersion: 3,
    attributionStatus: "verified",
    attributionMode:
      owner.entityType === "founder" ? "account_owner" : "subject",
    attributionSignals: [
      "current_cohort_owner",
      "exact_current_official_domain",
      "stable_authored_item_url",
      "title_text_date_provenance",
      ...(platform === "rss" ? ["verified_first_party_feed_item"] : []),
    ],
    _recoveryProvenance: {
      schemaVersion: 1,
      sourcePath,
      sourceKind,
      sourceEvidenceId: clean(row?.id),
      officialWebsiteUrl: owner.websiteUrl,
      officialHost: sourceHost,
      contentSha256: contentKey,
      zeroEngagementAccepted: Object.values(metrics).every(
        (value) => Number(value) === 0,
      ),
    },
  };
}

function looksLikeFirstPartyRow(value) {
  const platform = normalizePlatform(value?.platform);
  return SUPPORTED_PLATFORMS.has(platform) && Boolean(urlFromRow(value));
}

function urlFromRow(row) {
  return clean(
    row?.sourceUrl ??
      row?.candidateUrl ??
      row?.url ??
      row?.nativeUrl ??
      row?.exactUrl ??
      row?.canonicalUrl ??
      row?.link,
  );
}

function authoredTextFromRow(row) {
  for (const value of [
    row?.text,
    row?.description,
    row?.summary,
    row?.content,
  ]) {
    const cleaned = clean(value);
    if (cleaned) return cleaned;
  }
  const raw = clean(row?.rawVisibleText);
  return raw && !looksLikeCompactJson(raw) ? raw : null;
}

function normalizeMetrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [key, raw] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const number = finiteNumber(raw);
    if (number !== null && number >= 0) output[key] = number;
  }
  return output;
}

function compareEvaluations(left, right) {
  return (
    String(left?.owner?.batchSlug).localeCompare(
      String(right?.owner?.batchSlug),
    ) ||
    String(left?.owner?.entityId).localeCompare(
      String(right?.owner?.entityId),
    ) ||
    String(left?.sourceUrl).localeCompare(String(right?.sourceUrl)) ||
    String(left?.sourcePath).localeCompare(String(right?.sourcePath))
  );
}

function compareCandidateRows(left, right) {
  return (
    String(left?.batchSlug).localeCompare(String(right?.batchSlug)) ||
    String(left?.entityId).localeCompare(String(right?.entityId)) ||
    String(left?.sourceUrl).localeCompare(String(right?.sourceUrl))
  );
}

function candidateQuality(evaluation) {
  const sourcePriority =
    {
      anonymous_public_refresh: 4,
      current_review_ledger: 3,
      current_artifact: 2,
      repository_history: 1,
    }[evaluation?.sourceKind] ?? 0;
  return (
    sourcePriority * 1_000_000 +
    normalizeText(evaluation?.candidate?.text).length
  );
}

function countRejections(evaluations) {
  const counts = {};
  for (const evaluation of evaluations) {
    for (const reason of evaluation?.reasons ?? [])
      counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return sortRecord(counts);
}

function normalizeBatchSlug(value) {
  const raw = clean(value)
    ?.toUpperCase()
    .replace(/[\s_-]+/g, "");
  if (!raw) return null;
  if (["S2026", "SPRING2026", "YCSPRING2026"].includes(raw)) return "S2026";
  if (["S26", "SUMMER2026", "YCSUMMER2026"].includes(raw)) return "S26";
  if (["A16ZSR006", "A16ZSPEEDRUN006", "SPEEDRUN006"].includes(raw))
    return "A16ZSR006";
  return FIRST_PARTY_RECOVERY_COHORTS.includes(raw) ? raw : null;
}

function historyPathBatchSlug(value) {
  const path = String(value ?? "").toLowerCase();
  if (path.includes("a16zsr006")) return "A16ZSR006";
  if (/(?:^|\/)s2026(?:[.-]|\/)/.test(path)) return "S2026";
  if (/(?:^|\/)s26(?:[.-]|\/)/.test(path)) return "S26";
  return null;
}

function companySlugFrom(node, entityId) {
  const explicit = normalizeSlug(node?.companySlug ?? node?.slug);
  if (explicit) return explicit;
  return normalizeSlug(
    String(entityId)
      .replace(/^company-/, "")
      .replace(/^a16z-speedrun-006-/, ""),
  );
}

function normalizeSlug(value) {
  return (
    clean(value)
      ?.toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || null
  );
}

function normalizeName(value) {
  return (
    clean(value)
      ?.toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim() || null
  );
}

function normalizePlatform(value) {
  const platform = clean(value)?.toLowerCase().replace(/-/g, "_");
  return platform === "atom" || platform === "feed" ? "rss" : platform;
}

function normalizeText(value) {
  return (
    clean(value)
      ?.normalize("NFKC")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim() || ""
  );
}

function matchesOfficialHost(candidateHost, officialHosts) {
  return (officialHosts ?? []).some(
    (officialHost) =>
      candidateHost === officialHost ||
      candidateHost.endsWith(`.${officialHost}`),
  );
}

function hostFromUrl(value) {
  try {
    return value
      ? new URL(value).hostname.toLowerCase().replace(/^www\./, "")
      : null;
  } catch {
    return null;
  }
}

function equivalentPageUrl(left, right) {
  const leftUrl = new URL(left);
  const rightUrl = new URL(right);
  return (
    leftUrl.hostname === rightUrl.hostname &&
    normalizePath(leftUrl.pathname) === normalizePath(rightUrl.pathname)
  );
}

function normalizePath(value) {
  return String(value ?? "").replace(/\/+$/, "") || "/";
}

function timestampValue(value) {
  const raw = clean(value);
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return null;
  const year = new Date(timestamp).getUTCFullYear();
  return year >= 2000 && year <= 2100
    ? new Date(timestamp).toISOString()
    : null;
}

function preferredTimestamp(values) {
  for (const value of values ?? []) {
    const timestamp = timestampValue(value);
    if (timestamp) return timestamp;
  }
  return null;
}

function timestampAtOrBefore(value, upperBound) {
  const timestamp = timestampValue(value);
  const maximum = timestampValue(upperBound);
  if (!timestamp) return null;
  if (!maximum || Date.parse(timestamp) <= Date.parse(maximum)) return timestamp;
  return maximum;
}

function publicationPrecisionFromRow(row, postedAt) {
  const explicit = clean(row?.publishedAtPrecision);
  if (explicit) return explicit;
  const raw = clean(
    row?.postedAt ??
      row?.publishedAt ??
      row?.published_at ??
      row?.createdAt ??
      row?.created_at ??
      row?.datePublished,
  );
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return "day";
  return postedAt?.endsWith("T00:00:00.000Z") ? "day" : "exact";
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedText(value, limit) {
  const text = clean(value) ?? "";
  return text.length <= limit
    ? text
    : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function looksLikeCompactJson(value) {
  const text = String(value).trim();
  return text.startsWith("{") && text.endsWith("}");
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function scopedKey(...values) {
  return values.map((value) => String(value ?? "")).join("\u0000");
}

function clean(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function sortRecord(value) {
  return Object.fromEntries(
    Object.entries(value ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortDeep(child)]),
  );
}
