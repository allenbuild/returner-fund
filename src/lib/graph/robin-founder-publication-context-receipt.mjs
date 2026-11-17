import { createHash } from "node:crypto";

export const ROBIN_FOUNDER_PUBLICATION_SOURCE = "native_owned_robin_founder_publication_context_v1";
export const ROBIN_FOUNDER_PUBLICATION_VALIDATION = "fall_2026_robin_founder_publication_ingestion_v1";
export const robinPublicationSha256 = (value) => createHash("sha256").update(value).digest("hex");
const hash = (value) => /^[a-f0-9]{64}$/.test(value ?? "");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const nativeIds = new Map([
  ["https://robinchoy.substack.com/p/every-yc-company-should-be-investing", "211370047"],
  ["https://robinchoy.substack.com/p/my-non-yc-approved-advice-to-yc-companies", "211369744"]
]);
function xAccount(value) {
  try { const url = new URL(value); return /^https:$/.test(url.protocol) && /^(?:www\.)?(?:x|twitter)\.com$/.test(url.hostname) && /^\/choyrb\/?$/i.test(url.pathname) && !url.username && !url.password && !url.port; } catch { return false; }
}
export function robinPublicationNativeFields(row) {
  return { id: Number(row.nativePostId), publication_id: row.nativePublicationId, canonical_url: row.sourceUrl,
    title: row.title, body_html: row.originalBodyHtml, post_date: row.postedAt,
    publishedBylines: row.nativePublishedBylines, audience: row.nativeAudience, is_published: row.nativeIsPublished };
}
export function robinFounderPublicationContextReasons(row, entity) {
  if (!row || typeof row !== "object" || !entity || typeof entity !== "object") return ["invalid_robin_publication_or_known_founder"];
  const reasons = [];
  let raw;
  try { raw = typeof row.rawVisibleText === "string" ? JSON.parse(row.rawVisibleText) : row.rawVisibleText; } catch { raw = null; }
  const knownX = entity.socialAccounts?.x;
  if (row.batchSlug !== "F26" || row.companySlug !== "adsideai" || row.companyName !== "Adside.ai" || row.entityType !== "founder"
    || row.entityId !== "founder-adsideai-robin-choy-406206" || row.founderId !== "406206" || row.authorName !== "Robin Choy"
    || entity.entityId !== row.entityId || entity.companySlug !== row.companySlug || entity.companyName !== row.companyName || entity.founderName !== row.authorName
    || !(Array.isArray(knownX) ? knownX : [knownX]).some(xAccount)) reasons.push("unproven_exact_robin_roster_founder");
  if (row.platform !== "web" || row.publisherPlatform !== "substack" || nativeIds.get(row.sourceUrl) !== row.nativePostId || row.platformPostId !== row.sourceUrl
    || !/^\d+$/.test(row.nativePostId ?? "") || row.nativePublicationId !== 2319101 || row.authorUrl !== "https://substack.com/@robinchoy1") reasons.push("invalid_exact_native_robin_publication_identity");
  if (row.identitySourceUrl !== "https://www.ycombinator.com/companies/adsideai") reasons.push("identity_source_must_be_official_company_profile");
  if (!row.metrics || Array.isArray(row.metrics) || Object.keys(row.metrics).length || row.contributionScore !== 0 || row.tractionStatus !== "unscored"
    || row.nativeSocialPostAdmission !== false || row.historyComplete !== false) reasons.push("founder_publication_must_be_unscored_context");
  if (typeof row.text !== "string" || !row.text.trim() || row.originalText !== row.text || typeof row.originalBodyHtml !== "string" || !row.originalBodyHtml.trim()
    || row.originalBodyHtmlSha256 !== robinPublicationSha256(row.originalBodyHtml) || row.bodyTruncated !== false || row.bodyPaywalled !== false) reasons.push("invalid_full_original_robin_publication_body");
  const posted = Date.parse(row.postedAt ?? ""), observed = Date.parse(row.observedAt ?? ""), rssDate = Date.parse(row.nativeFeedPublishedAtLiteral ?? "");
  if (!Number.isFinite(posted) || !Number.isFinite(observed) || !Number.isFinite(rssDate) || posted > observed
    || Math.floor(posted / 1000) !== Math.floor(rssDate / 1000) || row.nativePublishedAtLiteral !== row.postedAt) reasons.push("invalid_native_robin_publication_clock");
  const bylines = row.nativePublishedBylines;
  if (!Array.isArray(bylines) || bylines.length !== 1 || bylines[0].id !== 224124204 || bylines[0].name !== "Robin Choy" || bylines[0].handle !== "robinchoy1"
    || bylines[0].is_guest !== false || row.nativeAudience !== "everyone" || row.nativeIsPublished !== true) reasons.push("native_robin_publication_byline_or_access_conflict");
  const owner = row.officialFounderPublicationOwnership;
  if (!owner || owner.source !== "official_founder_native_profile_personal_site_publication_chain_v1"
    || owner.companySlug !== row.companySlug || owner.founderId !== row.founderId || owner.founderName !== row.authorName || owner.entityId !== row.entityId
    || owner.officialYcCompanyUrl !== row.identitySourceUrl || !xAccount(owner.officialXProfileUrl)
    || owner.personalWebsiteUrl !== "https://robinchoy.com/" || owner.publicationUrl !== "https://robinchoy.substack.com/" || owner.nativePublicationId !== 2319101
    || owner.nativeXProfileWebsiteAnchor?.href !== "https://t.co/t7XtL09Z8N" || owner.nativeXProfileWebsiteAnchor?.text !== "robinchoy.com"
    || !owner.nativeXProfileWebsiteAnchor?.anchorHtml?.includes('data-testid="UserUrl"') || !owner.nativeXProfileWebsiteAnchor.anchorHtml.includes('href="https://t.co/t7XtL09Z8N"')
    || !owner.personalHomepageFounderHeadingHtml?.includes(">Robin Choy</h1>") || !owner.personalHomepageSelfBiographyHtml?.includes("I'm a repeat founder")
    || !owner.personalHomepageSelfBiographyHtml.includes("Adside") || !owner.personalHomepageReciprocalXAnchorHtml?.includes('href="https://x.com/ChoyRb"')
    || !owner.publicationAnchorHtml?.includes('href="https://robinchoy.substack.com/"')
    || !hash(owner.nativeXProfileArchiveSha256) || !hash(owner.personalHomepageSha256) || !hash(owner.rosterSha256) || !hash(owner.ownershipInventorySha256)) reasons.push("unproven_exact_native_personal_site_publication_chain");
  if (!raw || raw.source !== ROBIN_FOUNDER_PUBLICATION_SOURCE || !equal(raw.ownership, owner) || !equal(raw.nativePost, robinPublicationNativeFields(row))
    || raw.text !== row.text || raw.nativeFeedPublishedAtLiteral !== row.nativeFeedPublishedAtLiteral || raw.observedAt !== row.observedAt
    || !Array.isArray(raw.archives) || !raw.archives.length || raw.archives.some((ref) => typeof ref.path !== "string" || !hash(ref.sha256))) reasons.push("robin_publication_native_receipt_conflict");
  const validation = raw?.validation;
  if (validation?.source !== ROBIN_FOUNDER_PUBLICATION_VALIDATION || validation.archiveHashesVerified !== true || validation.exactRosterFounderVerified !== true
    || validation.nativeOwnProfileAnchorVerified !== true || validation.personalSiteSelfBiographyAndReciprocalXVerified !== true || validation.literalOwnedPublicationAnchorVerified !== true
    || validation.fullNativePostPreloadAndHtmlVerified !== true || validation.fullRssBodyAndNativeClockVerified !== true
    || validation.originalTextSha256 !== robinPublicationSha256(row.text ?? "") || validation.originalBodyHtmlSha256 !== row.originalBodyHtmlSha256
    || validation.nativeFieldsSha256 !== robinPublicationSha256(JSON.stringify(robinPublicationNativeFields(row)))
    || validation.ownershipSha256 !== robinPublicationSha256(JSON.stringify(owner)) || validation.archivesSha256 !== robinPublicationSha256(JSON.stringify(raw?.archives))) reasons.push("unverified_robin_publication_ingestion_receipt");
  return [...new Set(reasons)];
}
export function isVerifiedRobinFounderPublicationContext(row, entity) {
  try { return row?.attributionProvenance === ROBIN_FOUNDER_PUBLICATION_SOURCE && row.review_state === "verified" && row.attributionStatus === "verified"
    && row.attributionMode === "author" && robinFounderPublicationContextReasons(row, entity).length === 0; } catch { return false; }
}
