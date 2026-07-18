export const CANONICAL_EVIDENCE_PLATFORMS = [
  "x",
  "youtube",
  "github",
  "reddit",
  "product_hunt",
  "hacker_news",
  "instagram",
  "linkedin",
  "bluesky",
  "tiktok",
  "bilibili"
] as const;

export type CanonicalEvidencePlatform = (typeof CANONICAL_EVIDENCE_PLATFORMS)[number];
export type CanonicalEvidenceObjectType =
  | "post"
  | "video"
  | "repository"
  | "launch"
  | "story";
export type CanonicalEvidenceUrlClassification =
  | "native_object"
  | "profile"
  | "search"
  | "context"
  | "invalid";

export type CanonicalEvidenceRejectionReason =
  | "unsupported_platform"
  | "context_only_platform"
  | "traction_not_supported"
  | "missing_url"
  | "invalid_url"
  | "platform_host_mismatch"
  | "profile_page"
  | "search_page"
  | "not_native_object"
  | "invalid_native_id"
  | "native_id_conflict"
  | "invalid_metrics"
  | "no_visible_positive_metrics";

export interface CanonicalUrlNormalization {
  platform: CanonicalEvidencePlatform | null;
  sourceUrl: string;
  canonicalUrl: string | null;
  nativeId: string | null;
  objectType: CanonicalEvidenceObjectType | null;
  classification: CanonicalEvidenceUrlClassification;
  reason:
    | "invalid_url"
    | "platform_host_mismatch"
    | "profile_page"
    | "search_page"
    | "not_native_object"
    | "unsupported_platform"
    | null;
}

export interface CanonicalEvidenceInput {
  platform: string;
  sourceUrl?: string | null;
  nativeId?: string | null;
  author?: string | null;
  timestamp?: string | null;
  content?: string | null;
  text?: string | null;
  title?: string | null;
  metrics?: Readonly<Record<string, number | null | undefined>> | null;
  /** When omitted, supplied metric fields are considered visible. */
  metricsVisible?: boolean;
  /** When supplied, only these metric keys count as visibly observed. */
  visibleMetricKeys?: readonly string[] | null;
}

export interface CanonicalEvidenceValidation {
  validNativeObject: boolean;
  tractionEligible: boolean;
  rejectionReasons: CanonicalEvidenceRejectionReason[];
}

export interface CanonicalEvidence {
  sourcePlatform: string;
  platform: CanonicalEvidencePlatform | null;
  sourceUrl: string;
  canonicalUrl: string | null;
  suppliedNativeId: string | null;
  nativeId: string | null;
  nativeIdSource: "url" | "supplied" | null;
  objectType: CanonicalEvidenceObjectType | null;
  classification: CanonicalEvidenceUrlClassification;
  author: string | null;
  timestamp: string | null;
  content: string | null;
  metrics: Readonly<Record<string, number | null>>;
  visiblePositiveMetrics: Readonly<Record<string, number>>;
  validNativeObject: boolean;
  tractionEligible: boolean;
  rejectionReasons: CanonicalEvidenceRejectionReason[];
  dedupeKey: string;
}

export interface CanonicalEvidenceDedupeInput {
  platform: string;
  nativeId?: string | null;
  canonicalUrl?: string | null;
  sourceUrl?: string | null;
  author?: string | null;
  timestamp?: string | null;
  content?: string | null;
  text?: string | null;
  title?: string | null;
}

const PLATFORM_ALIASES: Readonly<Record<string, CanonicalEvidencePlatform>> = {
  x: "x",
  twitter: "x",
  youtube: "youtube",
  yt: "youtube",
  github: "github",
  reddit: "reddit",
  product_hunt: "product_hunt",
  producthunt: "product_hunt",
  hacker_news: "hacker_news",
  hackernews: "hacker_news",
  hn: "hacker_news",
  instagram: "instagram",
  linkedin: "linkedin",
  bluesky: "bluesky",
  bsky: "bluesky",
  tiktok: "tiktok",
  bilibili: "bilibili"
};

