const REDACTED_PUBLIC_TOKEN = "[redacted-public-token]";
const PRIVATE_KEY_BLOCK =
  /-----BEGIN ((?:RSA |EC |OPENSSH )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;
const PRIVATE_KEY_HEADER = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
const BEARER_VALUE =
  /\b(Bearer)(\s+)(?!\[(?:redacted|redacted-public-token)\])[^\s"']+/gi;
const AUTHORIZATION_VALUE =
  /\b((?:proxy-)?authorization)((?:["'])?\s*[:=]\s*(?:["'])?)(?!(?:(?:[A-Za-z][A-Za-z0-9._~-]{0,31})\s+)?\[(?:redacted|redacted-public-token)\])(?:(?:[A-Za-z][A-Za-z0-9._~-]{0,31})\s+)?[^\s,"']+/gi;
const REDACTED_VALUE = /^\[(?:redacted|redacted-public-token)\]$/i;

/**
 * Redact credential-shaped values from one decoded string without rewriting
 * ordinary identifiers that merely contain the characters `sk-` (for
 * example, an ingestion slot ending in `task-pagination-fix`).
 */
export function redactTokenLikeStrings(value) {
  return String(value)
    .replace(PRIVATE_KEY_BLOCK, REDACTED_PUBLIC_TOKEN)
    .replace(PRIVATE_KEY_HEADER, REDACTED_PUBLIC_TOKEN)
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
      BEARER_VALUE,
      (_match, header, spacing) => `${header}${spacing}${REDACTED_PUBLIC_TOKEN}`
    )
    .replace(
      AUTHORIZATION_VALUE,
      (_match, header, separator) => `${header}${separator}${REDACTED_PUBLIC_TOKEN}`
    )
    .replace(/\b[A-Za-z0-9_-]{3,}=[A-Za-z0-9%._/-]{16,}/g, (match) => {
      const key = match.split("=")[0];
      return `${key}=[redacted-public-param]`;
    });
}

/**
 * Recursively redact JSON-compatible keys and string values before calling
 * JSON.stringify. Performing this on decoded values keeps escape backslashes
 * out of the credential grammar and cannot consume a JSON delimiter.
 */
export function redactTokenLikeValues(value) {
  return redactTokenLikeValue(value, new WeakSet());
}

function redactTokenLikeValue(value, ancestors) {
  if (typeof value === "string") {
    return redactPossiblyNestedJsonString(value, ancestors);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("Public token redaction cannot serialize a cycle.");
    ancestors.add(value);
    try {
      return value.map((entry) => redactTokenLikeValue(entry, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (!value || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new TypeError("Public token redaction cannot serialize a cycle.");
  ancestors.add(value);
  try {
    const entries = [];
    const keys = new Set();
    for (const [key, entry] of Object.entries(value)) {
      const redactedKey = redactTokenLikeStrings(key);
      if (keys.has(redactedKey)) {
        throw new Error("Public token redaction produced a duplicate JSON key.");
      }
      keys.add(redactedKey);
      let redactedEntry = redactTokenLikeValue(entry, ancestors);
      if (
        isAuthorizationKey(key) &&
        redactedEntry !== null &&
        redactedEntry !== undefined &&
        !(
          typeof redactedEntry === "string" &&
          (REDACTED_VALUE.test(redactedEntry) || redactedEntry.includes(REDACTED_PUBLIC_TOKEN))
        )
      ) {
        redactedEntry = REDACTED_PUBLIC_TOKEN;
      }
      entries.push([redactedKey, redactedEntry]);
    }
    return Object.fromEntries(entries);
  } finally {
    ancestors.delete(value);
  }
}

function redactPossiblyNestedJsonString(value, ancestors) {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const body = value.slice(leading.length, value.length - trailing.length);
  if (
    (body.startsWith("{") && body.endsWith("}")) ||
    (body.startsWith("[") && body.endsWith("]"))
  ) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      // The string only resembles JSON. Treat it as diagnostic text below.
    }
    if (parsed !== undefined) {
      const redacted = redactTokenLikeValue(parsed, ancestors);
      const before = JSON.stringify(parsed);
      const after = JSON.stringify(redacted);
      if (after !== before) return `${leading}${after}${trailing}`;
    }
  }
  return redactTokenLikeStrings(value);
}

function isAuthorizationKey(value) {
  const normalized = String(value).toLowerCase().replace(/[^a-z]/g, "");
  return normalized === "authorization" || normalized === "proxyauthorization";
}
