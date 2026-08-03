import * as cheerio from "cheerio";

const X_PROFILE_POST_LIMIT = 100;
const X_POST_MEDIA_LIMIT = 8;

/**
 * Parse the first, anonymous server-rendered X profile page.
 *
 * X emits Schema.org SocialMediaPosting articles with native IDs, exact UTC
 * timestamps, authors and interaction counters. Quote cards are nested posts,
 * so every accepted row must prove that both the native URL and author match
 * the requested profile handle. This retains an owner's quote wrapper while
 * preventing the quoted author's post from being attributed to the owner.
 */
export function extractXPublicProfileReceipt({
  html,
  accountUrl,
  requestedHandle,
  fetchedAt = new Date().toISOString(),
  limit = 30
} = {}) {
  const handle = normalizeXHandle(requestedHandle ?? xHandleFromUrl(accountUrl));
  const canonicalAccountUrl = handle ? `https://x.com/${handle}` : null;
  if (!handle) {
    return emptyReceipt({
      fetchedAt,
      accountUrl: canonicalAccountUrl,
      reason: "invalid_requested_x_handle"
    });
  }

  const source = String(html ?? "");
  if (!source.trim()) {
    return emptyReceipt({
      fetchedAt,
      accountUrl: canonicalAccountUrl,
      handle,
      reason: "empty_x_profile_html"
    });
  }

  const $ = cheerio.load(source);
  const profileUrls = $("[itemtype='https://schema.org/ProfilePage']")
    .map((_, node) => directMeta($, $(node), "url"))
    .get()
    .filter(Boolean);
  const profileHandleVerified = profileUrls.some(
    (url) => normalizeXHandle(xHandleFromUrl(url)) === handle
  );
  const rejected = [];
  const byId = new Map();
  const articles = $("article[itemtype='https://schema.org/SocialMediaPosting']");

  articles.each((_, node) => {
    const article = $(node);
    const parsed = parseSocialMediaPosting($, article);
    if (!parsed.ok) {
      rejected.push(parsed.rejection);
      return;
    }
    if (parsed.post.authorHandle !== handle || parsed.post.urlHandle !== handle) {
      rejected.push({
        id: parsed.post.id,
        authorHandle: parsed.post.authorHandle,
        url: parsed.post.url,
        reason: "native_owner_mismatch"
      });
      return;
    }
    const existing = byId.get(parsed.post.id);
    byId.set(parsed.post.id, existing ? richerPost(existing, parsed.post) : parsed.post);
  });

  const normalizedLimit = Math.max(
    0,
    Math.min(X_PROFILE_POST_LIMIT, finiteInteger(limit, 30))
  );
  const ownedPosts = [...byId.values()].sort(comparePostRecency);
  const posts = ownedPosts.slice(0, normalizedLimit);
  // An exact ProfilePage proves only account identity. X can omit articles
  // from a blocked, degraded, or client-rendered response, so zero articles
  // are never sufficient proof of an empty native account window.
  const verified = profileHandleVerified && ownedPosts.length > 0;

  return {
    verified,
    reason: verified
      ? null
      : profileHandleVerified
        ? "no_exact_owner_social_media_postings"
        : "x_profile_identity_mismatch",
    fetchedAt: validIsoTimestamp(fetchedAt) ?? new Date().toISOString(),
    accountUrl: canonicalAccountUrl,
    handle,
    surfacePostCount: articles.length,
    exactOwnerPostCount: ownedPosts.length,
    returnedPostCount: posts.length,
    rejectedPostCount: rejected.length,
    truncated: ownedPosts.length > posts.length,
    posts,
    rejectedPosts: rejected
  };
}

