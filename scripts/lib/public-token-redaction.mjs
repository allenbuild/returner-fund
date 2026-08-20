const REDACTED_PUBLIC_TOKEN = "[redacted-public-token]";

/**
 * Redact credential-shaped values from collector JSON without rewriting
 * ordinary identifiers that merely contain the characters `sk-` (for
 * example, an ingestion slot ending in `task-pagination-fix`).
 */
export function redactTokenLikeStrings(value) {
  return String(value)
    .replace(/gh[pousr]_[A-Za-z0-9_]{12,}/g, REDACTED_PUBLIC_TOKEN)
    .replace(/github_pat_[A-Za-z0-9_]{12,}/g, REDACTED_PUBLIC_TOKEN)
    .replace(
      /(^|[^A-Za-z0-9_])sk-[A-Za-z0-9_-]{12,}/g,
      (_match, boundary) => `${boundary}${REDACTED_PUBLIC_TOKEN}`
    )
    .replace(/xox[baprs]-[A-Za-z0-9-]{12,}/g, REDACTED_PUBLIC_TOKEN)
    .replace(/AKIA[0-9A-Z]{16}/g, REDACTED_PUBLIC_TOKEN)
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, `Bearer ${REDACTED_PUBLIC_TOKEN}`)
    .replace(/\b[A-Za-z0-9_-]{3,}=[A-Za-z0-9%._/-]{16,}/g, (match) => {
      const key = match.split("=")[0];
      return `${key}=[redacted-public-param]`;
    });
}
