const X_RECENT_SEARCH_ENDPOINT = "https://api.x.com/2/tweets/search/recent";
const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";

export function xUsernameFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (!["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) return null;
    const username = url.pathname.split("/").filter(Boolean)[0] ?? "";
    if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) return null;
    return username.toLowerCase();
  } catch {
    return null;
  }
}

export function extractEmbeddedYouTubeIds(value) {
  const text = decodeEmbeddedMarkup(value);
  const ids = [];
  const patterns = [
    /(?:youtube(?:-nocookie)?\.com)\/embed\/([A-Za-z0-9_-]{6,})/gi,
    /(?:youtube(?:-nocookie)?\.com)\/shorts\/([A-Za-z0-9_-]{6,})/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) ids.push(match[1]);
  }
  return [...new Set(ids)];
}

export function extractProductHuntLinks(value) {
  const text = decodeEmbeddedMarkup(value);
  return [
    ...new Set(
      [...text.matchAll(/https?:\/\/(?:www\.)?producthunt\.com\/(?:products|posts)\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+/gi)]
        .map((match) => canonicalProductHuntUrl(match[0]))
        .filter(Boolean)
    )
  ];
}

export async function fetchRecentXPostsForTargets({
  targets,
  bearerToken,
  fetchImpl = fetch,
  now = new Date(),
  lookbackHours = 26,
  handlesPerRequest = 8,
  concurrency = 2
}) {
  const handles = [...new Set(
    (targets ?? [])
      .map((target) => xUsernameFromUrl(target?.accountUrl))
      .filter(Boolean)
  )].sort();
  if (!bearerToken || handles.length === 0) {
    return {
      configured: Boolean(bearerToken),
      handlesRequested: handles.length,
      requestCount: 0,
      successfulRequestCount: 0,
      postsByHandle: new Map(),
      errors: []
    };
  }

  const groups = chunks(handles, Math.max(1, handlesPerRequest));
  const postsByHandle = new Map(handles.map((handle) => [handle, []]));
  const errors = [];
  let successfulRequestCount = 0;
  const startTime = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000).toISOString();

  await mapWithConcurrency(groups, concurrency, async (group) => {
    const query = `(${group.map((handle) => `from:${handle}`).join(" OR ")}) -is:retweet`;
    const params = new URLSearchParams({
      query,
      start_time: startTime,
      max_results: "100",
      "tweet.fields": "author_id,created_at,public_metrics,referenced_tweets",
      expansions: "author_id",
      "user.fields": "name,username"
    });
    try {
      const response = await fetchImpl(`${X_RECENT_SEARCH_ENDPOINT}?${params}`, {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Accept: "application/json"
        }
      });
      const payload = await safeJson(response);
      if (!response.ok) {
        errors.push({
          handles: group,
          status: response.status,
          reason: apiError(payload, `X recent search returned HTTP ${response.status}.`)
        });
        return;
      }
      successfulRequestCount += 1;
      const usersById = new Map((payload?.includes?.users ?? []).map((user) => [String(user.id), user]));
      for (const post of payload?.data ?? []) {
        const user = usersById.get(String(post.author_id));
        const handle = String(user?.username ?? "").toLowerCase();
        if (!postsByHandle.has(handle)) continue;
        postsByHandle.get(handle).push({ ...post, author: user });
      }
      if (payload?.meta?.next_token) {
        errors.push({
          handles: group,
          status: 206,
          reason: "X recent search returned more than 100 posts for this owner group; the next run must use a smaller group."
        });
      }
    } catch (error) {
      errors.push({ handles: group, status: null, reason: errorMessage(error) });
    }
  });

  return {
    configured: true,
    handlesRequested: handles.length,
    requestCount: groups.length,
    successfulRequestCount,
    postsByHandle,
    errors
  };
}

export async function searchExaSourceCandidates({
  query,
  platform,
  apiKey,
  fetchImpl = fetch,
  numResults = 8
}) {
  if (!apiKey || !query) return [];
  const includeDomains = exaDomainsForPlatform(platform);
  if (!includeDomains.length) return [];
  const response = await fetchImpl(EXA_SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      query,
      includeDomains,
      numResults: Math.max(1, Math.min(20, numResults)),
      type: "fast",
      contents: { highlights: true }
    })
  });
  const payload = await safeJson(response);
  if (!response.ok) {
    throw new Error(apiError(payload, `Exa search returned HTTP ${response.status}.`));
  }
  return (payload?.results ?? []).map((result) => ({
    query,
    searchUrl: EXA_SEARCH_ENDPOINT,
    title: cleanText(result?.title ?? ""),
    snippet: cleanText([
      result?.author,
      result?.text,
      ...(Array.isArray(result?.highlights) ? result.highlights : [])
    ].filter(Boolean).join(" ")),
    url: result?.url ?? "",
    publishedDate: result?.publishedDate ?? null,
    discoveryProvider: "exa"
  }));
}

function exaDomainsForPlatform(platform) {
  if (platform === "linkedin") return ["linkedin.com/posts", "linkedin.com/feed/update"];
  if (platform === "x") return ["x.com", "twitter.com"];
  if (platform === "product_hunt") return ["producthunt.com/products", "producthunt.com/posts"];
  if (platform === "youtube") return ["youtube.com/watch", "youtube.com/shorts"];
  return [];
}

function canonicalProductHuntUrl(rawUrl) {
  try {
    const url = new URL(rawUrl.replace(/[),.;]+$/, ""));
    url.protocol = "https:";
    url.hostname = "www.producthunt.com";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function decodeEmbeddedMarkup(value) {
  return String(value ?? "")
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"');
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function apiError(payload, fallback) {
  return cleanText(
    payload?.detail ??
    payload?.title ??
    payload?.error ??
    payload?.errors?.[0]?.message ??
    fallback
  );
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
