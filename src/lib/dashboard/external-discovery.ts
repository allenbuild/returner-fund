import { load } from "cheerio";
import { isIP } from "node:net";
import type { DashboardCandidate } from "./contracts";
import { canonicalDashboardUrl, compactSentence, compactWhitespace, safeDate, stableHash } from "./normalization";
import { isDashboardCandidateEligible } from "./pipeline";

const MAX_RESPONSE_BYTES = 1_500_000;
const MAX_HN_ITEMS = 200;
const MAX_GITHUB_ITEMS = 40;
const MAX_GITHUB_EVENT_ITEMS = 100;
const MAX_RSS_ITEMS_PER_FEED = 40;
const MAX_REDDIT_ITEMS_PER_SUBREDDIT = 40;

// Environment configuration may select a feed path only on these public
// publication hosts. Keeping this list literal (rather than accepting an
// arbitrary public hostname) prevents the worker from becoming a general
// outbound-fetch proxy through DASHBOARD_RSS_FEEDS.
const CONFIGURED_RSS_HOST_ALLOWLIST = new Set([
  "www.technologyreview.com",
  "feeds.arstechnica.com"
]);

/** Public, read-only sources; no browser automation, cookies, or account actions. */
export const DEFAULT_DASHBOARD_RSS_FEEDS = [
  { name: "MIT Technology Review", url: "https://www.technologyreview.com/feed/", quality: 78 },
  { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", quality: 72 }
] as const;

/** Papers are candidates only when another observed signal corroborates them. */
export const DEFAULT_DASHBOARD_RESEARCH_FEEDS = [
  { name: "arXiv cs.AI", url: "https://rss.arxiv.org/rss/cs.AI", quality: 78, platform: "research", sourceKind: "paper", independentlyReported: false },
  { name: "arXiv cs.RO", url: "https://rss.arxiv.org/rss/cs.RO", quality: 78, platform: "research", sourceKind: "paper", independentlyReported: false }
] as const satisfies readonly DashboardRssFeed[];

/** Fixed public communities avoid an unbounded Reddit search surface. */
export const DEFAULT_DASHBOARD_REDDIT_SUBREDDITS = ["MachineLearning", "technology", "programming", "startups"] as const;

interface DashboardRssFeed {
  name: string;
  url: string;
  quality?: number;
  platform?: "rss" | "research";
  sourceKind?: "article" | "paper";
  independentlyReported?: boolean;
}

export interface ExternalDiscoveryResult {
  candidates: DashboardCandidate[];
  failures: string[];
  sources: string[];
}

export interface ExternalDiscoveryOptions {
  now?: Date;
  fetchImpl?: typeof fetch;
  githubToken?: string | null;
  rssFeeds?: ReadonlyArray<DashboardRssFeed>;
  researchFeeds?: ReadonlyArray<DashboardRssFeed>;
  redditSubreddits?: readonly string[];
}

/**
 * Bounded, public-only Industry discovery. Authenticated/X/LinkedIn/Instagram
 * lanes are deliberately absent: their existing safety gates remain entirely
 * owned by the established ingestion system.
 */
export async function discoverExternalDashboardCandidates(
  options: ExternalDiscoveryOptions = {}
): Promise<ExternalDiscoveryResult> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const feeds = options.rssFeeds ?? configuredRssFeeds();
  const researchFeeds = options.researchFeeds ?? DEFAULT_DASHBOARD_RESEARCH_FEEDS;
  const subreddits = normalizeSubreddits(options.redditSubreddits ?? DEFAULT_DASHBOARD_REDDIT_SUBREDDITS);
  const githubToken = options.githubToken ?? null;
  const jobs: Array<Promise<{ source: string; candidates: DashboardCandidate[] }>> = [
    fetchHackerNewsCandidates(fetchImpl, now),
    fetchGithubCandidates(fetchImpl, now, githubToken),
    fetchGithubReleaseCandidates(fetchImpl, now, githubToken),
    ...feeds.map((feed) => fetchRssCandidates(fetchImpl, feed, now)),
    ...researchFeeds.map((feed) => fetchRssCandidates(fetchImpl, feed, now)),
    ...subreddits.map((subreddit) => fetchRedditCandidates(fetchImpl, subreddit, now))
  ];
  const settled = await Promise.allSettled(jobs);
  const candidates: DashboardCandidate[] = [];
  const failures: string[] = [];
  const sources: string[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      candidates.push(...result.value.candidates);
      sources.push(result.value.source);
    } else {
      // Safe observability label only; do not retain headers, tokens, or raw
      // provider bodies in a public dashboard artifact.
      failures.push(discoveryFailureLabel(result.reason));
    }
  }
  return { candidates, failures: [...new Set(failures)].sort(), sources: [...new Set(sources)].sort() };
}