const CONTEXT_ONLY_PLATFORMS = new Set(["rss", "web"]);
const TRACTION_PLATFORMS = new Set<CanonicalEvidencePlatform>([
  "x",
  "youtube",
  "github",
  "reddit",
  "product_hunt",
  "hacker_news",
  "instagram",
  "linkedin",
  "bilibili"
]);
const TRACKING_PARAMETER = /^(?:utm_.+|fbclid|gclid|dclid|igshid|mc_.+|ref|ref_src|source|si|feature|trk|trackingid)$/i;
const OBJECT_ID = /^[A-Za-z0-9_-]+$/;
const REDDIT_ID = /^[A-Za-z0-9]+$/;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+$/;
const GITHUB_RESERVED_OWNERS = new Set([
  "about",
  "account",
  "apps",
  "collections",
  "codespaces",
  "enterprise",
  "events",
  "explore",
  "features",
  "gist",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "settings",
  "signup",
  "sponsors",
  "topics",
  "users"
]);

export function normalizeEvidencePlatform(value: string): CanonicalEvidencePlatform | null {
  return PLATFORM_ALIASES[value.trim().toLowerCase().replace(/[ -]+/g, "_")] ?? null;
}

export function normalizeCanonicalEvidenceUrl(
  platformValue: string,
  rawUrl: string
): CanonicalUrlNormalization {
  const platform = normalizeEvidencePlatform(platformValue);
  const sourceUrl = rawUrl.trim();
  const parsed = parseHttpUrl(sourceUrl);

  if (!parsed) {
    return urlResult(platform, sourceUrl, null, "invalid", "invalid_url");
  }

  stripUrlNoise(parsed);
  if (!platform) {
    return {
      ...urlResult(null, sourceUrl, genericCanonicalUrl(parsed), "context", "unsupported_platform"),
      canonicalUrl: genericCanonicalUrl(parsed)
    };
  }

  return normalizePlatformUrl(platform, sourceUrl, parsed);
}

/** Returns only the canonical URL for callers that do not need classification details. */
export function canonicalEvidenceUrl(platform: string, rawUrl: string): string | null {
  return normalizeCanonicalEvidenceUrl(platform, rawUrl).canonicalUrl;
}

/** Derives an ID only from an unambiguous platform-native object URL. */
export function deriveNativeEvidenceId(platform: string, rawUrl: string): string | null {
  const normalized = normalizeCanonicalEvidenceUrl(platform, rawUrl);
  return normalized.classification === "native_object" ? normalized.nativeId : null;
}

export function normalizeCanonicalEvidence(input: CanonicalEvidenceInput): CanonicalEvidence {
  const sourcePlatform = input.platform.trim();
  const platform = normalizeEvidencePlatform(sourcePlatform);
  const sourceUrl = input.sourceUrl?.trim() ?? "";
  const url = sourceUrl
    ? normalizeCanonicalEvidenceUrl(sourcePlatform, sourceUrl)
    : urlResult(platform, sourceUrl, null, "invalid", "invalid_url");
  const suppliedNativeId = normalizeSuppliedNativeId(platform, input.nativeId);
  const suppliedNativeIdWasInvalid = Boolean(input.nativeId?.trim()) && suppliedNativeId === null;
  const nativeIdConflict = Boolean(
    url.nativeId && suppliedNativeId && url.nativeId !== suppliedNativeId
  );
  const nativeId = url.nativeId ?? suppliedNativeId;
  const nativeIdSource = url.nativeId ? "url" : suppliedNativeId ? "supplied" : null;
  const normalizedMetrics = normalizeMetrics(input.metrics);
  const visiblePositiveMetrics = positiveVisibleMetrics(
    normalizedMetrics.metrics,
    input.metricsVisible,
    input.visibleMetricKeys
  );
  const validation = validationFor({
    sourcePlatform,
    platform,
    sourceUrl,
    url,
    suppliedNativeIdWasInvalid,
    nativeIdConflict,
    invalidMetrics: normalizedMetrics.invalid,
    hasVisiblePositiveMetrics: Object.keys(visiblePositiveMetrics).length > 0
  });
  const author = nullableTrim(input.author);
  const timestamp = nullableTrim(input.timestamp);
  const content = nullableTrim(input.content ?? input.text ?? input.title);
  const canonical: Omit<CanonicalEvidence, "dedupeKey"> = {
    sourcePlatform,
    platform,
    sourceUrl,
    canonicalUrl: url.canonicalUrl,
    suppliedNativeId,
    nativeId,
    nativeIdSource,
    objectType: url.objectType,
    classification: url.classification,
    author,
    timestamp,
    content,
    metrics: normalizedMetrics.metrics,
    visiblePositiveMetrics,
    ...validation
  };

  return {
    ...canonical,
    dedupeKey: canonicalEvidenceDedupeKey({
      ...canonical,
      platform: canonical.platform ?? canonical.sourcePlatform
    })
  };
}

