import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isPrivateOrReservedAddress } from "./network-address";

const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref_src",
  "ref_url",
  "igshid",
  "si",
]);

export interface NormalizedSourceDocumentInput {
  originalUrl: string;
  canonicalUrl?: string | null;
  title: string;
  publisher?: string | null;
  author?: string | null;
  sourceType: string;
  publishedAt?: string | null;
  fetchedAt: string;
  text?: string | null;
  excerpt?: string | null;
  metadata?: Record<string, unknown>;
  discoveryMethod: string;
  sourceQualityTier: 1 | 2 | 3;
}

export interface NormalizedSourceDocument {
  originalUrl: string;
  canonicalUrl: string;
  domain: string;
  title: string;
  publisher: string | null;
  author: string | null;
  sourceType: string;
  publishedAt: string | null;
  fetchedAt: string;
  normalizedText: string | null;
  excerpt: string | null;
  metadata: Record<string, unknown>;
  discoveryMethod: string;
  sourceQualityTier: 1 | 2 | 3;
  contentHash: string;
}

export function canonicalizeSourceUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Timeline sources must use http or https.");
  }
  if (url.username || url.password) {
    throw new TypeError("Timeline source URLs must not contain credentials.");
  }

  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  assertPublicSourceHostname(url.hostname);
  url.hash = "";
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }

  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.startsWith("utm_") || TRACKING_PARAMETERS.has(normalizedKey)) {
      url.searchParams.delete(key);
    }
  }

  const sorted = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
  );
  url.search = "";
  for (const [key, item] of sorted) url.searchParams.append(key, item);

  // Internet Archive replay URLs intentionally embed an absolute original URL
  // in the path. Collapsing that embedded `://` would silently retarget the
  // evidence URL; ordinary paths still receive duplicate-slash cleanup.
  const archiveReplay = url.hostname === "web.archive.org"
    && /^\/web\/\d{14}(?:id_|if_)?\/https?:\/\//i.test(url.pathname);
  if (!archiveReplay) url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

export function normalizeSourceText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeEvidenceExcerpt(value: string, maxLength = 600): string {
  const normalized = normalizeSourceText(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).replace(/\s+\S*$/, "")}…`;
}

export function sourceContentHash(value: string): string {
  return createHash("sha256").update(normalizeSourceText(value), "utf8").digest("hex");
}

export function normalizeSourceDocument(input: NormalizedSourceDocumentInput): NormalizedSourceDocument {
  const originalUrl = canonicalizeSourceUrl(input.originalUrl);
  const canonicalUrl = canonicalizeSourceUrl(input.canonicalUrl ?? input.originalUrl);
  const normalizedText = input.text ? normalizeSourceText(input.text) : null;
  const excerptSource = input.excerpt ?? normalizedText;
  const excerpt = excerptSource ? sanitizeEvidenceExcerpt(excerptSource) : null;
  const title = sanitizeEvidenceExcerpt(input.title, 300);
  if (!title) throw new TypeError("Source title cannot be empty.");

  return {
    originalUrl,
    canonicalUrl,
    domain: new URL(canonicalUrl).hostname,
    title,
    publisher: input.publisher ? sanitizeEvidenceExcerpt(input.publisher, 160) : null,
    author: input.author ? sanitizeEvidenceExcerpt(input.author, 160) : null,
    sourceType: input.sourceType,
    publishedAt: input.publishedAt ?? null,
    fetchedAt: input.fetchedAt,
    normalizedText,
    excerpt,
    metadata: redactSensitiveMetadata(input.metadata ?? {}),
    discoveryMethod: input.discoveryMethod,
    sourceQualityTier: input.sourceQualityTier,
    contentHash: sourceContentHash(normalizedText ?? `${title}\n${canonicalUrl}`),
  };
}

function redactSensitiveMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const budget = { keys: 0 };
  const result = redactMetadataValue(metadata, 0, budget);
  return result && !Array.isArray(result) && typeof result === "object" ? result as Record<string, unknown> : {};
}

function redactMetadataValue(value: unknown, depth: number, budget: { keys: number }): unknown {
  if (depth > 6 || budget.keys >= 200) return undefined;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length <= 10_000 ? value : `${value.slice(0, 9_999)}…`;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactMetadataValue(item, depth + 1, budget)).filter((item) => item !== undefined);
  }
  if (typeof value !== "object") return undefined;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (budget.keys >= 200) break;
    budget.keys += 1;
    if (/(authorization|cookie|credential|password|secret|api[-_]?key|access[-_]?key|token)/i.test(key)) continue;
    const safe = redactMetadataValue(item, depth + 1, budget);
    if (safe !== undefined) output[key] = safe;
  }
  return output;
}

function assertPublicSourceHostname(hostname: string): void {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")
      || normalized === "metadata.google.internal" || normalized === "metadata.google.com") {
    throw new TypeError(`Blocked timeline source hostname: ${hostname}`);
  }
  if (!isIP(normalized)) return;
  if (isPrivateOrReservedAddress(normalized)) {
    throw new TypeError("Timeline source URL uses a private or reserved address.");
  }
}
