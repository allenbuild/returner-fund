import assert from "node:assert/strict";
import test from "node:test";

import { mergePublicEvidenceSnapshots } from "../scripts/lib/autonomous-ingestion-plan.mjs";
import {
  auditRepositoryHistoryXCandidate,
  buildRepositoryHistoryPublicEvidenceCandidate,
  isVerifiedRepositoryHistoryXMetriclessEvidence,
  repositoryHistoryXTrustFailures,
  withXPublicStatusValidation
} from "../scripts/lib/repository-history-public-evidence-candidate.mjs";
import {
  parseRepositoryHistoryPromotionArgs,
  planRepositoryHistoryXPromotion
} from "../scripts/promote-repository-history-x-candidate.mjs";

const postId = "1289216226527338496";
const exactPostedAt = "2020-07-31T15:07:55.540Z";

function recoveredRow(overrides = {}) {
  const base = {
    id: "recovered-x-post",
    batchSlug: "S2026",
    entityType: "founder",
    entityId: "founder-example-alice-1",
    companySlug: "example",
    companyName: "Example",
    platform: "x",
    sourceUrl: `https://x.com/aliceexample/status/${postId}`,
    platformPostId: postId,
    accountUrl: "https://x.com/aliceexample",
    authorName: "Alice Example",
    text: "A substantive recovered post body that contains enough exact words for deterministic content identity duplicate checks today.",
    rawVisibleText: JSON.stringify({ author: "aliceexample", name: "Alice Example" }),
    postedAt: exactPostedAt,
    metrics: { likes: 0, reposts: 0, comments: 0 },
    contributionScore: 0,
    review_state: "verified",
    linkStatus: "verified",
    attributionStatus: "verified",
    attributionMode: "account_owner",
    attributionSignals: [
      "current_verified_account_mapping",
      "official_x_oembed_author_match",
      "native_x_snowflake_timestamp"
    ],
    _recoveryProvenance: {
      schemaVersion: 1,
      kind: "git_repository_history_plus_official_x_oembed",
      physicalKey: `x:${postId}`,
      git: {
        commit: "a".repeat(40),
        committedAt: "2026-08-01T00:00:00.000Z",
        path: "src/lib/social/logged-in-evidence-current.json",
        sourceIndex: 42
      },
      liveValidation: {
        checkedAt: "2026-08-09T00:00:00.000Z",
        endpoint: `https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(`https://x.com/aliceexample/status/${postId}`)}`,
        returnedUrl: `https://x.com/aliceexample/status/${postId}`,
        returnedAuthorUrl: "https://x.com/aliceexample"
      },
      timestamp: {
        method: "x_snowflake_epoch",
        exactPostedAt,
        historicalPostedAt: "2020-07-31T15:07:55.000Z"
      }
    }
  };
  return { ...base, ...overrides };
}

function promotionReadyRow(overrides = {}) {
  const row = recoveredRow(overrides);
  return withXPublicStatusValidation(row, {
    post: {
      id: postId,
      url: `https://x.com/aliceexample/status/${postId}`,
      authorHandle: "aliceexample",
      authorName: "Alice Example",
      postedAt: "2020-07-31T15:07:55.000Z",
      metrics: { likes: 0, reposts: 0, replies: 0 }
    },
    checkedAt: "2026-08-09T01:00:00.000Z",
    responseBody: "<html>official public X status response</html>"
  });
}

test("builds a repository-native candidate with exact zero-engagement receipts", () => {
  const row = promotionReadyRow();
  assert.deepEqual(repositoryHistoryXTrustFailures(row), []);
  assert.equal(isVerifiedRepositoryHistoryXMetriclessEvidence(row), true);
  assert.deepEqual(row.metrics, { likes: 0, replies: 0, reposts: 0 });
  assert.equal(row.contributionScore, 0);

  const candidate = buildRepositoryHistoryPublicEvidenceCandidate([row], {
    generatedAt: "2026-08-09T01:00:00.000Z",
    inputPath: "/tmp/recovered.ndjson"
  });
  assert.equal(candidate.source.evidenceCount, 1);
  assert.deepEqual(candidate.source.batchSlugs, ["S2026"]);
  assert.deepEqual(candidate.needsReview, []);
  assert.deepEqual(candidate.failures, []);
  assert.deepEqual(candidate.attempts, {});
});

