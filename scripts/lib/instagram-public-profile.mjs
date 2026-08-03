const INSTAGRAM_WEB_PROFILE_INFO_URL =
  "https://www.instagram.com/api/v1/users/web_profile_info/";
const DEFAULT_INSTAGRAM_APP_ID = "936619743392459";
const INSTAGRAM_PUBLIC_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";
const MAX_PAYLOAD_CODE_UNITS = 4_000_000;
const MAX_RECEIVED_EDGES = 5_000;
const MAX_PROCESSED_EDGES = 50;
const MAX_SIDECAR_CHILDREN = 20;
const MAX_COAUTHOR_USERNAMES = 20;
const MAX_CAPTION_CODE_UNITS = 20_000;
const MAX_CURSOR_CODE_UNITS = 2_000;
const MAX_MEDIA_URL_CODE_UNITS = 12_000;
const RESERVED_PROFILE_PATHS = new Set([
  "about",
  "accounts",
  "api",
  "developer",
  "direct",
  "explore",
  "p",
  "reel",
  "reels",
  "stories",
  "tv",
  "web"
]);
const SENSITIVE_QUERY_PARAMETER =
  /^(?:access_token|api_key|auth|authorization|cookie|credential|key|oh|oe|password|secret|session|sessionid|sig|signature|token|_nc_ohc|_nc_rid|_nc_sid)$/i;
const SENSITIVE_QUERY_PARAMETER_FRAGMENT =
  /(?:^|[_-])(?:access[_-]?token|auth|cookie|credential|password|secret|session|sig|signature|token)(?:$|[_-])/i;

/**
 * Build a bounded, anonymous request for Instagram's public profile metadata.
 * The result is intended to be passed as `fetch(request.url, request.options)`.
 * It never forwards cookies, authorization, or caller-supplied headers. The
 * fixed browser UA and exact canonical profile Referer satisfy Instagram's
 * anonymous same-profile request policy without carrying session material.
 */
export function instagramPublicProfileRequest({
  accountUrl,
  username,
  appId = DEFAULT_INSTAGRAM_APP_ID
} = {}) {
  const requestedFromArgument = normalizeInstagramUsername(username);
  const requestedFromUrl = instagramUsernameFromAccountUrl(accountUrl);
  if (username != null && !requestedFromArgument) {
    throw new TypeError("Instagram public profile username is invalid.");
  }
  if (accountUrl != null && !requestedFromUrl) {
    throw new TypeError("Instagram public profile account URL is invalid.");
  }
  if (
    requestedFromArgument &&
    requestedFromUrl &&
    requestedFromArgument !== requestedFromUrl
  ) {
    throw new TypeError("Instagram public profile account URL and username do not match.");
  }

  const requestedUsername = requestedFromArgument ?? requestedFromUrl;
  if (!requestedUsername) {
    throw new TypeError("Instagram public profile username or account URL is required.");
  }
  const normalizedAppId = normalizeAppId(appId);
  if (!normalizedAppId) {
    throw new TypeError("Instagram public profile app ID is invalid.");
  }

  const url = new URL(INSTAGRAM_WEB_PROFILE_INFO_URL);
  url.searchParams.set("username", requestedUsername);
  if (url.toString().length > 300) {
    throw new TypeError("Instagram public profile request URL exceeded its bound.");
  }

  return {
    username: requestedUsername,
    url: url.toString(),
    options: {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      headers: {
        accept: "application/json",
        "x-ig-app-id": normalizedAppId,
        referer: `https://www.instagram.com/${requestedUsername}/`,
        "user-agent": INSTAGRAM_PUBLIC_BROWSER_USER_AGENT
      }
    }
  };
}

/**
 * Parse inert JSON returned by web_profile_info. No partial rows are returned
 * when the envelope, exact profile identity, timeline, or any processed edge
 * is malformed. Auth, challenge, and rate-limit responses are also rejected.
 */
