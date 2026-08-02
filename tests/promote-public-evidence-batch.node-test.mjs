import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  parsePromotionArgs,
  planPublicEvidenceBatchPromotion,
  promotePublicEvidenceBatch
} from "../scripts/promote-public-evidence-batch.mjs";

describe("public evidence batch promotion arguments", () => {
  it("parses the bounded Instagram contract and rejects unsafe variants", () => {
    assert.deepEqual(parsePromotionArgs([
      "--candidate=work/candidate.json",
      "--batch=s26",
      "--platform=Instagram",
      "--max-added=25",
      "--dry-run"
    ]), {
      candidate: "work/candidate.json",
      batch: "S26",
      platform: "instagram",
      maxAdded: 25,
      dryRun: true
    });
    assert.throws(
      () => parsePromotionArgs([
        "--candidate=x.json", "--batch=W26", "--platform=instagram", "--max-added=1"
      ]),
      /--batch must be one of/
    );
    assert.throws(
      () => parsePromotionArgs([
        "--candidate=x.json", "--batch=S26", "--platform=x", "--max-added=1"
      ]),
      /only instagram/
    );
    assert.throws(
      () => parsePromotionArgs([
        "--candidate=x.json", "--batch=S26", "--platform=instagram", "--max-added=1.5"
      ]),
      /non-negative integer/
    );
  });
});

