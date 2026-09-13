import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  BATCH_ORDER,
  DrainStopError,
  chooseNextReplayKey,
  dispatchFields,
  formatReplayKey,
  nextIncompleteBatch,
  replayKeyNumber,
  validateBatchPlan,
  validateCheckpointAuditReceipt,
  validateCheckpointReceipt,
  validateFinalAuditReceipt,
  validateFinalReplayReceipt,
  validatePublicationCommitMessage
} from "./linkedin-checkpoint-backlog-drain.mjs";

const sourceSha = "a".repeat(40);
const checkpointBefore = "b".repeat(64);
const checkpointAfter = "c".repeat(64);
const outputBefore = "d".repeat(64);
const outputAfter = "e".repeat(64);
const key = "incident-20260913-s26-linkedin-backlog-001";
const runId = 12345;

test("orders S26 before S2026 and keeps their replay keys disjoint", () => {
  assert.deepEqual(BATCH_ORDER, ["S26", "S2026"]);
  assert.equal(nextIncompleteBatch({ batches: { S26: { status: "pending" }, S2026: { status: "pending" } } }), "S26");
  assert.equal(formatReplayKey("S26", 1), key);
  assert.equal(formatReplayKey("S2026", 1), "incident-20260913-s2026-linkedin-backlog-001");
  assert.equal(replayKeyNumber(`Autonomous ingestion candidate ${key}`, "S26"), 1);
  assert.equal(replayKeyNumber(key, "S2026"), null);
  assert.equal(chooseNextReplayKey([{ displayTitle: key }], "S26"), "incident-20260913-s26-linkedin-backlog-002");
});

test("rejects duplicate batch-bound replay keys", () => {
  assert.throws(
    () => chooseNextReplayKey([{ displayTitle: key }, { displayTitle: key }], "S26"),
    (error) => error instanceof DrainStopError && error.code === "duplicate_replay_key"
  );
});

test("builds exact checkpoint and final dispatch bindings", () => {
  const checkpoint = dispatchFields({
    batchSlug: "S26", key, checkpointSha256: checkpointBefore, remaining: 21, checkpointOnly: true
  });
  assert.equal(checkpoint.authenticated_backfill_batch, "S26");
  assert.equal(checkpoint.incident_linkedin_checkpoint_only, "true");
  assert.equal(checkpoint.incident_linkedin_expected_checkpoint_sha256, checkpointBefore);
  assert.equal(checkpoint.incident_linkedin_expected_remaining, "21");
  const final = dispatchFields({
    batchSlug: "S26", key, checkpointSha256: checkpointBefore, remaining: 20, checkpointOnly: false
  });
  assert.equal(final.incident_linkedin_checkpoint_only, "false");
  assert.throws(
    () => dispatchFields({ batchSlug: "S26", key, checkpointSha256: checkpointBefore, remaining: 20, checkpointOnly: true }),
    (error) => error instanceof DrainStopError && error.code === "dispatch_binding_invalid"
  );
});

test("validates canonical inventory and collision hashes", () => {
  const { plan, contract } = planFixture(1);
  const validated = validateBatchPlan(plan, { contract });
  assert.equal(validated.remaining, 1);
  assert.equal(validated.proof.inventorySha256, contract.inventorySha256);
  const drifted = structuredClone(plan);
  drifted.targets[0].accountUrl += "changed";
  assert.throws(
    () => validateBatchPlan(drifted, { contract }),
    (error) => error instanceof DrainStopError && error.code === "inventory_contract_drift"
  );
});