function parseSocialMediaPosting($, article) {
  const id = String(
    directMeta($, article, "identifier") ?? article.attr("data-tweet-id") ?? ""
  ).trim();
  const url = canonicalXStatusUrl(directMeta($, article, "url"));
  const urlMatch = url?.match(/^https:\/\/x\.com\/([a-z0-9_]{1,15})\/status\/(\d+)$/i);
  const author = article.children("[itemprop='author']").first();
  const authorHandle = normalizeXHandle(directMeta($, author, "alternateName"));
  const authorName = cleanText(directMeta($, author, "name")) || authorHandle;
  const text = cleanText(
    directMeta($, article, "articleBody") ??
      directMeta($, article, "text") ??
      directMeta($, article, "headline")
  );
  const postedAt = validIsoTimestamp(
    directMeta($, article, "datePublished") ?? directMeta($, article, "dateCreated")
  );

  const reason = !/^\d{10,}$/.test(id)
    ? "invalid_native_post_id"
    : !urlMatch || urlMatch[2] !== id
      ? "native_status_url_mismatch"
      : !authorHandle
        ? "missing_native_author"
        : !postedAt
          ? "invalid_native_publication_timestamp"
          : !text
            ? "missing_native_post_text"
            : null;
  if (reason) {
    return {
      ok: false,
      rejection: { id: id || null, authorHandle, url, reason }
    };
  }

  const metrics = {};
  article.children("[itemprop='interactionStatistic']").each((_, node) => {
    const counter = $(node);
    const name = cleanText(directMeta($, counter, "name")).toLowerCase();
    const interactionType = cleanText(directMeta($, counter, "interactionType")).toLowerCase();
    const value = nonnegativeNumber(directMeta($, counter, "userInteractionCount"));
    if (value === null) return;
    const metric = metricName(name, interactionType);
    if (metric) metrics[metric] = Math.max(metrics[metric] ?? 0, value);
  });
  const commentCount = nonnegativeNumber(directMeta($, article, "commentCount"));
  if (commentCount !== null) {
    metrics.replies = Math.max(metrics.replies ?? 0, commentCount);
  }

  const mediaUrls = article
    .find("[itemprop='image']")
    .filter((_, node) => $(node).closest("article").get(0) === article.get(0))
    .map((_, node) => {
      const image = $(node);
      return directMeta($, image, "contentUrl") ?? directMeta($, image, "url");
    })
    .get()
    .filter(isHttpUrl);
  const basedOn = canonicalXStatusUrl(directMeta($, article, "isBasedOn"));

  return {
    ok: true,
    post: {
      id,
      url,
      urlHandle: normalizeXHandle(urlMatch[1]),
      authorHandle,
      authorName,
      text,
      postedAt,
      metrics,
      mediaUrls: [...new Set(mediaUrls)].slice(0, X_POST_MEDIA_LIMIT),
      quotedPostUrl: basedOn,
      isQuote: Boolean(basedOn)
    }
  };
}

function directMeta($, root, itemProp) {
  return root
    .children(`meta[itemprop='${itemProp}']`)
    .first()
    .attr("content") ?? null;
}

function metricName(name, interactionType) {
  if (name === "likes" || interactionType.endsWith("/likeaction")) return "likes";
  if (name === "retweets" || name === "reposts" || interactionType.endsWith("/shareaction")) return "reposts";
  if (name === "quotes" || interactionType.endsWith("/interactaction")) return "quotes";
  if (name === "replies" || interactionType.endsWith("/replyaction")) return "replies";
  if (name === "views" || interactionType.endsWith("/viewaction")) return "views";
  return null;
}

function canonicalXStatusUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!["x.com", "twitter.com"].includes(host)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const handle = normalizeXHandle(parts[0]);
    const statusIndex = parts[0]?.toLowerCase() === "i" ? 1 : 1;
    if (parts[statusIndex]?.toLowerCase() !== "status" || !/^\d+$/.test(parts[statusIndex + 1] ?? "")) {
      return null;
    }
    // /i/status/:id is a quote reference without an author. Keep the native
    // identity but do not manufacture an owner handle.
    return parts[0]?.toLowerCase() === "i"
      ? `https://x.com/i/status/${parts[2]}`
      : handle
        ? `https://x.com/${handle}/status/${parts[2]}`
        : null;
  } catch {
    return null;
  }
}

function xHandleFromUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!["x.com", "twitter.com"].includes(host)) return null;
    return url.pathname.split("/").filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

function normalizeXHandle(value) {
  const handle = String(value ?? "").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{1,15}$/.test(handle) ? handle : null;
}

function comparePostRecency(left, right) {
  const timestampDifference = Date.parse(right.postedAt) - Date.parse(left.postedAt);
  if (timestampDifference !== 0) return timestampDifference;
  if (BigInt(right.id) > BigInt(left.id)) return 1;
  if (BigInt(right.id) < BigInt(left.id)) return -1;
  return 0;
}

function richerPost(left, right) {
  const leftMetricTotal = Object.values(left.metrics ?? {}).reduce((sum, value) => sum + value, 0);
  const rightMetricTotal = Object.values(right.metrics ?? {}).reduce((sum, value) => sum + value, 0);
  return rightMetricTotal > leftMetricTotal ? right : left;
}

function validIsoTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function nonnegativeNumber(value) {
  const number = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function finiteInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

function cleanText(value) {
  let decoded = String(value ?? "");
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decoded.replace(
      /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi,
      (_, decimal, hexadecimal, named) => {
        if (decimal) return safeCodePoint(Number(decimal));
        if (hexadecimal) return safeCodePoint(Number.parseInt(hexadecimal, 16));
        return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[
          named.toLowerCase()
        ];
      }
    );
    if (next === decoded) break;
    decoded = next;
  }
  return decoded.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function safeCodePoint(value) {
  try {
    return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
      ? String.fromCodePoint(value)
      : "";
  } catch {
    return "";
  }
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value ?? ""));
}

function emptyReceipt({ fetchedAt, accountUrl, handle = null, reason }) {
  return {
    verified: false,
    reason,
    fetchedAt: validIsoTimestamp(fetchedAt) ?? new Date().toISOString(),
    accountUrl,
    handle,
    surfacePostCount: 0,
    exactOwnerPostCount: 0,
    returnedPostCount: 0,
    rejectedPostCount: 0,
    truncated: false,
    posts: [],
    rejectedPosts: []
  };
}
