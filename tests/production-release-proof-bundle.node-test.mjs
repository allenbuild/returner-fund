import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { writeArtifactManifest } from "../scripts/lib/artifact-manifest.mjs";
import { normalizeAutonomousIngestionCatalogs } from
  "../scripts/lib/ingestion-coverage-adapter.mjs";
import {
  INGESTION_CATALOG_MANIFEST_VERSION,
  computeIngestionCatalogSourceHash
} from "../scripts/lib/ingestion-coverage-receipt.mjs";
import {
  PRODUCTION_DEPLOYMENT_ATTESTATION_VERSION,
  captureProductionReleaseProofBundle
} from "../scripts/lib/production-release-proof-bundle.mjs";
import {
  PRODUCTION_GRAPH_BATCHES,
  PRODUCTION_GRAPH_CORE_PLATFORMS
} from "../scripts/lib/production-graph-sampler.mjs";

const NOW = "2026-08-03T05:00:00.000Z";
const REVISION = "a".repeat(40);
const BASE_URL = "https://returner.example";

describe("production release proof bundle", () => {
  it("atomically emits four reconciled receipts only after exact live bytes and 30/30 samples", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const tracker = [];
    const result = await captureFixture(fixture, {
      fetchImpl: productionFetch(fixture, { tracker })
    });

    assert.equal(result.status, "verified");
    assert.equal(result.authentication, "none");
    assert.deepEqual(Object.keys(result.releaseProofs).sort(), [
      "deployment",
      "expectedManifest",
      "productionArtifact",
      "productionSample"
    ]);
    assert.ok(Object.values(result.releaseProofs).every((receipt) => receipt !== null));
    assert.equal(result.releaseProofs.productionSample.samples.length, 30);
    assert.equal(result.audit.status, "verified");
    assert.equal(result.audit.denominator.batchPlatformCells, 30);
    assert.equal(tracker.length, 4);
    assert.equal(tracker.filter((row) => row.pathname === "/api/graph").length, 3);
    assert.ok(tracker.every((row) => row.authorization === null && row.cookie === null));
    assert.equal(result.liveManifest.sha256, result.rebuiltManifest.sha256);
    assert.equal(
      result.releaseProofs.productionArtifact.artifactDigest,
      fixture.manifest.contentHash
    );
  });

  it("emits no receipt when independent metadata identifies a stale revision", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    fixture.attestation.revision = "b".repeat(40);
    let calls = 0;
    const result = await captureFixture(fixture, {
      fetchImpl: async () => {
        calls += 1;
        throw new Error("stale revision must stop before production reads");
      }
    });
    assert.equal(result.status, "blocked");
    assertNoReceipts(result);
    assert.equal(calls, 0);
    assert.ok(result.blockers.some((row) => row.code === "deployed_revision_mismatch"));
  });

  it("rejects an abbreviated revision before reading production", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    let calls = 0;
    await assert.rejects(
      captureFixture(fixture, {
        deployedRevision: REVISION.slice(0, 12),
        fetchImpl: async () => {
          calls += 1;
          throw new Error("abbreviated revision must stop before production reads");
        }
      }),
      /full 40- or 64-character lowercase Git object ID/
    );
    assert.equal(calls, 0);
  });

  it("emits no receipt for a stale rebuilt manifest or different live manifest bytes", async (t) => {
    const stale = await createFixture();
    const liveMismatch = await createFixture();
    t.after(() => Promise.all([stale, liveMismatch].map((fixture) =>
      rm(fixture.root, { recursive: true, force: true })
    )));
    const staleGraphPath = join(stale.root, "public", "graph", "s2026.json");
    const staleGraph = JSON.parse(await readFile(staleGraphPath, "utf8"));
    staleGraph.unpublishedMutation = true;
    await writeFile(staleGraphPath, `${JSON.stringify(staleGraph)}\n`);
    const staleResult = await captureFixture(stale, {
      fetchImpl: async () => {
        throw new Error("stale local manifest must stop before production reads");
      }
    });
    assert.equal(staleResult.status, "blocked");
    assertNoReceipts(staleResult);
    assert.ok(staleResult.blockers.some((row) => row.code === "rebuilt_manifest_invalid"));

    const mismatchBytes = Buffer.from(`${JSON.stringify(liveMismatch.manifest)}\n`);
    const result = await captureFixture(liveMismatch, {
      fetchImpl: productionFetch(liveMismatch, { liveManifestBytes: mismatchBytes })
    });
    assert.equal(result.status, "blocked");
    assertNoReceipts(result);
    assert.ok(result.blockers.some((row) => row.code === "live_manifest_bytes_mismatch"));
  });

  it("emits no receipt when production sampling reaches only 29/30 Cartesian cells", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const result = await captureFixture(fixture, {
      fetchImpl: productionFetch(fixture, { omitCell: "S26:reddit" })
    });
    assert.equal(result.sampleCapture.summary.verifiedCells, 29);
    assert.equal(result.status, "blocked");
    assertNoReceipts(result);
    assert.ok(result.blockers.some((row) =>
      row.code === "production_sample_cartesian_incomplete"
    ));
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "production-release-proof-bundle-"));
  const graphDir = join(root, "public", "graph");
  const benchmarkDir = join(root, "outputs", "benchmarks");
  await Promise.all([
    mkdir(graphDir, { recursive: true }),
    mkdir(benchmarkDir, { recursive: true }),
    mkdir(join(root, "public", "topic-facets"), { recursive: true }),
    mkdir(join(root, "public", "timelines", "companies"), { recursive: true }),
    mkdir(join(root, "src", "lib", "social"), { recursive: true }),
    mkdir(join(root, "src", "lib", "graph"), { recursive: true }),
    mkdir(join(root, "docs", "outputs"), { recursive: true })
  ]);
  await Promise.all([
    ...PRODUCTION_GRAPH_BATCHES.map((batchSlug) => writeFile(
      join(graphDir, `${batchSlug.toLowerCase()}.json`),
      `${JSON.stringify(graphFixture(batchSlug))}\n`
    )),
    writeFile(join(root, "src", "lib", "social", "logged-in-evidence-current.json"), "{}\n"),
    writeFile(join(root, "public", "topic-facets", "s2026.json"), "{}\n"),
    writeFile(join(root, "src", "lib", "graph", "ranked-posts-sidecar.generated.json"), "{}\n"),
    writeFile(join(root, "public", "timelines", "companies", "fixture.json"), "{}\n"),
    writeFile(join(root, "docs", "outputs", "scoring-diagnostics-v4-audit.json"), "{}\n"),
    writeFile(join(root, "docs", "outputs", "scoring-diagnostics-v4-report.md"), "fixture\n")
  ]);
  const { manifest, manifestPath } = await writeArtifactManifest({
    rootDir: root,
    ingestionRunId: "release-proof-fixture",
    publishedAt: NOW
  });
  const manifestBytes = await readFile(manifestPath);
  const catalogs = rawCatalogs();
  const normalized = normalizeAutonomousIngestionCatalogs(catalogs);
  const expectedCatalogManifest = {
    version: INGESTION_CATALOG_MANIFEST_VERSION,
    batches: normalized.map((catalog) => ({
      batchSlug: catalog.batchSlug,
      sourcePath: catalog.sourcePath,
      sourceVersion: catalog.sourceVersion,
      sourceHash: computeIngestionCatalogSourceHash(catalog),
      companies: 1,
      founders: 0,
      entities: 1
    }))
  };
  const attestation = {
    schemaVersion: PRODUCTION_DEPLOYMENT_ATTESTATION_VERSION,
    status: "verified",
    environment: "production",
    provider: "fixture-deployment-api",
    deploymentId: "deployment-fixture-42",
    verificationMethod: "Independent deployment metadata export matched Git revision and artifact pins.",
    productionUrl: BASE_URL,
    manifestUrl: `${BASE_URL}/graph/manifest.json`,
    revision: REVISION,
    artifactDigest: manifest.contentHash,
    manifestSha256: sha256(manifestBytes),
    verifiedAt: NOW
  };
  return {
    root,
    graphDir,
    benchmarkDir,
    manifest,
    manifestPath,
    manifestBytes,
    catalogs,
    expectedCatalogManifest,
    coveragePairs: coverageFixture(),
    attestation
  };
}

