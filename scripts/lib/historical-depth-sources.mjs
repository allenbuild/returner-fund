import * as cheerio from "cheerio";

export class HistoricalDepthPayloadError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "HistoricalDepthPayloadError";
    this.code = code;
    Object.assign(this, details);
  }
}

export function youtubeChannelIdFromAccountUrl(accountUrl) {
  try {
    const parts = new URL(accountUrl).pathname.split("/").filter(Boolean);
    return parts[0]?.toLowerCase() === "channel" && /^UC[A-Za-z0-9_-]+$/.test(parts[1] ?? "")
      ? parts[1]
      : null;
  } catch {
    return null;
  }
}

export function youtubePublicVideosUrl(target) {
  if (!target?.accountUrl) throw new Error("YouTube public history requires a verified account URL.");
  return `${target.accountUrl.replace(/\/+$/, "")}/videos`;
}

export function youtubeFeedUrl(channelId) {
  if (!/^UC[A-Za-z0-9_-]+$/.test(String(channelId ?? ""))) {
    throw new Error("YouTube feed requires an exact native channel ID.");
  }
  const url = new URL("https://www.youtube.com/feeds/videos.xml");
  url.searchParams.set("channel_id", channelId);
  return url.toString();
}

export function youtubeChannelsApiUrl(channelId, apiKey) {
  if (!/^UC[A-Za-z0-9_-]+$/.test(String(channelId ?? ""))) {
    throw new Error("YouTube channels API requires an exact native channel ID.");
  }
  if (!String(apiKey ?? "").trim()) throw new Error("YouTube channels API requires an API key.");
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "contentDetails,snippet");
  url.searchParams.set("id", channelId);
  url.searchParams.set("key", apiKey);
  return url.toString();
}

export function youtubePlaylistItemsApiUrl({ playlistId, pageToken, pageSize, apiKey }) {
  if (!String(playlistId ?? "").trim()) throw new Error("YouTube uploads playlist ID is required.");
  if (!String(apiKey ?? "").trim()) throw new Error("YouTube playlist API requires an API key.");
  const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  url.searchParams.set("part", "snippet,contentDetails,status");
  url.searchParams.set("playlistId", playlistId);
  url.searchParams.set("maxResults", String(pageSize));
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  url.searchParams.set("key", apiKey);
  return url.toString();
}

export function youtubeBrowseContinuationRequest({ token, apiKey, clientVersion }) {
  if (!String(token ?? "").trim()) throw new Error("YouTube public continuation token is required.");
  if (!String(apiKey ?? "").trim()) throw new Error("YouTube public continuation API key is required.");
  const url = new URL("https://www.youtube.com/youtubei/v1/browse");
  url.searchParams.set("key", apiKey);
  return {
    url: url.toString(),
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB",
            clientVersion: String(clientVersion || "2.20260801.00.00")
          }
        },
        continuation: token
      })
    }
  };
}

export function productHuntGraphqlRequest(target, { after = null, pageSize = 20, token } = {}) {
  if (!target?.officialWebsite || !target?.officialDomain) {
    throw new Error("Product Hunt historical API query requires a canonical official website.");
  }
  if (!String(token ?? "").trim()) throw new Error("Product Hunt API query requires a token.");
  const query = `query HistoricalPosts($url: String!, $after: String, $first: Int!, $postedAfter: DateTime!) {
    posts(url: $url, after: $after, first: $first, postedAfter: $postedAfter) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id slug name tagline description url website createdAt votesCount commentsCount
        makers { id username name url }
      }
    }
  }`;
  return {
    url: "https://api.producthunt.com/v2/api/graphql",
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        query,
        variables: {
          url: target.officialWebsite,
          after,
          first: pageSize,
          postedAfter: "1970-01-01T00:00:00.000Z"
        }
      })
    }
  };
}

export function redditListingRequest(target, {
  after = null,
  count = 0,
  pageSize = 100,
  accessToken = null,
  userAgent = "ReturnerFundHistoricalDepth/1.0 (+public-evidence-audit)"
} = {}) {
  const identity = redditAccountIdentity(target?.accountUrl);
  if (!identity) throw new Error("Reddit history requires a verified user or subreddit account URL.");
  const host = accessToken ? "oauth.reddit.com" : "www.reddit.com";
  const path = identity.kind === "user"
    ? `/user/${encodeURIComponent(identity.name)}/submitted`
    : `/r/${encodeURIComponent(identity.name)}/new`;
  const url = new URL(`https://${host}${path}.json`);
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("count", String(count));
  url.searchParams.set("raw_json", "1");
  if (after) url.searchParams.set("after", after);
  return {
    url: url.toString(),
    init: {
      headers: {
        accept: "application/json",
        "user-agent": userAgent,
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
      }
    },
    identity
  };
}

