import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  HISTORICAL_BACKFILL_LIMITS,
  historicalHnSearchUrl,
  readBoundedResponseText
} from "./historical-backfill.mjs";

export const RECENT_WINDOW_PROOF_SCHEMA_VERSION =
  "recent-native-window-proof.v1";
export const RECENT_WINDOW_PAGE_RECEIPT_SCHEMA_VERSION =
  "recent-native-page-receipt.v1";
export const RECENT_WINDOW_DAYS = 90;

const DEFAULT_HN_PAGE_LIMIT = HISTORICAL_BACKFILL_LIMITS.hnMaxPages;
const DEFAULT_HN_ITEM_LIMIT = HISTORICAL_BACKFILL_LIMITS.hnMaxItems;
const DEFAULT_HN_HITS_PER_PAGE = HISTORICAL_BACKFILL_LIMITS.hnHitsPerPage;
const MAX_HN_PAGE_LIMIT = 20;
const MAX_HN_ITEM_LIMIT = 1_000;
const MAX_HN_HITS_PER_PAGE = 100;

/**
 * Convert a fully returned anonymous Instagram web_profile_info response into
 * an exact, single-page native-window observation. A shallow response is not
 * a completion signal: every native edge must be present, processed, and the
 * provider must explicitly report no next page.
 */
export function instagramRecentWindowObservation({
  requestUrl,
  requestedAt,
  completedAt,
  coverageCutoff,
  responseBody,
  receipt,
  windowDays = RECENT_WINDOW_DAYS
} = {}) {
  const checkedAt = canonicalTimestamp(completedAt, "completedAt");
  const startedAt = canonicalTimestamp(requestedAt, "requestedAt");
  const coveredThrough = canonicalTimestamp(coverageCutoff, "coverageCutoff");
  if (startedAt > checkedAt) {
    throw new Error("Instagram recent-window request completed before it started.");
  }
  if (startedAt < coveredThrough) {
    return {
      complete: false,
      blocker: "instagram_request_started_before_coverage_cutoff",
      startedAt,
      checkedAt,
      coveredThrough
    };
  }
  requireHttpsUrl(requestUrl, "requestUrl");
  const days = positiveInteger(windowDays, "windowDays");
  if (
    receipt?.verified !== true ||
    receipt?.truncated !== false ||
    receipt?.pageInfo?.hasNextPage !== false ||
    receipt?.pageInfo?.endCursor !== null ||
    !Number.isSafeInteger(receipt?.totalCount) ||
    !Number.isSafeInteger(receipt?.receivedEdgeCount) ||
    !Number.isSafeInteger(receipt?.processedEdgeCount) ||
    receipt.totalCount !== receipt.receivedEdgeCount ||
    receipt.receivedEdgeCount !== receipt.processedEdgeCount
  ) {
    return {
      complete: false,
      blocker: "instagram_native_timeline_not_exhausted",
      startedAt,
      checkedAt,
      coveredFrom: subtractDays(coveredThrough, days),
      coveredThrough
    };
  }

  const coveredFrom = subtractDays(coveredThrough, days);
  return completeObservation({
    startedAt,
    checkedAt,
    coveredFrom,
    coveredThrough,
    pageLimit: 2,
    pages: [{
      requestedAt: startedAt,
      completedAt: checkedAt,
      requestUrl,
      cursorIn: null,
      cursorOut: null,
      sourceExhausted: true,
      responseSha256: sha256(String(responseBody ?? "")),
      coverageFrom: coveredFrom,
      coverageThrough: coveredThrough
    }]
  });
}

/**
 * Exhaust an exact Hacker News Algolia query inside one immutable recent time
 * window. The historical collector's query builder and bounded body reader
 * are reused; this wrapper adds exact epoch bounds plus a cursor/page journal.
 */