function captureFixture(fixture, overrides = {}) {
  return captureProductionReleaseProofBundle({
    rootDir: fixture.root,
    catalogs: fixture.catalogs,
    expectedCatalogManifest: fixture.expectedCatalogManifest,
    coveragePairs: fixture.coveragePairs,
    artifactManifestPath: fixture.manifestPath,
    graphDir: fixture.graphDir,
    benchmarkDir: fixture.benchmarkDir,
    deployedRevision: overrides.deployedRevision ?? REVISION,
    productionBaseUrl: BASE_URL,
    deploymentAttestation: fixture.attestation,
    now: () => new Date(NOW),
    fetchImpl: overrides.fetchImpl
  });
}

function productionFetch(fixture, {
  tracker = [],
  liveManifestBytes = fixture.manifestBytes,
  omitCell = null
} = {}) {
  return async (input, options = {}) => {
    const url = new URL(input);
    tracker.push({
      pathname: url.pathname,
      authorization: new Headers(options.headers).get("authorization"),
      cookie: new Headers(options.headers).get("cookie")
    });
    if (url.pathname === "/graph/manifest.json") {
      return new Response(liveManifestBytes, {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const batchSlug = url.searchParams.get("batch");
    const graph = graphFixture(batchSlug);
    if (omitCell === `${batchSlug}:reddit`) {
      graph.evidence = graph.evidence.filter((row) => row.platform !== "reddit");
      graph.nodes[0].socialAccounts = graph.nodes[0].socialAccounts.filter(
        (row) => row.platform !== "reddit"
      );
      graph.platformStatus = graph.platformStatus.filter(
        (row) => row.platform !== "reddit"
      );
    }
    return new Response(JSON.stringify(graph), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-vercel-id": `fixture-${batchSlug}`
      }
    });
  };
}

function rawCatalogs() {
  return PRODUCTION_GRAPH_BATCHES.map((batchSlug) => ({
    slug: batchSlug,
    sourcePath: `fixtures/${batchSlug}.json`,
    generatedAt: "2026-08-03T04:00:00.000Z",
    companies: [{
      entityType: "company",
      sourceKey: companyId(batchSlug),
      name: `Company ${batchSlug}`,
      accounts: [],
      founders: []
    }]
  }));
}

function coverageFixture() {
  return PRODUCTION_GRAPH_BATCHES.flatMap((batchSlug) =>
    PRODUCTION_GRAPH_CORE_PLATFORMS.map((platform) => ({
      pairKey: `${batchSlug}:company:${companyId(batchSlug)}:${platform}`,
      batchSlug,
      entity: {
        type: "company",
        id: companyId(batchSlug),
        name: `Company ${batchSlug}`
      },
      platform,
      mapping: { status: "unmapped", verifiedAccountCount: 0, accounts: [] },
      terminal: { status: "collected", reasonCode: "native_evidence_collected" },
      evidence: { postCount: 1, recentPostCount: 1, historicalPostCount: 0 }
    }))
  );
}

function graphFixture(batchSlug) {
  const entityId = companyId(batchSlug);
  return {
    mode: "official_snapshot",
    batch: { slug: batchSlug, label: batchSlug },
    batches: PRODUCTION_GRAPH_BATCHES.map((slug) => ({ slug })),
    nodes: [{
      id: `company:${entityId}`,
      entityType: "company",
      entityId,
      batchSlug,
      socialAccounts: PRODUCTION_GRAPH_CORE_PLATFORMS.map((platform) => ({
        id: `account-${batchSlug}-${platform}`,
        platform,
        handle: `${batchSlug.toLowerCase()}-${platform}`,
        url: `https://${platform}.example/${batchSlug.toLowerCase()}`,
        review_state: "verified"
      })),
      founders: []
    }],
    evidence: PRODUCTION_GRAPH_CORE_PLATFORMS.map((platform) => ({
      id: `evidence-${batchSlug}-${platform}`,
      batchSlug,
      entityType: "company",
      entityId,
      platform
    })),
    needsReview: [],
    platformStatus: PRODUCTION_GRAPH_CORE_PLATFORMS.map((platform) => ({
      platform,
      status: "working",
      authMethod: "anonymous public read",
      notes: `Exact ${batchSlug}:${platform} fixture state.`,
      batchSlugs: [batchSlug]
    })),
    generatedAt: NOW,
    evidenceCollectedAt: NOW,
    scoringContext: {
      modelId: "returner-traction",
      modelVersion: "4.2.0",
      modelName: "canonical",
      evidenceAsOf: NOW
    }
  };
}

function assertNoReceipts(result) {
  assert.deepEqual(result.releaseProofs, {
    expectedManifest: null,
    productionArtifact: null,
    productionSample: null,
    deployment: null
  });
  assert.equal(result.audit, null);
}

function companyId(batchSlug) {
  return `company-${batchSlug.toLowerCase()}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
