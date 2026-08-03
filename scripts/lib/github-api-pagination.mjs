export const DEFAULT_GITHUB_COLLECTION_PAGE_LIMIT = 10;
export const MAX_GITHUB_COLLECTION_PAGE_LIMIT = 20;

export function githubNextLink(linkHeader, currentUrl) {
  if (!linkHeader) return null;

  for (const entry of String(linkHeader).split(/,(?=\s*<)/)) {
    const urlMatch = entry.match(/^\s*<([^>]+)>/);
    const relationMatch = entry.match(/;\s*rel\s*=\s*(?:"([^"]+)"|([^;,\s]+))/i);
    if (!urlMatch || !relationMatch) continue;
    const relations = String(relationMatch[1] ?? relationMatch[2] ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (relations.includes("next")) {
      return new URL(urlMatch[1], currentUrl).href;
    }
  }

  return null;
}

export async function fetchGithubCollectionPages(
  initialUrl,
  {
    fetchPage,
    maxPages = DEFAULT_GITHUB_COLLECTION_PAGE_LIMIT,
    allowedOrigin = new URL(initialUrl).origin
  } = {}
) {
  if (typeof fetchPage !== "function") {
    throw new TypeError("fetchGithubCollectionPages requires a fetchPage function.");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_GITHUB_COLLECTION_PAGE_LIMIT) {
    throw new RangeError(
      `maxPages must be an integer between 1 and ${MAX_GITHUB_COLLECTION_PAGE_LIMIT}.`
    );
  }

  const items = [];
  const visited = new Set();
  let nextUrl = assertAllowedGithubPageUrl(initialUrl, allowedOrigin);
  let pagesFetched = 0;

  while (nextUrl && pagesFetched < maxPages) {
    if (visited.has(nextUrl)) {
      throw new Error(`GitHub pagination cycle detected at ${nextUrl}.`);
    }
    visited.add(nextUrl);

    const page = await fetchPage(nextUrl);
    if (!Array.isArray(page?.data)) {
      throw new TypeError(`GitHub collection response for ${nextUrl} was not an array.`);
    }
    items.push(...page.data);
    pagesFetched += 1;

    const linkHeader = page.headers?.get?.("link") ?? page.linkHeader ?? null;
    const linkedNextUrl = githubNextLink(linkHeader, nextUrl);
    nextUrl = linkedNextUrl
      ? assertAllowedGithubPageUrl(linkedNextUrl, allowedOrigin)
      : null;
  }

  return {
    items,
    pagesFetched,
    truncated: Boolean(nextUrl),
    nextUrl
  };
}

function assertAllowedGithubPageUrl(rawUrl, allowedOrigin) {
  const url = new URL(rawUrl);
  if (url.origin !== allowedOrigin) {
    throw new Error(
      `Refusing GitHub pagination link outside ${allowedOrigin}: ${url.origin}.`
    );
  }
  return url.href;
}
