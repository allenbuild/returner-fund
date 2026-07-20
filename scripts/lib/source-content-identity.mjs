import { createHash } from "node:crypto";

const MINIMUM_BODY_CHARACTERS = 80;
const MINIMUM_BODY_WORDS = 12;

/**
 * Builds exact, deterministic aliases for a physical piece of social content.
 *
 * Author aliases are deliberately conservative: names retain punctuation and
 * diacritics, handles are exact after case folding, and account URLs are reduced
 * only along platform-native account routes. The body is normalized for Unicode,
 * case, zero-width characters, and whitespace, but is never token-similarity or
 * fuzzy matched.
 */
export function sourceContentIdentity(input) {
  const platform = normalizePlatform(input?.platform);
  const body = normalizeBody(input?.body ?? input?.content ?? input?.text);
  const authorIdentities = normalizedAuthorIdentities(input, platform);

  if (!platform || !isSubstantiveBody(body) || authorIdentities.length === 0) return null;

  const bodySha256 = createHash("sha256").update(body).digest("hex");
  const publication = normalizePublicationTime(input?.publishedAt ?? input?.postedAt ?? input?.timestamp);
  const strongAuthorIdentities = authorIdentities.filter((identity) =>
    identity.startsWith("handle:") || identity.startsWith("account:")
  );
  const matchingAuthorIdentities = authorIdentities;
  return {
    platform,
    authorIdentities,
    matchingAuthorIdentities,
    authorIdentityStrength: strongAuthorIdentities.length > 0 ? "native_account" : "display_name_fallback",
    body,
    bodySha256,
    publishedAt: publication?.timestamp ?? null,
    publishedOn: publication?.day ?? null,
    publicationPrecision: publication?.precision ?? null,
    keys: matchingAuthorIdentities.map((authorIdentity) =>
      JSON.stringify([platform, authorIdentity, body])
    )
  };
}

/**
 * Strong native identities dominate only when both sides expose one. If a
 * legacy source has only a display name, an exact name remains a permissible
 * fallback; two distinct known accounts can never match by name alone.
 */
export function sourceAuthorsCompatible(left, right) {
  const strong = (identity) => (identity?.authorIdentities ?? []).filter((value) =>
    value.startsWith("handle:") || value.startsWith("account:")
  );
  const leftStrong = strong(left);
  const rightStrong = strong(right);
  if (leftStrong.length > 0 && rightStrong.length > 0) {
    return leftStrong.some((value) => rightStrong.includes(value));
  }
  const leftNames = (left?.authorIdentities ?? []).filter((value) => value.startsWith("name:"));
  const rightNames = (right?.authorIdentities ?? []).filter((value) => value.startsWith("name:"));
  return leftNames.some((value) => rightNames.includes(value));
}

/**
 * Missing publication dates cannot disprove an otherwise exact content match.
 * When both sources expose precise timestamps, require the same instant. A
 * date-only source is intentionally compared at its declared UTC-day precision.
 * This keeps a later verbatim repost by the same author distinct.
 */
export function publicationTimesCompatible(left, right) {
  if (!left?.publishedAt || !right?.publishedAt) return true;
  if (left.publicationPrecision === "instant" && right.publicationPrecision === "instant") {
    return left.publishedAt === right.publishedAt;
  }
  return left.publishedOn === right.publishedOn;
}

function normalizedAuthorIdentities(input, platform) {
  const identities = new Set();
  const explicitNames = [
    input?.authorName,
    input?.voiceName,
    input?.author?.name
  ].map(normalizeIdentityText).filter(Boolean);
  const fallbackName = normalizeIdentityText(input?.fallbackAuthorName);

  for (const name of explicitNames.length > 0 ? explicitNames : [fallbackName].filter(Boolean)) {
    identities.add(`name:${name}`);
  }

  for (const rawHandle of [input?.authorHandle, input?.author?.handle, input?.author?.username]) {
    const handle = normalizeHandle(rawHandle);
    if (handle) identities.add(`handle:${handle}`);
  }

  for (const rawUrl of [input?.authorUrl, input?.author?.url, input?.accountUrl, input?.sourceUrl]) {
    const account = normalizeAccountIdentity(platform, rawUrl);
    if (account) identities.add(`account:${account}`);
  }

  return [...identities].sort();
}

function normalizeBody(value) {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  return normalized || null;
}

function isSubstantiveBody(value) {
  if (!value || value.length < MINIMUM_BODY_CHARACTERS) return false;
  return value.split(/\s+/u).filter(Boolean).length >= MINIMUM_BODY_WORDS;
}

function normalizeIdentityText(value) {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  return normalized || null;
}

function normalizeHandle(value) {
  return normalizeIdentityText(value)?.replace(/^@/, "") || null;
}

function normalizePlatform(value) {
  const normalized = normalizeIdentityText(value)?.replace(/[ -]+/g, "_");
  const aliases = { twitter: "x", producthunt: "product_hunt", hn: "hacker_news", hackernews: "hacker_news" };
  return aliases[normalized] ?? normalized ?? null;
}

function normalizeAccountIdentity(platform, rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;
  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);

    if (platform === "linkedin" && (host === "linkedin.com" || host.endsWith(".linkedin.com"))) {
      if (["in", "company"].includes(parts[0]?.toLowerCase()) && parts[1]) {
        return `linkedin.com/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
      }
      const postAuthor = parts[0]?.toLowerCase() === "posts"
        ? parts[1]?.match(/^(.+?)_(?:.*?activity-\d+|activity-\d+)/i)?.[1]
        : null;
      return postAuthor ? `linkedin.com/posts/${postAuthor.toLowerCase()}` : null;
    }

    if (platform === "x" && ["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) {
      const handle = normalizeHandle(parts[0]);
      return handle && handle !== "i" ? `x.com/${handle}` : null;
    }

    if (platform === "instagram" && (host === "instagram.com" || host.endsWith(".instagram.com"))) {
      if (!parts[0] || ["p", "reel", "reels", "tv", "explore"].includes(parts[0].toLowerCase())) return null;
      return `instagram.com/${parts[0].toLowerCase()}`;
    }

    if (platform === "youtube" && ["youtube.com", "m.youtube.com"].includes(host)) {
      if (/^@/.test(parts[0] ?? "")) return `youtube.com/${parts[0].toLowerCase()}`;
      if (["channel", "c", "user"].includes(parts[0]?.toLowerCase()) && parts[1]) {
        return `youtube.com/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function normalizePublicationTime(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return null;
  const normalized = new Date(timestamp).toISOString();
  return {
    timestamp: normalized,
    day: normalized.slice(0, 10),
    precision: /^\d{4}-\d{2}-\d{2}$/.test(raw) ? "day" : "instant"
  };
}
