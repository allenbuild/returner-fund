import assert from "node:assert/strict";
import test from "node:test";

import { planNeedsReviewNativePromotion } from "../scripts/lib/needs-review-native-promotion.mjs";
import { NEEDS_REVIEW_NATIVE_RECOVERY_VERSION } from "../scripts/lib/needs-review-native-recovery.mjs";

const owner = {
  batchSlug: "S2026",
  entityType: "company",
  entityId: "company-example",
  entityName: "Example",
  companySlug: "example",
  companyName: "Example",
  companyEntityId: "company-example"
};

test("promotes exact zero-engagement native posts and resolves only matching review rows", () => {
  const first = recoveredX("100", { id: "first", text: "identical body" });
  const second = recoveredX("101", { id: "second", text: "identical body" });
  const unrelated = reviewX("999", "unrelated");
  const canonical = snapshot([], [reviewX("100"), reviewX("100", "duplicate-review"), reviewX("101"), unrelated]);
  const plan = makePlan(canonical, [first, second]);

  assert.equal(plan.additions.length, 2);
  assert.equal(plan.zeroEngagementAdditions, 2);
  assert.equal(plan.resolvedReview.length, 3);
  assert.deepEqual(plan.promoted.needsReview, [unrelated]);
  assert.deepEqual(plan.promoted.evidence, [first, second]);
  assert.deepEqual(plan.promoted.failures, canonical.failures);
  assert.deepEqual(plan.addedByPlatform, { x: 2 });
});

test("does not republish a physical post already represented in another source", () => {
  const row = recoveredX("100");
  const canonical = snapshot([], [reviewX("100")]);
  const plan = makePlan(canonical, [row], [{ evidence: [{ ...row, id: "existing" }] }]);

  assert.equal(plan.additions.length, 0);
  assert.equal(plan.alreadyRepresented.length, 1);
  assert.equal(plan.resolvedReview.length, 1);
  assert.equal(plan.promoted.needsReview.length, 0);
});

test("fails closed on duplicate native IDs, owner drift, and receipt tampering", () => {
  const row = recoveredX("100");
  const canonical = snapshot([], [reviewX("100")]);
  assert.throws(() => makePlan(canonical, [row, { ...row, id: "copy" }]), /duplicates candidate physical post/);
  assert.throws(() => makePlan(canonical, [{ ...row, companySlug: "wrong" }]), /disagrees on companySlug/);
  assert.throws(() => makePlan(canonical, [{
    ...row,
    _needsReviewRecovery: {
      ...row._needsReviewRecovery,
      validation: { ...row._needsReviewRecovery.validation, returnedUrl: "https://x.com/example/status/101" }
    }
  }]), /mismatched official X receipt/);
});

test("requires a current review-ledger match before resolving a recovered row", () => {
  assert.throws(
    () => makePlan(snapshot(), [recoveredX("100")]),
    /not present in the current review ledger/
  );
});

function makePlan(canonical, evidence, extraSnapshots = []) {
  return planNeedsReviewNativePromotion({
    canonical,
    candidate: {
      schemaVersion: NEEDS_REVIEW_NATIVE_RECOVERY_VERSION,
      source: { fetchedAt: "2026-08-09T00:00:00.000Z" },
      evidence,
      needsReview: []
    },
    currentSnapshots: [canonical, ...extraSnapshots],
    resolveNativeAuthor: () => ({
      status: "matched",
      author: { platform: "x", key: "example" },
      owner
    })
  });
}

function snapshot(evidence = [], needsReview = []) {
  return {
    source: { fetchedAt: "2026-08-08T00:00:00.000Z", evidenceCount: evidence.length, needsReviewCount: needsReview.length },
    evidence,
    needsReview,
    attributionReconciliationLedger: [{ id: "keep" }],
    failures: [{ id: "keep" }],
    attempts: { keep: true },
    discoveryAttempts: [{ id: "keep" }],
    sourceDiscoveryPaths: [{ id: "keep" }]
  };
}

function reviewX(id, rowId = `review-${id}`) {
  return {
    id: rowId,
    platform: "x",
    sourceUrl: `https://x.com/example/status/${id}`,
    review_state: "needs_review"
  };
}

function recoveredX(id, overrides = {}) {
  return {
    id: `recovered-${id}`,
    batchSlug: owner.batchSlug,
    entityType: owner.entityType,
    entityId: owner.entityId,
    entityName: owner.entityName,
    companySlug: owner.companySlug,
    companyName: owner.companyName,
    platform: "x",
    sourceUrl: `https://x.com/example/status/${id}`,
    platformPostId: id,
    text: "A verified native post",
    rawVisibleText: '<blockquote class="twitter-tweet"><p>A verified native post</p></blockquote>',
    review_state: "verified",
    linkStatus: "verified",
    attributionStatus: "verified",
    attributionMode: "account_owner",
    attributionVersion: 3,
    attributionSignals: ["unique_native_author", "official_x_oembed_author_match"],
    nativeAuthorResolution: {
      status: "matched",
      author: { platform: "x", key: "example" },
      owner
    },
    metrics: {},
    contributionScore: 0,
    _needsReviewRecovery: {
      schemaVersion: NEEDS_REVIEW_NATIVE_RECOVERY_VERSION,
      physicalKey: `x:${id}`,
      validation: {
        kind: "official_x_oembed",
        author: "example",
        returnedUrl: `https://x.com/example/status/${id}`,
        text: "A verified native post",
        rawVisibleText: '<blockquote class="twitter-tweet"><p>A verified native post</p></blockquote>'
      }
    },
    ...overrides
  };
}
