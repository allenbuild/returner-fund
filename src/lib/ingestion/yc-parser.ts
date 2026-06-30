import * as cheerio from "cheerio";
import type {
  SourceReliability,
  SourceEvidence,
  YcCompanyRecord,
  YcFounderRecord,
  YcSearchResult
} from "./types";

export function normalizeBatchSlug(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/^YC\s+/, "").replace(/\s+/g, " ");
  const compactMatch = cleaned.match(/\b([SW])\s*(20\d{2})\b/);
  if (compactMatch) return `${compactMatch[1]}${compactMatch[2]}`;

  const seasonMatch = cleaned.match(/\b(SPRING|SUMMER|WINTER)\s+(20\d{2})\b/);
  if (seasonMatch) return `${seasonMatch[1] === "WINTER" ? "W" : "S"}${seasonMatch[2]}`;

  return cleaned.replace(/\s+/g, "");
}

export function batchSlugToLabel(batchSlug: string): string {
  const normalized = normalizeBatchSlug(batchSlug);
  const match = normalized.match(/^([SW])(20\d{2})$/);
  if (!match) return normalized;
  return `${match[1] === "S" ? "Spring" : "Winter"} ${match[2]}`;
}

export function reviewStateForSourceReliability(sourceReliability: SourceReliability) {
  return sourceReliability === "high" ? "verified" : "needs_review";
}

export function sourceEvidence(args: {
  url: string;
  title?: string | null;
  snippet?: string | null;
  sourceReliability: SourceReliability;
}): SourceEvidence {
  return {
    url: args.url,
    title: args.title ?? null,
    snippet: args.snippet ?? null,
    sourceReliability: args.sourceReliability,
    extractedAt: new Date().toISOString()
  };
}

export function parseYcCompaniesFromHtml(html: string, batchSlugInput: string, sourceUrl: string): YcCompanyRecord[] {
  const batchSlug = normalizeBatchSlug(batchSlugInput);
  const $ = cheerio.load(html);
  const records: YcCompanyRecord[] = [];

  $("script[type='application/ld+json'], script#__NEXT_DATA__").each((_, script) => {
    const raw = $(script).text();
    for (const json of parseJsonFragments(raw)) {
      records.push(...extractCompanyRecords(json, batchSlug, sourceUrl, "high"));
    }
  });

  $("a[href*='/companies/']").each((_, anchor) => {
    const href = $(anchor).attr("href");
    const name = $(anchor).text().replace(/\s+/g, " ").trim();
    if (!href || !name || name.length > 120) return;

    const containerText = $(anchor).closest("article, li, div").text().replace(/\s+/g, " ").trim();
    if (!textMatchesBatch(containerText, batchSlug) && /(?:Summer|Winter)\s+20\d{2}|\b[SW]20\d{2}\b/i.test(containerText)) {
      return;
    }

    records.push(
      createCompanyRecord({
        name,
        batchSlug,
        ycProfileUrl: absoluteUrl(href, sourceUrl),
        websiteUrl: null,
        tagline: null,
        description: null,
        industries: [],
        founders: [],
        groupPartner: null,
        sourceReliability: "medium",
        sourceUrl,
        sourceTitle: "YC directory HTML link",
        sourceSnippet: containerText.slice(0, 300),
        warnings: ["Record parsed from HTML link/card; missing fields need profile-page enrichment."]
      })
    );
  });

  return dedupeCompanies(records);
}

export function parseYcFallbackResults(results: YcSearchResult[], batchSlugInput: string): YcCompanyRecord[] {
  const batchSlug = normalizeBatchSlug(batchSlugInput);
  const records = results
    .map((result) => fallbackResultToRecord(result, batchSlug))
    .filter((record): record is YcCompanyRecord => Boolean(record));
  return dedupeCompanies(records);
}

export function extractCompanyRecords(
  value: unknown,
  batchSlug: string,
  sourceUrl: string,
  sourceReliability: SourceReliability
): YcCompanyRecord[] {
  const records: YcCompanyRecord[] = [];
  walkJson(value, (candidate) => {
    const record = coerceCompanyRecord(candidate, batchSlug, sourceUrl, sourceReliability);
    if (record) records.push(record);
  });
  return dedupeCompanies(records);
}

