import { createHash } from "node:crypto";
import { nativeThreadsIdentity } from "./threads-native-identity.mjs";
export { nativeThreadsIdentity } from "./threads-native-identity.mjs";

export const NATIVE_THREADS_SOURCE = "authorized_native_threads_dom_v1";
export const NATIVE_THREADS_VALIDATION = "fall_2026_native_threads_ingestion_v1";
const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identitySha = "d222eaf18a27f8b6008313cf1cbc09efed4c7b7a2ca3fb22aee63ccef7bacf3f";
const entityId = "founder-antimattr-sirsho-c-3675155";
const decode = (value) => value.replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
  const named = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };
  if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
  const number = entity.slice(2, -1), point = /^x/i.test(number) ? parseInt(number.slice(1), 16) : Number(number);
  return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
});
const htmlText = (html) => decode(html.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, ""));
const clock = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
};

/** Caption text comes from exact native card spans, never the whole page or an
 * unlabeled action count. Visible outbound link labels remain native text. */
export function nativeThreadsCaption(article) {
  if (!article || typeof article.nativeHtml !== "string" || typeof article.nativeText !== "string" || !Array.isArray(article.contentSpans) || !Array.isArray(article.controls)) return null;
  const owner = nativeThreadsIdentity(article.sourceUrl);
  if (!owner?.postId || article.controls.some((control) => /\b(?:see|show|read) more\b/i.test(`${control.text ?? ""} ${control.label ?? ""}`))) return null;
  const spans = article.contentSpans;
  if (spans.length < 3 || spans[0]?.text !== owner.handle || spans[1]?.text !== article.time?.text) return null;
  const controls = new Set(article.controls.map((control) => control.text).filter((text) => typeof text === "string" && text));
  const body = [];
  let counterSeen = false;
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index];
    if (span?.tag !== "SPAN" || typeof span.text !== "string" || !span.html || !article.nativeHtml.includes(span.html) || htmlText(span.html) !== span.text || !article.nativeText.includes(span.text)) return null;
    if (index < 2) continue;
    // Native counters have a nested numeric animation div. A numeric caption
    // span remains text; it cannot be discarded merely for containing digits.
    const counter = /^\d[\d,.KM]*$/i.test(span.text) && controls.has(span.text) && /<div\b/.test(span.html);
    if (counter) { counterSeen = true; continue; }
    if (counterSeen || !span.text || /\b(?:see|show|read) more\b/i.test(span.text)) return null;
    body.push(span.text);
  }
  const text = body.join("\n");
  return text && article.nativeText.startsWith(`${owner.handle}\n${article.time.text}\n${text}`) ? text : null;
}

