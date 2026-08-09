import {
  linkedinAccountSlugFromUrl,
  linkedinNativeAuthorSlugFromUrl,
  linkedinPostIdFromUrl
} from "./social-native-identity.mjs";

export const LINKEDIN_MINIMUM_TARGET_DELAY_MS = 30_000;
export const LINKEDIN_MINIMUM_INTERACTION_DELAY_MS = 3_000;

export function linkedinExecutionPolicy({
  requestedWorkers = 1,
  requestedDelayMs = 0
} = {}) {
  return {
    requestedWorkers: Math.max(1, finiteNonnegativeInteger(requestedWorkers)),
    workers: 1,
    delayMs: Math.max(
      LINKEDIN_MINIMUM_TARGET_DELAY_MS,
      finiteNonnegativeInteger(requestedDelayMs)
    )
  };
}

export async function runLinkedInSerialLane(
  items,
  collect,
  {
    delayMs = LINKEDIN_MINIMUM_TARGET_DELAY_MS,
    sleep = defaultSleep,
    shouldAbort = () => false
  } = {}
) {
  if (typeof collect !== "function") {
    throw new TypeError("LinkedIn serial collection requires a collector function.");
  }
  if (typeof sleep !== "function" || typeof shouldAbort !== "function") {
    throw new TypeError("LinkedIn serial collection safety hooks must be functions.");
  }

  const queue = Array.from(items ?? []);
  const policy = linkedinExecutionPolicy({ requestedWorkers: 1, requestedDelayMs: delayMs });
  let attemptedCount = 0;
  let aborted = false;

  for (let index = 0; index < queue.length; index += 1) {
    if (shouldAbort()) {
      aborted = true;
      break;
    }

    // The worker index is deliberately fixed at zero. This lane never starts
    // a second LinkedIn request until the first request and its checkpoint have
    // completed.
    await collect(queue[index], 0);
    attemptedCount += 1;

    if (shouldAbort()) {
      aborted = true;
      break;
    }
    if (index < queue.length - 1) {
      await sleep(policy.delayMs);
    }
  }

  return {
    attemptedCount,
    untouchedCount: Math.max(0, queue.length - attemptedCount),
    aborted,
    workers: policy.workers,
    delayMs: policy.delayMs
  };
}

