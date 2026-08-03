#!/usr/bin/env node

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateTimelineArtifacts } from "./validate-timeline-artifacts.mjs";

const DEFAULT_COMPANY_SAMPLE = 30;
const DEFAULT_EVENT_SAMPLE = 150;
// Treat explicit access controls and transient upstream/gateway failures as
// inconclusive rather than declaring the underlying evidence URL invalid.
// A repeatable 4xx such as 404 remains a hard audit failure.
const BLOCKED_STATUSES = new Set([401, 403, 407, 418, 423, 425, 429, 451, 502, 503, 504]);

export async function auditTimelineQuality({
  rootDir = process.cwd(),
  companySampleSize = DEFAULT_COMPANY_SAMPLE,
  eventSampleSize = DEFAULT_EVENT_SAMPLE,
  verifyLinks = false,
  linkConcurrency = 12,
  linkTimeoutMs = 8_000,
  fetchImpl = fetch,
} = {}) {
  const artifactValidation = await validateTimelineArtifacts({ rootDir });
  const coverage = await readJson(path.join(rootDir, "artifacts", "company-timeline", "coverage.json"));
  const companies = [];
  for (const entry of coverage.companies) {
    const artifact = await readJson(path.join(rootDir, entry.artifactPath));
    companies.push({ entry, artifact });
  }

  const companySample = selectCompanySample(companies, companySampleSize);
  if (companySample.length < Math.min(companySampleSize, companies.length)) {
    throw new Error(`Could only select ${companySample.length} companies for the ${companySampleSize}-company audit.`);
  }
  const sampledEvents = selectEventSample(companySample, companies, eventSampleSize);
  if (sampledEvents.length < Math.min(eventSampleSize, artifactValidation.publishedEvents)) {
    throw new Error(`Could only select ${sampledEvents.length} events for the ${eventSampleSize}-event audit.`);
  }
  if (artifactValidation.publishedEvents < eventSampleSize) {
    throw new Error(`The public timeline contains ${artifactValidation.publishedEvents} events, below the required ${eventSampleSize}-event quality audit.`);
  }

  const violations = [];
  const duplicateKeys = new Map();
  const categories = new Map();
  let majorEvents = 0;
  let conflicts = 0;
  const urls = new Set();

  for (const company of companies) {
    for (const event of company.artifact.events) {
      const normalizedTitle = event.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const duplicateKey = `${company.entry.company.id}|${event.eventDate}|${event.category}|${normalizedTitle}`;
      const prior = duplicateKeys.get(duplicateKey);
      if (prior) violations.push(`Duplicate event ${event.id} matches ${prior}`);
      else duplicateKeys.set(duplicateKey, event.id);
      for (const issue of timelineEventQualityViolations(company.entry.company, event)) {
        violations.push(`${event.id}: ${issue}`);
      }
    }
  }

  for (const { event } of sampledEvents) {
    categories.set(event.category, (categories.get(event.category) ?? 0) + 1);
    if (event.isMajor) majorEvents += 1;
    if (event.hasConflict) conflicts += 1;
    for (const source of event.sourcePreview) urls.add(source.url);
  }

  const linkAudit = verifyLinks
    ? await verifyPublicLinks([...urls], { concurrency: linkConcurrency, timeoutMs: linkTimeoutMs, fetchImpl })
    : { checked: 0, reachable: 0, blocked: 0, failed: 0, failures: [] };
  for (const failure of linkAudit.failures) violations.push(`Evidence URL failed: ${failure.url} (${failure.reason})`);
  if (violations.length) {
    const error = new Error(`Timeline quality audit failed:\n- ${violations.join("\n- ")}`);
    error.violations = violations;
    throw error;
  }

  return {
    status: "ok",
    inventoryRecords: artifactValidation.inventoryRecords,
    uniqueCompanies: artifactValidation.uniqueCompanies,
    companiesAudited: companySample.length,
    eventsAudited: sampledEvents.length,
    representedCategories: Object.fromEntries([...categories.entries()].sort()),
    majorEvents,
    conflicts,
    directEvidenceUrls: urls.size,
    linkAudit,
    sparseCompaniesAudited: companySample.filter(({ artifact }) => artifact.events.length <= 2).length,
    highEvidenceCompaniesAudited: companySample.filter(({ artifact }) => artifact.events.length >= 10).length,
    zeroEventCompaniesAudited: companySample.filter(({ artifact }) => artifact.events.length === 0).length,
  };
}

