import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildStoredUnpublishedCoverageBridge
} from "../scripts/lib/stored-unpublished-coverage-bridge.mjs";
import { normalizeAutonomousIngestionCatalogs } from
  "../scripts/lib/ingestion-coverage-adapter.mjs";
import {
  INGESTION_CATALOG_MANIFEST_VERSION,
  buildIngestionCoverageReceipt,
  computeIngestionCatalogSourceHash
} from "../scripts/lib/ingestion-coverage-receipt.mjs";

const GENERATED_AT = "2026-08-03T03:00:00.000Z";
const HISTORICAL_STAGED_AT = "2026-08-03T02:31:00.000Z";
const GITHUB_STAGED_AT = "2026-08-03T02:36:48.781Z";

describe("stored-unpublished coverage proof bridge", () => {
  it("emits one compatible receipt per canonical pair with exact positive and zero counts", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const outputDir = join(fixture.root, "proof-v1");
    const result = await bridge(fixture, { outputDir });

    assert.equal(result.status, "staged");
    assert.equal(result.productionEligible, false);
    assert.equal(result.scoringEligible, false);
    assert.equal(result.denominator.canonicalPairs, 26);
    assert.deepEqual(result.counts, {
      historicalLedgerRows: 2,
      githubLedgerRows: 2,
      historicalEvidenceAttributions: 2,
      githubEvidenceAttributions: 2,
      githubBlockerReviews: 1,
      totalEvidenceAttributions: 4,
      totalSurfacedAttributions: 5,
      explicitZeroPairs: 22,
      nonzeroPairs: 4
    });

    const scopes = JSON.parse(await readFile(join(outputDir, "pair-scopes.json"), "utf8"));
    assert.equal(scopes.length, 26);
    assert.equal(new Set(scopes.map((row) => row.pairKey)).size, 26);
    const companyGithub = scope(scopes, "company", "company-acme", "github");
    assert.deepEqual(companyGithub.scope.storedUnpublishedReceipt.surfacedCounts, {
      historicalEvidenceRows: 0,
      githubEvidenceAttributions: 1,
      githubBlockerReviews: 0,
      evidenceAttributions: 1,
      totalAttributedRows: 1,
      explicitZero: false
    });
    const founderGithub = scope(scopes, "founder", "founder-ada", "github");
    assert.equal(founderGithub.scope.storedUnpublishedReceipt.surfacedCounts.totalAttributedRows, 2);
    const explicitZero = scope(scopes, "company", "company-acme", "x");
    assert.equal(explicitZero.scope.storedUnpublishedReceipt.surfacedCounts.explicitZero, true);
    assert.match(explicitZero.scope.storedUnpublishedReceipt.reason, /both named ledgers were checked/i);
    assert.ok(scopes.every((row) =>
      row.scope.storedUnpublishedReceipt.status === "complete" &&
      row.scope.storedUnpublishedReceipt.scoringEligible === false &&
      row.scope.storedUnpublishedReceipt.publicationPolicy === "proof_only_no_publication"
    ));

    const normalizedCatalogs = normalizeAutonomousIngestionCatalogs(fixture.catalogs);
    const receipt = buildIngestionCoverageReceipt({
      runId: "fixture-run",
      run: {
        idempotencyKey: "fixture-run",
        campaignKey: "fixture-campaign",
        startedAt: GENERATED_AT,
        completedAt: GENERATED_AT
      },
      generatedAt: GENERATED_AT,
      catalogs: normalizedCatalogs,
      expectedCatalogManifest: expectedManifest(normalizedCatalogs),
      pairScopes: scopes
    });
    assert.equal(receipt.pairs.length, 26);
    assert.ok(receipt.pairs.every((pair) => pair.scope.storedUnpublishedSurfaced));

    const manifestBytes = await readFile(result.manifestPath);
    assert.equal(sha256(manifestBytes), result.manifestSha256);
    const pairBytes = await readFile(join(outputDir, result.artifacts.pairScopes.path));
    assert.equal(sha256(pairBytes), result.artifacts.pairScopes.sha256);
  });

  it("rejects a ledger whose bytes no longer match the hash-pinned stage descriptor", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    await writeFile(fixture.historicalLedgerPath, `${await readFile(fixture.historicalLedgerPath, "utf8")}\n`);
    await assert.rejects(bridge(fixture, { dryRun: true }), /SHA-256 does not match/);
  });

  it("rejects unknown identities and platforms instead of producing partial pair coverage", async (t) => {
    const unknown = await createFixture({
      historicalRows: [historicalRow({ entityId: "company-unknown" })]
    });
    t.after(() => rm(unknown.root, { recursive: true, force: true }));
    await assert.rejects(bridge(unknown, { dryRun: true }), /does not resolve to canonical pair/);

    const platform = await createFixture({
      historicalRows: [historicalRow({ platform: "x" })]
    });
    t.after(() => rm(platform.root, { recursive: true, force: true }));
    await assert.rejects(bridge(platform, { dryRun: true }), /unsupported platform x/);
  });

  it("rejects duplicate attribution within either immutable ledger", async (t) => {
    const historical = historicalRow();
    const duplicateHistorical = await createFixture({
      historicalRows: [historical, { ...historical, id: "historical-two" }]
    });
    t.after(() => rm(duplicateHistorical.root, { recursive: true, force: true }));
    await assert.rejects(
      bridge(duplicateHistorical, { dryRun: true }),
      /Duplicate historical attribution/
    );

    const github = githubEvidenceRow();
    github.ownerCandidates.push({ ...github.ownerCandidates[0] });
    const duplicateGithub = await createFixture({ githubRows: [github] });
    t.after(() => rm(duplicateGithub.root, { recursive: true, force: true }));
    await assert.rejects(
      bridge(duplicateGithub, { dryRun: true }),
      /Duplicate GitHub attribution/
    );
  });

  it("rejects any staged row that is scoring- or publication-eligible", async (t) => {
    const unsafeHistorical = await createFixture({
      historicalRows: [historicalRow({ publicationPolicy: "published" })]
    });
    t.after(() => rm(unsafeHistorical.root, { recursive: true, force: true }));
    await assert.rejects(bridge(unsafeHistorical, { dryRun: true }), /scoring- or publication-eligible/);

    const unsafeGithub = await createFixture({
      githubRows: [githubEvidenceRow({ scoringEligible: true })]
    });
    t.after(() => rm(unsafeGithub.root, { recursive: true, force: true }));
    await assert.rejects(bridge(unsafeGithub, { dryRun: true }), /scoring- or publication-eligible/);
  });

  it("rejects a GitHub receipt whose exact core no longer matches its self-hash", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const receipt = JSON.parse(await readFile(fixture.githubReceiptPath, "utf8"));
    receipt.generatedAt = "2026-08-03T02:36:49.000Z";
    await writeFile(fixture.githubReceiptPath, `${stableJson(receipt)}\n`);
    await assert.rejects(bridge(fixture, { dryRun: true }), /self-hash does not match/);
  });
});

