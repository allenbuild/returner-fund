import { load } from "cheerio";
import { canonicalizeSourceUrl, sanitizeEvidenceExcerpt } from "./source-document";

const MAX_JSON_LD_SCRIPTS = 20;
const MAX_JSON_LD_SCRIPT_BYTES = 100_000;
const MAX_JSON_LD_NODES = 200;

export interface TimelinePageMetadata {
  title: string | null;
  publisher: string | null;
  author: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  canonicalUrl: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Extracts inert, bounded page metadata. JSON-LD is parsed as JSON only (never
 * evaluated), and an embedded canonical is accepted only on the expected site.
 */
export function extractTimelinePageMetadata(
  body: string,
  finalUrl: string,
  canonicalSiteUrl: string = finalUrl,
): TimelinePageMetadata {
  const $ = load(body);
  const jsonLd = extractJsonLd($);
  const canonicalCandidate = clean($("link[rel~='canonical']").first().attr("href"))
    ?? clean($("meta[property='og:url']").first().attr("content"));
  const canonicalUrl = resolveSameSiteCanonical(canonicalCandidate, canonicalSiteUrl);
  const title = clean($("meta[property='og:title']").first().attr("content"))
    ?? clean(jsonLd.headline)
    ?? clean($("title").first().text());
  const publisher = clean($("meta[property='og:site_name']").first().attr("content"))
    ?? clean(jsonLd.publisher);
  const author = clean($("meta[name='author']").first().attr("content"))
    ?? clean($("meta[property='article:author']").first().attr("content"))
    ?? clean(jsonLd.author);
  const publishedAt = firstExactTimestamp([
    $("meta[property='article:published_time']").first().attr("content"),
    $("meta[name='date']").first().attr("content"),
    $("meta[name='pubdate']").first().attr("content"),
    jsonLd.datePublished,
    $("time[datetime]").first().attr("datetime"),
  ]);
  const updatedAt = firstExactTimestamp([
    $("meta[property='article:modified_time']").first().attr("content"),
    $("meta[name='last-modified']").first().attr("content"),
    jsonLd.dateModified,
  ]);

  return {
    title,
    publisher,
    author,
    publishedAt,
    updatedAt,
    canonicalUrl,
    metadata: {
      pageCanonicalUrl: canonicalUrl,
      canonicalCandidatePresent: Boolean(canonicalCandidate),
      canonicalCandidateAccepted: Boolean(canonicalUrl),
      jsonLdTypes: jsonLd.types,
      jsonLdAuthor: clean(jsonLd.author),
      jsonLdPublisher: clean(jsonLd.publisher),
      jsonLdPublishedAt: firstExactTimestamp([jsonLd.datePublished]),
      jsonLdUpdatedAt: firstExactTimestamp([jsonLd.dateModified]),
      openGraphTitle: clean($("meta[property='og:title']").first().attr("content")),
      openGraphSiteName: clean($("meta[property='og:site_name']").first().attr("content")),
    },
  };
}

interface JsonLdSummary {
  headline: string | null;
  author: string | null;
  publisher: string | null;
  datePublished: string | null;
  dateModified: string | null;
  types: string[];
}

function extractJsonLd($: ReturnType<typeof load>): JsonLdSummary {
  const summary: JsonLdSummary = {
    headline: null,
    author: null,
    publisher: null,
    datePublished: null,
    dateModified: null,
    types: [],
  };
  let visited = 0;
  $("script[type='application/ld+json']").slice(0, MAX_JSON_LD_SCRIPTS).each((_index, element) => {
    const raw = $(element).text().trim();
    if (!raw || Buffer.byteLength(raw, "utf8") > MAX_JSON_LD_SCRIPT_BYTES) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const queue: unknown[] = [parsed];
    while (queue.length && visited < MAX_JSON_LD_NODES) {
      const value = queue.shift();
      visited += 1;
      if (Array.isArray(value)) {
        queue.push(...value.slice(0, 50));
        continue;
      }
      if (!isRecord(value)) continue;
      if (Array.isArray(value["@graph"])) queue.push(...value["@graph"].slice(0, 50));
      const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
      for (const type of types) {
        if (typeof type === "string" && !summary.types.includes(type)) summary.types.push(type.slice(0, 80));
      }
      summary.headline ??= scalarName(value.headline) ?? scalarName(value.name);
      summary.author ??= scalarName(value.author);
      summary.publisher ??= scalarName(value.publisher);
      summary.datePublished ??= scalarName(value.datePublished);
      summary.dateModified ??= scalarName(value.dateModified);
    }
  });
  summary.types = summary.types.sort().slice(0, 20);
  return summary;
}

function scalarName(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(scalarName).filter((item): item is string => Boolean(item)).join(", ") || null;
  }
  if (!isRecord(value)) return null;
  return typeof value.name === "string" ? value.name : null;
}

function resolveSameSiteCanonical(candidate: string | null, canonicalSiteUrl: string): string | null {
  if (!candidate) return null;
  try {
    const base = new URL(canonicalizeSourceUrl(canonicalSiteUrl));
    const resolved = canonicalizeSourceUrl(new URL(candidate, base).toString());
    const resolvedHost = new URL(resolved).hostname.replace(/^www\./, "");
    const expectedHost = base.hostname.replace(/^www\./, "");
    return resolvedHost === expectedHost ? resolved : null;
  } catch {
    return null;
  }
}

function firstExactTimestamp(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const date = new Date(`${trimmed}T00:00:00.000Z`);
      if (!Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === trimmed) return date.toISOString();
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}(?:T|\s)\d{2}:\d{2}/.test(trimmed)) continue;
    const date = new Date(trimmed);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return null;
}

function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = sanitizeEvidenceExcerpt(value, 300);
  return normalized || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
