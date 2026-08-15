import { load } from "cheerio";
import { isIP } from "node:net";
import type { DashboardCandidate } from "./contracts";
import { canonicalDashboardUrl, compactSentence, compactWhitespace, safeDate, stableHash } from "./normalization";
import { isDashboardCandidateEligible } from "./pipeline";

const MAX_RESPONSE_BYTES = 1_500_000;
// HN is useful as lightweight corroboration, but it is intentionally a small
// input lane. The publication layer owns the final story-level share cap;
// retaining this bounded cohort here lets matching editorial coverage cluster
// with the correct discussion instead of manufacturing a singleton baseline.
const MAX_HN_ITEMS = 12;
const MIN_HN_UPVOTES = 20;
const MIN_HN_COMMENTS = 5;
const MAX_GITHUB_ITEMS = 40;
const MIN_GITHUB_STARS = 100;
const MAX_GITHUB_EVENT_ITEMS = 100;
const MAX_RSS_ITEMS_PER_FEED = 40;
// Primary research is a direct, high-quality lane rather than a broad
// consumer feed. Keep its discovery window modestly wider so the Top 100 can
// remain substantive without re-admitting reviews, deals, or lifestyle cards.
const MAX_RESEARCH_ITEMS_PER_FEED = 60;
const MAX_REDDIT_ITEMS_PER_SUBREDDIT = 40;
const MAX_ENTRY_IMAGE_HTML_CHARS = 32_000;
const MIN_RSS_SUMMARY_WORDS = 8;

// Direct publisher feeds are intentionally broad enough to catch important
// technology coverage, which means some also carry entertainment, shopping,
// and lifestyle sections. A source name is not a relevance guarantee: accept
// an article only when its own headline/description has a clear technology,
// science, engineering, or business-tech signal, and reject non-editorial
// formats before they can consume a Top 100 slot.
const TECHNOLOGY_EDITORIAL_SIGNAL = new RegExp([
  "\\btechnology\\b", "\\bai\\b", "a\\.i\\.", "artificial intelligence", "machine learning", "generative", "large language model", "\\bllm\\b", "agentic", "chatbot", "algorithm", "model training",
  "\\bsoftware\\b", "open[ -]?source", "developer", "development", "program(?:ming|mer)", "coding", "codebase", "compiler", "\\bapi\\b", "\\bapp(?:lication)?\\b", "app store", "operating system", "\\b(?:ios|macos|linux|android|windows)\\b",
  "\\bcloud\\b", "\\bserver\\b", "\\bdatabase\\b", "data centers?", "data storage", "data set", "\\bcompute\\b", "computing", "supercomputer", "semiconductor", "\\bchips?\\b", "\\bgpu\\b", "processor", "hardware", "firmware", "electronics?", "signal processing", "\\bantenna\\b", "\\busb(?:4|[- ]?c)?\\b",
  "\\binternet\\b", "\\bweb\\b", "browser", "digital platform", "network(?:ing)?", "telecom", "wireless", "broadband", "\\b(?:5g|6g|wi-?fi)\\b", "\\bnpm\\b", "supply chain", "\\bplugins?\\b",
  "cyber(?:security)?", "\\bsecurity\\b", "privacy", "encryption", "ransomware", "malware", "spyware", "phishing", "hack(?:er|ed|ing)?", "vulnerabilit(?:y|ies)", "prompt injection",
  "\\bstartup\\b", "fund(?:ing|raise)", "venture capital", "\\bvc\\b", "fintech", "payment(?:s)?", "\\bipo\\b", "cloud storage",
  "robot(?:ics)?", "autonomous", "self-driving", "\\bdrone\\b", "electric vehicle", "\\bev\\b", "\\bbattery\\b", "\\bsolar\\b", "wind power", "\\bnuclear\\b", "\\bfusion\\b", "energy grid", "electric aircraft", "\\baircraft\\b", "aviation", "aerospace",
  "biotech", "bio(?:tech|engineering)", "genom(?:e|ics)", "medical device", "engineering", "engineer(?:s|ing)?", "research(?:er|ers)?", "scientist(?:s)?", "\\bphysics\\b", "\\bquantum\\b",
  "spacecraft", "spaceflight", "satellite", "\\brocket\\b", "orbit(?:al)?", "telescope", "astronom(?:y|ical)", "black hole", "climate tech", "carbon capture", "facial recognition", "watermark(?:ing)?", "\\b(?:iphone|smartphone|mobile)\\b"
].join("|"), "i");

