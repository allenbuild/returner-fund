import { createHash } from "node:crypto";
export const NATIVE_FACEBOOK_SOURCE = "authorized_native_facebook_dom_v1";
export const NATIVE_FACEBOOK_VALIDATION = "fall_2026_native_facebook_ingestion_v1";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const host = (value) => { try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } };
const digest = (value) => /^[a-f0-9]{64}$/.test(value ?? "");

export { facebookNativeIdentity } from "./facebook-native-identity.mjs";
import { facebookNativeIdentity } from "./facebook-native-identity.mjs";

function verifiedReelDetailCaption(article, authorName) {
  const detail = article?.nativeReelDetailReceipt, prior = article?.priorIncompleteObservation;
  const currentId = facebookNativeIdentity(article?.sourceUrl), detailId = facebookNativeIdentity(detail?.url), priorId = facebookNativeIdentity(prior?.sourceUrl);
  const owner = facebookNativeIdentity(article?.profileUrl)?.accountKey;
  const header = article?.nativeAuthorHeader, priorHeader = prior?.nativeAuthorHeader;
  const names = Array.isArray(detail?.ownerHeading) ? detail.ownerHeading.map((name) => String(name).trim()).filter(Boolean) : [];
  const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const prefix = (prior?.captionNodes ?? []).map((node) => typeof node === "string" ? node : node.visibleText).find((text) => typeof text === "string")?.replace(/(?:…|\.{3})?\s*See more\s*$/, "");
  const htmlText = String(detail?.html ?? "").replace(/<br\s*\/?\s*>|<\/div>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  if (detail?.mechanism !== "native_facebook_reel_caption_v1" || currentId?.kind !== "reel" || detailId?.postId !== currentId.postId || priorId?.postId !== currentId.postId
    || header?.mechanism !== "native_post_feed_heading_v1" || header.text !== authorName || priorHeader?.text !== authorName
    || facebookNativeIdentity(header.url)?.accountKey !== owner || facebookNativeIdentity(priorHeader?.url)?.accountKey !== owner
    || facebookNativeIdentity(prior?.observationPageUrl)?.accountKey !== owner || names.length !== 1 || names[0] !== authorName
    || typeof detail.text !== "string" || !detail.text || !detail.nativeText?.includes(detail.text) || detail.nativeText !== article.nativeText
    || detail.observedAt !== article.observedAt || !Number.isFinite(Date.parse(detail.observedAt)) || !Number.isFinite(Date.parse(prior?.observedAt)) || Date.parse(prior.observedAt) > Date.parse(detail.observedAt)
    || !normalize(prefix) || !normalize(detail.text).startsWith(normalize(prefix))
    || !detail.html || normalize(htmlText) !== normalize(detail.text) || detail.controls?.some((control) => control.text === "See more" || control.label === "See more")) return null;
  const captionNodes = article.captionNodes ?? [];
  if (captionNodes.length !== 1 || (typeof captionNodes[0] === "string" ? captionNodes[0] : captionNodes[0].visibleText) !== detail.text) return null;
  return detail.text;
}

export function nativeFacebookCaption(article, authorName) {
  const detailedCaption = verifiedReelDetailCaption(article, authorName);
  if (detailedCaption !== null) return { ok: true, text: detailedCaption, kind: "authored_post", countsAsAuthoredPost: true, removedUiControl: null };
  if (article?.nativeReelDetailReceipt) return { ok: false, reason: "native_reel_detail_caption_receipt_conflict" };
  const nodes = [...new Set((article?.captionNodes ?? []).map((entry) => typeof entry === "string" ? entry : entry.visibleText).filter((entry) => typeof entry === "string" && entry.length))];
  if (nodes.length > 1) return { ok: false, reason: "multiple_distinct_native_caption_nodes" };
  if (nodes.length === 1) {
    let text = nodes[0];
    const controls = [...(article.controls ?? []).map((entry) => entry.text), ...(article.captionNodes ?? []).flatMap((entry) => typeof entry === "object" ? entry.controlLabels ?? [] : [])];
    if (controls.includes("See more")) return { ok: false, reason: "native_caption_not_expanded" };
    if (controls.includes("See less") && text.endsWith("See less")) text = text.slice(0, -"See less".length).replace(/\s+$/, "");
    if (!text || !article.nativeText?.includes(text)) return { ok: false, reason: "caption_not_in_exact_native_article" };
    return { ok: true, text, kind: "authored_post", countsAsAuthoredPost: true, removedUiControl: text === nodes[0] ? null : "See less" };
  }
  const firstLine = article?.nativeText?.split("\n")[0];
  const kinds = [["profile picture", "profile_photo_update"], ["cover photo", "cover_photo_update"]];
  for (const [label, kind] of kinds) if (firstLine === `${authorName} updated their ${label}.`) return { ok: true, text: "", kind, countsAsAuthoredPost: false, removedUiControl: null };
  return { ok: false, reason: "caption_absence_or_native_metadata_kind_not_proven" };
}

export function nativeFacebookPublicationLabel(article) {
  const text = article?.nativeReelDetailReceipt && verifiedReelDetailCaption(article, article.nativeAuthorHeader?.text) !== null ? article.priorIncompleteObservation.nativeText : article?.nativeText;
  return text?.split("\n").find((line) => /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [A-Za-z]+ \d{1,2}, \d{4} at /.test(line)) ?? null;
}

export function verifiedNativeFacebookReasons(row, company) {
  let raw;
  try { raw = JSON.parse(row?.rawVisibleText); } catch { return ["missing_native_facebook_receipt"]; }
  const reasons = [], post = raw?.post, article = post?.nativeObservation, profile = raw?.nativeProfile, proof = raw?.identityProof, validation = raw?.validation;
  const slug = company?.slug ?? company?.companySlug, name = company?.name ?? company?.companyName;
  const identity = facebookNativeIdentity(row?.sourceUrl), account = facebookNativeIdentity(row?.accountUrl);
  if (row?.batchSlug !== "F26" || row?.platform !== "facebook" || row?.entityType !== "company" || row?.entityId !== `company-${slug}` || row.companyName !== name) reasons.push("facebook_canonical_company_conflict");
  if (raw?.source !== NATIVE_FACEBOOK_SOURCE || !post || !article || !profile || validation?.source !== NATIVE_FACEBOOK_VALIDATION) return [...reasons, "missing_native_facebook_receipt"];
  if (row.review_state !== "verified" || row.attributionVersion !== 3 || row.attributionStatus !== "verified" || row.attributionMode !== "author" || row.attributionProvenance !== NATIVE_FACEBOOK_SOURCE || !["official_website_exact_facebook_account", "native_facebook_post_author", "visible_native_facebook_article"].every((signal) => row.attributionSignals?.includes(signal))) reasons.push("facebook_verified_attribution_required");
  const nativeAuthor = String(profile.identity ?? "").trim();
  const reelHeader = identity?.kind === "reel" && article.nativeAuthorHeader?.mechanism === "native_post_feed_heading_v1" && article.nativeAuthorHeader.text === nativeAuthor && facebookNativeIdentity(article.nativeAuthorHeader.url)?.accountKey === account?.accountKey && article.headings?.some((heading) => heading.links?.some((link) => link.text?.trim() === nativeAuthor && facebookNativeIdentity(link.url)?.accountKey === account?.accountKey));
  const ownsPost = identity?.accountKey === account?.accountKey || reelHeader;
  if (!identity?.postId || identity.postId !== row.platformPostId || identity.postId !== post.id || !account?.profileUrl || account.postId || !ownsPost || facebookNativeIdentity(profile.url)?.accountKey !== account.accountKey || facebookNativeIdentity(post.url)?.postId !== identity.postId || facebookNativeIdentity(article.sourceUrl)?.postId !== identity.postId) reasons.push("facebook_native_id_or_account_conflict");
  if (!nativeAuthor || post.authorName !== nativeAuthor || row.authorName !== nativeAuthor || !article.links?.some((link) => facebookNativeIdentity(link.url)?.accountKey === account?.accountKey && !facebookNativeIdentity(link.url)?.postId && link.text?.trim() === nativeAuthor) || !article.links?.some((link) => facebookNativeIdentity(link.url)?.postId === identity?.postId && (identity?.kind === "reel" ? reelHeader : facebookNativeIdentity(link.url)?.accountKey === account?.accountKey))) reasons.push("facebook_native_own_author_or_permalink_conflict");
  const outbound = proof?.officialOutboundReceipt, href = outbound?.anchorHtml?.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
  if (proof?.source !== "official_company_website_facebook_account_v1" || proof.companySlug !== slug || proof.companyName !== name || proof.entityId !== row.entityId || proof.review_state !== "verified" || facebookNativeIdentity(proof.profileUrl)?.accountKey !== account?.accountKey || proof.officialYcCompanyUrl !== `https://www.ycombinator.com/companies/${slug}` || !host(company?.websiteUrl) || host(proof.officialWebsite) !== host(company.websiteUrl) || outbound?.companySlug !== slug || outbound?.platform !== "facebook" || outbound?.ownershipStatus !== "official_company_account_or_community_link" || host(outbound.discoveredOn) !== host(company.websiteUrl) || facebookNativeIdentity(outbound.sourceUrl)?.accountKey !== account?.accountKey || facebookNativeIdentity(href)?.accountKey !== account?.accountKey || !digest(outbound.sourceHtmlSha256) || !digest(proof.inventorySha256)) reasons.push("facebook_official_website_ownership_conflict");
  if (validation.archiveHashesVerified !== true || validation.literalOfficialAnchorVerified !== true || validation.inventorySha256 !== proof?.inventorySha256 || validation.sourceHtmlSha256 !== outbound?.sourceHtmlSha256 || validation.identityProofSha256 !== hash(proof) || validation.nativeObservationSha256 !== hash(article)) reasons.push("facebook_ingestion_validation_conflict");
  const caption = nativeFacebookCaption(article, nativeAuthor);
  if (!caption.ok || row.text !== caption.text || (row.originalText ?? "") !== caption.text || post.text !== caption.text || row.nativeContentKind !== caption.kind || row.countsAsAuthoredPost !== caption.countsAsAuthoredPost || Boolean(row.captionAbsent) !== (caption.text === "") || Boolean(post.captionAbsent) !== (caption.text === "") || (!caption.countsAsAuthoredPost && !article.media?.length)) reasons.push("facebook_native_caption_or_metadata_kind_conflict");
  if (row.postedAt !== null || row.publishedAtPrecision !== "unknown" || row.nativePublishedAtLiteral !== nativeFacebookPublicationLabel(article) || post.publishedAt !== null || article.times?.length) reasons.push("facebook_unknown_timezone_publication_conflict");
  if (Object.keys(row.metrics ?? {}).length || Object.keys(post.metrics ?? {}).length || row.contributionScore !== 0 || row.tractionStatus !== "unscored") reasons.push("facebook_native_context_must_remain_unscored");
  if (!Number.isFinite(Date.parse(raw.observedAt)) || post.bodyTruncated) reasons.push("facebook_native_observation_conflict");
  return [...new Set(reasons)];
}
export function isVerifiedNativeFacebookReceipt(row, company) {
  try { return verifiedNativeFacebookReasons(row, company).length === 0; } catch { return false; }
}