export function parseInstagramPublicProfileResponse({
  payload,
  requestedUsername,
  fetchedAt
} = {}) {
  const username = normalizeInstagramUsername(requestedUsername);
  const observedAt = validIsoDate(fetchedAt);
  if (!username || !observedAt) {
    return unverifiedProfile(
      "instagram_public_profile_input_invalid",
      username,
      observedAt
    );
  }

  const parsedPayload = parseBoundedPayload(payload);
  if (!parsedPayload.ok) {
    return unverifiedProfile(parsedPayload.reason, username, observedAt);
  }
  const root = parsedPayload.value;
  const failureReason = instagramPayloadFailureReason(root);
  if (failureReason) {
    return unverifiedProfile(failureReason, username, observedAt);
  }

  const user = root?.data?.user;
  if (!isPlainObject(user)) {
    return unverifiedProfile(
      "instagram_public_profile_user_missing",
      username,
      observedAt
    );
  }
  const responseUsername = normalizePayloadInstagramUsername(user.username);
  if (!responseUsername || responseUsername !== username) {
    return unverifiedProfile(
      "instagram_public_profile_username_mismatch",
      username,
      observedAt
    );
  }

  const timeline = user.edge_owner_to_timeline_media;
  const timelineShape = normalizeTimelineShape(timeline);
  if (!timelineShape.ok) {
    return unverifiedProfile(timelineShape.reason, username, observedAt);
  }

  const selectedEdges = timelineShape.edges.slice(0, MAX_PROCESSED_EDGES);
  const byShortcode = new Map();
  let duplicateEdgeCount = 0;
  let nestedDataTruncated = false;
  for (const edge of selectedEdges) {
    const parsedEdge = parseTimelineEdge(edge, username);
    if (!parsedEdge.ok) {
      return unverifiedProfile(parsedEdge.reason, username, observedAt);
    }
    nestedDataTruncated ||=
      parsedEdge.mediaTruncated || parsedEdge.coauthorTruncated;
    const existing = byShortcode.get(parsedEdge.post.shortcode);
    if (existing) {
      duplicateEdgeCount += 1;
      const merged = mergeDuplicatePost(existing, parsedEdge.post, username);
      if (!merged) {
        return unverifiedProfile(
          "instagram_public_profile_edge_malformed",
          username,
          observedAt
        );
      }
      nestedDataTruncated ||= merged.coauthorTruncated;
      byShortcode.set(parsedEdge.post.shortcode, merged.post);
    } else {
      byShortcode.set(parsedEdge.post.shortcode, parsedEdge.post);
    }
  }

  const receivedEdgeCount = timelineShape.edges.length;
  const truncated =
    receivedEdgeCount > MAX_PROCESSED_EDGES ||
    timelineShape.pageInfo.hasNextPage ||
    timelineShape.totalCount > receivedEdgeCount ||
    nestedDataTruncated;

  return {
    verified: true,
    reason: "instagram_public_web_profile_info_exact_profile_verified",
    username,
    accountUrl: `https://www.instagram.com/${username}/`,
    fetchedAt: observedAt,
    totalCount: timelineShape.totalCount,
    pageInfo: timelineShape.pageInfo,
    receivedEdgeCount,
    processedEdgeCount: selectedEdges.length,
    duplicateEdgeCount,
    truncated,
    posts: [...byShortcode.values()]
  };
}

function parseBoundedPayload(payload) {
  if (typeof payload === "string") {
    if (!payload.trim() || payload.length > MAX_PAYLOAD_CODE_UNITS) {
      return { ok: false, reason: "instagram_public_profile_payload_malformed" };
    }
    try {
      const parsed = JSON.parse(payload);
      return isPlainObject(parsed)
        ? { ok: true, value: parsed }
        : { ok: false, reason: "instagram_public_profile_payload_malformed" };
    } catch {
      return { ok: false, reason: "instagram_public_profile_payload_malformed" };
    }
  }
  return isPlainObject(payload)
    ? { ok: true, value: payload }
    : { ok: false, reason: "instagram_public_profile_payload_malformed" };
}