async function createFixture({
  historicalRows = [
    historicalRow(),
    historicalRow({
      id: "historical-founder-hn",
      entityType: "founder",
      entityId: "founder-ada",
      entityName: "Ada Founder",
      platform: "hacker_news",
      nativeId: "hn:42"
    })
  ],
  githubRows = [githubEvidenceRow(), githubBlockerRow()]
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "stored-unpublished-bridge-"));
  const historicalDir = join(root, "historical-stage");
  const githubDir = join(root, "github-stage");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([
    mkdir(historicalDir),
    mkdir(githubDir)
  ]));
  const historicalLedgerPath = join(historicalDir, "historical-stored-unpublished.ndjson");
  const githubLedgerPath = join(githubDir, "github-exhaustive-stored-evidence-review.ndjson");
  const historicalBody = ndjsonBody(historicalRows);
  const githubBody = ndjsonBody(githubRows);
  await writeFile(historicalLedgerPath, historicalBody);
  await writeFile(githubLedgerPath, githubBody);

  const historicalManifest = {
    schemaVersion: "historical-publication-staging.v1",
    status: "staged",
    publicationStatus: "stored_but_unpublished",
    stagedAt: HISTORICAL_STAGED_AT,
    counts: { storedButUnpublished: historicalRows.length },
    artifacts: {
      storedUnpublished: {
        path: "historical-stored-unpublished.ndjson",
        format: "ndjson",
        rows: historicalRows.length,
        bytes: Buffer.byteLength(historicalBody),
        sha256: sha256(historicalBody),
        observedAt: HISTORICAL_STAGED_AT
      }
    }
  };
  const historicalManifestPath = join(historicalDir, "staging-manifest.json");
  await writeFile(historicalManifestPath, `${stableJson(historicalManifest)}\n`);

  const receiptCore = {
    schemaVersion: 1,
    status: "staged_not_published",
    productionEligible: false,
    generatedAt: GITHUB_STAGED_AT,
    denominators: {
      companiesEvaluated: 1,
      foundersEvaluated: 1,
      canonicalOwnersEvaluated: 2
    },
    evidence: { storedEvidenceReviewRows: githubRows.length },
    outputs: {
      storedEvidenceReview: {
        filename: "github-exhaustive-stored-evidence-review.ndjson",
        rowCount: githubRows.length,
        sha256: sha256(githubBody),
        publicationState: "stored_but_unpublished",
        scoringEligible: false
      }
    }
  };
  const githubReceipt = {
    ...receiptCore,
    receiptSha256: sha256(stableJson(receiptCore))
  };
  const githubReceiptPath = join(githubDir, "github-exhaustive-integration-receipt.json");
  await writeFile(githubReceiptPath, `${stableJson(githubReceipt)}\n`);

  return {
    root,
    catalogs: fixtureCatalogs(),
    historicalManifestPath,
    historicalLedgerPath,
    githubReceiptPath,
    githubLedgerPath
  };
}