export function validateCanonicalEvidence(input: CanonicalEvidenceInput): CanonicalEvidenceValidation {
  const canonical = normalizeCanonicalEvidence(input);
  return {
    validNativeObject: canonical.validNativeObject,
    tractionEligible: canonical.tractionEligible,
    rejectionReasons: [...canonical.rejectionReasons]
  };
}

export function canonicalEvidenceDedupeKey(input: CanonicalEvidenceDedupeInput): string {
  const platform = normalizeEvidencePlatform(input.platform);
  const platformKey = platform ?? (normalizeFingerprintPart(input.platform) || "unknown");
  const nativeId = normalizeSuppliedNativeId(platform, input.nativeId)
    ?? (platform ? deriveNativeEvidenceId(platform, input.canonicalUrl ?? input.sourceUrl ?? "") : null);

  if (nativeId) {
    return `${platformKey}:native:${nativeId}`;
  }

  const canonicalUrl = canonicalUrlForDedupe(input, platformKey);
  if (canonicalUrl) {
    return `${platformKey}:url:${canonicalUrl}`;
  }

  return `${platformKey}:fingerprint:${canonicalEvidenceContentFingerprint(input)}`;
}

export function canonicalEvidenceContentFingerprint(
  input: Pick<CanonicalEvidenceDedupeInput, "author" | "timestamp" | "content" | "text" | "title">
): string {
  const timestamp = normalizeTimestampForFingerprint(input.timestamp);
  const components = [
    normalizeFingerprintPart(input.author).replace(/^@/, ""),
    timestamp,
    normalizeFingerprintPart(input.content ?? input.text ?? input.title)
  ];
  return fnv1a64(components.join("\u001f"));
}

function validationFor(input: {
  sourcePlatform: string;
  platform: CanonicalEvidencePlatform | null;
  sourceUrl: string;
  url: CanonicalUrlNormalization;
  suppliedNativeIdWasInvalid: boolean;
  nativeIdConflict: boolean;
  invalidMetrics: boolean;
  hasVisiblePositiveMetrics: boolean;
}): CanonicalEvidenceValidation {
  const reasons: CanonicalEvidenceRejectionReason[] = [];
  const sourcePlatformKey = input.sourcePlatform.toLowerCase().replace(/[ -]+/g, "_");

  if (!input.platform) {
    reasons.push(
      CONTEXT_ONLY_PLATFORMS.has(sourcePlatformKey)
        ? "context_only_platform"
        : "unsupported_platform"
    );
  }
  if (!input.sourceUrl) {
    reasons.push("missing_url");
  } else if (input.url.reason && input.url.reason !== "unsupported_platform") {
    reasons.push(input.url.reason);
  }
  if (input.suppliedNativeIdWasInvalid) reasons.push("invalid_native_id");
  if (input.nativeIdConflict) reasons.push("native_id_conflict");
  if (input.invalidMetrics) reasons.push("invalid_metrics");

  const nativeObject = input.url.classification === "native_object";
  if (nativeObject && input.platform && !TRACTION_PLATFORMS.has(input.platform)) {
    reasons.push("traction_not_supported");
  }
  if (nativeObject && !input.hasVisiblePositiveMetrics) {
    reasons.push("no_visible_positive_metrics");
  }

  const rejectionReasons = [...new Set(reasons)];
  const validNativeObject = nativeObject && !input.nativeIdConflict && !input.suppliedNativeIdWasInvalid;
  const tractionEligible = Boolean(
    validNativeObject &&
      input.platform &&
      TRACTION_PLATFORMS.has(input.platform) &&
      !input.invalidMetrics &&
      input.hasVisiblePositiveMetrics
  );

  return { validNativeObject, tractionEligible, rejectionReasons };
}

