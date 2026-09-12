const AUTHENTICATED_BACKFILL_BATCHES = Object.freeze([
  "S2026",
  "S26",
  "A16ZSR006"
]);

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
  if (hasBatch !== hasCompany) {
    throw new Error(
      "Authenticated backfill target requires both an exact batch and an exact company slug."
    );
  }
  if (!AUTHENTICATED_BACKFILL_BATCHES.includes(normalizedBatch)) {
    throw new Error(
      `Authenticated backfill target batch must be one of ${AUTHENTICATED_BACKFILL_BATCHES.join(", ")}.`
    );
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedCompany)) {
    throw new Error(
      "Authenticated backfill target company slug must be a canonical lowercase slug."
    );
  }
  return Object.freeze({
    batchSlug: normalizedBatch,
    companySlug: normalizedCompany
  });
}

export function authenticatedBackfillTargetEquals(left, right) {
  if (left === null || right === null) return left === right;
  return Boolean(
    left &&
    right &&
    left.batchSlug === right.batchSlug &&
    left.companySlug === right.companySlug
  );
}

export function supportedAuthenticatedBackfillBatches() {
  return [...AUTHENTICATED_BACKFILL_BATCHES];
}