export function timelineEventQualityViolations(company, event) {
  const issues = [];
  const combined = `${event.title} ${event.summary}`;
  if (/&(?:#\d+|#x[a-f0-9]+|[a-z]{2,8});/i.test(combined)) {
    issues.push("public copy contains an undecoded text entity");
  }
  const normalizedTitleTokens = normalizeWords(event.title);
  if (containsRepeatedOpeningPhrase(normalizedTitleTokens)) {
    issues.push("title repeats the same opening phrase");
  }
  if (/(?:^|[-\s])[a-z]$/i.test(event.title) && !/[.!?…]$/.test(event.title)) {
    issues.push("title appears to be cut off mid-word");
  }
  if (/\b(?:launched a new product|released a product update)\b/i.test(event.title)) {
    issues.push("title uses a generic product-event placeholder");
  }
  if (/[,;:]\.$/.test(event.summary)) {
    issues.push("summary ends with malformed punctuation");
  }
  if (["traction_milestone", "revenue_milestone", "user_milestone"].includes(event.category)) {
    const achieved = /\b(?:reached|hit|crossed|surpassed|exceeded|grew to|now (?:has|serves)|has reached)\b/i.test(combined);
    const prospective = /\b(?:on track|aim(?:s|ing)?|goal|target|soon|to become)\b/i.test(combined);
    if (!achieved || prospective) issues.push("milestone is not an explicit achieved result");
  }
  if (event.category === "product_launch"
      && /\b(?:teammate|welcome\b|we(?:'re| are) hiring|join (?:our|the) team|anniversary)\b/i.test(combined)
      && !/\b(?:product|app|platform|software|model|api|feature|version|v\d|available|live|released|launched|shipped)\b/i.test(combined)) {
    issues.push("product launch appears to describe hiring or an anniversary instead of a product release");
  }
  const previews = Array.isArray(event.sourcePreview) ? event.sourcePreview : [];
  if (previews.length > 0 && previews.every((source) => source.sourceType === "founder_post")) {
    const identityTokens = new Set([
      ...normalizeWords(company.name),
      ...normalizeWords(company.slug),
    ].filter((token) => token.length >= 3));
    const evidenceTokens = new Set(normalizeWords(`${combined} ${previews.map((source) => source.title).join(" ")}`));
    if (identityTokens.size > 0 && ![...identityTokens].some((token) => evidenceTokens.has(token))) {
      issues.push("founder-only evidence does not materially identify the company");
    }
  }
  return issues;
}

function containsRepeatedOpeningPhrase(tokens) {
  const maximum = Math.min(10, Math.floor(tokens.length / 2));
  for (let length = maximum; length >= 4; length -= 1) {
    const phrase = tokens.slice(0, length).join(" ");
    if (tokens.slice(length).join(" ").includes(phrase)) return true;
  }
  return false;
}

function normalizeWords(value) {
  return String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

function selectCompanySample(companies, requested) {
  const selected = new Map();
  const byCount = [...companies].sort((left, right) => right.artifact.events.length - left.artifact.events.length || left.entry.company.id.localeCompare(right.entry.company.id));
  const bucketSize = Math.max(1, Math.ceil(requested / 3));
  for (const company of byCount.slice(0, bucketSize)) selected.set(company.entry.company.id, company);
  for (const company of [...byCount].reverse().slice(0, bucketSize)) selected.set(company.entry.company.id, company);
  for (const company of [...companies].sort((left, right) => stableOrder(left.entry.company.id) - stableOrder(right.entry.company.id))) {
    if (selected.size >= requested) break;
    selected.set(company.entry.company.id, company);
  }
  return [...selected.values()].slice(0, requested);
}

function selectEventSample(companySample, allCompanies, requested) {
  const sampled = [];
  const seen = new Set();
  const add = (company, event) => {
    if (seen.has(event.id) || sampled.length >= requested) return;
    seen.add(event.id);
    sampled.push({ company, event });
  };

  // Ensure every selected non-empty company contributes before filling the
  // remainder across the inventory using a deterministic hash order.
  for (const company of companySample) {
    for (const event of company.artifact.events.slice(0, 2)) add(company, event);
  }
  const candidates = allCompanies
    .flatMap((company) => company.artifact.events.map((event) => ({ company, event })))
    .sort((left, right) => stableOrder(left.event.id) - stableOrder(right.event.id));
  for (const candidate of candidates) add(candidate.company, candidate.event);
  return sampled;
}

export async function verifyPublicLinks(urls, { concurrency, timeoutMs, fetchImpl }) {
  const queue = [...new Set(urls)].sort();
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (cursor < queue.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await verifyOneLink(queue[index], { timeoutMs, fetchImpl });
    }
  });
  await Promise.all(workers);
  return {
    checked: results.length,
    reachable: results.filter((result) => result.status === "reachable").length,
    blocked: results.filter((result) => result.status === "blocked").length,
    failed: results.filter((result) => result.status === "failed").length,
    failures: results.filter((result) => result.status === "failed").map(({ url, reason }) => ({ url, reason })),
  };
}

async function verifyOneLink(initialUrl, { timeoutMs, fetchImpl }) {
  let currentUrl = initialUrl;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.1",
          range: "bytes=0-1023",
          "user-agent": "ReturnerTimelineAudit/1.0 (+https://www.returner.fund)",
        },
      });
    } catch (error) {
      clearTimeout(timeout);
      // Some bot-protected media hosts terminate ranged GETs while still
      // answering a standards-compliant HEAD request. Retry once without a
      // range so a transport quirk is not misreported as a dead source.
      const fallbackController = new AbortController();
      const fallbackTimeout = setTimeout(() => fallbackController.abort(), timeoutMs);
      try {
        const fallback = await fetchImpl(currentUrl, {
          method: "HEAD",
          redirect: "manual",
          signal: fallbackController.signal,
          headers: { "user-agent": "Mozilla/5.0 (compatible; ReturnerTimelineAudit/1.0)" },
        });
        clearTimeout(fallbackTimeout);
        await fallback.body?.cancel().catch(() => undefined);
        if (fallback.ok) return { url: initialUrl, status: "reachable", reason: `HTTP ${fallback.status} (HEAD fallback)` };
        if (BLOCKED_STATUSES.has(fallback.status)) return { url: initialUrl, status: "blocked", reason: `HTTP ${fallback.status} (HEAD fallback)` };
      } catch {
        clearTimeout(fallbackTimeout);
      }
      return { url: initialUrl, status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
    clearTimeout(timeout);
    await response.body?.cancel().catch(() => undefined);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { url: initialUrl, status: "failed", reason: `redirect ${response.status} without Location` };
      const destination = new URL(location, currentUrl);
      if (destination.protocol !== "http:" && destination.protocol !== "https:") return { url: initialUrl, status: "failed", reason: "unsafe redirect protocol" };
      if (!isPublicHostname(destination.hostname)) return { url: initialUrl, status: "failed", reason: "redirect targets a private network" };
      currentUrl = destination.toString();
      continue;
    }
    if (response.ok || response.status === 206) return { url: initialUrl, status: "reachable", reason: `HTTP ${response.status}` };
    if (BLOCKED_STATUSES.has(response.status)) return { url: initialUrl, status: "blocked", reason: `HTTP ${response.status}` };
    return { url: initialUrl, status: "failed", reason: `HTTP ${response.status}` };
  }
  return { url: initialUrl, status: "failed", reason: "more than five redirects" };
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