function normalizePlatformUrl(
  platform: CanonicalEvidencePlatform,
  sourceUrl: string,
  url: URL
): CanonicalUrlNormalization {
  const host = normalizedHost(url.hostname);
  const path = normalizedPath(url.pathname);

  switch (platform) {
    case "x":
      return normalizeXUrl(platform, sourceUrl, url, host, path);
    case "youtube":
      return normalizeYouTubeUrl(platform, sourceUrl, url, host, path);
    case "github":
      return normalizeGitHubUrl(platform, sourceUrl, url, host, path);
    case "reddit":
      return normalizeRedditUrl(platform, sourceUrl, url, host, path);
    case "product_hunt":
      return normalizeProductHuntUrl(platform, sourceUrl, url, host, path);
    case "hacker_news":
      return normalizeHackerNewsUrl(platform, sourceUrl, url, host, path);
    case "instagram":
      return normalizeInstagramUrl(platform, sourceUrl, url, host, path);
    case "linkedin":
      return normalizeLinkedInUrl(platform, sourceUrl, url, host, path);
    case "bluesky":
      return normalizeBlueskyUrl(platform, sourceUrl, url, host, path);
    case "tiktok":
      return normalizeTikTokUrl(platform, sourceUrl, url, host, path);
    case "bilibili":
      return normalizeBilibiliUrl(platform, sourceUrl, url, host, path);
  }
}

function normalizeXUrl(
  platform: CanonicalEvidencePlatform,
  sourceUrl: string,
  url: URL,
  host: string,
  path: string
): CanonicalUrlNormalization {
  if (!hostIn(host, "x.com", "twitter.com")) return hostMismatch(platform, sourceUrl, url);
  const status = path.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?$/i);
  if (status) {
    return nativeResult(platform, sourceUrl, `https://x.com/${status[1].toLowerCase()}/status/${status[2]}`, status[2], "post");
  }
  const webStatus = path.match(/^\/i\/(?:web\/)?status\/(\d+)$/i);
  if (webStatus) {
    return nativeResult(platform, sourceUrl, `https://x.com/i/status/${webStatus[1]}`, webStatus[1], "post");
  }
  return nonObjectResult(platform, sourceUrl, canonicalWith(url, "x.com", path), routeClassification(path, ["/search", "/hashtag", "/explore"], [/^\/[A-Za-z0-9_]{1,15}(?:\/with_replies|\/media|\/likes)?$/i]));
}

function normalizeYouTubeUrl(
  platform: CanonicalEvidencePlatform,
  sourceUrl: string,
  url: URL,
  host: string,
  path: string
): CanonicalUrlNormalization {
  let videoId: string | null = null;
  if (host === "youtu.be") videoId = validObjectId(path.slice(1));
  if (hostIn(host, "youtube.com", "youtube-nocookie.com")) {
    if (path === "/watch") videoId = validObjectId(url.searchParams.get("v"));
    videoId ??= path.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]+)$/i)?.[1] ?? null;
  }
  if (videoId) {
    return nativeResult(platform, sourceUrl, `https://youtube.com/watch?v=${videoId}`, videoId, "video");
  }
  if (!hostIn(host, "youtube.com", "youtube-nocookie.com", "youtu.be")) {
    return hostMismatch(platform, sourceUrl, url);
  }
  const classification = routeClassification(
    path,
    ["/results", "/search"],
    [/^\/@[^/]+$/i, /^\/(?:channel|c|user)\/[^/]+$/i]
  );
  return nonObjectResult(platform, sourceUrl, canonicalWith(url, "youtube.com", path), classification);
}

function normalizeGitHubUrl(
  platform: CanonicalEvidencePlatform,
  sourceUrl: string,
  url: URL,
  host: string,
  path: string
): CanonicalUrlNormalization {
  if (host !== "github.com") return hostMismatch(platform, sourceUrl, url);
  const parts = path.split("/").filter(Boolean);
  const owner = parts[0] ?? "";
  const repository = (parts[1] ?? "").replace(/\.git$/i, "");
  if (validGitHubRepository(owner, repository)) {
    const nativeId = `${owner.toLowerCase()}/${repository.toLowerCase()}`;
    return nativeResult(platform, sourceUrl, `https://github.com/${nativeId}`, nativeId, "repository");
  }
  const classification = path === "/search" || path.startsWith("/search/") ? "search" : parts.length === 1 && GITHUB_OWNER.test(owner) ? "profile" : "context";
  return nonObjectResult(platform, sourceUrl, canonicalWith(url, "github.com", path), classification);
}