const COMMERCE_PROMOTION_FORMAT = new RegExp([
  "\\bdeals?\\b", "\\bsale\\b", "\\bdiscount\\b", "\\bpromo(?:tion| code)?\\b", "\\bcoupon\\b", "\\bgiveaway\\b", "giving away", "for free", "\\bshopping\\b", "shop now", "buy now", "available to buy", "\\bsponsored\\b", "save\\s+\\$", "under\\s+\\$", "%\\s*off", "lifetime access", "\\bupgrade deal\\b", "upgrade your (?:pc|computer|laptop|phone|device)", "pay\\s+\\$\\d", "plan for\\s+\\$\\d", "for just\\s+\\$\\d"
].join("|"), "i");

const LOWER_VALUE_EDITORIAL_FORMAT = new RegExp([
  "\\bbest\\b", "\\breviews?\\b", "\\bvs\\.?\\b", "\\bversus\\b", "\\bcomparison\\b", "hands-on", "\\bunboxing\\b", "\\b(?:i|we)\\s+(?:tested|reviewed)\\b",
  "\\bhow to\\b", "what(?:'s| is| are| happens)", "\\bexplained\\b", "\\bguides?\\b", "\\bapple loop\\b", "\\b(?:iphone|smartphone|laptop|macbook).{0,32}\\bprice\\b"
].join("|"), "i");

const OPINION_OR_VAGUE_FORMAT = new RegExp([
  "\\bopinion\\b", "\\bcolumn\\b", "\\bessay\\b", "\\bmanifesto(?:s)?\\b", "\\bexplainer\\b", "\\bthe case for\\b", "\\bai\\s+vs\\b", "\\bsatir(?:e|ical)\\b", "\\bparody\\b", "\\bjoke\\b", "can['’]?t go viral", "\\bgo viral\\b", "moved the goalposts", "\\bapod\\b", "astronomy picture of the day", "\\bexpo\\b", "\\bairshow\\b", "this week in science", "will redefine",
  "prompt(?:s)?\\s+(?:injections?|injected).*\\b(?:legal|court|filing)s?\\b", "\\b(?:legal|court|filing)s?.*(?:prompt(?:s)?\\s+(?:injections?|injected)|injected\\s+prompts?)"
].join("|"), "i");