export function parseYouTubePublicPage(text, { seen = new Set(), maxItems = 5_000 } = {}) {
  const source = String(text ?? "");
  const channelId = firstMatch(source, [
    /<meta[^>]+itemprop=["']channelId["'][^>]+content=["'](UC[A-Za-z0-9_-]+)["']/i,
    /[?&]channel_id=(UC[A-Za-z0-9_-]+)/i,
    /["'](?:channelId|externalId)["']\s*:\s*["'](UC[A-Za-z0-9_-]+)["']/i
  ]);
  const innertubeApiKey = firstMatch(source, [
    /["']INNERTUBE_API_KEY["']\s*:\s*["']([^"']+)["']/i,
    /["']innertubeApiKey["']\s*:\s*["']([^"']+)["']/i
  ]);
  const innertubeClientVersion = firstMatch(source, [
    /["']INNERTUBE_CLIENT_VERSION["']\s*:\s*["']([^"']+)["']/i,
    /["']clientVersion["']\s*:\s*["']([^"']+)["']/i
  ]);
  const continuationTokens = regexValues(
    source,
    /["']continuationCommand["']\s*:\s*\{[^{}]{0,1000}?["']token["']\s*:\s*["']((?:\\.|[^"'])+)["']/gi,
    50
  ).map(decodeJsonString).filter(Boolean);
  const videoIds = regexValues(
    source,
    /["']videoId["']\s*:\s*["']([A-Za-z0-9_-]{6,})["']/gi,
    maxItems * 2
  );
  let duplicates = 0;
  let rejectedMissingExactTimestamp = 0;
  const discoveredVideoIds = [];
  for (const videoId of videoIds) {
    const identity = `youtube:${videoId}`;
    if (seen.has(identity)) {
      duplicates += 1;
      continue;
    }
    if (discoveredVideoIds.length >= maxItems) break;
    seen.add(identity);
    discoveredVideoIds.push(videoId);
    // Public browse payloads expose relative dates. They are discovery only;
    // exact publication timestamps must come from RSS or the official Data API.
    rejectedMissingExactTimestamp += 1;
  }
  return {
    channelId,
    innertubeApiKey,
    innertubeClientVersion,
    continuationToken: continuationTokens[0] ?? null,
    continuationTokens: [...new Set(continuationTokens)],
    discoveredVideoIds,
    itemsSeen: videoIds.length,
    duplicates,
    rejectedMissingExactTimestamp,
    accepted: 0,
    evidence: []
  };
}

export function parseYouTubeFeed(text, { target, seen = new Set(), discoveredAt = new Date() } = {}) {
  const $ = cheerio.load(String(text ?? ""), { xmlMode: true, decodeEntities: true });
  // YouTube's live Atom surface serializes `yt:channelId` without the
  // canonical `UC` prefix even though the request, alternate channel URL, and
  // Data API all use the prefixed ID. Normalize that documented wire shape
  // before comparing it with the verified mapping; otherwise every healthy
  // official feed is falsely rejected as an identity mismatch.
  const feedChannelId = normalizeYouTubeFeedChannelId(
    clean($("feed > yt\\:channelId").first().text()) ??
      clean($("channelId").first().text())
  );
  const expectedChannelId = youtubeChannelIdFromAccountUrl(target?.accountUrl) ?? target?.accountId ?? null;
  if (expectedChannelId && feedChannelId && expectedChannelId !== feedChannelId) {
    throw new HistoricalDepthPayloadError(
      "youtube_feed_channel_mismatch",
      `YouTube feed channel ${feedChannelId} did not match verified mapping ${expectedChannelId}.`
    );
  }
  const evidence = [];
  let rejected = 0;
  let duplicates = 0;
  let earliest = null;
  let latest = null;
  const nodes = $("entry").toArray();
  for (const node of nodes) {
    const entry = $(node);
    const videoId = clean(entry.find("yt\\:videoId").first().text());
    const publishedAt = canonicalExactTimestamp(entry.find("published").first().text());
    if (!videoId || !publishedAt) {
      rejected += 1;
      continue;
    }
    const identity = `youtube:${videoId}`;
    if (seen.has(identity)) {
      duplicates += 1;
      continue;
    }
    seen.add(identity);
    earliest = earlier(earliest, publishedAt);
    latest = later(latest, publishedAt);
    const media = entry.find("media\\:group").first();
    const statistics = media.find("media\\:statistics").first();
    evidence.push({
      ...evidenceBase(target, "youtube", discoveredAt),
      externalId: identity,
      nativeId: videoId,
      sourceUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      canonicalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      accountUrl: target.accountUrl,
      title: clean(entry.find("title").first().text()),
      text: clean(media.find("media\\:description").first().text()),
      publishedAt,
      author: clean(entry.find("author > name").first().text()),
      metrics: integerMetrics({ views: statistics.attr("views") }),
      attribution: {
        status: "verified",
        method: "verified_channel_id_and_official_youtube_atom_feed",
        accountUrl: target.accountUrl,
        nativeChannelId: feedChannelId ?? expectedChannelId ?? null
      },
      discoveryMethod: "youtube_official_atom_feed"
    });
  }
  return {
    channelId: feedChannelId ?? expectedChannelId ?? null,
    itemsSeen: nodes.length,
    accepted: evidence.length,
    rejected,
    duplicates,
    earliest,
    latest,
    evidence,
    sourceExhausted: true,
    coverageExtent: "all_entries_exposed_by_non_paginated_youtube_channel_feed"
  };
}

function normalizeYouTubeFeedChannelId(value) {
  const channelId = clean(value);
  if (!channelId) return null;
  return channelId.startsWith("UC") ? channelId : `UC${channelId}`;
}

export function parseYouTubeChannelApi(payload, target) {
  const items = Array.isArray(payload?.items) ? payload.items : null;
  if (!items) {
    throw new HistoricalDepthPayloadError("youtube_channels_payload_invalid", "YouTube channels API payload has no items array.");
  }
  if (items.length === 0) {
    throw new HistoricalDepthPayloadError(
      "youtube_verified_mapping_not_found",
      "YouTube channels API returned no channel for the verified mapping."
    );
  }
  const channel = items[0];
  const mappedId = youtubeChannelIdFromAccountUrl(target?.accountUrl) ?? target?.accountId ?? null;
  if (mappedId && channel.id !== mappedId) {
    throw new HistoricalDepthPayloadError(
      "youtube_channel_identity_mismatch",
      `YouTube channels API returned ${channel.id ?? "no id"} for verified channel ${mappedId}.`
    );
  }
  const uploadsPlaylistId = clean(channel?.contentDetails?.relatedPlaylists?.uploads);
  if (!uploadsPlaylistId) {
    throw new HistoricalDepthPayloadError(
      "youtube_uploads_playlist_missing",
      "YouTube channels API did not expose the channel uploads playlist."
    );
  }
  return { channelId: clean(channel.id), uploadsPlaylistId, title: clean(channel?.snippet?.title) };
}

export function parseYouTubePlaylistPage(payload, {
  target,
  expectedChannelId,
  seen = new Set(),
  discoveredAt = new Date()
} = {}) {
  const items = Array.isArray(payload?.items) ? payload.items : null;
  if (!items) {
    throw new HistoricalDepthPayloadError("youtube_playlist_payload_invalid", "YouTube playlist API payload has no items array.");
  }
  const evidence = [];
  let rejected = 0;
  let duplicates = 0;
  let earliest = null;
  let latest = null;
  for (const item of items) {
    const videoId = clean(item?.contentDetails?.videoId ?? item?.snippet?.resourceId?.videoId);
    const publishedAt = canonicalExactTimestamp(item?.contentDetails?.videoPublishedAt);
    const ownerId = clean(item?.snippet?.videoOwnerChannelId ?? item?.snippet?.channelId);
    if (!videoId || !publishedAt || (expectedChannelId && ownerId && ownerId !== expectedChannelId)) {
      rejected += 1;
      continue;
    }
    const identity = `youtube:${videoId}`;
    if (seen.has(identity)) {
      duplicates += 1;
      continue;
    }
    seen.add(identity);
    earliest = earlier(earliest, publishedAt);
    latest = later(latest, publishedAt);
    evidence.push({
      ...evidenceBase(target, "youtube", discoveredAt),
      externalId: identity,
      nativeId: videoId,
      sourceUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      canonicalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      accountUrl: target.accountUrl,
      title: clean(item?.snippet?.title),
      text: clean(item?.snippet?.description),
      publishedAt,
      author: clean(item?.snippet?.videoOwnerChannelTitle ?? item?.snippet?.channelTitle),
      metrics: {},
      attribution: {
        status: "verified",
        method: "verified_channel_uploads_playlist",
        accountUrl: target.accountUrl,
        nativeChannelId: ownerId ?? expectedChannelId ?? null
      },
      discoveryMethod: "youtube_data_api_uploads_playlist"
    });
  }
  const nextCursor = clean(payload?.nextPageToken);
  return {
    itemsSeen: items.length,
    accepted: evidence.length,
    rejected,
    duplicates,
    earliest,
    latest,
    evidence,
    nextCursor,
    sourceExhausted: !nextCursor,
    totalResults: Number.isInteger(payload?.pageInfo?.totalResults) ? payload.pageInfo.totalResults : null
  };
}

export function parseProductHuntPage(payload, {
  target,
  seen = new Set(),
  discoveredAt = new Date()
} = {}) {
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    const message = payload.errors.map((error) => clean(error?.message)).filter(Boolean).join("; ");
    throw new HistoricalDepthPayloadError(
      "product_hunt_graphql_error",
      `Product Hunt GraphQL returned errors: ${message || "unspecified error"}.`
    );
  }
  const connection = payload?.data?.posts;
  if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
    throw new HistoricalDepthPayloadError(
      "product_hunt_payload_invalid",
      "Product Hunt GraphQL payload is missing posts nodes or pageInfo."
    );
  }
  const evidence = [];
  let rejected = 0;
  let duplicates = 0;
  let earliest = null;
  let latest = null;
  for (const post of connection.nodes) {
    const nativeId = clean(post?.id) ?? clean(post?.slug);
    const slug = clean(post?.slug);
    const publishedAt = canonicalExactTimestamp(post?.createdAt);
    const nativeUrl = canonicalProductHuntPostUrl(post?.url, slug);
    if (!nativeId || !publishedAt || !nativeUrl) {
      rejected += 1;
      continue;
    }
    const identity = `product_hunt:${nativeId}`;
    if (seen.has(identity)) {
      duplicates += 1;
      continue;
    }
    seen.add(identity);
    earliest = earlier(earliest, publishedAt);
    latest = later(latest, publishedAt);
    evidence.push({
      ...evidenceBase(target, "product_hunt", discoveredAt),
      externalId: identity,
      nativeId,
      sourceUrl: nativeUrl,
      canonicalUrl: nativeUrl,
      accountUrl: target.accountUrl,
      title: clean(post?.name),
      text: clean([post?.tagline, post?.description].filter(Boolean).join("\n")),
      publishedAt,
      author: (post?.makers ?? []).map((maker) => clean(maker?.name ?? maker?.username)).filter(Boolean).join(", ") || null,
      metrics: integerMetrics({ upvotes: post?.votesCount, comments: post?.commentsCount }),
      attribution: {
        status: "verified",
        method: "product_hunt_posts_query_exact_official_url",
        accountUrl: target.accountUrl,
        officialWebsite: target.officialWebsite,
        officialDomain: target.officialDomain
      },
      discoveryMethod: "product_hunt_official_graphql_posts_by_exact_url"
    });
  }
  const hasNextPage = connection.pageInfo.hasNextPage === true;
  const nextCursor = clean(connection.pageInfo.endCursor);
  if (hasNextPage && !nextCursor) {
    throw new HistoricalDepthPayloadError(
      "product_hunt_cursor_missing",
      "Product Hunt GraphQL declared another page without an end cursor."
    );
  }
  return {
    itemsSeen: connection.nodes.length,
    accepted: evidence.length,
    rejected,
    duplicates,
    earliest,
    latest,
    evidence,
    nextCursor: hasNextPage ? nextCursor : null,
    sourceExhausted: !hasNextPage,
    totalResults: Number.isInteger(connection.totalCount) ? connection.totalCount : null
  };
}

export function parseRedditListing(payload, {
  target,
  identity = redditAccountIdentity(target?.accountUrl),
  seen = new Set(),
  discoveredAt = new Date()
} = {}) {
  const children = payload?.data?.children;
  if (!identity || !Array.isArray(children)) {
    throw new HistoricalDepthPayloadError(
      "reddit_listing_payload_invalid",
      "Reddit listing payload is missing the expected children array."
    );
  }
  const evidence = [];
  let rejected = 0;
  let duplicates = 0;
  let earliest = null;
  let latest = null;
  for (const child of children) {
    const post = child?.data;
    const nativeId = clean(post?.name) ?? (clean(post?.id) ? `t3_${post.id}` : null);
    const attributed = identity.kind === "user"
      ? clean(post?.author)?.toLowerCase() === identity.name.toLowerCase()
      : clean(post?.subreddit)?.toLowerCase() === identity.name.toLowerCase();
    const publishedAt = epochSecondsTimestamp(post?.created_utc);
    const sourceUrl = canonicalRedditPostUrl(post?.permalink, post?.url);
    if (child?.kind !== "t3" || !nativeId || !publishedAt || !sourceUrl || !attributed) {
      rejected += 1;
      continue;
    }
    const identityKey = `reddit:${nativeId.toLowerCase()}`;
    if (seen.has(identityKey)) {
      duplicates += 1;
      continue;
    }
    seen.add(identityKey);
    earliest = earlier(earliest, publishedAt);
    latest = later(latest, publishedAt);
    evidence.push({
      ...evidenceBase(target, "reddit", discoveredAt),
      externalId: identityKey,
      nativeId: nativeId.toLowerCase(),
      sourceUrl,
      canonicalUrl: sourceUrl,
      accountUrl: target.accountUrl,
      title: clean(post?.title),
      text: clean(post?.selftext),
      publishedAt,
      author: clean(post?.author),
      metrics: integerMetrics({ upvotes: post?.score, comments: post?.num_comments }),
      attribution: {
        status: "verified",
        method: identity.kind === "user" ? "exact_reddit_author_listing" : "exact_reddit_subreddit_listing",
        accountUrl: target.accountUrl,
        nativeOwner: identity.name
      },
      discoveryMethod: "reddit_official_listing_json"
    });
  }
  const nextCursor = clean(payload?.data?.after);
  return {
    itemsSeen: children.length,
    accepted: evidence.length,
    rejected,
    duplicates,
    earliest,
    latest,
    evidence,
    nextCursor,
    sourceExhausted: !nextCursor,
    endpointCutoff: "reddit_listing_window_maximum_1000_items"
  };
}

export function redditAccountIdentity(accountUrl) {
  try {
    const parts = new URL(accountUrl).pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return null;
    const kind = parts[0].toLowerCase();
    if (kind === "r") return { kind: "subreddit", name: parts[1] };
    if (kind === "u" || kind === "user") return { kind: "user", name: parts[1] };
    return null;
  } catch {
    return null;
  }
}

export function looksLikeAccessWall(text) {
  return /(?:captcha|challenge-platform|access denied|request blocked|securitycompromiseerror|you've been blocked|log in to continue|too many requests)/i
    .test(String(text ?? "").slice(0, 200_000));
}

export function canonicalExactTimestamp(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    return null;
  }
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function evidenceBase(target, platform, discoveredAt) {
  return {
    schemaVersion: 1,
    collector: "historical-depth-backfill",
    platform,
    batchSlug: target.batchSlug,
    entityType: target.entityType,
    entityId: target.entityId,
    entityName: target.entityName,
    companyId: target.companyId,
    companyName: target.companyName,
    officialDomain: target.officialDomain,
    discoveredAt: dateIso(discoveredAt)
  };
}

function canonicalProductHuntPostUrl(rawUrl, slug) {
  try {
    const parsed = new URL(rawUrl || `https://www.producthunt.com/posts/${slug}`);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const match = parsed.pathname.match(/^\/posts\/([A-Za-z0-9][A-Za-z0-9_-]*)\/?$/i);
    if (host !== "producthunt.com" || !match) return null;
    return `https://www.producthunt.com/posts/${match[1].toLowerCase()}`;
  } catch {
    return null;
  }
}

function canonicalRedditPostUrl(permalink, fallback) {
  for (const candidate of [permalink, fallback]) {
    try {
      const parsed = new URL(candidate, "https://www.reddit.com");
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      if (host !== "reddit.com" || !/\/comments\/[A-Za-z0-9]+/i.test(parsed.pathname)) continue;
      const path = parsed.pathname.replace(/\/+$/, "");
      return `https://www.reddit.com${path}`;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function integerMetrics(values) {
  return Object.fromEntries(Object.entries(values).flatMap(([key, value]) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? [[key, Math.floor(number)]] : [];
  }));
}

function epochSecondsTimestamp(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return new Date(Math.floor(seconds * 1000)).toISOString();
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return decodeJsonString(match[1]);
  }
  return null;
}

function regexValues(text, pattern, limit) {
  const values = [];
  const seen = new Set();
  for (const match of text.matchAll(pattern)) {
    const value = match[1];
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}

function decodeJsonString(value) {
  try {
    return JSON.parse(`"${String(value).replace(/"/g, '\\"')}"`);
  } catch {
    return String(value ?? "").replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  }
}

function clean(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function earlier(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  return left < right ? left : right;
}

function later(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  return left > right ? left : right;
}

function dateIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("discoveredAt must be a valid date.");
  return date.toISOString();
}