function instagramPayloadFailureReason(payload) {
  const statusCode = Number(
    payload?.status_code ?? payload?.statusCode ?? payload?.http_status ?? NaN
  );
  const explicitChallenge = Boolean(
    payload?.challenge ||
    payload?.challenge_context ||
    payload?.checkpoint_url ||
    payload?.checkpointUrl
  );
  const explicitRateLimit = payload?.rate_limited === true || statusCode === 429;
  const explicitAuth =
    payload?.login_required === true ||
    payload?.require_login === true ||
    statusCode === 401 ||
    statusCode === 403;
  const errorText = boundedErrorText([
    payload?.status,
    payload?.message,
    payload?.error,
    payload?.error_type,
    payload?.error_title,
    payload?.feedback_title,
    payload?.feedback_message
  ]);

  if (
    explicitChallenge ||
    /\b(?:challenge|required challenge|checkpoint|confirm it'?s you|security code|suspicious login)\b/i.test(errorText)
  ) {
    return "instagram_public_profile_challenge";
  }
  if (
    explicitRateLimit ||
    /\b(?:429|rate limit(?:ed)?|too many requests|please wait|slow down|try again later|temporarily restricted)\b/i.test(errorText)
  ) {
    return "instagram_public_profile_rate_limited";
  }
  if (
    explicitAuth ||
    /\b(?:401|403|login required|log in|sign in|authentication|unauthorized|forbidden|session expired)\b/i.test(errorText)
  ) {
    return "instagram_public_profile_auth_required";
  }

  const status = String(payload?.status ?? "").trim().toLowerCase();
  if (
    (status && status !== "ok") ||
    payload?.error != null ||
    payload?.error_type != null
  ) {
    return "instagram_public_profile_api_error";
  }
  return null;
}

function normalizeTimelineShape(timeline) {
  if (!isPlainObject(timeline) || !Array.isArray(timeline.edges)) {
    return { ok: false, reason: "instagram_public_profile_timeline_malformed" };
  }
  if (timeline.edges.length > MAX_RECEIVED_EDGES) {
    return { ok: false, reason: "instagram_public_profile_timeline_malformed" };
  }
  const totalCount = nonnegativeSafeInteger(timeline.count);
  const pageInfo = timeline.page_info;
  if (totalCount === null || !isPlainObject(pageInfo)) {
    return { ok: false, reason: "instagram_public_profile_timeline_malformed" };
  }
  if (typeof pageInfo.has_next_page !== "boolean") {
    return { ok: false, reason: "instagram_public_profile_timeline_malformed" };
  }
  const endCursor = pageInfo.end_cursor;
  if (
    endCursor != null &&
    (typeof endCursor !== "string" || endCursor.length > MAX_CURSOR_CODE_UNITS)
  ) {
    return { ok: false, reason: "instagram_public_profile_timeline_malformed" };
  }
  if (pageInfo.has_next_page && !String(endCursor ?? "").trim()) {
    return { ok: false, reason: "instagram_public_profile_timeline_malformed" };
  }

  return {
    ok: true,
    totalCount,
    edges: timeline.edges,
    pageInfo: {
      hasNextPage: pageInfo.has_next_page,
      endCursor: endCursor == null ? null : endCursor
    }
  };
}

function parseTimelineEdge(edge, profileUsername) {
  if (!isPlainObject(edge) || !isPlainObject(edge.node)) {
    return { ok: false, reason: "instagram_public_profile_edge_malformed" };
  }
  const node = edge.node;
  const shortcode = normalizeShortcode(node.shortcode);
  const postedAt = timestampSecondsToIso(node.taken_at_timestamp);
  if (!shortcode || !postedAt) {
    return { ok: false, reason: "instagram_public_profile_edge_malformed" };
  }
  if (!isPlainObject(node.owner)) {
    return { ok: false, reason: "instagram_public_profile_edge_malformed" };
  }
  const authorUsername = normalizePayloadInstagramUsername(node.owner.username);
  if (!authorUsername) {
    return { ok: false, reason: "instagram_public_profile_edge_malformed" };
  }
  const coauthors = instagramCoauthorUsernames(
    node.coauthor_producers,
    authorUsername
  );
  if (!coauthors.ok) {
    return { ok: false, reason: "instagram_public_profile_edge_malformed" };
  }

  const caption = instagramCaption(node.edge_media_to_caption);
  if (!caption.ok) {
    return { ok: false, reason: "instagram_public_profile_edge_malformed" };
  }
  const metrics = instagramMetrics(node);
  if (!metrics.ok) {
    return { ok: false, reason: "instagram_public_profile_edge_malformed" };
  }
  const media = instagramMediaUrls(node);
  if (!media.ok || media.urls.length === 0) {
    return { ok: false, reason: "instagram_public_profile_edge_malformed" };
  }

  const mediaType = isVideoNode(node) ? "reel" : "post";
  return {
    ok: true,
    mediaTruncated: media.truncated,
    coauthorTruncated: coauthors.truncated,
    post: {
      shortcode,
      url: `https://www.instagram.com/${mediaType === "reel" ? "reel" : "p"}/${shortcode}/`,
      mediaType,
      authorUsername,
      coauthorUsernames: coauthors.usernames,
      profileRole: instagramProfileRole(
        profileUsername,
        authorUsername,
        coauthors.usernames
      ),
      caption: caption.text,
      postedAt,
      metrics: metrics.value,
      mediaUrls: media.urls
    }
  };
}

function instagramCoauthorUsernames(value, authorUsername) {
  if (value == null) {
    return { ok: true, usernames: [], truncated: false };
  }
  if (!Array.isArray(value)) return { ok: false, usernames: [], truncated: false };
  const usernames = [];
  for (const producer of value.slice(0, MAX_COAUTHOR_USERNAMES)) {
    if (!isPlainObject(producer)) {
      return { ok: false, usernames: [], truncated: false };
    }
    const username = normalizePayloadInstagramUsername(producer.username);
    if (!username) return { ok: false, usernames: [], truncated: false };
    if (username !== authorUsername && !usernames.includes(username)) {
      usernames.push(username);
    }
  }
  return {
    ok: true,
    usernames,
    truncated: value.length > MAX_COAUTHOR_USERNAMES
  };
}

function instagramProfileRole(profileUsername, authorUsername, coauthorUsernames) {
  if (authorUsername === profileUsername) return "primary";
  if (coauthorUsernames.includes(profileUsername)) return "coauthor";
  return "surface_only";
}

function instagramCaption(value) {
  if (value == null) return { ok: true, text: "" };
  if (!isPlainObject(value) || !Array.isArray(value.edges)) return { ok: false };
  const captions = [];
  for (const edge of value.edges.slice(0, 5)) {
    if (!isPlainObject(edge) || !isPlainObject(edge.node)) return { ok: false };
    if (edge.node.text == null) continue;
    if (typeof edge.node.text !== "string") return { ok: false };
    captions.push(cleanMultilineText(edge.node.text));
  }
  const text = captions.find(Boolean) ?? "";
  return {
    ok: true,
    text: text.slice(0, MAX_CAPTION_CODE_UNITS)
  };
}

function instagramMetrics(node) {
  const likes = metricFromCandidates([
    node?.edge_media_preview_like?.count,
    node?.edge_liked_by?.count,
    node?.like_count
  ]);
  const comments = metricFromCandidates([
    node?.edge_media_to_parent_comment?.count,
    node?.edge_media_to_comment?.count,
    node?.comment_count
  ]);
  const videoViews = metricFromCandidates([
    node?.video_view_count,
    node?.video_views
  ]);
  const videoPlays = metricFromCandidates([
    node?.video_play_count,
    node?.play_count,
    node?.video_plays
  ]);
  if ([likes, comments, videoViews, videoPlays].some((item) => !item.ok)) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      likes: likes.value,
      comments: comments.value,
      videoViews: videoViews.value,
      videoPlays: videoPlays.value
    }
  };
}