describe("public evidence batch promotion planning", () => {
  it("appends only accepted evidence and reviews while preserving every ledger order", () => {
    const canonical = canonicalFixture();
    const evidence = acceptedInstagramEvidence();
    const review = candidateReview();
    const merged = mergedFixture(canonical, { evidence: [evidence], reviews: [review] });
    const plan = planPublicEvidenceBatchPromotion({
      canonical,
      merged,
      batch: "S26",
      platform: "instagram",
      maxAdded: 2
    });

    assert.equal(plan.status, "planned");
    assert.deepEqual(plan.promoted.evidence, [...canonical.evidence, evidence]);
    assert.deepEqual(plan.promoted.needsReview, [...canonical.needsReview, review]);
    for (const key of [
      "attributionReconciliationLedger",
      "failures",
      "attempts",
      "discoveryAttempts",
      "sourceDiscoveryPaths"
    ]) {
      assert.equal(JSON.stringify(plan.promoted[key]), JSON.stringify(canonical[key]), key);
    }
    assert.deepEqual(plan.promoted.source, {
      ...canonical.source,
      fetchedAt: merged.source.fetchedAt,
      evidenceCount: 2,
      needsReviewCount: 2,
      quarantinedEvidenceCount: 1,
      duplicateContentEvidenceCount: 0,
      duplicatePhysicalEvidenceCount: 0,
      attributionReconciliationCount: 1,
      failureCount: 1,
      discoveryAttemptCount: 1,
      sourceDiscoveryPathCount: 1,
      attemptCount: 1
    });
  });

  it("treats zero accepted additions as a true no-op even when merge produced a review", () => {
    const canonical = canonicalFixture();
    const merged = mergedFixture(canonical, { reviews: [candidateReview()] });
    const plan = planPublicEvidenceBatchPromotion({
      canonical,
      merged,
      batch: "S26",
      platform: "instagram",
      maxAdded: 1
    });

    assert.equal(plan.status, "no_op");
    assert.equal(plan.promoted, canonical);
    assert.deepEqual(plan.addedReviews, []);
  });

  it("preserves duplicate legacy canonical review ids and dedupes only new review ids", () => {
    const canonical = canonicalFixture();
    canonical.needsReview = [
      { id: "legacy-duplicate", platform: "x", observation: "first" },
      { id: "legacy-duplicate", platform: "linkedin", observation: "second" }
    ];
    const firstNewReview = candidateReview({ observation: "first-new" });
    const duplicateNewReview = candidateReview({ observation: "duplicate-new" });
    const merged = mergedFixture(canonical, {
      evidence: [acceptedInstagramEvidence()],
      reviews: [firstNewReview, duplicateNewReview]
    });

    const promotion = plan(canonical, merged, 2);
    assert.deepEqual(promotion.promoted.needsReview, [
      ...canonical.needsReview,
      firstNewReview
    ]);
    assert.deepEqual(promotion.addedReviews, [firstNewReview]);
    assert.equal(promotion.promoted.source.needsReviewCount, 3);
  });

  it("rejects removed canonical evidence, over-cap additions, and every unsafe row contract", () => {
    const canonical = canonicalFixture();
    assert.throws(
      () => plan(canonical, { ...mergedFixture(canonical), evidence: [] }, 1),
      /would remove 1 canonical evidence/
    );
    assert.throws(
      () => plan(canonical, mergedFixture(canonical, {
        evidence: [acceptedInstagramEvidence(), acceptedInstagramEvidence({ id: "second", platformPostId: "SECOND", sourceUrl: "https://instagram.com/p/SECOND" })]
      }), 1),
      /above --max-added=1/
    );
    assert.throws(
      () => plan(canonical, mergedFixture(canonical, {
        evidence: [acceptedInstagramEvidence()],
        reviews: [candidateReview(), candidateReview({ id: "second-review" })]
      }), 1),
      /add 2 review row.*above --max-added=1/
    );
    assert.throws(
      () => plan(canonical, mergedFixture(canonical, {
        evidence: [acceptedInstagramEvidence()],
        reviews: [candidateReview({ batchSlug: "S2026" })]
      }), 2),
      /must be scoped to S26\/instagram/
    );

    const unsafeRows = [
      [acceptedInstagramEvidence({ batchSlug: "S2026" }), /batch S2026/],
      [acceptedInstagramEvidence({ platform: "x" }), /platform x/],
      [acceptedInstagramEvidence({ sourceUrl: "https://instagram.com/example" }), /not an exact native/],
      [acceptedInstagramEvidence({ sourceUrl: "https://instagram.com/reel/OTHER", platformPostId: "POST_1" }), /not an exact native/],
      [acceptedInstagramEvidence({ contributionScore: 0 }), /positive contributionScore/],
      [acceptedInstagramEvidence({ review_state: "needs_review" }), /fully verified canonical attribution/],
      [acceptedInstagramEvidence({ attributionStatus: "needs_review" }), /fully verified canonical attribution/],
      [acceptedInstagramEvidence({ nativeAuthorResolution: { status: "ambiguous" } }), /fully verified canonical attribution/],
      [acceptedInstagramEvidence({ attributionSignals: [] }), /fully verified canonical attribution/]
    ];
    for (const [row, expected] of unsafeRows) {
      assert.throws(
        () => plan(canonical, mergedFixture(canonical, { evidence: [row] }), 1),
        expected
      );
    }
  });
});

