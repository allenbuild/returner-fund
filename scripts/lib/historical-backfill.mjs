import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { isIP } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { gunzipSync } from "node:zlib";
import * as cheerio from "cheerio";
import { loadAutonomousCatalogs } from "./autonomous-ingestion-plan.mjs";
import { CircuitOpenError, createHttpPolicy } from "./http-policy.mjs";

export const HISTORICAL_BACKFILL_SCHEMA_VERSION = 1;
export const HISTORICAL_BACKFILL_RUNNER_VERSION = "2026-08-02.v1";
export const HISTORICAL_BACKFILL_PLATFORMS = Object.freeze([
  "hacker_news",
  "rss",
  "web"
]);

export const HISTORICAL_BACKFILL_LIMITS = Object.freeze({
  globalConcurrency: 8,
  hostConcurrency: 1,
  hostPaceMs: 250,
  requestTimeoutMs: 20_000,
  requestAttempts: 3,
  circuitFailureThreshold: 4,
  circuitCooldownMs: 60_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxDecodedBytes: 4 * 1024 * 1024,
  hnHitsPerPage: 50,
  hnMaxPages: 20,
  hnMaxItems: 1_000,
  siteMaxDepth: 3,
  siteMaxUrls: 200,
  siteMaxResponses: 40,
  siteMaxItems: 2_000
});

const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src"
]);
const FEED_CONTENT_TYPES = /(?:application|text)\/(?:atom\+xml|rss\+xml|rdf\+xml|xml)|\bfeed\b/i;
const HTML_CONTENT_TYPES = /text\/html|application\/xhtml\+xml/i;
const HISTORICAL_PATH = /(?:^|\/)(?:blog|blogs|news|press|press-releases?|changelog|updates?|stories|articles?|resources?|events?|launch(?:es)?|archive(?:s)?)(?:\/|$)/i;
const FEED_PATH = /(?:^|\/)(?:feed|feeds|rss|atom)(?:\.(?:xml|rss|atom))?(?:\/|$)|\.(?:rss|atom)$/i;
const SITEMAP_PATH = /(?:sitemap|site-map)(?:[_-](?:index|\d+))?(?:\.xml)?(?:\.gz)?$/i;

export class BoundedBodyError extends Error {
  constructor(message, { limit, observed, phase }) {
    super(message);
    this.name = "BoundedBodyError";
    this.limit = limit;
    this.observed = observed;
    this.phase = phase;
  }
}

export function normalizeHistoricalPlatforms(platforms) {
  const source = platforms == null
    ? [...HISTORICAL_BACKFILL_PLATFORMS]
    : Array.isArray(platforms)
      ? platforms
      : String(platforms).split(",");
  const normalized = [...new Set(source.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  const invalid = normalized.filter((platform) => !HISTORICAL_BACKFILL_PLATFORMS.includes(platform));
  if (invalid.length > 0) {
    throw new Error(
      `Unsupported historical platform(s): ${invalid.join(", ")}. ` +
      `Supported values: ${HISTORICAL_BACKFILL_PLATFORMS.join(", ")}.`
    );
  }
  if (normalized.length === 0) throw new Error("At least one historical platform is required.");
  return normalized.sort();
}

export function selectHistoricalCatalogs(catalogs, batches) {
  if (batches == null) return catalogs;
  const requested = [...new Set(
    (Array.isArray(batches) ? batches : String(batches).split(","))
      .map((value) => String(value).trim().toUpperCase())
      .filter(Boolean)
  )];
  if (requested.length === 0) throw new Error("At least one batch is required.");
  const bySlug = new Map(catalogs.map((catalog) => [String(catalog.slug).toUpperCase(), catalog]));
  const missing = requested.filter((slug) => !bySlug.has(slug));
  if (missing.length > 0) {
    throw new Error(`Unknown historical batch(es): ${missing.join(", ")}.`);
  }
  return requested.map((slug) => bySlug.get(slug));
}

export function buildHistoricalTargets(catalogs, { batches, platforms } = {}) {
  const selectedCatalogs = selectHistoricalCatalogs(catalogs, batches);
  const selectedPlatforms = normalizeHistoricalPlatforms(platforms);
  const targets = [];
  const batchRows = [];
  let companiesEvaluated = 0;
  let missingOfficialWebsites = 0;

  for (const catalog of selectedCatalogs) {
    let batchMissingWebsites = 0;
    const companies = [...(catalog.companies ?? [])].sort((left, right) =>
      String(left.sourceKey).localeCompare(String(right.sourceKey))
    );
    for (const company of companies) {
      companiesEvaluated += 1;
      const officialWebsite = canonicalOfficialWebsite(company.websiteUrl);
      const officialDomain = officialWebsite ? normalizedHostname(new URL(officialWebsite).hostname) : null;
      if (!officialWebsite) {
        missingOfficialWebsites += 1;
        batchMissingWebsites += 1;
      }
      for (const platform of selectedPlatforms) {
        const targetKey = `${catalog.slug}:${company.sourceKey}:${platform}`;
        targets.push(Object.freeze({
          targetKey,
          batchSlug: catalog.slug,
          entityType: "company",
          entityId: company.sourceKey,
          entityName: company.name,
          companyName: company.name,
          companySlug: companySlug(company),
          officialWebsite,
          officialDomain,
          platform
        }));
      }
    }
    batchRows.push({
      slug: catalog.slug,
      companies: companies.length,
      missingOfficialWebsites: batchMissingWebsites,
      targetPlatformPairs: companies.length * selectedPlatforms.length
    });
  }

  return {
    schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
    runnerVersion: HISTORICAL_BACKFILL_RUNNER_VERSION,
    platforms: selectedPlatforms,
    batches: batchRows,
    companiesEvaluated,
    missingOfficialWebsites,
    targetPlatformPairs: targets.length,
    targets
  };
}

export async function buildHistoricalBackfillPlan(root, options = {}) {
  const catalogs = options.catalogs ?? await loadAutonomousCatalogs(root);
  const targetPlan = buildHistoricalTargets(catalogs, options);
  const limits = normalizeHistoricalLimits(options.limits);
  const estimatedWorstCasePages = targetPlan.targets.reduce((total, target) => {
    if (!target.officialWebsite) return total;
    return total + (target.platform === "hacker_news" ? limits.hnMaxPages : limits.siteMaxResponses);
  }, 0);
  return {
    ...targetPlan,
    targets: undefined,
    concurrency: {
      global: limits.globalConcurrency,
      perHost: limits.hostConcurrency,
      hostPaceMs: limits.hostPaceMs,
      signedInSessions: false
    },
    limits: publicLimits(limits),
    estimatedWorstCasePages,
    estimatedWorstCaseRequests: estimatedWorstCasePages * limits.requestAttempts
  };
}

export function historicalHnSearchUrl(target, page, limits = HISTORICAL_BACKFILL_LIMITS) {
  if (!target?.entityName || !target?.officialDomain) {
    throw new Error("Hacker News historical search requires an exact company name and official domain.");
  }
  const url = new URL("https://hn.algolia.com/api/v1/search_by_date");
  url.searchParams.set("query", `\"${target.entityName}\" ${target.officialDomain}`);
  url.searchParams.set("tags", "story");
  url.searchParams.set("hitsPerPage", String(limits.hnHitsPerPage));
  url.searchParams.set("page", String(page));
  return url.toString();
}

export function matchesHnCompanyStory(hit, target) {
  const name = String(target?.entityName ?? "").trim();
  const officialDomain = normalizedHostname(target?.officialDomain);
  if (!name || !officialDomain) return false;
  const text = [
    hit?.title,
    hit?.story_title,
    hit?.story_text,
    hit?.comment_text,
    hit?.url,
    hit?.story_url
  ].filter(Boolean).join(" \n ");
  if (!containsExactPhrase(text, name)) return false;
  return urlMatchesOfficialDomain(hit?.url ?? hit?.story_url, officialDomain) ||
    containsDomain(text, officialDomain);
}

export async function readBoundedResponseBytes(response, {
  maxResponseBytes = HISTORICAL_BACKFILL_LIMITS.maxResponseBytes,
  maxDecodedBytes = HISTORICAL_BACKFILL_LIMITS.maxDecodedBytes
} = {}) {
  assertPositiveLimit(maxResponseBytes, "maxResponseBytes");
  assertPositiveLimit(maxDecodedBytes, "maxDecodedBytes");
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw new BoundedBodyError(
      `Response declared ${declaredLength} bytes, above the ${maxResponseBytes}-byte limit.`,
      { limit: maxResponseBytes, observed: declaredLength, phase: "encoded" }
    );
  }

  const chunks = [];
  let observed = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        observed += chunk.length;
        if (observed > maxResponseBytes) {
          await reader.cancel().catch(() => {});
          throw new BoundedBodyError(
            `Response exceeded the ${maxResponseBytes}-byte encoded body limit.`,
            { limit: maxResponseBytes, observed, phase: "encoded" }
          );
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
  } else {
    const body = Buffer.from(await response.arrayBuffer());
    observed = body.length;
    if (observed > maxResponseBytes) {
      throw new BoundedBodyError(
        `Response exceeded the ${maxResponseBytes}-byte encoded body limit.`,
        { limit: maxResponseBytes, observed, phase: "encoded" }
      );
    }
    chunks.push(body);
  }

  const encoded = Buffer.concat(chunks, observed);
  const gzipMagic = encoded.length >= 2 && encoded[0] === 0x1f && encoded[1] === 0x8b;
  if (!gzipMagic) {
    if (encoded.length > maxDecodedBytes) {
      throw new BoundedBodyError(
        `Response exceeded the ${maxDecodedBytes}-byte decoded body limit.`,
        { limit: maxDecodedBytes, observed: encoded.length, phase: "decoded" }
      );
    }
    return encoded;
  }

  let decoded;
  try {
    decoded = gunzipSync(encoded, { maxOutputLength: maxDecodedBytes + 1 });
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new BoundedBodyError(
        `Gzip response exceeded the ${maxDecodedBytes}-byte decoded body limit.`,
        { limit: maxDecodedBytes, observed: maxDecodedBytes + 1, phase: "decoded" }
      );
    }
    throw error;
  }
  if (decoded.length > maxDecodedBytes) {
    throw new BoundedBodyError(
      `Gzip response exceeded the ${maxDecodedBytes}-byte decoded body limit.`,
      { limit: maxDecodedBytes, observed: decoded.length, phase: "decoded" }
    );
  }
  return decoded;
}