function normalizeRedditUrl(
  platform: CanonicalEvidencePlatform,
  sourceUrl: string,
  url: URL,
  host: string,
  path: string
): CanonicalUrlNormalization {
  const shortId = host === "redd.it" ? path.match(/^\/([A-Za-z0-9]+)$/)?.[1] : null;
  const postId = shortId ?? path.match(/^\/(?:r\/[^/]+\/)?comments\/([A-Za-z0-9]+)(?:\/.*)?$/i)?.[1] ?? null;
  if (postId && REDDIT_ID.test(postId) && hostIn(host, "reddit.com", "redd.it")) {
    const nativeId = postId.toLowerCase();
    return nativeResult(platform, sourceUrl, `https://reddit.com/comments/${nativeId}`, nativeId, "post");
  }
  if (!hostIn(host, "reddit.com", "redd.it")) return hostMismatch(platform, sourceUrl, url);
  const classification = path === "/search" || path.startsWith("/search/") ? "search" : /^\/(?:r|user|u)\/[^/]+$/i.test(path) ? "profile" : "context";
  return nonObjectResult(platform, sourceUrl, canonicalWith(url, "reddit.com", path), classification);
}

function normalizeProductHuntUrl(
  platform: CanonicalEvidencePlatform,
  sourceUrl: string,
  url: URL,
  host: string,
  path: string
): CanonicalUrlNormalization {
  if (host !== "producthunt.com") return hostMismatch(platform, sourceUrl, url);
  const post = path.match(/^\/posts\/([A-Za-z0-9][A-Za-z0-9_-]*)$/i);
  if (post) {
    const nativeId = `posts/${post[1].toLowerCase()}`;
    return nativeResult(platform, sourceUrl, `https://producthunt.com/${nativeId}`, nativeId, "launch");
  }
  const launch = path.match(/^\/products\/([A-Za-z0-9][A-Za-z0-9_-]*)\/launches\/([A-Za-z0-9][A-Za-z0-9_-]*)$/i);
  if (launch) {
    const nativeId = `products/${launch[1].toLowerCase()}/launches/${launch[2].toLowerCase()}`;
    return nativeResult(platform, sourceUrl, `https://producthunt.com/${nativeId}`, nativeId, "launch");
  }
  const discussion = path.match(/^\/p\/([A-Za-z0-9][A-Za-z0-9_-]*)\/([A-Za-z0-9][A-Za-z0-9_-]*)$/i);
  if (discussion) {
    const nativeId = `p/${discussion[1].toLowerCase()}/${discussion[2].toLowerCase()}`;
    return nativeResult(platform, sourceUrl, `https://producthunt.com/${nativeId}`, nativeId, "post");
  }
  const classification = path === "/search" || path.startsWith("/search/") ? "search" : /^\/(?:products|@)\/[^/]+$/i.test(path) || /^\/@[^/]+$/i.test(path) ? "profile" : "context";
  return nonObjectResult(platform, sourceUrl, canonicalWith(url, "producthunt.com", path), classification);
}

function normalizeHackerNewsUrl(
  platform: CanonicalEvidencePlatform,
  sourceUrl: string,
  url: URL,
  host: string,
  path: string
): CanonicalUrlNormalization {
  if (host !== "news.ycombinator.com") return hostMismatch(platform, sourceUrl, url);
  const id = path === "/item" && /^\d+$/.test(url.searchParams.get("id") ?? "")
    ? url.searchParams.get("id")
    : null;
  if (id) {
    return nativeResult(platform, sourceUrl, `https://news.ycombinator.com/item?id=${id}`, id, "story");
  }
  const classification = path === "/user" ? "profile" : path === "/from" ? "search" : "context";
  return nonObjectResult(platform, sourceUrl, canonicalWith(url, "news.ycombinator.com", path), classification);
}