export function linkedinAdapterSupportsAccountUrl(accountUrl) {
  try {
    const url = new URL(accountUrl);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    return (
      (host === "linkedin.com" || host.endsWith(".linkedin.com")) &&
      /^\/in\/[^/?#]+\/?$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function mergeOwnedLinkedInPosts(
  postGroups,
  {
    accountUrl,
    targetName,
    limit = Number.POSITIVE_INFINITY
  }
) {
  const expectedAccountSlug = linkedinAccountSlugFromUrl(accountUrl);
  if (!expectedAccountSlug) return [];

  const observationsById = new Map();
  for (const post of postGroups.flat()) {
    const normalized = normalizeLinkedInPost(post);
    if (!normalized) continue;
    observationsById.set(normalized.id, [
      ...(observationsById.get(normalized.id) ?? []),
      { original: post, normalized }
    ]);
  }

  const ownedOriginals = [];
  for (const observations of observationsById.values()) {
    // Repost status belongs to the native activity, not one extraction lane.
    // If DOM proves the activity is a wrapper, an opaque/richer adapter copy
    // of that same activity must not resurrect it as an original post.
    if (
      observations.some(({ original }) =>
        linkedinPostIsExplicitRepost(original, targetName)
      )
    ) {
      continue;
    }
    ownedOriginals.push(
      observations
        .map(({ normalized }) => normalized)
        .reduce((merged, post) => mergeLinkedInPost(merged, post), null)
    );
  }

  return ownedOriginals
    // OpenCLI's adapter returns opaque /feed/update/ activity URLs without an
    // author URL. Merge the same native activity across adapter and DOM first,
    // then require the merged observation to contain exact owner proof. This
    // lets DOM identity authorize adapter metrics without ever trusting an
    // opaque adapter row on its own.
    .filter((post) =>
      linkedinPostStrictlyBelongsToAccount(post, accountUrl, targetName)
    )
    .sort(compareLinkedInRecency)
    .slice(0, limit);
}

export function linkedinPostStrictlyBelongsToAccount(post, accountUrl, targetName) {
  const expectedAccountSlug = linkedinAccountSlugFromUrl(accountUrl);
  const postId = linkedinPostIdFromUrl(post?.url);
  if (!expectedAccountSlug || !postId || linkedinPostIsExplicitRepost(post, targetName)) {
    return false;
  }

  const nativeAuthorSlug = linkedinNativeAuthorSlugFromUrl(post.url);
  const authorUrlMatch = (post.authorUrls ?? []).some(
    (url) => linkedinAccountSlugFromUrl(url) === expectedAccountSlug
  );
  if (nativeAuthorSlug && nativeAuthorSlug !== expectedAccountSlug) return false;
  if (!nativeAuthorSlug && !authorUrlMatch) return false;

  return linkedinAuthorTextMatchesTarget(post, targetName);
}

export function linkedinPostIsExplicitRepost(post, targetName = "") {
  // LinkedIn places repost ownership in the DOM card header. Restrict the
  // generic phrase to that header shape so ordinary native prose such as
  // “I shared this analysis…” is never treated as a reshare wrapper.
  const headers = [post?.rawText, post?.raw_text]
    .map((value) => String(value ?? "").slice(0, 700))
    .filter(Boolean);

  if (
    headers.some((value) =>
      /^\s*Feed post number\s+\d+\s+[^•\n]{1,220}?\b(?:reposted|reshared|shared)\s+this\b/i.test(
        value
      )
    )
  ) {
    return true;
  }

  // A nested LinkedIn reshare card can omit the words "reposted/shared this".
  // It still renders two independent actor headers, each with its own Follow
  // control. In that shape the only activity URL exposed by the DOM is often
  // the embedded parent's ID, while the reactions belong to the outer wrapper.
  // Treating that mixed card as native evidence duplicates one physical post
  // across every profile that commented on it.
  if (
    headers.some(
      (value) =>
        /^\s*Feed post number\s+\d+\b/i.test(value) &&
        (value.match(/\bFollow\b/g) ?? []).length >= 2
    )
  ) {
    return true;
  }

  // LinkedIn's compact nested organization card can expose only one outer
  // Follow control. The embedded organization header is still structurally
  // identifiable because its public follower count and relative timestamp
  // occur after that outer Follow control. The only activity URL in this
  // shape belongs to the embedded organization post, so accepting it would
  // attribute the same physical post to every founder who commented on it.
  if (
    headers.some(
      (value) =>
        /^\s*Feed post number\s+\d+\b/i.test(value) &&
        /\bFollow\b[\s\S]{0,1400}\b[0-9][0-9,.]*\s+followers?\s+(?:\d+\s*)?(?:s|m|h|d|w|mo|yr|minute|hour|day|week|month|year)s?\s*(?:•|·)/i.test(
          value
        )
    )
  ) {
    return true;
  }

  // Compact LinkedIn cards can omit both the feed-post accessibility prefix
  // and an explicit target parameter when replayed from persisted evidence.
  // Their wrapper header repeats the same actor on both sides of a relative
  // timestamp before "shared this". Match that structural header directly so
  // finalization can quarantine it without depending on mutable catalog names.
  if (
    headers.some((value) =>
      /^\s*([^•\r\n]{2,120}?)\s+\1\s+(?:\d+(?:mo|yr|[smhdwy])|\d+\s+(?:minute|hour|day|week|month|year)s?\s+ago)\s+\1\s+(?:reposted|reshared|shared)\s+this\b/iu.test(
        value
      )
    )
  ) {
    return true;
  }

  const target = String(targetName ?? "").trim();
  return Boolean(
    target &&
      headers.some((value) =>
        [
          new RegExp(
            `^\\s*(?:Feed post number\\s+\\d+\\s+)?(?:${escapeRegExp(target)}\\s+){1,2}(?:reposted|reshared|shared)\\s+this\\b`,
            "i"
          ),
          // Compact cards can repeat the profile name around the relative
          // timestamp without the accessible "Feed post number" prefix:
          // "Alexandre Labreche Alexandre Labreche 1d Alexandre Labreche
          // shared this …". Requiring the target both at the beginning and
          // immediately before the wrapper verb keeps ordinary post prose
          // containing "shared this" eligible.
          new RegExp(
            `^\\s*${escapeRegExp(target)}\\b.{0,180}?\\b${escapeRegExp(target)}\\s+(?:reposted|reshared|shared)\\s+this\\b`,
            "i"
          )
        ].some((pattern) => pattern.test(value))
      )
  );
}

export function linkedinCollectionAttemptState({
  postCount = 0,
  attemptedSourceCount = 0,
  completedSourceCount = 0,
  failedSourceCount = 0
} = {}) {
  const posts = finiteNonnegativeInteger(postCount);
  const attempted = finiteNonnegativeInteger(attemptedSourceCount);
  const completed = finiteNonnegativeInteger(completedSourceCount);
  const failed = finiteNonnegativeInteger(failedSourceCount);
  if (posts > 0) {
    return { status: "done", collectionFailed: false };
  }
  // A successful empty lane must not hide an auth, rate-limit, or transport
  // failure in the other authenticated lane. Leave the target retryable when
  // no attributable post survived and any attempted source failed.
  if (failed > 0) {
    return { status: "failed", collectionFailed: true };
  }
  if (completed > 0) return { status: "done", collectionFailed: false };
  return {
    status: attempted > 0 ? "failed" : "done",
    collectionFailed: attempted > 0
  };
}

export function prioritizeLinkedInTargets(
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
    if (row?.platform !== "linkedin" || !row?.entityId) continue;
    const postId =
      (/^\d+$/.test(String(row?.platformPostId ?? ""))
        ? String(row.platformPostId)
        : linkedinPostIdFromUrl(row?.sourceUrl));
    if (!postId) continue;
    const key = `${row.batchSlug ?? ""}:${row.entityId}`;
    evidenceIds.set(key, new Set([...(evidenceIds.get(key) ?? []), postId]));
  }
  const evidenceCounts = new Map(
    [...evidenceIds].map(([key, ids]) => [key, ids.size])
  );

  const prioritized = targets
    .filter((target) => target?.platform === "linkedin")
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
        // Exhaust the untouched zero-coverage inventory before retrying known
        // failures. Failed targets remain eligible in the next band, followed
        // by routine low-coverage/old refreshes.
        priorityBand:
          evidenceCount === 0 && !attemptMap.has(key)
            ? 0
            : attempt?.status === "failed"
              ? 1
              : 2,
        checkedAt: finiteTimestamp(attempt?.checkedAt)
      };
    })
    .sort(
      (left, right) =>
        left.priorityBand - right.priorityBand ||
        left.evidenceCount - right.evidenceCount ||
        left.checkedAt - right.checkedAt ||
        left.key.localeCompare(right.key) ||
        left.originalIndex - right.originalIndex
    )
    .map(({ target }) => target);

  let linkedinIndex = 0;
  return targets.map((target) =>
    target?.platform === "linkedin"
      ? prioritized[linkedinIndex++]
      : target
  );
}

