import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildAutonomousPublicNativeAuthorResolver,
  loadAutonomousCatalogs,
  mergePublicEvidenceSnapshots
} from "../scripts/lib/autonomous-ingestion-plan.mjs";
import { assessLinkedInPrimaryPostBody } from "../scripts/lib/public-evidence-attribution.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const auditPath = join(
  root,
  "outputs/source-hunt/current-run-public-native-author-gate-impact-audit.json"
);
const canonicalPath = join(root, "src/lib/social/public-evidence-current.json");

const replayPromise = replayUnresolvedAuthorAudit();

describe("public native-author gate-impact artifact replay", () => {
  it("replays the exhaustive 41/62/2 subject oracle without fabricating authorship", async () => {
    const replay = await replayPromise;
    const validSubjects = replay.auditRecords.filter(isValidSubject);
    const unresolvedSubjects = replay.auditRecords.filter((record) =>
      record.subjectAssessment.classification === "unresolved_subject"
    );
    const hardMismatches = replay.auditRecords.filter((record) =>
      record.subjectAssessment.classification === "reject_subject_mismatch"
    );

    assert.equal(validSubjects.length, 41);
    assert.equal(unresolvedSubjects.length, 62);
    assert.equal(hardMismatches.length, 2);
    assert.deepEqual(
      countBy(validSubjects, (record) => record.subjectAssessment.subjectDisposition),
      {
        reassign_founder_to_company: 3,
        retain_company: 32,
        retain_founder: 6
      }
    );
    assert.equal(
      validSubjects.filter((record) =>
        !replay.reviewByCanonicalId.get(record.canonicalRowId)?.quarantineReasons?.includes(
          "semantic_attribution:list_or_roundup_without_target_specific_owner_anchor"
        ) &&
        record.subjectAssessment.proposedSubjectAttribution.entityType === "company"
      ).length,
      34
    );
    assert.equal(
      validSubjects.filter((record) =>
        record.subjectAssessment.proposedSubjectAttribution.entityType === "founder"
      ).length,
      6
    );

    const structuredRoundupOverrides = validSubjects.filter((record) =>
      replay.reviewByCanonicalId.get(record.canonicalRowId)?.quarantineReasons?.includes(
        "semantic_attribution:list_or_roundup_without_target_specific_owner_anchor"
      )
    );
    assert.deepEqual(structuredRoundupOverrides.map((record) => record.physicalId), [
      "7478895855991775232"
    ]);

    for (const expected of validSubjects.filter((record) =>
      !structuredRoundupOverrides.includes(record)
    )) {
      const accepted = replay.acceptedByCanonicalId.get(expected.canonicalRowId);
      assert(accepted, `${expected.physicalIdentity} should remain accepted as a subject`);
      const proposed = expected.subjectAssessment.proposedSubjectAttribution;
      assert.deepEqual(
        [accepted.batchSlug, accepted.entityType, accepted.entityId],
        [proposed.batchSlug, proposed.entityType, proposed.entityId],
        `${expected.physicalIdentity} subject attribution differs from the oracle`
      );
      assert.equal(accepted.attributionMode, "subject", expected.physicalIdentity);
      assert.notEqual(
        accepted.nativeAuthorResolution?.status,
        "matched",
        `${expected.physicalIdentity} must not fabricate a roster author match`
      );
      assert.equal(
        accepted.nativeAuthorResolution?.owner,
        undefined,
        `${expected.physicalIdentity} must not fabricate a roster owner`
      );
    }

    const newlyResolvedSubjects = unresolvedSubjects.filter((record) =>
      replay.resolveNativeAuthor(replay.candidateByCanonicalId.get(record.canonicalRowId))?.status === "matched"
    );
    assert.deepEqual(newlyResolvedSubjects.map((record) => record.physicalId), [
      "7484347612448587776"
    ]);
    const newlyResolved = replay.acceptedByCanonicalId.get(newlyResolvedSubjects[0].canonicalRowId);
    assert.deepEqual(
      [newlyResolved.batchSlug, newlyResolved.entityType, newlyResolved.entityId],
      ["S26", "founder", "founder-gutgutgoose-leon-mojarrabi-991771"]
    );

    const falseAccepts = unresolvedSubjects
      .filter((record) => !newlyResolvedSubjects.includes(record))
      .filter((record) => replay.acceptedByCanonicalId.has(record.canonicalRowId))
      .map((record) => record.physicalId)
      .sort();
    assert.deepEqual(falseAccepts, []);
    assert.deepEqual(
      unresolvedSubjects
        .filter((record) => !newlyResolvedSubjects.includes(record))
        .filter((record) => !replay.reviewByCanonicalId.has(record.canonicalRowId))
        .map((record) => record.physicalId)
        .sort(),
      []
    );

    const quarantinedPhysicalIds = new Set(
      replay.merged.attributionReconciliationLedger
        .filter((entry) => entry.disposition === "quarantined")
        .map((entry) => String(entry.platformPostId))
    );
    for (const expected of hardMismatches) {
      assert.equal(replay.acceptedByCanonicalId.has(expected.canonicalRowId), false);
      assert(replay.reviewByCanonicalId.has(expected.canonicalRowId));
      assert(quarantinedPhysicalIds.has(expected.physicalId));
    }
  });

  it("honors the two narrowly bounded identity normalizations", async () => {
    const replay = await replayPromise;
    const suffix = replay.auditByPhysicalId.get("7450398541010616320");
    const diacritic = replay.auditByPhysicalId.get("7460796099386171393");

    assert.deepEqual(suffix.subjectAssessment.nativeBodyEvidence.proof.normalization, {
      kind: "bounded_legal_suffix_elision",
      canonical: "Enjamb Labs",
      observed: "Enjamb",
      allowedSuffix: "Labs"
    });
    assert.deepEqual(diacritic.subjectAssessment.nativeBodyEvidence.proof.normalization, {
      kind: "unicode_nfkd_combining_mark_elision",
      canonical: "Peter Vajda",
      observed: "Péter Vajda"
    });
    assert(replay.acceptedByCanonicalId.has(suffix.canonicalRowId));
    assert(replay.acceptedByCanonicalId.has(diacritic.canonicalRowId));
  });

  it("reassigns only the three founder rows whose primary bodies prove a company", async () => {
    const replay = await replayPromise;
    const expected = new Map([
      ["7450604868651732992", ["S2026", "company", "company-datost"]],
      ["7477356233977405440", ["S2026", "company", "company-pentagon"]],
      ["7482811226582867968", ["S26", "company", "company-screenpipe"]]
    ]);
    const reassignments = replay.auditRecords.filter((record) =>
      record.subjectAssessment.subjectDisposition === "reassign_founder_to_company"
    );

    assert.equal(reassignments.length, 3);
    for (const record of reassignments) {
      const accepted = replay.acceptedByCanonicalId.get(record.canonicalRowId);
      assert(accepted, record.physicalIdentity);
      assert.deepEqual(
        [accepted.batchSlug, accepted.entityType, accepted.entityId],
        expected.get(record.physicalId)
      );
    }
  });

  it("reassigns Leon Mojarrabi's public post and removes the exact stale Inkbox quarantine", async () => {
    const replay = await replayPromise;
    const physicalId = "7484347612448587776";
    const record = replay.auditByPhysicalId.get(physicalId);
    const staleReview = replay.canonicalById.get(record.canonicalRowId);
    const candidate = replay.candidateByCanonicalId.get(record.canonicalRowId);
    const priorLedger = replay.canonical.attributionReconciliationLedger.filter(
      (entry) => String(entry.platformPostId) === physicalId
    );

    const merged = mergePublicEvidenceSnapshots([
      {
        source: { batchSlugs: ["S26"] },
        evidence: [],
        needsReview: [staleReview],
        failures: [],
        attributionReconciliationLedger: priorLedger
      },
      {
        source: { batchSlugs: ["S26"] },
        evidence: [candidate],
        needsReview: [],
        failures: []
      }
    ], {
      fetchedAt: "2026-07-20T00:00:00.000Z",
      resolveNativeAuthor: replay.resolveNativeAuthor
    });

    const accepted = merged.evidence.filter((row) => row.platformPostId === physicalId);
    assert.equal(accepted.length, 1);
    assert.deepEqual(
      [accepted[0].batchSlug, accepted[0].entityType, accepted[0].entityId],
      ["S26", "founder", "founder-gutgutgoose-leon-mojarrabi-991771"]
    );
    assert.equal(
      merged.needsReview.some((row) => String(row.platformPostId) === physicalId),
      false
    );
    assert.ok(merged.attributionReconciliationLedger.some((entry) =>
      entry.platform === "linkedin" &&
      entry.platformPostId === physicalId &&
      entry.disposition === "reattributed" &&
      entry.staleAttribution?.entityId === "founder-inkbox-ray-liao-778892" &&
      entry.replacementAttribution?.entityId === "founder-gutgutgoose-leon-mojarrabi-991771"
    ));

    const replayed = mergePublicEvidenceSnapshots([merged], {
      fetchedAt: "2026-07-20T00:00:00.000Z",
      resolveNativeAuthor: replay.resolveNativeAuthor
    });
    assert.equal(replayed.evidence.filter((row) => row.platformPostId === physicalId).length, 1);
    assert.equal(replayed.needsReview.some((row) => String(row.platformPostId) === physicalId), false);
  });

  it("rejects related-post chrome, a conflicting suffix, and cross-company ambiguity", async () => {
    const replay = await replayPromise;
    const nineFives = replay.candidateByCanonicalId.get(
      replay.auditByPhysicalId.get("7483487916195729409").canonicalRowId
    );
    const enjamb = replay.candidateByCanonicalId.get(
      replay.auditByPhysicalId.get("7450398541010616320").canonicalRowId
    );
    const callabFounder = replay.candidateByCanonicalId.get(
      replay.auditByPhysicalId.get("7450604868651732992").canonicalRowId
    );
    const relatedOnly = syntheticLinkedInRow(nineFives, {
      id: "linkedin-negative-related-post-only",
      platformPostId: "7999999999999999901",
      primaryBody: "Primary post discusses an unrelated product with no roster identity.",
      afterBoundary: "## More Relevant Posts Nine Fives (YC P26) by Noah Levy and Andrew Kurtz"
    });
    const conflictingSuffix = syntheticLinkedInRow(enjamb, {
      id: "linkedin-negative-conflicting-legal-suffix",
      platformPostId: "7999999999999999902",
      primaryBody: "Enjamb Systems (YC P26) announced a different research product with Maadhav Deekshitha.",
      afterBoundary: ""
    });
    const ambiguousCrossCompany = syntheticLinkedInRow(callabFounder, {
      id: "linkedin-negative-ambiguous-cross-company-subject",
      platformPostId: "7999999999999999903",
      primaryBody: "Datost (YC P26), built by Jason Wang and Maceo Cardinale Kwik, and OpenWork (YC P26) announced separate products in this two-company roundup.",
      afterBoundary: ""
    });

    assert.equal(assessLinkedInPrimaryPostBody(relatedOnly).verified, true);
    assert.equal(assessLinkedInPrimaryPostBody(relatedOnly).text.includes("Nine Fives"), false);

    const merged = mergePublicEvidenceSnapshots([{
      source: { batchSlugs: ["S2026"] },
      evidence: [relatedOnly, conflictingSuffix, ambiguousCrossCompany],
      needsReview: [],
      failures: []
    }], {
      fetchedAt: "2026-07-20T00:00:00.000Z",
      resolveNativeAuthor: replay.resolveNativeAuthor
    });

    assert.deepEqual(merged.evidence.map((row) => row.id), []);
    assert.deepEqual(
      merged.needsReview.map((row) => row.sourceEvidenceId ?? row.id).sort(),
      [relatedOnly.id, conflictingSuffix.id, ambiguousCrossCompany.id].sort()
    );
  });

  it("quarantines the frozen dense LinkedIn company roundup while retaining focused third-party subjects on replay", async () => {
    const replay = await replayPromise;
    const roundupId = "7478895855991775232";
    const focusedThirdPartyId = "7459281446504120320";
    const roundupRecord = replay.auditByPhysicalId.get(roundupId);
    const focusedRecord = replay.auditByPhysicalId.get(focusedThirdPartyId);
    const review = replay.reviewByCanonicalId.get(roundupRecord.canonicalRowId);

    assert.equal(replay.acceptedByCanonicalId.has(roundupRecord.canonicalRowId), false);
    assert.deepEqual(review.quarantineReasons, [
      "semantic_attribution:list_or_roundup_without_target_specific_owner_anchor"
    ]);
    assert.equal(review.review_state, "needs_review");
    assert.ok(replay.merged.attributionReconciliationLedger.some((entry) =>
      entry.platform === "linkedin" &&
      entry.platformPostId === roundupId &&
      entry.disposition === "quarantined" &&
      entry.reason === "semantic_attribution:list_or_roundup_without_target_specific_owner_anchor"
    ));
    assert.ok(
      replay.acceptedByCanonicalId.has(focusedRecord.canonicalRowId),
      "a focused third-party post about one company must remain accepted"
    );

    const replayed = mergePublicEvidenceSnapshots([replay.merged], {
      fetchedAt: "2026-07-20T00:00:00.000Z",
      resolveNativeAuthor: replay.resolveNativeAuthor
    });
    assert.deepEqual(replayed.evidence, replay.merged.evidence);
    assert.deepEqual(replayed.needsReview, replay.merged.needsReview);
    assert.deepEqual(
      replayed.attributionReconciliationLedger,
      replay.merged.attributionReconciliationLedger
    );
  });

  it("does not let dense cohort markers confined to a comment quarantine a focused third-party subject", async () => {
    const replay = await replayPromise;
    const focusedRecord = replay.auditByPhysicalId.get("7459281446504120320");
    const focused = replay.candidateByCanonicalId.get(focusedRecord.canonicalRowId);
    const commentOnlyRoundup = syntheticLinkedInRow(focused, {
      id: "linkedin-focused-subject-with-dense-comment",
      platformPostId: "7999999999999999904",
      primaryBody: "Armature (YC P26) released one focused product update.",
      afterBoundary: ""
    });
    commentOnlyRoundup.rawVisibleText = commentOnlyRoundup.rawVisibleText.replace(
      "[Like](https://linkedin.com/signup)",
      [
        "[Report this comment](https://linkedin.com/uas/login?guestReportContentType=COMMENT)",
        "COMMENT ONLY: Datost (YC P26) OpenWork (YC P26) Enjamb Labs (YC P26) Nine Fives (YC P26)",
        "[Like](https://linkedin.com/signup)"
      ].join(" ")
    );

    const assessment = assessLinkedInPrimaryPostBody(commentOnlyRoundup);
    assert.equal(assessment.verified, true);
    assert.equal(assessment.text, "Armature (YC P26) released one focused product update.");

    const merged = mergePublicEvidenceSnapshots([{
      source: { batchSlugs: ["S2026"] },
      evidence: [commentOnlyRoundup],
      needsReview: [],
      failures: []
    }], {
      fetchedAt: "2026-07-20T00:00:00.000Z",
      resolveNativeAuthor: replay.resolveNativeAuthor
    });

    assert.deepEqual(merged.evidence.map((row) => row.id), [commentOnlyRoundup.id]);
    assert.equal(merged.needsReview.length, 0);
    assert.equal(merged.attributionReconciliationLedger.length, 0);
  });
});