export async function readBoundedResponseText(response, options) {
  const bytes = await readBoundedResponseBytes(response, options);
  return bytes.toString("utf8");
}

export function canonicalHistoricalGuid(value, baseUrl) {
  const source = String(value ?? "").normalize("NFKC").trim();
  if (!source) return null;
  if (/^(?:https?:)?\/\//i.test(source) || /^(?:\.{0,2}\/)/.test(source)) {
    const canonicalUrl = canonicalExternalUrl(source, baseUrl);
    if (canonicalUrl) return `url:${canonicalUrl}`;
  }
  if (/^urn:/i.test(source)) return `urn:${source.slice(4).trim().toLowerCase()}`;
  if (/^tag:/i.test(source)) return `tag:${source.slice(4).trim()}`;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(source)) return `uuid:${source.toLowerCase()}`;
  return `opaque:${source.replace(/\s+/g, " ")}`;
}

export function parseRobotsTxt(text) {
  const sitemapUrls = [];
  const groups = [];
  let currentGroups = [];
  let lastDirective = null;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "sitemap") {
      if (value) sitemapUrls.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (lastDirective !== "user-agent") currentGroups = [];
      const group = { userAgent: value.toLowerCase(), rules: [] };
      groups.push(group);
      currentGroups.push(group);
      lastDirective = field;
      continue;
    }
    if ((field === "allow" || field === "disallow") && currentGroups.length > 0) {
      for (const group of currentGroups) group.rules.push({ type: field, path: value });
      lastDirective = field;
    }
  }
  const wildcardRules = groups
    .filter((group) => group.userAgent === "*")
    .flatMap((group) => group.rules);
  return {
    sitemapUrls: [...new Set(sitemapUrls)],
    rules: wildcardRules
  };
}

export function robotsAllows(url, rules) {
  let pathname;
  try {
    const parsed = new URL(url);
    pathname = `${parsed.pathname}${parsed.search}`;
  } catch {
    return false;
  }
  const matches = (rules ?? [])
    .filter((rule) => rule.path && robotsPathMatches(pathname, rule.path))
    .sort((left, right) =>
      right.path.length - left.path.length ||
      (left.type === "allow" ? -1 : 1)
    );
  if (matches.length === 0) return true;
  return matches[0].type === "allow";
}

export function parseHistoricalDocument(text, {
  url,
  contentType = "",
  platform,
  target,
  seenItemKeys = [],
  robotsRules = [],
  maxItems = Infinity,
  discoveredAt = new Date().toISOString()
}) {
  if (target?.platform && target.platform !== platform) {
    throw new Error(
      `Historical parser platform ${platform} does not match target ${target.targetKey ?? target.entityId}:${target.platform}.`
    );
  }
  const seen = new Set(seenItemKeys);
  const documentKind = classifyHistoricalDocument(text, contentType, url);
  if (documentKind === "feed") {
    // A web crawl may reach a feed through a redirect, robots-declared URL, or
    // an official website configured directly as /feed.xml. Record that page
    // discovery in the web journal, but leave RSS-native items exclusively to
    // the independently planned RSS target. Emitting them here would attribute
    // one physical feed item to both entity-platform pairs and double-count it.
    if (platform !== "rss") {
      return {
        ...emptyParsedDocument("feed"),
        discoveredUrls: [{ url, kind: "feed" }]
      };
    }
    return parseFeed(text, { url, target, seen, maxItems, discoveredAt });
  }
  if (documentKind === "sitemap") {
    return parseSitemap(text, {
      url,
      target,
      platform,
      seen,
      robotsRules,
      maxItems,
      discoveredAt
    });
  }
  if (documentKind === "html") {
    return parseHtml(text, { url, target, platform, seen, discoveredAt });
  }
  return emptyParsedDocument("unsupported");
}

export async function runHistoricalBackfill({
  root = process.cwd(),
  outputDir,
  catalogs,
  batches,
  platforms,
  limits: limitOverrides,
  resume = false,
  fetch: fetchImplementation = globalThis.fetch,
  clock,
  signal,
  now = () => new Date(),
  onPageCommitted
} = {}) {
  if (!outputDir) throw new Error("runHistoricalBackfill requires an outputDir.");
  if (typeof fetchImplementation !== "function") throw new Error("A fetch implementation is required.");
  const loadedCatalogs = catalogs ?? await loadAutonomousCatalogs(root);
  const plan = buildHistoricalTargets(loadedCatalogs, { batches, platforms });
  const limits = normalizeHistoricalLimits(limitOverrides);
  const config = {
    schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
    runnerVersion: HISTORICAL_BACKFILL_RUNNER_VERSION,
    batches: plan.batches.map((batch) => batch.slug),
    platforms: plan.platforms,
    targetKeys: plan.targets.map((target) => target.targetKey),
    limits: publicLimits(limits)
  };
  const configFingerprint = sha256(stableJson(config));
  const store = await HistoricalCheckpointStore.open(resolve(outputDir), {
    config,
    configFingerprint,
    resume,
    now
  });
  const httpAttemptCounts = new Map();
  const http = createHttpPolicy({
    fetch: fetchImplementation,
    clock,
    globalConcurrency: limits.globalConcurrency,
    providerConcurrency: limits.hostConcurrency,
    providerPaceMs: limits.hostPaceMs,
    timeoutMs: limits.requestTimeoutMs,
    maxAttempts: limits.requestAttempts,
    circuitBreaker: {
      failureThreshold: limits.circuitFailureThreshold,
      cooldownMs: limits.circuitCooldownMs
    },
    onEvent(event) {
      if (event.phase !== "start") return;
      httpAttemptCounts.set(event.requestId, (httpAttemptCounts.get(event.requestId) ?? 0) + 1);
    }
  });
  const context = {
    http,
    httpAttemptCounts,
    nextHttpRequestId: 1,
    limits,
    store,
    signal,
    now,
    onPageCommitted
  };
  const pendingTargets = plan.targets.filter((target) => !store.isCompleted(target.targetKey));
  await runWorkerPool(pendingTargets, limits.globalConcurrency, async (target) => {
    throwIfAborted(signal);
    await collectHistoricalTarget(target, context);
  });
  const summary = buildRunSummary(plan, store.state, limits, now());
  await store.finish(summary);
  return summary;
}

async function collectHistoricalTarget(target, context) {
  if (!target.officialWebsite || !target.officialDomain) {
    await context.store.completeTarget(
      target,
      terminalReceipt(target, freshProgress(target, context.limits), {
        outcome: "manual_review",
        blocker: "official_website_missing_or_invalid",
        nextAction: "Verify and add the canonical public company website before historical collection.",
        coverageExtent: "not_started_missing_official_domain"
      })
    );
    return;
  }

  try {
    if (target.platform === "hacker_news") {
      await collectHackerNews(target, context);
    } else {
      await collectOfficialSiteHistory(target, context);
    }
  } catch (error) {
    if (isAbort(error) || context.signal?.aborted) throw error;
    const progress = context.store.progressFor(target.targetKey) ?? freshProgress(target, context.limits);
    await context.store.completeTarget(
      target,
      terminalReceipt(target, progress, blockerResolution(error, target))
    );
  }
}