function normalizeInstagramUrl(
  platform: CanonicalEvidencePlatform,
  sourceUrl: string,
  url: URL,
  host: string,
  path: string
): CanonicalUrlNormalization {
  if (host !== "instagram.com") return hostMismatch(platform, sourceUrl, url);
  const post = path.match(/^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)$/i);
  if (post) {
    const route = post[1].toLowerCase() === "reels" ? "reel" : post[1].toLowerCase();
    return nativeResult(platform, sourceUrl, `https://instagram.com/${route}/${post[2]}`, post[2], "post");
  }
  const classification = path === "/explore" || path.startsWith("/explore/") ? "search" : /^\/[A-Za-z0-9._]+$/i.test(path) ? "profile" : "context";
  return nonObjectResult(platform, sourceUrl, canonicalWith(url, "instagram.com", path), classification);
}

function normalizeLinkedInUrl(
  platform: CanonicalEvidencePlatform,
  sourceUrl: string,
  url: URL,
  host: string,
  path: string
): CanonicalUrlNormalization {
  if (host !== "linkedin.com") return hostMismatch(platform, sourceUrl, url);
  const decodedPath = safeDecode(path);
  const activityId = decodedPath.match(/^\/feed\/update\/urn:li:(?:activity|share):(\d+)$/i)?.[1]
    ?? decodedPath.match(/^\/posts\/[^/]*activity[-:](\d+)[^/]*$/i)?.[1]
    ?? null;
  if (activityId) {
    return nativeResult(platform, sourceUrl, `https://linkedin.com/feed/update/urn:li:activity:${activityId}`, activityId, "post");
  }
  const classification = path === "/search" || path.startsWith("/search/") ? "search" : /^\/(?:in|company|school|showcase)\/[^/]+$/i.test(path) ? "profile" : "context";
  return nonObjectResult(platform, sourceUrl, canonicalWith(url, "linkedin.com", path), classification);
}

function normalizeBlueskyUrl(
  platform: CanonicalEvidencePlatform,
  sourceUrl: string,
  url: URL,
  host: string,
  path: string
): CanonicalUrlNormalization {
  if (host !== "bsky.app") return hostMismatch(platform, sourceUrl, url);
  const post = path.match(/^\/profile\/([^/]+)\/post\/([A-Za-z0-9._~:-]+)$/i);
  if (post) {
    const author = post[1].toLowerCase();
    const nativeId = `${author}/post/${post[2]}`;
    return nativeResult(platform, sourceUrl, `https://bsky.app/profile/${nativeId}`, nativeId, "post");
  }
  const classification = path === "/search" || path.startsWith("/search/") ? "search" : /^\/profile\/[^/]+$/i.test(path) ? "profile" : "context";
  return nonObjectResult(platform, sourceUrl, canonicalWith(url, "bsky.app", path), classification);
}

function normalizeTikTokUrl(
  platform: CanonicalEvidencePlatform,
  sourceUrl: string,
  url: URL,
  host: string,
  path: string
): CanonicalUrlNormalization {
  if (host !== "tiktok.com") return hostMismatch(platform, sourceUrl, url);
  const video = path.match(/^\/@([A-Za-z0-9._-]+)\/video\/(\d+)$/i);
  if (video) {
    return nativeResult(platform, sourceUrl, `https://tiktok.com/@${video[1].toLowerCase()}/video/${video[2]}`, video[2], "video");
  }
  const classification = path === "/search" || path.startsWith("/search/") ? "search" : /^\/@[A-Za-z0-9._-]+$/i.test(path) ? "profile" : "context";
  return nonObjectResult(platform, sourceUrl, canonicalWith(url, "tiktok.com", path), classification);
}

function normalizeBilibiliUrl(
  platform: CanonicalEvidencePlatform,
  sourceUrl: string,
  url: URL,
  host: string,
  path: string
): CanonicalUrlNormalization {
  if (host !== "bilibili.com") return hostMismatch(platform, sourceUrl, url);
  const video = path.match(/^\/video\/((?:BV[A-Za-z0-9]+)|(?:av\d+))$/i);
  if (video) {
    const nativeId = /^bv/i.test(video[1]) ? `BV${video[1].slice(2)}` : `av${video[1].replace(/^av/i, "")}`;
    return nativeResult(platform, sourceUrl, `https://bilibili.com/video/${nativeId}`, nativeId, "video");
  }
  const classification = path === "/search" || path.startsWith("/search/") ? "search" : /^\/\d+$/i.test(path) || path.startsWith("/space/") ? "profile" : "context";
  return nonObjectResult(platform, sourceUrl, canonicalWith(url, "bilibili.com", path), classification);
}

