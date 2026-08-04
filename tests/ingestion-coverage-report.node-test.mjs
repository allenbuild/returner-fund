import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  INGESTION_COVERAGE_REPORT_VERSION,
  buildIngestionCoverageReport,
  extractMaterializationProjection
} from "../scripts/lib/ingestion-coverage-report.mjs";
import {
  INGESTION_CORE_PLATFORMS
} from "../scripts/lib/ingestion-coverage-receipt.mjs";

const GENERATED_AT = "2026-08-03T03:10:00.000Z";
const CUTOFF_AT = "2026-05-05T03:10:00.000Z";

describe("artifact-bound ingestion coverage report", () => {
  it("projects measured batch/platform denominators without promoting incomplete work", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));

    const { report, markdown } = await buildReport(fixture);

    assert.equal(report.schemaVersion, INGESTION_COVERAGE_REPORT_VERSION);
    assert.equal(report.objectiveComplete, false);
    assert.equal(report.productionReleaseStatus.complete, false);
    assert.equal(report.fullIngestionCoverageStatus.complete, false);
    assert.equal(report.inventory.companies, 1);
    assert.equal(report.inventory.founders, 0);
    assert.equal(report.inventory.corePairs, 10);
    assert.equal(report.byPlatform.length, 10);
    assert.equal(report.byBatchPlatform.length, 10);
    assert.deepEqual(report.completionProofs.historical, {
      status: "generated_verified",
      coveredThrough: CUTOFF_AT,
      evaluated: 3,
      complete: 1,
      excluded: 2,
      completionPercent: 33.33,
      byBatch: {
        TEST: { evaluated: 3, complete: 1, excluded: 2, completionPercent: 33.33 }
      },
      byPlatform: {
        hacker_news: { evaluated: 1, complete: 1, excluded: 0, completionPercent: 100 },
        rss: { evaluated: 1, complete: 0, excluded: 1, completionPercent: 0 },
        web: { evaluated: 1, complete: 0, excluded: 1, completionPercent: 0 }
      },
      exclusionReasons: { source_not_exhausted: 2 }
    });
    assert.equal(report.completionProofs.recent.complete, 0);
    assert.equal(report.missingScopeProofs.recent.missing, 10);
    assert.match(markdown, /Production release \| INCOMPLETE/);
    assert.match(markdown, /Full ingestion coverage \| INCOMPLETE/);
    assert.match(markdown, /No completion is inferred/);
    assert.match(report.provenance.reportPayloadSha256, /^[a-f0-9]{64}$/);
  });

  it("fails closed when the streamed coverage receipt bytes are modified", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const body = await readFile(fixture.materializationPath, "utf8");
    await writeFile(fixture.materializationPath, body.replace("receipt-🚀", "receipt-🛰️"));

    await assert.rejects(buildReport(fixture), /Coverage receipt sha256 mismatch/);
  });

  it("fails closed on proof-byte, manifest-schema, and denominator drift", async (t) => {
    const proofTamper = await createFixture();
    const schemaTamper = await createFixture();
    const denominatorTamper = await createFixture();
    t.after(async () => {
      await Promise.all([proofTamper, schemaTamper, denominatorTamper].map((fixture) =>
        rm(fixture.root, { recursive: true, force: true })
      ));
    });

    await writeFile(proofTamper.historicalProofPath, "[]\n");
    await assert.rejects(buildReport(proofTamper), /historical completion proofs (bytes|sha256) mismatch/);

    const recentManifest = JSON.parse(await readFile(schemaTamper.recentManifestPath));
    recentManifest.schemaVersion = "recent-completion-proof-generator.v999";
    await writeFile(schemaTamper.recentManifestPath, JSON.stringify(recentManifest));
    await assert.rejects(buildReport(schemaTamper), /Recent manifest schemaVersion/);

    const historicalManifest = JSON.parse(
      await readFile(denominatorTamper.historicalManifestPath)
    );
    historicalManifest.denominator.targetsExcluded = 1;
    await writeFile(
      denominatorTamper.historicalManifestPath,
      JSON.stringify(historicalManifest)
    );
    await assert.rejects(buildReport(denominatorTamper), /Historical proof denominator is inconsistent/);
  });

  it("binds the report to the campaign and rejects a modified campaign manifest", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const campaign = JSON.parse(await readFile(fixture.campaignPath));
    campaign.coverageGeneratedAt = "2026-08-03T03:10:00.001Z";
    await writeFile(fixture.campaignPath, JSON.stringify(campaign));

    await assert.rejects(buildReport(fixture), /Campaign manifest sha256 mismatch/);
  });

  it("hashes a large receipt with bounded capture and preserves astral Unicode bytes", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "coverage-report-stream-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const receipt = { marker: "🚀", payload: "x".repeat(2 * 1024 * 1024) };
    const receiptBody = JSON.stringify(receipt);
    const path = join(root, "materialization.json");
    await writeFile(path, JSON.stringify({
      schemaVersion: "ingestion-coverage-materialization.v1",
      runId: "stream-test",
      generatedAt: GENERATED_AT,
      coverageGeneratedAt: GENERATED_AT,
      objectiveComplete: false,
      productionReleaseStatus: {},
      fullIngestionCoverageStatus: {},
      coverageReceipt: receipt,
      provenance: {}
    }));

    const result = await extractMaterializationProjection(path, {
      maxCapturedValueBytes: 1024
    });
    assert.equal(result.valueSha256.coverageReceipt, sha256(receiptBody));
    assert.equal(result.valueBytes.coverageReceipt, Buffer.byteLength(receiptBody));
    assert.equal(result.values.runId, "stream-test");
  });
});