function metricFromCandidates(values) {
  let sawValue = false;
  const counts = [];
  for (const value of values) {
    if (value == null) continue;
    sawValue = true;
    const count = nonnegativeSafeInteger(value);
    if (count === null) return { ok: false, value: null };
    counts.push(count);
  }
  return {
    ok: true,
    value: sawValue ? Math.max(...counts) : null
  };
}

function instagramMediaUrls(node) {
  const candidates = [node.display_url, node.thumbnail_src, node.video_url];
  let truncated = false;
  if (node.edge_sidecar_to_children != null) {
    const sidecar = node.edge_sidecar_to_children;
    if (!isPlainObject(sidecar) || !Array.isArray(sidecar.edges)) {
      return { ok: false, urls: [], truncated };
    }
    truncated = sidecar.edges.length > MAX_SIDECAR_CHILDREN;
    for (const edge of sidecar.edges.slice(0, MAX_SIDECAR_CHILDREN)) {
      if (!isPlainObject(edge) || !isPlainObject(edge.node)) {
        return { ok: false, urls: [], truncated };
      }
      candidates.push(
        edge.node.display_url,
        edge.node.thumbnail_src,
        edge.node.video_url
      );
    }
  }

  const urls = [];
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") continue;
    const sanitized = sanitizedMediaUrl(candidate);
    if (!sanitized) return { ok: false, urls: [], truncated };
    if (!urls.includes(sanitized)) urls.push(sanitized);
  }
  return { ok: true, urls, truncated };
}

