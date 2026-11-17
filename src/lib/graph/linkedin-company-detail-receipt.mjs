import { createHash } from "node:crypto";

export const NATIVE_LINKEDIN_COMPANY_DETAIL = "native_linkedin_company_detail_v1";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const decode = (value) => value.replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
  const values = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };
  if (values[entity.toLowerCase()]) return values[entity.toLowerCase()];
  const digits = entity.slice(2, -1), number = /^x/i.test(digits) ? parseInt(digits.slice(1), 16) : Number(digits);
  return number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
});
const htmlText = (html) => decode(String(html).replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, ""));
const attribute = (html, name) => decode(String(html ?? "").match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2] ?? "");
const clock = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function linkedin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["linkedin.com", "www.linkedin.com"].includes(url.hostname) || url.username || url.password || url.port || url.hash) return null;
    const company = url.pathname.match(/^\/company\/([^/]+)\/?$/i), activity = url.pathname.match(/^\/feed\/update\/urn:li:activity:(\d+)\/?$/);
    return company ? { company: company[1].toLowerCase(), activityId: null } : activity && !url.search ? { company: null, activityId: activity[1] } : null;
  } catch { return null; }
}

export function nativeLinkedInCompanyDetailSummary(receipt, entity) {
  const reasons = [], review = receipt?.review, detail = review?.signedInNativeDetail, source = review?.card;
  const accounts = entity?.socialAccounts?.linkedin ?? [];
  const expected = (Array.isArray(accounts) ? accounts : [accounts]).map((url) => linkedin(url)?.company).filter(Boolean);
  const account = linkedin(receipt?.profileUrl)?.company;
  if (receipt?.mechanism !== "native_linkedin_company_detail_redirect_v1" || receipt.companySlug !== entity?.companySlug || !account || !expected.includes(account)) reasons.push("linkedin_company_detail_canonical_owner_conflict");
  if (!source || !detail || typeof detail.cardHtml !== "string" || typeof detail.captionHtml !== "string" || typeof source.body !== "string" || !source.key) return { ok: false, reasons: [...reasons, "linkedin_company_detail_native_source_required"] };
  const target = linkedin(detail.observedRedirectTarget), actual = linkedin(detail.url);
  let redirected = null;
  try { const url = new URL(detail.observedRedirectLink?.href); if (url.protocol === "https:" && ["www.linkedin.com", "linkedin.com"].includes(url.hostname) && /^\/(?:signup|uas\/login|login)/.test(url.pathname)) redirected = linkedin(url.searchParams.get("session_redirect")); } catch { /* No guessed redirect. */ }
  if (!actual?.activityId || actual.activityId !== target?.activityId || actual.activityId !== redirected?.activityId || !review.nativeEmbedLinks?.some((link) => link.href === detail.observedRedirectLink?.href)) reasons.push("linkedin_company_detail_exact_observed_redirect_required");
  const authorName = detail.menuLabel?.replace(/^Open control menu for post by /, "");
  if (!authorName || detail.menuLabel !== source.menu || !detail.cardHtml.includes(`aria-label="${detail.menuLabel}"`)) reasons.push("linkedin_company_detail_own_menu_conflict");
  const captionIndex = detail.cardHtml.indexOf(detail.captionHtml);
  const beforeCaption = captionIndex >= 0 ? detail.cardHtml.slice(0, captionIndex) : "";
  const actorHtml = beforeCaption.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [];
  if (!detail.primaryActorLinks?.some((link) => linkedin(link.href)?.company === account && normalize(link.text) === authorName)
    || !actorHtml.some((html) => linkedin(attribute(html, "href"))?.company === account && normalize(htmlText(html)) === authorName)) reasons.push("linkedin_company_detail_primary_actor_conflict");
  if (captionIndex < 0 || !detail.captionText || normalize(source.body) !== normalize(detail.captionText) || normalize(htmlText(detail.captionHtml)) !== normalize(detail.captionText) || !Array.isArray(detail.fullnessControls) || detail.fullnessControls.length) reasons.push("linkedin_company_detail_complete_own_caption_required");
  if (!clock(detail.observedAt) || !clock(receipt.observedAt) || Date.parse(detail.observedAt) > Date.parse(receipt.observedAt)) reasons.push("linkedin_company_detail_native_clock_conflict");
  const metrics = {};
  for (const [key, label] of [["reactions", /^Reaction button state: /], ["comments", /^Comment$/], ["reposts", /^Repost$/]]) {
    const candidates = (detail.nativeControls ?? []).filter((control) => control.tag === "BUTTON" && label.test(control.ariaLabel ?? "") && control.html && detail.cardHtml.includes(control.html) && detail.cardHtml.indexOf(control.html) > captionIndex && attribute(control.html, "aria-label") === control.ariaLabel);
    if (candidates.length !== 1) continue;
    const control = candidates[0], literal = control.text?.trim();
    if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(literal ?? "") || normalize(htmlText(control.html)) !== literal) continue;
    const value = Number(literal.replaceAll(",", ""));
    if (Number.isSafeInteger(value)) metrics[key] = value;
  }
  return { ok: !reasons.length, reasons: [...new Set(reasons)], platformPostId: actual?.activityId, sourceUrl: actual?.activityId ? `https://www.linkedin.com/feed/update/urn:li:activity:${actual.activityId}/` : null, accountUrl: receipt.profileUrl, authorName, text: detail.captionText, metrics, postedAt: null, publishedAtPrecision: "unknown" };
}