test("audits physical, id, and substantive-content collisions against current evidence", () => {
  const row = promotionReadyRow();
  const candidate = buildRepositoryHistoryPublicEvidenceCandidate([row]);
  const cleanAudit = auditRepositoryHistoryXCandidate(candidate, {
    currentSnapshots: [{ evidence: [] }],
    expectedTotal: 1,
    expectedByBatch: { S2026: 1, S26: 0 }
  });
  assert.equal(cleanAudit.duplicatePhysical, 0);
  assert.equal(cleanAudit.duplicateContent, 0);
  assert.equal(cleanAudit.zeroEngagementEvidence, 1);

  const physicalAudit = auditRepositoryHistoryXCandidate(candidate, {
    currentSnapshots: [{ evidence: [{ ...row, id: "current-copy" }] }],
    expectedTotal: 1,
    expectedByBatch: { S2026: 1 },
    throwOnFailure: false
  });
  assert.equal(physicalAudit.currentPhysicalCollisions, 1);

  const contentAudit = auditRepositoryHistoryXCandidate(candidate, {
    currentSnapshots: [{ evidence: [{
      ...row,
      id: "different-physical-copy",
      sourceUrl: "https://x.com/aliceexample/status/1289216226527338497",
      platformPostId: "1289216226527338497"
    }] }],
    expectedTotal: 1,
    expectedByBatch: { S2026: 1 },
    throwOnFailure: false
  });
  assert.equal(contentAudit.duplicateContent, 1);
});

test("keeps the metricless exception opt-in and receipt scoped", () => {
  const row = promotionReadyRow();
  const snapshot = {
    source: { batchSlugs: ["S2026"], fetchedAt: "2026-08-09T01:00:00.000Z" },
    evidence: [row]
  };
  const defaultMerge = mergePublicEvidenceSnapshots([snapshot]);
  assert.equal(defaultMerge.evidence.length, 0);
  assert.deepEqual(defaultMerge.needsReview[0].quarantineReasons, [
    "no_visible_positive_scoring_metrics"
  ]);

  const recoveryMerge = mergePublicEvidenceSnapshots([snapshot], {
    allowVerifiedMetriclessEvidence: isVerifiedRepositoryHistoryXMetriclessEvidence
  });
  assert.equal(recoveryMerge.evidence.length, 1);
  assert.equal(recoveryMerge.needsReview.length, 0);

  const tampered = {
    ...row,
    _recoveryProvenance: {
      ...row._recoveryProvenance,
      publicStatusValidation: {
        ...row._recoveryProvenance.publicStatusValidation,
        responseSha256: "not-a-hash"
      }
    }
  };
  assert.equal(isVerifiedRepositoryHistoryXMetriclessEvidence(tampered), false);
});

test("plans an append-only exact cohort promotion", () => {
  const row = promotionReadyRow();
  const candidate = buildRepositoryHistoryPublicEvidenceCandidate([row]);
  const audit = auditRepositoryHistoryXCandidate(candidate, {
    currentSnapshots: [{ evidence: [] }],
    expectedTotal: 1,
    expectedByBatch: { S2026: 1, S26: 0 }
  });
  const candidateGate = mergePublicEvidenceSnapshots([candidate], {
    allowVerifiedMetriclessEvidence: isVerifiedRepositoryHistoryXMetriclessEvidence
  });
  const canonical = {
    source: { evidenceCount: 0, needsReviewCount: 0 },
    evidence: [],
    needsReview: [],
    attributionReconciliationLedger: [],
    failures: [],
    attempts: {},
    discoveryAttempts: [],
    sourceDiscoveryPaths: []
  };
  const plan = planRepositoryHistoryXPromotion({
    canonical,
    candidate,
    merged: candidateGate,
    candidateGate,
    audit,
    expectedTotal: 1,
    expectedByBatch: { S2026: 1, S26: 0 }
  });
  assert.equal(plan.additions.length, 1);
  assert.deepEqual(plan.addedByBatch, { S2026: 1 });
  assert.equal(plan.promoted.evidence.length, 1);
  assert.deepEqual(plan.promoted.failures, canonical.failures);
});

test("parses exact dry-run expectations and rejects inconsistent cohorts", () => {
  assert.deepEqual(parseRepositoryHistoryPromotionArgs([
    "--candidate=work/candidate.json",
    "--expected-total=40",
    "--expected-s2026=14",
    "--expected-s26=26",
    "--dry-run"
  ]), {
    candidate: "work/candidate.json",
    receipt: null,
    expectedTotal: 40,
    expectedByBatch: { S2026: 14, S26: 26 },
    dryRun: true,
    write: false
  });
  assert.throws(() => parseRepositoryHistoryPromotionArgs([
    "--candidate=work/candidate.json",
    "--expected-total=40",
    "--expected-s2026=13",
    "--expected-s26=26",
    "--dry-run"
  ]), /must sum/);
});