function sanitizedMediaUrl(value) {
  if (typeof value !== "string" || value.length > MAX_MEDIA_URL_CODE_UNITS) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (
        SENSITIVE_QUERY_PARAMETER.test(key) ||
        SENSITIVE_QUERY_PARAMETER_FRAGMENT.test(key)
      ) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function mergeDuplicatePost(existing, incoming, profileUsername) {
  if (
    existing.authorUsername !== incoming.authorUsername ||
    existing.mediaType !== incoming.mediaType ||
    existing.postedAt !== incoming.postedAt
  ) {
    return null;
  }
  const allCoauthors = [...new Set([
    ...existing.coauthorUsernames,
    ...incoming.coauthorUsernames
  ])];
  const coauthorUsernames = allCoauthors.slice(0, MAX_COAUTHOR_USERNAMES);
  return {
    coauthorTruncated: allCoauthors.length > MAX_COAUTHOR_USERNAMES,
    post: {
      ...existing,
      coauthorUsernames,
      profileRole: instagramProfileRole(
        profileUsername,
        existing.authorUsername,
        coauthorUsernames
      ),
      caption: existing.caption || incoming.caption,
      metrics: {
        likes: maxNullableMetric(existing.metrics.likes, incoming.metrics.likes),
        comments: maxNullableMetric(existing.metrics.comments, incoming.metrics.comments),
        videoViews: maxNullableMetric(
          existing.metrics.videoViews,
          incoming.metrics.videoViews
        ),
        videoPlays: maxNullableMetric(
          existing.metrics.videoPlays,
          incoming.metrics.videoPlays
        )
      },
      mediaUrls: [...new Set([...existing.mediaUrls, ...incoming.mediaUrls])]
    }
  };
}

function maxNullableMetric(...values) {
  const finite = values.filter((value) => Number.isSafeInteger(value) && value >= 0);
  return finite.length ? Math.max(...finite) : null;
}

function isVideoNode(node) {
  const type = String(node?.__typename ?? "").trim().toLowerCase();
  const productType = String(node?.product_type ?? "").trim().toLowerCase();
  return (
    node?.is_video === true ||
    type === "graphvideo" ||
    ["clips", "reel", "reels"].includes(productType)
  );
}

function instagramUsernameFromAccountUrl(value) {
  if (value == null || value === "") return null;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (
      parsed.protocol !== "https:" ||
      hostname !== "instagram.com" ||
      parts.length !== 1 ||
      RESERVED_PROFILE_PATHS.has(parts[0].toLowerCase())
    ) {
      return null;
    }
    return normalizeInstagramUsername(parts[0]);
  } catch {
    return null;
  }
}

function normalizeInstagramUsername(value) {
  const username = String(value ?? "").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_.]{1,30}$/.test(username) ? username : null;
}

function normalizePayloadInstagramUsername(value) {
  const username = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9_.]{1,30}$/.test(username) ? username : null;
}

function normalizeAppId(value) {
  const appId = String(value ?? "").trim();
  return /^\d{6,32}$/.test(appId) ? appId : null;
}

function normalizeShortcode(value) {
  const shortcode = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(shortcode) ? shortcode : null;
}

function timestampSecondsToIso(value) {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1) return null;
  const millis = seconds * 1_000;
  if (!Number.isSafeInteger(millis)) return null;
  const parsed = new Date(millis);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function validIsoDate(value) {
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function nonnegativeSafeInteger(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function boundedErrorText(values) {
  return values
    .flatMap((value) => {
      if (typeof value === "string") return [value];
      if (typeof value === "number" || typeof value === "boolean") {
        return [String(value)];
      }
      if (isPlainObject(value)) {
        return [value.message, value.error, value.title]
          .filter((item) => typeof item === "string");
      }
      return [];
    })
    .join(" ")
    .slice(0, 10_000);
}

function cleanMultilineText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unverifiedProfile(reason, requestedUsername, fetchedAt) {
  return {
    verified: false,
    reason,
    username: requestedUsername ?? null,
    accountUrl: requestedUsername
      ? `https://www.instagram.com/${requestedUsername}/`
      : null,
    fetchedAt: fetchedAt ?? null,
    totalCount: null,
    pageInfo: null,
    receivedEdgeCount: 0,
    processedEdgeCount: 0,
    duplicateEdgeCount: 0,
    truncated: false,
    posts: []
  };
}