test("cross-checks checkpoint controller and autonomous receipts", () => {
  const { plan: beforeRaw, contract } = planFixture(1);
  const { plan: afterRaw } = planFixture(0);
  const beforePlan = validateBatchPlan(beforeRaw, { contract });
  const afterPlan = validateBatchPlan(afterRaw, { contract });
  const before = snapshotFixture({ checkpointHash: checkpointBefore, outputHash: outputBefore, firstStatus: "failed" });
  const after = snapshotFixture({ checkpointHash: checkpointAfter, outputHash: outputAfter, firstStatus: "done" });
  const controller = checkpointReceiptFixture({ contract });
  const result = validateCheckpointReceipt(controller, {
    batchSlug: "S26", key, sourceSha, runId, before, after, beforePlan, afterPlan, contract
  });
  assert.deepEqual(result, { beforeRemaining: 1, completedTargets: 1, afterRemaining: 0 });
  const controllerHash = "f".repeat(64);
  assert.equal(validateCheckpointAuditReceipt(checkpointAuditFixture({ controllerHash }), {
    controllerReceipt: controller,
    controllerReceiptSha256: controllerHash,
    batchSlug: "S26",
    key,
    sourceSha,
    runId
  }), true);
});

test("rejects collision mutation in an otherwise valid checkpoint receipt", () => {
  const { plan: beforeRaw, contract } = planFixture(1);
  const { plan: afterRaw } = planFixture(0);
  const beforePlan = validateBatchPlan(beforeRaw, { contract });
  const afterPlan = validateBatchPlan(afterRaw, { contract });
  const before = snapshotFixture({ checkpointHash: checkpointBefore, outputHash: outputBefore, firstStatus: "failed" });
  const after = snapshotFixture({ checkpointHash: checkpointAfter, outputHash: outputAfter, firstStatus: "done" });
  after.attemptDigests["S26:linkedin:collision"].digest = "mutated";
  assert.throws(
    () => validateCheckpointReceipt(checkpointReceiptFixture({ contract }), {
      batchSlug: "S26", key, sourceSha, runId, before, after, beforePlan, afterPlan, contract
    }),
    (error) => error instanceof DrainStopError &&
      ["checkpoint_attempt_delta_mismatch", "collision_checkpoint_changed"].includes(error.code)
  );
});

test("requires exact final replay checkpoint binding and completed debt", () => {
  const receipt = finalReplayFixture();
  assert.equal(validateFinalReplayReceipt(receipt, {
    batchSlug: "S26", key, checkpointSha256: checkpointBefore, expectedRemaining: 20
  }).remainingTargetCount, 0);
  receipt.authenticatedSocialReplay.batches[0].linkedin.checkpointBinding.checkpointSha256 = outputBefore;
  assert.throws(
    () => validateFinalReplayReceipt(receipt, {
      batchSlug: "S26", key, checkpointSha256: checkpointBefore, expectedRemaining: 20
    }),
    (error) => error instanceof DrainStopError && error.code === "final_replay_receipt_mismatch"
  );
});

test("binds final audit and publication commit to source, run, and key", () => {
  const publishedSha = "9".repeat(40);
  const audit = {
    schemaVersion: 1,
    status: "published",
    slotKey: key,
    shouldRun: true,
    trigger: "manual-replay",
    sourceSha,
    triggerSha: sourceSha,
    headSha: sourceSha,
    executedSha: sourceSha,
    ingestResult: "success",
    validationResult: "success",
    acceptanceResult: "skipped",
    receiptRecognized: true,
    commitProofValid: true,
    commitRepositoryVerified: true,
    publishedCommit: publishedSha,
    run: { id: String(runId), attempt: "1", eventName: "workflow_dispatch" }
  };
  assert.equal(validateFinalAuditReceipt(audit, {
    key, sourceSha, runId, publishedSha, workflowConclusion: "success"
  }), true);
  const message = [
    `Publish autonomous ingestion ${key}`,
    "",
    `Returner-Slot-Key: ${key}`,
    `Returner-Source-SHA: ${sourceSha}`,
    `Returner-Run-ID: ${runId}`,
    "Returner-Run-Attempt: 1"
  ].join("\n");
  assert.equal(validatePublicationCommitMessage(message, { key, sourceSha, runId }), true);
});

