import { isIP } from "node:net";
import { canonicalGithubTargetUrl } from "./github-url.mjs";

const LINKEDIN_NAMESPACES = new Set(["company", "in", "school", "showcase"]);
const LINKEDIN_RESERVED_IDENTITIES = new Set(["about", "admin", "posts"]);
const X_RESERVED_IDENTITIES = new Set(["explore", "home", "i", "intent", "search", "share"]);
const INSTAGRAM_RESERVED_IDENTITIES = new Set(["accounts", "explore", "p", "reel", "stories", "tv"]);
const ASCII_ACCOUNT_IDENTITY = /^[a-z0-9._-]+$/i;
const INTERNATIONAL_ACCOUNT_IDENTITY = /^[\p{L}\p{M}\p{N}._-]+$/u;
const X_ACCOUNT_IDENTITY = /^[a-z0-9_]{1,15}$/i;
const INSTAGRAM_ACCOUNT_IDENTITY = /^[a-z0-9._]{1,30}$/i;
const REDDIT_ACCOUNT_IDENTITY = /^[a-z0-9_-]+$/i;
const HACKER_NEWS_ACCOUNT_IDENTITY = /^[a-z0-9_-]{1,15}$/i;
const ENCODED_ACCOUNT_PATH_DELIMITER = /%(?:00|23|2f|3f|5c)/i;
const ENCODED_DOT_PATH_SEGMENT = /(?:^|\/)(?:(?:\.|%2e){1,2})(?:\/|$)/i;
const SPECIAL_USE_IPV4_RANGES = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
].map(([network, prefix]) => [ipv4ToInteger(network), prefix]);
const SPECIAL_USE_IPV6_RANGES = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8]
].map(([network, prefix]) => [ipv6ToBigInt(network), prefix]);
const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src"
]);

export function normalizeSocialAccountPlatform(rawPlatform) {
  const platform = String(rawPlatform ?? "").trim().toLowerCase();
  if (platform === "twitter") return "x";
  if (platform === "website") return "web";
  if (platform === "producthunt") return "product_hunt";
  if (platform === "hn" || platform === "hackernews") return "hacker_news";
  return platform;
}