async function collectHackerNews(target, context) {
  let progress = context.store.progressFor(target.targetKey) ?? freshProgress(target, context.limits);
  if (progress.truncated || progress.sourceExhausted) {
    await context.store.completeTarget(target, terminalReceipt(target, progress, {
      outcome: progress.accepted > 0
        ? "collected"
        : progress.truncated
          ? "access_blocked"
          : "verified_no_history",
      blocker: progress.truncated ? "hacker_news_source_limit_reached" : null,
      credentialRequired: false,
      nextAction: progress.truncated
        ? "Start a new explicitly higher-cap run and merge by canonical externalId."
        : "No action; the currently exposed Hacker News search history was exhausted.",
      coverageExtent: progress.truncated
        ? "bounded_search_results"
        : "all_available_search_results"
    }));
    return;
  }
  const seen = new Set(progress.seenItemKeys ?? []);
  let page = integerOr(progress.nextCursor, 0);

  while (page < context.limits.hnMaxPages && progress.itemsSeen < context.limits.hnMaxItems) {
    throwIfAborted(context.signal);
    const requestUrl = historicalHnSearchUrl(target, page, context.limits);
    let response;
    let requestAttempts = 0;
    try {
      const fetched = await historicalFetch(context, requestUrl);
      response = fetched.response;
      requestAttempts = fetched.requestAttempts;
    } catch (error) {
      progress = incrementRequest(progress, error.historicalRequestAttempts ?? 0, false);
      const resolution = blockerResolution(error, target);
      const receipt = pageReceipt(target, progress, {
        page,
        requestUrl,
        blocker: resolution.blocker,
        credentialRequired: resolution.credentialRequired,
        nextAction: resolution.nextAction,
        coverageExtent: "provider_request_blocked"
      });
      await commitPage(context, target, receipt, [], progress);
      await context.store.completeTarget(target, terminalReceipt(target, progress, resolution));
      return;
    }

    if (!response.ok) {
      progress = incrementRequest(progress, requestAttempts, true);
      const resolution = httpBlocker(response.status, requestUrl);
      const receipt = pageReceipt(target, progress, {
        page,
        requestUrl,
        blocker: resolution.blocker,
        credentialRequired: resolution.credentialRequired,
        nextAction: resolution.nextAction,
        coverageExtent: "provider_http_blocked"
      });
      await commitPage(context, target, receipt, [], progress);
      await context.store.completeTarget(target, terminalReceipt(target, progress, resolution));
      return;
    }

    let body;
    try {
      body = await readBoundedResponseText(response, context.limits);
    } catch (error) {
      progress = incrementRequest(progress, requestAttempts, true);
      const resolution = blockerResolution(error, target);
      const receipt = pageReceipt(target, progress, {
        page,
        requestUrl,
        blocker: resolution.blocker,
        credentialRequired: resolution.credentialRequired,
        nextAction: resolution.nextAction,
        coverageExtent: resolution.coverageExtent
      });
      await commitPage(context, target, receipt, [], progress);
      await context.store.completeTarget(target, terminalReceipt(target, progress, resolution));
      return;
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      progress = incrementRequest(progress, requestAttempts, true);
      const resolution = {
        outcome: "access_blocked",
        blocker: `invalid_hacker_news_json:${new URL(requestUrl).hostname}`,
        credentialRequired: false,
        nextAction: "Retry from the recorded page after the public provider returns valid JSON.",
        coverageExtent: "provider_response_invalid"
      };
      const receipt = pageReceipt(target, progress, {
        page,
        requestUrl,
        blocker: resolution.blocker,
        credentialRequired: false,
        nextAction: resolution.nextAction,
        coverageExtent: resolution.coverageExtent
      });
      await commitPage(context, target, receipt, [], progress);
      await context.store.completeTarget(target, terminalReceipt(target, progress, resolution));
      return;
    }
    const allHits = Array.isArray(payload.hits) ? payload.hits : [];
    const remainingItems = Math.max(0, context.limits.hnMaxItems - progress.itemsSeen);
    const hits = allHits.slice(0, remainingItems);
    const evidence = [];
    let rejected = 0;
    let duplicates = 0;
    let earliest = null;
    let latest = null;
    for (const hit of hits) {
      const key = String(hit?.objectID ?? hit?.story_id ?? "").trim();
      if (!key || !matchesHnCompanyStory(hit, target)) {
        rejected += 1;
        continue;
      }
      const identity = `hn:${key}`;
      if (seen.has(identity)) {
        duplicates += 1;
        continue;
      }
      seen.add(identity);
      const publishedAt = validIso(hit.created_at) ?? epochSecondsIso(hit.created_at_i);
      earliest = earlierDate(earliest, publishedAt);
      latest = laterDate(latest, publishedAt);
      evidence.push(hnEvidence(target, hit, identity, publishedAt, context.now()));
    }

    const totalPages = Math.max(0, integerOr(payload.nbPages, 0));
    const sourceExhausted = allHits.length === 0 || page + 1 >= totalPages;
    const reachedItemLimit = allHits.length > hits.length ||
      progress.itemsSeen + hits.length >= context.limits.hnMaxItems;
    const reachedPageLimit = page + 1 >= context.limits.hnMaxPages;
    const truncated = allHits.length > hits.length ||
      (!sourceExhausted && (reachedItemLimit || reachedPageLimit));
    const pageSourceExhausted = sourceExhausted && !truncated;
    const nextCursor = pageSourceExhausted || truncated ? null : page + 1;
    progress = updateProgress(progress, {
      pageItemsSeen: hits.length,
      pageAccepted: evidence.length,
      pageRejected: rejected,
      pageDuplicates: duplicates,
      earliest,
      latest,
      nextCursor,
      sourceExhausted: pageSourceExhausted,
      truncated,
      seenItemKeys: [...seen],
      requestAttempts
    });
    const receipt = pageReceipt(target, progress, {
      page,
      requestUrl,
      pageItemsSeen: hits.length,
      pageAccepted: evidence.length,
      pageRejected: rejected,
      pageDuplicates: duplicates,
      blocker: null,
      credentialRequired: false,
      nextAction: pageSourceExhausted
        ? "No further Hacker News search pages are available."
        : truncated
          ? "Start a new explicitly higher-cap run and merge by canonical externalId."
          : "Fetch the recorded Hacker News page cursor.",
      coverageExtent: pageSourceExhausted
        ? "all_available_search_results"
        : truncated
          ? "bounded_search_results"
          : "partial_search_results"
    });
    await commitPage(context, target, receipt, evidence, progress);
    if (pageSourceExhausted || truncated) break;
    page += 1;
  }

  const outcome = progress.accepted > 0
    ? "collected"
    : progress.truncated
      ? "access_blocked"
      : "verified_no_history";
  await context.store.completeTarget(target, terminalReceipt(target, progress, {
    outcome,
    blocker: progress.truncated ? "hacker_news_source_limit_reached" : null,
    credentialRequired: false,
    nextAction: progress.truncated
      ? "Start a new explicitly higher-cap run and merge by canonical externalId."
      : "No action; the currently exposed Hacker News search history was exhausted.",
    coverageExtent: progress.truncated
      ? "bounded_search_results"
      : "all_available_search_results"
  }));
}

