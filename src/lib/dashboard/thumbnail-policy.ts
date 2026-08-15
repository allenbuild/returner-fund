/**
 * The public dashboard consumes a compact artifact. Treat image URLs in that
 * artifact as untrusted presentation data: rendering every arbitrary URL
 * would turn a story payload into an unrestricted third-party image loader.
 *
 * This list deliberately covers only the bounded, first-party media/CDN
 * surfaces produced by the dashboard's supported discovery adapters. New
 * sources should be cached locally or explicitly reviewed here and in
 * `next.config.mjs`; otherwise the UI shows its platform fallback.
 */
const EXACT_DASHBOARD_THUMBNAIL_HOSTS = new Set([
  "avatars.githubusercontent.com",
  "opengraph.githubassets.com",
  "github.githubassets.com",
  "pbs.twimg.com",
  "media.licdn.com",
  "static.licdn.com",
  "static.cdninstagram.com",
  "i.ytimg.com",
  "yt3.ggpht.com",
  "ph-files.imgix.net",
  "ph-avatars.imgix.net",
  "i.redd.it",
  "preview.redd.it",
  "external-preview.redd.it",
  "cdn.bsky.app",
  "www.technologyreview.com",
  "wp.technologyreview.com",
  "cdn.arstechnica.net"
]);

const DASHBOARD_THUMBNAIL_HOST_SUFFIXES = [
  "cdninstagram.com",
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "hdslb.com"
] as const;

const MAX_DASHBOARD_THUMBNAIL_URL_LENGTH = 2_048;

/**
 * Returns a canonical image URL only when it matches the intentionally small
 * dashboard thumbnail policy. It is safe to pass the returned value to
 * `next/image`; unrecognized URLs must use a non-network fallback instead.
 */
export function safeDashboardThumbnailUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!input || input.length > MAX_DASHBOARD_THUMBNAIL_URL_LENGTH) return null;

  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      !isAllowedDashboardThumbnailHost(url.hostname)
    ) {
      return null;
    }

    // Fragments are never sent to the origin. Dropping them produces a stable
    // optimizer cache key without changing the requested image resource.
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isAllowedDashboardThumbnailHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (EXACT_DASHBOARD_THUMBNAIL_HOSTS.has(normalized)) return true;
  return DASHBOARD_THUMBNAIL_HOST_SUFFIXES.some((suffix) => normalized.endsWith(`.${suffix}`));
}
