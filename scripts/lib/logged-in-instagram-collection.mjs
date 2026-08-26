const INSTAGRAM_HOST_RE = /^(?:www\.)?instagram\.com$/i;
const INSTAGRAM_SHORTCODE_RE = /^[A-Za-z0-9_-]+$/;
const INSTAGRAM_EARLIEST_PUBLICATION_MS = Date.UTC(2010, 0, 1);
export const INSTAGRAM_DEEP_SCROLL_PAGINATION_VERSION = 2;
export const INSTAGRAM_DEEP_SCROLL_PAGINATION_MODE =
  "bounded-authenticated-window-v2";
const INSTAGRAM_PAGINATION_RECENT_ID_LIMIT = 512;
const INSTAGRAM_LEGACY_DEEP_SCROLL_PAGINATION_VERSION = 1;
const INSTAGRAM_LEGACY_DEEP_SCROLL_PAGINATION_MODE =
  "deterministic-browser-deep-scroll-v1";
export const LOGGED_IN_STORED_RAW_TEXT_LIMIT = 1_024;
const LOGGED_IN_STORED_FIELD_LIMITS = Object.freeze({
  rawVisibleText: LOGGED_IN_STORED_RAW_TEXT_LIMIT,
  rawText: LOGGED_IN_STORED_RAW_TEXT_LIMIT,
  diagnostic: 2_048,
  diagnostics: 2_048,
  error: 2_048,
  errorMessage: 2_048,
  stack: 2_048,
  message: 2_048,
  matchReason: 1_024,
  title: 512
});
const INSTAGRAM_PUBLICATION_DATE_FIELDS = Object.freeze([
  "postedAt",
  "publishedAt",
  "taken_at",
  "takenAt",
  "timestamp",
  "date",
  "dateLabel"
]);
const MONTH_NUMBER_BY_NAME = Object.freeze({
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12
});

/**
 * Compact only diagnostic/display fields that are not used as native identity,
 * metrics, dates, or topic/scoring text. Rows and nested objects are retained
 * and mutated in place to avoid another full 40k-row allocation.
 */
export function compactLoggedInStoredRows(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new WeakSet();
  for (const row of rows) compactLoggedInStoredValue(row, seen, 0);
  return rows;
}

/**
 * Append-only evidence admission for bounded Instagram attempts. A forced run
 * is a selection override, never permission to replace durable history because
 * authenticated Instagram coverage has no trustworthy exhaustion proof.
 */
export function appendInstagramAttemptEvidence(existingRows, resultRows = []) {
  if (!Array.isArray(existingRows)) {
    throw new TypeError("existingRows must be an array");
  }
  for (const row of Array.isArray(resultRows) ? resultRows : []) {
    if (row && typeof row === "object") existingRows.push(row);
  }
  return existingRows;
}

function compactLoggedInStoredValue(value, seen, depth) {
  if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const [field, nested] of Object.entries(value)) {
    const limit = LOGGED_IN_STORED_FIELD_LIMITS[field];
    if (typeof nested === "string" && Number.isSafeInteger(limit)) {
      if (nested.length > limit) value[field] = nested.slice(0, limit);
      continue;
    }
    if (Array.isArray(nested)) {
      for (const item of nested) compactLoggedInStoredValue(item, seen, depth + 1);
    } else {
      compactLoggedInStoredValue(nested, seen, depth + 1);
    }
  }
}

