const INSTAGRAM_HOST_RE = /^(?:www\.)?instagram\.com$/i;
const INSTAGRAM_SHORTCODE_RE = /^[A-Za-z0-9_-]+$/;
const INSTAGRAM_EARLIEST_PUBLICATION_MS = Date.UTC(2010, 0, 1);
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

export function canonicalInstagramPostUrl(value) {
  try {
    const parsed = new URL(value);
    if (!INSTAGRAM_HOST_RE.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (
      parts.length < 2 ||
      !/^(?:p|reel|tv)$/i.test(parts[0]) ||
      !INSTAGRAM_SHORTCODE_RE.test(parts[1])
    ) {
      return null;
    }
    return `https://www.instagram.com/${parts[0].toLowerCase()}/${parts[1]}/`;
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
    .filter((kind) => kind !== "other" && kind !== "empty");
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
    const key = `${row.batchSlug ?? ""}:${row.entityId}`;
    evidenceIds.set(key, new Set([...(evidenceIds.get(key) ?? []), postId]));
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
          evidenceCounts.get(`${target.batchSlug ?? ""}:${target.entityId}`) ??
          evidenceCounts.get(`:${target.entityId}`) ??
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
