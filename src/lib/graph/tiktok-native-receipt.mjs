import { createHash } from "node:crypto";

export const NATIVE_TIKTOK_SOURCE = "authorized_native_tiktok_dom_v1";
export const NATIVE_TIKTOK_VALIDATION = "fall_2026_native_tiktok_ingestion_v1";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const digest = (value) => /^[a-f0-9]{64}$/.test(value ?? "");
const listingWhitespace = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const host = (value) => { try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } };

export function tiktokNativeIdentity(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["tiktok.com", "www.tiktok.com", "m.tiktok.com"].includes(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/^\/@([A-Za-z0-9._-]+)(?:\/(video|photo)\/(\d+))?\/?$/);
    return match ? { handle: match[1].toLowerCase(), kind: match[2] ?? null, postId: match[3] ?? null, profileUrl: `https://www.tiktok.com/@${match[1].toLowerCase()}` } : null;
  } catch { return null; }
}

export function nativeTikTokMetrics(post) {
  const fields = { "browse-like-count": "likes", "browse-comment-count": "comments", "browse-favorite-count": "saves" };
  const metrics = {};
  for (const label of post?.metricLabels ?? []) {
    const key = fields[label.nativeField];
    if (!key || !/^\d[\d,]*$/.test(label.text ?? "")) continue;
    const number = Number(label.text.replaceAll(",", ""));
    if (Number.isSafeInteger(number) && number >= 0) metrics[key] = number;
  }
  return metrics;
}

