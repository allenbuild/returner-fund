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
        record.subjectAssessment.proposedSubjectAttribution.entityType === "company"
      ).length,
      35
    );
    assert.equal(
      validSubjects.filter((record) =>
        record.subjectAssessment.proposedSubjectAttribution.entityType === "founder"
      ).length,
      6
    );

    assert.deepEqual(
      validSubjects
        .filter((record) => !replay.acceptedByCanonicalId.has(record.canonicalRowId))
        .map((record) => record.physicalId)
        .sort(),
      [],
      "every oracle-valid subject should be accepted"
    );

    for (const expected of validSubjects) {
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

    const falseAccepts = unresolvedSubjects
      .filter((record) => replay.acceptedByCanonicalId.has(record.canonicalRowId))
      .map((record) => record.physicalId)
      .sort();
    assert.deepEqual(falseAccepts, []);
    assert.deepEqual(
      unresolvedSubjects
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

  it("rejects related-post chrome, a conflicting suffix, and cross-company ambiguity", async () => {
    const replay = await replayPromise;
    const nineFives = replay.canonicalById.get(
      replay.auditByPhysicalId.get("7483487916195729409").canonicalRowId
    );
    const enjamb = replay.canonicalById.get(
      replay.auditByPhysicalId.get("7450398541010616320").canonicalRowId
    );
    const callabFounder = replay.canonicalById.get(
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
});

async function replayUnresolvedAuthorAudit() {
  const [audit, canonical, catalogs] = await Promise.all([
    readJson(auditPath),
    readJson(canonicalPath),
    loadAutonomousCatalogs(root)
  ]);
  const canonicalById = new Map(
    [...(canonical.evidence ?? []), ...(canonical.needsReview ?? [])]
      .map((row) => [row.id, row])
  );
  const auditRecords = audit.records.filter((record) => record.action === "review");
  assert.equal(auditRecords.length, 105);
  const rows = auditRecords.map((record) => {
    const canonicalRow = canonicalById.get(record.canonicalRowId);
    assert(canonicalRow, `Missing canonical fixture ${record.canonicalRowId}`);
    return {
      ...canonicalRow,
      batchSlug: record.currentAttribution.batchSlug,
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
    canonicalById,
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
