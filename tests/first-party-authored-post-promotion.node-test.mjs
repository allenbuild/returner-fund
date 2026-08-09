import assert from "node:assert/strict";
import test from "node:test";

import { planFirstPartyAuthoredPostPromotion } from "../scripts/lib/first-party-authored-post-promotion.mjs";
import { authoredContentFingerprint, sha256 } from "../scripts/lib/first-party-authored-post-recovery.mjs";

test("appends verified first-party posts, keeps them unscored, and resolves exact review URLs", () => {
  const row = candidateRow();
  const unrelated = reviewRow("https://example.com/blog/other");
  const canonical = snapshot([], [reviewRow(row.sourceUrl), unrelated]);
  const plan = makePlan(canonical, [row]);
  assert.equal(plan.additions.length, 1);
  assert.equal(plan.zeroEngagementAdditions, 1);
  assert.equal(plan.resolvedReview.length, 1);
  assert.deepEqual(plan.promoted.needsReview, [unrelated]);
  assert.deepEqual(plan.promoted.failures, canonical.failures);
});

test("fails closed on current overlap, duplicate content, owner drift, and provenance tampering", () => {
  const row = candidateRow();
  assert.throws(() => makePlan(snapshot(), [row], [{ evidence: [row] }]), /already_in_current_evidence/);
  assert.throws(() => makePlan(snapshot(), [row, candidateRow({
    id: candidateId("https://example.com/blog/second"),
    sourceUrl: "https://example.com/blog/second",
    platformPostId: "https://example.com/blog/second"
  })]), /duplicates candidate authored content/);
  assert.throws(() => makePlan(snapshot(), [{ ...row, companyName: "Wrong" }]), /official owner disagrees/);
  assert.throws(() => makePlan(snapshot(), [{
    ...row,
    _recoveryProvenance: { ...row._recoveryProvenance, contentSha256: "0".repeat(64) }
  }]), /mismatched recovery provenance/);
});

test("fails closed when a candidate publication date follows candidate generation", () => {
  assert.throws(
    () =>
      makePlan(snapshot(), [
        candidateRow({ postedAt: "2026-08-13T00:00:00.000Z" }),
      ]),
    /publication_date_after_observation/,
  );
});

test("requires a valid non-future candidate observation timestamp", () => {
  for (const generatedAt of [undefined, "not-a-date", "2099-01-01T00:00:00.000Z"]) {
    assert.throws(
      () => makePlan(snapshot(), [candidateRow()], [], { generatedAt }),
      /generatedAt must (?:be a valid observation timestamp|not be in the future)/,
    );
  }
});

function makePlan(canonical, evidence, extraReferences = [], candidateOverrides = {}) {
  return planFirstPartyAuthoredPostPromotion({
    canonical,
    candidate: {
      schemaVersion: "first-party-authored-post-promotion-candidate.v1",
      generatedAt: "2026-08-09T00:00:00.000Z",
      counts: { total: evidence.length },
      audit: { zeroDuplicateAudit: true, referenceUrlOverlap: 0, referenceContentOverlap: 0 },
      evidence,
      ...candidateOverrides
    },
    graphDocuments: [graphDocument()],
    referenceDocuments: extraReferences,
    now: new Date("2026-08-09T12:00:00.000Z")
  });
}

function candidateRow(overrides = {}) {
  const sourceUrl = overrides.sourceUrl ?? "https://example.com/blog/launch-post";
  const row = {
    id: candidateId(sourceUrl),
    batchSlug: "S2026",
    entityType: "company",
    entityId: "company-example",
    entityName: "Example",
    companySlug: "example",
    companyName: "Example",
    platform: "web",
    title: "Example launches a durable new product",
    sourceUrl,
    platformPostId: sourceUrl,
    text: "This is a substantive authored article with enough exact content for recovery.",
    postedAt: "2026-08-01T00:00:00.000Z",
    metrics: {},
    contributionScore: 0,
    review_state: "verified",
    linkStatus: "verified",
    attributionStatus: "verified",
    attributionVersion: 3,
    attributionMode: "subject",
    attributionSignals: [
      "current_cohort_owner",
      "exact_current_official_domain",
      "stable_authored_item_url",
      "title_text_date_provenance"
    ]
  };
  row._recoveryProvenance = {
    schemaVersion: 1,
    sourcePath: "history.json",
    sourceKind: "repository_history",
    officialWebsiteUrl: "https://example.com/",
    officialHost: "example.com",
    contentSha256: authoredContentFingerprint(row),
    zeroEngagementAccepted: true
  };
  return { ...row, ...overrides };
}

function candidateId(sourceUrl) {
  return `first-party-web-${sha256(`S2026|company-example|${sourceUrl}`).slice(0, 24)}`;
}

function snapshot(evidence = [], needsReview = []) {
  return {
    source: { fetchedAt: "2026-08-08T00:00:00.000Z", evidenceCount: evidence.length, needsReviewCount: needsReview.length },
    evidence,
    needsReview,
    attributionReconciliationLedger: [{ keep: true }],
    failures: [{ keep: true }],
    attempts: { keep: true },
    discoveryAttempts: [{ keep: true }],
    sourceDiscoveryPaths: [{ keep: true }]
  };
}

function reviewRow(sourceUrl) {
  return { id: `review-${sourceUrl}`, platform: "web", sourceUrl, review_state: "needs_review" };
}

function graphDocument() {
  return {
    batch: { slug: "S2026" },
    nodes: [{
      entityType: "company",
      entityId: "company-example",
      companySlug: "example",
      label: "Example",
      websiteUrl: "https://example.com/",
      founders: []
    }]
  };
}