export function verifiedNativeTikTokReasons(row, company) {
  const reasons = [];
  let raw;
  try { raw = JSON.parse(row?.rawVisibleText); } catch { return ["missing_native_tiktok_receipt"]; }
  const post = raw?.post, native = post?.nativeObservation, proof = raw?.identityProof, validation = raw?.validation;
  const identity = tiktokNativeIdentity(row?.sourceUrl), owner = tiktokNativeIdentity(row?.accountUrl);
  const slug = company?.slug ?? company?.companySlug;
  const companyName = company?.name ?? company?.companyName;
  const website = company?.websiteUrl;
  if (row?.batchSlug !== "F26" || row?.platform !== "tiktok" || row?.entityType !== "company" || row?.entityId !== `company-${slug}` || row?.companyName !== companyName) reasons.push("tiktok_canonical_company_conflict");
  if (raw?.source !== NATIVE_TIKTOK_SOURCE || !post || !native || validation?.source !== NATIVE_TIKTOK_VALIDATION) return [...reasons, "missing_native_tiktok_receipt"];
  if (row.review_state !== "verified" || row.attributionVersion !== 3 || row.attributionStatus !== "verified" || row.attributionMode !== "author" || row.attributionProvenance !== NATIVE_TIKTOK_SOURCE || !["official_website_exact_tiktok_account", "native_tiktok_post_author", "visible_native_tiktok_video"].every((signal) => row.attributionSignals?.includes(signal))) reasons.push("tiktok_verified_attribution_required");
  if (!identity?.postId || identity.postId !== row.platformPostId || identity.postId !== post.id || identity.postId !== native.nativePostId || tiktokNativeIdentity(post.url)?.postId !== identity.postId || tiktokNativeIdentity(native.url)?.postId !== identity.postId) reasons.push("tiktok_native_id_conflict");
  if (!owner || owner.postId || owner.handle !== identity?.handle || post.authorHandle !== owner.handle || native.authorHandle !== owner.handle || tiktokNativeIdentity(native.authorProfileUrl)?.handle !== owner.handle || row.authorHandle !== owner.handle) reasons.push("tiktok_native_author_conflict");
  const outbound = proof?.officialOutboundReceipt;
  const anchorHref = outbound?.anchorHtml?.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
  if (proof?.source !== "official_company_website_tiktok_account_v1" || proof.companySlug !== slug || proof.companyName !== companyName || proof.entityId !== row.entityId || proof.review_state !== "verified" || tiktokNativeIdentity(proof.profileUrl)?.handle !== owner?.handle || proof.officialYcCompanyUrl !== `https://www.ycombinator.com/companies/${slug}` || !host(website) || host(proof.officialWebsite) !== host(website) || outbound?.companySlug !== slug || outbound?.platform !== "tiktok" || outbound?.ownershipStatus !== "official_company_account_or_community_link" || host(outbound.discoveredOn) !== host(website) || tiktokNativeIdentity(outbound.sourceUrl)?.handle !== owner?.handle || tiktokNativeIdentity(anchorHref)?.handle !== owner?.handle || !digest(outbound.sourceHtmlSha256) || !digest(proof.inventorySha256)) reasons.push("tiktok_official_website_ownership_conflict");
  if (validation.archiveHashesVerified !== true || validation.literalOfficialAnchorVerified !== true || validation.nativeProfileMatched !== true || validation.inventorySha256 !== proof?.inventorySha256 || validation.sourceHtmlSha256 !== outbound?.sourceHtmlSha256 || validation.identityProofSha256 !== hash(proof) || validation.nativeObservationSha256 !== hash(native)) reasons.push("tiktok_ingestion_validation_conflict");
  const profile = raw.nativeProfile;
  const listed = profile?.postLinks?.find((entry) => tiktokNativeIdentity(entry.url)?.postId === identity?.postId);
  const nativeNames = [owner?.handle, native.authorDisplayName].filter(Boolean);
  const profileLines = String(profile?.nativeText ?? "").split("\n");
  const handleIndex = profileLines.indexOf(owner?.handle);
  const profileHeader = profileLines.slice(0, 2).includes(owner?.handle) ||
    profile?.title?.includes(`(@${owner?.handle})`) && handleIndex >= 1 && /^\d[\d,]*$/.test(profileLines[handleIndex + 1] ?? "") && profileLines[handleIndex + 2] === "Following";
  if (tiktokNativeIdentity(profile?.url)?.handle !== owner?.handle || !profileHeader || !listed || !nativeNames.some((name) => String(listed.imageAlt ?? "").includes(`created by ${name}`))) reasons.push("tiktok_native_profile_listing_conflict");
  if (native.captionElementPresent !== true || typeof native.caption !== "string" || native.nativeText !== native.caption || post.text !== native.caption || row.text !== native.caption || (row.originalText ?? "") !== native.caption || !listingWhitespace(listed?.imageAlt).startsWith(listingWhitespace(native.caption))) reasons.push("tiktok_native_caption_conflict");
  const empty = native.caption === "";
  if (empty && (row.contributionScore !== 0 || row.tractionStatus !== "unscored")) reasons.push("tiktok_captionless_metadata_must_be_unscored");
  if (Boolean(row.captionAbsent) !== empty || Boolean(post.captionAbsent) !== empty || (empty && (!native.media?.length || !native.controls?.some((control) => /^\d[\d,]* Likes?$/.test(control.label ?? ""))))) reasons.push("tiktok_caption_absence_receipt_conflict");
  const metrics = nativeTikTokMetrics(native);
  if (!equal(metrics, row.metrics) || !equal(metrics, post.metrics) || Object.values(metrics).some((value) => !Number.isSafeInteger(value) || value < 0)) reasons.push("tiktok_native_metric_conflict");
  const likeControl = native.controls?.find((control) => /^\d[\d,]* Likes?$/.test(control.label ?? ""));
  if (metrics.likes !== undefined && Number(likeControl?.label?.match(/^[\d,]+/)?.[0]?.replaceAll(",", "")) !== metrics.likes) reasons.push("tiktok_native_like_control_conflict");
  // Yearless UI labels are not a publication date. Native IDs are never decoded.
  if (row.postedAt !== null || row.publishedAtPrecision !== "unknown" || native.publishedAt !== null || native.times?.length || !["unknown_year_month_day_label_only", "native_label_without_full_datetime"].includes(native.publicationPrecision) || !nativeNames.some((name) => native.nativeDateLabel?.includes(name))) reasons.push("tiktok_unknown_publication_date_conflict");
  if (!Number.isFinite(Date.parse(native.observedAt)) || raw.observedAt !== native.observedAt || post.bodyTruncated || native.bodyTruncated || post.kind !== `original_company_${identity?.kind}`) reasons.push("tiktok_native_observation_conflict");
  return [...new Set(reasons)];
}

export function isVerifiedNativeTikTokReceipt(row, company) {
  try { return verifiedNativeTikTokReasons(row, company).length === 0; }
  catch { return false; }
}
