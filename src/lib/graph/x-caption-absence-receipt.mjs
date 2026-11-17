export const NATIVE_X_CAPTION_ABSENCE_SOURCE = "authenticated_native_x_ui_v1";

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const handle = (value) => typeof value === "string" && /^@?[A-Za-z0-9_]{1,15}$/.test(value) ? value.replace(/^@/, "").toLowerCase() : null;
const clock = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, milliseconds) => `.${(milliseconds ?? "").padEnd(3, "0")}Z`);
  return new Date(timestamp).toISOString() === canonical ? timestamp : null;
};
const equalMetrics = (left, right) => object(left) && object(right) && Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, value]) => Number.isSafeInteger(value) && value >= 0 && right[key] === value);

/** Parses only native profile/post/media permalinks; no ID or date inference. */
export function nativeXCaptionlessIdentity(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) return null;
    const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/status\/(\d+)(?:\/(photo|video)\/([1-9]\d*))?)?\/?$/);
    return match ? { handle: match[1].toLowerCase(), postId: match[2] ?? null, mediaKind: match[3] ?? null, mediaIndex: match[4] ?? null } : null;
  } catch { return null; }
}

/** Exact integer ARIA counters only. Abbreviated counters remain unknown. */
export function nativeXCaptionlessMetrics(labels) {
  if (!Array.isArray(labels)) return null;
  const metrics = {};
  for (const label of labels) {
    if (typeof label !== "string") return null;
    const match = label.match(/^((?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+))\s+(Replies?\. Reply|reposts?\. Repost|Likes?\. Like|views?\. View post analytics)$/i);
    if (!match) continue;
    const count = Number(match[1].replaceAll(",", ""));
    if (!Number.isSafeInteger(count) || count < 0) return null;
    const kind = match[2].toLowerCase();
    const key = kind.startsWith("repl") ? "replies" : kind.startsWith("repost") ? "reposts" : kind.startsWith("like") ? "likes" : "views";
    if (key in metrics && metrics[key] !== count) return null;
    metrics[key] = count;
  }
  return metrics;
}

function ownNativeMedia(media, identity) {
  if (!object(media)) return false;
  const permalink = nativeXCaptionlessIdentity(media.href);
  if (!permalink?.mediaKind || permalink.handle !== identity.handle || permalink.postId !== identity.postId || media.nativePostId !== identity.postId || media.kind !== permalink.mediaKind || String(media.mediaIndex) !== permalink.mediaIndex || !Array.isArray(media.visibleMediaUrls) || media.visibleMediaUrls.length === 0) return false;
  return media.visibleMediaUrls.every((value) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
      if (permalink.mediaKind === "photo") return url.hostname.toLowerCase() === "pbs.twimg.com" && /^\/media\/[^/]+$/.test(url.pathname);
      return url.hostname.toLowerCase() === "pbs.twimg.com" && /^\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb|video_thumb)\/.+/.test(url.pathname) ||
        url.hostname.toLowerCase() === "video.twimg.com" && /^\/(?:ext_tw_video|amplify_video|tweet_video)\/.+/.test(url.pathname);
    } catch { return false; }
  });
}

/** Verifies native caption absence and media only. Canonical YC owner admission
 * remains the caller's responsibility; this helper cannot upgrade ownership. */