function bridge(fixture, overrides = {}) {
  return buildStoredUnpublishedCoverageBridge({
    root: fixture.root,
    historicalManifestPath: fixture.historicalManifestPath,
    githubReceiptPath: fixture.githubReceiptPath,
    outputDir: overrides.outputDir,
    generatedAt: GENERATED_AT,
    dryRun: overrides.dryRun ?? false,
    expectedPairCount: 26,
    catalogs: fixture.catalogs,
    maxInputBytes: 8 * 1024 * 1024
  });
}

function fixtureCatalogs() {
  return [{
    slug: "TEST",
    sourcePath: "fixture-catalog.json",
    generatedAt: "2026-08-03T02:00:00.000Z",
    companies: [{
      sourceKey: "company-acme",
      name: "Acme Labs",
      accounts: [],
      founders: [{
        sourceKey: "founder-ada",
        name: "Ada Founder",
        accounts: []
      }]
    }]
  }];
}

function historicalRow(overrides = {}) {
  return {
    id: "historical-company-web",
    batchSlug: "TEST",
    entityType: "company",
    entityId: "company-acme",
    entityName: "Acme Labs",
    platform: "web",
    nativeId: "web:https://acme.example/history",
    canonicalUrl: "https://acme.example/history",
    publicationPolicy: "stored_but_unpublished",
    historicalValidationStatus: "pending_publication_validation",
    review_state: "needs_review",
    ...overrides
  };
}

function githubEvidenceRow(overrides = {}) {
  return {
    reviewId: "github-exhaustive-evidence:fixture",
    category: "github_exhaustive_content_stored_unpublished",
    contentIdentity: {
      evidenceId: "github:commit:1:abc",
      kind: "github_commit"
    },
    ownerCandidates: [{
      batchSlug: "TEST",
      entityType: "company",
      entityId: "company-acme",
      entityName: "Acme Labs",
      taskKey: "TEST:company:company-acme:https://github.com/acme"
    }, {
      batchSlug: "TEST",
      entityType: "founder",
      entityId: "founder-ada",
      entityName: "Ada Founder",
      taskKey: "TEST:founder:founder-ada:https://github.com/ada"
    }],
    publicationState: "stored_but_unpublished",
    scoringEligible: false,
    ...overrides
  };
}

function githubBlockerRow() {
  return {
    reviewId: "github-exhaustive-target:fixture",
    category: "github_exhaustive_target_terminal_blocker",
    attributionTaskKeys: ["TEST:founder:founder-ada:https://github.com/ada/repo"],
    publicationState: "stored_but_unpublished",
    scoringEligible: false
  };
}

function scope(rows, entityType, entityId, platform) {
  const row = rows.find((candidate) =>
    candidate.entityType === entityType &&
    candidate.entityId === entityId &&
    candidate.platform === platform
  );
  assert.ok(row);
  return row;
}

function expectedManifest(catalogs) {
  return {
    version: INGESTION_CATALOG_MANIFEST_VERSION,
    batches: catalogs.map((catalog) => ({
      batchSlug: catalog.batchSlug,
      sourcePath: catalog.sourcePath,
      sourceVersion: catalog.sourceVersion,
      sourceHash: computeIngestionCatalogSourceHash(catalog),
      companies: catalog.companies.length,
      founders: catalog.companies.reduce((sum, company) => sum + company.founders.length, 0),
      entities: catalog.companies.reduce(
        (sum, company) => sum + company.founders.length + 1,
        0
      )
    }))
  };
}

function ndjsonBody(rows) {
  return rows.map((row) => stableJson(row)).join("\n") + "\n";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
