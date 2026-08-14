#!/usr/bin/env node

/**
 * Hydrate the exact top-level body authored by each YC partner currently
 * represented in the published YC partner graph snapshots.
 *
 * This intentionally never reads quote/reply-card bodies. X Articles are
 * reconstructed from the article blocks returned by FxTwitter; LinkedIn uses
 * the public post description metadata. The resulting map is checked into the
 * graph data so scoring and the UI have one lossless source of truth.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const graphPaths = ["public/graph/s2026-yc-partners.json", "public/graph/s26-yc-partners.json"];
const outputPath = resolve(root, "src/lib/social/yc-partner-verbatim-text.json");
const requestTimeoutMs = 20_000;
const concurrency = 6;

const existing = JSON.parse(await readFile(outputPath, "utf8"));
const rows = new Map();

for (const relativePath of graphPaths) {
  const graph = JSON.parse(await readFile(resolve(root, relativePath), "utf8"));
  for (const evidence of graph.evidence ?? []) {
    if (evidence.topVoice?.audienceId !== "yc_partners") continue;
    if (!evidence.sourceUrl) continue;
    rows.set(evidence.sourceUrl, evidence);
  }
}

const urls = [...rows.keys()].sort();
const hydrated = { ...existing };
const failures = [];
let cursor = 0;

async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= urls.length) return;
    const url = urls[index];
    try {
      const body = await fetchVerbatimBody(url);
      if (body) hydrated[url] = body;
      else failures.push({ url, reason: "empty native body" });
    } catch (error) {
      failures.push({ url, reason: error instanceof Error ? error.message : String(error) });
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));

const sorted = Object.fromEntries(Object.entries(hydrated).sort(([left], [right]) => left.localeCompare(right)));
await writeFile(outputPath, `${JSON.stringify(sorted, null, 2)}\n`);

console.log(`YC partner rows: ${urls.length}`);
console.log(`Exact bodies hydrated: ${urls.filter((url) => typeof sorted[url] === "string" && sorted[url].length > 0).length}`);
console.log(`Failures: ${failures.length}`);
for (const failure of failures) console.warn(`${failure.url}: ${failure.reason}`);

async function fetchVerbatimBody(url) {
  const parsed = new URL(url);
  if (parsed.hostname === "x.com" || parsed.hostname === "twitter.com") {
    const match = parsed.pathname.match(/\/status\/(\d+)/i);
    if (!match) return null;
    const handle = parsed.pathname.split("/").filter(Boolean)[0];
    const response = await fetchWithTimeout(`https://api.fxtwitter.com/${handle}/status/${match[1]}`);
    if (!response.ok) throw new Error(`FxTwitter HTTP ${response.status}`);
    const payload = await response.json();
    const tweet = payload?.tweet;
    const articleText = tweet?.article?.content?.blocks
      ?.map((block) => block?.text)
      .filter((text) => typeof text === "string" && text.trim())
      .join("\n\n");
    return normalizeBody(articleText || tweet?.text);
  }

  if (parsed.hostname === "www.linkedin.com" || parsed.hostname === "linkedin.com") {
    const response = await fetchWithTimeout(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; returner-fund evidence hydration)" }
    });
    if (!response.ok) throw new Error(`LinkedIn HTTP ${response.status}`);
    const html = await response.text();
    const descriptions = [
      readMetaContent(html, "description"),
      readMetaContent(html, "og:description"),
      readMetaContent(html, "twitter:description")
    ];
    return normalizeBody(descriptions.find((value) => value) ?? "");
  }

  return null;
}

function readMetaContent(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<meta\\b[^>]*(?:name|property)=["']${escaped}["'][^>]*content=("|')([\\s\\S]*?)\\1[^>]*>`, "i");
  const reversePattern = new RegExp(`<meta\\b[^>]*content=("|')([\\s\\S]*?)\\1[^>]*(?:name|property)=["']${escaped}["'][^>]*>`, "i");
  return decodeHtmlEntities(pattern.exec(html)?.[2] ?? reversePattern.exec(html)?.[2] ?? "");
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeBody(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return normalized || null;
}

async function fetchWithTimeout(url, options = {}) {
  const signal = AbortSignal.timeout(requestTimeoutMs);
  return fetch(url, { ...options, signal });
}
