import type { Platform } from "./types";

const BODY_KEYS = [
  "articleBody",
  "article_body",
  "fullText",
  "full_text",
  "text",
  "body",
  "content"
] as const;

const RAW_BODY_KEYS = ["rawText", "raw_text"] as const;
const SYNTHETIC_SUMMARY_PATTERNS = [
  /\b(?:quote[- ]?post|quoted\s+(?:founder\s+)?post|native\s+(?:x|linkedin)\s+(?:post|article)|post\s+about)\b/i,
  /^\s*[\p{L}\d][\p{L}\d .'-]{1,60}\s+(?:repl(?:ied|ies|y)|responded|congratulat(?:es|ing)|highlighted|shared|discussed|recommended)\b/iu,
  /\b(?:replied|responded)\s+(?:directly\s+)?to\b/i
];

type RawRecord = Record<string, unknown>;

export interface VerbatimEvidenceInput {
  platform: Platform;
  title?: string | null;
  text?: string | null;
  originalText?: string | null;
  rawVisibleText?: string | null;
  attributionProvenance?: string | null;
}

/**
 * Resolve the partner-authored body without falling back to attribution
 * summaries, titles, URLs, or quoted/replied content. The explicit
 * originalText field wins; raw receipts are only consulted for their native
 * primary-post body fields.
 */
export function originalEvidenceText(item: VerbatimEvidenceInput): string {
  // Search-result snippets can be copied into both text fields by ingestion,
  // but they are attribution summaries rather than the native authored body.
  // Discard them before any other fallback is considered.
  const explicit = item.attributionProvenance === "strict_native_search_snippet_v3"
    ? ""
    : authoredBodyOrEmpty(item.originalText);
  if (explicit) return explicit;

  const payload = parseRecord(item.rawVisibleText);
  if (payload) {
    const extracted = item.platform === "linkedin"
      ? linkedInPrimaryBody(payload)
      : item.platform === "x"
        ? xPrimaryBody(payload)
        : genericPrimaryBody(payload);
    const authored = authoredBodyOrEmpty(extracted);
    if (authored) return authored;
  }

  const text = authoredBodyOrEmpty(item.text);
  if (!text) return "";
  if (item.attributionProvenance === "strict_native_search_snippet_v3") return "";
  if (item.title && sameText(text, preserveText(item.title))) return "";
  return text;
}

function authoredBodyOrEmpty(value: unknown): string {
  const text = preserveText(value);
  return text && !SYNTHETIC_SUMMARY_PATTERNS.some((pattern) => pattern.test(text)) ? text : "";
}

/**
 * Split authored text using the runtime's sentence segmenter so URLs,
 * decimals, initials, and quoted punctuation do not create false boundaries.
 * Only outer whitespace is removed; all interior characters remain verbatim.
 */
export function splitVerbatimSentences(value: string | null | undefined): string[] {
  const text = String(value ?? "");
  if (!text.trim()) return [];

  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    return [...segmenter.segment(text)]
      .map(({ segment }) => segment.trim())
      .filter(Boolean);
  }

  return fallbackSentenceSegments(text);
}

function linkedInPrimaryBody(payload: RawRecord): string {
  const post = record(payload.post);
  const detail = record(payload.detail);
  return firstBody(
    post,
    payload,
    detail,
    record(payload.article),
    record(post?.article),
    { raw: post?.rawText ?? post?.raw_text },
    { raw: payload.rawText ?? payload.raw_text }
  );
}

function xPrimaryBody(payload: RawRecord): string {
  // Reconciled X receipts keep the owner's authored wrapper under primary;
  // profile receipts keep it under post. Never traverse quote/quotedPost.
  const primary = record(payload.primary);
  const post = record(payload.post);
  const article = record(payload.article);
  const postArticle = record(post?.article);
  return firstBody(
    primary,
    post,
    article,
    postArticle,
    payload,
    { raw: post?.rawText ?? post?.raw_text },
    { raw: primary?.rawText ?? primary?.raw_text }
  );
}

function genericPrimaryBody(payload: RawRecord): string {
  return firstBody(payload, record(payload.post), record(payload.detail));
}

function firstBody(...records: Array<RawRecord | { raw?: unknown } | null>): string {
  const bodyParts: string[] = [];
  const rawParts: string[] = [];
  let articleBody = "";

  for (const candidate of records) {
    if (!candidate) continue;
    const recordValue = "raw" in candidate ? null : candidate as RawRecord;
    if (recordValue) {
      for (const key of BODY_KEYS) {
        const value = bodyValue(recordValue[key]);
        if (!value) continue;
        if (key === "articleBody" || key === "article_body") {
          articleBody = articleBody || value;
        } else if (!bodyParts.some((existing) => sameText(existing, value))) {
          bodyParts.push(value);
        }
      }
      for (const key of RAW_BODY_KEYS) {
        const value = bodyValue(recordValue[key]);
        if (value && !rawParts.some((existing) => sameText(existing, value))) rawParts.push(value);
      }
    }

    const raw = "raw" in candidate ? preserveText(candidate.raw) : "";
    if (raw && !rawParts.some((existing) => sameText(existing, raw))) rawParts.push(raw);
  }

  if (articleBody && !bodyParts.some((existing) => sameText(existing, articleBody))) {
    bodyParts.push(articleBody);
  }
  return (bodyParts.length > 0 ? bodyParts : rawParts).join("\n\n").trim();
}

function bodyValue(value: unknown): string {
  if (typeof value === "string") return preserveText(value);
  const nested = record(value);
  return preserveText(nested?.text ?? nested?.value ?? nested?.body);
}

function parseRecord(value: string | null | undefined): RawRecord | null {
  if (!value || !value.trim().startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return record(parsed);
  } catch {
    return null;
  }
}

function record(value: unknown): RawRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RawRecord
    : null;
}

function preserveText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").trim()
    : "";
}

function sameText(left: string, right: string): boolean {
  return left === right || left.replace(/\s+/g, " ") === right.replace(/\s+/g, " ");
}

function fallbackSentenceSegments(text: string): string[] {
  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!/[.!?]/.test(text[index])) continue;
    const next = text[index + 1] ?? "";
    if (next && !/\s/.test(next)) continue;
    const segment = text.slice(start, index + 1).trim();
    if (segment) segments.push(segment);
    start = index + 1;
  }
  const remainder = text.slice(start).trim();
  if (remainder) segments.push(remainder);
  return segments;
}