function normalizeSuppliedNativeId(
  platform: CanonicalEvidencePlatform | null,
  rawValue: string | null | undefined
): string | null {
  const value = rawValue?.trim();
  if (!platform || !value) return null;
  if (/^https?:\/\//i.test(value)) return deriveNativeEvidenceId(platform, value);

  switch (platform) {
    case "x":
    case "linkedin":
    case "hacker_news":
    case "tiktok":
      return /^\d+$/.test(value) ? value : null;
    case "youtube":
    case "instagram":
      return validObjectId(value);
    case "reddit": {
      const id = value.replace(/^t3_/i, "");
      return REDDIT_ID.test(id) ? id.toLowerCase() : null;
    }
    case "github": {
      const [owner, repository, ...rest] = value.replace(/^\/+|\/+$/g, "").split("/");
      return !rest.length && validGitHubRepository(owner, repository)
        ? `${owner.toLowerCase()}/${repository.replace(/\.git$/i, "").toLowerCase()}`
        : null;
    }
    case "product_hunt": {
      const normalized = value.replace(/^\/+|\/+$/g, "").toLowerCase();
      return /^(?:posts\/[a-z0-9][a-z0-9_-]*|p\/[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*|products\/[a-z0-9][a-z0-9_-]*\/launches\/[a-z0-9][a-z0-9_-]*)$/.test(normalized)
        ? normalized
        : null;
    }
    case "bluesky": {
      const atUri = value.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._~:-]+)$/i);
      if (atUri) return `${atUri[1].toLowerCase()}/post/${atUri[2]}`;
      const nativeId = value.match(/^([^/]+)\/post\/([A-Za-z0-9._~:-]+)$/i);
      return nativeId ? `${nativeId[1].toLowerCase()}/post/${nativeId[2]}` : null;
    }
    case "bilibili":
      if (/^BV[A-Za-z0-9]+$/i.test(value)) return `BV${value.slice(2)}`;
      if (/^av\d+$/i.test(value)) return `av${value.replace(/^av/i, "")}`;
      return null;
  }
}

function normalizeMetrics(metrics: CanonicalEvidenceInput["metrics"]): {
  metrics: Readonly<Record<string, number | null>>;
  invalid: boolean;
} {
  const normalized: Record<string, number | null> = {};
  let invalid = false;

  for (const key of Object.keys(metrics ?? {}).sort()) {
    const value = metrics?.[key];
    if (value === null || value === undefined) {
      normalized[key] = null;
    } else if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      normalized[key] = value;
    } else {
      normalized[key] = null;
      invalid = true;
    }
  }

  return { metrics: Object.freeze(normalized), invalid };
}

function positiveVisibleMetrics(
  metrics: Readonly<Record<string, number | null>>,
  metricsVisible: boolean | undefined,
  visibleMetricKeys: readonly string[] | null | undefined
): Readonly<Record<string, number>> {
  if (metricsVisible === false) return Object.freeze({});
  const visibleKeys = visibleMetricKeys
    ? new Set(visibleMetricKeys.map((key) => key.trim()).filter(Boolean))
    : null;
  const positive: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (value !== null && value > 0 && (!visibleKeys || visibleKeys.has(key))) {
      positive[key] = value;
    }
  }
  return Object.freeze(positive);
}

function canonicalUrlForDedupe(
  input: CanonicalEvidenceDedupeInput,
  platformKey: string
): string | null {
  const value = input.canonicalUrl?.trim() || input.sourceUrl?.trim();
  if (!value) return null;
  if (normalizeEvidencePlatform(platformKey)) {
    return normalizeCanonicalEvidenceUrl(platformKey, value).canonicalUrl;
  }
  const parsed = parseHttpUrl(value);
  if (!parsed) return null;
  stripUrlNoise(parsed);
  return genericCanonicalUrl(parsed);
}