function fallbackResultToRecord(result: YcSearchResult, batchSlug: string): YcCompanyRecord | null {
  const mentionsYc = /y\s*combinator|yc\b/i.test(`${result.title} ${result.snippet} ${result.url}`);
  const mentionsBatch = textMatchesBatch(`${result.title} ${result.snippet}`, batchSlug);
  if (!mentionsYc && !result.url.includes("ycombinator.com/companies")) return null;

  const name = cleanCompanyNameFromTitle(result.title);
  if (!name) return null;

  const sourceReliability: SourceReliability =
    result.url.includes("ycombinator.com/companies") && mentionsBatch ? "medium" : "low";
  return createCompanyRecord({
    name,
    batchSlug,
    ycProfileUrl: result.url.includes("ycombinator.com/companies") ? result.url : null,
    websiteUrl: null,
    tagline: null,
    description: result.snippet || null,
    industries: [],
    founders: [],
    groupPartner: null,
    sourceReliability,
    sourceUrl: result.url,
    sourceTitle: result.title,
    sourceSnippet: result.snippet,
    warnings: [
      "Fallback search result requires review before canonical use.",
      "Founder, industry, website, and group partner data were not inferred from search text."
    ]
  });
}

function coerceCompanyRecord(
  raw: Record<string, unknown>,
  batchSlug: string,
  sourceUrl: string,
  sourceReliability: SourceReliability
): YcCompanyRecord | null {
  const name = firstString(raw, ["name", "companyName", "company_name", "title"]);
  if (!name || name.length > 160) return null;

  const rawBatch = firstString(raw, ["batch", "batchName", "batch_name", "ycBatch"]);
  if (rawBatch && normalizeBatchSlug(rawBatch) !== batchSlug) return null;

  const ycProfileUrl =
    firstUrl(raw, ["ycProfileUrl", "yc_profile_url", "absoluteUrl", "url"]) ??
    (firstString(raw, ["slug"]) ? `https://www.ycombinator.com/companies/${firstString(raw, ["slug"])}` : null);
  const websiteUrl = firstUrl(raw, ["websiteUrl", "website_url", "website", "companyUrl", "company_url"]);
  const tagline = firstString(raw, ["tagline", "oneLiner", "one_liner", "shortDescription"]);
  const description = firstString(raw, ["description", "longDescription", "long_description"]);
  const industries = arrayOfStrings(raw.industries ?? raw.tags ?? raw.markets);
  const founders = parseFounders(raw.founders ?? raw.founderNames ?? raw.founder_names, sourceUrl, sourceReliability);
  const groupPartner = firstString(raw, ["groupPartner", "group_partner"]);
  const source = sourceEvidence({
    url: sourceUrl,
    title: "YC structured payload",
    snippet: tagline ?? description ?? null,
    sourceReliability
  });

  return {
    name,
    batchSlug,
    ycProfileUrl,
    websiteUrl,
    tagline,
    description,
    industries,
    founders,
    groupPartner: groupPartner ?? null,
    sourceReliability,
    sources: [source],
    review_state: reviewStateForSourceReliability(sourceReliability),
    warnings: groupPartner ? [] : ["Group partner is null because no reliable source field was present."]
  };
}

function parseFounders(raw: unknown, sourceUrl: string, sourceReliability: SourceReliability): YcFounderRecord[] {
  const source = sourceEvidence({ url: sourceUrl, title: "YC founder payload", sourceReliability });
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === "string") {
          return founderRecord(item, null, null, sourceReliability, source);
        }
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          const name = firstString(obj, ["name", "fullName", "full_name"]);
          if (!name) return null;
          return founderRecord(
            name,
            firstUrl(obj, ["ycProfileUrl", "yc_profile_url", "url"]),
            firstUrl(obj, ["personalWebsiteUrl", "personal_website_url", "website"]),
            sourceReliability,
            source
          );
        }
        return null;
      })
      .filter((founder): founder is YcFounderRecord => Boolean(founder));
  }
  if (typeof raw === "string") {
    return raw
      .split(/,| and /)
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => founderRecord(name, null, null, sourceReliability, source));
  }
  return [];
}

function founderRecord(
  name: string,
  ycProfileUrl: string | null,
  personalWebsiteUrl: string | null,
  sourceReliability: SourceReliability,
  source: SourceEvidence
): YcFounderRecord {
  return {
    name,
    ycProfileUrl,
    personalWebsiteUrl,
    sourceReliability,
    sources: [source],
    review_state: reviewStateForSourceReliability(sourceReliability)
  };
}