async function buildReport(fixture) {
  return buildIngestionCoverageReport({
    root: fixture.root,
    materializationPath: fixture.materializationPath,
    historicalManifestPath: fixture.historicalManifestPath,
    recentManifestPath: fixture.recentManifestPath,
    maxManifestBytes: 1024 * 1024,
    maxProofArtifactBytes: 1024 * 1024,
    maxCapturedMaterializationValueBytes: 1024 * 1024
  });
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "coverage-report-"));
  const campaignDir = join(root, "campaign");
  const historicalDir = join(root, "historical-proof");
  const recentDir = join(root, "recent-proof");
  await Promise.all([
    mkdir(join(campaignDir, "generated"), { recursive: true }),
    mkdir(historicalDir, { recursive: true }),
    mkdir(recentDir, { recursive: true })
  ]);

  const expectedCatalogManifest = {
    version: "ingestion-catalog-manifest.v1",
    batches: [{
      batchSlug: "TEST",
      sourcePath: "fixture.json",
      sourceVersion: "v1",
      sourceHash: "a".repeat(64),
      companies: 1,
      founders: 0,
      entities: 1
    }]
  };
  const expectedCatalogBody = JSON.stringify(expectedCatalogManifest);
  const expectedCatalogPath = join(campaignDir, "generated", "expected.json");
  await writeFile(expectedCatalogPath, expectedCatalogBody);

  const sourceJournalBody = "{}\n";
  const sourceJournalPath = join(root, "source.ndjson");
  await writeFile(sourceJournalPath, sourceJournalBody);
  const historicalProofs = [{
    proofVersion: "historical-completion-proof.v1",
    targetKey: "TEST:company:hacker_news",
    status: "complete",
    artifactSha256: sha256(sourceJournalBody),
    terminalSequence: 1,
    runCompletedSequence: 2,
    checkedAt: GENERATED_AT,
    coveredThrough: CUTOFF_AT,
    receiptId: `historical-${"b".repeat(40)}`,
    technicalLimit: "All public results were exhausted.",
    reason: "The source was exhausted."
  }];
  const historicalProofBody = JSON.stringify(historicalProofs);
  const historicalProofPath = join(historicalDir, "completion-proofs.json");
  await writeFile(historicalProofPath, historicalProofBody);
  const historicalExclusions = { generatedAt: GENERATED_AT, rows: [{}, {}] };
  const historicalExclusionBody = JSON.stringify(historicalExclusions);
  await writeFile(join(historicalDir, "completion-exclusions.json"), historicalExclusionBody);
  const historicalManifest = {
    schemaVersion: "historical-completion-proof-generator.v1",
    status: "generated_verified",
    generatedAt: GENERATED_AT,
    recencyCutoffAt: CUTOFF_AT,
    sourceArtifact: {
      path: "source.ndjson",
      sha256: sha256(sourceJournalBody),
      bytes: Buffer.byteLength(sourceJournalBody)
    },
    denominator: {
      targetsEvaluated: 3,
      targetsCompletionEligible: 1,
      targetsExcluded: 2
    },
    artifacts: {
      completionProofs: descriptor(
        "completion-proofs.json",
        historicalProofBody,
        1
      ),
      completionExclusions: descriptor(
        "completion-exclusions.json",
        historicalExclusionBody,
        2
      )
    },
    summary: {
      byBatch: {
        TEST: { evaluated: 3, completionEligible: 1, excluded: 2 }
      },
      byPlatform: {
        hacker_news: { evaluated: 1, completionEligible: 1, excluded: 0 },
        rss: { evaluated: 1, completionEligible: 0, excluded: 1 },
        web: { evaluated: 1, completionEligible: 0, excluded: 1 }
      },
      exclusionReasons: { source_not_exhausted: 2 }
    }
  };
  const historicalManifestPath = join(historicalDir, "completion-proof-manifest.json");
  await writeFile(historicalManifestPath, JSON.stringify(historicalManifest));

  const campaign = {
    schemaVersion: "ingestion-coverage-campaign.v1",
    runId: "fixture-run",
    coverageGeneratedAt: GENERATED_AT,
    artifacts: {
      expectedCatalogManifest: {
        path: "generated/expected.json",
        sha256: sha256(expectedCatalogBody)
      },
      historicalBackfills: [{
        journal: { path: "historical/pages.ndjson", sha256: sha256(sourceJournalBody) },
        completionProofs: {
          path: "historical/completion-proofs.json",
          sha256: sha256(historicalProofBody)
        }
      }]
    }
  };
  const campaignBody = JSON.stringify(campaign);
  const campaignPath = join(campaignDir, "campaign.json");
  await writeFile(campaignPath, campaignBody);

  const recentProofBody = "[]";
  await writeFile(join(recentDir, "recent-completion-proofs.json"), recentProofBody);
  const byPlatform = Object.fromEntries(INGESTION_CORE_PLATFORMS.map((platform) => [
    platform,
    {
      canonicalPairs: 1,
      completionEligiblePairs: 0,
      excludedPairs: 1
    }
  ]));
  const recentManifest = {
    schemaVersion: "recent-completion-proof-generator.v1",
    status: "no_qualifying_pairs",
    generatedAt: GENERATED_AT,
    window: { coveredFrom: CUTOFF_AT, coveredThrough: GENERATED_AT },
    sourceCampaign: {
      path: "campaign/campaign.json",
      sha256: sha256(campaignBody)
    },
    denominator: {
      canonicalCorePairs: 10,
      collectorAttemptRows: 0,
      pairsWithNativeAttempts: 0,
      pairsWithoutNativeAttempts: 10,
      completionEligiblePairs: 0,
      excludedPairs: 10
    },
    artifacts: null,
    summary: {
      byBatch: {
        TEST: { canonicalPairs: 10, completionEligiblePairs: 0, excludedPairs: 10 }
      },
      byPlatform,
      exclusionReasons: { no_native_collector_attempt: 10 }
    },
    contractChangesRequired: [
      "Emit immutable native-window proof receipts for every core pair attempt."
    ],
    packagingDecision: "No recent completion receipts were generated."
  };
  const recentExclusions = {
    schemaVersion: recentManifest.schemaVersion,
    campaignSha256: recentManifest.sourceCampaign.sha256,
    coveredFrom: recentManifest.window.coveredFrom,
    coveredThrough: recentManifest.window.coveredThrough,
    rows: Array.from({ length: 10 }, () => ({}))
  };
  const recentExclusionBody = JSON.stringify(recentExclusions);
  await writeFile(
    join(recentDir, "recent-completion-exclusions.json"),
    recentExclusionBody
  );
  recentManifest.artifacts = {
      recentCompletionProofs: descriptor(
        "recent-completion-proofs.json",
        recentProofBody,
        0
      ),
      recentCompletionExclusions: descriptor(
        "recent-completion-exclusions.json",
        recentExclusionBody,
        10
      )
  };
  const recentManifestPath = join(recentDir, "recent-completion-proof-manifest.json");
  await writeFile(recentManifestPath, JSON.stringify(recentManifest));

  const fullStatus = buildFullStatus(expectedCatalogManifest);
  const productionStatus = {
    status: "incomplete",
    complete: false,
    requiredReceiptCount: 4,
    verifiedReceiptCount: 0,
    receipts: {},
    blockers: ["No production deployment receipt was supplied."],
    nextActions: ["Provide a fresh production deployment proof receipt."]
  };
  const coverageReceipt = { schemaVersion: "ingestion-coverage.v1", marker: "receipt-🚀" };
  const coverageReceiptSha256 = sha256(JSON.stringify(coverageReceipt));
  const provenance = {
    adapter: {},
    historicalAdapters: [],
    historicalDepthAdapters: [],
    crossLayerDuplicateReviews: [],
    inputArtifacts: [],
    expectedCatalogManifestSha256: sha256Stable(expectedCatalogManifest),
    coverageReceiptSha256,
    materializationManifestSha256: null,
    hashAlgorithm: "sha256",
    hashSerialization: "stable-json.v1"
  };
  const materializationBase = {
    schemaVersion: "ingestion-coverage-materialization.v1",
    runId: "fixture-run",
    generatedAt: GENERATED_AT,
    coverageGeneratedAt: GENERATED_AT,
    objectiveComplete: false,
    productionReleaseStatus: productionStatus,
    fullIngestionCoverageStatus: fullStatus
  };
  provenance.materializationManifestSha256 = sha256Stable({
    ...materializationBase,
    coverageReceiptSha256,
    expectedCatalogManifestSha256: provenance.expectedCatalogManifestSha256,
    inputArtifacts: provenance.inputArtifacts,
    adapterProvenance: provenance.adapter,
    historicalAdapterProvenance: provenance.historicalAdapters,
    historicalDepthAdapterProvenance: provenance.historicalDepthAdapters,
    crossLayerDuplicateReviews: provenance.crossLayerDuplicateReviews
  });
  const materialization = {
    ...materializationBase,
    coverageReceipt,
    provenance
  };
  const materializationPath = join(root, "coverage-materialization.json");
  await writeFile(materializationPath, JSON.stringify(materialization));

  return {
    root,
    campaignPath,
    materializationPath,
    historicalManifestPath,
    historicalProofPath,
    recentManifestPath
  };
}