describe("public evidence batch promotion publication", () => {
  it("uses the canonical merge inputs and atomically appends a bounded fixture promotion", async () => {
    await withPromotionFixture(async (fixture) => {
      const canonical = canonicalFixture();
      const added = acceptedInstagramEvidence();
      const review = candidateReview();
      await fixture.writeCanonical(canonical);
      await fixture.writeCandidate(candidateSnapshot());
      let renameCalls = 0;
      const receipt = await promotePublicEvidenceBatch(fixture.args(), fixture.dependencies({
        merged: mergedFixture(canonical, { evidence: [added], reviews: [review] }),
        renameImpl: async (source, destination) => {
          renameCalls += 1;
          await rename(source, destination);
        }
      }));

      assert.equal(receipt.status, "promoted");
      assert.equal(receipt.addedEvidence, 1);
      assert.equal(receipt.addedReviews, 1);
      assert.equal(renameCalls, 1);
      assert.equal(fixture.mergeCalls.length, 1);
      assert.equal(fixture.mergeCalls[0].snapshots.length, 2);
      assert.deepEqual(
        fixture.mergeCalls[0].options.contentIdentityReferenceRows.map((row) => row.id),
        ["reference-1", "reference-2", "reference-3"]
      );
      assert.equal(typeof fixture.mergeCalls[0].options.resolveBatchSlug, "function");
      assert.equal(typeof fixture.mergeCalls[0].options.resolveNativeAuthor, "function");

      const promoted = JSON.parse(await readFile(fixture.canonicalPath, "utf8"));
      assert.deepEqual(promoted.evidence, [...canonical.evidence, added]);
      assert.deepEqual(promoted.needsReview, [...canonical.needsReview, review]);
      assert.deepEqual(promoted.failures, canonical.failures);
      assert.deepEqual(promoted.attempts, canonical.attempts);
      assert.deepEqual(promoted.discoveryAttempts, canonical.discoveryAttempts);
      assert.deepEqual(promoted.sourceDiscoveryPaths, canonical.sourceDiscoveryPaths);
    });
  });

  it("leaves canonical bytes unchanged for dry-runs and zero-addition promotions", async () => {
    await withPromotionFixture(async (fixture) => {
      const canonical = canonicalFixture();
      await fixture.writeCanonical(canonical);
      await fixture.writeCandidate(candidateSnapshot());
      const before = await readFile(fixture.canonicalPath);
      const dryRun = await promotePublicEvidenceBatch(
        [...fixture.args(), "--dry-run"],
        fixture.dependencies({ merged: mergedFixture(canonical, { evidence: [acceptedInstagramEvidence()] }) })
      );
      assert.equal(dryRun.status, "dry_run");
      assert.deepEqual(await readFile(fixture.canonicalPath), before);

      const noOp = await promotePublicEvidenceBatch(
        fixture.args(),
        fixture.dependencies({ merged: mergedFixture(canonical, { reviews: [candidateReview()] }) })
      );
      assert.equal(noOp.status, "no_op");
      assert.deepEqual(await readFile(fixture.canonicalPath), before);
    });
  });

  it("hash-guards canonical immediately before publication", async () => {
    await withPromotionFixture(async (fixture) => {
      const canonical = canonicalFixture();
      const concurrent = { ...canonical, source: { ...canonical.source, label: "concurrent edit" } };
      await fixture.writeCanonical(canonical);
      await fixture.writeCandidate(candidateSnapshot());
      let canonicalReads = 0;
      const guardedRead = async (filePath, ...rest) => {
        if (path.resolve(filePath) === fixture.canonicalPath) {
          canonicalReads += 1;
          if (canonicalReads === 2) {
            await writeFile(fixture.canonicalPath, `${JSON.stringify(concurrent, null, 2)}\n`);
          }
        }
        return readFile(filePath, ...rest);
      };

      await assert.rejects(
        promotePublicEvidenceBatch(fixture.args(), fixture.dependencies({
          merged: mergedFixture(canonical, { evidence: [acceptedInstagramEvidence()] }),
          readFileImpl: guardedRead
        })),
        /Canonical evidence changed during promotion/
      );
      assert.deepEqual(
        JSON.parse(await readFile(fixture.canonicalPath, "utf8")),
        concurrent
      );
    });
  });
});

function plan(canonical, merged, maxAdded) {
  return planPublicEvidenceBatchPromotion({
    canonical,
    merged,
    batch: "S26",
    platform: "instagram",
    maxAdded
  });
}

