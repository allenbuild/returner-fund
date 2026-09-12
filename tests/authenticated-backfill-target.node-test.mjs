import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAuthenticatedBackfillTargetExists,
  assertAuthenticatedLinkedInPlanTarget,
  assertAuthenticatedReplayReceiptBinding,
  authenticatedBackfillTargetEquals,
  compactAuthenticatedLinkedInPlan,
  resolveAuthenticatedBackfillTarget
} from "../scripts/lib/authenticated-backfill-target.mjs";

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

test("authenticated replay targeting fails closed on partial or widened selectors", () => {
  for (const [options, expected] of [
    [{ batchSlug: "S26", companySlug: "gamgee" }, /only with authenticated social replay/],
    [{ authenticatedReplay: true, requestedScope: "all", batchSlug: "S26", companySlug: "gamgee" }, /linkedin-only/],
    [{ authenticatedReplay: true, requestedScope: "linkedin", batchSlug: "S26" }, /requires both/],
    [{ authenticatedReplay: true, requestedScope: "linkedin", companySlug: "gamgee" }, /requires both/],
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
  const catalogs = [{ slug: "S26", companies: [{ slug: "gamgee" }] }];
  assert.equal(assertAuthenticatedBackfillTargetExists(catalogs, target), target);
  assert.throws(
    () => assertAuthenticatedBackfillTargetExists(catalogs, {
      batchSlug: "S26",
      companySlug: "missing"
    }),
    /must resolve to exactly one company/
  );
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
