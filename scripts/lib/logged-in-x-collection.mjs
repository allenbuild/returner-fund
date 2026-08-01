export function mergeOwnedXTweets(
  tweetGroups,
  {
    handle,
    includeRetweets = false,
    limit = Number.POSITIVE_INFINITY,
    cutoff = "2025-01-01T00:00:00.000Z"
  }
) {
  const normalizedHandle = normalizeHandle(handle);
  if (!normalizedHandle) return [];

  return mergeOwnedXTweetObservations(tweetGroups, { handle: normalizedHandle })
    .filter((tweet) =>
      xTweetIngestionDecision(tweet, {
        handle: normalizedHandle,
        includeRetweets,
        cutoff
      }).eligible
    )
    .sort((left, right) => compareTweetRecency(left, right))
    .slice(0, limit);
}

export function mergeOwnedXTweetObservations(
  tweetGroups,
  { handle }
) {
  const normalizedHandle = normalizeHandle(handle);
  if (!normalizedHandle) return [];

  const byId = new Map();
  for (const tweet of tweetGroups.flat()) {
    const id = xTweetId(tweet);
    if (!id || !xTweetBelongsToHandle(tweet, normalizedHandle)) continue;
    byId.set(id, mergeXTweet(byId.get(id), {
      ...tweet,
      id,
      author: normalizedHandle,
      url: `https://x.com/${normalizedHandle}/status/${id}`
    }));
  }

  return [...byId.values()];
}

export function xTweetIngestionDecision(
  tweet,
  {
    handle,
    includeRetweets = false,
    cutoff = "2025-01-01T00:00:00.000Z"
  } = {}
) {
  if (!xTweetId(tweet)) {
    return { eligible: false, reason: "missing_native_post_id" };
  }
  if (handle && !xTweetBelongsToHandle(tweet, handle)) {
    return { eligible: false, reason: "native_owner_mismatch" };
  }
  if (!includeRetweets && xTweetIsRetweetWrapper(tweet)) {
    return { eligible: false, reason: "retweet_wrapper" };
  }
  if (!xTweetHasPositiveVisibleTraction(tweet)) {
    return { eligible: false, reason: "no_positive_visible_metric" };
  }

  const createdAt = String(tweet?.created_at ?? "").trim();
  if (!createdAt) {
    return { eligible: false, reason: "missing_publication_date" };
  }
  const postedAt = xTweetTimestamp(createdAt);
  if (!Number.isFinite(postedAt)) {
    return { eligible: false, reason: "invalid_publication_date" };
  }
  const cutoffAt = Date.parse(cutoff);
  if (!Number.isFinite(cutoffAt)) {
    return { eligible: false, reason: "invalid_cutoff_date" };
  }
  if (postedAt < cutoffAt) {
    return { eligible: false, reason: "publication_before_cutoff" };
  }
  return { eligible: true, reason: "verified_recent_native_post" };
}

export function xTweetIsRetweetWrapper(tweet) {
  if (tweet?.is_retweet) return true;
  return [tweet?.text, tweet?.rawText].some((value) =>
    /^RT\s+@[a-z0-9_]{1,15}\b/i.test(String(value ?? "").trim())
  );
}

export function xTweetHasPositiveVisibleTraction(tweet) {
  return ["likes", "retweets", "replies", "views"].some((metric) => {
    const value = Number(tweet?.[metric]);
    return Number.isFinite(value) && value > 0;
  });
}

export function xTweetDateIsOnOrAfter(
  tweet,
  cutoff = "2025-01-01T00:00:00.000Z"
) {
  const postedAt = xTweetTimestamp(tweet?.created_at);
  const cutoffAt = Date.parse(cutoff);
  return (
    Number.isFinite(postedAt) &&
    Number.isFinite(cutoffAt) &&
    postedAt >= cutoffAt
  );
}

/**
 * Converts only a platform-native X publication label into ranking-safe date
 * metadata. Relative labels are useful for collection recency, but they are
 * observations rather than exact publication timestamps and therefore fail
 * closed for Today/Month ranking.
 */
