import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertAuthenticatedBackfillTargetExists,
  assertAuthenticatedLinkedInPlanTarget,
  assertAuthenticatedReplayReceiptBinding,
  authenticatedBackfillTargetEquals,
  compactAuthenticatedLinkedInPlan,
  resolveAuthenticatedBackfillTarget
} from "../scripts/lib/authenticated-backfill-target.mjs";
import { loadAutonomousCatalogs } from "../scripts/lib/autonomous-ingestion-plan.mjs";

test("authenticated replay targeting defaults to the existing full replay", () => {
  assert.equal(resolveAuthenticatedBackfillTarget(), null);
  assert.equal(resolveAuthenticatedBackfillTarget({
    authenticatedReplay: true,
    requestedScope: "all"
  }), null);
});

test("authenticated replay targeting accepts an exact LinkedIn batch and company slug", () => {
  const target = resolveAuthenticatedBackfillTarget({
    authenticatedReplay: true,
    requestedScope: "linkedin",
    batchSlug: "S26",
    companySlug: "gamgee"
  });
  assert.deepEqual(target, { batchSlug: "S26", companySlug: "gamgee" });
  assert.equal(authenticatedBackfillTargetEquals(target, {
    batchSlug: "S26",
    companySlug: "gamgee"
  }), true);
});

test("authenticated replay targeting accepts an exact LinkedIn batch without widening to other batches", () => {
  const target = resolveAuthenticatedBackfillTarget({
    authenticatedReplay: true,
    requestedScope: "linkedin",
    batchSlug: "S2026"
  });
  assert.deepEqual(target, { batchSlug: "S2026" });
  assert.equal(authenticatedBackfillTargetEquals(target, { batchSlug: "S2026" }), true);
  assert.equal(authenticatedBackfillTargetEquals(target, { batchSlug: "S26" }), false);
  assert.equal(authenticatedBackfillTargetEquals(target, {
    batchSlug: "S2026",
    companySlug: "zenbu-2"
  }), false);
  assert.equal(authenticatedBackfillTargetEquals(target, {
    batchSlug: "S2026",
    companySlug: ""
  }), false);
  assert.equal(authenticatedBackfillTargetEquals(target, {
    batchSlug: "S2026",
    widened: true
  }), false);
});

test("authenticated replay targeting fails closed on invalid or widened selectors", () => {
  for (const [options, expected] of [
    [{ batchSlug: "S26", companySlug: "gamgee" }, /only with authenticated social replay/],
    [{ batchSlug: "S2026" }, /only with authenticated social replay/],
    [{ authenticatedReplay: true, requestedScope: "all", batchSlug: "S26", companySlug: "gamgee" }, /linkedin-only/],
    [{ authenticatedReplay: true, requestedScope: "all", batchSlug: "S2026" }, /linkedin-only/],
    [{ authenticatedReplay: true, requestedScope: "linkedin", companySlug: "gamgee" }, /requires an exact batch/],
    [{ authenticatedReplay: true, requestedScope: "linkedin", batchSlug: "W99", companySlug: "gamgee" }, /must be one of/],
    [{ authenticatedReplay: true, requestedScope: "linkedin", batchSlug: "S26", companySlug: "Gamgee" }, /canonical lowercase slug/],
    [{ authenticatedReplay: true, requestedScope: "linkedin", batchSlug: "S26", companySlug: "gamgee,other" }, /canonical lowercase slug/],
    [{ authenticatedReplay: true, requestedScope: "linkedin", batchSlug: "S26", companySlug: "a".repeat(129) }, /no longer than 128/]
  ]) {
    assert.throws(() => resolveAuthenticatedBackfillTarget(options), expected);
  }
});

test("authenticated replay resolves its exact target before browser work", () => {
  const target = { batchSlug: "S26", companySlug: "gamgee" };
  const catalogs = [
    { slug: "S26", companies: [{ sourceKey: "company-gamgee" }] },
    { slug: "S2026", companies: [{ sourceKey: "company-zenbu-2" }] },
    { slug: "A16ZSR006", companies: [{ sourceKey: "a16z-speedrun-006-acceler8" }] }
  ];
  const springBatch = { batchSlug: "S2026" };
  assert.equal(assertAuthenticatedBackfillTargetExists(catalogs, springBatch), springBatch);
  assert.equal(assertAuthenticatedBackfillTargetExists(catalogs, target), target);
  const zenbuTarget = { batchSlug: "S2026", companySlug: "zenbu-2" };
  assert.equal(
    assertAuthenticatedBackfillTargetExists(catalogs, zenbuTarget),
    zenbuTarget
  );
  const speedrunTarget = { batchSlug: "A16ZSR006", companySlug: "acceler8" };
  assert.equal(
    assertAuthenticatedBackfillTargetExists(catalogs, speedrunTarget),
    speedrunTarget
  );
  assert.throws(
    () => assertAuthenticatedBackfillTargetExists(catalogs, {
      batchSlug: "S26",
      companySlug: "missing"
    }),
    /must resolve to exactly one company/
  );
  assert.throws(
    () => assertAuthenticatedBackfillTargetExists(catalogs, {
      batchSlug: "S26",
      companySlug: "zenbu-2"
    }),
    /must resolve to exactly one company/
  );
  assert.throws(
    () => assertAuthenticatedBackfillTargetExists([
      ...catalogs,
      { slug: "S2026", companies: [] }
    ], springBatch),
    /must resolve to exactly one pinned publication catalog/
  );
});

