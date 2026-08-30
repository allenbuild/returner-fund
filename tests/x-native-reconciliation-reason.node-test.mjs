import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalXNativeMergeReason,
  canonicalXNativeReconciliationReason,
  splitGeneratedXNativeReconciliationReason
} from "../scripts/lib/x-native-reconciliation-reason.mjs";

const clause = (count) =>
  `Canonical write reconciled ${count} same-owner observations by native X post ID and retained per-metric maxima.`;
const conflictClause =
  "Conflicting exact native timestamps were observed for the same X post ID; queued for review.";
const recentSearchClause =
  "The credentialed X recent-search result independently matched the same native post ID; per-metric maxima were retained.";

test("canonical X reconciliation provenance is idempotent across resumed snapshots", () => {
  const sourceReason = "Exact native author and status URL were verified.";
  const first = canonicalXNativeReconciliationReason(sourceReason, 1);
  const resumed = canonicalXNativeReconciliationReason(first, 1);
  const resumedWithStaleDuplicates = canonicalXNativeReconciliationReason(
    `${first} ${clause(7)} ${clause(1)}`,
    3
  );

  assert.equal(first, `${sourceReason} ${clause(1)}`);
  assert.equal(resumed, first);
  assert.equal(resumedWithStaleDuplicates, `${sourceReason} ${clause(3)}`);
  assert.equal(resumedWithStaleDuplicates.match(/Canonical write reconciled/g)?.length, 1);
});

test("canonical X timestamp-conflict provenance is idempotent and transition-safe", () => {
  const sourceReason = "Exact native author and status URL were verified.";
  const conflicted = canonicalXNativeReconciliationReason(
    `${sourceReason} ${conflictClause} ${conflictClause}`,
    2,
    { timestampConflict: true }
  );
  const replayedConflict = canonicalXNativeReconciliationReason(
    conflicted,
    2,
    { timestampConflict: true }
  );
  const resolved = canonicalXNativeReconciliationReason(
    replayedConflict,
    1,
    { timestampConflict: false }
  );

  assert.equal(conflicted, `${sourceReason} ${clause(2)} ${conflictClause}`);
  assert.equal(replayedConflict, conflicted);
  assert.equal(conflicted.match(/Conflicting exact native timestamps/g)?.length, 1);
  assert.equal(resolved, `${sourceReason} ${clause(1)}`);
});

test("canonical X merge provenance deduplicates recent-search and conflict clauses", () => {
  const sourceReason = "Exact native author and status URL were verified.";
  const stale = `${sourceReason} ${recentSearchClause} ${recentSearchClause} ` +
    `${conflictClause} ${conflictClause} ${clause(9)}`;
  const merged = canonicalXNativeMergeReason(stale, {
    credentialedRecentSearchMatch: true,
    timestampConflict: true
  });
  const replayed = canonicalXNativeMergeReason(merged, {
    credentialedRecentSearchMatch: true,
    timestampConflict: true
  });
  const reconciled = canonicalXNativeReconciliationReason(merged, 2, {
    credentialedRecentSearchMatch: true,
    timestampConflict: true
  });

  assert.equal(merged, `${sourceReason} ${recentSearchClause} ${conflictClause}`);
  assert.equal(replayed, merged);
  assert.equal(
    reconciled,
    `${sourceReason} ${recentSearchClause} ${clause(2)} ${conflictClause}`
  );
});

test("canonical X reconciliation removes only exact generated clauses", () => {
  const sourceReason = [
    "Human evidence note with  two spaces.",
    clause(1),
    "\nAnalyst note: Canonical write reconciled observations manually; retain this prose.",
    "Analyst note: Conflicting exact native timestamps might be investigated manually.",
    "Analyst note: The credentialed X recent-search result was interpreted manually.",
    `${clause(8)}-not-a-generated-clause`,
    "Near-match retained per metric maxima."
  ].join(" ");
  const result = canonicalXNativeReconciliationReason(sourceReason, 2);

  assert.equal(
    result,
    [
      "Human evidence note with  two spaces.",
      "\nAnalyst note: Canonical write reconciled observations manually; retain this prose.",
      "Analyst note: Conflicting exact native timestamps might be investigated manually.",
      "Analyst note: The credentialed X recent-search result was interpreted manually.",
      `${clause(8)}-not-a-generated-clause`,
      "Near-match retained per metric maxima.",
      clause(2)
    ].join(" ")
  );
  assert.match(result, /Human evidence note with  two spaces\./);
  assert.match(result, /Analyst note: Canonical write reconciled observations manually/);
  assert.match(result, /Conflicting exact native timestamps might be investigated manually/);
  assert.match(result, /credentialed X recent-search result was interpreted manually/);
  assert.match(result, /retained per-metric maxima\.-not-a-generated-clause/);
  assert.match(result, /Near-match retained per metric maxima\./);
});

test("canonical X reconciliation does not collapse semantic source mutations", () => {
  const original = canonicalXNativeReconciliationReason("Native body said alpha.", 1);
  const mutated = canonicalXNativeReconciliationReason("Native body said beta.", 1);

  assert.notEqual(mutated, original);
  assert.equal(mutated, `Native body said beta. ${clause(1)}`);
  assert.throws(
    () => canonicalXNativeReconciliationReason("Native body said alpha.", 0),
    /positive safe integer/
  );
  assert.throws(
    () => canonicalXNativeReconciliationReason(
      "Native body said alpha.",
      1,
      { timestampConflict: "true" }
    ),
    /must be a boolean/
  );
});

test("generated X provenance splitting preserves all non-generated bytes", () => {
  const source =
    `Evidence  prose. ${clause(2)} ${clause(2)}\nAnalyst prose. ${conflictClause} ${conflictClause} ` +
    `${recentSearchClause} ${recentSearchClause}`;
  const split = splitGeneratedXNativeReconciliationReason(source);

  assert.equal(split.prose, "Evidence  prose.\nAnalyst prose.");
  assert.deepEqual(split.observationCounts, ["2", "2"]);
  assert.equal(split.timestampConflictOccurrences, 2);
  assert.equal(split.credentialedRecentSearchOccurrences, 2);
  assert.throws(
    () => splitGeneratedXNativeReconciliationReason(null),
    /matchReason must be a string/
  );
});
