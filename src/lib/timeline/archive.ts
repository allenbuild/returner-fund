import type { TimelineCompanyIdentity, TimelineClassificationSource } from "./domain";
import type { TimelineWebDiscoveryResult } from "./discovery";
import { classificationSourceFromFetchedPage } from "./discovery";
import { fetchSafeTimelineSource, type SafeSourceFetchResult } from "./safe-fetch";
import { canonicalizeSourceUrl } from "./source-document";

const INTERNET_ARCHIVE_CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx";

export interface TimelineArchiveDiscoveryOptions {
  fetchIndex?: (url: string) => Promise<SafeSourceFetchResult>;
  fetchPage?: (url: string) => Promise<SafeSourceFetchResult>;
  maxCaptures?: number;
  /** Inclusive UTC year bounds. */
  fromYear?: number;
  toYear?: number;
}

interface ArchiveCapture {
  timestamp: string;
  originalUrl: string;
  digest: string | null;
}

/**
 * Uses the Internet Archive's public CDX index and immutable capture URLs.
 * This is deliberately separate from web search: index rows are discovery-only
 * and only the safely fetched archived page can become Timeline evidence.
 */
export async function discoverTimelineHistoricalArchiveSources(
  company: TimelineCompanyIdentity,
  options: TimelineArchiveDiscoveryOptions = {},
): Promise<TimelineWebDiscoveryResult> {
  if (!company.websiteUrl) return empty("no_results");
  const officialUrl = canonicalizeSourceUrl(company.websiteUrl);
  const officialHost = new URL(officialUrl).hostname.replace(/^www\./, "");
  const maxCaptures = clamp(options.maxCaptures ?? 3, 1, 4);
  const fromYear = clamp(options.fromYear ?? 1996, 1996, 2100);
  const toYear = clamp(options.toYear ?? new Date().getUTCFullYear(), fromYear, 2100);
  const indexUrl = archiveIndexUrl(officialHost, fromYear, toYear, maxCaptures * 4);
  const fetchIndex = options.fetchIndex ?? ((url: string) => fetchSafeTimelineSource(url, {
    timeoutMs: 8_000,
    maxBytes: 250_000,
    maxRedirects: 2,
    allowedMimeTypes: ["application/json", "text/plain"],
  }));
  const fetchPage = options.fetchPage ?? ((url: string) => fetchSafeTimelineSource(url, {
    timeoutMs: 10_000,
    maxBytes: 1_000_000,
    maxRedirects: 3,
  }));
  const failures: TimelineWebDiscoveryResult["failures"] = [];
  let captures: ArchiveCapture[];
  try {
    const index = await fetchIndex(indexUrl);
    captures = selectArchiveCaptures(parseCdxCaptures(index.body, officialHost), maxCaptures);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({
      provider: "internet_archive_cdx",
      kind: /429|rate/i.test(message) ? "rate_limited" : "archive_index_failed",
      message,
    });
    return {
      ...empty(/429|rate/i.test(message) ? "rate_limited" : "failed"),
      searchedQueries: [indexUrl],
      failures,
    };
  }
  if (!captures.length) return { ...empty("no_results"), searchedQueries: [indexUrl] };

  const sources: TimelineClassificationSource[] = [];
  let fetchedUrls = 0;
  for (const capture of captures) {
    const captureUrl = archiveCaptureUrl(capture);
    try {
      const fetched = await fetchPage(captureUrl);
      fetchedUrls += 1;
      assertArchiveReplayProvenance(fetched, captureUrl);
      const source = classificationSourceFromFetchedPage(company, fetched, {
        sourceType: "archived_page",
        sourceQualityTier: 1,
        canonicalUrl: captureUrl,
        canonicalSiteUrl: capture.originalUrl,
        identityUrl: capture.originalUrl,
        authorRelationship: "company",
        metadata: {
          archiveProvider: "internet_archive",
          archiveIndexUrl: indexUrl,
          archiveCaptureUrl: captureUrl,
          archiveOriginalUrl: capture.originalUrl,
          archiveCapturedAt: archiveTimestampToIso(capture.timestamp),
          archiveDigest: capture.digest,
          archiveIndexUsedAsEvidence: false,
          searchSnippetUsedAsEvidence: false,
        },
      });
      if (source) sources.push(source);
    } catch (error) {
      failures.push({
        provider: "internet_archive",
        kind: "archive_capture_fetch_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    status: sources.length ? "completed" : fetchedUrls ? "no_results" : "blocked",
    sources,
    searchedQueries: [indexUrl],
    discoveredUrls: captures.length,
    fetchedUrls,
    failures,
  };
}

function archiveIndexUrl(hostname: string, fromYear: number, toYear: number, limit: number): string {
  const url = new URL(INTERNET_ARCHIVE_CDX_ENDPOINT);
  url.searchParams.set("url", `${hostname}/*`);
  url.searchParams.set("output", "json");
  url.searchParams.set("fl", "timestamp,original,statuscode,mimetype,digest");
  url.searchParams.append("filter", "statuscode:200");
  url.searchParams.append("filter", "mimetype:text/html");
  url.searchParams.set("collapse", "digest");
  url.searchParams.set("from", String(fromYear));
  url.searchParams.set("to", String(toYear));
  url.searchParams.set("limit", String(Math.min(limit, 16)));
  url.searchParams.set("sort", "ascending");
  return canonicalizeSourceUrl(url.toString());
}

function parseCdxCaptures(body: string, officialHost: string): ArchiveCapture[] {
  if (Buffer.byteLength(body, "utf8") > 250_000) throw new RangeError("Archive index exceeded the parsing limit.");
  const parsed = JSON.parse(body) as unknown;
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 100) return [];
  const header = parsed[0];
  if (!Array.isArray(header)) return [];
  const fields = header.map(String);
  const timestampIndex = fields.indexOf("timestamp");
  const originalIndex = fields.indexOf("original");
  const statusIndex = fields.indexOf("statuscode");
  const mimeIndex = fields.indexOf("mimetype");
  const digestIndex = fields.indexOf("digest");
  if (timestampIndex < 0 || originalIndex < 0 || statusIndex < 0 || mimeIndex < 0) return [];
  const captures: ArchiveCapture[] = [];
  for (const raw of parsed.slice(1, 100)) {
    if (!Array.isArray(raw)) continue;
    const timestamp = String(raw[timestampIndex] ?? "");
    const original = String(raw[originalIndex] ?? "");
    if (!/^\d{14}$/.test(timestamp) || String(raw[statusIndex]) !== "200"
        || String(raw[mimeIndex]).toLowerCase() !== "text/html") continue;
    try {
      const originalUrl = canonicalizeSourceUrl(original);
      if (new URL(originalUrl).hostname.replace(/^www\./, "") !== officialHost) continue;
      captures.push({
        timestamp,
        originalUrl,
        digest: digestIndex >= 0 && raw[digestIndex] ? String(raw[digestIndex]).slice(0, 160) : null,
      });
    } catch {
      // A malformed/private/cross-site CDX row never becomes a fetch target.
    }
  }
  return captures.sort((left, right) => left.timestamp.localeCompare(right.timestamp)
    || left.originalUrl.localeCompare(right.originalUrl));
}

function selectArchiveCaptures(captures: readonly ArchiveCapture[], limit: number): ArchiveCapture[] {
  if (captures.length <= limit) return [...captures];
  if (limit === 1) return [captures[0]!];
  const selected = new Map<string, ArchiveCapture>();
  for (let index = 0; index < limit; index += 1) {
    const position = Math.round(index * (captures.length - 1) / (limit - 1));
    const capture = captures[position]!;
    selected.set(`${capture.timestamp}:${capture.originalUrl}`, capture);
  }
  return [...selected.values()];
}

function archiveCaptureUrl(capture: ArchiveCapture): string {
  return canonicalizeSourceUrl(`https://web.archive.org/web/${capture.timestamp}id_/${capture.originalUrl}`);
}

function assertArchiveReplayProvenance(fetched: SafeSourceFetchResult, expectedCaptureUrl: string): void {
  let finalUrl: string;
  try {
    finalUrl = canonicalizeSourceUrl(fetched.finalUrl);
  } catch {
    throw new TypeError("Archive capture returned an invalid final replay URL.");
  }
  if (finalUrl !== expectedCaptureUrl) {
    throw new TypeError("Archive capture redirected away from the selected immutable replay URL.");
  }
}

function archiveTimestampToIso(value: string): string {
  const parts = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!parts) throw new TypeError("Archive timestamp is malformed.");
  const [, year, month, day, hour, minute, second] = parts;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`);
  if (Number.isNaN(date.valueOf())) throw new TypeError("Archive timestamp is invalid.");
  return date.toISOString();
}

function empty(status: TimelineWebDiscoveryResult["status"]): TimelineWebDiscoveryResult {
  return { status, sources: [], searchedQueries: [], discoveredUrls: 0, fetchedUrls: 0, failures: [] };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.floor(value), minimum), maximum);
}