export async function fetchHackerNewsCandidates(fetchImpl: typeof fetch, now = new Date()): Promise<{ source: string; candidates: DashboardCandidate[] }> {
  const after = Math.floor((now.getTime() - 24 * 60 * 60 * 1_000) / 1_000);
  const url = new URL("https://hn.algolia.com/api/v1/search_by_date");
  url.searchParams.set("tags", "story");
  url.searchParams.set("numericFilters", `created_at_i>${after}`);
  url.searchParams.set("hitsPerPage", String(MAX_HN_ITEMS));
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "ReturnerDashboard/1.0 public-read-only" },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`hacker_news_http_${response.status}`);
  const payload = await readBoundedJson<AlgoliaResponse>(response, "hacker_news");
  const candidates = (payload.hits ?? [])
    .flatMap((hit) => hackerNewsCandidate(hit, now))
    .filter((candidate) => isDashboardCandidateEligible(candidate, now));
  return { source: "hacker_news", candidates };
}

export async function fetchGithubCandidates(
  fetchImpl: typeof fetch,
  now = new Date(),
  githubToken: string | null = null
): Promise<{ source: string; candidates: DashboardCandidate[] }> {
  const after = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", `created:>=${after}`);
  url.searchParams.set("sort", "stars");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(MAX_GITHUB_ITEMS));
  const response = await fetchImpl(url, {
    headers: githubPublicHeaders(githubToken),
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`github_http_${response.status}`);
  const payload = await readBoundedJson<GithubSearchResponse>(response, "github");
  const candidates = (payload.items ?? [])
    .flatMap((repository) => githubCandidate(repository, now))
    .filter((candidate) => isDashboardCandidateEligible(candidate, now));
  return { source: "github", candidates };
}

/**
 * The public Events endpoint is deliberately a separate bounded job from
 * repository search. A rate limit or transient error on either source cannot
 * suppress the other GitHub discovery lane.
 */
