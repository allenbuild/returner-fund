import { canonicalGithubTargetUrl } from "./github-url.mjs";

const LINKEDIN_NAMESPACES = new Set(["company", "in", "school", "showcase"]);
const LINKEDIN_RESERVED_IDENTITIES = new Set(["about", "admin", "posts"]);
const X_RESERVED_IDENTITIES = new Set(["explore", "home", "i", "intent", "search", "share"]);
const INSTAGRAM_RESERVED_IDENTITIES = new Set(["accounts", "explore", "p", "reel", "stories", "tv"]);

export function normalizeSocialAccountPlatform(rawPlatform) {
  const platform = String(rawPlatform ?? "").trim().toLowerCase();
  if (platform === "twitter") return "x";
  if (platform === "producthunt") return "product_hunt";
  if (platform === "hn" || platform === "hackernews") return "hacker_news";
  return platform;
}

export function canonicalSocialAccountUrl(rawPlatform, rawUrl) {
  const platform = normalizeSocialAccountPlatform(rawPlatform);
  if (!platform || typeof rawUrl !== "string" || !rawUrl.trim()) return null;

  try {
    const url = new URL(rawUrl.trim().replace(/^http:\/\//i, "https://"));
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (platform === "github") {
      if (host !== "github.com") return null;
      const canonicalUrl = canonicalGithubTargetUrl(rawUrl);
      return canonicalUrl ? canonicalUrl.toLowerCase() : null;
    }

    if (platform === "x") {
      if (!["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) return null;
      const identity = parts[0]?.replace(/^@/, "").toLowerCase();
      if (!identity || X_RESERVED_IDENTITIES.has(identity)) return null;
      return `https://x.com/${identity}`;
    }

    if (platform === "linkedin") {
      if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
      const namespaceIndex = parts.findIndex((part) => LINKEDIN_NAMESPACES.has(part.toLowerCase()));
      const namespace = namespaceIndex >= 0 ? parts[namespaceIndex]?.toLowerCase() : null;
      const identity = namespaceIndex >= 0 ? parts[namespaceIndex + 1]?.toLowerCase() : null;
      if (!namespace || !identity || LINKEDIN_RESERVED_IDENTITIES.has(identity)) return null;
      return `https://linkedin.com/${namespace}/${identity}`;
    }

    if (platform === "instagram") {
      if (host !== "instagram.com" && !host.endsWith(".instagram.com")) return null;
      const identity = parts[0]?.replace(/^@/, "").toLowerCase();
      if (!identity || INSTAGRAM_RESERVED_IDENTITIES.has(identity)) return null;
      return `https://instagram.com/${identity}`;
    }

    if (platform === "youtube") {
      if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return null;
      const namespace = parts[0]?.toLowerCase();
      if (!namespace) return null;
      if (namespace.startsWith("@")) return `https://youtube.com/${namespace}`;
      if (["channel", "c", "user"].includes(namespace) && parts[1]) {
        return `https://youtube.com/${namespace}/${parts[1].toLowerCase()}`;
      }
      return null;
    }

    if (platform === "product_hunt") {
      if (host !== "producthunt.com" && !host.endsWith(".producthunt.com")) return null;
      if (!parts.length) return null;
      return `https://producthunt.com/${parts.map((part) => part.toLowerCase()).join("/")}`;
    }

    url.hash = "";
    url.search = "";
    url.protocol = "https:";
    url.hostname = host;
    url.pathname = `/${parts.join("/")}`.replace(/\/$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
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
