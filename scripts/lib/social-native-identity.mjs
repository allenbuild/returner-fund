export function linkedinPostIdFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
    const path = decodeURIComponent(url.pathname).replace(/\/$/, "");
    return (
      path.match(/\/feed\/update\/urn:li:activity:(\d{10,})$/i)?.[1] ??
      path.match(/\/posts\/[^/]*?activity-(\d{10,})(?:-[^/]*)?$/i)?.[1] ??
      null
    );
  } catch {
    return null;
  }
}

export function linkedinNativeAuthorSlugFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
    const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    if (parts[0]?.toLowerCase() !== "posts" || !parts[1]) return null;
    return normalizeLinkedinSlug(parts[1].match(/^(.+?)_(?:.*?activity-\d+|activity-\d+)/i)?.[1]);
  } catch {
    return null;
  }
}

export function linkedinAccountSlugFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
    const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    return ["in", "company"].includes(parts[0]?.toLowerCase())
      ? normalizeLinkedinSlug(parts[1])
      : null;
  } catch {
    return null;
  }
}

export function linkedinPostMatchesAccount(postUrl, accountUrl) {
  if (!linkedinPostIdFromUrl(postUrl)) return false;
  const nativeAuthorSlug = linkedinNativeAuthorSlugFromUrl(postUrl);
  if (!nativeAuthorSlug) {
    // Activity URNs are opaque; the caller may trust them only when they were read
    // directly from the requested account's own activity page.
    return true;
  }
  return nativeAuthorSlug === linkedinAccountSlugFromUrl(accountUrl);
}

export function linkedinNativeAuthorSlugFromPayload(value) {
  const text = String(value ?? "");
  const heading = text.search(/#\s+.{1,160}?[’']s\s+Post\b/i);
  if (heading < 0) return null;
  const nativeHeader = text.slice(heading, heading + 1_500);
  for (const match of nativeHeader.matchAll(/\]\((https?:\/\/[^)\s]+linkedin\.com\/(?:in|company)\/[^)?#\s]+)/gi)) {
    const slug = linkedinAccountSlugFromUrl(match[1]);
    if (slug) return slug;
  }
  return null;
}

function normalizeLinkedinSlug(value) {
  return String(value ?? "").trim().replace(/^@/, "").replace(/\/$/, "").toLowerCase() || null;
}
