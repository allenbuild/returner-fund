import { createHash } from "node:crypto";

export const NATIVE_X_ARTICLE_CONTEXT_PROVENANCE = "native_x_article_context_v1";
export const NATIVE_X_ARTICLE_CONTEXT_VALIDATION = "fall_2026_native_x_article_context_ingestion_v1";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const objectHash = (value) => sha(JSON.stringify(value));
const clock = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const compact = (value) => String(value ?? "").replace(/\s/g, "");
const name = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const htmlText = (value) => String(value ?? "").replace(/<[^>]*>/g, "").replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
  const key = entity.slice(1, -1).toLowerCase(), named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  if (key in named) return named[key];
  const point = /^#x/.test(key) ? parseInt(key.slice(2), 16) : Number(key.slice(1));
  return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
});
function identity(value) {
  try {
    const url = new URL(value), match = url.pathname.match(/^\/([a-z0-9_]+)(?:\/status\/(\d+))?\/?$/i);
    return url.protocol === "https:" && ["x.com", "www.x.com"].includes(url.hostname) && !url.username && !url.password && !url.port && !url.search && !url.hash && match ? { handle: match[1].toLowerCase(), postId: match[2] ?? null } : null;
  } catch { return null; }
}
const same = (left, right) => left && right && left.handle === right.handle && left.postId === right.postId;
const emptyMetrics = (value) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;

/** This verifies a distinct body-context receipt. It deliberately assigns no
 * native Article ID or post namespace: the observed status ID identifies the
 * outer post, whose original caption remains independently receipt-bound. */
