import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  INGESTION_COVERAGE_MATERIALIZATION_VERSION,
  INGESTION_PRODUCTION_RELEASE_PROOF_VERSION,
  materializeIngestionCoverage,
  mergeIngestionPairScopes,
  summarizeProductionRelease,
  writeIngestionCoverageMaterializationJson
} from "../scripts/lib/ingestion-coverage-materializer.mjs";
import {
  INGESTION_CATALOG_MANIFEST_VERSION,
  INGESTION_CORE_PLATFORMS
} from "../scripts/lib/ingestion-coverage-receipt.mjs";
import {
  normalizeAutonomousIngestionCatalogs
} from "../scripts/lib/ingestion-coverage-adapter.mjs";
import {
  runHistoricalBackfill
} from "../scripts/lib/historical-backfill.mjs";
import {
  runHistoricalDepthBackfill
} from "../scripts/lib/historical-depth-backfill.mjs";

const STARTED_AT = "2026-08-02T18:20:00.000Z";
const CHECKED_AT = "2026-08-02T18:29:00.000Z";
const COMPLETED_AT = "2026-08-02T18:30:00.000Z";
const GENERATED_AT = "2026-08-02T18:31:00.000Z";
const MATERIALIZED_AT = "2026-08-02T19:15:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function catalogs() {
  return [{
    slug: "TEST",
    sourcePath: "fixtures/test-catalog.json",
    generatedAt: "2026-08-02T18:00:00.000Z",
    companies: [{
      entityType: "company",
      sourceKey: "company-acme",
      name: "Acme",
      accounts: [{
        platform: "x",
        url: "https://x.com/acme",
        verificationStatus: "verified"
      }],
      founders: []
    }]
  }];
}

function manifestFor(sourceCatalogs) {
  const normalized = normalizeAutonomousIngestionCatalogs(sourceCatalogs);
  return {
    version: INGESTION_CATALOG_MANIFEST_VERSION,
    batches: normalized.map((catalog) => ({
      batchSlug: catalog.batchSlug,
      sourcePath: catalog.sourcePath,
      sourceVersion: catalog.sourceVersion,
      sourceHash: catalog.sourceHash,
      companies: catalog.companies.length,
      founders: 0,
      entities: catalog.companies.length
    }))
  };
}

function runnerLogs() {
  return [
    {
      eventType: "run.started",
      createdAt: STARTED_AT,
      severity: "info",
      message: "Autonomous ingestion run started.",
      payload: {}
    },
    {
      eventType: "run.completed",
      createdAt: COMPLETED_AT,
      severity: "info",
      message: "Autonomous ingestion run completed.",
      payload: {}
    }
  ];
}

function adapterInput() {
  const sourceCatalogs = catalogs();
  return {
    runId: "run-test",
    idempotencyKey: "idempotency-test",
    campaignKey: "campaign-test",
    generatedAt: GENERATED_AT,
    catalogs: sourceCatalogs,
    expectedCatalogManifest: manifestFor(sourceCatalogs),
    taskPlan: [{
      batchSlug: "TEST",
      companySourceKey: "company-acme",
      entityType: "company",
      entitySourceKey: "company-acme",
      platform: "x",
      account: {
        platform: "x",
        url: "https://x.com/acme",
        verificationStatus: "verified"
      },
      checkpointKey: "run:TEST:company:company-acme:x:account:https%3A%2F%2Fx.com%2Facme",
      status: "queued",
      terminalReason: null
    }],
    collectorArtifacts: [{
      kind: "public",
      artifact: {
        path: "public-test.json",
        sha256: HASH_A,
        observedAt: CHECKED_AT
      },
      snapshot: {
        source: { batchSlug: "TEST", fetchedAt: CHECKED_AT },
        attempts: {
          "x:company:company-acme:https://x.com/acme": {
            attemptKey: "x:company:company-acme:https://x.com/acme",
            batchSlug: "TEST",
            entityType: "company",
            entityId: "company-acme",
            platform: "x",
            accountUrl: "https://x.com/acme",
            status: "done",
            outcomeStatus: "completed",
            outcomeReason: "collector_evidence_collected",
            checkedAt: CHECKED_AT,
            retryable: false
          }
        },
        evidence: [{
          id: "x-company-acme-42",
          batchSlug: "TEST",
          entityType: "company",
          entityId: "company-acme",
          platform: "x",
          sourceUrl: "https://x.com/acme/status/42",
          platformPostId: "42",
          accountUrl: "https://x.com/acme",
          title: "Acme shipped a native update",
          text: "Acme shipped a native update with exact public evidence.",
          postedAt: "2026-08-02T18:00:00.000Z",
          last_checked_at: CHECKED_AT,
          review_state: "verified",
          metrics: { likes: 12 }
        }],
        needsReview: [],
        failures: []
      }
    }],
    runnerLogs: runnerLogs(),
    runnerLogArtifact: {
      path: "runner-events.ndjson",
      sha256: HASH_D,
      observedAt: GENERATED_AT
    },
    inputArtifacts: [{
      kind: "campaign_manifest",
      path: "campaign.json",
      sha256: HASH_B,
      observedAt: GENERATED_AT
    }]
  };
}