function planFixture(remaining) {
  const targets = [
    target("S26:linkedin:alpha", "alpha"),
    target("S26:linkedin:beta", "beta")
  ];
  const collisions = [{
    batchSlug: "S26",
    platform: "linkedin",
    accountIdentity: "linkedin:in/shared",
    entityIds: ["founder-shared"],
    targets: [{ checkpointKey: "S26:linkedin:collision", entityId: "founder-shared" }]
  }];
  const inventory = targets.map((item) => ({
    checkpointKey: item.checkpointKey,
    batchSlug: item.batchSlug,
    companySlug: item.companySlug,
    companyName: item.companyName,
    entityType: item.entityType,
    entityId: item.entityId,
    entityName: item.entityName,
    platform: item.platform,
    accountUrl: item.accountUrl,
    activityUrl: item.activityUrl
  })).sort((left, right) => left.checkpointKey.localeCompare(right.checkpointKey));
  const canonicalCollisions = collisions.map((collision) => ({
    ...collision,
    entityIds: [...collision.entityIds].sort(),
    targets: collision.targets.map((item) => ({ ...item })).sort((left, right) => left.checkpointKey.localeCompare(right.checkpointKey))
  }));
  const contract = {
    batchSlug: "S26",
    catalogCompanyCount: 2,
    companyCount: 2,
    founderCount: 0,
    targetCount: 2,
    quarantinedTargetCount: 1,
    collisionCount: 1,
    collisionTargetCount: 1,
    inventorySha256: hash(JSON.stringify(inventory)),
    collisionSha256: hash(JSON.stringify(canonicalCollisions))
  };
  const runnableTargets = remaining ? [targets[0]] : [];
  return {
    contract,
    plan: {
      batchSlug: "S26",
      requestedTarget: null,
      catalogCompanyCount: 2,
      companyCount: 2,
      founderCount: 0,
      quarantinedTargetCount: 1,
      linkedinCollectionMode: "browser",
      remainingTargetCount: remaining,
      selectedForThisInvocationCount: remaining,
      runnableTargetCount: remaining,
      linkedinExecution: {
        workers: 1,
        serial: true,
        persistentHostPacing: true,
        delayMs: 30_000,
        targetCap: 5,
        remainingTargetCount: remaining,
        selectedForThisInvocationCount: remaining
      },
      targets,
      runnableTargets,
      ownerAccountCollisions: collisions
    }
  };
}

function target(checkpointKey, slug) {
  return {
    checkpointKey,
    batchSlug: "S26",
    companySlug: slug,
    companyName: slug,
    entityType: "company",
    entityId: `company-${slug}`,
    entityName: slug,
    platform: "linkedin",
    accountUrl: `https://linkedin.com/company/${slug}`,
    activityUrl: `https://linkedin.com/company/${slug}/posts`
  };
}

function snapshotFixture({ checkpointHash, outputHash, firstStatus }) {
  return {
    checkpointHash,
    outputHash,
    attemptDigests: {
      "S26:linkedin:alpha": { digest: firstStatus, status: firstStatus },
      "S26:linkedin:beta": { digest: "done-beta", status: "done" },
      "S26:linkedin:collision": { digest: "unchanged", status: "failed" }
    }
  };
}

function checkpointReceiptFixture({ contract }) {
  return {
    schemaVersion: 1,
    kind: "s2026_linkedin_checkpoint_collection",
    status: "checkpoint_collection_completed",
    publicationDeferred: true,
    request: {
      idempotencyKey: key,
      sourceSha,
      runId: String(runId),
      runAttempt: "1",
      eventName: "workflow_dispatch",
      scope: "linkedin",
      batch: "S26",
      expectedCheckpointSha256: checkpointBefore,
      expectedRemaining: 1
    },
    safety: {
      serial: true,
      workers: 1,
      targetCapPerChild: 5,
      targetDelayMs: 30_000,
      scrollPassesPerTarget: 30,
      postLimitPerTarget: 100,
      batteryFloorPercent: 5,
      batteryComparison: "strictly_greater_than",
      batteryMaxChunks: 4,
      acMaxChunks: 12,
      globalLockNamespace: "returner-fund-production-linkedin-allen-xu-v1",
      controllerLockNamespace: "returner-fund-production-linkedin-checkpoint-controller-v1",
      fullWakeAdmissionPerChild: true,
      powerAndLidWatchdog: true
    },
    inventory: { ...contract },
    progress: {
      beforeRemaining: 1,
      afterRemaining: 0,
      completedTargets: 1,
      chunksCompleted: 1,
      batteryChunks: 0,
      acChunks: 1,
      finalPublicationReady: true,
      finalPublicationMaximumRemaining: 20
    },
    artifacts: {
      checkpointSha256Before: checkpointBefore,
      checkpointSha256After: checkpointAfter,
      outputSha256Before: outputBefore,
      outputSha256After: outputAfter
    },
    chunks: [{
      chunkNumber: 1,
      powerMode: "ac",
      beforeRemaining: 1,
      afterRemaining: 0,
      completedTargets: 1,
      completedKeysSha256: "8".repeat(64),
      checkpointSha256Before: checkpointBefore,
      checkpointSha256After: checkpointAfter,
      outputSha256Before: outputBefore,
      outputSha256After: outputAfter
    }]
  };
}