async function replayUnresolvedAuthorAudit() {
  const [audit, canonical, catalogs] = await Promise.all([
    readJson(auditPath),
    readJson(canonicalPath),
    loadAutonomousCatalogs(root)
  ]);
  const canonicalById = new Map(
    [...(canonical.evidence ?? []), ...(canonical.needsReview ?? [])]
      .flatMap((row) => [
        [row.id, row],
        ...(row.sourceEvidenceId ? [[row.sourceEvidenceId, row]] : [])
      ])
  );
  const auditRecords = audit.records.filter((record) => record.action === "review");
  assert.equal(auditRecords.length, 105);
  const rows = auditRecords.map((record) => {
    const canonicalRow = canonicalById.get(record.canonicalRowId);
    assert(canonicalRow, `Missing canonical fixture ${record.canonicalRowId}`);
    const {
      attributionReconciliationDirective: _attributionReconciliationDirective,
      candidateUrl: _candidateUrl,
      duplicateEvidenceIdentity: _duplicateEvidenceIdentity,
      quarantineReasons: _quarantineReasons,
      sourceEvidenceId: _sourceEvidenceId,
      ...candidate
    } = canonicalRow;
    return {
      ...candidate,
      id: record.canonicalRowId,
      batchSlug: record.currentAttribution.batchSlug,
      entityType: record.currentAttribution.entityType,
      entityId: record.currentAttribution.entityId,
      entityName: record.currentAttribution.entityName,
      companySlug: record.currentAttribution.companySlug,
      companyName: record.currentAttribution.companyName,
      review_state: "verified",
      attributionMode: "subject"
    };
  });
  const resolveNativeAuthor = buildAutonomousPublicNativeAuthorResolver(catalogs);
  const merged = mergePublicEvidenceSnapshots([{
    source: { batchSlugs: ["S2026", "S26", "A16ZSR006"] },
    evidence: rows,
    needsReview: [],
    failures: []
  }], {
    fetchedAt: "2026-07-20T00:00:00.000Z",
    resolveNativeAuthor
  });

  return {
    auditRecords,
    auditByPhysicalId: new Map(auditRecords.map((record) => [record.physicalId, record])),
    candidateByCanonicalId: new Map(rows.map((row) => [row.id, row])),
    canonicalById,
    canonical,
    resolveNativeAuthor,
    merged,
    acceptedByCanonicalId: new Map(
      merged.evidence.map((row) => [row.sourceEvidenceId ?? row.id, row])
    ),
    reviewByCanonicalId: new Map(
      merged.needsReview.map((row) => [row.sourceEvidenceId ?? row.id, row])
    )
  };
}