export async function fetchGithubReleaseCandidates(
  fetchImpl: typeof fetch,
  now = new Date(),
  githubToken: string | null = null
): Promise<{ source: string; candidates: DashboardCandidate[] }> {
  const url = new URL("https://api.github.com/events");
  url.searchParams.set("per_page", String(MAX_GITHUB_EVENT_ITEMS));
  const response = await fetchImpl(url, {
    headers: githubPublicHeaders(githubToken),
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`github_events_http_${response.status}`);
  const payload = await readBoundedJson<unknown>(response, "github_events");
  const events = Array.isArray(payload) ? payload.slice(0, MAX_GITHUB_EVENT_ITEMS) as GithubEvent[] : [];
  const candidates = events
    .flatMap((event) => githubReleaseCandidate(event, now))
    .filter((candidate) => isDashboardCandidateEligible(candidate, now));
  return { source: "github_events", candidates };
}

export async function fetchRssCandidates(
  fetchImpl: typeof fetch,
  feed: DashboardRssFeed,
  now = new Date()
): Promise<{ source: string; candidates: DashboardCandidate[] }> {
  const response = await fetchImpl(feed.url, {
    headers: {
      Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, text/html;q=0.5",
      "User-Agent": "ReturnerDashboard/1.0 public-read-only"
    },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`rss_${sourceSlug(feed.name)}_http_${response.status}`);
  const xml = await readBoundedText(response, `rss_${sourceSlug(feed.name)}`);
  const $ = load(xml, { xmlMode: true });
  const entries = $("item, entry").toArray().slice(0, MAX_RSS_ITEMS_PER_FEED);
  const candidates = entries
    .flatMap((entry, index) => rssCandidate($, entry, index, feed))
    .filter((candidate) => isDashboardCandidateEligible(candidate, now));
  return { source: `rss:${sourceSlug(feed.name)}`, candidates };
}

export async function fetchRedditCandidates(
  fetchImpl: typeof fetch,
  subreddit: string,
  now = new Date()
): Promise<{ source: string; candidates: DashboardCandidate[] }> {
  const normalizedSubreddit = normalizeSubreddits([subreddit])[0];
  if (!normalizedSubreddit) throw new Error("reddit_invalid_subreddit");
  const url = new URL(`https://www.reddit.com/r/${encodeURIComponent(normalizedSubreddit)}/new.json`);
  url.searchParams.set("limit", String(MAX_REDDIT_ITEMS_PER_SUBREDDIT));
  url.searchParams.set("raw_json", "1");
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "ReturnerDashboard/1.0 public-read-only" },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`reddit_${sourceSlug(normalizedSubreddit)}_http_${response.status}`);
  const payload = await readBoundedJson<RedditListing>(response, `reddit_${sourceSlug(normalizedSubreddit)}`);
  const candidates = (payload.data?.children ?? [])
    .flatMap((child) => redditCandidate(child.data, normalizedSubreddit, now))
    .filter((candidate) => isDashboardCandidateEligible(candidate, now));
  return { source: `reddit:${sourceSlug(normalizedSubreddit)}`, candidates };
}

function hackerNewsCandidate(hit: AlgoliaHit, observedAt: Date): DashboardCandidate[] {
  const title = compactWhitespace(hit.title ?? hit.story_title);
  const publishedAt = validTimestamp(hit.created_at);
  const id = compactWhitespace(hit.objectID);
  if (!title || !publishedAt || !id) return [];
  const nativeUrl = `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}`;
  const destinationUrl = canonicalDashboardUrl(hit.url ?? hit.story_url);
  return [{
    id: `hn:${id}`,
    canonicalKey: `hacker_news:post:${id}`,
    platform: "hacker_news",
    sourceKind: "discussion",
    url: nativeUrl,
    destinationUrl,
    linkedUrls: destinationUrl ? [destinationUrl] : [],
    title,
    summary: null,
    authorName: compactWhitespace(hit.author) || null,
    publisher: "Hacker News",
    publishedAt,
    observedAt: observedAt.toISOString(),
    metrics: { upvotes: finiteNonnegative(hit.points), comments: finiteNonnegative(hit.num_comments) },
    entityKeys: destinationUrl ? [`destination:${destinationUrl}`] : [],
    topics: [],
    independentlyReported: true,
    sourceQuality: 70,
    contentFingerprint: `${id}:${title}`
  }];
}

function githubCandidate(repository: GithubRepository, observedAt: Date): DashboardCandidate[] {
  const url = canonicalDashboardUrl(repository.html_url);
  const publishedAt = validTimestamp(repository.created_at);
  const id = String(repository.id ?? "").trim();
  const name = compactWhitespace(repository.full_name || repository.name);
  if (!url || !publishedAt || !id || !name) return [];
  const description = compactWhitespace(repository.description);
  return [{
    id: `github:${id}`,
    canonicalKey: `github:repository-object:${id}`,
    platform: "github",
    sourceKind: "repository",
    url,
    destinationUrl: url,
    linkedUrls: [url],
    title: name,
    summary: description || null,
    text: description || null,
    authorName: compactWhitespace(repository.owner?.login) || null,
    publisher: "GitHub",
    publishedAt,
    observedAt: observedAt.toISOString(),
    metrics: {
      stars: finiteNonnegative(repository.stargazers_count),
      forks: finiteNonnegative(repository.forks_count),
      watchers: finiteNonnegative(repository.watchers_count)
    },
    entityKeys: [`repository:${id}`, `destination:${url}`],
    entityLabel: name,
    topics: [],
    thumbnailUrl: repository.owner?.avatar_url ?? null,
    thumbnailAlt: `${name} repository preview`,
    independentlyReported: false,
    sourceQuality: 72,
    contentFingerprint: `${id}:${repository.updated_at ?? ""}:${description}`
  }];
}