function checkpointAuditFixture({ controllerHash }) {
  return {
    schemaVersion: 1,
    status: "checkpoint_collection_completed",
    slotKey: key,
    shouldRun: true,
    trigger: "manual-replay",
    sourceSha,
    triggerSha: sourceSha,
    headSha: sourceSha,
    executedSha: sourceSha,
    resolveResult: "success",
    ingestResult: "success",
    validationResult: "skipped",
    acceptanceResult: "skipped",
    runnerStatus: "checkpoint_collection_completed",
    hostReady: true,
    publishedCommit: null,
    commitRepositoryVerified: false,
    run: { id: String(runId), attempt: "1", eventName: "workflow_dispatch" },
    checkpointCollection: {
      checkpointOnly: true,
      receiptRecognized: true,
      batch: "S26",
      receiptSha256: controllerHash,
      sourceSha,
      beforeRemaining: 1,
      afterRemaining: 0,
      completedTargets: 1,
      chunksCompleted: 1,
      batteryChunks: 0,
      acChunks: 1,
      finalPublicationReady: true,
      checkpointSha256Before: checkpointBefore,
      checkpointSha256After: checkpointAfter,
      outputSha256Before: outputBefore,
      outputSha256After: outputAfter,
      inventorySha256: planFixture(1).contract.inventorySha256,
      collisionSha256: planFixture(1).contract.collisionSha256
    }
  };
}

function finalReplayFixture() {
  return {
    idempotencyKey: key,
    trigger: "manual-replay",
    authenticatedSocialReplay: {
      status: "completed",
      requestedScope: "linkedin",
      requestedPlatforms: ["linkedin"],
      requestedTarget: { batchSlug: "S26" },
      durableLockConfigured: true,
      configurationSkipped: false,
      safetyStopped: false,
      infrastructureStopped: false,
      remainingTargetCountKnown: true,
      remainingTargetCount: 0,
      remainingByBatch: { S26: 0 },
      unknownRemainingBatches: [],
      maxChunks: 4,
      targetCapPerChunk: 5,
      reserveMs: 900_000,
      drainHeadroomMs: 300_000,
      chunkAdmissionPolicy: "battery-floor-watchdog",
      wallClockChunkAdmissionBudgetMs: 0,
      requiredRemainingForChunkMs: 1_200_000,
      batteryFloorPercent: 5,
      batteryFloorComparison: "strictly_greater_than",
      batteryRuntimeEstimateRequired: false,
      externalPowerRequiredForChunkAdmission: false,
      perChunkBatteryCheckRequired: true,
      chunksAdmitted: 4,
      chunksAttempted: 4,
      chunksCompleted: 4,
      targetCapacityAdmitted: 20,
      chunkBudgetExhausted: false,
      deadlineExhausted: false,
      platformStatus: { linkedin: { requested: true, status: "completed" } },
      platformDebt: [],
      batches: [{
        batchSlug: "S26",
        linkedin: {
          status: "completed",
          finalPlan: { remainingTargetCount: 0 },
          checkpointBinding: {
            batchSlug: "S26",
            checkpointSha256: checkpointBefore,
            expectedRemainingTargetCount: 20,
            observedRemainingTargetCount: 20
          }
        }
      }]
    }
  };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