export async function collectHackerNewsRecentWindow({
  target,
  fetchImpl = fetch,
  checkedThrough = new Date(),
  windowDays = RECENT_WINDOW_DAYS,
  pageLimit = DEFAULT_HN_PAGE_LIMIT,
  itemLimit = DEFAULT_HN_ITEM_LIMIT,
  hitsPerPage = DEFAULT_HN_HITS_PER_PAGE,
  maxResponseBytes = HISTORICAL_BACKFILL_LIMITS.maxResponseBytes,
  maxDecodedBytes = HISTORICAL_BACKFILL_LIMITS.maxDecodedBytes
} = {}) {
  const windowEnd = canonicalTimestamp(
    checkedThrough instanceof Date ? checkedThrough.toISOString() : checkedThrough,
    "checkedThrough"
  );
  const days = positiveInteger(windowDays, "windowDays");
  const boundedPageLimit = boundedPositiveInteger(
    pageLimit,
    MAX_HN_PAGE_LIMIT,
    "pageLimit"
  );
  const boundedItemLimit = boundedPositiveInteger(
    itemLimit,
    MAX_HN_ITEM_LIMIT,
    "itemLimit"
  );
  const boundedHitsPerPage = boundedPositiveInteger(
    hitsPerPage,
    MAX_HN_HITS_PER_PAGE,
    "hitsPerPage"
  );
  const coveredFrom = subtractDays(windowEnd, days);
  const lowerEpoch = Math.ceil(Date.parse(coveredFrom) / 1_000);
  const upperEpoch = Math.floor(Date.parse(windowEnd) / 1_000);
  const pages = [];
  const hits = [];
  let expectedNbHits = null;
  let expectedNbPages = null;
  let blocker = null;
  let sourceExhausted = false;
  let limitReached = false;

  for (let page = 0; page < boundedPageLimit; page += 1) {
    const baseUrl = new URL(historicalHnSearchUrl(target, page, {
      ...HISTORICAL_BACKFILL_LIMITS,
      hnHitsPerPage: boundedHitsPerPage
    }));
    baseUrl.searchParams.set(
      "numericFilters",
      `created_at_i>=${lowerEpoch},created_at_i<=${upperEpoch}`
    );
    const requestUrl = baseUrl.toString();
    const requestedAt = new Date().toISOString();
    let response;
    let body = "";
    let completedAt;
    try {
      response = await fetchImpl(requestUrl, {
        headers: {
          accept: "application/json",
          "user-agent": "ReturnerFundRecentWindowAudit/1.0 (+public-read-only)"
        }
      });
      body = await readBoundedResponseText(response, {
        maxResponseBytes,
        maxDecodedBytes
      });
      completedAt = new Date().toISOString();
    } catch (error) {
      completedAt = new Date().toISOString();
      blocker = `hacker_news_request_failed:${errorMessage(error)}`;
      break;
    }

    if (!response?.ok) {
      blocker = `hacker_news_http_${Number(response?.status) || "unknown"}`;
      break;
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      blocker = "hacker_news_invalid_json";
      break;
    }
    const pageHits = Array.isArray(payload?.hits) ? payload.hits : null;
    const nbHits = nonNegativeInteger(payload?.nbHits);
    const nbPages = nonNegativeInteger(payload?.nbPages);
    const responsePage = nonNegativeInteger(payload?.page);
    if (!pageHits || nbHits === null || nbPages === null || responsePage !== page) {
      blocker = "hacker_news_pagination_metadata_invalid";
      break;
    }
    if (expectedNbHits === null) {
      expectedNbHits = nbHits;
      expectedNbPages = nbPages;
    } else if (expectedNbHits !== nbHits || expectedNbPages !== nbPages) {
      blocker = "hacker_news_window_changed_during_pagination";
      break;
    }

    const nextPage = page + 1 < nbPages ? page + 1 : null;
    const pageSourceExhausted = nextPage === null;
    pages.push({
      requestedAt,
      completedAt,
      requestUrl,
      cursorIn: page === 0 ? null : String(page),
      cursorOut: nextPage === null ? null : String(nextPage),
      sourceExhausted: pageSourceExhausted,
      responseSha256: sha256(body),
      coverageFrom: coveredFrom,
      coverageThrough: windowEnd
    });
    hits.push(...pageHits);
    if (hits.length > boundedItemLimit) {
      limitReached = true;
      blocker = "hacker_news_recent_item_limit_reached";
      break;
    }
    if (pageSourceExhausted) {
      sourceExhausted = true;
      break;
    }
  }

  if (!sourceExhausted && !blocker) {
    limitReached = true;
    blocker = "hacker_news_recent_page_limit_reached";
  }
  if (
    expectedNbHits !== null &&
    (expectedNbHits > boundedItemLimit || expectedNbPages >= boundedPageLimit)
  ) {
    // Equality is deliberately incomplete: the proof verifier rejects a run
    // that lands exactly on its safety ceiling because exhaustion is ambiguous.
    limitReached = true;
    blocker ??= expectedNbHits > boundedItemLimit
      ? "hacker_news_recent_item_limit_reached"
      : "hacker_news_recent_page_limit_reached_or_ambiguous";
  }

  const checkedAt = pages.at(-1)?.completedAt ?? new Date().toISOString();
  if (blocker || !sourceExhausted || limitReached) {
    return {
      hits: hits.slice(0, boundedItemLimit),
      observation: {
        complete: false,
        blocker: blocker ?? "hacker_news_recent_window_not_exhausted",
        startedAt: pages[0]?.requestedAt ?? checkedAt,
        checkedAt,
        coveredFrom,
        coveredThrough: windowEnd,
        pagesAttempted: pages.length + (blocker && pages.length === 0 ? 1 : 0),
        pagesFetched: pages.length,
        pageLimit: boundedPageLimit,
        sourceExhausted,
        nextCursor: sourceExhausted ? null : pages.at(-1)?.cursorOut ?? "unknown",
        truncated: true,
        limitReached,
        blockers: [blocker ?? "hacker_news_recent_window_not_exhausted"]
      }
    };
  }

  return {
    hits,
    observation: completeObservation({
      startedAt: pages[0].requestedAt,
      checkedAt,
      coveredFrom,
      coveredThrough: windowEnd,
      pageLimit: boundedPageLimit,
      pages
    })
  };
}

