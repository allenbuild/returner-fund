import type {
  DashboardCandidate,
  DashboardMetrics,
  DashboardNativePlatform,
  DashboardPlatform,
  DashboardSourceKind,
  DashboardTopic
} from "./contracts";

const TRACKING_QUERY_KEYS = new Set([
  "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "referrer", "source", "utm_campaign", "utm_content", "utm_medium", "utm_source", "utm_term"
]);

export function finiteMetric(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function sanitizeMetrics(metrics: DashboardMetrics | null | undefined): DashboardMetrics {
  return Object.fromEntries(
    Object.entries(metrics ?? {}).flatMap(([key, value]) => {
      const normalized = finiteMetric(value);
      return normalized > 0 ? [[key, normalized]] : [];
    })
  );
}

export function aggregateMetrics(items: readonly DashboardMetrics[]): DashboardMetrics {
  const aggregate: DashboardMetrics = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      const normalized = finiteMetric(value);
      if (!normalized) continue;
      aggregate[key] = finiteMetric(aggregate[key]) + normalized;
    }
  }
  return aggregate;
}

/** A common, platform-independent absolute attention proxy used only after normalization. */
export function engagementMass(metrics: DashboardMetrics | null | undefined): number {
  const values = metrics ?? {};
  return (
    finiteMetric(values.views) * 0.04 +
    finiteMetric(values.likes) +
    finiteMetric(values.reactions) +
    finiteMetric(values.comments) * 2.2 +
    finiteMetric(values.replies) * 2.2 +
    finiteMetric(values.shares) * 3 +
    finiteMetric(values.reposts) * 3 +
    finiteMetric(values.quotes) * 3 +
    finiteMetric(values.upvotes) * 1.2 +
    finiteMetric(values.stars) * 1.5 +
    finiteMetric(values.forks) * 3 +
    finiteMetric(values.watchers) * 0.5 +
    finiteMetric(values.subscribers) * 0.2 +
    finiteMetric(values.downloads) * 0.03
  );
}

export function canonicalDashboardUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_QUERY_KEYS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
        url.searchParams.delete(key);
      }
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

export function dashboardPlatformForCandidate(candidate: Pick<DashboardCandidate, "platform" | "sourceKind">): DashboardPlatform {
  if (candidate.sourceKind === "paper") return "research";
  if (candidate.sourceKind === "article" && (candidate.platform === "web" || candidate.platform === "rss")) {
    return "news";
  }
  return candidate.platform;
}

export function sourceKindLabel(kind: DashboardSourceKind): string {
  const labels: Record<DashboardSourceKind, string> = {
    post: "Post",
    thread: "Thread",
    video: "Video",
    article: "Article",
    paper: "Research",
    repository: "Repository",
    release: "Release",
    launch: "Launch",
    discussion: "Discussion",
    other: "Source"
  };
  return labels[kind];
}

export function platformLabel(platform: DashboardPlatform | DashboardNativePlatform): string {
  const labels: Record<DashboardPlatform, string> = {
    github: "GitHub",
    x: "X",
    linkedin: "LinkedIn",
    instagram: "Instagram",
    product_hunt: "Product Hunt",
    youtube: "YouTube",
    rss: "RSS",
    web: "Web",
    reddit: "Reddit",
    hacker_news: "Hacker News",
    bilibili: "Bilibili",
    tiktok: "TikTok",
    bluesky: "Bluesky",
    news: "News",
    research: "Research"
  };
  return labels[platform as DashboardPlatform] ?? platform;
}

export function normalizeTopicList(topics: readonly DashboardTopic[] | null | undefined): DashboardTopic[] {
  const unique = new Set<DashboardTopic>();
  for (const topic of topics ?? []) unique.add(topic);
  return [...unique].sort();
}

export function safeDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function compactWhitespace(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function compactSentence(value: string | null | undefined, maxLength = 300): string | null {
  const normalized = compactWhitespace(value)
    .replace(/([.!?]){2,}/g, "$1")
    .replace(/\s+([,.;:!?])/g, "$1");
  if (!normalized) return null;
  const sentence = firstCompleteSentence(normalized) ?? normalized;
  const trimmed = sentence.slice(0, maxLength).replace(/[\s,;:]+$/, "");
  if (!trimmed) return null;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

const NON_TERMINAL_ABBREVIATIONS = new Set([
  "dr", "fig", "inc", "jr", "ltd", "mr", "mrs", "ms", "no", "prof", "sr", "st", "vs"
]);

/**
 * Finds the first real sentence boundary without mistaking publisher
 * abbreviations (for example "U.S." and "A.I.") for a complete sentence.
 */
function firstCompleteSentence(value: string): string | null {
  for (let index = 0; index < value.length; index += 1) {
    const punctuation = value[index];
    if (punctuation !== "." && punctuation !== "!" && punctuation !== "?") continue;
    const next = value[index + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    if (punctuation === "." && isNonTerminalAbbreviation(value, index)) continue;
    return value.slice(0, index + 1);
  }
  return null;
}

function isNonTerminalAbbreviation(value: string, punctuationIndex: number): boolean {
  const prefix = value.slice(0, punctuationIndex + 1);
  // Initialisms including U.S., A.I., and Ph.D. end in a period but commonly
  // continue a headline or sentence.
  if (/(?:\b[A-Za-z]\.){2,}$/.test(prefix)) return true;
  const word = prefix.match(/\b([A-Za-z]{1,10})\.$/)?.[1]?.toLowerCase();
  return Boolean(word && NON_TERMINAL_ABBREVIATIONS.has(word));
}

export function stableHash(value: string): string {
  // 64-bit FNV-1a is deterministic in browsers, server jobs, and tests. Its
  // much larger collision space matters for durable story/source identities;
  // it is still not used as a security boundary.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(36);
}

export function clamp(value: number, lower = 0, upper = 100): number {
  return Math.max(lower, Math.min(upper, Number.isFinite(value) ? value : lower));
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