function githubReleaseCandidate(event: GithubEvent, observedAt: Date): DashboardCandidate[] {
  const release = event.payload?.release;
  const action = compactWhitespace(event.payload?.action).toLowerCase();
  if (event.type !== "ReleaseEvent" || action !== "published" || !release || release.draft === true) return [];

  const eventId = stableIdentifier(event.id);
  const releaseId = stableIdentifier(release?.id);
  const repositoryId = stableIdentifier(event.repo?.id);
  const repositoryName = compactWhitespace(event.repo?.name);
  const url = canonicalDashboardUrl(release?.html_url);
  const publishedAt = validTimestamp(release?.published_at ?? event.created_at);
  if (!eventId || !releaseId || !repositoryName || !url || !publishedAt) return [];

  const releaseName = compactWhitespace(release.name) || compactWhitespace(release.tag_name);
  const title = releaseName
    ? `${repositoryName} releases ${releaseName}`
    : `${repositoryName} publishes a release`;
  const description = compactSentence(release.body, 300);
  const downloads = Array.isArray(release.assets)
    ? release.assets.reduce((total, asset) => total + (finiteNonnegative(asset.download_count) ?? 0), 0)
    : 0;
  const reactions = finiteNonnegative(release.reactions?.total_count);

  return [{
    id: `github:release:${releaseId}`,
    canonicalKey: `github:release:${releaseId}`,
    platform: "github",
    sourceKind: "release",
    url,
    destinationUrl: url,
    linkedUrls: [url],
    title,
    summary: description,
    text: description,
    authorName: compactWhitespace(release.author?.login) || compactWhitespace(event.actor?.login) || null,
    publisher: "GitHub",
    publishedAt,
    observedAt: observedAt.toISOString(),
    metrics: { downloads, reactions },
    entityKeys: [
      ...(repositoryId ? [`repository:${repositoryId}`] : []),
      `destination:${url}`
    ],
    entityLabel: repositoryName,
    topics: ["open_source"],
    thumbnailUrl: null,
    thumbnailAlt: `${title} release preview`,
    independentlyReported: false,
    sourceQuality: 74,
    contentFingerprint: `${eventId}:${releaseId}:${release.updated_at ?? release.published_at ?? ""}:${downloads}:${reactions ?? ""}:${description ?? ""}`
  }];
}

function githubPublicHeaders(githubToken: string | null): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "ReturnerDashboard/1.0 public-read-only",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {})
  };
}