export function canonicalInstagramPostUrl(value) {
  try {
    const parsed = new URL(value);
    if (!INSTAGRAM_HOST_RE.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (
      parts.length < 2 ||
      !/^(?:p|reels?|tv)$/i.test(parts[0]) ||
      !INSTAGRAM_SHORTCODE_RE.test(parts[1])
    ) {
      return null;
    }
    const surface = parts[0].toLowerCase() === "reels" ? "reel" : parts[0].toLowerCase();
    return `https://www.instagram.com/${surface}/${parts[1]}/`;
  } catch {
    return null;
  }
}

export function instagramPostIdFromUrl(value) {
  const canonical = canonicalInstagramPostUrl(value);
  if (!canonical) return null;
  return new URL(canonical).pathname.split("/").filter(Boolean)[1] ?? null;
}

export function instagramMetaDescriptionFields(value) {
  const description = String(value ?? "").trim();
  if (!description) {
    return {
      caption: null,
      dateLabel: null,
      likes: null,
      comments: null,
      views: null
    };
  }

  const metric = (label) => {
    const match = description.match(
      new RegExp(`([0-9,.]+\\s*[KMB]?)\\s+${label}`, "i")
    );
    return compactMetricNumber(match?.[1]);
  };
  const dateLabel =
    description.match(/\bon\s+([^:]+):\s*["“]/i)?.[1]?.trim() ?? null;
  const caption =
    description.match(/:\s*["“]([\s\S]*?)["”]\.?\s*$/)?.[1]?.trim() ?? null;

  return {
    caption,
    dateLabel,
    likes: metric("likes?"),
    comments: metric("comments?"),
    views: metric("(?:views?|plays?)")
  };
}

export function normalizeInstagramDetailObservation(parsed = {}) {
  const meta = instagramMetaDescriptionFields(parsed?.description);
  const observedCaption = nonBlank(parsed?.caption);
  const metaCaptionMatches =
    Boolean(meta.caption && observedCaption) &&
    instagramCaptionsCompatible(meta.caption, observedCaption);
  const useMetaObservation =
    Boolean(meta.caption) && (!observedCaption || !metaCaptionMatches);
  return {
    ...parsed,
    caption: meta.caption ?? observedCaption,
    dateLabel: useMetaObservation
      ? meta.dateLabel ?? nonBlank(parsed?.dateLabel)
      : nonBlank(parsed?.dateLabel) ?? meta.dateLabel,
    likes: useMetaObservation
      ? meta.likes ?? finiteMetric(parsed?.likes)
      : finiteMetric(parsed?.likes) ?? meta.likes,
    comments: useMetaObservation
      ? meta.comments ?? finiteMetric(parsed?.comments)
      : finiteMetric(parsed?.comments) ?? meta.comments,
    views: useMetaObservation
      ? meta.views ?? finiteMetric(parsed?.views)
      : finiteMetric(parsed?.views) ?? meta.views
  };
}

export function instagramDetailObservationMatchesMeta(parsed = {}) {
  const metaCaption = instagramMetaDescriptionFields(
    parsed?.description
  ).caption;
  const observedCaption = nonBlank(parsed?.caption);
  return Boolean(
    metaCaption &&
      observedCaption &&
      instagramCaptionsCompatible(metaCaption, observedCaption)
  );
}

export function instagramEvidenceProvenance({
  post,
  gridItems = [],
  detailItems = []
} = {}) {
  const adapterUrl = firstCanonicalInstagramPostUrl([
    post?.url,
    post?.permalink,
    post?.link
  ]);
  const adapterPostId =
    instagramPostIdFromUrl(adapterUrl) ??
    explicitInstagramShortcode(post);
  if (!adapterPostId) return null;

  const gridItem = gridItems.find(
    (item) => instagramPostIdFromUrl(item?.href) === adapterPostId
  ) ?? null;
  const sourceUrl =
    adapterUrl ??
    canonicalInstagramPostUrl(gridItem?.href);
  if (!sourceUrl) return null;

  const detail = detailItems.find(
    (item) => instagramPostIdFromUrl(item?.url) === adapterPostId
  ) ?? null;
  return {
    sourceUrl,
    platformPostId: adapterPostId,
    gridItem,
    detail
  };
}

export function instagramGridOnlyOwnershipDecision({
  requestedHandle,
  gridItem,
  detail
} = {}) {
  const requested = normalizeInstagramHandle(requestedHandle);
  if (!requested) return { ok: false, reason: "requested_handle_missing" };
  if (
    gridItem?.profileGridProven !== true ||
    normalizeInstagramHandle(gridItem?.profileHandle) !== requested
  ) {
    return { ok: false, reason: "exact_profile_grid_not_proven" };
  }

  const authorHandle = normalizeInstagramHandle(detail?.authorHandle);
  const authorUrlHandle = instagramProfileHandleFromUrl(detail?.authorUrl);
  if (!authorHandle || !authorUrlHandle) {
    return { ok: false, reason: "detail_author_identity_missing" };
  }
  if (
    authorHandle !== requested ||
    authorUrlHandle !== requested ||
    authorHandle !== authorUrlHandle
  ) {
    return { ok: false, reason: "detail_author_identity_mismatch" };
  }
  if (detail?.authorProof !== "native_post_header_profile_link") {
    return { ok: false, reason: "detail_author_proof_not_native" };
  }
  return {
    ok: true,
    reason: "exact_profile_grid_and_native_detail_author"
  };
}

/**
 * Select only grid posts that can add information to the adapter result.
 * Adapter rows with a native identity, valid date, and traction metric are
 * complete enough to keep without opening their detail page. Grid-only rows
 * are always selected; their grid evidence remains usable if detail loading
 * fails.
 */
export function instagramDetailUrlsNeedingEnrichment({
  adapterPosts = [],
  gridItems = [],
  now = Date.now(),
  limit = Number.POSITIVE_INFINITY,
  existingPostIds = [],
  offset = 0
} = {}) {
  const adapterRowsByPostId = new Map();
  for (const post of Array.isArray(adapterPosts) ? adapterPosts : []) {
    const postId = instagramObservationPostId(post);
    if (!postId) continue;
    const rows = adapterRowsByPostId.get(postId) ?? [];
    rows.push(post);
    adapterRowsByPostId.set(postId, rows);
  }

  const normalizedLimit = Number.isFinite(Number(limit))
    ? Math.max(0, Math.floor(Number(limit)))
    : Number.POSITIVE_INFINITY;
  if (normalizedLimit === 0) return [];
  const candidates = [];
  const seenPostIds = new Set(
    (Array.isArray(existingPostIds) ? existingPostIds : existingPostIds instanceof Set ? [...existingPostIds] : [])
      .map((postId) => String(postId ?? "").trim())
      .filter((postId) => INSTAGRAM_SHORTCODE_RE.test(postId))
  );
  for (const gridItem of Array.isArray(gridItems) ? gridItems : []) {
    const sourceUrl = canonicalInstagramPostUrl(
      gridItem?.href ?? gridItem?.url ?? gridItem?.permalink
    );
    const postId = instagramPostIdFromUrl(sourceUrl);
    if (!sourceUrl || !postId || seenPostIds.has(postId)) continue;
    const adapterRows = adapterRowsByPostId.get(postId) ?? [];
    const sufficientlyRepresented = adapterRows.some((post) =>
      instagramObservationIsSufficientlyRepresented(post, gridItem, now)
    );
    if (adapterRows.length === 0 || !sufficientlyRepresented) {
      candidates.push(sourceUrl);
      seenPostIds.add(postId);
    }
  }
  if (candidates.length === 0) return [];
  const normalizedOffset = Number.isSafeInteger(Number(offset))
    ? Math.max(0, Number(offset)) % candidates.length
    : 0;
  const rotated = normalizedOffset === 0
    ? candidates
    : [
        ...candidates.slice(normalizedOffset),
        ...candidates.slice(0, normalizedOffset)
      ];
  return rotated.slice(0, normalizedLimit);
}

/**
 * Merge one bounded grid extraction into the invocation-wide ledger. The map
 * is intentionally mutated so repeated passes do not copy the complete window.
 * Invalid or contradictory native identities are counted instead of silently
 * disappearing from the collection decision.
 */
export function mergeInstagramGridPassObservations({
  observedByUrl = new Map(),
  items = [],
  malformedItemCount = 0
} = {}) {
  const byUrl = observedByUrl instanceof Map ? observedByUrl : new Map();
  let malformed = finiteNonnegativeInteger(malformedItemCount);

  for (const item of Array.isArray(items) ? items : []) {
    if (
      item === null ||
      item === undefined ||
      item?.unrelated === true ||
      item?.duplicateIdentity === true
    ) {
      continue;
    }
    const sourceUrl = canonicalInstagramPostUrl(
      item?.href ?? item?.url ?? item?.permalink
    );
    const postId = instagramPostIdFromUrl(sourceUrl);
    const declaredPostId = String(item?.platformPostId ?? "").trim();
    const malformedIdentity =
      item?.malformedIdentity === true ||
      (item?.nativeAnchor === true && (!sourceUrl || !postId)) ||
      (declaredPostId && declaredPostId !== postId);
    if (malformedIdentity) {
      malformed += 1;
      continue;
    }
    if (!sourceUrl || !postId) continue;

    const normalized = { ...item, href: sourceUrl, platformPostId: postId };
    const existing = byUrl.get(sourceUrl);
    if (!existing) {
      byUrl.set(sourceUrl, normalized);
      continue;
    }
    const merged = { ...existing };
    for (const [field, value] of Object.entries(normalized)) {
      if (
        value !== null &&
        value !== undefined &&
        value !== "" &&
        (!Array.isArray(value) || value.length > 0)
      ) {
        merged[field] = value;
      }
    }
    byUrl.set(sourceUrl, merged);
  }

  return {
    observedByUrl: byUrl,
    items: [...byUrl.values()],
    malformedItemCount: malformed
  };
}

export function normalizeInstagramDeepScrollPagination(
  value,
  { handle = "" } = {}
) {
  const normalizedHandle = normalizeInstagramHandle(handle);
  const initial = {
    version: INSTAGRAM_DEEP_SCROLL_PAGINATION_VERSION,
    mode: INSTAGRAM_DEEP_SCROLL_PAGINATION_MODE,
    handle: normalizedHandle,
    observedPostIds: [],
    recentObservedPostIds: [],
    detailWindowOffset: 0,
    exhausted: false,
    status: "non_exhaustive",
    reason: "no_persisted_bounded_window_state"
  };
  if (
    !value ||
    !normalizedHandle ||
    normalizeInstagramHandle(value.handle) !== normalizedHandle
  ) {
    return initial;
  }

  const currentState =
    value.version === INSTAGRAM_DEEP_SCROLL_PAGINATION_VERSION &&
    value.mode === INSTAGRAM_DEEP_SCROLL_PAGINATION_MODE;
  const legacyState =
    value.version === INSTAGRAM_LEGACY_DEEP_SCROLL_PAGINATION_VERSION &&
    value.mode === INSTAGRAM_LEGACY_DEEP_SCROLL_PAGINATION_MODE;
  if (!currentState && !legacyState) return initial;

  const observedSource = Array.isArray(value.recentObservedPostIds)
    ? value.recentObservedPostIds
    : Array.isArray(value.observedPostIds)
      ? value.observedPostIds
      : [];
  const observedPostIds = [...new Set(
    observedSource
      .map((postId) => String(postId ?? "").trim())
      .filter((postId) => INSTAGRAM_SHORTCODE_RE.test(postId))
  )].slice(-INSTAGRAM_PAGINATION_RECENT_ID_LIMIT);
  const detailWindowOffset =
    currentState && Number.isSafeInteger(Number(value.detailWindowOffset))
      ? Math.max(0, Number(value.detailWindowOffset))
      : 0;
  return {
    ...initial,
    observedPostIds,
    recentObservedPostIds: observedPostIds,
    detailWindowOffset,
    reason: legacyState
      ? "legacy_scroll_state_migrated_without_exhaustion_claim"
      : "persisted_bounded_window_state"
  };
}

export function instagramDeepScrollPaginationDecision({
  identityOk = false,
  candidateItems = [],
  persistedObservedPostIds = [],
  priorState = null,
  malformedItemCount = 0,
  nextDetailWindowOffset = null
} = {}) {
  const prior = normalizeInstagramDeepScrollPagination(priorState, {
    handle: priorState?.handle
  });
  const candidatePostIds = [];
  let malformed = finiteNonnegativeInteger(malformedItemCount);
  const seenCandidates = new Set();
  for (const item of Array.isArray(candidateItems) ? candidateItems : []) {
    const sourceUrl = canonicalInstagramPostUrl(
      item?.href ?? item?.url ?? item?.permalink
    );
    const postId = instagramPostIdFromUrl(sourceUrl);
    const declaredPostId = String(item?.platformPostId ?? "").trim();
    if (
      !item ||
      item.malformedIdentity === true ||
      !postId ||
      (declaredPostId && declaredPostId !== postId)
    ) {
      malformed += 1;
      continue;
    }
    if (!seenCandidates.has(postId)) {
      seenCandidates.add(postId);
      candidatePostIds.push(postId);
    }
  }

  if (!identityOk) {
    return {
      ...prior,
      advance: false,
      exhausted: false,
      status: "blocked",
      reason: "identity_not_proven",
      malformedItemCount: malformed,
      newPostIds: [],
      previouslyObservedPostIds: []
    };
  }

  const persisted = new Set(prior.observedPostIds);
  const persistedValues =
    persistedObservedPostIds instanceof Set
      ? persistedObservedPostIds
      : Array.isArray(persistedObservedPostIds)
        ? persistedObservedPostIds
        : [];
  for (const value of persistedValues) {
    const postId = String(value ?? "").trim();
    if (INSTAGRAM_SHORTCODE_RE.test(postId)) persisted.add(postId);
  }
  const newPostIds = candidatePostIds.filter((postId) => !persisted.has(postId));
  const previouslyObservedPostIds = candidatePostIds.filter((postId) =>
    persisted.has(postId)
  );
  const observedPostIds = [...new Set([
    ...prior.observedPostIds,
    ...candidatePostIds
  ])].slice(-INSTAGRAM_PAGINATION_RECENT_ID_LIMIT);
  const detailWindowOffset = Number.isSafeInteger(Number(nextDetailWindowOffset))
    ? Math.max(0, Number(nextDetailWindowOffset))
    : prior.detailWindowOffset;
  const blocked = malformed > 0;

  return {
    version: INSTAGRAM_DEEP_SCROLL_PAGINATION_VERSION,
    mode: INSTAGRAM_DEEP_SCROLL_PAGINATION_MODE,
    handle: prior.handle,
    advance:
      newPostIds.length > 0 ||
      detailWindowOffset !== prior.detailWindowOffset,
    exhausted: false,
    status: blocked ? "blocked" : "non_exhaustive",
    reason: blocked
      ? "malformed_native_post_identity"
      : newPostIds.length > 0
        ? "bounded_window_observed_new_native_posts"
        : "bounded_window_reobserved_without_cursor",
    observedPostIds,
    recentObservedPostIds: observedPostIds,
    detailWindowOffset,
    malformedItemCount: malformed,
    newPostIds,
    previouslyObservedPostIds
  };
}

function instagramObservationIsSufficientlyRepresented(post, gridItem, now) {
  const publication = instagramPublicationDate(post, now).postedAt
    ?? instagramPublicationDate(gridItem, now).postedAt;
  if (!publication) return false;
  return [
    post?.likes,
    post?.comments,
    post?.views,
    gridItem?.likes,
    gridItem?.comments,
    gridItem?.views
  ].some((value) => instagramMetricIsPositive(value));
}

function instagramMetricIsPositive(value) {
  const numeric = finiteMetric(value) ?? compactMetricNumber(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function instagramObservationPostId(post) {
  return instagramPostIdFromUrl(
    post?.url ?? post?.permalink ?? post?.link
  ) ?? explicitInstagramShortcode(post);
}

export function instagramAdapterProfileIdentityDecision({
  requestedHandle,
  profile,
  targetVerified = false
} = {}) {
  const requested = normalizeInstagramHandle(requestedHandle);
  if (!targetVerified) {
    return { ok: false, reason: "target_mapping_not_verified" };
  }
  if (!requested || !profile || typeof profile !== "object") {
    return { ok: false, reason: "profile_identity_missing" };
  }

  const observedHandles = instagramProfileHandles(profile);
  if (!observedHandles.includes(requested)) {
    return {
      ok: false,
      reason: observedHandles.length
        ? "profile_handle_mismatch"
        : "profile_handle_missing"
    };
  }
  return { ok: true, reason: "verified_exact_profile_handle" };
}

export function instagramBrowserProfileIdentityDecision({
  requestedHandle,
  currentUrl,
  canonicalUrl,
  visibleHandles = [],
  loginWall = false,
  challenge = false
} = {}) {
  const requested = normalizeInstagramHandle(requestedHandle);
  if (!requested) return { ok: false, reason: "requested_handle_missing" };
  if (loginWall) return { ok: false, reason: "login_wall" };
  if (challenge) return { ok: false, reason: "challenge_page" };

  const currentHandle = instagramProfileHandleFromUrl(currentUrl);
  if (currentHandle !== requested) {
    return { ok: false, reason: "final_url_profile_mismatch" };
  }

  const canonicalHandle = instagramProfileHandleFromUrl(canonicalUrl);
  const visible = visibleHandles
    .flatMap(extractInstagramHandles)
    .map(normalizeInstagramHandle)
    .filter(Boolean);
  if (canonicalHandle !== requested && !visible.includes(requested)) {
    return { ok: false, reason: "visible_profile_identity_missing" };
  }

  return { ok: true, reason: "verified_browser_profile_identity" };
}

export function instagramTargetIsVerifiedForIngestion({
  account,
  override,
  matchReason
} = {}) {
  if (String(account?.review_state ?? "").toLowerCase() === "verified") {
    return true;
  }
  if (
    String(override?.instagramValidation?.review_state ?? "").toLowerCase() ===
    "verified"
  ) {
    return true;
  }

  const reason = String(
    matchReason ??
    account?.matchReason ??
    override?.matchReason ??
    ""
  );
  return [
    /official company website/i,
    /official website outbound/i,
    /source chain starts/i,
    /live instagram identity validation/i,
    /manual verified/i,
    /visible read-only social profiles/i,
    /native social account (?:exposed|found).*(?:profile|audit)/i
  ].some((pattern) => pattern.test(reason));
}

/**
 * Normalizes publication dates exposed by Instagram adapters and post-detail
 * readers. Native epoch fields take precedence over display labels, while an
 * explicitly supplied postedAt/publishedAt remains authoritative. Ambiguous,
 * malformed, pre-Instagram, and future values fail closed.
 */
export function instagramPublicationDate(observation, now = Date.now()) {
  const nowMs = normalizedNowMilliseconds(now);
  if (!Number.isFinite(nowMs)) return unknownInstagramPublicationDate();

  const value = firstInstagramPublicationDateValue(observation);
  if (value === null) return unknownInstagramPublicationDate();

  const exactMs = instagramEpochMilliseconds(value);
  if (Number.isFinite(exactMs)) {
    return validInstagramExactTimestamp(exactMs, nowMs)
      ? {
          postedAt: new Date(exactMs).toISOString(),
          publishedAtPrecision: "exact"
        }
      : unknownInstagramPublicationDate();
  }

  const text = String(value).trim();
  const canonicalDay = instagramCalendarDay(text);
  if (canonicalDay) {
    const currentDay = new Date(nowMs).toISOString().slice(0, 10);
    return canonicalDay >= "2010-01-01" && canonicalDay <= currentDay
      ? { postedAt: canonicalDay, publishedAtPrecision: "day" }
      : unknownInstagramPublicationDate();
  }

  const exactTimestamp = instagramIsoTimestampMilliseconds(text);
  return validInstagramExactTimestamp(exactTimestamp, nowMs)
    ? {
        postedAt: new Date(exactTimestamp).toISOString(),
        publishedAtPrecision: "exact"
      }
    : unknownInstagramPublicationDate();
}

export function instagramRecencyDecision(postedAt, cutoffMs) {
  if (!postedAt) return { eligible: false, reason: "missing_publication_date" };
  const postedAtMs = Date.parse(postedAt);
  if (!Number.isFinite(postedAtMs)) {
    return { eligible: false, reason: "invalid_publication_date" };
  }
  if (!Number.isFinite(cutoffMs)) {
    return { eligible: false, reason: "invalid_recency_cutoff" };
  }
  if (postedAtMs < cutoffMs) {
    return { eligible: false, reason: "before_recency_cutoff" };
  }
  return { eligible: true, reason: "within_recency_window" };
}

export function instagramFailureKind(value) {
  const message = String(value ?? "");
  // Compatibility for receipts emitted before bounded coverage became neutral
  // metadata. The word "authenticated" must not turn expected incompleteness
  // into an authentication failure or open the account circuit.
  if (/instagram authenticated history remains non-exhaustive/i.test(message)) {
    return "progress";
  }
  if (
    /\b(?:429|rate limit(?:ed)?|too many requests|slow down|try again later|temporarily restricted)\b/i.test(
      message
    )
  ) {
    return "rate_limited";
  }
  if (
    /\b(?:challenge(?:_page)?|checkpoint|confirm it'?s you|suspicious login|security code)\b/i.test(
      message
    )
  ) {
    return "challenge";
  }
  if (
    /\b(?:401|403|log in|login(?:_wall)?|sign in|authenticated|authentication|session expired|cookie expired)\b/i.test(
      message
    ) ||
    /\b400\b[\s\S]{0,160}\b(?:logged in|log in|sign in|authenticated)\b/i.test(
      message
    )
  ) {
    return "auth";
  }
  if (
    /\b(?:no scored recent instagram posts|empty (?:native )?timeline|hasn['’]t posted|no posts)\b/i.test(
      message
    )
  ) {
    return "empty";
  }
  if (
    /\b(?:profile_identity|profile identity|profile_handle|final_url_profile|visible_profile|adapter failed|extractor failed|command failed|timed? out|timeout|ECONN|ENOTFOUND|browser|transport|socket)\b/i.test(
      message
    )
  ) {
    return "command_or_profile";
  }
  return "other";
}

export function instagramShouldRetryTransientBrowserFailure(value) {
  const message = String(value ?? "");
  if (["auth", "challenge", "rate_limited"].includes(instagramFailureKind(message))) {
    return false;
  }
  return /\b(?:detached while handling command|pre-navigation[\s\S]{0,100}detached|browser extension is running|browser profile[^\r\n]{0,120}not connected|profile[_ -]?disconnected|extension (?:is )?(?:not connected|disconnected)|browser bridge[^\r\n]{0,80}not connected|transport|socket|timed? out|timeout)\b/i.test(
    message
  );
}

export function instagramCollectionAttemptState({
  evidenceCount = 0,
  completedTimelineSourceCount = 0,
  profileIdentityOk = true,
  failureMessages = []
} = {}) {
  const evidence = finiteNonnegativeInteger(evidenceCount);
  const completedSources = finiteNonnegativeInteger(
    completedTimelineSourceCount
  );
  const messages = Array.isArray(failureMessages)
    ? failureMessages
    : [failureMessages];
  const failureKinds = messages
    .map(instagramFailureKind)
    .filter(
      (kind) => kind !== "other" && kind !== "empty" && kind !== "progress"
    );
  const immediateFailureKind = ["challenge", "auth", "rate_limited"].find(
    (kind) => failureKinds.includes(kind)
  );

  if (immediateFailureKind) {
    return {
      status: "failed",
      collectionFailed: true,
      failureKind: immediateFailureKind
    };
  }
  if (!profileIdentityOk || (evidence === 0 && completedSources === 0)) {
    return {
      status: "failed",
      collectionFailed: true,
      failureKind: "command_or_profile"
    };
  }
  return {
    status: "done",
    collectionFailed: false,
    failureKind: evidence > 0 ? null : "empty"
  };
}

export function instagramCircuitDecision({
  consecutiveFailures = 0,
  maxConsecutiveFailures = 3,
  failureKind = "other"
} = {}) {
  const count = finiteNonnegativeInteger(consecutiveFailures);
  const threshold = Math.max(
    1,
    finiteNonnegativeInteger(maxConsecutiveFailures)
  );
  if (failureKind === "progress") {
    return { open: false, reason: null };
  }
  const immediate = ["challenge", "auth", "rate_limited"].includes(
    failureKind
  );
  return {
    open: immediate || count >= threshold,
    reason: immediate
      ? failureKind
      : count >= threshold
        ? "consecutive_failures"
        : null
  };
}

export function mergeVerifiedSocialAccountCandidates(candidates = []) {
  const byIdentity = new Map();
  for (const candidate of candidates) {
    if (!candidate?.platform || !candidate?.url) continue;
    const key = `${candidate.platform}:${comparableAccountUrl(candidate.url)}`;
    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, { ...candidate });
      continue;
    }
    // Later candidates may add fields, but must never erase structured
    // verification/provenance carried by an earlier graph account.
    const merged = {
      ...candidate,
      ...existing,
      review_state:
        existing.review_state ??
        candidate.review_state,
      matchReason:
        existing.matchReason ??
        candidate.matchReason,
      discoveredFromUrl:
        existing.discoveredFromUrl ??
        candidate.discoveredFromUrl
    };
    for (const [field, value] of Object.entries(merged)) {
      if (value === undefined) delete merged[field];
    }
    byIdentity.set(key, merged);
  }
  return [...byIdentity.values()];
}

export function prioritizeInstagramTargets(
  targets,
  {
    evidence = [],
    attempts = new Map(),
    attemptKey = defaultAttemptKey
  } = {}
) {
  const attemptMap =
    attempts instanceof Map ? attempts : new Map(Object.entries(attempts ?? {}));
  const evidenceIds = new Map();
  for (const row of evidence) {
    if (row?.platform !== "instagram" || !row?.entityId) continue;
    const postId = instagramPostIdFromUrl(row?.sourceUrl);
    if (!postId) continue;
    const key = `${row.batchSlug ?? ""}:instagram:${row.entityId}`;
    let postIds = evidenceIds.get(key);
    if (!postIds) {
      postIds = new Set();
      evidenceIds.set(key, postIds);
    }
    postIds.add(postId);
  }
  const evidenceCounts = new Map(
    [...evidenceIds].map(([key, ids]) => [key, ids.size])
  );

  const prioritized = targets
    .filter((target) => target?.platform === "instagram")
    .map((target, originalIndex) => {
      const key = attemptKey(target);
      return {
        target,
        originalIndex,
        key,
        evidenceCount:
          evidenceCounts.get(
            `${target.batchSlug ?? ""}:instagram:${target.entityId}`
          ) ??
          evidenceCounts.get(`:instagram:${target.entityId}`) ??
          0,
        failed: attemptMap.get(key)?.status === "failed" ? 0 : 1,
        checkedAt: finiteTimestamp(attemptMap.get(key)?.checkedAt)
      };
    })
    .sort(
      (left, right) =>
        left.evidenceCount - right.evidenceCount ||
        left.failed - right.failed ||
        left.checkedAt - right.checkedAt ||
        left.key.localeCompare(right.key) ||
        left.originalIndex - right.originalIndex
    )
    .map(({ target }) => target);

  let instagramIndex = 0;
  return targets.map((target) =>
    target?.platform === "instagram"
      ? prioritized[instagramIndex++]
      : target
  );
}

function firstCanonicalInstagramPostUrl(values) {
  for (const value of values) {
    const canonical = canonicalInstagramPostUrl(value);
    if (canonical) return canonical;
  }
  return null;
}

function explicitInstagramShortcode(post) {
  for (const value of [post?.shortcode, post?.code]) {
    const candidate = String(value ?? "").trim();
    if (INSTAGRAM_SHORTCODE_RE.test(candidate)) return candidate;
  }
  return null;
}

function instagramProfileHandles(profile) {
  const values = [
    profile?.username,
    profile?.userName,
    profile?.handle,
    profile?.url,
    profile?.profileUrl,
    profile?.profile_url
  ];
  return [
    ...new Set(
      values
        .flatMap((value) => [
          ...extractInstagramHandles(value),
          instagramProfileHandleFromUrl(value)
        ])
        .map(normalizeInstagramHandle)
        .filter(Boolean)
    )
  ];
}

function instagramProfileHandleFromUrl(value) {
  try {
    const parsed = new URL(value);
    if (!INSTAGRAM_HOST_RE.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return null;
    return normalizeInstagramHandle(parts[0]);
  } catch {
    return null;
  }
}

function extractInstagramHandles(value) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const values = [];
  const exact = normalizeInstagramHandle(text);
  if (exact && /^[A-Za-z0-9._]+$/.test(text.replace(/^@/, ""))) {
    values.push(exact);
  }
  for (const match of text.matchAll(/@([A-Za-z0-9._]+)/g)) {
    values.push(normalizeInstagramHandle(match[1]));
  }
  return values.filter(Boolean);
}

function normalizeInstagramHandle(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
  return /^[a-z0-9._]+$/.test(normalized) ? normalized : null;
}

function comparableAccountUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    return parsed.toString().toLowerCase();
  } catch {
    return String(value ?? "").trim().toLowerCase();
  }
}

function defaultAttemptKey(target) {
  return [
    target?.batchSlug,
    target?.platform,
    target?.entityId,
    target?.url
  ].join(":");
}

function firstInstagramPublicationDateValue(observation) {
  if (
    observation !== null &&
    typeof observation === "object" &&
    !Array.isArray(observation) &&
    !(observation instanceof Date)
  ) {
    for (const field of INSTAGRAM_PUBLICATION_DATE_FIELDS) {
      const value = observation[field];
      if (value === undefined || value === null || value === "") continue;
      return value;
    }
    return null;
  }
  return observation === undefined || observation === null || observation === ""
    ? null
    : observation;
}

function normalizedNowMilliseconds(value) {
  if (value instanceof Date) return value.getTime();
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : Number.NaN;
}

function instagramEpochMilliseconds(value) {
  if (value instanceof Date) return value.getTime();
  const text = typeof value === "number"
    ? String(value)
    : String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,3})?$/.test(text)) return Number.NaN;

  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric <= 0) return Number.NaN;
  const integerDigits = text.split(".", 1)[0].length;
  if (integerDigits >= 9 && integerDigits <= 10) {
    const milliseconds = Math.round(numeric * 1_000);
    return Number.isSafeInteger(milliseconds) ? milliseconds : Number.NaN;
  }
  if (
    !text.includes(".") &&
    integerDigits >= 12 &&
    integerDigits <= 13 &&
    Number.isSafeInteger(numeric)
  ) {
    return numeric;
  }
  return Number.NaN;
}