function stableOrder(value) {
  return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 12), 16);
}

function isPublicHostname(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) return false;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const octets = normalized.split(".").map(Number);
    return !(octets[0] === 10 || octets[0] === 127 || octets[0] === 0 || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
  }
  if (ipVersion === 6) return !(normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb"));
  return true;
}

function parseArgs(rawArgs) {
  const args = {};
  for (const argument of rawArgs) {
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--verify-links") {
      args.verifyLinks = true;
      continue;
    }
    const [flag, value] = argument.split("=", 2);
    if (!value) throw new Error(`Expected --name=value, received ${argument}`);
    if (flag === "--root-dir") args.rootDir = path.resolve(value);
    else if (flag === "--companies") args.companySampleSize = Number(value);
    else if (flag === "--events") args.eventSampleSize = Number(value);
    else if (flag === "--link-concurrency") args.linkConcurrency = Number(value);
    else if (flag === "--link-timeout-ms") args.linkTimeoutMs = Number(value);
    else throw new Error(`Unknown argument ${flag}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/audit-timeline-quality.mjs [options]",
    "",
    "  --companies=30",
    "  --events=150",
    "  --verify-links",
    "  --link-concurrency=12",
    "  --link-timeout-ms=8000",
    "  --root-dir=.",
  ].join("\n");
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) console.log(usage());
  else auditTimelineQuality(options)
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