async function collectOfficialSiteHistory(target, context) {
  let progress = context.store.progressFor(target.targetKey) ?? freshProgress(target, context.limits);
  const initialQueue = Array.isArray(progress.queue)
    ? [...progress.queue]
    : initialSiteQueue(target, target.platform);
  const seedTruncated = Boolean(progress.seedTruncated) ||
    initialQueue.length > context.limits.siteMaxUrls;
  const queue = initialQueue.slice(0, context.limits.siteMaxUrls);
  progress = { ...progress, seedTruncated };
  const queuedUrls = new Set(Array.isArray(progress.queuedUrls)
    ? progress.queuedUrls
    : queue.map((entry) => entry.url));
  const visitedUrls = new Set(progress.visitedUrls ?? []);
  const seenItemKeys = new Set(progress.seenItemKeys ?? []);
  let robotsRules = progress.robotsRules ?? [];
  let blockedByRobots = progress.blockedByRobots ?? 0;
  let depthLimited = progress.depthLimited ?? 0;

  while (queue.length > 0 && progress.pagesAttempted < context.limits.siteMaxResponses) {
    throwIfAborted(context.signal);
    const queueEntry = queue.shift();
    if (visitedUrls.has(queueEntry.url)) continue;
    if (queueEntry.depth > context.limits.siteMaxDepth) {
      depthLimited += 1;
      visitedUrls.add(queueEntry.url);
      continue;
    }
    if (queueEntry.kind !== "robots" && !robotsAllows(queueEntry.url, robotsRules)) {
      blockedByRobots += 1;
      visitedUrls.add(queueEntry.url);
      continue;
    }
    visitedUrls.add(queueEntry.url);

    let response;
    let requestAttempts = 0;
    try {
      const fetched = await historicalFetch(context, queueEntry.url);
      response = fetched.response;
      requestAttempts = fetched.requestAttempts;
    } catch (error) {
      const resolution = blockerResolution(error, target);
      if (queueEntry.kind === "robots") queue.length = 0;
      progress = updateSiteState(incrementRequest(
        progress,
        error.historicalRequestAttempts ?? 0,
        false
      ), {
        queue,
        queuedUrls,
        visitedUrls,
        seenItemKeys,
        robotsRules,
        blockedByRobots,
        nextCursor: queue[0]?.url ?? null,
        credentialRequired: progress.credentialRequired || resolution.credentialRequired,
        blocker: progress.blocker ?? resolution.blocker
      });
      const receipt = pageReceipt(target, progress, {
        page: progress.pagesAttempted - 1,
        requestUrl: queueEntry.url,
        pageType: queueEntry.kind,
        blocker: resolution.blocker,
        credentialRequired: resolution.credentialRequired,
        nextAction: queue.length > 0
          ? "Continue with the remaining bounded official-site discovery queue."
          : resolution.nextAction,
        coverageExtent: resolution.coverageExtent
      });
      await commitPage(context, target, receipt, [], progress);
      continue;
    }

    if (!response.ok) {
      const resolution = httpBlocker(response.status, queueEntry.url);
      const persistentBlocker = ![404, 410].includes(response.status);
      if (queueEntry.kind === "robots" && persistentBlocker) queue.length = 0;
      progress = updateSiteState(incrementRequest(progress, requestAttempts, true), {
        queue,
        queuedUrls,
        visitedUrls,
        seenItemKeys,
        robotsRules,
        blockedByRobots,
        nextCursor: queue[0]?.url ?? null,
        credentialRequired: progress.credentialRequired || resolution.credentialRequired,
        blocker: progress.blocker ?? (persistentBlocker ? resolution.blocker : null)
      });
      const receipt = pageReceipt(target, progress, {
        page: progress.pagesAttempted - 1,
        requestUrl: queueEntry.url,
        pageType: queueEntry.kind,
        blocker: resolution.blocker,
        credentialRequired: resolution.credentialRequired,
        nextAction: queue.length > 0
          ? "Continue with the remaining bounded official-site discovery queue."
          : resolution.nextAction,
        coverageExtent: "partial_official_site_discovery"
      });
      await commitPage(context, target, receipt, [], progress);
      continue;
    }

    const finalUrl = canonicalOfficialResourceUrl(response.url || queueEntry.url, target.officialDomain);
    if (!finalUrl) {
      if (queueEntry.kind === "robots") queue.length = 0;
      progress = updateSiteState(incrementRequest(progress, requestAttempts, true), {
        queue,
        queuedUrls,
        visitedUrls,
        seenItemKeys,
        robotsRules,
        blockedByRobots,
        nextCursor: queue[0]?.url ?? null,
        blocker: progress.blocker ?? "redirected_outside_verified_official_domain"
      });
      const receipt = pageReceipt(target, progress, {
        page: progress.pagesAttempted - 1,
        requestUrl: queueEntry.url,
        pageType: queueEntry.kind,
        blocker: "redirected_outside_verified_official_domain",
        credentialRequired: false,
        nextAction: "Manually review the off-domain redirect before trusting it as official history.",
        coverageExtent: "partial_official_site_discovery"
      });
      await commitPage(context, target, receipt, [], progress);
      continue;
    }

    let body;
    try {
      body = await readBoundedResponseText(response, context.limits);
    } catch (error) {
      const resolution = blockerResolution(error, target);
      if (queueEntry.kind === "robots") queue.length = 0;
      progress = updateSiteState(incrementRequest(progress, requestAttempts, true), {
        queue,
        queuedUrls,
        visitedUrls,
        seenItemKeys,
        robotsRules,
        blockedByRobots,
        nextCursor: queue[0]?.url ?? null,
        credentialRequired: progress.credentialRequired || resolution.credentialRequired,
        blocker: progress.blocker ?? resolution.blocker
      });
      const receipt = pageReceipt(target, progress, {
        page: progress.pagesAttempted - 1,
        requestUrl: finalUrl,
        pageType: queueEntry.kind,
        blocker: resolution.blocker,
        credentialRequired: resolution.credentialRequired,
        nextAction: queue.length > 0
          ? "Continue with the remaining bounded official-site discovery queue."
          : resolution.nextAction,
        coverageExtent: resolution.coverageExtent
      });
      await commitPage(context, target, receipt, [], progress);
      continue;
    }
    if (queueEntry.kind === "robots") {
      const robots = parseRobotsTxt(body);
      robotsRules = robots.rules;
      const discovered = robots.sitemapUrls
        .map((url) => siteQueueEntry(url, finalUrl, target, 1, "sitemap"))
        .filter(Boolean);
      const enqueueResult = enqueueSiteEntries(
        queue,
        queuedUrls,
        discovered,
        context.limits.siteMaxUrls
      );
      if (enqueueResult.truncated) queue.length = 0;
      progress = updateProgress(updateSiteState(progress, {
        queue,
        queuedUrls,
        visitedUrls,
        seenItemKeys,
        robotsRules,
        blockedByRobots,
        nextCursor: queue[0]?.url ?? null
      }), {
        pageItemsSeen: 0,
        pageAccepted: 0,
        pageRejected: 0,
        pageDuplicates: 0,
        nextCursor: enqueueResult.truncated ? null : queue[0]?.url ?? null,
        sourceExhausted: queue.length === 0 && !enqueueResult.truncated,
        truncated: enqueueResult.truncated,
        requestAttempts
      });
      const receipt = pageReceipt(target, progress, {
        page: progress.pagesAttempted - 1,
        requestUrl: finalUrl,
        pageType: "robots",
        pageItemsSeen: 0,
        pageAccepted: 0,
        pageRejected: 0,
        pageDuplicates: 0,
        blocker: null,
        credentialRequired: false,
        nextAction: enqueueResult.truncated
          ? "Start a new explicitly higher-cap run and merge by canonical externalId."
          : queue.length > 0
            ? "Continue with robots-declared and conventional official-site sources."
            : "No additional robots-declared source is available.",
        coverageExtent: enqueueResult.truncated
          ? "bounded_official_site_history"
          : "official_robots_evaluated"
      });
      await commitPage(context, target, receipt, [], progress);
      continue;
    }

    let parsed;
    try {
      parsed = parseHistoricalDocument(body, {
        url: finalUrl,
        contentType: response.headers.get("content-type") ?? "",
        platform: target.platform,
        target,
        seenItemKeys: [...seenItemKeys],
        robotsRules,
        maxItems: Math.max(0, context.limits.siteMaxItems - progress.itemsSeen),
        discoveredAt: context.now().toISOString()
      });
    } catch (error) {
      const resolution = {
        outcome: "access_blocked",
        blocker: `invalid_historical_document:${new URL(finalUrl).hostname}:${cleanText(error?.message, 300)}`,
        credentialRequired: false,
        nextAction: "Retry the recorded URL after validating its public XML/HTML response format.",
        coverageExtent: "provider_response_invalid"
      };
      progress = updateSiteState(incrementRequest(progress, requestAttempts, true), {
        queue,
        queuedUrls,
        visitedUrls,
        seenItemKeys,
        robotsRules,
        blockedByRobots,
        nextCursor: queue[0]?.url ?? null,
        blocker: progress.blocker ?? resolution.blocker
      });
      const receipt = pageReceipt(target, progress, {
        page: progress.pagesAttempted - 1,
        requestUrl: finalUrl,
        pageType: queueEntry.kind,
        blocker: resolution.blocker,
        credentialRequired: false,
        nextAction: queue.length > 0
          ? "Continue with the remaining bounded official-site discovery queue."
          : resolution.nextAction,
        coverageExtent: resolution.coverageExtent
      });
      await commitPage(context, target, receipt, [], progress);
      continue;
    }
    blockedByRobots += parsed.blockedByRobots ?? 0;
    for (const key of parsed.acceptedKeys) seenItemKeys.add(key);
    const discoveredEntries = parsed.discoveredUrls
      .map((entry) => siteQueueEntry(
        entry.url,
        finalUrl,
        target,
        queueEntry.depth + 1,
        entry.kind
      ))
      .filter(Boolean)
      .filter((entry) => target.platform === "rss"
        ? ["feed", "sitemap", "html"].includes(entry.kind)
        : entry.kind !== "feed");
    const enqueueResult = enqueueSiteEntries(
      queue,
      queuedUrls,
      discoveredEntries,
      context.limits.siteMaxUrls
    );
    const reachedUrlLimit = enqueueResult.truncated;
    const reachedItemLimit = parsed.itemLimitTruncated ||
      progress.itemsSeen + parsed.itemsSeen >= context.limits.siteMaxItems;
    const reachedResponseLimit = progress.pagesAttempted + 1 >= context.limits.siteMaxResponses;
    const sourceExhausted = queue.length === 0;
    const truncated = parsed.itemLimitTruncated ||
      (!sourceExhausted && (reachedUrlLimit || reachedItemLimit || reachedResponseLimit));
    const pageSourceExhausted = sourceExhausted && !truncated && parsed.blockedByRobots === 0;
    if (truncated) queue.length = 0;
    progress = updateProgress(updateSiteState(progress, {
      queue,
      queuedUrls,
      visitedUrls,
      seenItemKeys,
      robotsRules,
      blockedByRobots,
      nextCursor: truncated ? null : queue[0]?.url ?? null
    }), {
      pageItemsSeen: parsed.itemsSeen,
      pageAccepted: parsed.evidence.length,
      pageRejected: parsed.rejected,
      pageDuplicates: parsed.duplicates,
      earliest: parsed.earliest,
      latest: parsed.latest,
      nextCursor: truncated ? null : queue[0]?.url ?? null,
      sourceExhausted: pageSourceExhausted,
      truncated,
      requestAttempts
    });
    const receipt = pageReceipt(target, progress, {
      page: progress.pagesAttempted - 1,
      requestUrl: finalUrl,
      pageType: parsed.kind,
      pageItemsSeen: parsed.itemsSeen,
      pageAccepted: parsed.evidence.length,
      pageRejected: parsed.rejected,
      pageDuplicates: parsed.duplicates,
      blocker: parsed.blockedByRobots > 0
        ? `robots_txt_disallowed:${parsed.blockedByRobots}_document_items`
        : null,
      credentialRequired: false,
      nextAction: parsed.blockedByRobots > 0
        ? "Respect robots.txt; use an approved first-party feed/API or queue operator review."
        : pageSourceExhausted
          ? "No further official-site discovery URLs remain."
          : truncated
            ? "Start a new explicitly higher-cap run and merge by canonical externalId."
            : "Fetch the next recorded official-site discovery URL.",
      coverageExtent: parsed.blockedByRobots > 0
        ? "robots_policy_blocked"
        : pageSourceExhausted
          ? siteCompleteCoverage(target.platform)
          : truncated
            ? "bounded_official_site_history"
            : "partial_official_site_history"
    });
    await commitPage(context, target, receipt, parsed.evidence, progress);
    if (truncated) break;
  }

  const exhausted = queue.length === 0 && !progress.truncated;
  const truncated = progress.truncated || seedTruncated || depthLimited > 0 ||
    (!exhausted && progress.pagesAttempted >= context.limits.siteMaxResponses);
  progress = {
    ...progress,
    depthLimited,
    sourceExhausted: exhausted && !truncated,
    truncated,
    nextCursor: exhausted || truncated ? null : queue[0]?.url ?? null,
    queue: truncated ? [] : queue
  };
  const noEvidenceBlocker = progress.accepted === 0
    ? target.platform === "rss"
      ? "no_feed_entries_found_within_verified_official_sources"
      : "no_historical_pages_found_within_verified_official_sources"
    : null;
  const robotsBlocker = blockedByRobots > 0
    ? `robots_txt_disallowed:${blockedByRobots}_candidate_urls`
    : null;
  if (progress.blocker || progress.credentialRequired || robotsBlocker) {
    progress = { ...progress, sourceExhausted: false };
  }
  const terminalBlockers = [
    truncated ? "official_site_source_limit_reached" : null,
    progress.blocker,
    robotsBlocker,
    noEvidenceBlocker
  ].filter(Boolean);
  await context.store.completeTarget(target, terminalReceipt(target, progress, {
    outcome: progress.accepted > 0
      ? "collected"
      : truncated
        ? "access_blocked"
        : progress.credentialRequired
          ? "manual_review"
          : progress.blocker || robotsBlocker
            ? "access_blocked"
            : "verified_no_history",
    blocker: truncated
      ? "official_site_source_limit_reached"
      : progress.blocker ?? robotsBlocker ?? noEvidenceBlocker,
    blockers: terminalBlockers,
    credentialRequired: Boolean(progress.credentialRequired),
    nextAction: truncated
      ? "Start a new explicitly higher-cap run and merge by canonical externalId."
      : progress.credentialRequired
        ? "Provide credentials only if the company confirms the protected endpoint is its canonical history source."
        : robotsBlocker
          ? "Respect robots.txt; queue operator review or an approved first-party feed/API instead of bypassing the block."
          : progress.blocker
            ? "Resolve the exact recorded blocker, then start a new bounded run and merge by canonical externalId."
          : "No action; all discovered official-site sources within the configured policy were evaluated.",
    coverageExtent: truncated
      ? "bounded_official_site_history"
      : progress.credentialRequired
        ? "credential_review_required"
        : robotsBlocker
          ? "robots_policy_blocked"
          : progress.blocker
            ? "partial_official_site_history"
            : siteCompleteCoverage(target.platform)
  }));
}