function stableIdentifier(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function rssCandidate(
  $: ReturnType<typeof load>,
  entry: Parameters<ReturnType<typeof load>>[0],
  index: number,
  feed: DashboardRssFeed
): DashboardCandidate[] {
  const node = $(entry);
  const title = compactWhitespace(node.find("title").first().text());
  const url = canonicalDashboardUrl(
    node.find("link[rel='alternate']").first().attr("href") ||
    node.find("link").first().attr("href") ||
    node.find("link").first().text()
  );
  const publishedAt = validTimestamp(
    node.find("published, pubDate, updated, dc\\:date").first().text()
  );
  if (!title || !url || !publishedAt) return [];
  const description = compactSentence(node.find("description, summary, content").first().text(), 300);
  const media = node.find("media\\:content, media\\:thumbnail, enclosure[type^='image']").first();
  const thumbnailUrl = canonicalDashboardUrl(media.attr("url") ?? null);
  const articleKey = compactWhitespace(node.find("guid, id").first().text()) || url;
  const sourceKind = feed.sourceKind ?? "article";
  return [{
    id: `rss:${sourceSlug(feed.name)}:${stableHash(articleKey)}`,
    canonicalKey: `rss:url:${url}`,
    platform: feed.platform ?? "rss",
    sourceKind,
    url,
    destinationUrl: url,
    linkedUrls: [url],
    title,
    summary: description,
    text: description,
    publisher: feed.name,
    publishedAt,
    observedAt: publishedAt,
    metrics: {},
    entityKeys: [`destination:${url}`],
    topics: sourceKind === "paper" ? ["research"] : [],
    thumbnailUrl,
    thumbnailAlt: title,
    independentlyReported: feed.independentlyReported ?? true,
    sourceQuality: feed.quality ?? 62,
    contentFingerprint: `${articleKey}:${title}:${index}`
  }];
}

function redditCandidate(post: RedditPost | undefined, subreddit: string, observedAt: Date): DashboardCandidate[] {
  const id = compactWhitespace(post?.id);
  const title = compactWhitespace(post?.title);
  const permalink = compactWhitespace(post?.permalink);
  const timestamp = typeof post?.created_utc === "number" ? post.created_utc * 1_000 : Number.NaN;
  const publishedDate = new Date(timestamp);
  const publishedAt = Number.isFinite(publishedDate.getTime()) ? publishedDate.toISOString() : null;
  if (!id || !title || !permalink || !publishedAt) return [];
  const nativeUrl = canonicalDashboardUrl(`https://www.reddit.com${permalink}`);
  if (!nativeUrl) return [];
  const submittedUrl = canonicalDashboardUrl(post?.url ?? null);
  const destinationUrl = submittedUrl && !isRedditUrl(submittedUrl) ? submittedUrl : null;
  const description = compactSentence(post?.selftext, 300);
  return [{
    id: `reddit:${subreddit}:${id}`,
    canonicalKey: `reddit:post:${id}`,
    platform: "reddit",
    sourceKind: "discussion",
    url: nativeUrl,
    destinationUrl,
    linkedUrls: destinationUrl ? [destinationUrl] : [],
    title,
    summary: description,
    text: description,
    authorName: compactWhitespace(post?.author) || null,
    publisher: `r/${subreddit}`,
    publishedAt,
    observedAt: observedAt.toISOString(),
    metrics: { upvotes: finiteNonnegative(post?.score), comments: finiteNonnegative(post?.num_comments) },
    entityKeys: destinationUrl ? [`destination:${destinationUrl}`] : [],
    topics: [],
    // A public subreddit listing does not establish whether the submitter is
    // independent. It can contribute attention, but never a confirmation
    // bonus without a verified adapter making that determination.
    independentlyReported: false,
    sourceQuality: 58,
    contentFingerprint: `${id}:${post?.score ?? ""}:${post?.num_comments ?? ""}:${title}`
  }];
}

function configuredRssFeeds(): ReadonlyArray<DashboardRssFeed> {
  const configured = process.env.DASHBOARD_RSS_FEEDS?.trim();
  if (!configured) return DEFAULT_DASHBOARD_RSS_FEEDS;
  // Runtime configuration can choose a feed path only on the fixed,
  // built-in publication hosts; no arbitrary scheme, credentials, or host is
  // accepted.
  return configured.split(",").flatMap((raw, index) => {
    const url = configuredRssUrl(raw);
    if (!url) return [];
    return [{ name: `Configured feed ${index + 1}`, url, quality: 62 }];
  }).slice(0, 8);
}

function configuredRssUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    const hostname = normalizedRssHostname(parsed.hostname);
    if (
      parsed.protocol !== "https:" ||
      Boolean(parsed.port) ||
      Boolean(parsed.username || parsed.password) ||
      !isPublicRssHost(hostname) ||
      !CONFIGURED_RSS_HOST_ALLOWLIST.has(hostname)
    ) {
      return null;
    }
    return canonicalDashboardUrl(parsed.toString());
  } catch {
    return null;
  }
}