function socialAccount(value) {
  try {
    let url = new URL(value);
    if (url.hostname === "l.instagram.com") url = new URL(url.searchParams.get("u"));
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^twitter\.com$/, "x.com");
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return null;
    return `https://${host}${url.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch { return null; }
}

function identityVerified(proof) {
  const account = proof?.instagramAccountProof, identity = account?.nativeFounderSocialIdentity;
  if (proof?.source !== "verified_instagram_founder_threads_outbound_v1" || proof.companySlug !== "antimattr" || proof.entityId !== entityId || proof.founderId !== "3675155" || proof.founderName !== "Sirsho C" || nativeThreadsIdentity(proof.threadsProfileUrl)?.handle !== "sirsho29" || nativeThreadsIdentity(proof.threadsProfileUrl)?.postId || proof.identityArchivePath !== "outputs/fall-2026/browser-checkpoints/instagram-sirsho-identity-ui-current.json" || proof.identityArchiveSha256 !== identitySha || proof.validation?.source !== "fall_2026_threads_identity_ingestion_v1" || proof.validation.archiveHashesVerified !== true) return false;
  if (account?.entityType !== "founder" || account.handle !== "sirsho29" || account.founderId !== "3675155" || account.founderName !== "Sirsho C" || account.review_state !== "verified" || account.companyAccountMention !== "antimattr.one" || socialAccount(account.profileUrl) !== "https://instagram.com/sirsho29") return false;
  if (identity?.source !== "native_instagram_exact_roster_social_outbound_v1" || identity.batchSlug !== "F26" || identity.companySlug !== "antimattr" || identity.entityId !== entityId || identity.founderId !== "3675155" || identity.founderName !== "Sirsho C" || identity.companyHandle !== "antimattr.one" || identity.artifactSha256 !== identitySha || identity.artifactPath !== proof.identityArchivePath || socialAccount(identity.profileUrl) !== "https://instagram.com/sirsho29" || clock(identity.observedAt) === null || !identity.visibleBio?.split("\n").includes("sirsho29") || !identity.visibleBio.includes("@antimattr.one")) return false;
  for (const [platform, expected] of [["x", "https://x.com/sirsho29"], ["linkedin", "https://linkedin.com/in/sirsho29"]]) if (identity.matchedCanonicalAccounts?.[platform] !== expected || !identity.nativeOutboundLinks?.some((link) => socialAccount(link.url) === expected)) return false;
  const outbound = nativeThreadsIdentity(proof.nativeInstagramThreadsLink?.url);
  return outbound?.handle === "sirsho29" && !outbound.postId && typeof proof.nativeInstagramThreadsLink.text === "string";
}

export function verifiedNativeThreadsReasons(row) {
  if (row?.platform !== "threads" || row.attributionProvenance !== NATIVE_THREADS_SOURCE) return ["threads_native_provenance_required"];
  let raw;
  try { raw = JSON.parse(row.rawVisibleText); } catch { return ["threads_native_receipt_required"]; }
  const reasons = [], post = raw?.post, article = post?.nativeObservation, proof = raw?.identityProof, validation = raw?.validation;
  if (raw?.source !== NATIVE_THREADS_SOURCE || !post || !article || validation?.source !== NATIVE_THREADS_VALIDATION) return ["threads_native_receipt_required"];
  const native = nativeThreadsIdentity(row.sourceUrl), account = nativeThreadsIdentity(row.accountUrl), articleId = nativeThreadsIdentity(article.sourceUrl), dateId = nativeThreadsIdentity(article.time?.href);
  if (row.batchSlug !== "F26" || row.companySlug !== undefined && row.companySlug !== "antimattr" || row.companyName !== "antimattr" || row.entityType !== "founder" || row.entityId !== entityId || row.authorName !== "Sirsho C" || row.authorHandle !== "sirsho29" || !identityVerified(proof)) reasons.push("threads_verified_founder_identity_conflict");
  if (row.review_state !== "verified" || row.attributionVersion !== 3 || row.attributionStatus !== "verified" || row.attributionMode !== "author") reasons.push("threads_verified_attribution_required");
  if (!native?.postId || native.handle !== "sirsho29" || account?.handle !== native.handle || account.postId || row.platformPostId !== native.postId || post.id !== native.postId || post.authorHandle !== native.handle || nativeThreadsIdentity(post.url)?.postId !== native.postId || nativeThreadsIdentity(post.url)?.handle !== native.handle || articleId?.handle !== native.handle || articleId?.postId !== native.postId || dateId?.handle !== native.handle || dateId?.postId !== native.postId || article.companySlug !== "antimattr" || article.founderId !== "3675155") reasons.push("threads_native_author_or_permalink_conflict");
  if (!article.links?.some((link) => nativeThreadsIdentity(link.url)?.handle === native?.handle && !nativeThreadsIdentity(link.url)?.postId && link.text === native?.handle) || !article.links?.some((link) => nativeThreadsIdentity(link.url)?.postId === native?.postId && nativeThreadsIdentity(link.url)?.handle === native?.handle) || article.links?.some((link) => { const id = nativeThreadsIdentity(link.url); return id?.postId && (id.handle !== native?.handle || id.postId !== native?.postId); })) reasons.push("threads_mixed_author_card_or_native_link_conflict");
  const nativeTime = article.nativeHtml?.match(/<time\b[^>]*\bdatetime="([^"]+)"[^>]*>/)?.[1];
  const published = clock(article.time?.datetime), observed = clock(article.observedAt), exported = clock(raw.observedAt);
  if (published === null || observed === null || exported === null || published > observed || observed > exported || row.postedAt !== article.time?.datetime || post.publishedAt !== article.time?.datetime || nativeTime !== article.time?.datetime) reasons.push("threads_native_publication_clock_conflict");
  const text = nativeThreadsCaption(article);
  if (text === null || row.text !== text || row.originalText !== text || post.text !== text || row.bodyTruncated === true || post.bodyTruncated !== false || row.captionAbsent === true) reasons.push("threads_exact_native_caption_conflict");
  if (validation.archiveHashesVerified !== true || validation.nativeObservationSha256 !== sha(article) || validation.identityProofSha256 !== sha(proof) || validation.identityArchiveSha256 !== identitySha) reasons.push("threads_native_validation_hash_conflict");
  if (!row.metrics || Object.keys(row.metrics).length || !post.metrics || Object.keys(post.metrics).length || row.contributionScore !== 0 || row.tractionStatus !== "unscored") reasons.push("threads_unlabeled_metrics_must_remain_unknown_unscored");
  return [...new Set(reasons)];
}

export function isVerifiedNativeThreadsReceipt(row) {
  try { return verifiedNativeThreadsReasons(row).length === 0; } catch { return false; }
}
