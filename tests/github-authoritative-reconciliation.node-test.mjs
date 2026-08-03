import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildGithubAuthoritativeQuarantineLedger,
  isFullyAuthoritativeGithubReceipt,
  mergeGithubTractionSnapshots,
  reconcileGithubTractionSnapshots
} from "../scripts/lib/github-authoritative-reconciliation.mjs";

describe("authoritative GitHub reconciliation", () => {
  it("replaces an entire canonical cohort exactly and quarantines absent legacy rows", () => {
    const previous = {
      source: { batchSlug: "S26", fetchedAt: "2026-08-01T00:00:00Z" },
      accounts: [
        account("company-kept", "kept", true),
        account("company-stale", "stale", true)
      ]
    };
    const fresh = completeReceipt("S26", [account("company-kept", "kept", true)]);
    const reconciliation = reconcileGithubTractionSnapshots(previous, fresh);

    assert.equal(isFullyAuthoritativeGithubReceipt(fresh), true);
    assert.equal(reconciliation.authority, "fully_authoritative");
    assert.deepEqual(reconciliation.snapshot, fresh);
    assert.deepEqual(reconciliation.quarantinedAccounts.map((row) => row.entityId), ["company-stale"]);
    assert.deepEqual(mergeGithubTractionSnapshots(previous, fresh), fresh);
  });

  it("retains last-good rows for partial, sharded, or failed receipts", () => {
    const previous = {
      source: { batchSlug: "S26" },
      accounts: [account("company-acme", "acme", true, { marker: "last-good" })]
    };
    const partial = {
      source: {
        batchSlug: "S26",
        companyCount: 10,
        totalCompanyCount: 20,
        companyShardCount: 2,
        companyShardIndex: 0,
        targetCount: 1,
        fetchedCount: 0
      },
      accounts: [account("company-acme", "acme", false, { marker: "failed" })]
    };
    const reconciliation = reconcileGithubTractionSnapshots(previous, partial, {
      fetchedAt: "2026-08-02T00:00:00Z"
    });

    assert.equal(isFullyAuthoritativeGithubReceipt(partial), false);
    assert.equal(reconciliation.authority, "partial_or_failed");
    assert.equal(reconciliation.retainedLastGood, 1);
    assert.equal(reconciliation.snapshot.accounts[0].marker, "last-good");
    assert.deepEqual(reconciliation.quarantinedAccounts, []);
  });

  it("records physical representation and shared-owner review without making quarantined rows scoreable", () => {
    const sharedRepository = {
      id: 42,
      fullName: "acme/shared",
      htmlUrl: "https://github.com/acme/shared"
    };
    const company = account("company-acme", "acme", true, {
      repos: [sharedRepository]
    });
    const founder = {
      ...account("founder-acme", "acme", true, { repos: [sharedRepository] }),
      entityType: "founder",
      name: "A. Founder"
    };
    const fresh = completeReceipt("A16ZSR006", [company, founder]);
    const legacyRepository = account("company-legacy", "acme", true, {
      repo: "shared",
      githubUrl: "https://github.com/acme/shared",
      repos: [sharedRepository]
    });
    const reconciliation = reconcileGithubTractionSnapshots(
      { source: { batchSlug: "A16ZSR006" }, accounts: [legacyRepository] },
      fresh
    );
    const ledger = buildGithubAuthoritativeQuarantineLedger({
      reconciliations: [reconciliation],
      canonicalSnapshots: [fresh]
    });

    assert.equal(ledger.source.rowCount, 1);
    assert.equal(ledger.source.scoringEligible, false);
    assert.equal(ledger.rows[0].scoringEligible, false);
    assert.equal(
      ledger.rows[0].physicalRepresentation.status,
      "represented_in_current_canonical_receipt"
    );
    assert.deepEqual(
      ledger.rows[0].physicalRepresentation.matchedBy,
      ["repository_id", "canonical_url"]
    );
    assert.deepEqual(
      ledger.rows[0].physicalRepresentation.repositories.map((repository) => ({
        repositoryId: repository.repositoryId,
        status: repository.status
      })),
      [{ repositoryId: "42", status: "represented_in_current_canonical_receipt" }]
    );
    assert.equal(ledger.physicalEvidenceOwnerReview.length, 1);
    assert.equal(ledger.physicalEvidenceOwnerReview[0].physicalIdentity.repositoryId, "42");
    assert.deepEqual(
      ledger.physicalEvidenceOwnerReview[0].ownerCandidates.map((owner) => owner.entityId),
      ["company-acme", "founder-acme"]
    );
    assert.equal(ledger.physicalEvidenceOwnerReview[0].scoringPolicy, "deduplicate_physical_evidence");
  });
});

function completeReceipt(batchSlug, accounts) {
  return {
    source: {
      batchSlug,
      fetchedAt: "2026-08-02T00:00:00Z",
      companyCount: 1,
      totalCompanyCount: 1,
      companyShardCount: 1,
      companyShardIndex: 0,
      targetCount: accounts.length,
      fetchedCount: accounts.length
    },
    accounts
  };
}

function account(entityId, login, fetched, overrides = {}) {
  return {
    entityType: "company",
    entityId,
    companySlug: entityId.replace(/^company-/, ""),
    companyName: entityId,
    name: entityId,
    githubUrl: `https://github.com/${login}`,
    login,
    repo: null,
    fetched,
    repos: [],
    ...overrides
  };
}
