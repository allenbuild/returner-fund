import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectionTargetAccountIdentity,
  collectionTargetShouldRun,
  partitionCollectionTargetsByOwnerAmbiguity,
  selectRunnableCollectionTargets
} from "../scripts/lib/logged-in-social-target-selection.mjs";

const attemptKey = (target) => target.id;

describe("logged-in social runnable target selection", () => {
  it("applies the limit after completed targets are removed", () => {
    const targets = [
      { id: "done-positive" },
      { id: "done-empty" },
      { id: "failed" },
      { id: "new-one" },
      { id: "new-two" }
    ];
    const attempts = new Map([
      ["done-positive", { status: "done", count: 3 }],
      ["done-empty", { status: "done", count: 0 }],
      ["failed", { status: "failed", count: 0 }]
    ]);

    assert.deepEqual(
      selectRunnableCollectionTargets(targets, {
        attempts,
        attemptKey,
        limit: 2
      }).map((target) => target.id),
      ["failed", "new-one"]
    );
  });

  it("retries confirmed empties only when explicitly requested", () => {
    const target = { id: "done-empty" };
    const attempts = new Map([["done-empty", { status: "done", count: 0 }]]);
    assert.equal(
      collectionTargetShouldRun(target, { attempts, attemptKey }),
      false
    );
    assert.equal(
      collectionTargetShouldRun(target, {
        attempts,
        attemptKey,
        retryEmpty: true
      }),
      true
    );
  });

  it("force mode includes every target before applying the work limit", () => {
    const targets = [{ id: "one" }, { id: "two" }, { id: "three" }];
    const attempts = new Map(
      targets.map((target) => [target.id, { status: "done", count: 1 }])
    );
    assert.deepEqual(
      selectRunnableCollectionTargets(targets, {
        attempts,
        attemptKey,
        force: true,
        limit: 2
      }).map((target) => target.id),
      ["one", "two"]
    );
  });
});

describe("logged-in social owner collision quarantine", () => {
  it("fails closed for every target sharing one account across distinct owners", () => {
    const founderTarget = {
      id: "founder",
      batchSlug: "S2026",
      platform: "x",
      entityType: "founder",
      entityId: "founder-runtime-gus-trigos",
      url: "https://x.com/gustrigos"
    };
    const companyTarget = {
      id: "company",
      batchSlug: "S2026",
      platform: "x",
      entityType: "company",
      entityId: "company-runtime",
      url: "https://twitter.com/GusTrigos/?ref=profile"
    };
    const safeTarget = {
      id: "safe",
      batchSlug: "S2026",
      platform: "x",
      entityType: "company",
      entityId: "company-safe",
      url: "https://x.com/safe_company"
    };

    const result = partitionCollectionTargetsByOwnerAmbiguity([
      founderTarget,
      safeTarget,
      companyTarget
    ]);

    assert.deepEqual(result.targets.map((target) => target.id), ["safe"]);
    assert.deepEqual(
      result.quarantinedTargets.map((target) => target.id),
      ["founder", "company"]
    );
    assert.equal(result.collisions.length, 1);
    assert.equal(result.collisions[0].accountIdentity, "x:gustrigos");
    assert.deepEqual(result.collisions[0].entityIds, [
      "company-runtime",
      "founder-runtime-gus-trigos"
    ]);
  });

  it("does not quarantine duplicate mappings for the same canonical owner", () => {
    const targets = [
      {
        id: "catalog",
        batchSlug: "S2026",
        platform: "x",
        entityId: "company-runtime",
        url: "https://x.com/runtime"
      },
      {
        id: "override",
        batchSlug: "S2026",
        platform: "x",
        entityId: "company-runtime",
        url: "https://twitter.com/Runtime/"
      }
    ];

    const result = partitionCollectionTargetsByOwnerAmbiguity(targets);
    assert.deepEqual(result.targets, targets);
    assert.deepEqual(result.quarantinedTargets, []);
    assert.deepEqual(result.collisions, []);
  });

  it("scopes account ownership to a batch and platform", () => {
    const targets = [
      {
        id: "spring-x",
        batchSlug: "S2026",
        platform: "x",
        entityId: "founder-spring",
        url: "https://x.com/shared_owner"
      },
      {
        id: "summer-x",
        batchSlug: "S26",
        platform: "x",
        entityId: "founder-summer",
        url: "https://x.com/shared_owner"
      },
      {
        id: "spring-instagram",
        batchSlug: "S2026",
        platform: "instagram",
        entityId: "founder-instagram",
        url: "https://instagram.com/shared_owner"
      }
    ];

    const result = partitionCollectionTargetsByOwnerAmbiguity(targets);
    assert.deepEqual(result.targets, targets);
    assert.deepEqual(result.collisions, []);
  });

  it("fails closed when a shared account target has no canonical entity id", () => {
    const result = partitionCollectionTargetsByOwnerAmbiguity([
      {
        id: "known",
        batchSlug: "S2026",
        platform: "x",
        entityId: "founder-known",
        url: "https://x.com/shared_owner"
      },
      {
        id: "unknown",
        batchSlug: "S2026",
        platform: "x",
        url: "https://x.com/shared_owner"
      }
    ]);

    assert.deepEqual(result.targets, []);
    assert.deepEqual(
      result.quarantinedTargets.map((target) => target.id),
      ["known", "unknown"]
    );
    assert.equal(result.collisions.length, 1);
  });

  it("normalizes native profile identities and rejects foreign hosts", () => {
    assert.equal(
      collectionTargetAccountIdentity({
        platform: "twitter",
        url: "https://www.twitter.com/Owner_Name/?s=20"
      }),
      "x:owner_name"
    );
    assert.equal(
      collectionTargetAccountIdentity({
        platform: "linkedin",
        url: "https://www.linkedin.com/in/Owner-Name/detail/recent-activity/"
      }),
      "linkedin:in/owner-name"
    );
    assert.equal(
      collectionTargetAccountIdentity({
        platform: "x",
        url: "https://example.com/owner_name"
      }),
      null
    );
  });
});