export function verifiedNativeLinkedInCompanyDetailReasons(row, entity) {
  let raw;
  try { raw = JSON.parse(row?.rawVisibleText); } catch { return ["linkedin_company_detail_receipt_required"]; }
  const receipt = raw?.post?.nativeCompanyDetailReceipt, validation = raw.validation;
  if (row?.platform !== "linkedin" || row.attributionProvenance !== NATIVE_LINKEDIN_COMPANY_DETAIL || raw.source !== "authorized_linkedin_browser_dom_v1" || !receipt) return ["linkedin_company_detail_receipt_required"];
  const result = nativeLinkedInCompanyDetailSummary(receipt, entity), reasons = [...result.reasons];
  if (row.batchSlug !== "F26" || row.entityType !== "company" || row.entityId !== entity?.entityId || row.companyName !== entity?.companyName || row.review_state !== "verified" || row.attributionVersion !== 3 || row.attributionStatus !== "verified" || row.attributionMode !== "author") reasons.push("linkedin_company_detail_verified_canonical_owner_required");
  if (row.platformPostId !== result.platformPostId || linkedin(row.sourceUrl)?.activityId !== result.platformPostId || raw.post.id !== result.platformPostId || linkedin(raw.post.url)?.activityId !== result.platformPostId || linkedin(row.accountUrl)?.company !== linkedin(result.accountUrl)?.company || row.authorName !== result.authorName) reasons.push("linkedin_company_detail_native_id_or_author_conflict");
  if (row.text !== result.text || row.originalText !== result.text || raw.post.text !== result.text || raw.post.bodyTruncated !== false || row.bodyTruncated || row.captionAbsent || JSON.stringify(row.metrics) !== JSON.stringify(result.metrics) || JSON.stringify(raw.post.metrics) !== JSON.stringify(result.metrics)) reasons.push("linkedin_company_detail_native_body_or_metric_conflict");
  if (row.postedAt !== null || row.publishedAtPrecision !== "unknown" || raw.post.publishedAt !== null) reasons.push("linkedin_company_detail_relative_date_must_remain_unknown");
  if (validation?.source !== "fall_2026_native_linkedin_company_detail_ingestion_v1" || validation.archiveHashesVerified !== true || validation.nativeCompanyDetailReceiptSha256 !== hash(receipt) || !clock(raw.observedAt) || Date.parse(raw.observedAt) < Date.parse(receipt.observedAt)) reasons.push("linkedin_company_detail_ingestion_hash_or_clock_conflict");
  return [...new Set(reasons)];
}

export function isVerifiedNativeLinkedInCompanyDetailReceipt(row, entity) {
  try { return verifiedNativeLinkedInCompanyDetailReasons(row, entity).length === 0; } catch { return false; }
}
