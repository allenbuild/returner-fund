import { createHash } from "node:crypto";
export const OFFICIAL_PUBLICATION_CONTEXT_SOURCE = "official_company_publication_article_v1";
export const OFFICIAL_PUBLICATION_CONTEXT_VALIDATION = "fall_2026_official_publication_article_ingestion_v1";
export const publicationContextSha256 = (value) => createHash("sha256").update(value).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = (value) => /^[a-f0-9]{64}$/.test(value ?? "");
const urlKey = (value) => { try { const u = new URL(value); return u.href.replace(/\/$/, ""); } catch { return null; } };
export function officialPublicationReceipt(row) {
  try { return typeof row?.rawVisibleText === "string" ? JSON.parse(row.rawVisibleText) : row?.rawVisibleText; } catch { return null; }
}
export function officialPublicationNativeFields(row) {
  return { id: row.nativePostId, publication_id: row.nativePublicationId, canonical_url: row.sourceUrl, title: row.title,
    body_html: row.originalBodyHtml, post_date: row.postedAt, publishedBylines: row.nativePublishedBylines,
    audience: row.nativeAudience, is_published: row.nativeIsPublished, nativeFeedPublishedAtLiteral: row.nativeFeedPublishedAtLiteral };
}

/** Only the explicitly homepage-linked Particularity publication is admitted by this lane. */
export function officialPublicationArticleContextReasons(row, company) {
  if (!row || typeof row !== "object" || !company || typeof company !== "object") return ["invalid_publication_article_or_company"];
  const reasons = [], raw = officialPublicationReceipt(row), owner = row.officialPublicationOwnership;
  if (company.slug !== "particularity" || row.companySlug !== company.slug || row.companyName !== company.name || row.batchSlug !== "F26" || row.entityType !== "company" || row.entityId !== `company-${company.slug}`) reasons.push("unresolved_exact_official_publication_owner");
  if (row.platform !== "web" || row.publisherPlatform !== "substack" || row.platformPostId !== row.sourceUrl || !/^\d+$/.test(row.nativePostId ?? "") || row.nativePublicationId !== 6322238) reasons.push("invalid_native_publication_identity");
  try {
    const url = new URL(row.sourceUrl);
    if (url.origin !== "https://particularity.substack.com" || !/^\/p\/[^/]+$/.test(url.pathname) || url.search || url.hash) reasons.push("article_outside_exact_official_publication");
  } catch { reasons.push("invalid_native_publication_article_url"); }
  if (row.metrics === null || typeof row.metrics !== "object" || Array.isArray(row.metrics) || Object.keys(row.metrics).length || row.contributionScore !== 0 || (row.tractionStatus !== undefined && row.tractionStatus !== "unscored")) reasons.push("publication_context_must_have_zero_score_and_no_metrics");
  if (typeof row.text !== "string" || !row.text.trim() || (row.originalText !== undefined && row.originalText !== row.text) || typeof row.originalBodyHtml !== "string" || !row.originalBodyHtml.trim() || row.originalBodyHtmlSha256 !== publicationContextSha256(row.originalBodyHtml)) reasons.push("invalid_publication_original_body");
  if (!raw || raw.source !== OFFICIAL_PUBLICATION_CONTEXT_SOURCE || raw.company?.slug !== row.companySlug || raw.company?.name !== row.companyName || raw.company?.entityId !== row.entityId || raw.post?.nativePostId !== row.nativePostId || raw.post?.sourceUrl !== row.sourceUrl || raw.post?.title !== row.title || raw.post?.text !== row.text || raw.post?.nativePublishedAtLiteral !== row.postedAt || raw.post?.nativePublicationId !== row.nativePublicationId || !equal(raw.post?.nativePublishedBylines, row.nativePublishedBylines)) reasons.push("publication_article_receipt_conflict");
  if (!owner || owner.source !== "official_company_homepage_publication_anchor_v1" || owner.companySlug !== row.companySlug || owner.companyName !== row.companyName || owner.officialYcProfileUrl !== company.ycProfileUrl || urlKey(owner.officialWebsite) !== urlKey(company.websiteUrl) || urlKey(owner.discoveredOn) !== urlKey(company.websiteUrl) || owner.publicationUrl !== "https://particularity.substack.com/" || owner.nativePublicationId !== 6322238 || owner.anchorText !== "Substack" || !equal(raw?.officialPublicationOwnership, owner) || !hash(owner.officialHomepageSha256) || !hash(owner.ownershipInventorySha256) || typeof owner.anchorHtml !== "string") reasons.push("unproven_exact_official_publication_footer_ownership");
  for (const [rowKey, rawKey] of [["sourceHtmlSha256", "sourceHtmlSha256"], ["nativePostArchiveSha256", "nativePostArchiveSha256"], ["originalBodyHtmlSha256", "originalBodyHtmlSha256"]]) if (!hash(row[rowKey]) || raw?.[rawKey] !== row[rowKey]) reasons.push("missing_publication_native_archive_hash");
  if (raw?.sourceHtmlArchivePath !== row.fullOriginalHtmlArchivePath || raw?.nativePostArchivePath !== row.nativePostArchivePath || !hash(raw?.nativeFeedArchiveSha256) || typeof raw?.nativeFeedArchivePath !== "string") reasons.push("publication_archive_path_receipt_conflict");
  const posted = Date.parse(row.postedAt ?? ""), observed = Date.parse(row.observedAt ?? "");
  if (!Number.isFinite(posted) || !Number.isFinite(observed) || posted > observed || row.nativePublishedAtLiteral !== row.postedAt || Math.floor(posted / 1000) !== Math.floor(Date.parse(row.nativeFeedPublishedAtLiteral ?? "") / 1000)) reasons.push("invalid_future_or_conflicting_publication_clock");
  if (row.nativeAudience !== "everyone" || row.nativeIsPublished !== true || row.bodyPaywalled !== false || row.bodyCompleteness !== "full_native_publication_body_html") reasons.push("publication_body_not_verified_full_public_article");
  if (!Array.isArray(row.nativePublishedBylines) || !row.nativePublishedBylines.length || row.authorName !== row.nativePublishedBylines.map((byline) => byline.name).filter(Boolean).join(", ")) reasons.push("native_publication_byline_conflict");
  return [...new Set(reasons)];
}

