import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { TimelineCompanyIdentity, TimelineClassificationSource } from "./domain";
import { fetchSafeTimelineSource, type SafeSourceFetchResult } from "./safe-fetch";
import { createConfiguredTimelineSearchProviders, type TimelineSearchProvider } from "./search";
import { canonicalizeSourceUrl, sanitizeEvidenceExcerpt } from "./source-document";
import { extractTimelinePageMetadata } from "./page-metadata";
import type { TimelineSourceCoverageState } from "./contracts";
import type { TimelineSourceType } from "./contracts";

export interface TimelineWebDiscoveryOptions {
  providers?: readonly TimelineSearchProvider[];
  queries?: readonly string[];
  maxQueries?: number;
  maxResultsPerQuery?: number;
  maxFetchedPages?: number;
  fetchPage?: (url: string) => Promise<SafeSourceFetchResult>;
  signal?: AbortSignal;
}

export interface TimelineWebDiscoveryResult {
  status: Extract<TimelineSourceCoverageState, "completed" | "no_results" | "rate_limited" | "authentication_required" | "blocked" | "failed">;
  sources: TimelineClassificationSource[];
  searchedQueries: string[];
  discoveredUrls: number;
  fetchedUrls: number;
  failures: Array<{ provider: string; kind: string; message: string }>;
}

export interface TimelineDirectDiscoveryOptions {
  fetchPage?: (url: string) => Promise<SafeSourceFetchResult>;
  discoveryMethod: string;
  maxUrls?: number;
  sourceType?: TimelineSourceType;
  sourceQualityTier?: 1 | 2 | 3;
  /** Bounded same-domain announcement/blog links discovered from seed pages. */
  followInternalLinks?: number;
}

/**
 * Fetch a bounded list of already-known public URLs. This is used for the
 * company's official site and institutional profile. It deliberately shares
 * the same SSRF-safe fetch and page extraction path as search discovery; no
 * caller-supplied snippet can become evidence.
 */
