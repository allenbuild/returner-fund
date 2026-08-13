export const DEFAULT_LOGGED_IN_SOCIAL_FRESH_FOR_HOURS = 12;
export const LINKEDIN_CHILD_SAFETY_STOP_EXIT_CODE = 86;

export function linkedinChildSafetyStopDecision(failureKind) {
  const normalized = String(failureKind ?? "").trim().toLowerCase();
  const terminal = ["account_safety", "auth", "rate_limited"].includes(
    normalized
  );
  return terminal
    ? {
        terminal: true,
        signal: "LINKEDIN_CHILD_SAFETY_STOP",
        exitCode: LINKEDIN_CHILD_SAFETY_STOP_EXIT_CODE,
        failureKind: normalized
      }
    : {
        terminal: false,
        signal: null,
        exitCode: 0,
        failureKind: normalized || "system"
      };
}

export function collectionTargetShouldRun(
  target,
  {
    attempts = new Map(),
    attemptKey = defaultAttemptKey,
    force = false,
    retryEmpty = false,
    terminalCompletedPlatforms = [],
    freshForHours = DEFAULT_LOGGED_IN_SOCIAL_FRESH_FOR_HOURS,
    now = Date.now()
  } = {}
) {
  const attemptMap =
    attempts instanceof Map ? attempts : new Map(Object.entries(attempts ?? {}));
  const attempt = attemptMap.get(attemptKey(target));
  const platform = normalizePlatform(target?.platform);
  const terminalPlatforms = normalizedPlatformSet(terminalCompletedPlatforms);
  if (attempt?.status === "done" && terminalPlatforms.has(platform)) {
    return false;
  }
  if (force) return true;
  const instagramTarget =
    platform === "instagram";
  const completedBoundedAttempt =
    attempt?.status === "done" ||
    (instagramTarget && attempt?.status === "partial");
  if (!attempt || !completedBoundedAttempt) return true;
  // Instagram coverage remains explicitly non-exhaustive because neither the
  // adapter nor the browser provides a trustworthy resume cursor. A completed
  // bounded window still observes the normal freshness SLA so it does not
  // monopolize target throughput or delay the serial LinkedIn lane.
  if (retryEmpty && Number(attempt.count ?? 0) === 0) return true;
  return !completedAttemptIsFresh(attempt, { freshForHours, now });
}

export function selectRunnableCollectionTargets(
  targets,
  {
    attempts = new Map(),
    attemptKey = defaultAttemptKey,
    force = false,
    retryEmpty = false,
    terminalCompletedPlatforms = [],
    freshForHours = DEFAULT_LOGGED_IN_SOCIAL_FRESH_FOR_HOURS,
    now = Date.now(),
    limit = Number.POSITIVE_INFINITY
  } = {}
) {
  const normalizedLimit = Number.isFinite(Number(limit))
    ? Math.max(0, Math.floor(Number(limit)))
    : Number.POSITIVE_INFINITY;
  const normalizedTerminalCompletedPlatforms = normalizedPlatformSet(
    terminalCompletedPlatforms
  );
  return (targets ?? [])
    .filter((target) =>
      collectionTargetShouldRun(target, {
        attempts,
        attemptKey,
        force,
        retryEmpty,
        terminalCompletedPlatforms: normalizedTerminalCompletedPlatforms,
        freshForHours,
        now
      })
    )
    .slice(0, normalizedLimit);
}

function completedAttemptIsFresh(
  attempt,
  { freshForHours = DEFAULT_LOGGED_IN_SOCIAL_FRESH_FOR_HOURS, now = Date.now() } = {}
) {
  const checkedAtMs = timestampMillis(attempt?.checkedAt);
  const nowMs = timestampMillis(now);
  if (!Number.isFinite(checkedAtMs) || !Number.isFinite(nowMs)) return false;

  const configuredHours = Number(freshForHours);
  const normalizedHours = Number.isFinite(configuredHours)
    ? Math.max(0, configuredHours)
    : DEFAULT_LOGGED_IN_SOCIAL_FRESH_FOR_HOURS;
  if (normalizedHours === 0) return false;

  return nowMs - checkedAtMs < normalizedHours * 60 * 60 * 1000;
}

function timestampMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(String(value ?? ""));
}