function createCompanyRecord(args: {
  name: string;
  batchSlug: string;
  ycProfileUrl: string | null;
  websiteUrl: string | null;
  tagline: string | null;
  description: string | null;
  industries: string[];
  founders: YcFounderRecord[];
  groupPartner: string | null;
  sourceReliability: SourceReliability;
  sourceUrl: string;
  sourceTitle: string;
  sourceSnippet?: string | null;
  warnings: string[];
}): YcCompanyRecord {
  const source = sourceEvidence({
    url: args.sourceUrl,
    title: args.sourceTitle,
    snippet: args.sourceSnippet ?? null,
    sourceReliability: args.sourceReliability
  });
  return {
    name: args.name,
    batchSlug: args.batchSlug,
    ycProfileUrl: args.ycProfileUrl,
    websiteUrl: args.websiteUrl,
    tagline: args.tagline,
    description: args.description,
    industries: args.industries,
    founders: args.founders,
    groupPartner: args.groupPartner,
    sourceReliability: args.sourceReliability,
    sources: [source],
    review_state: reviewStateForSourceReliability(args.sourceReliability),
    warnings: args.groupPartner ? args.warnings : [...args.warnings, "Group partner is null; do not infer it."]
  };
}

function dedupeCompanies(records: YcCompanyRecord[]): YcCompanyRecord[] {
  const byKey = new Map<string, YcCompanyRecord>();
  for (const record of records) {
    const key = (record.ycProfileUrl ?? record.name).toLowerCase();
    const existing = byKey.get(key);
    if (!existing || reliabilityRank(record.sourceReliability) > reliabilityRank(existing.sourceReliability)) {
      byKey.set(key, record);
    }
  }
  return [...byKey.values()];
}

function reliabilityRank(sourceReliability: SourceReliability): number {
  return sourceReliability === "high" ? 3 : sourceReliability === "medium" ? 2 : 1;
}

function parseJsonFragments(raw: string): unknown[] {
  try {
    return [JSON.parse(raw)];
  } catch {
    return [];
  }
}

function walkJson(value: unknown, visit: (candidate: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item) => walkJson(item, visit));
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (looksLikeCompanyObject(object)) visit(object);
  Object.values(object).forEach((child) => walkJson(child, visit));
}

function looksLikeCompanyObject(object: Record<string, unknown>): boolean {
  const hasName = firstString(object, ["name", "companyName", "company_name", "title"]);
  const hasCompanySignal =
    firstString(object, ["batch", "batchName", "batch_name", "ycBatch"]) ||
    firstString(object, ["slug"]) ||
    firstString(object, ["tagline", "oneLiner", "one_liner"]) ||
    Array.isArray(object.founders);
  return Boolean(hasName && hasCompanySignal);
}

function firstString(object: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstUrl(object: Record<string, unknown>, keys: string[]): string | null {
  const value = firstString(object, keys);
  if (!value) return null;
  if (value.startsWith("/")) return `https://www.ycombinator.com${value}`;
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function arrayOfStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => {
      if (typeof value === "string") return value.trim();
      if (value && typeof value === "object") {
        return firstString(value as Record<string, unknown>, ["name", "title"]);
      }
      return null;
    })
    .filter((value): value is string => Boolean(value));
}

function textMatchesBatch(text: string, batchSlug: string): boolean {
  const label = batchSlugToLabel(batchSlug);
  const legacySummerLabel = batchSlug.startsWith("S") ? `Summer ${batchSlug.slice(1)}` : null;
  const labels = [label, legacySummerLabel].filter(Boolean).map((value) => escapeRegex(value as string));
  return new RegExp(
    `\\b${escapeRegex(batchSlug)}\\b|\\bYC\\s+${escapeRegex(batchSlug)}\\b|${labels
      .map((value) => `\\b${value}\\b`)
      .join("|")}`,
    "i"
  ).test(text);
}

function absoluteUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function cleanCompanyNameFromTitle(title: string): string | null {
  const cleaned = title
    .replace(/\s*\|\s*Y\s*Combinator.*$/i, "")
    .replace(/\s*-\s*Y\s*Combinator.*$/i, "")
    .replace(/\s*\|\s*Product Hunt.*$/i, "")
    .trim();
  return cleaned.length > 0 && cleaned.length < 120 ? cleaned : null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
