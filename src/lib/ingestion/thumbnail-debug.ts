import type { EvidenceItem, GraphResponse, Platform } from "@/lib/graph/types";

export interface ThumbnailCoverageReport {
  generatedAt: string;
  evidenceRows: number;
  rowsWithThumbnail: number;
  rowsWithRealThumbnail: number;
  rowsWithFallbackThumbnail: number;
  rowsMissingThumbnail: number;
  platformCoverage: ThumbnailPlatformRow[];
  missingExamples: ThumbnailMissingExample[];
  blockedOrFallbackExamples: ThumbnailMissingExample[];
}

export interface ThumbnailPlatformRow {
  platform: Platform;
  evidenceRows: number;
  withThumbnail: number;
  withRealThumbnail: number;
  withFallback: number;
  missing: number;
  thumbnailSources: Record<string, number>;
}

export interface ThumbnailMissingExample {
  id: string;
  platform: Platform;
  companyName: string | null;
  title: string;
  sourceUrl: string;
  thumbnailUrl: string | null;
  thumbnailSource: string | null;
  linkStatus: string | null;
  linkFailureReason: string | null;
}

export function buildThumbnailCoverageReport(graph: GraphResponse): ThumbnailCoverageReport {
  const rows = graph.evidence;
  const withThumbnail = rows.filter((item) => Boolean(item.thumbnailUrl));
  const fallback = rows.filter((item) => isFallbackThumbnail(item.thumbnailUrl));
  const real = withThumbnail.filter((item) => !isFallbackThumbnail(item.thumbnailUrl));
  const missing = rows.filter((item) => !item.thumbnailUrl);

  return {
    generatedAt: new Date().toISOString(),
    evidenceRows: rows.length,
    rowsWithThumbnail: withThumbnail.length,
    rowsWithRealThumbnail: real.length,
    rowsWithFallbackThumbnail: fallback.length,
    rowsMissingThumbnail: missing.length,
    platformCoverage: platforms(rows).map((platform) => platformRow(platform, rows.filter((item) => item.platform === platform))),
    missingExamples: missing.slice(0, 100).map(exampleRow),
    blockedOrFallbackExamples: fallback.slice(0, 100).map(exampleRow)
  };
}

function platformRow(platform: Platform, rows: EvidenceItem[]): ThumbnailPlatformRow {
  const withThumbnail = rows.filter((item) => Boolean(item.thumbnailUrl));
  const fallback = rows.filter((item) => isFallbackThumbnail(item.thumbnailUrl));
  const real = withThumbnail.filter((item) => !isFallbackThumbnail(item.thumbnailUrl));

  return {
    platform,
    evidenceRows: rows.length,
    withThumbnail: withThumbnail.length,
    withRealThumbnail: real.length,
    withFallback: fallback.length,
    missing: rows.length - withThumbnail.length,
    thumbnailSources: countBy(rows, (item) => item.thumbnailSource ?? "none")
  };
}

function exampleRow(item: EvidenceItem): ThumbnailMissingExample {
  return {
    id: item.id,
    platform: item.platform,
    companyName: item.attachedCompanyName ?? null,
    title: item.title ?? item.text,
    sourceUrl: item.sourceUrl,
    thumbnailUrl: item.thumbnailUrl ?? null,
    thumbnailSource: item.thumbnailSource ?? null,
    linkStatus: item.linkStatus ?? null,
    linkFailureReason: item.linkFailureReason ?? null
  };
}

function platforms(rows: EvidenceItem[]): Platform[] {
  return [...new Set(rows.map((item) => item.platform))].sort();
}

export function isFallbackThumbnail(url: string | null | undefined): boolean {
  if (!url) return false;
  const normalized = url.toLowerCase();
  return (
    /^\/evidence-thumbnails\/.+\.svg(?:$|[?#])/.test(normalized) ||
    normalized.includes("generated-preview") ||
    normalized.includes("fallback") ||
    normalized.includes("placeholder")
  );
}

function countBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}
