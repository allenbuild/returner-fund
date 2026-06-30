import {
  ReadOnlyConnector,
  emptyAccountMetrics,
  emptyPostMetrics,
  fetchText,
  normalizeLimit,
  parseJsonObject,
  profileCandidateFromUrl,
  stringField
} from "@/lib/connectors/base";
import type {
  EntityRef,
  FetchPostsOptions,
  NormalizedPost,
  PostMetrics,
  ProfileCandidate,
  SocialProfile
} from "@/types/domain";

export class ProductHuntConnector extends ReadOnlyConnector {
  platform = "product_hunt" as const;
  protected limitations = {
    platform: this.platform,
    requiresAuth: false,
    status: "public_only" as const,
    supportsMutation: false,
    supportsProfileDiscovery: true,
    supportsRecentPosts: true,
    supportsMetrics: true,
    authentication: "Public Product Hunt pages/search only.",
    rateLimits: ["Slow public page fetches; blocked pages are skipped instead of retried aggressively."],
    missingCapabilities: ["No voting, commenting, following, maker messaging, or authenticated API usage."],
    safetyRules: [],
    notes: [
      "Uses public Product Hunt product/post pages and search result pages only.",
      "Discovery candidates remain review-gated until name, website, maker, or YC context confirms the match.",
      "No votes, comments, follows, messages, or authenticated mutations."
    ]
  };

  constructor(private readonly fetchImpl: typeof fetch = fetch) {
    super();
  }

  async discoverProfiles(entity: EntityRef): Promise<ProfileCandidate[]> {
    const queries = [
      `site:producthunt.com/products "${entity.name}"`,
      `site:producthunt.com/posts "${entity.name}"`
    ];
    const candidates: ProfileCandidate[] = [];

    for (const query of queries) {
      const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const html = await fetchText(this.fetchImpl, url).catch(() => "");
      for (const candidateUrl of extractProductHuntUrls(html)) {
        if (!candidateLooksRelevant(entity, candidateUrl, html)) continue;
        candidates.push(
          profileCandidateFromUrl({
            platform: this.platform,
            url: candidateUrl,
            review_state: "needs_review",
            discoveredFromUrl: url,
            evidence: { query },
            reasons: [
              {
                signal: "public_product_hunt_search",
                weight: 0.5,
                matched: false,
                explanation: "Public Product Hunt search found a possible product/post URL; page verification is required before scoring.",
                sourceUrl: url
              }
            ]
          })
        );
      }
    }

    return dedupeByUrl(candidates).slice(0, 5);
  }

  async fetchRecentPosts(profile: SocialProfile, options: FetchPostsOptions): Promise<NormalizedPost[]> {
    const limit = normalizeLimit(options.limit, 5, 20);
    const html = await fetchText(this.fetchImpl, profile.url, { signal: options.signal }).catch(() => "");
    if (!html || isBlocked(html)) return [];

    const urls = [normalizeProductHuntUrl(profile.url), ...extractProductHuntUrls(html)]
      .filter((url): url is string => Boolean(url))
      .slice(0, limit);

    return dedupeStrings(urls).map((url) =>
      this.normalizePost({
        url,
        socialAccountId: profile.accountId ?? `product_hunt:${profile.handle ?? productHuntSlug(url) ?? "unknown"}`,
        authorHandle: profile.handle ?? productHuntSlug(url),
        html: url === normalizeProductHuntUrl(profile.url) ? html : "",
        title: extractTitle(html) ?? productHuntSlug(url),
        text: extractDescription(html) ?? extractTitle(html) ?? productHuntSlug(url) ?? "",
        metrics: parseProductHuntMetrics(html)
      })
    );
  }

  async fetchMetrics(post: NormalizedPost): Promise<PostMetrics> {
    const rawMetrics = parseJsonObject(post.raw.metrics) ?? {};
    const hasStoredMetrics = Object.values(rawMetrics).some((value) => Number.isFinite(Number(value)));
    const metrics = hasStoredMetrics
      ? rawMetrics
      : parseProductHuntMetrics(await fetchText(this.fetchImpl, post.url).catch(() => ""));

    return {
      ...emptyPostMetrics({ postId: post.platformPostId, url: post.url }),
      upvotes: numberOrNull(metrics.upvotes),
      comments: numberOrNull(metrics.comments),
      raw: metrics
    };
  }