export async function discoverTimelineDirectSources(
  company: TimelineCompanyIdentity,
  urls: readonly string[],
  options: TimelineDirectDiscoveryOptions,
): Promise<TimelineWebDiscoveryResult> {
  const fetchPage = options.fetchPage ?? ((url: string) => fetchSafeTimelineSource(url));
  const candidates = [...new Set(urls.filter(Boolean).map(canonicalizeSourceUrl))]
    .sort()
    .slice(0, clamp(options.maxUrls ?? 1, 1, 4));
  if (!candidates.length) {
    return { status: "no_results", sources: [], searchedQueries: [], discoveredUrls: 0, fetchedUrls: 0, failures: [] };
  }

  const sources: TimelineClassificationSource[] = [];
  const failures: TimelineWebDiscoveryResult["failures"] = [];
  let fetchedUrls = 0;
  const queue = [...candidates];
  const seen = new Set(queue);
  const followLimit = clamp(options.followInternalLinks ?? 0, 0, 8);
  for (let index = 0; index < queue.length && index < candidates.length + followLimit; index += 1) {
    const url = queue[index]!;
    try {
      const fetched = await fetchPage(url);
      fetchedUrls += 1;
      if (index < candidates.length && followLimit > 0) {
        for (const discoveredUrl of discoverInternalTimelineLinks(fetched).slice(0, followLimit)) {
          if (seen.has(discoveredUrl)) continue;
          seen.add(discoveredUrl);
          queue.push(discoveredUrl);
        }
      }
      const source = classificationSourceFromFetchedPage(company, fetched, {
        sourceType: options.sourceType,
        sourceQualityTier: options.sourceQualityTier,
      });
      if (source) sources.push(source);
    } catch (error) {
      failures.push({
        provider: options.discoveryMethod,
        kind: "fetch_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    status: sources.length ? "completed" : fetchedUrls ? "no_results" : "blocked",
    sources,
    searchedQueries: [],
    discoveredUrls: queue.length,
    fetchedUrls,
    failures,
  };
}

function discoverInternalTimelineLinks(fetched: SafeSourceFetchResult): string[] {
  const base = new URL(fetched.finalUrl);
  const $ = load(fetched.body);
  const links = new Set<string>();
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    const label = clean($(element).text()) ?? "";
    if (!href || !/\b(?:blog|news|press|launch|release|changelog|updates?|announcements?|funding|about)\b/i.test(`${href} ${label}`)) return;
    try {
      const resolved = new URL(href, base);
      if (resolved.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) return;
      links.add(canonicalizeSourceUrl(resolved.toString()));
    } catch {
      // An invalid or unsafe anchor is not a discovery candidate.
    }
  });
  return [...links].sort();
}

export async function discoverTimelineWebSources(
  company: TimelineCompanyIdentity,
  options: TimelineWebDiscoveryOptions = {},
): Promise<TimelineWebDiscoveryResult> {
  const providers = [...(options.providers ?? createConfiguredTimelineSearchProviders())];
  if (!providers.length) {
    return { status: "authentication_required", sources: [], searchedQueries: [], discoveredUrls: 0, fetchedUrls: 0, failures: [] };
  }
  const queries = [...new Set((options.queries ?? timelineDiscoveryQueries(company))
    .map((query) => query.trim()).filter(Boolean))]
    .slice(0, clamp(options.maxQueries ?? 2, 1, 4));
  const maxResults = clamp(options.maxResultsPerQuery ?? 5, 1, 10);
  const maxFetched = clamp(options.maxFetchedPages ?? 8, 1, 20);
  const failures: TimelineWebDiscoveryResult["failures"] = [];
  const discovered = new Map<string, { provider: string }>();

  for (const provider of providers) {
    for (const query of queries) {
      try {
        const results = await provider.search({ query, companyId: company.id, limit: maxResults }, options.signal);
        for (const result of results) {
          // Search snippets are intentionally discarded here. Only the safely
          // fetched source page below can become evidence.
          discovered.set(canonicalizeSourceUrl(result.url), { provider: provider.id });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ provider: provider.id, kind: /429|rate/i.test(message) ? "rate_limited" : "search_failed", message });
      }
    }
  }
  if (!discovered.size) {
    return {
      status: failures.some((item) => item.kind === "rate_limited") ? "rate_limited" : failures.length ? "failed" : "no_results",
      sources: [], searchedQueries: queries, discoveredUrls: 0, fetchedUrls: 0, failures,
    };
  }

  const fetchPage = options.fetchPage ?? ((url: string) => fetchSafeTimelineSource(url));
  const sources: TimelineClassificationSource[] = [];
  let fetchedUrls = 0;
  for (const [url, discovery] of [...discovered.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(0, maxFetched)) {
    try {
      const fetched = await fetchPage(url);
      fetchedUrls += 1;
      const source = classificationSourceFromFetchedPage(company, fetched);
      if (source) sources.push(source);
    } catch (error) {
      failures.push({ provider: discovery.provider, kind: "fetch_failed", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    status: sources.length ? "completed" : fetchedUrls ? "no_results" : "blocked",
    sources,
    searchedQueries: queries,
    discoveredUrls: discovered.size,
    fetchedUrls,
    failures,
  };
}

export function timelineDiscoveryQueries(company: TimelineCompanyIdentity): string[] {
  const identityTerms = [`"${company.name}"`, company.websiteUrl ? `site:${new URL(company.websiteUrl).hostname}` : ""]
    .filter(Boolean).join(" ");
  const founderTerms = company.founderNames.slice(0, 2).map((name) => `"${name}"`).join(" OR ");
  return [
    `${identityTerms} (launched OR released OR raised OR funding OR customer OR partnership OR acquired OR pivoted OR shutdown)`,
    `${identityTerms}${founderTerms ? ` (${founderTerms})` : ""} (founded OR accelerator OR milestone OR revenue OR users)`,
  ];
}

export function classificationSourceFromFetchedPage(
  company: TimelineCompanyIdentity,
  fetched: SafeSourceFetchResult,
  overrides: {
    sourceType?: TimelineSourceType;
    sourceQualityTier?: 1 | 2 | 3;
    canonicalUrl?: string;
    canonicalSiteUrl?: string;
    identityUrl?: string;
    authorRelationship?: TimelineClassificationSource["authorRelationship"];
    metadata?: Record<string, unknown>;
  } = {},
): TimelineClassificationSource | null {
  const $ = load(fetched.body);
  const pageMetadata = extractTimelinePageMetadata(
    fetched.body,
    fetched.finalUrl,
    overrides.canonicalSiteUrl ?? fetched.finalUrl,
  );
  $("script,style,noscript,template,svg").remove();
  const title = pageMetadata.title;
  const text = sanitizeEvidenceExcerpt($("main,article,body").first().text(), 20_000);
  if (!title || text.length < 40 || !matchesCompany(company, title, text, overrides.identityUrl ?? fetched.finalUrl)) return null;
  const published = pageMetadata.publishedAt;
  const officialDomain = company.websiteUrl ? new URL(company.websiteUrl).hostname.replace(/^www\./, "") : null;
  const identityDomain = new URL(overrides.identityUrl ?? fetched.finalUrl).hostname.replace(/^www\./, "");
  const sourceType = overrides.sourceType ?? (officialDomain === identityDomain ? "company_page" : "news_article");
  const authorRelationship = overrides.authorRelationship
    ?? (officialDomain === identityDomain ? "company" : "third_party");
  const canonicalUrl = overrides.canonicalUrl ?? pageMetadata.canonicalUrl ?? fetched.finalUrl;
  return {
    id: `web-${createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 24)}`,
    url: fetched.finalUrl,
    originalUrl: fetched.originalUrl,
    canonicalUrl,
    title,
    publisher: pageMetadata.publisher || identityDomain,
    author: pageMetadata.author,
    sourceType,
    platform: "web",
    publicationTimestamp: published,
    updatedTimestamp: pageMetadata.updatedAt,
    publicationDatePrecision: published ? "exact" : "unknown",
    text,
    evidenceExcerpt: sanitizeEvidenceExcerpt(text, 600),
    sourceQualityTier: overrides.sourceQualityTier ?? (officialDomain === identityDomain ? 1 : 2),
    attributionStatus: "verified",
    linkStatus: "verified",
    topic: null,
    authorRelationship,
    httpStatus: fetched.status,
    metadata: {
      ...pageMetadata.metadata,
      requestedUrl: fetched.originalUrl,
      finalUrl: fetched.finalUrl,
      redirects: fetched.redirects.slice(0, 5),
      fetchedAt: fetched.fetchedAt,
      httpStatus: fetched.status,
      contentType: fetched.contentType,
      pageUpdatedAt: pageMetadata.updatedAt,
      ...overrides.metadata,
    },
  };
}

function matchesCompany(company: TimelineCompanyIdentity, title: string, text: string, url: string): boolean {
  const domain = new URL(url).hostname.replace(/^www\./, "");
  if (company.websiteUrl && domain === new URL(company.websiteUrl).hostname.replace(/^www\./, "")) return true;
  const haystack = `${title} ${text.slice(0, 8_000)}`;
  return [company.name, ...company.aliases].some((alias) => hasExactIdentity(haystack, alias))
    && (company.founderNames.some((name) => hasExactIdentity(haystack, name))
      || /\b(?:launched|launch|released|raised|funding|founded|accepted|joined|accelerator|customer|partnership|acquired|pivoted|shutdown)\b/i.test(haystack));
}

function hasExactIdentity(value: string, identity: string): boolean {
  const normalize = (input: string) => input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const normalizedValue = normalize(value);
  const normalizedIdentity = normalize(identity);
  if (normalizedIdentity.replace(/\s+/g, "").length < 3) return false;
  const tokens = new Set(normalizedValue.split(" ").filter(Boolean));
  return ` ${normalizedValue} `.includes(` ${normalizedIdentity} `)
    || tokens.has(normalizedIdentity.replace(/\s+/g, ""));
}

function clean(value: string | undefined): string | null {
  const normalized = value?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 300) : null;
}
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(Math.max(value, minimum), maximum); }