export function xTweetPublicationDate(value, now = Date.now()) {
  const text = String(value ?? "").trim();
  if (!text) return { postedAt: null, publishedAtPrecision: "unknown" };

  if (/^(\d+)\s*(m|h|d|minutes?|hours?|days?)\s*(?:ago)?$/i.test(text)) {
    return { postedAt: null, publishedAtPrecision: "unknown" };
  }

  const canonicalDay = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (canonicalDay && validCalendarDay(...canonicalDay.slice(1).map(Number))) {
    return { postedAt: canonicalDay[0], publishedAtPrecision: "day" };
  }

  const namedDay = text.match(
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i
  );
  if (namedDay) {
    const month = MONTH_NUMBER_BY_NAME[namedDay[1].toLowerCase()];
    const day = Number(namedDay[2]);
    let year = namedDay[3] ? Number(namedDay[3]) : new Date(now).getUTCFullYear();
    let candidate = Date.UTC(year, month - 1, day, 12);
    // A yearless timeline label around New Year belongs to the preceding year,
    // not to a future publication date.
    if (!namedDay[3] && candidate > now + 24 * 60 * 60 * 1_000) {
      year -= 1;
      candidate = Date.UTC(year, month - 1, day, 12);
    }
    if (validCalendarDay(year, month, day)) {
      return {
        postedAt: new Date(candidate).toISOString().slice(0, 10),
        publishedAtPrecision: "day"
      };
    }
  }

  const hasExplicitTimeAndZone =
    /\d{1,2}:\d{2}(?::\d{2})?/.test(text) &&
    /(?:Z|[+-]\d{2}:?\d{2}|\b(?:UTC|GMT)\b)/i.test(text);
  const timestamp = hasExplicitTimeAndZone ? Date.parse(text) : Number.NaN;
  return Number.isFinite(timestamp)
    ? { postedAt: new Date(timestamp).toISOString(), publishedAtPrecision: "exact" }
    : { postedAt: null, publishedAtPrecision: "unknown" };
}

export function xTweetBelongsToHandle(tweet, expectedHandle) {
  const normalizedExpected = normalizeHandle(expectedHandle);
  if (!normalizedExpected) return false;
  const author = normalizeHandle(tweet?.author);
  const urlHandle = xHandleFromStatusUrl(tweet?.url);
  return author === normalizedExpected && urlHandle === normalizedExpected;
}