/**
 * Fail closed when one native social account is mapped to more than one owner.
 *
 * A collector cannot infer whether a shared profile should be attributed to a
 * company or a founder. Fetching it once per entity can duplicate every post,
 * while fetching only the first target makes attribution depend on incidental
 * target ordering. Keep every member of an ambiguous group out of the runnable
 * set until the canonical account map assigns the profile to exactly one
 * entity.
 */
export function partitionCollectionTargetsByOwnerAmbiguity(targets) {
  const normalizedTargets = Array.isArray(targets) ? targets : [];
  const groups = new Map();

  for (const [index, target] of normalizedTargets.entries()) {
    const accountIdentity = collectionTargetAccountIdentity(target);
    if (!accountIdentity) continue;
    const groupKey = [
      target?.batchSlug ?? "",
      normalizePlatform(target?.platform),
      accountIdentity
    ].join(":");
    const group = groups.get(groupKey) ?? {
      groupKey,
      batchSlug: target?.batchSlug ?? null,
      platform: normalizePlatform(target?.platform),
      accountIdentity,
      targetIndexes: [],
      entityIds: new Set(),
      ownerKeys: new Set()
    };
    group.targetIndexes.push(index);
    const entityId = String(target?.entityId ?? "").trim();
    if (entityId) group.entityIds.add(entityId);
    group.ownerKeys.add(entityId ? `entity:${entityId}` : `unknown-target:${index}`);
    groups.set(groupKey, group);
  }

  const ambiguousIndexes = new Set();
  const collisions = [];
  for (const group of groups.values()) {
    if (group.ownerKeys.size <= 1) continue;
    group.targetIndexes.forEach((index) => ambiguousIndexes.add(index));
    collisions.push({
      batchSlug: group.batchSlug,
      platform: group.platform,
      accountIdentity: group.accountIdentity,
      entityIds: [...group.entityIds].sort(),
      targets: group.targetIndexes.map((index) => normalizedTargets[index])
    });
  }

  return {
    targets: normalizedTargets.filter((_, index) => !ambiguousIndexes.has(index)),
    quarantinedTargets: normalizedTargets.filter((_, index) =>
      ambiguousIndexes.has(index)
    ),
    collisions: collisions.sort((left, right) =>
      [
        left.batchSlug ?? "",
        left.platform ?? "",
        left.accountIdentity ?? ""
      ].join(":").localeCompare([
        right.batchSlug ?? "",
        right.platform ?? "",
        right.accountIdentity ?? ""
      ].join(":"))
    )
  };
}

export function collectionTargetAccountIdentity(target) {
  const platform = normalizePlatform(target?.platform);
  try {
    const url = new URL(target?.url);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const segments = url.pathname.split("/").filter(Boolean);

    if (platform === "x") {
      if (!["x.com", "twitter.com"].includes(hostname)) return null;
      const handle = normalizeXHandle(segments[0]);
      return handle ? `x:${handle}` : null;
    }

    if (platform === "instagram") {
      if (hostname !== "instagram.com") return null;
      const handle = normalizeInstagramHandle(segments[0]);
      return handle ? `instagram:${handle}` : null;
    }

    if (platform === "linkedin") {
      if (hostname !== "linkedin.com" || segments.length < 2) return null;
      return `linkedin:${segments
        .slice(0, 2)
        .map((segment) => segment.toLowerCase())
        .join("/")}`;
    }

    return `${platform}:${hostname}/${segments
      .map((segment) => segment.toLowerCase())
      .join("/")}`;
  } catch {
    return null;
  }
}

function defaultAttemptKey(target) {
  return [
    target?.batchSlug ?? "",
    target?.entityType ?? "",
    target?.entityId ?? "",
    target?.platform ?? "",
    target?.url ?? ""
  ].join(":");
}

function normalizePlatform(value) {
  const platform = String(value ?? "").trim().toLowerCase();
  return platform === "twitter" ? "x" : platform;
}

function normalizedPlatformSet(values) {
  if (
    values instanceof Set &&
    [...values].every((value) => normalizePlatform(value) === value)
  ) {
    return values;
  }
  const source = values instanceof Set
    ? values
    : Array.isArray(values)
      ? values
      : String(values ?? "").split(",");
  return new Set(
    [...source]
      .map(normalizePlatform)
      .filter(Boolean)
  );
}

function normalizeXHandle(value) {
  const handle = String(value ?? "").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{1,15}$/.test(handle) ? handle : null;
}

function normalizeInstagramHandle(value) {
  const handle = String(value ?? "").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_.]{1,30}$/.test(handle) ? handle : null;
}