function parseFeed(text, { url, target, seen, maxItems, discoveredAt }) {
  const $ = cheerio.load(text, { xmlMode: true, decodeEntities: true });
  const allNodes = $("item, entry").toArray();
  const nodes = allNodes.slice(0, maxItems);
  const evidence = [];
  const acceptedKeys = [];
  let rejected = 0;
  let duplicates = 0;
  let earliest = null;
  let latest = null;
  for (const node of nodes) {
    const item = $(node);
    const title = cleanText(item.find("title").first().text(), 500);
    const guidRaw = firstNonEmpty(
      item.find("guid").first().text(),
      item.find("id").first().text()
    );
    const atomLink = item.find("link[rel='alternate']").first().attr("href") ??
      item.find("link[href]").first().attr("href");
    const linkRaw = firstNonEmpty(atomLink, item.find("link").first().text());
    const canonicalLink = canonicalExternalUrl(linkRaw, url);
    const identity = canonicalHistoricalGuid(guidRaw || canonicalLink, url) ||
      fallbackItemIdentity(title, firstNonEmpty(
        item.find("pubDate").first().text(),
        item.find("published").first().text(),
        item.find("updated").first().text()
      ));
    if (!identity || (!title && !canonicalLink)) {
      rejected += 1;
      continue;
    }
    if (seen.has(identity)) {
      duplicates += 1;
      continue;
    }
    seen.add(identity);
    acceptedKeys.push(identity);
    const publishedAt = validIso(firstNonEmpty(
      item.find("pubDate").first().text(),
      item.find("published").first().text(),
      item.find("updated").first().text(),
      item.find("date").first().text(),
      item.find("dc\\:date").first().text()
    ));
    earliest = earlierDate(earliest, publishedAt);
    latest = laterDate(latest, publishedAt);
    evidence.push({
      ...evidenceBase(target, "rss"),
      externalId: identity,
      sourceUrl: url,
      canonicalUrl: canonicalLink ?? url,
      title: title || null,
      text: cleanText(firstNonEmpty(
        item.find("description").first().text(),
        item.find("summary").first().text(),
        item.find("content").first().text(),
        item.find("content\\:encoded").first().text()
      ), 2_000) || null,
      publishedAt,
      author: cleanText(firstNonEmpty(
        item.find("author name").first().text(),
        item.find("author").first().text(),
        item.find("creator").first().text(),
        item.find("dc\\:creator").first().text()
      ), 300) || null,
      discoveredAt,
      discoveryMethod: "verified_official_feed"
    });
  }
  return {
    kind: "feed",
    itemsSeen: nodes.length,
    evidence,
    acceptedKeys,
    rejected,
    duplicates,
    earliest,
    latest,
    discoveredUrls: [],
    itemLimitTruncated: allNodes.length > nodes.length,
    blockedByRobots: 0
  };
}

function parseSitemap(text, {
  url,
  target,
  platform,
  seen,
  robotsRules,
  maxItems,
  discoveredAt
}) {
  const $ = cheerio.load(text, { xmlMode: true, decodeEntities: true });
  const isIndex = $("sitemapindex").length > 0 || $("sitemap").length > 0;
  const allRows = (isIndex ? $("sitemap") : $("url")).toArray();
  const rows = allRows.slice(0, maxItems);
  const evidence = [];
  const acceptedKeys = [];
  const discoveredUrls = [];
  let rejected = 0;
  let duplicates = 0;
  let blockedByRobots = 0;
  let earliest = null;
  let latest = null;
  for (const row of rows) {
    const node = $(row);
    const rawLocation = node.find("loc").first().text();
    const location = canonicalOfficialResourceUrl(rawLocation, target.officialDomain, url);
    if (!location) {
      if (!isIndex && platform === "web") rejected += 1;
      continue;
    }
    if (!robotsAllows(location, robotsRules)) {
      blockedByRobots += 1;
      if (!isIndex && platform === "web") rejected += 1;
      continue;
    }
    if (isIndex || SITEMAP_PATH.test(new URL(location).pathname)) {
      discoveredUrls.push({ url: location, kind: "sitemap" });
      continue;
    }
    if (platform === "rss") {
      if (FEED_PATH.test(new URL(location).pathname)) {
        discoveredUrls.push({ url: location, kind: "feed" });
      }
      continue;
    }
    if (!isHistoricalUrl(location)) {
      rejected += 1;
      continue;
    }
    discoveredUrls.push({ url: location, kind: "html" });
    const identity = `web:${location}`;
    if (seen.has(identity)) {
      duplicates += 1;
      continue;
    }
    seen.add(identity);
    acceptedKeys.push(identity);
    const publishedAt = validIso(node.find("lastmod").first().text());
    earliest = earlierDate(earliest, publishedAt);
    latest = laterDate(latest, publishedAt);
    evidence.push({
      ...evidenceBase(target, "web"),
      externalId: identity,
      sourceUrl: url,
      canonicalUrl: location,
      title: null,
      text: null,
      publishedAt,
      author: null,
      discoveredAt,
      discoveryMethod: "verified_official_sitemap"
    });
  }
  return {
    kind: "sitemap",
    itemsSeen: isIndex || platform === "rss" ? 0 : evidence.length + rejected + duplicates,
    evidence,
    acceptedKeys,
    rejected,
    duplicates,
    earliest,
    latest,
    discoveredUrls,
    itemLimitTruncated: allRows.length > rows.length,
    blockedByRobots
  };
}

function parseHtml(text, { url, target, platform, seen, discoveredAt }) {
  const $ = cheerio.load(text);
  const discoveredUrls = [];
  for (const element of $("link[href], a[href]").toArray()) {
    const node = $(element);
    const raw = node.attr("href");
    const location = canonicalOfficialResourceUrl(raw, target.officialDomain, url);
    if (!location) {
      continue;
    }
    const rel = String(node.attr("rel") ?? "").toLowerCase();
    const type = String(node.attr("type") ?? "").toLowerCase();
    const pathname = new URL(location).pathname;
    if ((rel.includes("alternate") && FEED_CONTENT_TYPES.test(type)) || FEED_PATH.test(pathname)) {
      discoveredUrls.push({ url: location, kind: "feed" });
    } else if (SITEMAP_PATH.test(pathname)) {
      discoveredUrls.push({ url: location, kind: "sitemap" });
    } else if (HISTORICAL_PATH.test(pathname)) {
      discoveredUrls.push({ url: location, kind: "html" });
    }
  }

  const evidence = [];
  const acceptedKeys = [];
  let duplicates = 0;
  let earliest = null;
  let latest = null;
  if (platform === "web" && isHistoricalUrl(url)) {
    const canonicalRaw = $("link[rel='canonical']").first().attr("href");
    const canonicalUrl = canonicalOfficialResourceUrl(canonicalRaw, target.officialDomain, url) ?? url;
    const identity = `web:${canonicalUrl}`;
    if (seen.has(identity)) {
      duplicates += 1;
    } else {
      seen.add(identity);
      acceptedKeys.push(identity);
      const publishedAt = validIso(firstNonEmpty(
        $("meta[property='article:published_time']").attr("content"),
        $("meta[name='date']").attr("content"),
        $("time[datetime]").first().attr("datetime")
      ));
      earliest = publishedAt;
      latest = publishedAt;
      evidence.push({
        ...evidenceBase(target, "web"),
        externalId: identity,
        sourceUrl: url,
        canonicalUrl,
        title: cleanText(firstNonEmpty(
          $("meta[property='og:title']").attr("content"),
          $("title").first().text(),
          $("h1").first().text()
        ), 500) || null,
        text: cleanText(firstNonEmpty(
          $("meta[name='description']").attr("content"),
          $("meta[property='og:description']").attr("content")
        ), 2_000) || null,
        publishedAt,
        author: cleanText(firstNonEmpty(
          $("meta[name='author']").attr("content"),
          $("meta[property='article:author']").attr("content")
        ), 300) || null,
        discoveredAt,
        discoveryMethod: "verified_official_web_page"
      });
    }
  }
  return {
    kind: "html",
    itemsSeen: platform === "web" && isHistoricalUrl(url) ? 1 : 0,
    evidence,
    acceptedKeys,
    rejected: 0,
    duplicates,
    earliest,
    latest,
    discoveredUrls: dedupeDiscoveredUrls(discoveredUrls),
    itemLimitTruncated: false,
    blockedByRobots: 0
  };
}