function instagramCalendarDay(value) {
  const canonical = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (canonical) {
    const year = Number(canonical[1]);
    const month = Number(canonical[2]);
    const day = Number(canonical[3]);
    return validCalendarDay(year, month, day) ? value : null;
  }

  const named = value.match(
    /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})$/i
  );
  if (!named) return null;
  const year = Number(named[3]);
  const month = MONTH_NUMBER_BY_NAME[named[1].toLowerCase()];
  const day = Number(named[2]);
  if (!validCalendarDay(year, month, day)) return null;
  return [year, month, day]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}

function instagramIsoTimestampMilliseconds(value) {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i
  );
  if (!match) return Number.NaN;
  if (!validCalendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) {
    return Number.NaN;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function validInstagramExactTimestamp(timestamp, nowMs) {
  return (
    Number.isFinite(timestamp) &&
    timestamp >= INSTAGRAM_EARLIEST_PUBLICATION_MS &&
    timestamp <= nowMs
  );
}

function validCalendarDay(year, month, day) {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function unknownInstagramPublicationDate() {
  return { postedAt: null, publishedAtPrecision: "unknown" };
}

function finiteTimestamp(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function finiteNonnegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function compactMetricNumber(value) {
  const match = String(value ?? "")
    .replace(/,/g, "")
    .match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMB])?$/i);
  if (!match) return null;
  const multiplier =
    match[2]?.toUpperCase() === "K"
      ? 1_000
      : match[2]?.toUpperCase() === "M"
        ? 1_000_000
        : match[2]?.toUpperCase() === "B"
          ? 1_000_000_000
          : 1;
  return Math.round(Number(match[1]) * multiplier);
}

function finiteMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function nonBlank(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function instagramCaptionsCompatible(left, right) {
  const normalize = (value) => {
    let text = String(value ?? "");
    try {
      text = JSON.parse(`"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    } catch {
      // The visible caption is still useful even when it contains an
      // incomplete escape sequence.
    }
    return text
      .replace(/\\u([0-9a-f]{4})/gi, (_, code) =>
        String.fromCharCode(Number.parseInt(code, 16))
      )
      .replace(/\\\//g, "/")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  };
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 24 && longer.includes(shorter);
}