export function canonicalSocialAccountUrl(rawPlatform, rawUrl) {
  const platform = normalizeSocialAccountPlatform(rawPlatform);
  if (!platform || typeof rawUrl !== "string" || !rawUrl.trim()) return null;

  try {
    const input = rawUrl.trim();
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    if ((url.protocol === "https:" && url.port && url.port !== "443") ||
        (url.protocol === "http:" && url.port && url.port !== "80")) return null;
    if (!isPublicHostname(host)) return null;

    if (platform === "github") {
      if (host !== "github.com") return null;
      const canonicalUrl = canonicalGithubTargetUrl(rawUrl);
      return canonicalUrl ? canonicalUrl.toLowerCase() : null;
    }

    if (["rss", "web"].includes(platform)) {
      return canonicalPublicContentUrl(url, host);
    }

    if (hasUnsafeAccountPathSyntax(input)) return null;
    const parts = decodeAccountPath(url.pathname);
    if (!parts) return null;

    if (platform === "x") {
      if (!["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) return null;
      const identity = normalizeIdentity(parts[0], {
        pattern: X_ACCOUNT_IDENTITY,
        stripLeadingAt: true
      });
      if (!identity || X_RESERVED_IDENTITIES.has(identity)) return null;
      return `https://x.com/${encodeIdentity(identity)}`;
    }

    if (platform === "linkedin") {
      if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
      const namespace = parts[0]?.toLowerCase();
      const identity = normalizeIdentity(parts[1], {
        pattern: INTERNATIONAL_ACCOUNT_IDENTITY,
        maxLength: 200,
        requireAlphaNumeric: true
      });
      if (!LINKEDIN_NAMESPACES.has(namespace)) return null;
      if (!namespace || !identity || LINKEDIN_RESERVED_IDENTITIES.has(identity)) return null;
      return `https://linkedin.com/${namespace}/${encodeIdentity(identity)}`;
    }

    if (platform === "instagram") {
      if (host !== "instagram.com" && !host.endsWith(".instagram.com")) return null;
      const identity = normalizeIdentity(parts[0], {
        pattern: INSTAGRAM_ACCOUNT_IDENTITY,
        stripLeadingAt: true
      });
      if (!identity || INSTAGRAM_RESERVED_IDENTITIES.has(identity)) return null;
      if (identity.startsWith(".") || identity.endsWith(".") || identity.includes("..")) return null;
      return `https://instagram.com/${encodeIdentity(identity)}`;
    }

    if (platform === "youtube") {
      if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return null;
      const namespace = parts[0];
      if (!namespace) return null;
      if (namespace.startsWith("@")) {
        const identity = normalizeIdentity(namespace.slice(1), {
          pattern: INTERNATIONAL_ACCOUNT_IDENTITY,
          maxLength: 100,
          requireAlphaNumeric: true
        });
        return identity ? `https://youtube.com/@${encodeIdentity(identity)}` : null;
      }
      const normalizedNamespace = namespace.toLowerCase();
      if (["channel", "c", "user"].includes(normalizedNamespace) && parts[1]) {
        const identity = normalizeIdentity(parts[1], {
          pattern: INTERNATIONAL_ACCOUNT_IDENTITY,
          maxLength: 200,
          requireAlphaNumeric: true
        });
        return identity
          ? `https://youtube.com/${normalizedNamespace}/${encodeIdentity(identity)}`
          : null;
      }
      return null;
    }

    if (platform === "product_hunt") {
      if (host !== "producthunt.com" && !host.endsWith(".producthunt.com")) return null;
      if (parts.length === 1 && parts[0].startsWith("@")) {
        const identity = normalizeIdentity(parts[0].slice(1), {
          pattern: ASCII_ACCOUNT_IDENTITY,
          maxLength: 100,
          requireAlphaNumeric: true
        });
        return identity ? `https://producthunt.com/@${encodeIdentity(identity)}` : null;
      }
      const namespace = parts[0]?.toLowerCase();
      if (parts.length !== 2 || !["products", "users"].includes(namespace)) return null;
      const identity = normalizeIdentity(parts[1], {
        pattern: ASCII_ACCOUNT_IDENTITY,
        maxLength: 200,
        requireAlphaNumeric: true
      });
      return identity
        ? `https://producthunt.com/${namespace}/${encodeIdentity(identity)}`
        : null;
    }

    if (platform === "reddit") {
      if (host !== "reddit.com" && !host.endsWith(".reddit.com")) return null;
      if (parts.length !== 2) return null;
      const namespace = parts[0]?.toLowerCase();
      const identity = normalizeIdentity(parts[1], {
        pattern: REDDIT_ACCOUNT_IDENTITY,
        maxLength: 32,
        stripLeadingAt: true,
        requireAlphaNumeric: true
      });
      if (!["user", "u", "r"].includes(namespace) || !identity) return null;
      return `https://reddit.com/${namespace === "u" ? "user" : namespace}/${encodeIdentity(identity)}`;
    }

    if (platform === "hacker_news") {
      if (host !== "news.ycombinator.com" || parts.length !== 1 || parts[0] !== "user") return null;
      const identities = url.searchParams.getAll("id");
      if (identities.length !== 1) return null;
      const identity = normalizeIdentity(identities[0], {
        lowercase: false,
        pattern: HACKER_NEWS_ACCOUNT_IDENTITY
      });
      return identity
        ? `https://news.ycombinator.com/user?id=${encodeIdentity(identity)}`
        : null;
    }

    return null;
  } catch {
    return null;
  }
}

function canonicalPublicContentUrl(url, host) {
  url.hash = "";
  url.protocol = "https:";
  url.hostname = host;
  for (const key of [...new Set(url.searchParams.keys())]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  const canonicalUrl = url.toString();
  return url.pathname === "/" && !url.search ? canonicalUrl.replace(/\/$/, "") : canonicalUrl;
}

function hasUnsafeAccountPathSyntax(rawUrl) {
  if (/[\\\u0000-\u001f\u007f]/u.test(rawUrl)) return true;
  const rawPath = rawPathComponent(rawUrl);
  return ENCODED_ACCOUNT_PATH_DELIMITER.test(rawPath) || ENCODED_DOT_PATH_SEGMENT.test(rawPath);
}

function rawPathComponent(rawUrl) {
  const schemeEnd = rawUrl.indexOf("://");
  if (schemeEnd < 0) return "";
  const authorityStart = schemeEnd + 3;
  const pathStart = rawUrl.indexOf("/", authorityStart);
  if (pathStart < 0) return "";
  const queryStart = rawUrl.indexOf("?", pathStart);
  const hashStart = rawUrl.indexOf("#", pathStart);
  const ends = [queryStart, hashStart].filter((index) => index >= 0);
  return rawUrl.slice(pathStart, ends.length ? Math.min(...ends) : undefined);
}

function decodeAccountPath(pathname) {
  const rawParts = pathname.split("/");
  if (rawParts.shift() !== "") return null;
  if (rawParts.at(-1) === "") rawParts.pop();
  if (rawParts.some((part) => !part)) return null;
  const parts = [];
  for (const rawPart of rawParts) {
    let part;
    try {
      part = decodeURIComponent(rawPart).normalize("NFC");
    } catch {
      return null;
    }
    if (!part || /[\/\\?#\u0000-\u001f\u007f]/u.test(part)) return null;
    parts.push(part);
  }
  return parts;
}

function normalizeIdentity(rawIdentity, {
  lowercase = true,
  maxLength = Infinity,
  pattern,
  requireAlphaNumeric = false,
  stripLeadingAt = false
} = {}) {
  if (typeof rawIdentity !== "string") return null;
  const withoutPrefix = stripLeadingAt ? rawIdentity.replace(/^@/, "") : rawIdentity;
  const normalized = withoutPrefix.normalize("NFC");
  const identity = lowercase ? normalized.toLowerCase() : normalized;
  if (!identity || [...identity].length > maxLength || !pattern?.test(identity)) return null;
  if (requireAlphaNumeric && !/[\p{L}\p{N}]/u.test(identity)) return null;
  return identity;
}

function encodeIdentity(identity) {
  return encodeURIComponent(identity);
}

function isPublicHostname(hostname) {
  const host = String(hostname ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return false;
  }
  const ipLiteral = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const version = isIP(ipLiteral);
  if (version === 4) {
    const address = ipv4ToInteger(ipLiteral);
    return !SPECIAL_USE_IPV4_RANGES.some(([network, prefix]) =>
      isIpv4InRange(address, network, prefix)
    );
  }
  if (version === 6) {
    const address = ipv6ToBigInt(ipLiteral);
    return address !== null && !SPECIAL_USE_IPV6_RANGES.some(([network, prefix]) =>
      isIpv6InRange(address, network, prefix)
    );
  }
  return host.includes(".");
}

function ipv4ToInteger(address) {
  return String(address).split(".").reduce((value, octet) => (value * 256) + Number(octet), 0);
}

function isIpv4InRange(address, network, prefix) {
  const blockSize = 2 ** (32 - prefix);
  return Math.floor(address / blockSize) === Math.floor(network / blockSize);
}

function ipv6ToBigInt(address) {
  const rawAddress = String(address).toLowerCase();
  const separator = rawAddress.indexOf("::");
  if (separator !== rawAddress.lastIndexOf("::")) return null;

  const expandSide = (side) => {
    if (!side) return [];
    const chunks = side.split(":");
    const last = chunks.at(-1);
    if (last?.includes(".")) {
      if (isIP(last) !== 4) return null;
      const value = ipv4ToInteger(last);
      chunks.splice(-1, 1, (value >>> 16).toString(16), (value & 0xffff).toString(16));
    }
    if (chunks.some((chunk) => !/^[0-9a-f]{1,4}$/.test(chunk))) return null;
    return chunks.map((chunk) => Number.parseInt(chunk, 16));
  };

  const left = expandSide(separator >= 0 ? rawAddress.slice(0, separator) : rawAddress);
  const right = expandSide(separator >= 0 ? rawAddress.slice(separator + 2) : "");
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((separator >= 0 && missing < 1) || (separator < 0 && missing !== 0)) return null;
  const chunks = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (chunks.length !== 8) return null;
  return chunks.reduce((value, chunk) => (value << 16n) | BigInt(chunk), 0n);
}

function isIpv6InRange(address, network, prefix) {
  const shift = 128n - BigInt(prefix);
  return (address >> shift) === (network >> shift);
}

export function socialAccountIdentityKey(rawPlatform, rawUrl) {
  const platform = normalizeSocialAccountPlatform(rawPlatform);
  const canonicalUrl = canonicalSocialAccountUrl(platform, rawUrl);
  return canonicalUrl ? `${platform}:${canonicalUrl.toLowerCase()}` : null;
}

export function retiredSocialAccountKey(rawPlatform, rawUrl) {
  const platform = normalizeSocialAccountPlatform(rawPlatform);
  return socialAccountIdentityKey(platform, rawUrl)
    ?? `${platform}:invalid:${String(rawUrl ?? "").trim().toLowerCase()}`;
}
