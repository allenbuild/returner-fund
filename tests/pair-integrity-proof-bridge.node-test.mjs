import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildPairIntegrityProofBridge } from
  "../scripts/lib/pair-integrity-proof-bridge.mjs";
import { buildStoredUnpublishedCoverageBridge } from
  "../scripts/lib/stored-unpublished-coverage-bridge.mjs";
import { normalizeAutonomousIngestionCatalogs } from
  "../scripts/lib/ingestion-coverage-adapter.mjs";
import {
  INGESTION_CATALOG_MANIFEST_VERSION,
  buildIngestionCoverageReceipt,
  computeIngestionCatalogSourceHash
} from "../scripts/lib/ingestion-coverage-receipt.mjs";

const STORED_AT = "2026-08-03T03:00:00.000Z";
const SCORING_AT = "2026-08-03T03:05:00.000Z";
const GENERATED_AT = "2026-08-03T03:10:00.000Z";
const WEIGHTED = [
  "bilibili",
  "github",
  "hacker_news",
  "instagram",
  "linkedin",
  "product_hunt",
  "reddit",
  "x",
  "youtube"
];

describe("four-dimension pair integrity proof bridge", () => {
  it("preserves stored receipts and verifies only exact evaluated dimensions", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const outputDir = join(fixture.root, "integrity-proof");
    const result = await runBridge(fixture, { outputDir });

    assert.equal(result.denominator.canonicalPairs, 26);
    assert.deepEqual(result.summary.dimensions, {
      duplicates: { verified: 26, unverified: 0, evaluated: 26, unevaluated: 0 },
      attribution: { verified: 23, unverified: 3, evaluated: 26, unevaluated: 0 },
      timestamps: { verified: 25, unverified: 1, evaluated: 26, unevaluated: 0 },
      scoring: { verified: 9, unverified: 17, evaluated: 9, unevaluated: 17 }
    });
    const rows = JSON.parse(await readFile(join(outputDir, "pair-scopes.json"), "utf8"));
    const companyGithub = pair(rows, "company", "company-acme", "github");
    const founderGithub = pair(rows, "founder", "founder-ada", "github");
    const companyX = pair(rows, "company", "company-acme", "x");
    const founderX = pair(rows, "founder", "founder-ada", "x");
    assert.equal(companyGithub.scope.storedUnpublishedReceipt.status, "complete");
    assert.equal(companyGithub.scope.integrityChecks.duplicates.verified, true);
    assert.equal(companyGithub.scope.integrityChecks.attribution.verified, false);
    assert.equal(founderGithub.scope.integrityChecks.attribution.verified, false);
    assert.equal(companyGithub.scope.integrityChecks.timestamps.verified, false);
    assert.equal(companyX.scope.integrityChecks.scoring.verified, true);
    assert.equal(founderX.scope.integrityChecks.scoring.verified, false);
    assert.equal(founderX.scope.integrityChecks.scoring.evaluated, false);
    assert.ok(rows.every((row) => Object.values(row.scope.integrityChecks).every((check) =>
      /^[a-f0-9]{64}$/.test(check.artifactDigest) &&
      /^[a-f0-9]{64}$/.test(check.dependencyHash) &&
      check.checkedAt === GENERATED_AT
    )));

    const catalogs = normalizeAutonomousIngestionCatalogs(fixture.catalogs);
    const receipt = buildIngestionCoverageReceipt({
      runId: "integrity-fixture",
      run: {
        idempotencyKey: "integrity-fixture",
        campaignKey: "integrity-fixture",
        startedAt: STORED_AT,
        completedAt: GENERATED_AT
      },
      generatedAt: GENERATED_AT,
      catalogs,
      expectedCatalogManifest: expectedManifest(catalogs),
      pairScopes: rows
    });
    assert.equal(receipt.pairs.length, 26);
    assert.equal(receipt.pairs.filter((row) => row.scope.scoringVerified).length, 9);
  });

  it("rejects a scoring diagnostic after any hash-pinned input changes", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    await writeFile(fixture.scoringInputPath, "changed after recomputation\n");
    await assert.rejects(runBridge(fixture, { dryRun: true }), /changed after recomputation/);
  });

  it("rejects a scoring diagnostic that omits one exact company-platform slice", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const audit = JSON.parse(await readFile(fixture.scoringAuditPath, "utf8"));
    audit.cohorts[0].scoring.before_vs_after_by_platform.pop();
    await writeFile(fixture.scoringAuditPath, `${JSON.stringify(audit)}\n`);
    await assert.rejects(runBridge(fixture, { dryRun: true }), /exact nine-platform comparison/);
  });

  it("keeps every attribution pair false when a scoring finding cannot be scoped", async (t) => {
    const fixture = await createFixture({ unscopedAttributionFinding: true });
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const result = await runBridge(fixture, { dryRun: true });
    assert.deepEqual(result.summary.dimensions.attribution, {
      verified: 0,
      unverified: 26,
      evaluated: 26,
      unevaluated: 0
    });
    assert.equal(result.globalFindings.attribution.length, 1);
  });

  it("rejects a modified stored-source proof instead of trusting rewritten ledger pins", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const manifest = JSON.parse(await readFile(fixture.storedManifestPath, "utf8"));
    manifest.sources.historical.ledgerRows += 1;
    await writeFile(fixture.storedManifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(runBridge(fixture, { dryRun: true }), /source proof no longer matches/);
  });

  it("requires the existing production artifact validator to pass", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    await assert.rejects(
      runBridge(fixture, {
        dryRun: true,
        productionValidator: async () => ({ status: "failed" })
      }),
      /did not return status=ok/
    );
  });
});