export function linkedinSafetySignal(value) {
  const message = typeof value === "string" ? value : safeJson(value);
  const taggedSignal = message.match(
    /\bLinkedIn safety stop \((account_safety|auth|rate_limited)\)/i
  )?.[1]?.toLowerCase();
  if (taggedSignal) return taggedSignal;
  if (
    /(?:\bHTTP(?:\/\d(?:\.\d)?)?\s*429\b|\bstatus(?:\s+code)?\s*[:=]?\s*429\b|\b429\s+(?:too many requests|rate limit)|\brate limit(?:ed|ing)?\b|\btoo many requests\b|\bslow down\b|\btemporarily restricted due to (?:request|activity) volume\b)/i.test(
      message
    )
  ) {
    return "rate_limited";
  }
  if (
    /(?:linkedin\.com\/checkpoint\b|\/checkpoint\/(?:challenge|lg)\b|\bsecurity checkpoint\b|\bcheckpoint (?:challenge|required)\b|^\s*checkpoint\s*$|\b(?:linkedin )?challenge (?:page|required)\b|^\s*challenge\s*$|\bconfirm it['’]?s you\b|\bsecurity code\b|\bverify (?:your )?(?:identity|account)\b|\bidentity verification\b|\bsuspicious (?:login|activity)\b|\bunusual activity (?:was detected|on your account)\b|\bwe(?:'ve| have) detected automated activity\b|\bautomated activity (?:has been )?detected\b|\bcommercial use limit\b|\byour account (?:has been |is )?(?:temporarily |permanently )?(?:restricted|suspended)\b|\baccount[-\s]+warning\b|\bprotect your account\b|\bcaptcha\b)/i.test(
      message
    )
  ) {
    return "account_safety";
  }
  if (
    /(?:\bsign in to (?:continue|linkedin)\b|\blog in to (?:continue|linkedin)\b|\blinkedin (?:login|sign in)\b|\bsession expired\b)/i.test(
      message
    )
  ) {
    return "auth";
  }
  return null;
}