function isPublicRssHost(hostname: string): boolean {
  const host = normalizedRssHostname(hostname);
  if (!host || host === "localhost" || host.endsWith(".localhost")) return false;
  const version = isIP(host);
  if (version === 4) return !isPrivateIpv4(host);
  if (version === 6) return !isPrivateIpv6(host);
  return true;
}

function normalizedRssHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
}

function isPrivateIpv4(host: string): boolean {
  const [first, second] = host.split(".").map(Number);
  return first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function isPrivateIpv6(host: string): boolean {
  // `URL` normalizes IPv4-mapped addresses (for example, 127.0.0.1 becomes
  // ::ffff:7f00:1), so reject the reserved/compatibility `::/` range rather
  // than attempting to recover an embedded IPv4 string.
  if (host.startsWith("::")) return true;
  const firstSegment = Number.parseInt(host.split(":")[0] || "0", 16);
  // fc00::/7 private use and fe80::/10 link-local addresses are never valid
  // configured feed targets.
  return (firstSegment & 0xfe00) === 0xfc00 || (firstSegment & 0xffc0) === 0xfe80;
}

function normalizeSubreddits(values: readonly string[]): string[] {
  return [...new Set(values
    .map((value) => value.trim())
    .filter((value) => /^[A-Za-z0-9_]{2,30}$/.test(value)))]
    .slice(0, 8);
}

function isRedditUrl(value: string): boolean {
  try {
    return new URL(value).hostname.endsWith("reddit.com");
  } catch {
    return false;
  }
}

async function readBoundedJson<T>(response: Response, source: string): Promise<T> {
  const text = await readBoundedText(response, source);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${source}_invalid_json`);
  }
}

async function readBoundedText(response: Response, source: string): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error(`${source}_response_too_large`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`${source}_response_too_large`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concatenate(chunks, size));
}

function concatenate(chunks: Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function validTimestamp(value: unknown): string | null {
  const date = typeof value === "string" ? safeDate(value) : null;
  return date?.toISOString() ?? null;
}

function finiteNonnegative(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function sourceSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "source";
}

function discoveryFailureLabel(error: unknown): string {
  const raw = error instanceof Error ? error.message : "unknown";
  return raw.replace(/[^a-z0-9_.:-]+/gi, "_").slice(0, 160) || "unknown";
}

interface AlgoliaResponse { hits?: AlgoliaHit[] }
interface AlgoliaHit {
  objectID?: string;
  title?: string | null;
  story_title?: string | null;
  url?: string | null;
  story_url?: string | null;
  author?: string | null;
  created_at?: string | null;
  points?: number | null;
  num_comments?: number | null;
}
interface GithubSearchResponse { items?: GithubRepository[] }
interface GithubRepository {
  id?: number | string;
  name?: string | null;
  full_name?: string | null;
  html_url?: string | null;
  description?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  stargazers_count?: number | null;
  forks_count?: number | null;
  watchers_count?: number | null;
  owner?: { login?: string | null; avatar_url?: string | null } | null;
}
interface GithubEvent {
  id?: string | number;
  type?: string | null;
  created_at?: string | null;
  actor?: { login?: string | null } | null;
  repo?: { id?: string | number; name?: string | null } | null;
  payload?: {
    action?: string | null;
    release?: GithubRelease | null;
  } | null;
}
interface GithubRelease {
  id?: string | number;
  name?: string | null;
  tag_name?: string | null;
  html_url?: string | null;
  body?: string | null;
  published_at?: string | null;
  updated_at?: string | null;
  draft?: boolean | null;
  author?: { login?: string | null } | null;
  reactions?: { total_count?: number | null } | null;
  assets?: Array<{ download_count?: number | null }> | null;
}
interface RedditListing {
  data?: { children?: Array<{ data?: RedditPost }> };
}
interface RedditPost {
  id?: string | null;
  title?: string | null;
  permalink?: string | null;
  url?: string | null;
  selftext?: string | null;
  author?: string | null;
  created_utc?: number | null;
  score?: number | null;
  num_comments?: number | null;
}
