const GENERATED_X_RECONCILIATION_CLAUSE =
  /(?:^| )Canonical write reconciled ([1-9][0-9]*) same-owner observations by native X post ID and retained per-metric maxima\.(?=$|\s)/g;
const GENERATED_X_TIMESTAMP_CONFLICT_CLAUSE =
  /(?:^| )Conflicting exact native timestamps were observed for the same X post ID; queued for review\.(?=$|\s)/g;
const GENERATED_X_RECENT_SEARCH_CLAUSE =
  /(?:^| )The credentialed X recent-search result independently matched the same native post ID; per-metric maxima were retained\.(?=$|\s)/g;

/**
 * Keep collector-generated X reconciliation provenance replay-stable.
 *
 * A resumed snapshot can already contain sentences written by an earlier
 * merge or normalization pass. Remove only those exact generated clauses
 * before writing the current state; all source and analyst prose remains
 * byte-for-byte intact.
 */
export function canonicalXNativeReconciliationReason(
  matchReason,
  observationCount,
  {
    timestampConflict = false,
    credentialedRecentSearchMatch = false
  } = {}
) {
  if (!Number.isSafeInteger(observationCount) || observationCount < 1) {
    throw new RangeError("observationCount must be a positive safe integer");
  }
  assertGeneratedFlags({ timestampConflict, credentialedRecentSearchMatch });
  return canonicalGeneratedXNativeReason(matchReason, {
    observationCount,
    timestampConflict,
    credentialedRecentSearchMatch
  });
}

export function canonicalXNativeMergeReason(
  matchReason,
  {
    timestampConflict = false,
    credentialedRecentSearchMatch = false
  } = {}
) {
  assertGeneratedFlags({ timestampConflict, credentialedRecentSearchMatch });
  return canonicalGeneratedXNativeReason(matchReason, {
    observationCount: null,
    timestampConflict,
    credentialedRecentSearchMatch
  });
}

function canonicalGeneratedXNativeReason(matchReason, {
  observationCount,
  timestampConflict,
  credentialedRecentSearchMatch
}) {
  const sourceReason = matchReason == null
    ? "Verified native X evidence."
    : String(matchReason);
  const preservedReason = sourceReason
    .replace(GENERATED_X_RECONCILIATION_CLAUSE, "")
    .replace(GENERATED_X_TIMESTAMP_CONFLICT_CLAUSE, "")
    .replace(GENERATED_X_RECENT_SEARCH_CLAUSE, "");
  return (
    preservedReason +
    (credentialedRecentSearchMatch
      ? " The credentialed X recent-search result independently matched the same native post ID; per-metric maxima were retained."
      : "") +
    (observationCount === null
      ? ""
      : ` Canonical write reconciled ${observationCount} same-owner observations by native X post ID and retained per-metric maxima.`) +
    (timestampConflict
      ? " Conflicting exact native timestamps were observed for the same X post ID; queued for review."
      : "")
  );
}

function assertGeneratedFlags({ timestampConflict, credentialedRecentSearchMatch }) {
  if (typeof timestampConflict !== "boolean") {
    throw new TypeError("timestampConflict must be a boolean");
  }
  if (typeof credentialedRecentSearchMatch !== "boolean") {
    throw new TypeError("credentialedRecentSearchMatch must be a boolean");
  }
}

export function splitGeneratedXNativeReconciliationReason(matchReason) {
  if (typeof matchReason !== "string") {
    throw new TypeError("matchReason must be a string");
  }
  const observationCounts = [...matchReason.matchAll(GENERATED_X_RECONCILIATION_CLAUSE)]
    .map((match) => match[1]);
  const timestampConflictOccurrences = [
    ...matchReason.matchAll(GENERATED_X_TIMESTAMP_CONFLICT_CLAUSE)
  ].length;
  const credentialedRecentSearchOccurrences = [
    ...matchReason.matchAll(GENERATED_X_RECENT_SEARCH_CLAUSE)
  ].length;
  return Object.freeze({
    prose: matchReason
      .replace(GENERATED_X_RECONCILIATION_CLAUSE, "")
      .replace(GENERATED_X_TIMESTAMP_CONFLICT_CLAUSE, "")
      .replace(GENERATED_X_RECENT_SEARCH_CLAUSE, ""),
    observationCounts: Object.freeze(observationCounts),
    timestampConflictOccurrences,
    credentialedRecentSearchOccurrences
  });
}