const ENTERTAINMENT_OR_LIFESTYLE_SIGNAL = new RegExp([
  "\\bmovies?\\b", "\\bfilms?\\b", "\\btelevision\\b", "\\btv\\b", "\\bseries\\b", "\\bseason\\b", "\\bepisode\\b", "\\btrailer\\b", "\\bcast\\b", "\\bactors?\\b", "\\bactress(?:es)?\\b", "\\bconcert\\b", "\\bmusic\\b", "\\bsongs?\\b", "\\balbum\\b", "\\bpodcast\\b", "\\bcelebrity\\b", "\\bhollywood\\b",
  "\\banime\\b", "\\bgames?\\b", "\\bgamer\\b", "\\bgaming\\b", "vibe coded", "video games?", "\\bplaystation\\b", "\\bxbox\\b", "\\bnintendo\\b", "\\bdisney\\b", "\\bmarvel\\b", "star wars", "\\bnetflix\\b", "\\bhbo\\b", "\\bhulu\\b", "\\btheat(?:er|re)\\b",
  "\\bnecklace\\b", "\\bjewelry\\b", "\\bfashion\\b", "\\bbeauty\\b", "\\bgarden\\b", "ice cream", "\\bfood\\b", "\\brecipe\\b", "\\bbooks?\\b", "secondhand", "\\bmushrooms?\\b", "\\bdating\\b", "\\brelationship\\b", "\\bparents?\\b", "\\bkids?\\b", "screen time", "\\bporn\\b", "\\bsexual\\b", "\\bmasturbation\\b", "\\binfluencers?\\b", "\\bfitness\\b", "bodybuild(?:er|ing)", "looksmaxx", "\\bsemaglutide\\b", "\\bglp[- ]?1s?\\b", "\\bdementia\\b", "mental health advice", "weight loss", "\\bdiet\\b",
  "\\bheadphones?\\b", "\\bearbuds?\\b", "watch bands?", "phone grip", "\\bturntable\\b", "bookshelf speakers?", "\\bspeakers?\\b", "\\bprinters?\\b", "\\bvacuum\\b", "\\bfan\\b", "sports betting"
].join("|"), "i");

const LOW_SIGNAL_OR_PROMOTIONAL_REPOSITORY = /\b(?:crypto(?:currency)?|nft|token|airdrop|coin|memecoin|web3|gambling|casino|betting|preset|gitbash|fake[ -]?balance|vibe[ -]?coding)\b/i;

// Environment configuration may select a feed path only on these public
// publication hosts. Keeping this list literal (rather than accepting an
// arbitrary public hostname) prevents the worker from becoming a general
// outbound-fetch proxy through DASHBOARD_RSS_FEEDS.
const CONFIGURED_RSS_HOST_ALLOWLIST = new Set([
  "www.technologyreview.com",
  "feeds.arstechnica.com",
  "techcrunch.com",
  "www.theverge.com",
  "www.wired.com",
  "spectrum.ieee.org",
  "venturebeat.com",
  "www.engadget.com",
  "www.theguardian.com",
  "rss.nytimes.com",
  "feeds.bbci.co.uk",
  "api.theregister.com",
  "news.mit.edu",
  "research.google",
  "huggingface.co",
  "www.cnet.com",
  "gizmodo.com",
  "www.zdnet.com",
  "www.pcmag.com",
  "mashable.com",
  "www.ft.com",
  "the-decoder.com",
  "thenewstack.io",
  "feed.infoq.com",
  "www.bleepingcomputer.com",
  "www.techspot.com",
  "www.tomshardware.com",
  "9to5google.com",
  "www.bloomberg.com",
  "www.geekwire.com",
  "therecord.media",
  "spacenews.com",
  "www.nasa.gov",
  "www.darkreading.com",
  "www.hpcwire.com",
  "phys.org",
  "www.space.com",
  "www.datacenterdynamics.com",
  "www.sciencealert.com",
  "www.forbes.com"
]);

/**
 * Public, read-only editorial feeds. These are intentionally direct publisher
 * feeds rather than a search-engine feed or a generic scrape: that keeps the
 * worker bounded, makes the source shown to visitors unambiguous, and gives
 * reporting and research a much larger discovery surface than discussions.
 */