function releaseProof(kind, status, artifactDigest, overrides = {}) {
  return {
    schemaVersion: INGESTION_PRODUCTION_RELEASE_PROOF_VERSION,
    receiptId: `release-${kind}`,
    status,
    checkedAt: GENERATED_AT,
    artifactDigest,
    toolVersion: "coverage-materializer-test.v1",
    reason: `Fresh ${kind} proof was checked against the exact campaign artifact digest.`,
    ...overrides
  };
}

function productionSampleProof(
  artifactDigest,
  revision = "revision-42",
  checkedAt = GENERATED_AT
) {
  return releaseProof("productionSample", "verified", artifactDigest, {
    revision,
    checkedAt,
    samples: INGESTION_CORE_PLATFORMS.map((platform) => ({
      sampleId: `sample-TEST-${platform}`,
      batchSlug: "TEST",
      platform,
      pairKey: `TEST:company:company-acme:${platform}`,
      verified: true,
      checkedAt,
      reason: `Production rendered the expected ${platform} pair state for the TEST batch.`
    }))
  });
}

describe("ingestion coverage materializer", () => {
  it("merges historical proof into existing pair scope without weakening either source", () => {
    const identity = {
      batchSlug: "TEST",
      entityType: "company",
      entityId: "company-acme",
      platform: "web"
    };
    const recentBackfillReceipt = { receiptId: "recent-proof" };
    const historicalBackfillReceipt = { receiptId: "historical-proof" };
    const [merged] = mergeIngestionPairScopes(
      [{ ...identity, scope: { recentBackfillReceipt } }],
      [{ ...identity, scope: { historicalBackfillReceipt } }]
    );

    assert.deepEqual(merged, {
      ...identity,
      scope: { recentBackfillReceipt, historicalBackfillReceipt }
    });
    assert.throws(
      () => mergeIngestionPairScopes(
        [{ ...identity, scope: { historicalBackfillReceipt } }],
        [{ ...identity, scope: { historicalBackfillReceipt: { receiptId: "different" } } }]
      ),
      /conflicting historicalBackfillReceipt scope proofs/
    );
  });

  it("emits exact core denominators and stays fail-closed without proof receipts", async () => {
    const result = await materializeIngestionCoverage(adapterInput());

    assert.equal(result.schemaVersion, INGESTION_COVERAGE_MATERIALIZATION_VERSION);
    assert.equal(result.objectiveComplete, false);
    assert.equal(result.productionReleaseStatus.status, "incomplete");
    assert.equal(result.productionReleaseStatus.blockers.length, 4);
    assert.equal(result.fullIngestionCoverageStatus.status, "incomplete");
    assert.deepEqual(result.fullIngestionCoverageStatus.denominator, {
      companies: 1,
      founders: 0,
      entities: 1,
      corePlatforms: 10,
      extendedOnlyPlatforms: 3,
      corePairs: 10,
      allPairs: 13
    });
    assert.equal(result.fullIngestionCoverageStatus.terminalStatusBuckets.collected, 1);
    assert.equal(result.fullIngestionCoverageStatus.terminalStatusBuckets.queued, 9);
    assert.equal(result.fullIngestionCoverageStatus.mapping.verifiedAccounts, 1);
    assert.equal(result.fullIngestionCoverageStatus.posts.physicalPosts, 1);
    assert.equal(result.fullIngestionCoverageStatus.byPlatform.x.denominator.pairs, 1);
    assert.equal(result.fullIngestionCoverageStatus.byBatchPlatform["TEST:x"].posts.recentPosts, 1);
    assert.equal(result.fullIngestionCoverageStatus.extendedOnly.denominator.pairs, 3);
    assert.equal(result.provenance.inputArtifacts[0].sha256, HASH_B);
    assert.match(result.provenance.coverageReceiptSha256, /^[a-f0-9]{64}$/);
    assert.match(result.provenance.materializationManifestSha256, /^[a-f0-9]{64}$/);
  });

  it("preserves and reconciles stored-unpublished surfaced counts", async () => {
    const storedReceipt = {
      receiptId: "stored-unpublished-fixture",
      status: "complete",
      checkedAt: COMPLETED_AT,
      coveredThrough: COMPLETED_AT,
      reason:
        "Both named stored-unpublished ledgers were traversed and their attributed rows were reconciled.",
      surfacedCounts: {
        historicalEvidenceRows: 522,
        githubEvidenceAttributions: 3,
        githubBlockerReviews: 1,
        evidenceAttributions: 525,
        totalAttributedRows: 526,
        explicitZero: false
      },
      sourceProofSha256: HASH_C,
      publicationPolicy: "proof_only_no_publication",
      scoringEligible: false
    };
    const result = await materializeIngestionCoverage({
      ...adapterInput(),
      pairScopes: [{
        pairKey: "TEST:company:company-acme:x",
        batchSlug: "TEST",
        entityType: "company",
        entityId: "company-acme",
        platform: "x",
        scope: { storedUnpublishedReceipt: storedReceipt }
      }]
    });
    const xPair = result.coverageReceipt.pairs.find((pair) =>
      pair.pairKey === "TEST:company:company-acme:x"
    );
    assert.deepEqual(xPair.scope.receipts.storedUnpublished, storedReceipt);
    assert.equal(xPair.scope.storedUnpublishedSurfaced, true);

    await assert.rejects(
      materializeIngestionCoverage({
        ...adapterInput(),
        pairScopes: [{
          batchSlug: "TEST",
          entityType: "company",
          entityId: "company-acme",
          platform: "x",
          scope: {
            storedUnpublishedReceipt: {
              ...storedReceipt,
              surfacedCounts: {
                ...storedReceipt.surfacedCounts,
                totalAttributedRows: 525
              }
            }
          }
        }]
      }),
      /totalAttributedRows does not reconcile/
    );
  });

  it("verifies release status only when all explicit receipts reconcile", async () => {
    const first = await materializeIngestionCoverage(adapterInput());
    const artifactDigest = HASH_C;
    const releaseProofs = {
      expectedManifest: releaseProof(
        "expectedManifest",
        "verified",
        first.provenance.expectedCatalogManifestSha256,
        { checkedAt: MATERIALIZED_AT }
      ),
      productionArtifact: releaseProof("productionArtifact", "rebuilt", artifactDigest, {
        revision: "revision-42",
        checkedAt: MATERIALIZED_AT
      }),
      productionSample: productionSampleProof(
        artifactDigest,
        "revision-42",
        MATERIALIZED_AT
      ),
      deployment: releaseProof("deployment", "verified", artifactDigest, {
        revision: "revision-42",
        environment: "production",
        checkedAt: MATERIALIZED_AT
      })
    };
    const result = await materializeIngestionCoverage({
      ...adapterInput(),
      materializedAt: MATERIALIZED_AT,
      releaseProofs
    });

    assert.equal(result.productionReleaseStatus.status, "verified");
    assert.equal(result.productionReleaseStatus.complete, true);
    assert.equal(result.generatedAt, MATERIALIZED_AT);
    assert.equal(result.coverageGeneratedAt, GENERATED_AT);
    assert.equal(result.fullIngestionCoverageStatus.objectiveComplete, false);
    assert.equal(result.objectiveComplete, false);
  });

  it("rejects a self-consistent count when expected-manifest proof hashes the wrong bytes", async () => {
    const result = await materializeIngestionCoverage({
      ...adapterInput(),
      releaseProofs: {
        expectedManifest: releaseProof("expectedManifest", "verified", HASH_C),
        productionArtifact: releaseProof("productionArtifact", "rebuilt", HASH_A, {
          revision: "revision-42"
        }),
        productionSample: productionSampleProof(HASH_A),
        deployment: releaseProof("deployment", "verified", HASH_A, {
          revision: "revision-42",
          environment: "production"
        })
      }
    });

    assert.equal(result.productionReleaseStatus.complete, false);
    assert.match(result.productionReleaseStatus.blockers.join("\n"), /digest does not match/);
  });

  it("does not verify production from samples that omit a supported platform", async () => {
    const first = await materializeIngestionCoverage(adapterInput());
    const sample = productionSampleProof(HASH_A);
    sample.samples = sample.samples.filter((row) => row.platform !== "linkedin");
    const result = await materializeIngestionCoverage({
      ...adapterInput(),
      releaseProofs: {
        expectedManifest: releaseProof(
          "expectedManifest",
          "verified",
          first.provenance.expectedCatalogManifestSha256
        ),
        productionArtifact: releaseProof("productionArtifact", "rebuilt", HASH_A, {
          revision: "revision-42"
        }),
        productionSample: sample,
        deployment: releaseProof("deployment", "verified", HASH_A, {
          revision: "revision-42",
          environment: "production"
        })
      }
    });

    assert.equal(result.productionReleaseStatus.complete, false);
    assert.match(result.productionReleaseStatus.blockers.join("\n"), /missing batches \[\] and platforms \[linkedin\]/);
  });

  it("requires every expected batch-platform production sample combination", () => {
    const batches = ["ALPHA", "BETA", "GAMMA"];
    const pairFor = (batchSlug, platform) => ({
      batchSlug,
      platform,
      pairKey: `${batchSlug}:company:company-${batchSlug.toLowerCase()}:${platform}`
    });
    const coveragePairs = batches.flatMap((batchSlug) =>
      INGESTION_CORE_PLATFORMS.map((platform) => pairFor(batchSlug, platform))
    );
    const samples = coveragePairs
      .filter((pair) => !(pair.batchSlug === "BETA" && pair.platform === "linkedin"))
      .map((pair) => ({
        sampleId: `sample-${pair.batchSlug}-${pair.platform}`,
        batchSlug: pair.batchSlug,
        platform: pair.platform,
        pairKey: pair.pairKey,
        verified: true,
        checkedAt: GENERATED_AT,
        reason:
          `Production rendered the expected ${pair.batchSlug} ${pair.platform} pair state.`
      }));
    assert.deepEqual([...new Set(samples.map((sample) => sample.batchSlug))], batches);
    assert.deepEqual(
      [...new Set(samples.map((sample) => sample.platform))].sort(),
      [...INGESTION_CORE_PLATFORMS].sort(),
      "the old separate-union check would accept this deliberately incomplete matrix"
    );
    const releaseProofs = {
      expectedManifest: releaseProof("expectedManifest", "verified", HASH_A),
      productionArtifact: releaseProof("productionArtifact", "rebuilt", HASH_B, {
        revision: "revision-matrix"
      }),
      productionSample: releaseProof("productionSample", "verified", HASH_B, {
        revision: "revision-matrix",
        samples
      }),
      deployment: releaseProof("deployment", "verified", HASH_B, {
        revision: "revision-matrix",
        environment: "production"
      })
    };
    const summarize = (proofs) => summarizeProductionRelease({
      releaseProofs: proofs,
      expectedCatalogManifestSha256: HASH_A,
      expectedCatalogManifest: {
        batches: batches.map((batchSlug) => ({ batchSlug }))
      },
      coveragePairs,
      run: { startedAt: STARTED_AT, completedAt: COMPLETED_AT },
      generatedAt: GENERATED_AT
    });
    const incomplete = summarize(releaseProofs);
    assert.equal(incomplete.complete, false);
    assert.equal(incomplete.receipts.productionSample.valid, false);
    assert.match(
      incomplete.blockers.join("\n"),
      /missing batches \[\] and platforms \[\]; missing batch-platform combinations \[BETA:linkedin\]/
    );

    const complete = summarize({
      ...releaseProofs,
      productionSample: {
        ...releaseProofs.productionSample,
        samples: [...samples, {
          sampleId: "sample-BETA-linkedin",
          batchSlug: "BETA",
          platform: "linkedin",
          pairKey: pairFor("BETA", "linkedin").pairKey,
          verified: true,
          checkedAt: GENERATED_AT,
          reason: "Production rendered the expected BETA linkedin pair state."
        }]
      }
    });
    assert.equal(complete.status, "verified");
    assert.equal(complete.complete, true);
  });

  it("streams a parseable artifact and reports its exact serialized digest", async () => {
    const result = await materializeIngestionCoverage(adapterInput());
    let serialized = "";
    const writeResult = await writeIngestionCoverageMaterializationJson(result, {
      expectedCatalogManifest: adapterInput().expectedCatalogManifest,
      maxChunkCharacters: 512,
      write: async (chunk) => {
        serialized += chunk;
      }
    });

    assert.deepEqual(JSON.parse(serialized), result);
    assert.match(writeResult.sha256, /^[a-f0-9]{64}$/);
    assert.ok(writeResult.chunks > 10);
  });

  it("bridges a real bounded historical journal into the same measured matrix", async (t) => {
    const outputDir = await mkdtemp(join(tmpdir(), "coverage-materializer-history-"));
    t.after(() => rm(outputDir, { recursive: true, force: true }));
    let tick = 0;
    await runHistoricalBackfill({
      outputDir,
      catalogs: [{
        slug: "TEST",
        companies: [{
          sourceKey: "company-acme",
          name: "Acme",
          websiteUrl: "https://acme.example",
          accounts: [],
          founders: []
        }]
      }],
      platforms: ["hacker_news"],
      limits: {
        hostPaceMs: 0,
        requestAttempts: 1,
        hnHitsPerPage: 1_000,
        hnMaxItems: 1_000
      },
      now: () => new Date(Date.parse(STARTED_AT) + tick++ * 1_000),
      fetch: async () => new Response(JSON.stringify({
        hits: Array.from({ length: 522 }, (_, index) => ({
          objectID: `historical-${index}`,
          title: `Acme historical launch ${index}`,
          url: `https://acme.example/blog/historical-launch-${index}`,
          created_at: "2026-04-01T12:00:00.000Z",
          author: "fixture-author"
        })),
        nbPages: 1
      }), { headers: { "content-type": "application/json" } })
    });
    const journal = await readFile(join(outputDir, "pages.ndjson"));
    const events = journal.toString("utf8").trimEnd().split("\n").map(JSON.parse);
    const input = adapterInput();
    input.taskPlan.push({
      batchSlug: "TEST",
      companySourceKey: "company-acme",
      entityType: "company",
      entitySourceKey: "company-acme",
      platform: "hacker_news",
      account: null,
      checkpointKey: "run:TEST:company:company-acme:hacker_news:discovery",
      status: "queued",
      terminalReason: null
    });
    input.collectorArtifacts[0].snapshot.attempts[
      "hacker_news:company:company-acme:discovery"
    ] = {
      attemptKey: "hacker_news:company:company-acme:discovery",
      batchSlug: "TEST",
      entityType: "company",
      entityId: "company-acme",
      platform: "hacker_news",
      status: "done",
      outcomeStatus: "completed",
      outcomeReason: "collector_evidence_collected",
      checkedAt: CHECKED_AT,
      retryable: false
    };
    input.collectorArtifacts[0].snapshot.evidence.push({
      id: "hacker-news-company-acme-historical-0",
      batchSlug: "TEST",
      entityType: "company",
      entityId: "company-acme",
      platform: "hacker_news",
      sourceUrl: "https://news.ycombinator.com/item?id=historical-0",
      platformPostId: "historical-0",
      title: "Acme historical launch 0",
      text: "Acme historical launch 0",
      postedAt: "2026-04-01T12:00:00.000Z",
      last_checked_at: CHECKED_AT,
      review_state: "verified",
      metrics: { upvotes: 1 }
    });
    const result = await materializeIngestionCoverage({
      ...input,
      historicalBackfills: [{
        journal: [journal],
        artifact: {
          path: "historical/pages.ndjson",
          sha256: createHash("sha256").update(journal).digest("hex"),
          observedAt: events.at(-1).recordedAt
        }
      }]
    });

    const pair = result.coverageReceipt.pairs.find((candidate) =>
      candidate.pairKey === "TEST:company:company-acme:hacker_news"
    );
    assert.equal(pair.terminal.status, "collected");
    assert.equal(pair.evidence.historicalPostCount, 522);
    assert.doesNotMatch(
      pair.terminal.reason,
      /\b5\d\d\b/,
      "a legitimate 522-row success must not be classified as an HTTP 522 failure"
    );
    assert.equal(pair.scope.historicalBackfillComplete, false);
    assert.equal(result.historicalCoverage.runs.length, 1);
    assert.equal(result.historicalCoverage.runs[0].targetCoverage[0].scopeStatus, "partial");
    assert.equal(result.historicalCoverage.runs[0].outboundLinks.length, 522);
    assert.equal(result.provenance.historicalAdapters.length, 1);
    assert.equal(result.historicalDepthCoverage.crossLayerDuplicateReviews.length, 1);
    assert.equal(
      result.historicalDepthCoverage.crossLayerDuplicateReviews[0].sourceLayer,
      "historical"
    );
    assert.equal(
      result.coverageReceipt.evidenceRegistry.filter((row) =>
        row.platform === "hacker_news" && row.nativeId === "historical-0"
      ).length,
      1
    );
  });

  it("materializes every historical-depth pair, including explicit unmapped queues", async (t) => {
    const outputDir = await mkdtemp(join(tmpdir(), "coverage-materializer-depth-"));
    t.after(() => rm(outputDir, { recursive: true, force: true }));
    const input = adapterInput();
    input.catalogs[0].companies[0].websiteUrl = "https://acme.example";
    input.catalogs[0].companies[0].accounts.push({
      platform: "product_hunt",
      url: "https://www.producthunt.com/products/acme",
      verificationStatus: "verified",
      verified: true
    });
    input.expectedCatalogManifest = manifestFor(input.catalogs);
    let tick = 0;
    await runHistoricalDepthBackfill({
      outputDir,
      catalogs: input.catalogs,
      platforms: ["youtube", "product_hunt", "reddit"],
      limits: { hostPaceMs: 0, redditPaceMs: 0, requestAttempts: 1 },
      now: () => new Date(Date.parse(STARTED_AT) + tick++ * 1_000)
    });
    const journal = await readFile(join(outputDir, "pages.ndjson"));
    const events = journal.toString("utf8").trimEnd().split("\n").map(JSON.parse);
    const result = await materializeIngestionCoverage({
      ...input,
      historicalDepthBackfills: [{
        journal: [journal],
        artifact: {
          path: "historical-depth/pages.ndjson",
          sha256: createHash("sha256").update(journal).digest("hex"),
          observedAt: events.at(-1).recordedAt
        }
      }]
    });

    const depth = result.historicalDepthCoverage.runs[0];
    assert.equal(depth.coverageSummary.ownerPlatformPairsEvaluated, 3);
    assert.equal(depth.coverageSummary.mappedOwnerPlatformPairs, 1);
    assert.equal(depth.coverageSummary.unmappedOwnerPlatformPairs, 2);
    assert.equal(depth.coverageSummary.pairStatusCounts.requires_credentials, 1);
    assert.equal(depth.coverageSummary.pairStatusCounts.queued_unmapped, 2);
    assert.equal(depth.pairCoverage.length, 3);
    assert.equal(result.provenance.historicalDepthAdapters.length, 1);
    const productHunt = result.coverageReceipt.pairs.find((pair) =>
      pair.pairKey === "TEST:company:company-acme:product_hunt"
    );
    assert.equal(productHunt.terminal.status, "queued");
    assert.equal(productHunt.terminal.reasonCode, "missing_credentials");
  });

  it("coalesces exact shallow/depth duplicates and surfaces a review without double-counting", async (t) => {
    const outputDir = await mkdtemp(join(tmpdir(), "coverage-materializer-collision-"));
    t.after(() => rm(outputDir, { recursive: true, force: true }));
    const input = adapterInput();
    const company = input.catalogs[0].companies[0];
    company.websiteUrl = "https://acme.example";
    company.accounts.push({
      platform: "youtube",
      url: "https://www.youtube.com/channel/UCfixture123",
      verificationStatus: "verified",
      verified: true
    });
    input.expectedCatalogManifest = manifestFor(input.catalogs);
    input.collectorArtifacts[0].snapshot.attempts[
      "youtube:company:company-acme:https://www.youtube.com/channel/UCfixture123"
    ] = {
      attemptKey: "youtube:company:company-acme:https://www.youtube.com/channel/UCfixture123",
      batchSlug: "TEST",
      entityType: "company",
      entityId: "company-acme",
      platform: "youtube",
      accountUrl: "https://www.youtube.com/channel/UCfixture123",
      status: "done",
      outcomeStatus: "completed",
      outcomeReason: "collector_evidence_collected",
      checkedAt: CHECKED_AT,
      retryable: false
    };
    input.collectorArtifacts[0].snapshot.evidence.push({
      id: "youtube-company-acme-video123",
      batchSlug: "TEST",
      entityType: "company",
      entityId: "company-acme",
      platform: "youtube",
      sourceUrl: "https://www.youtube.com/watch?v=video123",
      platformPostId: "video123",
      accountUrl: "https://www.youtube.com/channel/UCfixture123",
      title: "Historical launch",
      text: "",
      postedAt: "2026-01-01T12:00:00.000Z",
      last_checked_at: CHECKED_AT,
      review_state: "verified",
      metrics: {}
    });
    let tick = 0;
    await runHistoricalDepthBackfill({
      outputDir,
      catalogs: input.catalogs,
      platforms: ["youtube"],
      credentials: { youtubeApiKey: "fixture-key" },
      limits: { hostPaceMs: 0, redditPaceMs: 0, requestAttempts: 1 },
      now: () => new Date(Date.parse(STARTED_AT) + tick++ * 1_000),
      fetch: async (url) => {
        const value = String(url);
        if (value.includes("feeds/videos.xml")) {
          return new Response(`<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><yt:channelId>UCfixture123</yt:channelId></feed>`);
        }
        if (value.includes("/youtube/v3/channels")) {
          return Response.json({ items: [{
            id: "UCfixture123",
            contentDetails: { relatedPlaylists: { uploads: "UUfixture123" } }
          }] });
        }
        if (value.includes("/youtube/v3/playlistItems")) {
          return Response.json({
            items: [{
              contentDetails: {
                videoId: "video123",
                videoPublishedAt: "2026-01-01T12:00:00.000Z"
              },
              snippet: {
                videoOwnerChannelId: "UCfixture123",
                title: "Historical launch",
                description: ""
              }
            }],
            pageInfo: { totalResults: 1 }
          });
        }
        return new Response(`<meta itemprop="channelId" content="UCfixture123">`);
      }
    });
    const journal = await readFile(join(outputDir, "pages.ndjson"));
    const events = journal.toString("utf8").trimEnd().split("\n").map(JSON.parse);
    const result = await materializeIngestionCoverage({
      ...input,
      historicalDepthBackfills: [{
        journal: [journal],
        artifact: {
          path: "historical-depth/collision.ndjson",
          sha256: createHash("sha256").update(journal).digest("hex"),
          observedAt: events.at(-1).recordedAt
        }
      }]
    });

    const youtube = result.coverageReceipt.pairs.find((pair) =>
      pair.pairKey === "TEST:company:company-acme:youtube"
    );
    assert.equal(youtube.evidence.postCount, 1);
    assert.equal(result.historicalDepthCoverage.crossLayerDuplicateReviews.length, 1);
    assert.equal(
      result.historicalDepthCoverage.crossLayerDuplicateReviews[0].disposition,
      "coalesced_exact_identity"
    );
    assert.equal(
      result.coverageReceipt.evidenceRegistry.filter((row) => row.platform === "youtube").length,
      1
    );
  });
});
