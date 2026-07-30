import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileCheckpointOwnerCollisions
} from "../scripts/lib/logged-in-owner-collision-reconciliation.mjs";

const observedAt = "2026-07-29T13:30:00.000Z";

test("reattributes an exact company/founder X collision and emits an audit trail", () => {
  const checkpoint = {
    evidence: [
      companyRow({ id: "1", postId: "2053544851162140957" }),
      companyRow({ id: "2", postId: "2053544851162140958" }),
      {
        id: "unrelated",
        entityType: "company",
        entityId: "company-other",
        batchSlug: "S2026",
        platform: "x"
      }
    ],
    needsReview: [],
    attributionReconciliationLedger: []
  };
  const original = structuredClone(checkpoint);

  const { snapshot, summary } = reconcileCheckpointOwnerCollisions(
    checkpoint,
    [validCollision()],
    { observedAt }
  );

  assert.deepEqual(checkpoint, original, "the helper must not mutate its input");
  assert.equal(summary.reattributedCount, 2);
  assert.equal(summary.quarantinedCount, 0);
  assert.equal(snapshot.evidence.length, 3);
  const repaired = snapshot.evidence.filter(
    (row) => row.entityType === "founder"
  );
  assert.equal(repaired.length, 2);
  assert.equal(
    repaired.every(
      (row) =>
        row.entityId ===
          "founder-arlo-industries-deo-arlo-iron-dome-guy-836806" &&
        row.id.startsWith(
          "x-founder-arlo-industries-deo-arlo-iron-dome-guy-836806-"
        ) &&
        row.attributionReconciliation.action ===
          "company_to_founder_owner_collision"
    ),
    true
  );
  assert.equal(snapshot.needsReview.length, 2);
  assert.equal(
    snapshot.needsReview.every((row) =>
      row.quarantineReasons.includes(
        "stale_company_attribution_reconciled_to_founder"
      )
    ),
    true
  );
  assert.equal(snapshot.attributionReconciliationLedger.length, 2);
  assert.equal(
    snapshot.attributionReconciliationLedger.every(
      (row) =>
        row.disposition === "reattributed" &&
        row.staleAttribution.entityId === "company-arlo-industries" &&
        row.replacementAttribution.entityId ===
          "founder-arlo-industries-deo-arlo-iron-dome-guy-836806"
    ),
    true
  );
});

test("is idempotent when replayed against its reconciled snapshot", () => {
  const first = reconcileCheckpointOwnerCollisions(
    { evidence: [companyRow()], needsReview: [] },
    [validCollision()],
    { observedAt }
  );
  const replay = reconcileCheckpointOwnerCollisions(
    first.snapshot,
    [validCollision()],
    { observedAt }
  );

  assert.deepEqual(replay.snapshot, first.snapshot);
  assert.equal(replay.summary.reattributedCount, 0);
  assert.equal(replay.summary.quarantinedCount, 0);
});

test("quarantines rather than guesses when founder membership is not proven", () => {
  const collision = validCollision();
  collision.targets[1].companySlug = "different-company";

  const { snapshot, summary } = reconcileCheckpointOwnerCollisions(
    { evidence: [companyRow()] },
    [collision],
    { observedAt }
  );

  assert.equal(summary.validCollisionCount, 0);
  assert.equal(summary.reattributedCount, 0);
  assert.equal(summary.quarantinedCount, 1);
  assert.equal(snapshot.evidence.length, 0);
  assert.deepEqual(snapshot.needsReview[0].quarantineReasons, [
    "founder_company_membership_not_proven"
  ]);
  assert.equal(
    snapshot.attributionReconciliationLedger[0].disposition,
    "quarantined"
  );
});

test("quarantines rather than guesses when a collision has extra owners", () => {
  const collision = validCollision();
  collision.targets.push({
    ...collision.targets[1],
    entityId: "founder-arlo-industries-someone-else-1",
    name: "Someone Else"
  });

  const { snapshot, summary } = reconcileCheckpointOwnerCollisions(
    { evidence: [companyRow()] },
    [collision],
    { observedAt }
  );

  assert.equal(summary.reattributedCount, 0);
  assert.equal(summary.quarantinedCount, 1);
  assert.equal(snapshot.evidence.length, 0);
  assert.equal(
    snapshot.needsReview[0].quarantineReasons.includes(
      "collision_not_exactly_one_company_and_one_founder"
    ),
    true
  );
});