export function linkedinFailureRequiresImmediateAbort(value) {
  const safetySignal = linkedinSafetySignal(value);
  if (safetySignal) return true;
  const kind = ["account_safety", "auth", "rate_limited"].includes(value)
    ? value
    : linkedinFailureKind(value);
  return kind === "account_safety" || kind === "auth" || kind === "rate_limited";
}

export function linkedinFailureKind(value) {
  const message = String(value ?? "");
  const safetySignal = linkedinSafetySignal(message);
  if (safetySignal) return safetySignal;
  if (
    /\b(?:log in|login|sign in|authenticated|authentication|session expired)\b/i.test(
      message
    )
  ) {
    return "auth";
  }
  if (/\b(?:no visible posts|empty result|hasn['’]t posted|no posts)\b/i.test(message)) {
    return "empty";
  }
  if (
    /\b(?:no attributable|ownership mismatch|owner mismatch|author mismatch|does not belong|did not belong|unsupported linkedin url shape|url host did not match)\b/i.test(
      message
    )
  ) {
    return "target_specific";
  }
  if (
    /\b(?:timed? out|timeout|ECONN|ENOTFOUND|transport|socket|connection (?:closed|dropped|failed|refused)|browser (?:closed|crashed|disconnected|unavailable))\b/i.test(
      message
    )
  ) {
    return "transport";
  }
  return "system";
}

export function linkedinCircuitDecision({
  consecutiveFailures = 0,
  maxConsecutiveFailures = 5,
  failureKind = "other"
} = {}) {
  const count = finiteNonnegativeInteger(consecutiveFailures);
  const threshold = Math.max(1, finiteNonnegativeInteger(maxConsecutiveFailures));
  const immediate =
    failureKind === "account_safety" ||
    failureKind === "auth" ||
    failureKind === "rate_limited";
  const repeatable = failureKind === "transport" || failureKind === "system";
  return {
    open: immediate || (repeatable && count >= threshold),
    reason: immediate
      ? failureKind
      : repeatable && count >= threshold
        ? "consecutive_failures"
        : null
  };
}

export function linkedinCircuitStateTransition({
  previousConsecutiveFailures = 0,
  collectionFailed = false,
  maxConsecutiveFailures = 5,
  failureKind = "system"
} = {}) {
  const infrastructureFailure =
    failureKind === "account_safety" ||
    failureKind === "auth" ||
    failureKind === "rate_limited" ||
    failureKind === "transport" ||
    failureKind === "system";
  const consecutiveFailures =
    collectionFailed && infrastructureFailure
      ? finiteNonnegativeInteger(previousConsecutiveFailures) + 1
      : 0;
  return {
    consecutiveFailures,
    ...linkedinCircuitDecision({
      consecutiveFailures,
      maxConsecutiveFailures,
      failureKind
    })
  };
}

function normalizeLinkedInPost(post) {
  const id = linkedinPostIdFromUrl(post?.url);
  if (!id) return null;
  const body = longerText(post?.body, post?.text);
  const rawText = longerText(post?.rawText, post?.raw_text, body);
  return {
    ...post,
    id,
    url: canonicalLinkedInPostUrl(post.url),
    author: String(post?.author ?? "").trim(),
    authorUrls: uniqueStrings(post?.authorUrls, post?.author_urls),
    body,
    rawText,
    postedAt: post?.postedAt ?? post?.posted_at ?? null,
    reactions: numberOrNull(post?.reactions),
    comments: numberOrNull(post?.comments),
    reposts: numberOrNull(post?.reposts),
    impressions: numberOrNull(post?.impressions),
    mediaUrls: uniqueStrings(
      post?.mediaUrls,
      post?.media_urls,
      splitPipeValues(post?.media_urls)
    )
  };
}

function linkedinAuthorTextMatchesTarget(post, targetName) {
  const target = normalizeWords(targetName);
  if (!target) return false;
  const author = normalizeWords(post?.author);
  const header = normalizeWords(String(post?.rawText ?? "").slice(0, 360));
  return author === target || header.includes(target);
}

function mergeLinkedInPost(existing, incoming) {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    author: longerText(existing.author, incoming.author),
    body: longerText(existing.body, incoming.body),
    rawText: longerText(existing.rawText, incoming.rawText),
    postedAt: morePreciseDate(existing.postedAt, incoming.postedAt),
    reactions: maxFinite(existing.reactions, incoming.reactions),
    comments: maxFinite(existing.comments, incoming.comments),
    reposts: maxFinite(existing.reposts, incoming.reposts),
    impressions: maxFinite(existing.impressions, incoming.impressions),
    authorUrls: uniqueStrings(existing.authorUrls, incoming.authorUrls),
    mediaUrls: uniqueStrings(existing.mediaUrls, incoming.mediaUrls)
  };
}

function canonicalLinkedInPostUrl(value) {
  try {
    const url = new URL(value);
    url.protocol = "https:";
    url.hostname = "www.linkedin.com";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function compareLinkedInRecency(left, right) {
  const leftTime = Date.parse(left?.postedAt ?? "");
  const rightTime = Date.parse(right?.postedAt ?? "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return String(right?.id ?? "").localeCompare(String(left?.id ?? ""));
}

function normalizeWords(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitPipeValues(value) {
  return typeof value === "string" ? value.split(/\s*\|\s*/).filter(Boolean) : [];
}

function uniqueStrings(...groups) {
  return [...new Set(groups.flat(Infinity).filter(Boolean).map(String))];
}

function longerText(...values) {
  return (
    values
      .map((value) => String(value ?? "").trim())
      .sort((left, right) => right.length - left.length)[0] ?? ""
  );
}

function morePreciseDate(left, right) {
  const candidates = [left, right].filter(Boolean);
  const exact = candidates.find((value) =>
    /(?:\d{4}|[+-]\d{4}|GMT|UTC)/i.test(String(value))
  );
  return exact ?? candidates[0] ?? null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function maxFinite(...values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
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

function safeJson(value) {
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
