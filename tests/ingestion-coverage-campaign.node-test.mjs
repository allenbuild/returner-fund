import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  INGESTION_COVERAGE_CAMPAIGN_VERSION,
  loadIngestionCoverageCampaign
} from "../scripts/lib/ingestion-coverage-campaign.mjs";
import {
  materializeIngestionCoverage
} from "../scripts/lib/ingestion-coverage-materializer.mjs";
import {
  INGESTION_CATALOG_MANIFEST_VERSION
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

function sourceCatalogs({ withHistoricalDepth = false } = {}) {
  return [{
    slug: "TEST",
    sourcePath: "fixtures/test-catalog.json",
    generatedAt: "2026-08-02T18:00:00.000Z",
    companies: [{
      sourceKey: "company-acme",
      name: "Acme",
      websiteUrl: "https://acme.example",
      accounts: withHistoricalDepth ? [{
        platform: "product_hunt",
        url: "https://www.producthunt.com/products/acme",
        verified: true,
        verificationStatus: "verified"
      }] : [],
      founders: []
    }]
  }];
}

function expectedManifest(catalogs) {
  const normalized = normalizeAutonomousIngestionCatalogs(catalogs);
  return {
    version: INGESTION_CATALOG_MANIFEST_VERSION,
    batches: normalized.map((catalog) => ({
      batchSlug: catalog.batchSlug,
      sourcePath: catalog.sourcePath,
      sourceVersion: catalog.sourceVersion,
      sourceHash: catalog.sourceHash,
      companies: 1,
      founders: 0,
      entities: 1
    }))
  };
}

async function createCampaignFixture({
  withHistorical = false,
  withHistoricalDepth = false
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "ingestion-coverage-campaign-"));
  const catalogs = sourceCatalogs({ withHistoricalDepth });
  const files = {
    catalogs: await writeArtifact(root, "catalogs.json", JSON.stringify(catalogs)),
    expected: await writeArtifact(
      root,
      "expected-manifest.json",
      JSON.stringify(expectedManifest(catalogs))
    ),
    tasks: await writeArtifact(root, "tasks.ndjson", `${JSON.stringify({
      batchSlug: "TEST",
      companySourceKey: "company-acme",
      entityType: "company",
      entitySourceKey: "company-acme",
      platform: "x",
      account: null,
      checkpointKey: "run:TEST:company:company-acme:x:discovery",
      status: "queued",
      terminalReason: null
    })}\n`),
    runner: await writeArtifact(root, "runner.ndjson", [
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
    ].map((row) => JSON.stringify(row)).join("\n") + "\n"),
    public: await writeArtifact(root, "public.json", JSON.stringify({
      source: { batchSlug: "TEST", fetchedAt: CHECKED_AT },
      attempts: {},
      evidence: [],
      needsReview: [],
      failures: []
    }))
  };
  const manifest = {
    schemaVersion: INGESTION_COVERAGE_CAMPAIGN_VERSION,
    runId: "run-campaign-test",
    idempotencyKey: "idempotency-campaign-test",
    campaignKey: "campaign-test",
    generatedAt: GENERATED_AT,
    manifestObservedAt: GENERATED_AT,
    artifacts: {
      catalogs: descriptor(files.catalogs, GENERATED_AT, "json"),
      expectedCatalogManifest: descriptor(files.expected, GENERATED_AT, "json"),
      taskPlan: descriptor(files.tasks, GENERATED_AT, "ndjson"),
      runnerLog: descriptor(files.runner, GENERATED_AT, "ndjson"),
      collectors: [{
        kind: "public",
        ...descriptor(files.public, CHECKED_AT, "json")
      }]
    }
  };
  if (withHistorical) {
    const historyDir = join(root, "history");
    let tick = 0;
    await runHistoricalBackfill({
      outputDir: historyDir,
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
      limits: { hostPaceMs: 0, requestAttempts: 1 },
      now: () => new Date(Date.parse(STARTED_AT) + tick++ * 1_000),
      fetch: async () => new Response(JSON.stringify({
        hits: [{
          objectID: "campaign-history-42",
          title: "Acme campaign history",
          url: "https://acme.example/history",
          created_at: "2026-04-01T12:00:00.000Z",
          author: "fixture-author"
        }],
        nbPages: 1
      }), { headers: { "content-type": "application/json" } })
    });
    const historyPath = join(historyDir, "pages.ndjson");
    const historyBytes = await readFile(historyPath);
    const events = historyBytes.toString("utf8").trimEnd().split("\n").map(JSON.parse);
    manifest.artifacts.historicalBackfills = [{
      journal: descriptor({
        name: "history/pages.ndjson",
        path: historyPath,
        sha256: createHash("sha256").update(historyBytes).digest("hex")
      }, events.at(-1).recordedAt, "ndjson"),
      limits: { maxEvents: 100 }
    }];
  }
  if (withHistoricalDepth) {
    const depthDir = join(root, "historical-depth");
    let tick = 0;
    await runHistoricalDepthBackfill({
      outputDir: depthDir,
      catalogs,
      platforms: ["product_hunt"],
      limits: { hostPaceMs: 0, redditPaceMs: 0, requestAttempts: 1 },
      now: () => new Date(Date.parse(STARTED_AT) + tick++ * 1_000)
    });
    const depthPath = join(depthDir, "pages.ndjson");
    const depthBytes = await readFile(depthPath);
    const depthEvents = depthBytes.toString("utf8").trimEnd().split("\n").map(JSON.parse);
    manifest.artifacts.historicalDepthBackfills = [{
      journal: descriptor({
        name: "historical-depth/pages.ndjson",
        path: depthPath,
        sha256: createHash("sha256").update(depthBytes).digest("hex")
      }, depthEvents.at(-1).recordedAt, "ndjson"),
      limits: { maxEvents: 100 }
    }];
  }
  const manifestPath = join(root, "campaign.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, manifestPath, files };
}

async function writeArtifact(root, name, body) {
  const path = join(root, name);
  await writeFile(path, body);
  return {
    name,
    path,
    sha256: createHash("sha256").update(body).digest("hex")
  };
}

function descriptor(file, observedAt, format) {
  return {
    path: file.name,
    sha256: file.sha256,
    observedAt,
    format
  };
}

describe("ingestion coverage campaign loader and CLI", () => {
  it("authenticates every declared file and loads collectors one at a time", async (t) => {
    const fixture = await createCampaignFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const campaign = await loadIngestionCoverageCampaign(fixture.manifestPath);
    const result = await materializeIngestionCoverage(campaign.materializerInput);

    assert.equal(result.runId, "run-campaign-test");
    assert.equal(result.objectiveComplete, false);
    assert.equal(result.provenance.inputArtifacts.length, 6);
    assert.equal(result.fullIngestionCoverageStatus.denominator.corePairs, 10);
  });

  it("rejects modified bytes before adapting any collector rows", async (t) => {
    const fixture = await createCampaignFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    await writeFile(fixture.files.catalogs.path, JSON.stringify([{ tampered: true }]));

    await assert.rejects(
      loadIngestionCoverageCampaign(fixture.manifestPath),
      /catalogs.sha256 does not match/
    );
  });

  it("passes a hash-pinned historical journal through the production CLI loader", async (t) => {
    const fixture = await createCampaignFixture({ withHistorical: true });
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const campaign = await loadIngestionCoverageCampaign(fixture.manifestPath);
    const result = await materializeIngestionCoverage(campaign.materializerInput);
    const pair = result.coverageReceipt.pairs.find((candidate) =>
      candidate.pairKey === "TEST:company:company-acme:hacker_news"
    );

    assert.equal(pair.terminal.status, "collected");
    assert.equal(pair.evidence.historicalPostCount, 1);
    assert.equal(result.historicalCoverage.runs.length, 1);
    assert.equal(result.provenance.inputArtifacts.length, 7);
  });

  it("passes a hash-pinned historical-depth journal into the fail-closed matrix", async (t) => {
    const fixture = await createCampaignFixture({ withHistoricalDepth: true });
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const campaign = await loadIngestionCoverageCampaign(fixture.manifestPath);
    const result = await materializeIngestionCoverage(campaign.materializerInput);
    const pair = result.coverageReceipt.pairs.find((candidate) =>
      candidate.pairKey === "TEST:company:company-acme:product_hunt"
    );

    assert.equal(campaign.materializerInput.historicalDepthBackfills.length, 1);
    assert.equal(pair.terminal.status, "queued");
    assert.equal(pair.terminal.reasonCode, "missing_credentials");
    assert.equal(result.historicalDepthCoverage.runs.length, 1);
    assert.equal(
      result.historicalDepthCoverage.runs[0].coverageSummary.ownerPlatformPairsEvaluated,
      1
    );
    assert.equal(result.provenance.inputArtifacts.length, 7);
  });

  it("writes the measured matrix but exits 2 by default when objective proof is incomplete", async (t) => {
    const fixture = await createCampaignFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const outputPath = join(fixture.root, "coverage.json");
    const run = spawnSync(process.execPath, [
      "scripts/materialize-ingestion-coverage.mjs",
      `--manifest=${fixture.manifestPath}`,
      `--output=${outputPath}`,
      "--unresolved-preview-limit=2"
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(run.status, 2, run.stderr);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.objectiveComplete, false);
    assert.equal(output.productionReleaseStatus.status, "incomplete");
    assert.equal(output.fullIngestionCoverageStatus.unresolved.preview.length, 2);
    assert.match(run.stderr, /ingestion_coverage\.materialized/);
  });
});
