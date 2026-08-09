import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  PUBLIC_EVIDENCE_ARTIFACT_MAX_BYTES,
  PUBLIC_EVIDENCE_OPERATIONAL_KEYS,
  PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES,
  PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH,
  PUBLIC_EVIDENCE_REVIEW_KEYS,
  PUBLIC_EVIDENCE_REVIEW_LEDGER_MAX_BYTES,
  PUBLIC_EVIDENCE_REVIEW_LEDGER_PATH,
  assertPublicEvidenceArtifactSize,
  assertPublicEvidenceOperationalLedgerSize,
  assertPublicEvidenceReviewLedgerSize,
  buildPublicEvidenceArtifactPair,
  hydratePublicEvidenceArtifact,
  readPublicEvidenceArtifact,
  writePublicEvidenceCanonicalArtifactAtomic,
  writePublicEvidenceArtifactPairAtomic
} from "../scripts/lib/public-evidence-artifact.mjs";

describe("public evidence operational ledger split", () => {
  it("round-trips every operational row and produces deterministic bounded artifacts", () => {
    const fixture = publicEvidenceFixture();
    const first = buildPublicEvidenceArtifactPair(fixture);
    const second = buildPublicEvidenceArtifactPair(structuredClone(fixture));

    assert.equal(first.canonicalBody, second.canonicalBody);
    assert.equal(first.ledgerBody, second.ledgerBody);
    assert.equal(first.reviewLedgerBody, second.reviewLedgerBody);
    assert.ok(Buffer.byteLength(first.canonicalBody) < PUBLIC_EVIDENCE_ARTIFACT_MAX_BYTES);
    assert.ok(Buffer.byteLength(first.ledgerBody) < PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES);
    assert.ok(Buffer.byteLength(first.reviewLedgerBody) < PUBLIC_EVIDENCE_REVIEW_LEDGER_MAX_BYTES);
    assert.equal(first.reference.path, PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH);
    assert.deepEqual(first.reference.counts, {
      failures: 2,
      attempts: 2,
      discoveryAttempts: 2,
      sourceDiscoveryPaths: 2
    });
    assert.equal(first.reviewReference.path, PUBLIC_EVIDENCE_REVIEW_LEDGER_PATH);
    assert.deepEqual(first.reviewReference.counts, {
      attributionReconciliationLedger: 1,
      needsReview: 1
    });
    for (const key of PUBLIC_EVIDENCE_OPERATIONAL_KEYS) {
      assert.equal(Object.hasOwn(first.canonical, key), false, key);
    }
    for (const key of PUBLIC_EVIDENCE_REVIEW_KEYS) {
      assert.equal(Object.hasOwn(first.canonical, key), false, key);
    }

    const hydrated = hydratePublicEvidenceArtifact(
      JSON.parse(first.canonicalBody),
      first.ledgerBody,
      { reviewLedgerSource: first.reviewLedgerBody }
    );
    assert.deepEqual(hydrated, fixture);
    for (const key of PUBLIC_EVIDENCE_OPERATIONAL_KEYS) {
      assert.deepEqual(hydrated[key], fixture[key], key);
    }
  });

  it("fails closed on a tampered hash, count, hybrid document, or unsafe path", () => {
    const pair = buildPublicEvidenceArtifactPair(publicEvidenceFixture());
    const canonical = JSON.parse(pair.canonicalBody);
    assert.throws(
      () => hydratePublicEvidenceArtifact(canonical, `${pair.ledgerBody} `, {
        reviewLedgerSource: pair.reviewLedgerBody
      }),
      /byte count mismatch|SHA-256 mismatch/
    );
    assert.throws(
      () => hydratePublicEvidenceArtifact({
        ...canonical,
        operationalLedgerRef: {
          ...canonical.operationalLedgerRef,
          counts: { ...canonical.operationalLedgerRef.counts, failures: 3 }
        }
      }, pair.ledgerBody, { reviewLedgerSource: pair.reviewLedgerBody }),
      /failures count mismatch/
    );
    assert.throws(
      () => hydratePublicEvidenceArtifact({ ...canonical, failures: [] }, pair.ledgerBody, {
        reviewLedgerSource: pair.reviewLedgerBody
      }),
      /must not embed failures/
    );
    assert.throws(
      () => hydratePublicEvidenceArtifact({
        ...canonical,
        operationalLedgerRef: {
          ...canonical.operationalLedgerRef,
          path: "../outside.json"
        }
      }, pair.ledgerBody, { reviewLedgerSource: pair.reviewLedgerBody }),
      /Unsafe public evidence operational ledger path/
    );
    assert.throws(
      () => hydratePublicEvidenceArtifact(canonical, pair.ledgerBody, {
        reviewLedgerSource: `${pair.reviewLedgerBody} `
      }),
      /review ledger byte count mismatch|review ledger SHA-256 mismatch/
    );
    assert.throws(
      () => hydratePublicEvidenceArtifact({
        ...canonical,
        reviewLedgerRef: {
          ...canonical.reviewLedgerRef,
          counts: { ...canonical.reviewLedgerRef.counts, needsReview: 2 }
        }
      }, pair.ledgerBody, { reviewLedgerSource: pair.reviewLedgerBody }),
      /needsReview count mismatch/
    );
    assert.throws(
      () => hydratePublicEvidenceArtifact({ ...canonical, needsReview: [] }, pair.ledgerBody, {
        reviewLedgerSource: pair.reviewLedgerBody
      }),
      /must not embed needsReview/
    );
    assert.throws(
      () => hydratePublicEvidenceArtifact({
        ...canonical,
        reviewLedgerRef: { ...canonical.reviewLedgerRef, path: "../review.json" }
      }, pair.ledgerBody, { reviewLedgerSource: pair.reviewLedgerBody }),
      /Unsafe public evidence review ledger path/
    );
    assert.throws(
      () => hydratePublicEvidenceArtifact({
        source: canonical.source,
        evidence: canonical.evidence,
        reviewLedgerRef: canonical.reviewLedgerRef
      }, null, { reviewLedgerSource: pair.reviewLedgerBody }),
      /review ledger reference requires an operational ledger reference/
    );
    assert.throws(
      () => buildPublicEvidenceArtifactPair(publicEvidenceFixture(), {
        ledgerRelativePath: "outputs/shared.json",
        reviewLedgerRelativePath: "./outputs/shared.json"
      }),
      /must use different paths/
    );
    const malformedReview = `${JSON.stringify({
      ...pair.reviewLedger,
      schemaVersion: "wrong.version"
    })}\n`;
    const malformedCanonical = {
      ...canonical,
      reviewLedgerRef: {
        ...canonical.reviewLedgerRef,
        sha256: sha256(malformedReview),
        bytes: Buffer.byteLength(malformedReview)
      }
    };
    assert.throws(
      () => hydratePublicEvidenceArtifact(malformedCanonical, pair.ledgerBody, {
        reviewLedgerSource: malformedReview
      }),
      /Unsupported public evidence review ledger version/
    );
  });

  it("hydrates the previous two-file format before rebuilding all three files", () => {
    const fixture = publicEvidenceFixture();
    const pair = buildPublicEvidenceArtifactPair(fixture);
    const previousCanonical = {
      ...pair.canonical,
      attributionReconciliationLedger: fixture.attributionReconciliationLedger,
      needsReview: fixture.needsReview
    };
    delete previousCanonical.reviewLedgerRef;
    const hydrated = hydratePublicEvidenceArtifact(previousCanonical, pair.ledgerBody);
    assert.deepEqual(hydrated, fixture);
    const rebuilt = buildPublicEvidenceArtifactPair(hydrated);
    assert.deepEqual(
      hydratePublicEvidenceArtifact(rebuilt.canonical, rebuilt.ledgerBody, {
        reviewLedgerSource: rebuilt.reviewLedgerBody
      }),
      fixture
    );
  });

  it("guards both artifacts strictly below their configured limits", () => {
    assert.equal(assertPublicEvidenceArtifactSize("123", { maxBytes: 4 }), 3);
    assert.equal(assertPublicEvidenceOperationalLedgerSize("123", { maxBytes: 4 }), 3);
    assert.equal(assertPublicEvidenceReviewLedgerSize("123", { maxBytes: 4 }), 3);
    assert.throws(
      () => assertPublicEvidenceArtifactSize("1234", { maxBytes: 4 }),
      /must remain below 4 bytes/
    );
    assert.throws(
      () => assertPublicEvidenceOperationalLedgerSize("1234", { maxBytes: 4 }),
      /must remain below 4 bytes/
    );
    assert.throws(
      () => assertPublicEvidenceReviewLedgerSize("1234", { maxBytes: 4 }),
      /must remain below 4 bytes/
    );
  });

  it("atomically publishes and hash-verifies the pair", async () => {
    await withTemporaryRoot(async ({ root, canonicalPath }) => {
      const fixture = publicEvidenceFixture();
      const legacyBody = `${JSON.stringify(fixture)}\n`;
      await writeFile(canonicalPath, legacyBody);
      const result = await writePublicEvidenceArtifactPairAtomic({
        rootDir: root,
        canonicalPath,
        snapshot: fixture,
        expectedCanonicalSha256: sha256(legacyBody),
        expectedLedgerSha256: null,
        expectedReviewLedgerSha256: null
      });
      const loaded = await readPublicEvidenceArtifact(canonicalPath, { rootDir: root });
      assert.deepEqual(loaded.snapshot, fixture);
      assert.equal(loaded.canonicalSha256, result.canonicalSha256);
      assert.equal(loaded.ledgerSha256, result.ledgerSha256);
      assert.equal(loaded.reviewLedgerSha256, result.reviewLedgerSha256);
      assert.equal((await stat(canonicalPath)).size, Buffer.byteLength(result.canonicalBody));
      assert.equal((await stat(result.ledgerPath)).size, Buffer.byteLength(result.ledgerBody));
      assert.equal(
        (await stat(result.reviewLedgerPath)).size,
        Buffer.byteLength(result.reviewLedgerBody)
      );
    });
  });

  it("restores the old ledger if canonical publication throws", async () => {
    await withTemporaryRoot(async ({ root, canonicalPath, ledgerPath, reviewLedgerPath }) => {
      const original = publicEvidenceFixture();
      const originalPair = buildPublicEvidenceArtifactPair(original);
      await writeFile(canonicalPath, originalPair.canonicalBody);
      await writeFile(ledgerPath, originalPair.ledgerBody);
      await writeFile(reviewLedgerPath, originalPair.reviewLedgerBody);
      const updated = {
        ...original,
        failures: [...original.failures, { id: "failure-3", message: "new" }]
      };
      let renameCalls = 0;
      await assert.rejects(
        writePublicEvidenceArtifactPairAtomic({
          rootDir: root,
          canonicalPath,
          snapshot: updated,
          expectedCanonicalSha256: originalPair.canonicalSha256,
          expectedLedgerSha256: originalPair.ledgerSha256,
          expectedReviewLedgerSha256: originalPair.reviewLedgerSha256,
          renameImpl: async (source, destination) => {
            renameCalls += 1;
            if (renameCalls === 3) throw new Error("synthetic canonical rename failure");
            await rename(source, destination);
          }
        }),
        /synthetic canonical rename failure/
      );
      assert.equal(
        renameCalls,
        5,
        "two ledger publishes, canonical failure, and two ledger rollbacks"
      );
      assert.equal(await readFile(canonicalPath, "utf8"), originalPair.canonicalBody);
      assert.equal(await readFile(ledgerPath, "utf8"), originalPair.ledgerBody);
      assert.equal(
        await readFile(reviewLedgerPath, "utf8"),
        originalPair.reviewLedgerBody
      );
      assert.deepEqual(
        (await readPublicEvidenceArtifact(canonicalPath, { rootDir: root })).snapshot,
        original
      );
    });
  });

  it("restores the operational ledger if review-ledger publication throws", async () => {
    await withTemporaryRoot(async ({ root, canonicalPath, ledgerPath, reviewLedgerPath }) => {
      const original = publicEvidenceFixture();
      const originalPair = buildPublicEvidenceArtifactPair(original);
      await writeFile(canonicalPath, originalPair.canonicalBody);
      await writeFile(ledgerPath, originalPair.ledgerBody);
      await writeFile(reviewLedgerPath, originalPair.reviewLedgerBody);
      let renameCalls = 0;
      await assert.rejects(
        writePublicEvidenceArtifactPairAtomic({
          rootDir: root,
          canonicalPath,
          snapshot: { ...original, needsReview: [...original.needsReview, { id: "review-2" }] },
          expectedCanonicalSha256: originalPair.canonicalSha256,
          expectedLedgerSha256: originalPair.ledgerSha256,
          expectedReviewLedgerSha256: originalPair.reviewLedgerSha256,
          renameImpl: async (source, destination) => {
            renameCalls += 1;
            if (renameCalls === 2) throw new Error("synthetic review rename failure");
            await rename(source, destination);
          }
        }),
        /synthetic review rename failure/
      );
      assert.equal(renameCalls, 3, "operational publish, review failure, operational rollback");
      assert.equal(await readFile(canonicalPath, "utf8"), originalPair.canonicalBody);
      assert.equal(await readFile(ledgerPath, "utf8"), originalPair.ledgerBody);
      assert.equal(await readFile(reviewLedgerPath, "utf8"), originalPair.reviewLedgerBody);
    });
  });

  it("atomically updates canonical evidence without rewriting the verified ledger", async () => {
    await withTemporaryRoot(async ({ root, canonicalPath, ledgerPath, reviewLedgerPath }) => {
      const original = publicEvidenceFixture();
      const originalPair = buildPublicEvidenceArtifactPair(original);
      await writeFile(canonicalPath, originalPair.canonicalBody);
      await writeFile(ledgerPath, originalPair.ledgerBody);
      await writeFile(reviewLedgerPath, originalPair.reviewLedgerBody);
      const canonical = JSON.parse(originalPair.canonicalBody);
      canonical.evidence[0].thumbnailUrl = "https://images.example/evidence-1.png";
      canonical.evidence[0].thumbnailSource = "link-preview-og-image";
      const ledgerBefore = await readFile(ledgerPath);
      const reviewLedgerBefore = await readFile(reviewLedgerPath);
      const renameDestinations = [];

      const result = await writePublicEvidenceCanonicalArtifactAtomic({
        rootDir: root,
        canonicalPath,
        canonical,
        expectedCanonicalSha256: originalPair.canonicalSha256,
        expectedLedgerSha256: originalPair.ledgerSha256,
        expectedReviewLedgerSha256: originalPair.reviewLedgerSha256,
        renameImpl: async (source, destination) => {
          renameDestinations.push(destination);
          await rename(source, destination);
        }
      });

      assert.deepEqual(renameDestinations, [canonicalPath]);
      assert.deepEqual(await readFile(ledgerPath), ledgerBefore);
      assert.deepEqual(await readFile(reviewLedgerPath), reviewLedgerBefore);
      assert.equal(result.ledgerSha256, originalPair.ledgerSha256);
      assert.equal(result.reviewLedgerSha256, originalPair.reviewLedgerSha256);
      const loaded = await readPublicEvidenceArtifact(canonicalPath, { rootDir: root });
      assert.equal(
        loaded.canonical.evidence[0].thumbnailUrl,
        "https://images.example/evidence-1.png"
      );
      assert.deepEqual(loaded.snapshot.failures, original.failures);
      assert.deepEqual(loaded.snapshot.attempts, original.attempts);
      assert.deepEqual(loaded.snapshot.needsReview, original.needsReview);
    });
  });

  it("refuses a concurrent ledger change and leaves the canonical checkpoint untouched", async () => {
    await withTemporaryRoot(async ({ root, canonicalPath, ledgerPath, reviewLedgerPath }) => {
      const original = publicEvidenceFixture();
      const originalPair = buildPublicEvidenceArtifactPair(original);
      await writeFile(canonicalPath, originalPair.canonicalBody);
      await writeFile(ledgerPath, originalPair.ledgerBody);
      await writeFile(reviewLedgerPath, originalPair.reviewLedgerBody);
      const canonical = JSON.parse(originalPair.canonicalBody);
      canonical.evidence[0].thumbnailUrl = "https://images.example/stale-writer.png";
      const concurrentLedger = Buffer.from(
        originalPair.ledgerBody.replace("timed out", "concurrent update")
      );
      let injectedConcurrentWrite = false;

      await assert.rejects(
        writePublicEvidenceCanonicalArtifactAtomic({
          rootDir: root,
          canonicalPath,
          canonical,
          expectedCanonicalSha256: originalPair.canonicalSha256,
          expectedLedgerSha256: originalPair.ledgerSha256,
          expectedReviewLedgerSha256: originalPair.reviewLedgerSha256,
          writeFileImpl: async (destination, body, options) => {
            await writeFile(destination, body, options);
            if (!injectedConcurrentWrite) {
              injectedConcurrentWrite = true;
              await writeFile(ledgerPath, concurrentLedger);
            }
          }
        }),
        /operational ledger changed during .*refusing to overwrite concurrent work/
      );

      assert.equal(await readFile(canonicalPath, "utf8"), originalPair.canonicalBody);
      assert.deepEqual(await readFile(ledgerPath), concurrentLedger);
    });
  });

  it("refuses a concurrent review-ledger change during canonical-only publication", async () => {
    await withTemporaryRoot(async ({ root, canonicalPath, ledgerPath, reviewLedgerPath }) => {
      const original = publicEvidenceFixture();
      const originalPair = buildPublicEvidenceArtifactPair(original);
      await writeFile(canonicalPath, originalPair.canonicalBody);
      await writeFile(ledgerPath, originalPair.ledgerBody);
      await writeFile(reviewLedgerPath, originalPair.reviewLedgerBody);
      const canonical = JSON.parse(originalPair.canonicalBody);
      canonical.evidence[0].thumbnailUrl = "https://images.example/stale-review-writer.png";
      const concurrentReviewLedger = Buffer.from(
        originalPair.reviewLedgerBody.replace("review-1", "review-x")
      );
      let injectedConcurrentWrite = false;

      await assert.rejects(
        writePublicEvidenceCanonicalArtifactAtomic({
          rootDir: root,
          canonicalPath,
          canonical,
          expectedCanonicalSha256: originalPair.canonicalSha256,
          expectedLedgerSha256: originalPair.ledgerSha256,
          expectedReviewLedgerSha256: originalPair.reviewLedgerSha256,
          writeFileImpl: async (destination, body, options) => {
            await writeFile(destination, body, options);
            if (!injectedConcurrentWrite) {
              injectedConcurrentWrite = true;
              await writeFile(reviewLedgerPath, concurrentReviewLedger);
            }
          }
        }),
        /review ledger changed during .*refusing to overwrite concurrent work/
      );

      assert.equal(await readFile(canonicalPath, "utf8"), originalPair.canonicalBody);
      assert.deepEqual(await readFile(reviewLedgerPath), concurrentReviewLedger);
    });
  });

  it("refuses stale canonical checkpoints before publishing", async () => {
    await withTemporaryRoot(async ({ root, canonicalPath, ledgerPath, reviewLedgerPath }) => {
      const original = publicEvidenceFixture();
      const originalPair = buildPublicEvidenceArtifactPair(original);
      await writeFile(canonicalPath, originalPair.canonicalBody);
      await writeFile(ledgerPath, originalPair.ledgerBody);
      await writeFile(reviewLedgerPath, originalPair.reviewLedgerBody);
      const staleCanonical = JSON.parse(originalPair.canonicalBody);
      staleCanonical.evidence[0].thumbnailUrl = "https://images.example/stale.png";
      const concurrentCanonical = JSON.parse(originalPair.canonicalBody);
      concurrentCanonical.evidence[0].thumbnailUrl = "https://images.example/concurrent.png";
      const concurrentBody = serializeCanonicalFixture(concurrentCanonical);
      await writeFile(canonicalPath, concurrentBody);

      await assert.rejects(
        writePublicEvidenceCanonicalArtifactAtomic({
          rootDir: root,
          canonicalPath,
          canonical: staleCanonical,
          expectedCanonicalSha256: originalPair.canonicalSha256,
          expectedLedgerSha256: originalPair.ledgerSha256,
          expectedReviewLedgerSha256: originalPair.reviewLedgerSha256
        }),
        /Canonical public evidence artifact changed before publication/
      );

      assert.equal(await readFile(canonicalPath, "utf8"), concurrentBody);
      assert.equal(await readFile(ledgerPath, "utf8"), originalPair.ledgerBody);
    });
  });

  it("keeps the checked-in artifact pair reproducible and fully hydratable", async () => {
    const root = process.cwd();
    const canonicalPath = join(root, "src/lib/social/public-evidence-current.json");
    const loaded = await readPublicEvidenceArtifact(canonicalPath, { rootDir: root });
    assert.equal(loaded.split, true);
    assert.equal(loaded.fullySplit, true);
    const rebuilt = buildPublicEvidenceArtifactPair(loaded.snapshot);
    assert.equal(rebuilt.canonicalBody, loaded.canonicalBytes.toString("utf8"));
    assert.equal(rebuilt.ledgerBody, loaded.ledgerBytes.toString("utf8"));
    assert.equal(
      rebuilt.reviewLedgerBody,
      loaded.reviewLedgerBytes.toString("utf8")
    );
    assert.ok(loaded.canonicalBytes.length < PUBLIC_EVIDENCE_ARTIFACT_MAX_BYTES);
    assert.ok(loaded.ledgerBytes.length < PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES);
    assert.ok(
      loaded.reviewLedgerBytes.length < PUBLIC_EVIDENCE_REVIEW_LEDGER_MAX_BYTES
    );
    for (const key of PUBLIC_EVIDENCE_OPERATIONAL_KEYS) {
      assert.equal(Object.hasOwn(loaded.canonical, key), false, key);
      assert.equal(
        loaded.reference.counts[key],
        key === "attempts"
          ? Object.keys(loaded.snapshot.attempts).length
          : loaded.snapshot[key].length,
        key
      );
    }
    for (const key of PUBLIC_EVIDENCE_REVIEW_KEYS) {
      assert.equal(Object.hasOwn(loaded.canonical, key), false, key);
      assert.equal(loaded.reviewReference.counts[key], loaded.snapshot[key].length, key);
    }
  });
});