export const DEFAULT_DASHBOARD_RSS_FEEDS = [
  { name: "MIT Technology Review", url: "https://www.technologyreview.com/feed/", quality: 84 },
  { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", quality: 80 },
  { name: "IEEE Spectrum", url: "https://spectrum.ieee.org/feeds/feed.rss", quality: 84 },
  { name: "MIT News AI", url: "https://news.mit.edu/rss/topic/artificial-intelligence2", quality: 84 },
  { name: "The New York Times Technology", url: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml", quality: 84 },
  { name: "BBC News Technology", url: "https://feeds.bbci.co.uk/news/technology/rss.xml", quality: 82 },
  { name: "The Guardian Technology", url: "https://www.theguardian.com/uk/technology/rss", quality: 80 },
  { name: "WIRED", url: "https://www.wired.com/feed/rss", quality: 78 },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml", quality: 76 },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/", quality: 74 },
  { name: "VentureBeat", url: "https://venturebeat.com/feed/", quality: 72 },
  { name: "Engadget", url: "https://www.engadget.com/rss.xml", quality: 70 },
  { name: "The Register", url: "https://api.theregister.com/api/v1/article?orderBy=published&site_id=2&remapper=rss", quality: 72 },
  { name: "Google Research", url: "https://research.google/blog/rss/", quality: 82 },
  { name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml", quality: 76 },
  { name: "CNET", url: "https://www.cnet.com/rss/news/", quality: 74 },
  { name: "Gizmodo", url: "https://gizmodo.com/feed", quality: 70 },
  { name: "ZDNET", url: "https://www.zdnet.com/news/rss.xml", quality: 74 },
  { name: "PCMag", url: "https://www.pcmag.com/feeds/rss/latest", quality: 74 },
  { name: "Mashable Tech", url: "https://mashable.com/feeds/rss/tech", quality: 70 },
  { name: "Financial Times Technology", url: "https://www.ft.com/technology?format=rss", quality: 84 },
  { name: "The Decoder", url: "https://the-decoder.com/feed/", quality: 80 },
  { name: "The New Stack", url: "https://thenewstack.io/feed/", quality: 80 },
  { name: "InfoQ", url: "https://feed.infoq.com/", quality: 80 },
  { name: "BleepingComputer", url: "https://www.bleepingcomputer.com/feed/", quality: 80 },
  { name: "TechSpot", url: "https://www.techspot.com/backend.xml", quality: 74 },
  { name: "Tom's Hardware", url: "https://www.tomshardware.com/feeds/all", quality: 74 },
  { name: "9to5Google", url: "https://9to5google.com/feed/", quality: 72, maxItems: 2 },
  { name: "Bloomberg Technology", url: "https://www.bloomberg.com/feeds/technology/news.rss", quality: 86 },
  { name: "GeekWire", url: "https://www.geekwire.com/feed/", quality: 80 },
  { name: "The Record", url: "https://therecord.media/feed", quality: 82 },
  { name: "SpaceNews", url: "https://spacenews.com/feed/", quality: 82 },
  { name: "NASA News", url: "https://www.nasa.gov/news-release/feed/", quality: 86, independentlyReported: false },
  { name: "Dark Reading", url: "https://www.darkreading.com/rss.xml", quality: 82 },
  { name: "HPCwire", url: "https://www.hpcwire.com/feed/", quality: 82 },
  { name: "Phys.org Technology", url: "https://phys.org/rss-feed/technology-news/", quality: 78 },
  { name: "Phys.org Physics", url: "https://phys.org/rss-feed/physics-news/", quality: 78 },
  { name: "Phys.org Space", url: "https://phys.org/rss-feed/space-news/", quality: 78 },
  { name: "Space.com", url: "https://www.space.com/feeds/all", quality: 78 },
  { name: "Data Center Dynamics", url: "https://www.datacenterdynamics.com/en/rss/", quality: 82 },
  { name: "ScienceAlert", url: "https://www.sciencealert.com/feed", quality: 76 },
  { name: "Forbes Innovation", url: "https://www.forbes.com/innovation/feed2/", quality: 78 }
] as const;

/**
 * Papers are candidates only when another observed signal corroborates them.
 * The category feeds keep the worker broad across AI, ML, language, vision,
 * robotics, and security without issuing an unbounded research search.
 */
export const DEFAULT_DASHBOARD_RESEARCH_FEEDS = [
  { name: "arXiv cs.AI", url: "https://rss.arxiv.org/rss/cs.AI", quality: 84, platform: "research", sourceKind: "paper", independentlyReported: false },
  { name: "arXiv cs.LG", url: "https://rss.arxiv.org/rss/cs.LG", quality: 84, platform: "research", sourceKind: "paper", independentlyReported: false },
  { name: "arXiv stat.ML", url: "https://rss.arxiv.org/rss/stat.ML", quality: 84, platform: "research", sourceKind: "paper", independentlyReported: false },
  { name: "arXiv cs.CL", url: "https://rss.arxiv.org/rss/cs.CL", quality: 82, platform: "research", sourceKind: "paper", independentlyReported: false },
  { name: "arXiv cs.CV", url: "https://rss.arxiv.org/rss/cs.CV", quality: 82, platform: "research", sourceKind: "paper", independentlyReported: false },
  { name: "arXiv cs.RO", url: "https://rss.arxiv.org/rss/cs.RO", quality: 82, platform: "research", sourceKind: "paper", independentlyReported: false },
  { name: "arXiv cs.CR", url: "https://rss.arxiv.org/rss/cs.CR", quality: 80, platform: "research", sourceKind: "paper", independentlyReported: false }
] as const satisfies readonly DashboardRssFeed[];

/** Fixed public communities avoid an unbounded Reddit search surface. */
export const DEFAULT_DASHBOARD_REDDIT_SUBREDDITS = ["MachineLearning", "technology", "programming", "startups"] as const;

interface DashboardRssFeed {
  name: string;
  url: string;
  quality?: number;
  maxItems?: number;
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
  return {
    candidates,
    failures: [...new Set(failures)].sort(),
    sources: [...new Set(sources)].sort()
  };
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
  const sourceItemLimit = feed.sourceKind === "paper" ? MAX_RESEARCH_ITEMS_PER_FEED : MAX_RSS_ITEMS_PER_FEED;
  const maxItems = Number.isFinite(feed.maxItems)
    ? Math.max(1, Math.min(sourceItemLimit, Math.trunc(feed.maxItems ?? sourceItemLimit)))
    : sourceItemLimit;
  const entries = $("item, entry").toArray().slice(0, maxItems);
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
  const storyText = compactSentence(hit.story_text, 300);
  const publishedAt = validTimestamp(hit.created_at);
  const id = compactWhitespace(hit.objectID);
  const upvotes = finiteNonnegative(hit.points);
  const comments = finiteNonnegative(hit.num_comments);
  if (
    !title ||
    !publishedAt ||
    !id ||
    !isTechnologyEditorialArticle(title, storyText) ||
    (upvotes ?? 0) < MIN_HN_UPVOTES && (comments ?? 0) < MIN_HN_COMMENTS
  ) return [];
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
    summary: storyText,
    text: storyText,
    authorName: compactWhitespace(hit.author) || null,
    publisher: "Hacker News",
    publishedAt,
    observedAt: observedAt.toISOString(),
    metrics: { upvotes, comments },
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
  const stars = finiteNonnegative(repository.stargazers_count);
  if (!isTechnologyRepositoryCandidate(name, description, stars)) return [];
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
      stars,
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

function isTechnologyRepositoryCandidate(name: string, description: string, stars: number | null): boolean {
  // A freshly-created repository with no meaningful description is usually
  // not enough evidence for a public technology-news card. Require an
  // explicit technical purpose, and exclude speculative-token spam entirely.
  const text = compactWhitespace(`${name} ${description}`);
  return description.length >= 16 &&
    (stars ?? 0) >= MIN_GITHUB_STARS &&
    TECHNOLOGY_EDITORIAL_SIGNAL.test(text) &&
    !LOW_SIGNAL_OR_PROMOTIONAL_REPOSITORY.test(text);
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
  if (LOW_SIGNAL_OR_PROMOTIONAL_REPOSITORY.test(`${repositoryName} ${releaseName} ${description ?? ""}`)) return [];
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
  const description = rssEntrySummary(node.find("description, summary, content, content\\:encoded").first().text());
  const sourceKind = feed.sourceKind ?? "article";
  if (sourceKind === "article" && !isTechnologyEditorialArticle(title, description)) return [];
  const thumbnailUrl = rssThumbnailUrl($, entry);
  const articleKey = compactWhitespace(node.find("guid, id").first().text()) || url;
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

/** RSS descriptions frequently arrive as CDATA-wrapped HTML. Keep markup out
 * of relevance scoring and the public summary while leaving the raw fragment
 * available to the separate thumbnail extractor below. */
function rssEntryPlainText(value: string | null | undefined): string | null {
  const raw = compactWhitespace(value);
  if (!raw) return null;
  if (!/<[a-z][^>]*>/i.test(raw)) return raw;
  return compactWhitespace(load(raw).text()) || null;
}

function rssEntrySummary(value: string | null | undefined): string | null {
  const summary = compactSentence(rssEntryPlainText(value), 300);
  if (!summary) return null;
  const wordCount = summary.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  // A fragment such as "Flamingo missiles were used." contains no useful
  // story context. Let the pipeline use the factual title instead of
  // publishing a clipped, context-free RSS excerpt.
  if (wordCount < MIN_RSS_SUMMARY_WORDS) return null;
  return summary;
}

function isTechnologyEditorialArticle(
  title: string,
  description: string | null
): boolean {
  const text = compactWhitespace([title, description].filter(Boolean).join(" "));
  return Boolean(text) &&
    TECHNOLOGY_EDITORIAL_SIGNAL.test(text) &&
    !COMMERCE_PROMOTION_FORMAT.test(text) &&
    !LOWER_VALUE_EDITORIAL_FORMAT.test(text) &&
    !OPINION_OR_VAGUE_FORMAT.test(text) &&
    !ENTERTAINMENT_OR_LIFESTYLE_SIGNAL.test(text);
}

/**
 * Publisher feeds commonly put their card image in `media:*`, but WordPress,
 * Atom, and newspaper feeds also frequently encode it inside a bounded entry
 * HTML fragment. We only extract an absolute public HTTPS URL; no image is
 * fetched here, and the dashboard's separate thumbnail policy still decides
 * whether the renderer may request the host.
 */
function rssThumbnailUrl(
  $: ReturnType<typeof load>,
  entry: Parameters<ReturnType<typeof load>>[0]
): string | null {
  const node = $(entry);
  const directMedia = node
    .find("media\\:thumbnail, media\\:content[type^='image'], media\\:content[medium='image'], enclosure[type^='image'], media\\:content")
    .toArray();
  for (const media of directMedia) {
    const thumbnail = absolutePublicHttpsUrl($(media).attr("url"));
    if (thumbnail) return thumbnail;
  }

  const htmlFragments = node
    .find("description, summary, content, content\\:encoded")
    .toArray()
    .map((content) => $(content).text().slice(0, MAX_ENTRY_IMAGE_HTML_CHARS));
  for (const html of htmlFragments) {
    const thumbnail = firstHtmlImageUrl(html);
    if (thumbnail) return thumbnail;
  }
  return null;
}

function firstHtmlImageUrl(html: string): string | null {
  if (!html.trim()) return null;
  const fragment = load(html);
  for (const image of fragment("img").toArray()) {
    const node = fragment(image);
    for (const attribute of ["src", "data-src", "data-original", "data-lazy-src"]) {
      const thumbnail = absolutePublicHttpsUrl(node.attr(attribute));
      if (thumbnail) return thumbnail;
    }
  }
  return null;
}

function absolutePublicHttpsUrl(value: string | null | undefined): string | null {
  const raw = compactWhitespace(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== "https:" ||
      Boolean(parsed.port || parsed.username || parsed.password) ||
      !isPublicRssHost(parsed.hostname)
    ) {
      return null;
    }
    return canonicalDashboardUrl(parsed.toString());
  } catch {
    return null;
  }
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
  story_text?: string | null;
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