export function xTweetId(tweet) {
  const explicit = String(tweet?.id ?? "").trim();
  if (/^\d+$/.test(explicit)) return explicit;
  try {
    return new URL(tweet?.url).pathname.match(/\/status\/(\d+)/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function xCollectionAttemptState({
  tweetCount = 0,
  attemptedSourceCount = 0,
  completedSourceCount = 0,
  failedSourceCount = 0
} = {}) {
  const normalizedTweetCount = finiteNonnegativeInteger(tweetCount);
  const normalizedAttemptedCount = finiteNonnegativeInteger(attemptedSourceCount);
  const normalizedCompletedCount = finiteNonnegativeInteger(completedSourceCount);
  const normalizedFailedCount = finiteNonnegativeInteger(failedSourceCount);

  if (normalizedTweetCount > 0) {
    return {
      status: "done",
      collectionFailed: false
    };
  }
  if (normalizedFailedCount > 0) {
    return {
      status: "failed",
      collectionFailed: true
    };
  }
  if (normalizedCompletedCount > 0) {
    return {
      status: "done",
      collectionFailed: false
    };
  }

  return {
    status: normalizedAttemptedCount > 0 ? "failed" : "done",
    collectionFailed: normalizedAttemptedCount > 0
  };
}

export function xFailureKind(value) {
  const message = String(value ?? "");
  const explicitTimelineFailure = message.match(
    /\bX_TIMELINE_FAILURE:(rate_limited|auth|transport|system)\b/i
  )?.[1];
  if (explicitTimelineFailure) return explicitTimelineFailure.toLowerCase();
  if (
    /\b(?:429|rate limit(?:ed)?|too many requests|quota (?:exceeded|exhausted)|slow down)\b/i.test(
      message
    )
  ) {
    return "rate_limited";
  }
  if (
    /\b(?:log in|login|sign in|unauthenticated|not authenticated|authentication (?:required|failed)|session expired|checkpoint)\b/i.test(
      message
    )
  ) {
    return "auth";
  }
  if (
    /\b(?:timed? out|timeout|ECONN|ENOTFOUND|transport|socket|connection (?:closed|dropped|failed|refused)|browser (?:closed|crashed|disconnected|unavailable))\b/i.test(
      message
    )
  ) {
    return "transport";
  }
  if (
    /\b(?:X authenticated adapter failed|X browser DOM extractor failed)\b/i.test(
      message
    )
  ) {
    return "system";
  }
  if (
    /\b(?:no scored recent original x posts|native_owner_mismatch|retweet_wrapper|no_positive_visible_metric|missing_publication_date|invalid_publication_date|publication_before_cutoff|url host did not match|could not parse x\/twitter handle)\b/i.test(
      message
    )
  ) {
    return "target_specific";
  }
  return "system";
}

export function xCircuitStateTransition({
  previousConsecutiveFailures = 0,
  collectionFailed = false,
  maxConsecutiveFailures = 8,
  failureKind = "system"
} = {}) {
  const immediate = failureKind === "auth" || failureKind === "rate_limited";
  const repeatedInfrastructureFailure =
    collectionFailed && (failureKind === "transport" || failureKind === "system");
  const consecutiveFailures = immediate || repeatedInfrastructureFailure
    ? finiteNonnegativeInteger(previousConsecutiveFailures) + 1
    : 0;
  const threshold = Math.max(1, finiteNonnegativeInteger(maxConsecutiveFailures));
  return {
    consecutiveFailures,
    open: immediate || consecutiveFailures >= threshold,
    reason: immediate
      ? failureKind
      : consecutiveFailures >= threshold
        ? "consecutive_failures"
        : null
  };
}

export function prioritizeXTargets(
  targets,
  {
    evidence = [],
    attempts = new Map(),
    attemptKey = defaultAttemptKey
  } = {}
) {
  const attemptMap = attempts instanceof Map
    ? attempts
    : new Map(Object.entries(attempts ?? {}));
  const evidenceIds = new Map();
  for (const row of evidence) {
    if (row?.platform !== "x" || !row?.entityId) continue;
    const postId = xTweetId({
      id: row?.platformPostId,
      url: row?.sourceUrl
    });
    if (!postId) continue;
    const key = `${row.batchSlug ?? ""}:${row.entityId}`;
    evidenceIds.set(key, new Set([...(evidenceIds.get(key) ?? []), postId]));
  }
  const evidenceCounts = new Map(
    [...evidenceIds].map(([key, ids]) => [key, ids.size])
  );

  const prioritizedX = targets
    .filter((target) => target?.platform === "x")
    .map((target, originalIndex) => {
      const key = attemptKey(target);
      const attempt = attemptMap.get(key);
      const evidenceCount =
        evidenceCounts.get(`${target.batchSlug ?? ""}:${target.entityId}`) ??
        evidenceCounts.get(`:${target.entityId}`) ??
        0;
      return {
        target,
        originalIndex,
        key,
        evidenceCount,
        // Finish the untouched zero-coverage inventory before retrying known
        // failures. In particular, a legacy failed attempt without checkedAt
        // must not tie a truly untouched target at negative infinity.
        priorityBand:
          evidenceCount === 0 && !attemptMap.has(key)
            ? 0
            : attempt?.status === "failed"
              ? 1
              : 2,
        checkedAt: finiteTimestamp(attempt?.checkedAt)
      };
    })
    .sort((left, right) =>
      left.priorityBand - right.priorityBand ||
      left.evidenceCount - right.evidenceCount ||
      left.checkedAt - right.checkedAt ||
      left.key.localeCompare(right.key) ||
      left.originalIndex - right.originalIndex
    )
    .map(({ target }) => target);

  let xIndex = 0;
  return targets.map((target) =>
    target?.platform === "x"
      ? prioritizedX[xIndex++]
      : target
  );
}

export function xTimelinePageState(bodyText, tweetCount = 0) {
  if (finiteNonnegativeInteger(tweetCount) > 0) return "healthy";
  const text = String(bodyText ?? "").replace(/\s+/g, " ").trim();
  if (
    /\bhasn['’]t posted\b/i.test(text) ||
    /\bno posts yet\b/i.test(text) ||
    /\bdoesn['’]t have any posts\b/i.test(text)
  ) {
    return "empty";
  }
  if (
    /\bsomething went wrong\b/i.test(text) ||
    /\btry reloading\b/i.test(text) ||
    /\brate limit(?:ed)?\b/i.test(text) ||
    /\btoo many requests\b/i.test(text) ||
    /\blog in\b/i.test(text) ||
    /\bsign in\b/i.test(text)
  ) {
    return "failed";
  }
  return "failed";
}

function mergeXTweet(existing, incoming) {
  if (!existing) return incoming;
  const merged = { ...existing, ...incoming };
  for (const metric of ["likes", "retweets", "replies", "views"]) {
    merged[metric] = maxFinite(existing[metric], incoming[metric]);
  }
  merged.text = longerText(existing.text, incoming.text);
  merged.rawText = longerText(existing.rawText, incoming.rawText);
  merged.created_at = morePreciseDate(existing.created_at, incoming.created_at);
  merged.is_retweet = Boolean(
    existing.is_retweet ||
    incoming.is_retweet ||
    xTweetIsRetweetWrapper(existing) ||
    xTweetIsRetweetWrapper(incoming)
  );
  merged.media_urls = uniqueStrings(existing.media_urls, incoming.media_urls);
  merged.media_posters = uniqueStrings(existing.media_posters, incoming.media_posters);
  merged.has_media = Boolean(
    existing.has_media ||
    incoming.has_media ||
    merged.media_urls.length ||
    merged.media_posters.length
  );
  return merged;
}

function xHandleFromStatusUrl(value) {
  try {
    const match = new URL(value).pathname.match(/^\/([^/]+)\/status\/\d+/i);
    return normalizeHandle(match?.[1]);
  } catch {
    return null;
  }
}

function normalizeHandle(value) {
  const handle = String(value ?? "").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{1,15}$/.test(handle) ? handle : null;
}

function maxFinite(...values) {
  const finite = values.map(Number).filter((value) => Number.isFinite(value));
  return finite.length ? Math.max(...finite) : null;
}

function longerText(...values) {
  return values
    .map((value) => String(value ?? "").trim())
    .sort((left, right) => right.length - left.length)[0] ?? "";
}

function morePreciseDate(left, right) {
  const candidates = [left, right].filter(Boolean);
  const exact = candidates.find((value) =>
    /(?:\d{4}|[+-]\d{4}|GMT|UTC)/i.test(String(value))
  );
  return exact ?? candidates[0] ?? null;
}

function uniqueStrings(...groups) {
  return [...new Set(groups.flat().filter(Boolean))];
}

function compareTweetRecency(left, right) {
  const leftTime = xTweetTimestamp(left?.created_at);
  const rightTime = xTweetTimestamp(right?.created_at);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return String(right?.id ?? "").localeCompare(String(left?.id ?? ""));
}

function xTweetTimestamp(value, now = Date.now()) {
  const text = String(value ?? "").trim();
  if (!text) return Number.NaN;

  const exact = Date.parse(text);
  if (Number.isFinite(exact)) return exact;

  const relative = text.match(
    /^(\d+)\s*(m|h|d|minutes?|hours?|days?)\s*(?:ago)?$/i
  );
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase()[0];
    const duration =
      unit === "m"
        ? amount * 60_000
        : unit === "h"
          ? amount * 3_600_000
          : amount * 86_400_000;
    return now - duration;
  }

  const monthDay = text.match(
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})$/i
  );
  if (!monthDay) return Number.NaN;
  const year = new Date(now).getUTCFullYear();
  return Date.parse(`${monthDay[1]} ${monthDay[2]}, ${year} UTC`);
}

const MONTH_NUMBER_BY_NAME = Object.freeze({
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
});

function validCalendarDay(year, month, day) {
  if (![year, month, day].every(Number.isInteger) || month < 1 || month > 12 || day < 1) {
    return false;
  }
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function finiteNonnegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function finiteTimestamp(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function defaultAttemptKey(target) {
  return [
    target?.batchSlug ?? "",
    target?.platform ?? "",
    target?.entityId ?? "",
    target?.url ?? ""
  ].join(":");
}