function canonicalFixture() {
  return {
    source: {
      label: "canonical",
      fetchedAt: "2026-08-01T00:00:00.000Z",
      evidenceCount: 999,
      needsReviewCount: 999,
      quarantinedEvidenceCount: 0,
      duplicateContentEvidenceCount: 0,
      duplicatePhysicalEvidenceCount: 0
    },
    evidence: [{ id: "canonical-evidence", platform: "x" }],
    attributionReconciliationLedger: [{ z: 1, a: 2 }],
    needsReview: [{ id: "canonical-review", platform: "x" }],
    failures: [{ id: "failure-1", z: 1, a: 2 }],
    attempts: { "S26:attempt": { status: "done", checkedAt: "2026-08-01T00:00:00.000Z" } },
    discoveryAttempts: [{ id: "discovery-1", query: "one" }],
    sourceDiscoveryPaths: [{ id: "path-1", source_url: "https://example.com" }]
  };
}

function acceptedInstagramEvidence(overrides = {}) {
  return {
    id: "instagram-evidence",
    batchSlug: "S26",
    entityType: "company",
    entityId: "company-fixture",
    companySlug: "fixture",
    platform: "instagram",
    sourceUrl: "https://instagram.com/reel/POST_1",
    platformPostId: "POST_1",
    contributionScore: 42,
    review_state: "verified",
    attributionStatus: "verified",
    attributionMode: "account_owner",
    attributionSignals: ["mapped_official_account"],
    nativeAuthorResolution: {
      status: "matched",
      owner: {
        batchSlug: "S26",
        entityType: "company",
        entityId: "company-fixture",
        companySlug: "fixture"
      }
    },
    ...overrides
  };
}

function candidateReview(overrides = {}) {
  return {
    id: "instagram-review",
    batchSlug: "S26",
    platform: "instagram",
    review_state: "needs_review",
    quarantineReasons: ["candidate_context"],
    ...overrides
  };
}

function mergedFixture(canonical, { evidence = [], reviews = [] } = {}) {
  return {
    source: { fetchedAt: "2026-08-02T00:00:00.000Z" },
    evidence: [...canonical.evidence, ...evidence],
    needsReview: [...canonical.needsReview, ...reviews],
    attributionReconciliationLedger: [{ changed: true }],
    failures: [{ changed: true }],
    attempts: { changed: true },
    discoveryAttempts: [{ changed: true }],
    sourceDiscoveryPaths: [{ changed: true }]
  };
}

function candidateSnapshot() {
  return {
    source: { batchSlug: "S26", fetchedAt: "2026-08-02T00:00:00.000Z" },
    evidence: []
  };
}

async function withPromotionFixture(run) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "returner-promotion-test-"));
  const canonicalPath = path.join(rootDir, "canonical.json");
  const candidatePath = path.join(rootDir, "candidate.json");
  const referencePaths = [1, 2, 3].map((number) => path.join(rootDir, `reference-${number}.json`));
  await mkdir(rootDir, { recursive: true });
  await Promise.all(referencePaths.map((referencePath, index) =>
    writeFile(referencePath, JSON.stringify({ evidence: [{ id: `reference-${index + 1}` }] }))
  ));
  const mergeCalls = [];
  const output = [];
  const fixture = {
    rootDir,
    canonicalPath,
    candidatePath,
    mergeCalls,
    args: () => [
      `--candidate=${candidatePath}`,
      "--batch=S26",
      "--platform=instagram",
      "--max-added=2"
    ],
    writeCanonical: (value) => writeFile(canonicalPath, `${JSON.stringify(value, null, 2)}\n`),
    writeCandidate: (value) => writeFile(candidatePath, `${JSON.stringify(value, null, 2)}\n`),
    dependencies: ({ merged, mergeSnapshots, ...overrides } = {}) => ({
      rootDir,
      canonicalPath,
      referencePaths,
      loadCatalogs: async () => [{ slug: "S26", companies: [] }],
      buildBatchResolver: () => () => "S26",
      buildNativeAuthorResolver: () => () => ({ status: "matched" }),
      mergeSnapshots: mergeSnapshots ?? ((snapshots, options) => {
        mergeCalls.push({ snapshots, options });
        return merged;
      }),
      stdout: { write: (value) => output.push(value) },
      ...overrides
    })
  };

  try {
    await run(fixture);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}
