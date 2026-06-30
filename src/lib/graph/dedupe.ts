import type { EvidenceItem } from "./types";

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|igshid$|mc_|ref$|ref_src$|s$|t$)/i;

export function canonicalEvidenceKey(item: EvidenceItem): string {
  if (item.platformPostId) {
    return `${item.platform}:post:${normalizeKeyPart(item.platformPostId)}`;
  }

  const canonicalUrl = canonicalEvidenceUrl(item.sourceUrl);
  if (canonicalUrl) {
    return `${item.platform}:url:${canonicalUrl}`;
  }

  const accountPart = item.canonicalAccountId ?? item.socialAccountId ?? item.authorHandle ?? item.authorName;
  return `${item.platform}:fallback:${normalizeKeyPart(accountPart)}:${fallbackEvidenceKey(item)}`;
}

export function canonicalEvidenceUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    if (url.hostname === "twitter.com" || url.hostname === "mobile.twitter.com") {
      url.hostname = "x.com";
    }

    if (url.hostname === "x.com") {
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
      if (match) {
        url.pathname = `/${match[1].toLowerCase()}/status/${match[2]}`;
        url.search = "";
      }
    }

    if (url.hostname === "instagram.com") {
      const match = url.pathname.match(/^\/(p|reel|tv)\/([^/]+)/i);
      if (match) {
        url.pathname = `/${match[1].toLowerCase()}/${match[2]}`;
        url.search = "";
      }
    }

    if (url.hostname.endsWith("linkedin.com")) {
      url.search = "";
      url.pathname = url.pathname.replace(/\/$/, "");
    }

    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return "";
  }
}

export function dedupeEvidenceItems<T extends EvidenceItem>(items: T[]): T[] {
  const byKey = new Map<string, T>();

  for (const item of items) {
    const key = canonicalEvidenceKey(item);
    const existing = byKey.get(key);
    if (!existing || shouldReplaceEvidence(existing, item)) {
      byKey.set(key, item);
    }
  }

  return [...byKey.values()];
}

function fallbackEvidenceKey(item: EvidenceItem): string {
  return `${item.authorName}:${item.text}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function shouldReplaceEvidence(existing: EvidenceItem, candidate: EvidenceItem): boolean {
  const existingFreshness = evidenceFreshness(existing);
  const candidateFreshness = evidenceFreshness(candidate);

  if (candidateFreshness !== existingFreshness) {
    return candidateFreshness > existingFreshness;
  }

  return evidenceRank(candidate) > evidenceRank(existing);
}

function evidenceFreshness(item: EvidenceItem): number {
  return Math.max(
    parseDateMs(item.last_checked_at),
    parseDateMs(item.last_updated_at),
    parseDateMs(item.first_seen_at),
    parseDateMs(item.postedAt)
  );
}

function parseDateMs(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function evidenceRank(item: EvidenceItem): number {
  const metricTotal = Object.values(item.metrics).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return item.contributionScore * 1_000_000 + metricTotal;
}

function normalizeKeyPart(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