function emptyParsedDocument(kind) {
  return {
    kind,
    itemsSeen: 0,
    evidence: [],
    acceptedKeys: [],
    rejected: 0,
    duplicates: 0,
    earliest: null,
    latest: null,
    discoveredUrls: [],
    itemLimitTruncated: false,
    blockedByRobots: 0
  };
}

function classifyHistoricalDocument(text, contentType, url) {
  const prefix = String(text ?? "").trimStart().slice(0, 500).toLowerCase();
  if (/<(?:rss|feed|rdf:rdf)\b/i.test(prefix) || FEED_CONTENT_TYPES.test(contentType) && /<(?:item|entry)\b/i.test(text)) {
    return "feed";
  }
  if (/<(?:sitemapindex|urlset)\b/i.test(prefix) || SITEMAP_PATH.test(new URL(url).pathname)) {
    return "sitemap";
  }
  if (HTML_CONTENT_TYPES.test(contentType) || /<(?:!doctype\s+html|html|head|body)\b/i.test(prefix)) {
    return "html";
  }
  return "unsupported";
}

function initialSiteQueue(target, platform) {
  const base = new URL(target.officialWebsite);
  const origin = base.origin;
  const candidates = [
    { url: `${origin}/robots.txt`, depth: 0, kind: "robots" },
    { url: target.officialWebsite, depth: 0, kind: "html" },
    { url: `${origin}/sitemap.xml`, depth: 0, kind: "sitemap" },
    { url: `${origin}/sitemap_index.xml`, depth: 0, kind: "sitemap" },
    { url: `${origin}/wp-sitemap.xml`, depth: 0, kind: "sitemap" }
  ];
  if (platform === "rss") {
    candidates.push(
      { url: `${origin}/feed`, depth: 0, kind: "feed" },
      { url: `${origin}/feed.xml`, depth: 0, kind: "feed" },
      { url: `${origin}/rss.xml`, depth: 0, kind: "feed" },
      { url: `${origin}/atom.xml`, depth: 0, kind: "feed" },
      { url: `${origin}/blog/feed`, depth: 0, kind: "feed" },
      { url: `${origin}/news/feed`, depth: 0, kind: "feed" }
    );
  }
  for (const path of ["/blog", "/news", "/press", "/changelog", "/updates", "/archive"]) {
    candidates.push({ url: `${origin}${path}`, depth: 0, kind: "html" });
  }
  return dedupeQueue(candidates);
}

function siteQueueEntry(rawUrl, baseUrl, target, depth, kind) {
  if (depth > Number.MAX_SAFE_INTEGER) return null;
  const url = canonicalOfficialResourceUrl(rawUrl, target.officialDomain, baseUrl);
  if (!url) return null;
  return { url, depth, kind: normalizedQueueKind(kind, url) };
}

function normalizedQueueKind(kind, url) {
  if (kind === "robots") return "robots";
  const pathname = new URL(url).pathname;
  if (SITEMAP_PATH.test(pathname)) return "sitemap";
  if (FEED_PATH.test(pathname)) return "feed";
  return kind === "sitemap" || kind === "feed" ? kind : "html";
}

function enqueueSiteEntries(queue, queuedUrls, entries, maxUrls) {
  let added = 0;
  let duplicates = 0;
  let truncated = false;
  for (const entry of entries) {
    if (queuedUrls.has(entry.url)) {
      duplicates += 1;
      continue;
    }
    if (queuedUrls.size >= maxUrls) {
      truncated = true;
      break;
    }
    queuedUrls.add(entry.url);
    queue.push(entry);
    added += 1;
  }
  return { added, duplicates, truncated };
}

async function historicalFetch(context, url) {
  throwIfAborted(context.signal);
  const parsed = new URL(url);
  const requestId = `historical:${context.nextHttpRequestId++}:${sha256(url).slice(0, 20)}`;
  try {
    const response = await context.http.fetch(url, {
      headers: {
        accept: "application/json, application/xml, text/xml, application/rss+xml, application/atom+xml, text/html;q=0.9, text/plain;q=0.8",
        "user-agent": "ReturnerFundHistoricalBackfill/1.0 (+public-evidence-audit)"
      },
      signal: context.signal
    }, {
      provider: parsed.hostname.toLowerCase(),
      requestId
    });
    return {
      response,
      requestAttempts: context.httpAttemptCounts.get(requestId) ?? 0
    };
  } catch (error) {
    try {
      error.historicalRequestAttempts = context.httpAttemptCounts.get(requestId) ?? 0;
    } catch {
      // A frozen provider error still carries its exact blocker; attempt count falls back to zero.
    }
    throw error;
  } finally {
    context.httpAttemptCounts.delete(requestId);
  }
}

async function commitPage(context, target, receipt, evidence, progress) {
  await context.store.commitPage(target, receipt, evidence, progress);
  if (typeof context.onPageCommitted === "function") {
    await context.onPageCommitted({ target, receipt, evidence, progress });
  }
}

function freshProgress(target, limits) {
  return {
    targetKey: target.targetKey,
    platform: target.platform,
    pagesAttempted: 0,
    pagesFetched: 0,
    requests: 0,
    itemsSeen: 0,
    accepted: 0,
    rejected: 0,
    duplicates: 0,
    earliest: null,
    latest: null,
    nextCursor: target.platform === "hacker_news" ? 0 : null,
    sourceExhausted: false,
    truncated: false,
    credentialRequired: false,
    blocker: null,
    sourceLimit: sourceLimitFor(target.platform, limits),
    seenItemKeys: []
  };
}

function incrementRequest(progress, requestAttempts = 1, fetched = false) {
  return {
    ...progress,
    pagesAttempted: progress.pagesAttempted + 1,
    pagesFetched: progress.pagesFetched + (fetched ? 1 : 0),
    requests: progress.requests + requestAttempts
  };
}

function updateProgress(progress, {
  pageItemsSeen = 0,
  pageAccepted = 0,
  pageRejected = 0,
  pageDuplicates = 0,
  earliest = null,
  latest = null,
  nextCursor = progress.nextCursor,
  sourceExhausted = progress.sourceExhausted,
  truncated = progress.truncated,
  seenItemKeys = progress.seenItemKeys,
  requestAttempts = 1
}) {
  return {
    ...progress,
    pagesAttempted: progress.pagesAttempted + 1,
    pagesFetched: progress.pagesFetched + 1,
    requests: progress.requests + requestAttempts,
    itemsSeen: progress.itemsSeen + pageItemsSeen,
    accepted: progress.accepted + pageAccepted,
    rejected: progress.rejected + pageRejected,
    duplicates: progress.duplicates + pageDuplicates,
    earliest: earlierDate(progress.earliest, earliest),
    latest: laterDate(progress.latest, latest),
    nextCursor,
    sourceExhausted,
    truncated: progress.truncated || truncated,
    seenItemKeys
  };
}

function updateSiteState(progress, {
  queue,
  queuedUrls,
  visitedUrls,
  seenItemKeys,
  robotsRules,
  blockedByRobots,
  nextCursor,
  credentialRequired = progress.credentialRequired,
  blocker = progress.blocker
}) {
  return {
    ...progress,
    queue: [...queue],
    queuedUrls: [...queuedUrls],
    visitedUrls: [...visitedUrls],
    seenItemKeys: [...seenItemKeys],
    robotsRules,
    blockedByRobots,
    nextCursor,
    credentialRequired,
    blocker
  };
}

function pageReceipt(target, progress, {
  page,
  requestUrl,
  pageType = target.platform === "hacker_news" ? "search_by_date" : null,
  pageItemsSeen = 0,
  pageAccepted = 0,
  pageRejected = 0,
  pageDuplicates = 0,
  blocker,
  credentialRequired,
  nextAction,
  coverageExtent
}) {
  return {
    schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
    runnerVersion: HISTORICAL_BACKFILL_RUNNER_VERSION,
    receiptType: "page",
    provider: target.platform,
    platform: target.platform,
    batchSlug: target.batchSlug,
    entityType: target.entityType,
    entityId: target.entityId,
    entityName: target.entityName,
    officialDomain: target.officialDomain,
    page,
    pageType,
    requestUrl,
    windowStart: progress.earliest,
    windowEnd: progress.latest,
    pagesAttempted: progress.pagesAttempted,
    pagesFetched: progress.pagesFetched,
    requests: progress.requests,
    itemsSeen: progress.itemsSeen,
    accepted: progress.accepted,
    rejected: progress.rejected,
    duplicates: progress.duplicates,
    pageItemsSeen,
    pageAccepted,
    pageRejected,
    pageDuplicates,
    earliest: progress.earliest,
    latest: progress.latest,
    nextCursor: progress.nextCursor,
    sourceExhausted: Boolean(progress.sourceExhausted),
    truncated: Boolean(progress.truncated),
    sourceLimit: progress.sourceLimit,
    credentialRequired: Boolean(credentialRequired),
    blocker: blocker ?? null,
    blockers: blocker ? [blocker] : [],
    nextAction,
    coverageExtent
  };
}

