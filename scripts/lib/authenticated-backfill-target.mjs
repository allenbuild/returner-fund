import { createHash } from "node:crypto";

const AUTHENTICATED_BACKFILL_BATCHES = Object.freeze([
  "S2026",
  "S26",
  "A16ZSR006"
]);
export const AUTHENTICATED_BACKFILL_COMPANY_SLUG_MAX_LENGTH = 128;
const AUTHENTICATED_PLAN_IDENTITY_SAMPLE_LIMIT = 10;

export function resolveAuthenticatedBackfillTarget({
  authenticatedReplay = false,
  requestedScope = "all",
  batchSlug = "all",
  companySlug = ""
} = {}) {
  const normalizedBatch = String(batchSlug ?? "all").trim();
  const normalizedCompany = String(companySlug ?? "").trim();
  const hasBatch = normalizedBatch !== "all";
  const hasCompany = normalizedCompany.length > 0;

  if (!hasBatch && !hasCompany) return null;
  if (authenticatedReplay !== true) {
    throw new Error(
      "Authenticated backfill target is available only with authenticated social replay."
    );
  }
  if (requestedScope !== "linkedin") {
    throw new Error(
      "Authenticated backfill target requires the linkedin-only authenticated scope."
    );
  }
  if (!hasBatch && hasCompany) {
    throw new Error(
      "Authenticated backfill company targeting requires an exact batch."
    );
  }
  if (!AUTHENTICATED_BACKFILL_BATCHES.includes(normalizedBatch)) {
    throw new Error(
      `Authenticated backfill target batch must be one of ${AUTHENTICATED_BACKFILL_BATCHES.join(", ")}.`
    );
  }
  if (hasCompany && (
    normalizedCompany.length > AUTHENTICATED_BACKFILL_COMPANY_SLUG_MAX_LENGTH ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedCompany)
  )) {
    throw new Error(
      `Authenticated backfill target company slug must be a canonical lowercase slug no longer than ` +
      `${AUTHENTICATED_BACKFILL_COMPANY_SLUG_MAX_LENGTH} characters.`
    );
  }
  return Object.freeze({
    batchSlug: normalizedBatch,
    ...(hasCompany ? { companySlug: normalizedCompany } : {})
  });
}

export function authenticatedBackfillTargetEquals(left, right) {
  if (left === null || right === null) return left === right;
  if (
    !isCanonicalAuthenticatedBackfillTarget(left) ||
    !isCanonicalAuthenticatedBackfillTarget(right)
  ) {
    return false;
  }
  return Boolean(
    left.batchSlug === right.batchSlug &&
    optionalCompanySlug(left) === optionalCompanySlug(right)
  );
}

export function supportedAuthenticatedBackfillBatches() {
  return [...AUTHENTICATED_BACKFILL_BATCHES];
}

export function assertAuthenticatedBackfillTargetExists(catalogs, requestedTarget) {
  if (!requestedTarget) return null;
  if (!isCanonicalAuthenticatedBackfillTarget(requestedTarget)) {
    throw new Error("Authenticated backfill target is not canonical.");
  }
  const matchingCatalogs = (Array.isArray(catalogs) ? catalogs : [])
    .filter((catalog) => catalog?.slug === requestedTarget.batchSlug);
  if (matchingCatalogs.length !== 1) {
    throw new Error(
      `Authenticated backfill target batch ${requestedTarget.batchSlug} ` +
      `must resolve to exactly one pinned publication catalog; resolved ${matchingCatalogs.length}.`
    );
  }
  if (!requestedTarget.companySlug) return requestedTarget;
  const expectedCompanySourceKey = requestedTarget.batchSlug === "A16ZSR006"
    ? `a16z-speedrun-006-${requestedTarget.companySlug}`
    : `company-${requestedTarget.companySlug}`;
  const matches = matchingCatalogs
    .flatMap((catalog) => Array.isArray(catalog?.companies) ? catalog.companies : [])
    // loadAutonomousCatalogs() intentionally exposes normalized company
    // identities, not the source snapshot's raw slug field.
    .filter((company) => company?.sourceKey === expectedCompanySourceKey);
  if (matches.length !== 1) {
    throw new Error(
      `Authenticated backfill target ${requestedTarget.batchSlug}/${requestedTarget.companySlug} ` +
      `must resolve to exactly one company in the pinned publication catalog; resolved ${matches.length}.`
    );
  }
  return requestedTarget;
}

export function assertAuthenticatedReplayReceiptBinding({
  authenticatedReplay = false,
  requestedScope = "all",
  requestedTarget = null,
  receipt
} = {}) {
  const replayReceipt = receipt?.authenticatedSocialReplay;
  const receiptClaimsAuthenticatedReplay = Boolean(
    replayReceipt && typeof replayReceipt === "object" && !Array.isArray(replayReceipt)
  );
  if (!authenticatedReplay) {
    if (receiptClaimsAuthenticatedReplay) {
      throw new Error(
        "Idempotent replay receipt belongs to an authenticated social replay, not this request."
      );
    }
    return;
  }
  const expectedPlatforms = requestedScope === "linkedin"
    ? ["linkedin"]
    : requestedScope === "all"
      ? ["instagram", "linkedin"]
      : null;
  if (
    !receiptClaimsAuthenticatedReplay ||
    !expectedPlatforms ||
    replayReceipt.requestedScope !== requestedScope ||
    !authenticatedBackfillTargetEquals(
      replayReceipt.requestedTarget ?? null,
      requestedTarget
    ) ||
    JSON.stringify(replayReceipt.requestedPlatforms) !== JSON.stringify(expectedPlatforms)
  ) {
    throw new Error(
      "Idempotent authenticated replay receipt does not match the exact requested scope and target."
    );
  }
}

