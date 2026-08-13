import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { auditProductionReleaseProofs } from
  "../scripts/lib/production-release-proof-audit.mjs";
import {
  INGESTION_CATALOG_MANIFEST_VERSION,
  INGESTION_CORE_PLATFORMS,
  computeIngestionCatalogSourceHash
} from "../scripts/lib/ingestion-coverage-receipt.mjs";
import { normalizeAutonomousIngestionCatalogs } from
  "../scripts/lib/ingestion-coverage-adapter.mjs";

const STARTED_AT = "2026-08-03T02:00:00.000Z";
const CHECKED_AT = "2026-08-03T03:00:00.000Z";
const HASH_A = "a".repeat(64);

describe("production release proof Cartesian audit", () => {
  it("accepts a verified sample for every batch-platform cell", () => {
    const fixture = buildFixture();
    const result = auditProductionReleaseProofs(fixture);
    assert.equal(result.status, "verified");
    assert.equal(result.denominator.batches, 2);
    assert.equal(result.denominator.corePlatforms, 10);
    assert.equal(result.denominator.batchPlatformCells, 20);
    assert.equal(result.samples.coveredBatchPlatformCells, 20);
  });

  it("rejects union-only samples that omit batch-platform cells", () => {
    const fixture = buildFixture();
    fixture.releaseProofs.productionSample.samples = [
      ...fixture.releaseProofs.productionSample.samples.filter(
        (sample) => sample.batchSlug === "A"
      ),
      fixture.releaseProofs.productionSample.samples.find(
        (sample) => sample.batchSlug === "B" && sample.platform === "github"
      )
    ];
    assert.throws(
      () => auditProductionReleaseProofs(fixture),
      /(?:9\/20 batch-platform cells are missing|missing batch-platform combinations \[B:x)/
    );
  });

  it("rejects a sample whose pair identity does not match its cell", () => {
    const fixture = buildFixture();
    fixture.releaseProofs.productionSample.samples[0].pairKey =
      "B:company:company-b:github";
    assert.throws(
      () => auditProductionReleaseProofs(fixture),
      /pairKey does not match batch A and platform github/
    );
  });

  it("rejects a release whose deployment digest differs from the rebuild", () => {
    const fixture = buildFixture();
    fixture.releaseProofs.deployment.artifactDigest = "b".repeat(64);
    assert.throws(
      () => auditProductionReleaseProofs(fixture),
      /Deployment receipt does not identify the rebuilt production artifact digest/
    );
  });
});

function buildFixture() {
  const catalogs = normalizeAutonomousIngestionCatalogs([
    catalog("A", "company-a"),
    catalog("B", "company-b")
  ]);
  const expectedCatalogManifest = {
    version: INGESTION_CATALOG_MANIFEST_VERSION,
    batches: catalogs.map((value) => ({
      batchSlug: value.batchSlug,
      sourcePath: value.sourcePath,
      sourceVersion: value.sourceVersion,
      sourceHash: computeIngestionCatalogSourceHash(value),
      companies: 1,
      founders: 0,
      entities: 1
    }))
  };
  const artifactDigest = HASH_A;
  const revision = "revision-42";
  const expectedManifestDigest = sha256Stable(expectedCatalogManifest);
  return {
    catalogs,
    expectedCatalogManifest,
    runStartedAt: STARTED_AT,
    generatedAt: CHECKED_AT,
    releaseProofs: {
      expectedManifest: proof("expectedManifest", "verified", expectedManifestDigest),
      productionArtifact: proof("productionArtifact", "rebuilt", artifactDigest, {
        revision
      }),
      productionSample: proof("productionSample", "verified", artifactDigest, {
        revision,
        samples: catalogs.flatMap((value) => INGESTION_CORE_PLATFORMS.map(
          (platform) => ({
            sampleId: `sample-${value.batchSlug}-${platform}`,
            batchSlug: value.batchSlug,
            platform,
            pairKey: `${value.batchSlug}:company:${value.companies[0].id}:${platform}`,
            verified: true,
            checkedAt: CHECKED_AT,
            reason: `Production returned the expected ${platform} state for ${value.batchSlug}.`
          })
        ))
      }),
      deployment: proof("deployment", "verified", artifactDigest, {
        revision,
        environment: "production"
      })
    }
  };
}

function catalog(batchSlug, companyId) {
  return {
    slug: batchSlug,
    sourcePath: `fixtures/${batchSlug}.json`,
    generatedAt: "2026-08-03T01:00:00.000Z",
    companies: [{
      entityType: "company",
      sourceKey: companyId,
      name: companyId,
      accounts: [],
      founders: []
    }]
  };
}

function proof(kind, status, artifactDigest, extras = {}) {
  return {
    schemaVersion: "ingestion-production-release-proof.v1",
    receiptId: `release-${kind}`,
    status,
    checkedAt: CHECKED_AT,
    artifactDigest,
    toolVersion: "release-proof-cartesian-test.v1",
    reason: `The exact ${kind} artifact and production state were verified.`,
    ...extras
  };
}

function sha256Stable(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
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