function terminalReceipt(target, progress, {
  outcome,
  blocker = null,
  blockers = blocker ? [blocker] : [],
  credentialRequired = false,
  nextAction,
  coverageExtent
}) {
  return {
    schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
    runnerVersion: HISTORICAL_BACKFILL_RUNNER_VERSION,
    receiptType: "target",
    provider: target.platform,
    platform: target.platform,
    batchSlug: target.batchSlug,
    entityType: target.entityType,
    entityId: target.entityId,
    entityName: target.entityName,
    officialDomain: target.officialDomain,
    outcome,
    windowStart: progress.earliest,
    windowEnd: progress.latest,
    pagesAttempted: progress.pagesAttempted,
    pagesFetched: progress.pagesFetched,
    requests: progress.requests,
    itemsSeen: progress.itemsSeen,
    accepted: progress.accepted,
    rejected: progress.rejected,
    duplicates: progress.duplicates,
    earliest: progress.earliest,
    latest: progress.latest,
    nextCursor: progress.nextCursor,
    sourceExhausted: Boolean(progress.sourceExhausted),
    truncated: Boolean(progress.truncated),
    sourceLimit: progress.sourceLimit,
    credentialRequired: Boolean(credentialRequired),
    blocker,
    blockers: [...new Set(blockers.filter(Boolean))],
    nextAction,
    coverageExtent
  };
}

function blockerResolution(error, target) {
  if (error instanceof CircuitOpenError) {
    return {
      outcome: "access_blocked",
      blocker: `circuit_open:${error.provider}:retry_at=${new Date(error.retryAt).toISOString()}`,
      credentialRequired: false,
      nextAction: "Resume after the recorded circuit-breaker cooldown; do not increase concurrency.",
      coverageExtent: "provider_circuit_open"
    };
  }
  if (error instanceof BoundedBodyError) {
    return {
      outcome: "access_blocked",
      blocker: `bounded_body_limit_exceeded:phase=${error.phase}:limit=${error.limit}:observed=${error.observed}`,
      credentialRequired: false,
      nextAction: "Manually review the endpoint before raising the bounded response limit.",
      coverageExtent: "response_body_rejected_by_safety_limit"
    };
  }
  const cleanMessage = cleanText(error?.message ?? String(error), 500);
  return {
    outcome: "access_blocked",
    blocker: `request_error:${error?.name ?? "Error"}:${cleanMessage}`,
    credentialRequired: false,
    nextAction: `Retry the ${target.platform} target from its recorded checkpoint after diagnosing the exact request error.`,
    coverageExtent: "provider_request_failed"
  };
}

function httpBlocker(status, url) {
  const credentialRequired = status === 401 || status === 407;
  return {
    outcome: credentialRequired ? "manual_review" : "access_blocked",
    blocker: `http_${status}:${new URL(url).hostname}`,
    credentialRequired,
    nextAction: credentialRequired
      ? "Queue for credential review; do not use personal or signed-in browser sessions."
      : status === 403
        ? "Record the host policy block and use an approved public API or request operator review."
        : "Retry from the checkpoint only after the endpoint or network condition is healthy.",
    coverageExtent: "provider_http_blocked"
  };
}

class HistoricalCheckpointStore {
  static async open(outputDir, options) {
    const store = new HistoricalCheckpointStore(outputDir, options);
    await store.initialize();
    return store;
  }

  constructor(outputDir, { config, configFingerprint, resume, now }) {
    this.outputDir = outputDir;
    this.journalPath = join(outputDir, "pages.ndjson");
    this.checkpointPath = join(outputDir, "checkpoint-current.json");
    this.summaryPath = join(outputDir, "summary.json");
    this.config = config;
    this.configFingerprint = configFingerprint;
    this.resume = resume;
    this.now = now;
    this.writeTail = Promise.resolve();
    this.state = null;
  }

  async initialize() {
    await mkdir(this.outputDir, { recursive: true });
    const existingCheckpoint = await readJsonIfExists(this.checkpointPath);
    const journalExists = await fileExists(this.journalPath);
    if (!this.resume && (existingCheckpoint || journalExists)) {
      throw new Error(
        `Historical output already exists at ${this.outputDir}; use --resume or choose a new --output-dir.`
      );
    }
    if (this.resume && !existingCheckpoint && !journalExists) {
      throw new Error(`No resumable historical checkpoint exists at ${this.outputDir}.`);
    }
    const startedAt = this.now().toISOString();
    this.state = existingCheckpoint ?? {
      schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
      runnerVersion: HISTORICAL_BACKFILL_RUNNER_VERSION,
      config: this.config,
      configFingerprint: this.configFingerprint,
      startedAt,
      updatedAt: startedAt,
      lastSequence: 0,
      progress: {},
      completed: {}
    };
    if (this.state.configFingerprint !== this.configFingerprint) {
      throw new Error(
        "Historical resume configuration does not match the original batch/platform/limit fingerprint."
      );
    }
    let journalHasContent = journalExists && (await stat(this.journalPath)).size > 0;
    if (journalHasContent) {
      const repairedTail = await repairTruncatedJournalTail(this.journalPath);
      if (repairedTail) this.state.recoveredTruncatedJournalTail = true;
      journalHasContent = (await stat(this.journalPath)).size > 0;
    }
    if (journalHasContent) await this.replayJournal();
    if (!journalHasContent) {
      const event = await this.appendEvent({
        type: "run_initialized",
        config: this.config,
        configFingerprint: this.configFingerprint,
        startedAt
      });
      this.applyEvent(event);
    }
    await this.writeCheckpoint();
  }

  isCompleted(targetKey) {
    return Boolean(this.state.completed[targetKey]);
  }

  progressFor(targetKey) {
    const progress = this.state.progress[targetKey];
    return progress ? structuredClone(progress) : null;
  }

  async commitPage(target, receipt, evidence, progress) {
    return this.enqueueWrite(async () => {
      const event = await this.appendEvent({
        type: "page_checkpoint",
        targetKey: target.targetKey,
        receipt,
        evidence,
        progress
      });
      this.applyEvent(event);
      await this.writeCheckpoint();
    });
  }

  async completeTarget(target, receipt) {
    return this.enqueueWrite(async () => {
      const event = await this.appendEvent({
        type: "target_completed",
        targetKey: target.targetKey,
        receipt
      });
      this.applyEvent(event);
      await this.writeCheckpoint();
    });
  }

  async finish(summary) {
    await this.enqueueWrite(async () => {
      const event = await this.appendEvent({ type: "run_completed", summary });
      this.applyEvent(event);
      await atomicJsonWrite(this.summaryPath, summary);
      await this.writeCheckpoint();
    });
  }

  enqueueWrite(operation) {
    const promise = this.writeTail.then(operation, operation);
    this.writeTail = promise.catch(() => {});
    return promise;
  }

  async appendEvent(payload) {
    const event = {
      schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
      sequence: this.state.lastSequence + 1,
      recordedAt: this.now().toISOString(),
      ...payload
    };
    await appendFile(this.journalPath, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
    return event;
  }

  applyEvent(event) {
    if (!Number.isInteger(event.sequence) || event.sequence <= this.state.lastSequence) return;
    if (event.type === "page_checkpoint") {
      this.state.progress[event.targetKey] = event.progress;
    } else if (event.type === "target_completed") {
      delete this.state.progress[event.targetKey];
      this.state.completed[event.targetKey] = event.receipt;
    } else if (event.type === "run_completed") {
      this.state.status = "completed";
    }
    this.state.lastSequence = event.sequence;
    this.state.updatedAt = event.recordedAt;
  }

  async replayJournal() {
    const input = createReadStream(this.journalPath, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let pendingLine = null;
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (pendingLine != null) this.applyJournalLine(pendingLine);
      pendingLine = line;
    }
    if (pendingLine != null) this.applyJournalLine(pendingLine);
  }

  applyJournalLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`Historical journal contains invalid NDJSON near sequence ${this.state.lastSequence + 1}.`);
    }
    if (event.type === "run_initialized") {
      if (event.configFingerprint !== this.configFingerprint) {
        throw new Error("Historical journal fingerprint does not match the requested resume configuration.");
      }
      if (event.sequence > this.state.lastSequence) {
        this.state.lastSequence = event.sequence;
        this.state.updatedAt = event.recordedAt;
        this.state.startedAt = event.startedAt ?? this.state.startedAt;
      }
      return;
    }
    this.applyEvent(event);
  }

  async writeCheckpoint() {
    await atomicJsonWrite(this.checkpointPath, this.state);
  }
}

function buildRunSummary(plan, state, limits, completedAt) {
  const receipts = Object.values(state.completed);
  const byPlatform = {};
  const byBatch = {};
  const totals = emptyReceiptTotals();
  for (const receipt of receipts) {
    addReceiptTotals(totals, receipt);
    byPlatform[receipt.platform] ??= emptyReceiptTotals();
    byBatch[receipt.batchSlug] ??= emptyReceiptTotals();
    addReceiptTotals(byPlatform[receipt.platform], receipt);
    addReceiptTotals(byBatch[receipt.batchSlug], receipt);
  }
  return {
    schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
    runnerVersion: HISTORICAL_BACKFILL_RUNNER_VERSION,
    startedAt: state.startedAt,
    completedAt: completedAt.toISOString(),
    status: receipts.length === plan.targetPlatformPairs ? "completed" : "incomplete",
    companiesEvaluated: plan.companiesEvaluated,
    targetPlatformPairs: plan.targetPlatformPairs,
    completedTargetPlatformPairs: receipts.length,
    missingOfficialWebsites: plan.missingOfficialWebsites,
    platforms: plan.platforms,
    batches: plan.batches,
    totals,
    byPlatform,
    byBatch,
    limits: publicLimits(limits),
    artifacts: {
      pageCheckpointJournal: "pages.ndjson",
      currentCheckpoint: "checkpoint-current.json",
      summary: "summary.json"
    }
  };
}

