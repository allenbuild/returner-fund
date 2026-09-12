import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticatedBackfillTargetEquals,
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
    [{ authenticatedReplay: true, requestedScope: "linkedin", batchSlug: "S26", companySlug: "gamgee,other" }, /canonical lowercase slug/]
  ]) {
    assert.throws(() => resolveAuthenticatedBackfillTarget(options), expected);
  }
});
