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
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      REDACTED_PUBLIC_TOKEN
    )
    .replace(
      /\bBearer(\s+)(?!\[(?:redacted|redacted-public-token)\])(?:[A-Za-z0-9._~+/=%:-]{12,}|<[A-Za-z0-9._-]{6,}>)/gi,
      (_match, spacing) => `Bearer${spacing}${REDACTED_PUBLIC_TOKEN}`
    )
    .replace(
      /\b((?:proxy-)?authorization)((?:\\*["'])?\s*[:=]\s*(?:\\*["'])?)(?!\[(?:redacted|redacted-public-token)\])(?:([A-Za-z][A-Za-z0-9._~-]{0,31})(\s+))?([A-Za-z0-9._~+/=%:-]{12,}|<[A-Za-z0-9._-]{6,}>)/gi,
      (_match, header, separator) => `${header}${separator}${REDACTED_PUBLIC_TOKEN}`
    )
    .replace(/\b[A-Za-z0-9_-]{3,}=[A-Za-z0-9%._/-]{16,}/g, (match) => {
      const key = match.split("=")[0];
      return `${key}=[redacted-public-param]`;
    });
}