function publicEvidenceFixture() {
  return {
    source: { label: "fixture", fetchedAt: "2026-08-02T12:00:00.000Z" },
    evidence: [{ id: "evidence-1", text: "keep exact text", postedAt: "2026-08-01T00:00:00.000Z" }],
    attributionReconciliationLedger: [{ id: "reconciliation-1" }],
    needsReview: [{ id: "review-1", candidateUrl: "https://example.com/review" }],
    failures: [
      { id: "failure-1", message: "blocked", checkedAt: "2026-08-02T12:01:00.000Z" },
      { id: "failure-2", message: "timed out", checkedAt: "2026-08-02T12:02:00.000Z" }
    ],
    attempts: {
      "S26:x:one": { status: "done", checkedAt: "2026-08-02T12:03:00.000Z" },
      "S26:x:two": { status: "failed", checkedAt: "2026-08-02T12:04:00.000Z" }
    },
    discoveryAttempts: [
      { id: "discovery-1", query: "one" },
      { id: "discovery-2", query: "two" }
    ],
    sourceDiscoveryPaths: [
      { id: "path-1", source_url: "https://example.com/one" },
      { id: "path-2", source_url: "https://example.com/two" }
    ]
  };
}

async function withTemporaryRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "public-evidence-ledger-"));
  const canonicalPath = join(root, "src/lib/social/public-evidence-current.json");
  const ledgerPath = join(root, PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH);
  const reviewLedgerPath = join(root, PUBLIC_EVIDENCE_REVIEW_LEDGER_PATH);
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([
    mkdir(join(root, "src/lib/social"), { recursive: true }),
    mkdir(join(root, "outputs"), { recursive: true })
  ]));
  try {
    await run({ root, canonicalPath, ledgerPath, reviewLedgerPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function serializeCanonicalFixture(value) {
  return `${JSON.stringify(value)}\n`;
}