export function nativeXCaptionlessPostReasons(row) {
  if (row?.platform !== "x" || row?.captionAbsent !== true) return ["x_captionless_metadata_required"];
  let raw;
  try { raw = JSON.parse(row.rawVisibleText); } catch { return ["x_captionless_native_receipt_required"]; }
  const reasons = [], post = raw?.post;
  if (raw?.source !== NATIVE_X_CAPTION_ABSENCE_SOURCE || !object(post)) return ["x_captionless_native_receipt_required"];
  const native = nativeXCaptionlessIdentity(row.sourceUrl), dateLink = nativeXCaptionlessIdentity(post.nativeDateLink), owner = nativeXCaptionlessIdentity(row.accountUrl);
  if (!native?.postId || native.mediaKind || typeof row.platformPostId !== "string" || row.platformPostId !== native.postId || post.platformPostId !== native.postId || dateLink?.handle !== native.handle || dateLink?.postId !== native.postId || dateLink?.mediaKind) reasons.push("x_captionless_outer_native_id_conflict");
  if (!owner || owner.postId || owner.handle !== native?.handle || handle(row.authorHandle) !== native?.handle || handle(post.authorHandle) !== native?.handle) reasons.push("x_captionless_outer_native_author_conflict");
  const visibleOuterHandle = typeof raw.renderedArticleTextIncludingQuotedContent === "string" ? raw.renderedArticleTextIncludingQuotedContent.split("\n").map((line) => line.trim()).find((line) => /^@[A-Za-z0-9_]{1,15}$/.test(line)) : null;
  if (handle(visibleOuterHandle) !== native?.handle) reasons.push("x_captionless_visible_outer_author_header_conflict");
  if (row.text !== "" || row.originalText !== "" || post.text !== "" || row.bodyTruncated !== false || post.bodyTruncated !== false || post.ownTweetTextElementCount !== 0 || post.ownVisibleTextAbsent !== true || post.captionAbsent === false) reasons.push("x_captionless_explicit_native_body_absence_required");
  if (row.contributionScore !== 0 || row.tractionStatus !== "unscored") reasons.push("x_captionless_metadata_must_be_unscored");
  // A native Article, a shared card or a quoted body's image is not proof of an
  // original media post with no caption. The own-ID media link must stand alone.
  if (!Array.isArray(post.ownNativeArticleLinks) || post.ownNativeArticleLinks.length || /(?:^|\n)\s*Article\s*(?:\n|$)/.test(raw.renderedArticleTextIncludingQuotedContent ?? "")) reasons.push("x_captionless_native_article_body_requires_review");
  if (!native || !Array.isArray(post.ownMediaPermalinks) || post.ownMediaPermalinks.length === 0 || !post.ownMediaPermalinks.every((media) => ownNativeMedia(media, native))) reasons.push("x_captionless_exact_own_media_required");
  if (post.is_retweet || post.isRepost || ["repost", "third_party_subject_context"].includes(post.kind)) reasons.push("x_captionless_original_author_required");
  const published = clock(post.publishedAt), observed = clock(raw.observedAt), exported = clock(raw.exportedAt);
  if (published === null || observed === null || exported === null || row.postedAt !== post.publishedAt || published > observed || observed > exported || row.collectionObservedAt !== undefined && row.collectionObservedAt !== raw.observedAt) reasons.push("x_captionless_native_clock_conflict");
  const mergedMetrics = {};
  if (!Array.isArray(raw.metricObservations)) reasons.push("x_captionless_metric_observations_required");
  else for (const observation of raw.metricObservations) {
    const nativeMetrics = nativeXCaptionlessMetrics(observation?.nativeVisibleLabels), metricTime = clock(observation?.observedAt);
    if (!nativeMetrics || !equalMetrics(nativeMetrics, observation.metrics) || metricTime === null || published === null || exported === null || metricTime < published || metricTime > exported) reasons.push("x_captionless_native_metric_labels_conflict");
    else Object.assign(mergedMetrics, nativeMetrics);
  }
  if (!equalMetrics(mergedMetrics, raw.metrics) || !equalMetrics(mergedMetrics, row.metrics) || post.metrics !== undefined && !equalMetrics(mergedMetrics, post.metrics)) reasons.push("x_captionless_native_metrics_conflict");
  return [...new Set(reasons)];
}

export function isVerifiedNativeXCaptionlessPost(row) {
  try { return nativeXCaptionlessPostReasons(row).length === 0; }
  catch { return false; }
}