function emptyReceiptTotals() {
  return {
    targets: 0,
    collected: 0,
    verifiedNoHistory: 0,
    accessBlocked: 0,
    manualReview: 0,
    credentialRequired: 0,
    truncated: 0,
    requests: 0,
    pagesAttempted: 0,
    pagesFetched: 0,
    itemsSeen: 0,
    accepted: 0,
    rejected: 0,
    duplicates: 0,
    earliest: null,
    latest: null
  };
}

function addReceiptTotals(total, receipt) {
  total.targets += 1;
  if (receipt.outcome === "collected") total.collected += 1;
  else if (receipt.outcome === "verified_no_history") total.verifiedNoHistory += 1;
  else if (receipt.outcome === "access_blocked") total.accessBlocked += 1;
  else if (receipt.outcome === "manual_review") total.manualReview += 1;
  if (receipt.credentialRequired) total.credentialRequired += 1;
  if (receipt.truncated) total.truncated += 1;
  for (const field of [
    "requests",
    "pagesAttempted",
    "pagesFetched",
    "itemsSeen",
    "accepted",
    "rejected",
    "duplicates"
  ]) {
    total[field] += Number(receipt[field] ?? 0);
  }
  total.earliest = earlierDate(total.earliest, receipt.earliest);
  total.latest = laterDate(total.latest, receipt.latest);
}

async function runWorkerPool(items, concurrency, worker) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(workers);
}

function normalizeHistoricalLimits(overrides = {}) {
  const limits = { ...HISTORICAL_BACKFILL_LIMITS, ...(overrides ?? {}) };
  for (const key of Object.keys(HISTORICAL_BACKFILL_LIMITS)) {
    const value = Number(limits[key]);
    if (!Number.isFinite(value) || value < 0 || (key !== "hostPaceMs" && value === 0)) {
      throw new Error(`Historical limit ${key} must be a ${key === "hostPaceMs" ? "non-negative" : "positive"} number.`);
    }
    limits[key] = Math.floor(value);
  }
  if (limits.hostConcurrency !== 1) {
    throw new Error("Historical hostConcurrency is fixed at 1 to protect public hosts.");
  }
  if (limits.globalConcurrency > 8) {
    throw new Error("Historical globalConcurrency cannot exceed the safe maximum of 8.");
  }
  return limits;
}

function publicLimits(limits) {
  return {
    globalConcurrency: limits.globalConcurrency,
    hostConcurrency: limits.hostConcurrency,
    hostPaceMs: limits.hostPaceMs,
    requestTimeoutMs: limits.requestTimeoutMs,
    requestAttempts: limits.requestAttempts,
    circuitFailureThreshold: limits.circuitFailureThreshold,
    circuitCooldownMs: limits.circuitCooldownMs,
    maxResponseBytes: limits.maxResponseBytes,
    maxDecodedBytes: limits.maxDecodedBytes,
    hnHitsPerPage: limits.hnHitsPerPage,
    hnMaxPages: limits.hnMaxPages,
    hnMaxItems: limits.hnMaxItems,
    siteMaxDepth: limits.siteMaxDepth,
    siteMaxUrls: limits.siteMaxUrls,
    siteMaxResponses: limits.siteMaxResponses,
    siteMaxItems: limits.siteMaxItems
  };
}

function sourceLimitFor(platform, limits) {
  return platform === "hacker_news"
    ? { maxPages: limits.hnMaxPages, maxItems: limits.hnMaxItems, hitsPerPage: limits.hnHitsPerPage }
    : {
        maxDepth: limits.siteMaxDepth,
        maxUrls: limits.siteMaxUrls,
        maxResponses: limits.siteMaxResponses,
        maxItems: limits.siteMaxItems,
        maxResponseBytes: limits.maxResponseBytes,
        maxDecodedBytes: limits.maxDecodedBytes
      };
}

function evidenceBase(target, platform) {
  return {
    schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
    collector: "historical-backfill",
    platform,
    batchSlug: target.batchSlug,
    entityType: "company",
    entityId: target.entityId,
    entityName: target.entityName,
    companyName: target.companyName,
    companySlug: target.companySlug,
    officialDomain: target.officialDomain
  };
}

function hnEvidence(target, hit, identity, publishedAt, discoveredAt) {
  const sourceUrl = `https://news.ycombinator.com/item?id=${encodeURIComponent(String(hit.objectID))}`;
  return {
    ...evidenceBase(target, "hacker_news"),
    externalId: identity,
    sourceUrl,
    canonicalUrl: canonicalExternalUrl(hit.url ?? hit.story_url) ?? sourceUrl,
    title: cleanText(hit.title ?? hit.story_title, 500) || null,
    text: cleanText(hit.story_text ?? hit.comment_text, 2_000) || null,
    publishedAt,
    author: cleanText(hit.author, 300) || null,
    discoveredAt: discoveredAt.toISOString(),
    discoveryMethod: "hn_algolia_search_by_date_exact_name_and_official_domain"
  };
}

function canonicalOfficialWebsite(rawUrl) {
  const source = String(rawUrl ?? "").trim();
  const url = canonicalExternalUrl(
    source && !/^[a-z][a-z0-9+.-]*:/i.test(source) ? `https://${source}` : source
  );
  if (!url) return null;
  const parsed = new URL(url);
  if (!isPublicHostname(parsed.hostname)) return null;
  parsed.pathname = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
}

function canonicalOfficialResourceUrl(rawUrl, officialDomain, baseUrl) {
  const url = canonicalExternalUrl(rawUrl, baseUrl);
  if (!url) return null;
  const parsed = new URL(url);
  if (!isPublicHostname(parsed.hostname)) return null;
  return urlMatchesOfficialDomain(url, officialDomain) ? url : null;
}

function canonicalExternalUrl(rawUrl, baseUrl) {
  const source = String(rawUrl ?? "").trim();
  if (!source) return null;
  let url;
  try {
    url = baseUrl ? new URL(source, baseUrl) : new URL(source);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  if (url.username || url.password) return null;
  if ((url.protocol === "https:" && url.port && url.port !== "443") ||
      (url.protocol === "http:" && url.port && url.port !== "80")) return null;
  if (!isPublicHostname(url.hostname)) return null;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

function isPublicHostname(hostname) {
  const host = normalizedHostname(hostname);
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const [a, b] = host.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (ipVersion === 6) {
    return !(host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb"));
  }
  return host.includes(".");
}

function normalizedHostname(value) {
  return String(value ?? "").trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function urlMatchesOfficialDomain(rawUrl, officialDomain) {
  try {
    const host = normalizedHostname(new URL(rawUrl).hostname);
    const official = normalizedHostname(officialDomain);
    return Boolean(official && (host === official || host.endsWith(`.${official}`)));
  } catch {
    return false;
  }
}

function containsDomain(text, domain) {
  const normalizedText = String(text ?? "").normalize("NFKC").toLowerCase();
  const escaped = escapeRegExp(normalizedHostname(domain));
  return new RegExp(`(?:^|[^a-z0-9.-])(?:www\\.)?${escaped}(?=$|[^a-z0-9.-])`, "i").test(normalizedText);
}

function containsExactPhrase(text, phrase) {
  const normalizedText = String(text ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  const normalizedPhrase = String(phrase ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalizedPhrase) return false;
  const escaped = escapeRegExp(normalizedPhrase);
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(normalizedText);
}

function isHistoricalUrl(url) {
  try {
    return HISTORICAL_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function robotsPathMatches(pathname, rawRule) {
  const escaped = escapeRegExp(rawRule)
    .replace(/\\\*/g, ".*")
    .replace(/\\\$$/, "$");
  try {
    return new RegExp(`^${escaped}`).test(pathname);
  } catch {
    return false;
  }
}

function fallbackItemIdentity(title, date) {
  if (!title) return null;
  return `fallback:${sha256(`${title}\n${date ?? ""}`)}`;
}

function dedupeDiscoveredUrls(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.kind}:${row.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeQueue(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.url)) return false;
    seen.add(row.url);
    return true;
  });
}

function siteCompleteCoverage(platform) {
  return platform === "rss"
    ? "all_discovered_official_feed_entries_within_endpoint_policy"
    : "all_discovered_official_web_history_within_endpoint_policy";
}

function validIso(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function epochSecondsIso(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? new Date(seconds * 1_000).toISOString() : null;
}

function earlierDate(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function laterDate(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function cleanText(value, limit = 1_000) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, limit);
}

function firstNonEmpty(...values) {
  return values.find((value) => String(value ?? "").trim()) ?? null;
}

function integerOr(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function companySlug(company) {
  return String(company.sourceKey ?? "").replace(/^company-/, "").replace(/^company:/, "") ||
    cleanText(company.name, 200).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function atomicJsonWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function repairTruncatedJournalTail(path) {
  const handle = await open(path, "r+");
  try {
    const metadata = await handle.stat();
    if (metadata.size === 0) return false;
    const lastByte = Buffer.alloc(1);
    await handle.read(lastByte, 0, 1, metadata.size - 1);
    if (lastByte[0] === 0x0a) return false;

    const chunkSize = 64 * 1024;
    let cursor = metadata.size;
    while (cursor > 0) {
      const start = Math.max(0, cursor - chunkSize);
      const length = cursor - start;
      const chunk = Buffer.allocUnsafe(length);
      await handle.read(chunk, 0, length, start);
      const newline = chunk.lastIndexOf(0x0a);
      if (newline >= 0) {
        await handle.truncate(start + newline + 1);
        return true;
      }
      cursor = start;
    }
    await handle.truncate(0);
    return true;
  } finally {
    await handle.close();
  }
}

function assertPositiveLimit(value, name) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
    throw new TypeError(`${name} must be a positive number.`);
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function isAbort(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}