function nativeResult(
  platform: CanonicalEvidencePlatform,
  sourceUrl: string,
  canonicalUrl: string,
  nativeId: string,
  objectType: CanonicalEvidenceObjectType
): CanonicalUrlNormalization {
  return {
    platform,
    sourceUrl,
    canonicalUrl,
    nativeId,
    objectType,
    classification: "native_object",
    reason: null
  };
}

function nonObjectResult(
  platform: CanonicalEvidencePlatform,
  sourceUrl: string,
  canonicalUrl: string,
  classification: Exclude<CanonicalEvidenceUrlClassification, "native_object" | "invalid">
): CanonicalUrlNormalization {
  const reason = classification === "profile"
    ? "profile_page"
    : classification === "search"
      ? "search_page"
      : "not_native_object";
  return {
    platform,
    sourceUrl,
    canonicalUrl,
    nativeId: null,
    objectType: null,
    classification,
    reason
  };
}

function hostMismatch(
  platform: CanonicalEvidencePlatform,
  sourceUrl: string,
  url: URL
): CanonicalUrlNormalization {
  return {
    ...urlResult(platform, sourceUrl, genericCanonicalUrl(url), "context", "platform_host_mismatch"),
    canonicalUrl: genericCanonicalUrl(url)
  };
}

function urlResult(
  platform: CanonicalEvidencePlatform | null,
  sourceUrl: string,
  canonicalUrl: string | null,
  classification: CanonicalEvidenceUrlClassification,
  reason: CanonicalUrlNormalization["reason"]
): CanonicalUrlNormalization {
  return {
    platform,
    sourceUrl,
    canonicalUrl,
    nativeId: null,
    objectType: null,
    classification,
    reason
  };
}

function routeClassification(
  path: string,
  searchRoutes: readonly string[],
  profilePatterns: readonly RegExp[]
): "profile" | "search" | "context" {
  if (searchRoutes.some((route) => path === route || path.startsWith(`${route}/`))) return "search";
  if (profilePatterns.some((pattern) => pattern.test(path))) return "profile";
  return "context";
}

function parseHttpUrl(rawValue: string): URL | null {
  const value = rawValue.trim();
  if (!value) return null;
  const candidate = /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    if (url.port && !((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443"))) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function stripUrlNoise(url: URL): void {
  url.protocol = "https:";
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETER.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
}

function genericCanonicalUrl(url: URL): string {
  const host = normalizedHost(url.hostname);
  const path = normalizedPath(url.pathname);
  return canonicalWith(url, host, path);
}

function canonicalWith(url: URL, host: string, path: string): string {
  const canonical = new URL(url.toString());
  canonical.protocol = "https:";
  canonical.hostname = host;
  canonical.port = "";
  canonical.pathname = path;
  canonical.hash = "";
  canonical.searchParams.sort();
  return canonical.toString().replace(/\/$/, "");
}

function normalizedHost(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  if (/^(?:mobile|m)\.twitter\.com$/.test(host)) return "twitter.com";
  if (/^(?:mobile|m)\.x\.com$/.test(host)) return "x.com";
  if (/^(?:music|m)\.youtube\.com$/.test(host)) return "youtube.com";
  if (/^(?:old|new|np|m)\.reddit\.com$/.test(host)) return "reddit.com";
  if (/^m\.instagram\.com$/.test(host)) return "instagram.com";
  if (/^m\.linkedin\.com$/.test(host)) return "linkedin.com";
  if (/^m\.tiktok\.com$/.test(host)) return "tiktok.com";
  if (/^m\.bilibili\.com$/.test(host)) return "bilibili.com";
  return host;
}

function normalizedPath(pathname: string): string {
  const path = pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return path || "/";
}

function hostIn(host: string, ...hosts: string[]): boolean {
  return hosts.includes(host);
}

function validObjectId(value: string | null): string | null {
  return value && OBJECT_ID.test(value) ? value : null;
}

function validGitHubRepository(owner: string, repository: string): boolean {
  return Boolean(
    GITHUB_OWNER.test(owner) &&
      GITHUB_REPOSITORY.test(repository) &&
      repository !== "." &&
      repository !== ".." &&
      !GITHUB_RESERVED_OWNERS.has(owner.toLowerCase())
  );
}

function nullableTrim(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeFingerprintPart(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTimestampForFingerprint(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : normalizeFingerprintPart(trimmed);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