function buildFullStatus(expectedCatalogManifest) {
  const global = coverageGroup({ pairs: 10, historical: 1 });
  const platformGroups = Object.fromEntries(INGESTION_CORE_PLATFORMS.map((platform) => [
    platform,
    coverageGroup({ pairs: 1, historical: platform === "hacker_news" ? 1 : 0 })
  ]));
  const batchPlatform = Object.fromEntries(INGESTION_CORE_PLATFORMS.map((platform) => [
    `TEST:${platform}`,
    {
      batchSlug: "TEST",
      platform,
      ...coverageGroup({ pairs: 1, historical: platform === "hacker_news" ? 1 : 0 })
    }
  ]));
  return {
    status: "incomplete",
    objectiveComplete: false,
    coverageMatrixResolved: true,
    denominator: {
      companies: 1,
      founders: 0,
      entities: 1,
      corePlatforms: 10,
      extendedOnlyPlatforms: 3,
      corePairs: 10,
      allPairs: 13
    },
    evaluated: global.evaluated,
    terminalStatusBuckets: global.terminalStatusBuckets,
    mapping: global.mapping,
    profiles: global.profiles,
    scope: global.scope,
    posts: {
      ...global.posts,
      physicalPosts: 0,
      physicalRecentPosts: 0,
      physicalHistoricalPosts: 0,
      allMatrixPhysicalPosts: 0,
      allMatrixPhysicalRecentPosts: 0,
      allMatrixPhysicalHistoricalPosts: 0,
      allMatrixStoredUnpublishedPosts: 0
    },
    unresolved: {
      pairs: 0,
      documentedBlockerPairs: 10,
      previewLimit: 0,
      previewTruncated: false,
      preview: [],
      documentedBlockerPreview: [],
      completeRecordsPath: "coverageReceipt.pairs"
    },
    byBatch: { TEST: coverageGroup({ pairs: 10, historical: 1 }) },
    byPlatform: platformGroups,
    byBatchPlatform: batchPlatform,
    expectedCatalogManifest,
    definitions: {
      evaluatedPair: "Every task has a dated attempt.",
      coverageMatrixResolved: "Every pair has a blocker or proof.",
      objectiveComplete: "Every scope proof exists."
    }
  };
}

