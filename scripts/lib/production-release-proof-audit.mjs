import { createHash } from "node:crypto";

import { normalizeAutonomousIngestionCatalogs } from
  "./ingestion-coverage-adapter.mjs";
import {
  INGESTION_CATALOG_MANIFEST_VERSION,
  INGESTION_CORE_PLATFORMS,
  computeIngestionCatalogSourceHash
} from "./ingestion-coverage-receipt.mjs";
import { summarizeProductionRelease } from
  "./ingestion-coverage-materializer.mjs";

export const PRODUCTION_RELEASE_PROOF_AUDIT_VERSION =
  "production-release-proof-cartesian-audit.v1";

/**
 * Validate the materializer's release-proof contract, then strengthen its
 * representative-sample gate to require every batch x core-platform cell.
 * This is deliberately read-only and does not manufacture proof receipts.
 */
export function auditProductionReleaseProofs({
  releaseProofs,
  catalogs,
  expectedCatalogManifest,
  runStartedAt,
  generatedAt
} = {}) {
  const normalizedCatalogs = normalizeAutonomousIngestionCatalogs(catalogs);
  const normalizedExpectedManifest = validateExpectedManifest(
    expectedCatalogManifest,
    normalizedCatalogs
  );
  const coveragePairs = buildCoveragePairs(normalizedCatalogs);
  const expectedCatalogManifestSha256 = sha256Stable(expectedCatalogManifest);
  const release = summarizeProductionRelease({
    releaseProofs,
    expectedCatalogManifestSha256,
    expectedCatalogManifest: normalizedExpectedManifest,
    coveragePairs,
    run: { startedAt: canonicalTimestamp(runStartedAt, "runStartedAt") },
    generatedAt: canonicalTimestamp(generatedAt, "generatedAt")
  });
  if (!release.complete) {
    throw new Error(
      `Base production release proof is incomplete: ${release.blockers.join(" | ")}`
    );
  }

  const expectedCells = [];
  for (const batch of normalizedExpectedManifest.batches) {
    for (const platform of INGESTION_CORE_PLATFORMS) {
      expectedCells.push(`${batch.batchSlug}:${platform}`);
    }
  }
  const samples = release.receipts.productionSample.samples;
  const samplesByCell = new Map(expectedCells.map((cell) => [cell, []]));
  for (const sample of samples) {
    const cell = `${sample.batchSlug}:${sample.platform}`;
    const rows = samplesByCell.get(cell);
    if (!rows) throw new Error(`Production sample uses unexpected cell ${cell}.`);
    rows.push(sample.sampleId);
  }
  const missingCells = [...samplesByCell.entries()]
    .filter(([, sampleIds]) => sampleIds.length === 0)
    .map(([cell]) => cell);
  if (missingCells.length > 0) {
    throw new Error(
      `Production sample Cartesian coverage is incomplete: ${missingCells.length}/` +
      `${expectedCells.length} batch-platform cells are missing; ` +
      `first=${missingCells.slice(0, 10).join(",")}.`
    );
  }

  const duplicateCells = [...samplesByCell.entries()]
    .filter(([, sampleIds]) => sampleIds.length > 1)
    .map(([cell, sampleIds]) => ({ cell, sampleIds: [...sampleIds].sort() }));
  return {
    schemaVersion: PRODUCTION_RELEASE_PROOF_AUDIT_VERSION,
    status: "verified",
    generatedAt: canonicalTimestamp(generatedAt, "generatedAt"),
    expectedCatalogManifestSha256,
    revision: release.receipts.productionArtifact.revision,
    artifactDigest: release.receipts.productionArtifact.artifactDigest,
    denominator: {
      batches: normalizedExpectedManifest.batches.length,
      corePlatforms: INGESTION_CORE_PLATFORMS.length,
      batchPlatformCells: expectedCells.length
    },
    samples: {
      rows: samples.length,
      coveredBatchPlatformCells: expectedCells.length,
      duplicateCells
    },
    release
  };
}

function validateExpectedManifest(value, catalogs) {
  assertObject(value, "expectedCatalogManifest");
  if (value.version !== INGESTION_CATALOG_MANIFEST_VERSION) {
    throw new Error(
      `expectedCatalogManifest.version must be ${INGESTION_CATALOG_MANIFEST_VERSION}.`
    );
  }
  if (!Array.isArray(value.batches)) {
    throw new TypeError("expectedCatalogManifest.batches must be an array.");
  }
  const expected = catalogs.map((catalog) => {
    const founders = catalog.companies.reduce(
      (sum, company) => sum + company.founders.length,
      0
    );
    return {
      batchSlug: catalog.batchSlug,
      sourcePath: catalog.sourcePath,
      sourceVersion: catalog.sourceVersion,
      sourceHash: computeIngestionCatalogSourceHash(catalog),
      companies: catalog.companies.length,
      founders,
      entities: catalog.companies.length + founders
    };
  }).sort((left, right) => left.batchSlug.localeCompare(right.batchSlug));
  const actual = value.batches.map((batch, index) => {
    assertObject(batch, `expectedCatalogManifest.batches[${index}]`);
    return structuredClone(batch);
  }).sort((left, right) =>
    String(left.batchSlug ?? "").localeCompare(String(right.batchSlug ?? ""))
  );
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(
      "Expected catalog manifest does not match the normalized canonical catalogs."
    );
  }
  return { version: value.version, batches: actual };
}

function buildCoveragePairs(catalogs) {
  const pairs = [];
  for (const catalog of catalogs) {
    for (const company of catalog.companies) {
      addOwnerPairs(pairs, catalog.batchSlug, "company", company.id);
      for (const founder of company.founders) {
        addOwnerPairs(pairs, catalog.batchSlug, "founder", founder.id);
      }
    }
  }
  return pairs;
}

function addOwnerPairs(pairs, batchSlug, entityType, entityId) {
  for (const platform of INGESTION_CORE_PLATFORMS) {
    pairs.push({
      pairKey: `${batchSlug}:${entityType}:${entityId}:${platform}`,
      batchSlug,
      platform
    });
  }
}

function canonicalTimestamp(value, label) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) ||
      !Number.isFinite(Date.parse(text)) ||
      new Date(text).toISOString() !== text) {
    throw new TypeError(`${label} must be a canonical ISO UTC timestamp.`);
  }
  return text;
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

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}