function syntheticLinkedInRow(base, { id, platformPostId, primaryBody, afterBoundary }) {
  const sourceUrl = `https://linkedin.com/posts/activity-${platformPostId}-test`;
  return {
    ...base,
    id,
    sourceEvidenceId: undefined,
    sourceUrl,
    canonicalUrl: sourceUrl,
    platformPostId,
    title: "Unrelated native LinkedIn post",
    text: "Unrelated native LinkedIn post",
    authorHandle: null,
    accountUrl: null,
    attributionMode: "subject",
    rawVisibleText: [
      "Title: Unrelated native LinkedIn post",
      `URL Source: ${sourceUrl}`,
      "Markdown Content:",
      "# Outside Observer’s Post",
      "* [Report this post](https://linkedin.com/uas/login?guestReportContentType=POST)",
      primaryBody,
      "[Like](https://linkedin.com/signup)",
      afterBoundary
    ].join(" ")
  };
}

function isValidSubject(record) {
  return [
    "valid_founder_subject_exact_full_name",
    "valid_strong_third_party_company_subject",
    "valid_native_body_company_subject",
    "valid_native_body_founder_subject_exact_full_name",
    "valid_native_body_company_subject_requires_entity_reassignment"
  ].includes(record.subjectAssessment.classification);
}

function countBy(items, selector) {
  return Object.fromEntries(
    Object.entries(Object.groupBy(items, selector))
      .map(([key, values]) => [key, values.length])
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