  normalizePost(rawPost: unknown): NormalizedPost {
    const raw = parseJsonObject(rawPost);
    if (!raw) return super.normalizePost(rawPost);

    const url = normalizeProductHuntUrl(stringField(raw, "url") ?? "");
    if (!url) return super.normalizePost(rawPost);

    const platformPostId = productHuntSlug(url) ?? url;
    return {
      id: `product_hunt:${platformPostId}`,
      socialAccountId: stringField(raw, "socialAccountId") ?? `product_hunt:${platformPostId}`,
      platform: this.platform,
      platformPostId,
      url,
      authorName: stringField(raw, "authorName"),
      authorHandle: stringField(raw, "authorHandle"),
      text: stringField(raw, "text") ?? stringField(raw, "title") ?? platformPostId,
      mediaType: "launch",
      postedAt: stringField(raw, "postedAt"),
      raw
    };
  }

  getPermalink(rawPost: unknown): string | null {
    const raw = parseJsonObject(rawPost);
    return normalizeProductHuntUrl(stringField(raw ?? {}, "url") ?? "") ?? super.getPermalink(rawPost);
  }

  async getAccountMetrics(profile: SocialProfile) {
    return emptyAccountMetrics({ url: profile.url, note: "Product Hunt public pages expose launch/post metrics, not stable account follower metrics." });
  }
}

function extractProductHuntUrls(html: string): string[] {
  const urls = [
    ...html.matchAll(/https?:\/\/(?:www\.)?producthunt\.com\/(?:products|posts)\/[a-z0-9-]+/gi)
  ].map((match) => normalizeProductHuntUrl(match[0]));
  return dedupeStrings(urls.filter((url): url is string => Boolean(url)));
}

function normalizeProductHuntUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!/(^|\.)producthunt\.com$/i.test(url.hostname)) return null;
    if (!/^\/(products|posts)\/[a-z0-9-]+\/?$/i.test(url.pathname)) return null;
    url.hostname = "www.producthunt.com";
    url.protocol = "https:";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

function candidateLooksRelevant(entity: EntityRef, url: string, _context: string): boolean {
  const name = slugify(entity.name);
  const slug = productHuntSlug(url) ?? "";
  return slug === name || slug.includes(name);
}

function productHuntSlug(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).pathname.split("/").filter(Boolean).at(-1) ?? null;
  } catch {
    return null;
  }
}

function parseProductHuntMetrics(html: string): Record<string, number | null> {
  return {
    upvotes: parseCompactNumber((html.match(/([\d,.]+[KMB]?)\s+upvotes?/i) ?? [])[1]),
    comments: parseCompactNumber((html.match(/([\d,.]+[KMB]?)\s+comments?/i) ?? [])[1])
  };
}

function extractTitle(html: string): string | null {
  return decodeHtml((html.match(/<title[^>]*>(.*?)<\/title>/is) ?? [])[1] ?? (html.match(/property=["']og:title["'][^>]+content=["']([^"']+)/i) ?? [])[1]);
}

function extractDescription(html: string): string | null {
  return decodeHtml(
    (html.match(/name=["']description["'][^>]+content=["']([^"']+)/i) ?? [])[1] ??
      (html.match(/property=["']og:description["'][^>]+content=["']([^"']+)/i) ?? [])[1]
  );
}

function decodeHtml(value: string | undefined): string | null {
  const decoded = String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return decoded || null;
}

function isBlocked(html: string): boolean {
  return /captcha|access denied|forbidden|temporarily blocked|enable javascript|log in to continue/i.test(html);
}

function parseCompactNumber(value: string | undefined): number | null {
  const match = String(value ?? "").replace(/,/g, "").match(/^([\d.]+)\s*([KMB])?/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const suffix = match[2]?.toUpperCase();
  const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
  return Number.isFinite(amount) ? Math.round(amount * multiplier) : null;
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function dedupeByUrl(items: ProfileCandidate[]): ProfileCandidate[] {
  return [...new Map(items.map((item) => [item.url, item])).values()];
}

function dedupeStrings(items: string[]): string[] {
  return [...new Set(items)];
}