test("requires exact collision identity without quarantining a legitimate second account", () => {
  const wrongAccount = companyRow({
    accountUrl: "https://x.com/someone_else",
    sourceUrl: "https://x.com/someone_else/status/2053544851162140957"
  });
  const wrongPost = companyRow({
    id: "2",
    postId: "2053544851162140958",
    sourceUrl: "https://x.com/deoarlo/status/not-the-native-id"
  });
  const otherBatch = companyRow({
    id: "3",
    postId: "2053544851162140959",
    batchSlug: "S26"
  });

  const { snapshot, summary } = reconcileCheckpointOwnerCollisions(
    { evidence: [wrongAccount, wrongPost, otherBatch] },
    [validCollision()],
    { observedAt }
  );

  assert.equal(summary.reattributedCount, 0);
  assert.equal(summary.quarantinedCount, 1);
  assert.deepEqual(snapshot.evidence.map((row) => row.id), [
    "x-company-arlo-industries-1",
    "x-company-arlo-industries-3"
  ]);
  assert.equal(
    snapshot.needsReview.some((row) =>
      row.quarantineReasons.includes("checkpoint_row_account_identity_mismatch")
    ),
    false
  );
  assert.equal(
    snapshot.needsReview.some((row) =>
      row.quarantineReasons.includes(
        "checkpoint_row_native_post_identity_mismatch"
      )
    ),
    true
  );
});

test("retires a duplicate stale company copy without duplicating founder evidence", () => {
  const founder = {
    ...companyRow(),
    id: "existing-founder-copy",
    entityType: "founder",
    entityId: "founder-arlo-industries-deo-arlo-iron-dome-guy-836806"
  };
  const { snapshot, summary } = reconcileCheckpointOwnerCollisions(
    { evidence: [founder, companyRow()] },
    [validCollision()],
    { observedAt }
  );

  assert.equal(summary.reattributedCount, 0);
  assert.equal(summary.quarantinedCount, 1);
  assert.equal(summary.duplicateCount, 1);
  assert.deepEqual(snapshot.evidence.map((row) => row.id), [
    "existing-founder-copy"
  ]);
  assert.deepEqual(snapshot.needsReview[0].quarantineReasons, [
    "founder_attribution_already_has_native_post"
  ]);
});

function validCollision() {
  return {
    batchSlug: "S2026",
    platform: "x",
    accountIdentity: "x:deoarlo",
    entityIds: [
      "company-arlo-industries",
      "founder-arlo-industries-deo-arlo-iron-dome-guy-836806"
    ],
    targets: [
      {
        batchSlug: "S2026",
        platform: "x",
        url: "https://x.com/deoarlo",
        companySlug: "arlo-industries",
        companyName: "Arlo Industries",
        entityType: "company",
        entityId: "company-arlo-industries",
        name: "Arlo Industries"
      },
      {
        batchSlug: "S2026",
        platform: "x",
        url: "https://x.com/deoarlo",
        companySlug: "arlo-industries",
        companyName: "Arlo Industries",
        entityType: "founder",
        entityId:
          "founder-arlo-industries-deo-arlo-iron-dome-guy-836806",
        name: "Deo"
      }
    ]
  };
}

function companyRow({
  id = "1",
  postId = "2053544851162140957",
  batchSlug = "S2026",
  accountUrl = "https://x.com/deoarlo",
  sourceUrl = `https://x.com/deoarlo/status/${postId}`
} = {}) {
  return {
    id: `x-company-arlo-industries-${id}`,
    entityType: "company",
    entityId: "company-arlo-industries",
    batchSlug,
    companySlug: "arlo-industries",
    companyName: "Arlo Industries",
    platform: "x",
    platformPostId: postId,
    accountUrl,
    sourceUrl,
    review_state: "verified"
  };
}
