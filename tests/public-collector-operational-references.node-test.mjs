import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLIC_COLLECTOR_OPERATIONAL_REFERENCE_RECONCILIATION_SCHEMA,
  reconcileRetiredFounderOperationalFailures,
  removedFounderSourceKeys
} from "../scripts/lib/public-collector-operational-references.mjs";

const staleFounderId = "founder-conifer-yavuz-inan-3606209";
const removedTransition = {
  companyId: "33936",
  companySlug: "conifer",
  founderId: "3606209",
  change: "removed",
  fromName: "Yavuz Inan",
  toName: null
};

test("prunes all four retained operational failures for an exact removed-founder transition", () => {
  const staleFailures = [
    ["instagram", null, "No mapped public Instagram URL."],
    ["linkedin", "https://linkedin.com/in/yavuz-selim-inan", "LinkedIn public HTML was blocked."],
    ["linkedin", "https://linkedin.com/in/yavuz-selim-inan", "LinkedIn discovery was blocked."],
    ["x", null, "No mapped public X URL."]
  ].map(([platform, accountUrl, message], index) => ({
    id: `stale-${index + 1}`,
    entityType: "founder",
    entityId: staleFounderId,
    companySlug: "conifer",
    platform,
    accountUrl,
    message,
    retryable: false
  }));
  const currentFailure = {
    id: "current-founder-failure",
    entityType: "founder",
    entityId: "founder-conifer-michael-jeffords-3664042",
    companySlug: "conifer",
    platform: "x",
    message: "No mapped public X URL.",
    retryable: false
  };
  const arbitraryUnknownFailure = {
    id: "unknown-founder-failure",
    entityType: "founder",
    entityId: "founder-conifer-unrecorded-person-9999999",
    companySlug: "conifer",
    platform: "x",
    message: "Unknown owner reference.",
    retryable: false
  };

  const reconciled = reconcileRetiredFounderOperationalFailures(
    [...staleFailures, currentFailure, arbitraryUnknownFailure],
    {
      currentEntityIds: [currentFailure.entityId],
      founderTransitions: [removedTransition]
    }
  );

  assert.deepEqual(reconciled.pruned.map((row) => row.id), staleFailures.map((row) => row.id));
  assert.deepEqual(
    reconciled.failures.map((row) => row.id),
    [currentFailure.id, arbitraryUnknownFailure.id]
  );
  assert.deepEqual(reconciled.receipt, {
    schemaVersion: PUBLIC_COLLECTOR_OPERATIONAL_REFERENCE_RECONCILIATION_SCHEMA,
    disposition: "pruned_obsolete_operational_failures",
    reason: "exact_removed_mutable_catalog_founder_transition",
    prunedFailureCount: 4,
    prunedFounderEntityIds: [staleFounderId],
    prunedFailureIdsSha256: reconciled.receipt.prunedFailureIdsSha256
  });
  assert.match(reconciled.receipt.prunedFailureIdsSha256, /^[a-f0-9]{64}$/);
});

test("keeps references fail-closed without an exact scoped removal transition", () => {
  const failure = {
    id: "same-generated-key-in-another-cohort",
    entityType: "founder",
    entityId: staleFounderId,
    platform: "linkedin",
    message: "Unknown owner reference."
  };

  for (const founderTransitions of [
    [],
    [{ ...removedTransition, change: "added", fromName: null, toName: "Yavuz Inan" }],
    [{ ...removedTransition, founderId: "9999999" }]
  ]) {
    const reconciled = reconcileRetiredFounderOperationalFailures([failure], {
      currentEntityIds: [],
      founderTransitions
    });
    assert.deepEqual(reconciled.failures, [failure]);
    assert.deepEqual(reconciled.pruned, []);
    assert.equal(reconciled.receipt, null);
  }
});

test("does not prune a current founder even when historical transition history contains a removal", () => {
  const failure = {
    id: "current-founder",
    entityType: "founder",
    entityId: staleFounderId,
    platform: "x",
    message: "Current owner diagnostic."
  };
  const reconciled = reconcileRetiredFounderOperationalFailures([failure], {
    currentEntityIds: [staleFounderId],
    founderTransitions: [removedTransition]
  });

  assert.deepEqual(reconciled.failures, [failure]);
  assert.deepEqual(reconciled.pruned, []);
  assert.equal(reconciled.receipt, null);
  assert.deepEqual([...removedFounderSourceKeys([removedTransition])], [staleFounderId]);
});