export function assertAuthenticatedLinkedInPlanTarget(plan, requestedTarget) {
  if (requestedTarget && !isCanonicalAuthenticatedBackfillTarget(requestedTarget)) {
    throw new Error("LinkedIn plan-only child received a non-canonical requested target.");
  }
  const requestedCompanySlug = optionalCompanySlug(requestedTarget);
  for (const [label, targets, requireNonEmpty] of [
    ["targets", plan?.targets, Boolean(requestedTarget)],
    ["runnableTargets", plan?.runnableTargets, false]
  ]) {
    if (!Array.isArray(targets) || (requireNonEmpty && targets.length === 0)) {
      throw new Error(`LinkedIn plan-only child returned invalid ${label}.`);
    }
    if (targets.some((target) =>
      target?.platform !== "linkedin" || (requestedTarget && (
      target?.batchSlug !== requestedTarget.batchSlug ||
      (requestedCompanySlug !== null && target?.companySlug !== requestedCompanySlug)
      ))
    )) {
      throw new Error(
        `LinkedIn plan-only child returned a non-LinkedIn or out-of-scope ${label} target.`
      );
    }
  }
  if (!requestedTarget) return;
  if (
    plan?.batchSlug !== requestedTarget.batchSlug ||
    (requestedCompanySlug === null
      ? plan?.requestedTarget !== null && plan?.requestedTarget !== undefined
      : !authenticatedBackfillTargetEquals(plan?.requestedTarget ?? null, requestedTarget))
  ) {
    throw new Error("LinkedIn plan-only child did not bind the exact requested replay batch and company scope.");
  }
}

export function compactAuthenticatedLinkedInPlan(plan) {
  const targets = planTargetIdentities(plan?.targets);
  const runnableTargets = planTargetIdentities(plan?.runnableTargets);
  return {
    schemaVersion: 1,
    batchSlug: plan?.batchSlug ?? null,
    requestedTarget: plan?.requestedTarget ?? null,
    catalogCompanyCount: nonnegativeIntegerOrNull(plan?.catalogCompanyCount),
    companyCount: nonnegativeIntegerOrNull(plan?.companyCount),
    founderCount: nonnegativeIntegerOrNull(plan?.founderCount),
    remainingTargetCount: nonnegativeIntegerOrNull(plan?.remainingTargetCount),
    selectedForThisInvocationCount: nonnegativeIntegerOrNull(
      plan?.selectedForThisInvocationCount
    ),
    linkedinExecution: {
      remainingTargetCount: nonnegativeIntegerOrNull(
        plan?.linkedinExecution?.remainingTargetCount
      ),
      selectedForThisInvocationCount: nonnegativeIntegerOrNull(
        plan?.linkedinExecution?.selectedForThisInvocationCount
      ),
      runnableTargetCount: nonnegativeIntegerOrNull(
        plan?.linkedinExecution?.runnableTargetCount
      )
    },
    targetCount: targets.length,
    runnableTargetCount: runnableTargets.length,
    targetIdentitiesSha256: canonicalHash(targets),
    runnableTargetIdentitiesSha256: canonicalHash(runnableTargets),
    targetIdentitySamples: targets.slice(0, AUTHENTICATED_PLAN_IDENTITY_SAMPLE_LIMIT),
    runnableTargetIdentitySamples: runnableTargets.slice(
      0,
      AUTHENTICATED_PLAN_IDENTITY_SAMPLE_LIMIT
    )
  };
}

function planTargetIdentities(value) {
  if (!Array.isArray(value)) return [];
  return value.map((target) => ({
    batchSlug: target?.batchSlug ?? null,
    companySlug: target?.companySlug ?? null,
    entityType: target?.entityType ?? null,
    entityId: target?.entityId ?? null,
    platform: target?.platform ?? null,
    checkpointKey: target?.checkpointKey ?? null
  }));
}

function nonnegativeIntegerOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : null;
}

function canonicalHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function optionalCompanySlug(target) {
  return target && Object.hasOwn(target, "companySlug")
    ? target.companySlug
    : null;
}

function isCanonicalAuthenticatedBackfillTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return false;
  if (!AUTHENTICATED_BACKFILL_BATCHES.includes(target.batchSlug)) return false;
  const keys = Object.keys(target).sort();
  if (!Object.hasOwn(target, "companySlug")) {
    return keys.length === 1 && keys[0] === "batchSlug";
  }
  if (
    keys.length !== 2 ||
    keys[0] !== "batchSlug" ||
    keys[1] !== "companySlug"
  ) {
    return false;
  }
  return typeof target.companySlug === "string" &&
    target.companySlug.length > 0 &&
    target.companySlug.length <= AUTHENTICATED_BACKFILL_COMPANY_SLUG_MAX_LENGTH &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target.companySlug);
}