test("authenticated replay targets match the live normalized catalog identity shape", async () => {
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const catalogs = await loadAutonomousCatalogs(repositoryRoot);
  for (const target of [
    { batchSlug: "S2026" },
    { batchSlug: "S26", companySlug: "gamgee" },
    { batchSlug: "S2026", companySlug: "zenbu-2" },
    { batchSlug: "A16ZSR006", companySlug: "acceler8" }
  ]) {
    assert.equal(assertAuthenticatedBackfillTargetExists(catalogs, target), target);
  }
});

test("idempotent authenticated replay receipts bind exact scope and target", () => {
  const requestedTarget = { batchSlug: "S26", companySlug: "gamgee" };
  const receipt = {
    authenticatedSocialReplay: {
      requestedScope: "linkedin",
      requestedPlatforms: ["linkedin"],
      requestedTarget
    }
  };
  assert.doesNotThrow(() => assertAuthenticatedReplayReceiptBinding({
    authenticatedReplay: true,
    requestedScope: "linkedin",
    requestedTarget,
    receipt
  }));
  assert.throws(() => assertAuthenticatedReplayReceiptBinding({
    authenticatedReplay: true,
    requestedScope: "linkedin",
    requestedTarget: { batchSlug: "S26", companySlug: "another-company" },
    receipt
  }), /does not match the exact requested scope and target/);
  assert.throws(() => assertAuthenticatedReplayReceiptBinding({ receipt }), /authenticated social replay/);
});

test("idempotent authenticated replay receipts bind a batch-only selector", () => {
  const requestedTarget = { batchSlug: "S2026" };
  const receipt = {
    authenticatedSocialReplay: {
      requestedScope: "linkedin",
      requestedPlatforms: ["linkedin"],
      requestedTarget
    }
  };
  assert.doesNotThrow(() => assertAuthenticatedReplayReceiptBinding({
    authenticatedReplay: true,
    requestedScope: "linkedin",
    requestedTarget,
    receipt
  }));
  for (const widenedOrDifferentTarget of [
    null,
    { batchSlug: "S26" },
    { batchSlug: "S2026", companySlug: "zenbu-2" }
  ]) {
    assert.throws(() => assertAuthenticatedReplayReceiptBinding({
      authenticatedReplay: true,
      requestedScope: "linkedin",
      requestedTarget: widenedOrDifferentTarget,
      receipt
    }), /does not match the exact requested scope and target/);
  }
});

test("targeted LinkedIn plans reject every widened target and compact full payloads", () => {
  const requestedTarget = { batchSlug: "S26", companySlug: "gamgee" };
  const target = {
    batchSlug: "S26",
    companySlug: "gamgee",
    entityType: "company",
    entityId: "company-gamgee",
    platform: "linkedin",
    checkpointKey: "S26:linkedin:company-gamgee"
  };
  const plan = {
    batchSlug: "S26",
    requestedTarget,
    targets: [target],
    runnableTargets: [target],
    linkedinExecution: { remainingTargetCount: 1, runnableTargetCount: 1 }
  };
  assert.doesNotThrow(() => assertAuthenticatedLinkedInPlanTarget(plan, requestedTarget));
  assert.throws(
    () => assertAuthenticatedLinkedInPlanTarget({
      ...plan,
      targets: []
    }, requestedTarget),
    /invalid targets/
  );
  for (const field of ["targets", "runnableTargets"]) {
    assert.throws(
      () => assertAuthenticatedLinkedInPlanTarget({
        ...plan,
        [field]: [{ ...target, platform: "instagram" }]
      }, requestedTarget),
      new RegExp(`non-LinkedIn or out-of-scope ${field}`)
    );
    assert.throws(
      () => assertAuthenticatedLinkedInPlanTarget({
        ...plan,
        [field]: [{ ...target, companySlug: "another-company" }]
      }, requestedTarget),
      new RegExp(`non-LinkedIn or out-of-scope ${field}`)
    );
  }

  const expanded = {
    ...plan,
    targets: Array.from({ length: 25 }, (_, index) => ({
      ...target,
      entityId: `founder-gamgee-${index}`,
      checkpointKey: `S26:linkedin:founder-gamgee-${index}`
    }))
  };
  const compact = compactAuthenticatedLinkedInPlan(expanded);
  assert.equal(compact.targetCount, 25);
  assert.equal(compact.targetIdentitySamples.length, 10);
  assert.match(compact.targetIdentitiesSha256, /^[0-9a-f]{64}$/);
  assert.equal("targets" in compact, false);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(expanded).length);
});

test("batch-only LinkedIn plans require an unfiltered exact-batch inventory", () => {
  const requestedTarget = { batchSlug: "S2026" };
  const targets = ["zenbu-2", "eden-robotics"].map((companySlug) => ({
    batchSlug: "S2026",
    companySlug,
    entityType: "company",
    entityId: `company-${companySlug}`,
    platform: "linkedin",
    checkpointKey: `S2026:linkedin:company-${companySlug}`
  }));
  const plan = {
    batchSlug: "S2026",
    requestedTarget: null,
    targets,
    runnableTargets: targets,
    linkedinExecution: { remainingTargetCount: 2, runnableTargetCount: 2 }
  };
  assert.doesNotThrow(() => assertAuthenticatedLinkedInPlanTarget(plan, requestedTarget));
  assert.throws(
    () => assertAuthenticatedLinkedInPlanTarget({
      ...plan,
      targets: [{ ...targets[0], batchSlug: "S26" }]
    }, requestedTarget),
    /non-LinkedIn or out-of-scope targets/
  );
  assert.throws(
    () => assertAuthenticatedLinkedInPlanTarget({
      ...plan,
      requestedTarget: { batchSlug: "S2026", companySlug: "zenbu-2" }
    }, requestedTarget),
    /did not bind the exact requested replay batch and company scope/
  );
});