export function isVerifiedOfficialPublicationArticleContext(row, company) {
  try {
    if (officialPublicationArticleContextReasons(row, company).length || row.review_state !== "verified" || row.attributionStatus !== "verified" || row.attributionMode !== "publisher" || row.attributionProvenance !== OFFICIAL_PUBLICATION_CONTEXT_SOURCE || row.tractionStatus !== "unscored" || typeof row.originalText !== "string") return false;
    const raw = officialPublicationReceipt(row), validation = raw.validation;
    return validation?.source === OFFICIAL_PUBLICATION_CONTEXT_VALIDATION && validation.archiveHashesVerified === true && validation.nativePostFieldsVerified === true && validation.nativeFeedEntryVerified === true && validation.exactOfficialFooterAnchorVerified === true &&
      validation.originalBodySha256 === publicationContextSha256(row.originalText) && validation.nativeFieldsSha256 === publicationContextSha256(JSON.stringify(officialPublicationNativeFields(row))) &&
      validation.nativePostArchiveSha256 === row.nativePostArchiveSha256 && validation.sourceHtmlSha256 === row.sourceHtmlSha256 &&
      validation.officialHomepageSha256 === row.officialPublicationOwnership.officialHomepageSha256 && validation.ownershipInventorySha256 === row.officialPublicationOwnership.ownershipInventorySha256 && validation.nativeFeedArchiveSha256 === raw.nativeFeedArchiveSha256;
  } catch { return false; }
}