function coverageGroup({ pairs, historical }) {
  return {
    denominator: { pairs, companies: 1, founders: 0, entities: 1 },
    evaluated: {
      pairs,
      companies: 1,
      founders: 0,
      entities: 1,
      resolvedCompanies: 1,
      resolvedFounders: 0,
      resolvedEntities: 1
    },
    terminalStatusBuckets: {
      collected: 0,
      verified_no_account: 0,
      blocked: 0,
      queued: pairs
    },
    mapping: {
      mappedPairs: 0,
      unmappedPairs: pairs,
      mappingCoveragePercent: 0,
      verifiedAccounts: 0
    },
    profiles: {
      mapped: 0,
      scraped: 0,
      scrapeCoveragePercent: 0,
      verifiedMapped: 0,
      verifiedScraped: 0,
      verifiedScrapeCoveragePercent: 0
    },
    posts: {
      attributedPosts: 0,
      recentPosts: 0,
      historicalPosts: 0,
      storedUnpublishedPosts: 0
    },
    scope: {
      recentBackfillCompletePairs: 0,
      historicalBackfillCompletePairs: historical,
      storedUnpublishedSurfacedPairs: pairs,
      schedulerCurrentPairs: 0,
      integrityVerifiedPairs: 0,
      objectiveCompletePairs: 0,
      matrixResolvedPairs: pairs,
      objectiveCoveragePercent: 0,
      matrixResolutionPercent: 100
    }
  };
}

function descriptor(path, body, rows) {
  return {
    path,
    bytes: Buffer.byteLength(body),
    sha256: sha256(body),
    rows
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Stable(value) {
  return sha256(stableJson(value));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}