async function createFixture({ unscopedAttributionFinding = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pair-integrity-proof-"));
  const historicalDir = join(root, "historical");
  const githubDir = join(root, "github");
  const storedDir = join(root, "stored");
  await Promise.all([mkdir(historicalDir), mkdir(githubDir)]);
  const catalogs = fixtureCatalogs();

  const historicalRows = [historicalRow()];
  const historicalBody = ndjson(historicalRows);
  const historicalLedgerPath = join(historicalDir, "historical-stored-unpublished.ndjson");
  await writeFile(historicalLedgerPath, historicalBody);
  const historicalManifestPath = join(historicalDir, "staging-manifest.json");
  await writeFile(historicalManifestPath, `${JSON.stringify({
    schemaVersion: "historical-publication-staging.v1",
    status: "staged",
    publicationStatus: "stored_but_unpublished",
    stagedAt: "2026-08-03T02:31:00.000Z",
    counts: { storedButUnpublished: 1 },
    artifacts: {
      storedUnpublished: {
        path: "historical-stored-unpublished.ndjson",
        format: "ndjson",
        rows: 1,
        bytes: Buffer.byteLength(historicalBody),
        sha256: sha256(historicalBody),
        observedAt: "2026-08-03T02:31:00.000Z"
      }
    }
  })}\n`);

  const githubRows = [githubSharedRow()];
  const githubBody = ndjson(githubRows);
  const githubLedgerPath = join(githubDir, "github-exhaustive-stored-evidence-review.ndjson");
  await writeFile(githubLedgerPath, githubBody);
  const githubCore = {
    schemaVersion: 1,
    status: "staged_not_published",
    productionEligible: false,
    generatedAt: "2026-08-03T02:36:48.781Z",
    denominators: {
      companiesEvaluated: 1,
      foundersEvaluated: 1,
      canonicalOwnersEvaluated: 2
    },
    evidence: { storedEvidenceReviewRows: 1 },
    outputs: {
      storedEvidenceReview: {
        filename: "github-exhaustive-stored-evidence-review.ndjson",
        rowCount: 1,
        sha256: sha256(githubBody),
        publicationState: "stored_but_unpublished",
        scoringEligible: false
      }
    }
  };
  const githubReceiptPath = join(githubDir, "github-exhaustive-integration-receipt.json");
  await writeFile(githubReceiptPath, `${JSON.stringify({
    ...githubCore,
    receiptSha256: sha256(stableJson(githubCore))
  })}\n`);

  await buildStoredUnpublishedCoverageBridge({
    root,
    historicalManifestPath,
    githubReceiptPath,
    outputDir: storedDir,
    generatedAt: STORED_AT,
    expectedPairCount: 26,
    catalogs,
    maxInputBytes: 8 * 1024 * 1024
  });

  const scoringInputPath = join(root, "scoring-input.txt");
  const scoringInputBody = "exact scoring input\n";
  await writeFile(scoringInputPath, scoringInputBody);
  const scoringAuditPath = join(root, "scoring-audit.json");
  const scoringAudit = fixtureScoringAudit({
    scoringInputBody,
    unscopedAttributionFinding
  });
  await writeFile(scoringAuditPath, `${JSON.stringify(scoringAudit)}\n`);
  await writeFile(join(root, "production.json"), "{}\n");
  await writeFile(join(root, "dependency.mjs"), "export const fixture = true;\n");

  return {
    root,
    catalogs,
    storedManifestPath: join(storedDir, "stored-unpublished-coverage-manifest.json"),
    scoringAuditPath,
    scoringInputPath
  };
}

function runBridge(fixture, overrides = {}) {
  return buildPairIntegrityProofBridge({
    root: fixture.root,
    storedCoverageManifestPath: fixture.storedManifestPath,
    scoringAuditPath: fixture.scoringAuditPath,
    outputDir: overrides.outputDir,
    generatedAt: GENERATED_AT,
    dryRun: overrides.dryRun ?? false,
    expectedPairCount: 26,
    catalogs: fixture.catalogs,
    maxInputBytes: 8 * 1024 * 1024,
    dependencyPaths: Object.fromEntries([
      "duplicates",
      "attribution",
      "timestamps",
      "scoring"
    ].map((dimension) => [dimension, ["dependency.mjs"]])),
    productionArtifactPaths: ["production.json"],
    productionValidator: overrides.productionValidator ?? (async () => ({
      status: "ok",
      scoringModel: "returner-traction@4.2.0"
    }))
  });
}

function fixtureScoringAudit({ scoringInputBody, unscopedAttributionFinding }) {
  const inputEntry = {
    path: "scoring-input.txt",
    bytes: Buffer.byteLength(scoringInputBody),
    sha256: sha256(scoringInputBody)
  };
  const ranked = [{
    rank: 1,
    company_id: "company-acme",
    company_name: "Acme Labs",
    score: 0,
    top_platform: null,
    scored_evidence_rows: 0,
    platforms_with_evidence: 0
  }];
  const slices = WEIGHTED.map((platform) => ({
    platform,
    score_before: { ranked_companies: ranked },
    score_after: { ranked_companies: ranked }
  }));
  const observations = WEIGHTED.map((platform) => ({
    platform,
    before: completeRankObservation(),
    after: completeRankObservation()
  }));
  const attributionFinding = unscopedAttributionFinding
    ? {
        audit_key: "TEST:unknown",
        entity_id: "unknown-owner",
        owner_company_ids: [],
        platform: "x",
        reason: "not_verified"
      }
    : {
        audit_key: "TEST:founder-x",
        entity_id: "founder-ada",
        owner_company_ids: [],
        platform: "x",
        reason: "not_verified"
      };
  return {
    metadata: {
      report_version: "scoring-diagnostics-v4",
      generated_at: SCORING_AT,
      production_model_id: "returner-traction",
      production_model_version: "4.2.0",
      input_hashes: {
        file_count: 1,
        files: [inputEntry],
        combined_sha256: sha256(`scoring-input.txt\0${inputEntry.sha256}\n`),
        versioned_scoring_inputs: { combined_sha256: sha256("versioned fixture") }
      }
    },
    global_summary: { company_count: 1 },
    invariants: { all_passed: true, check_count: 1, passed_count: 1, violation_count: 0 },
    cohorts: [{
      cohort: "TEST",
      input_counts: { companies: 1, founders: 1 },
      eligibility_rejections: { findings: [attributionFinding] },
      missing_data: {
        findings: [{
          audit_key: "TEST:company-github",
          entity_id: "company-acme",
          owner_company_ids: ["company-acme"],
          platform: "github",
          issue: "publication_date_precision_unknown"
        }]
      },
      canonical_duplicates: {},
      scoring: { before_vs_after_by_platform: slices },
      invariant_observations: {
        platform_rank_observations: observations,
        eligible_company_physical_duplicate_groups: []
      }
    }]
  };
}

function completeRankObservation() {
  return {
    row_count: 1,
    expected_row_count: 1,
    duplicate_company_id_count: 0,
    missing_company_ids: [],
    unexpected_company_ids: [],
    non_finite_score_count: 0,
    out_of_bounds_score_count: 0
  };
}

function fixtureCatalogs() {
  return [{
    slug: "TEST",
    sourcePath: "fixture.json",
    generatedAt: "2026-08-03T02:00:00.000Z",
    companies: [{
      sourceKey: "company-acme",
      name: "Acme Labs",
      accounts: [],
      founders: [{ sourceKey: "founder-ada", name: "Ada Founder", accounts: [] }]
    }]
  }];
}

function historicalRow() {
  return {
    id: "historical-fixture",
    batchSlug: "TEST",
    entityType: "company",
    entityId: "company-acme",
    platform: "web",
    nativeId: "web:https://acme.example/history",
    historicalDigest: sha256("historical fixture"),
    historicalTargetKey: "TEST:company-acme:web",
    publishedAt: "2026-06-01T00:00:00.000Z",
    first_seen_at: "2026-08-03T02:30:00.000Z",
    publicationPolicy: "stored_but_unpublished",
    historicalValidationStatus: "pending_publication_validation",
    review_state: "needs_review"
  };
}

function githubSharedRow() {
  return {
    reviewId: "github-exhaustive-evidence:fixture",
    category: "github_exhaustive_content_stored_unpublished",
    contentIdentity: { evidenceId: "github:commit:1:abc", kind: "github_commit" },
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
    publishedAt: "2026-06-01T00:00:00.000Z",
    observedAt: "2026-08-03T02:30:00.000Z",
    publicationState: "stored_but_unpublished",
    scoringEligible: false
  };
}

function pair(rows, entityType, entityId, platform) {
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
    batches: catalogs.map((catalog) => {
      const founders = catalog.companies.reduce((sum, company) => sum + company.founders.length, 0);
      return {
        batchSlug: catalog.batchSlug,
        sourcePath: catalog.sourcePath,
        sourceVersion: catalog.sourceVersion,
        sourceHash: computeIngestionCatalogSourceHash(catalog),
        companies: catalog.companies.length,
        founders,
        entities: catalog.companies.length + founders
      };
    })
  };
}

function ndjson(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
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