/**
 * Persist a complete native request journal and return the exact attempt proof
 * shape consumed by recent-completion-proof-generator. Incomplete observations
 * never create a proof or a journal file.
 */
export async function persistRecentWindowProof({
  observation,
  attemptKey,
  pairKey,
  journalDirectory,
  descriptorRoot
} = {}) {
  if (observation?.complete !== true) {
    return {
      recentWindowProof: null,
      blocker: observation?.blocker ?? "native_recent_window_unverifiable",
      startedAt: observation?.startedAt ?? null,
      checkedAt: observation?.checkedAt ?? null
    };
  }
  const checkedAt = canonicalTimestamp(observation.checkedAt, "observation.checkedAt");
  const coveredThrough = canonicalTimestamp(
    observation.coveredThrough,
    "observation.coveredThrough"
  );
  const coveredFrom = canonicalTimestamp(
    observation.coveredFrom,
    "observation.coveredFrom"
  );
  const startedAt = canonicalTimestamp(observation.startedAt, "observation.startedAt");
  if (coveredFrom >= coveredThrough || startedAt < coveredThrough || checkedAt < coveredThrough) {
    return {
      recentWindowProof: null,
      blocker: "native_request_predates_coverage_cutoff",
      startedAt,
      checkedAt
    };
  }
  if (
    observation.sourceExhausted !== true ||
    observation.nextCursor !== null ||
    observation.truncated !== false ||
    observation.limitReached !== false ||
    !Array.isArray(observation.pages) ||
    observation.pages.length === 0 ||
    observation.pagesAttempted !== observation.pages.length ||
    observation.pagesFetched !== observation.pages.length ||
    !Number.isSafeInteger(observation.pageLimit) ||
    observation.pageLimit <= observation.pages.length ||
    !Array.isArray(observation.blockers) ||
    observation.blockers.length > 0
  ) {
    return {
      recentWindowProof: null,
      blocker: "native_recent_window_observation_not_exhaustive",
      startedAt,
      checkedAt
    };
  }
  const normalizedAttemptKey = requiredText(attemptKey, "attemptKey");
  const normalizedPairKey = requiredText(pairKey, "pairKey");
  const root = resolve(requiredText(descriptorRoot, "descriptorRoot"));
  const directory = resolve(requiredText(journalDirectory, "journalDirectory"));
  if (!isWithin(root, directory)) {
    throw new Error("Recent-window journal directory must stay inside descriptorRoot.");
  }
  const fileName = `${sha256(`${normalizedPairKey}\n${normalizedAttemptKey}\n${checkedAt}`)}.ndjson`;
  const absolutePath = resolve(directory, fileName);
  if (!isWithin(root, absolutePath)) {
    throw new Error("Recent-window journal path escaped descriptorRoot.");
  }
  let previousCursor = null;
  let invalidPage = false;
  const rows = observation.pages.map((page, index) => {
    const requestedAt = canonicalTimestamp(page.requestedAt, `pages[${index}].requestedAt`);
    const completedAt = canonicalTimestamp(page.completedAt, `pages[${index}].completedAt`);
    const cursorIn = nullableText(page.cursorIn, `pages[${index}].cursorIn`);
    const cursorOut = nullableText(page.cursorOut, `pages[${index}].cursorOut`);
    const pageCoveredFrom = canonicalTimestamp(
      page.coverageFrom,
      `pages[${index}].coverageFrom`
    );
    const pageCoveredThrough = canonicalTimestamp(
      page.coverageThrough,
      `pages[${index}].coverageThrough`
    );
    const finalPage = index === observation.pages.length - 1;
    if (
      requestedAt < coveredThrough ||
      completedAt < requestedAt ||
      completedAt > checkedAt ||
      cursorIn !== previousCursor ||
      pageCoveredFrom !== coveredFrom ||
      pageCoveredThrough !== coveredThrough ||
      (finalPage ? page.sourceExhausted !== true || cursorOut !== null
        : page.sourceExhausted !== false || cursorOut === null)
    ) {
      invalidPage = true;
    }
    previousCursor = cursorOut;
    return {
      schemaVersion: RECENT_WINDOW_PAGE_RECEIPT_SCHEMA_VERSION,
      sequence: index + 1,
      attemptKey: normalizedAttemptKey,
      pairKey: normalizedPairKey,
      requestedAt,
      completedAt,
      requestUrl: requireHttpsUrl(page.requestUrl, `pages[${index}].requestUrl`),
      status: "success",
      cursorIn,
      cursorOut,
      sourceExhausted: page.sourceExhausted === true,
      responseSha256: requiredSha256(page.responseSha256, `pages[${index}].responseSha256`),
      coverageFrom: pageCoveredFrom,
      coverageThrough: pageCoveredThrough
    };
  });
  if (invalidPage || previousCursor !== null) {
    return {
      recentWindowProof: null,
      blocker: "native_recent_window_page_receipts_invalid",
      startedAt,
      checkedAt
    };
  }
  await mkdir(directory, { recursive: true });
  const body = `${rows.map(stableJson).join("\n")}\n`;
  const temporaryPath = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, body, { mode: 0o600 });
  await rename(temporaryPath, absolutePath);
  const descriptorPath = relative(root, absolutePath).split(sep).join("/");
  if (!descriptorPath || descriptorPath.startsWith("../")) {
    throw new Error("Recent-window journal descriptor escaped descriptorRoot.");
  }

  return {
    startedAt,
    checkedAt,
    blocker: null,
    recentWindowProof: {
      schemaVersion: RECENT_WINDOW_PROOF_SCHEMA_VERSION,
      status: "complete",
      coverageScope: "pair_all_native_targets",
      coveredFrom,
      coveredThrough,
      checkedAt,
      sourceExhausted: true,
      nextCursor: null,
      truncated: false,
      limitReached: false,
      pageLimit: observation.pageLimit,
      pagesAttempted: rows.length,
      pagesFetched: rows.length,
      blockers: [],
      requestJournal: {
        path: descriptorPath,
        sha256: sha256(body),
        observedAt: checkedAt
      }
    }
  };
}

