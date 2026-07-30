import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  officialCompanyInstagramIdentityDecision
} from "../scripts/lib/instagram-official-identity.mjs";

describe("official Instagram company identity gate", () => {
  it("does not treat a sole official-site link as company owner proof", () => {
    assert.deepEqual(
      officialCompanyInstagramIdentityDecision({
        snapshotVerified: false,
        uniquelyStrongCompanyHandle: false,
        founderLikeHandle: false
      }),
      {
        reviewState: "needs_review",
        reason: "insufficient_company_owner_proof"
      }
    );
  });

  it("fails closed for a founder-like handle even when it also resembles the company", () => {
    assert.deepEqual(
      officialCompanyInstagramIdentityDecision({
        snapshotVerified: true,
        uniquelyStrongCompanyHandle: true,
        founderLikeHandle: true
      }),
      {
        reviewState: "needs_review",
        reason: "founder_like_handle"
      }
    );
  });

  it("permits exact snapshot or uniquely strong company identity proof", () => {
    assert.equal(
      officialCompanyInstagramIdentityDecision({
        snapshotVerified: true
      }).reviewState,
      "verified"
    );
    assert.equal(
      officialCompanyInstagramIdentityDecision({
        uniquelyStrongCompanyHandle: true
      }).reviewState,
      "verified"
    );
  });

  it("never re-promotes an explicitly rejected identity", () => {
    assert.deepEqual(
      officialCompanyInstagramIdentityDecision({
        explicitlyRejected: true,
        snapshotVerified: true,
        uniquelyStrongCompanyHandle: true
      }),
      {
        reviewState: "needs_review",
        reason: "explicitly_rejected"
      }
    );
  });
});