export function nativeXArticleContextReasons(row, entity) {
  if (row?.attributionProvenance !== NATIVE_X_ARTICLE_CONTEXT_PROVENANCE) return ["native_x_article_provenance_required"];
  const reasons = [];
  let raw;
  try { raw = typeof row.rawVisibleText === "string" ? JSON.parse(row.rawVisibleText) : null; } catch { return ["native_x_article_receipt_invalid"]; }
  const record = raw?.nativeRecord, outer = raw?.outerPost, validation = raw?.validation;
  const native = identity(row.nativeArticleUrl), account = identity(row.accountUrl);
  const known = entity?.socialAccounts?.x, knownProfiles = (Array.isArray(known) ? known : [known]).map(identity).filter((value) => value && !value.postId);
  if (row.batchSlug !== "F26" || row.platform !== "x" || row.entityType !== "founder" || row.entityId !== entity?.entityId || row.companySlug !== entity?.companySlug || row.companyName !== entity?.companyName || row.authorName !== entity?.founderName || !native?.postId || native.postId !== row.outerNativePostId || !account || account.postId || account.handle !== native.handle || !knownProfiles.some((known) => known.handle === native.handle)) reasons.push("native_x_article_known_owner_conflict");
  if (row.contextObjectType !== "native_x_article_body" || row.contentKind !== "native_x_article" || row.articleNativeId !== null || row.platformPostId !== undefined || row.sourceUrl !== row.nativeArticleUrl) reasons.push("native_x_article_outer_post_and_body_context_must_remain_distinct");
  if (raw?.source !== "authorized_native_x_article_context_v1" || !record || !outer) return [...reasons, "native_x_article_native_records_required"];
  const legacy = record.mechanism === "native_x_article_read_view_v1", modern = record.source === "authorized_native_x_article_dom_v1";
  const sourceUrl = legacy ? record.sourceUrl : record.pageUrl, body = legacy ? record.bodyText : record.body, header = legacy ? record.primaryActorHeader : record.nativeAuthorHeader;
  const times = legacy ? record.times : [{ datetime: record.nativePublishedAt, href: record.nativePostUrl, html: record.nativeTimeHtml }];
  const nativeTimes = Array.isArray(times) ? times.filter((time) => same(identity(time.href), native)) : [];
  if ((!legacy && !modern) || !same(identity(sourceUrl), native) || sourceUrl !== row.nativeArticleUrl || modern && record.nativePostUrl !== sourceUrl || legacy && record.outerNativePostId !== native?.postId || nativeTimes.length !== 1) reasons.push("native_x_article_exact_observed_permalink_required");
  const publishedAt = nativeTimes[0]?.datetime;
  if (!clock(publishedAt) || !clock(record.observedAt) || !clock(raw.exportedAt) || publishedAt > record.observedAt || record.observedAt > raw.exportedAt || row.postedAt !== publishedAt || row.observedAt !== record.observedAt || outer.postedAt !== publishedAt || !nativeTimes[0]?.html || !record.nativeMainHtml?.includes(nativeTimes[0].html) || !nativeTimes[0].html.includes(`datetime="${publishedAt}"`)) reasons.push("native_x_article_native_clock_conflict");
  const main = record.nativeMainHtml, view = record.readViewHtml;
  if (typeof body !== "string" || !body.trim() || typeof record.title !== "string" || !record.title.trim() || row.text !== body || row.originalText !== body || row.title !== record.title || row.bodyTruncated !== false || row.captionAbsent !== false || typeof main !== "string" || typeof view !== "string" || !main.includes(view) || !view.includes(record.bodyHtml) || !view.includes(record.titleHtml) || !/data-testid=["']twitterArticleReadView["']/.test(view) || !/data-testid=["']twitterArticleRichTextView["']/.test(record.bodyHtml ?? "") || !/data-testid=["']twitter-article-title["']/.test(record.titleHtml ?? "") || compact(htmlText(record.bodyHtml)) !== compact(body) || compact(htmlText(record.titleHtml)) !== compact(record.title)) reasons.push("native_x_article_exact_full_body_html_conflict");
  const headerHandle = header?.text?.match(/@([a-z0-9_]+)/i)?.[1]?.toLowerCase();
  if (!header?.html || !main?.includes(header.html) || main.indexOf(header.html) >= main.indexOf(record.bodyHtml) || headerHandle !== native?.handle || name(header.text.split("\n")[0]) !== name(entity?.founderName) || !header.links?.some((link) => same(identity(link.href), account) && link.html && header.html.includes(link.html))) reasons.push("native_x_article_primary_native_author_conflict");
  let outerRaw;
  try { outerRaw = JSON.parse(outer.rawVisibleText); } catch { reasons.push("native_x_article_outer_receipt_invalid"); }
  if (outer.platform !== "x" || outer.platformPostId !== native?.postId || !same(identity(outer.sourceUrl), native) || !same(identity(outer.accountUrl), account) || row.outerPostText !== outer.text || outerRaw?.source !== "authenticated_native_x_ui_v1" || outerRaw?.post?.platformPostId !== native?.postId || String(outerRaw?.post?.authorHandle).toLowerCase() !== native?.handle || outerRaw?.post?.text !== outer.text || outer.bodyTruncated !== false || outerRaw?.post?.bodyTruncated !== false) reasons.push("native_x_article_original_outer_caption_must_be_preserved");
  if (!emptyMetrics(row.metrics) || row.contributionScore !== 0 || row.tractionStatus !== "unscored") reasons.push("native_x_article_context_must_remain_unscored");
  if (validation?.source !== NATIVE_X_ARTICLE_CONTEXT_VALIDATION || validation.archiveHashesVerified !== true || validation.nativeArticleRecordSha256 !== objectHash(record) || validation.outerPostRecordSha256 !== objectHash(outer) || validation.nativeBodySha256 !== sha(body ?? "") || !/^[a-f0-9]{64}$/.test(raw.sourceArchiveSha256 ?? "") || !/^[a-f0-9]{64}$/.test(raw.outerPostArchiveSha256 ?? "") || !/^\/source\/nativeArticleBodies(?:AfterControlReset)?\/\d+$/.test(raw.sourceRecordPointer ?? "")) reasons.push("native_x_article_physical_validation_receipt_conflict");
  return [...new Set(reasons)];
}

export function isVerifiedNativeXArticleContext(row, entity) {
  try { return nativeXArticleContextReasons(row, entity).length === 0; } catch { return false; }
}