function completeObservation({
  startedAt,
  checkedAt,
  coveredFrom,
  coveredThrough,
  pageLimit,
  pages
}) {
  return {
    complete: true,
    blocker: null,
    startedAt,
    checkedAt,
    coveredFrom,
    coveredThrough,
    sourceExhausted: true,
    nextCursor: null,
    truncated: false,
    limitReached: false,
    pageLimit,
    pagesAttempted: pages.length,
    pagesFetched: pages.length,
    blockers: [],
    pages
  };
}

function subtractDays(timestamp, days) {
  return new Date(Date.parse(timestamp) - days * 24 * 60 * 60 * 1_000).toISOString();
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  const canonical = new Date(parsed).toISOString();
  if (canonical !== value) throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  return canonical;
}

function requireHttpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(requiredText(value, label));
  } catch {
    throw new TypeError(`${label} must be an HTTPS URL.`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new TypeError(`${label} must be an HTTPS URL without credentials.`);
  }
  return parsed.toString();
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function nullableText(value, label) {
  if (value === null) return null;
  return requiredText(value, label);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function boundedPositiveInteger(value, maximum, label) {
  const normalized = positiveInteger(value, label);
  if (normalized > maximum) throw new RangeError(`${label} cannot exceed ${maximum}.`);
  return normalized;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function requiredSha256(value, label) {
  const text = requiredText(value, label);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new TypeError(`${label} must be lowercase SHA-256.`);
  return text;
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
