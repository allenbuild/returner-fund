import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AUTONOMOUS_COVERAGE_BATCH_LAYOUT,
  prepareIngestionCoverageCampaign
} from "../scripts/lib/prepare-ingestion-coverage-campaign.mjs";
import {
  loadIngestionCoverageCampaign
} from "../scripts/lib/ingestion-coverage-campaign.mjs";
import {
  materializeIngestionCoverage
} from "../scripts/lib/ingestion-coverage-materializer.mjs";
import {
  INGESTION_CORE_PLATFORMS,
  INGESTION_EXTENDED_ONLY_PLATFORMS
} from "../scripts/lib/ingestion-coverage-receipt.mjs";
import {
  runHistoricalBackfill
} from "../scripts/lib/historical-backfill.mjs";
import {
  runHistoricalDepthBackfill
} from "../scripts/lib/historical-depth-backfill.mjs";

const STARTED_AT = "2026-08-02T18:20:00.000Z";
const CHECKED_AT = "2026-08-02T18:29:00.000Z";
const MATERIALIZED_AT = "2026-08-02T18:31:00.000Z";
const TEST_LAYOUT = [{ slug: "TEST", publicShards: 1, githubShards: 1 }];

describe("ingestion coverage campaign preparer", () => {
  it("stays bound to the autonomous runner's exact production shard matrix", async () => {
    assert.deepEqual(AUTONOMOUS_COVERAGE_BATCH_LAYOUT, [
      { slug: "S2026", publicShards: 4, githubShards: 4 },
      { slug: "S26", publicShards: 2, githubShards: 2 },
      { slug: "A16ZSR006", publicShards: 1, githubShards: 1 }
    ]);
    const runner = await readFile(
      new URL("../scripts/run-autonomous-ingestion.mjs", import.meta.url),
      "utf8"
    );
    assert.deepEqual(shardTable(runner, "PUBLIC_COLLECTOR_SHARDS"), {
      S2026: 4,
      S26: 2,
      A16ZSR006: 1
    });
    assert.deepEqual(shardTable(runner, "GITHUB_COLLECTOR_SHARDS"), {
      S2026: 4,
      S26: 2,
      A16ZSR006: 1
    });
  });

  it("builds a deterministic hash-pinned package and materializes the full task denominator", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const firstOutput = join(fixture.root, "packages", "prepared-a");
    const secondOutput = join(fixture.root, "packages", "prepared-b");

    const first = await prepareFixture(fixture, firstOutput);
    const second = await prepareFixture(fixture, secondOutput);
    assert.equal(first.tasks, 13);
    assert.equal(first.collectors, 2);
    assert.equal(first.historicalIncluded, false);
    assert.equal(first.historicalDepthIncluded, false);
    assert.equal(first.coverageGeneratedAt, CHECKED_AT);
    assert.equal(first.recentCoverageCutoff, STARTED_AT);
    assert.equal(
      await readFile(first.manifestPath, "utf8"),
      await readFile(second.manifestPath, "utf8"),
      "explicit timestamps and relative paths make the package manifest deterministic"
    );

    const manifest = JSON.parse(await readFile(first.manifestPath, "utf8"));
    assert.equal(manifest.schemaVersion, "ingestion-coverage-campaign.v1");
    assert.equal("releaseProofs" in manifest.artifacts, false);
    assert.equal("pairScopes" in manifest.artifacts, false);
    assert.equal("multiAttributionReviews" in manifest.artifacts, false);
    assert.equal("historicalBackfills" in manifest.artifacts, false);
    assert.equal(manifest.artifacts.collectors.length, 2);
    assert.equal(manifest.artifacts.supporting.length, 5);
    for (const descriptor of allDescriptors(manifest.artifacts)) {
      const bytes = await readFile(join(firstOutput, descriptor.path));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), descriptor.sha256);
    }

    const taskRows = (await readFile(join(firstOutput, "generated/task-plan.ndjson"), "utf8"))
      .trimEnd().split("\n").map(JSON.parse);
    assert.equal(taskRows.length, 13);
    assert.equal(new Set(taskRows.map((task) => task.checkpointKey)).size, 13);

    const campaign = await loadIngestionCoverageCampaign(first.manifestPath);
    const materialized = await materializeIngestionCoverage(campaign.materializerInput);
    assert.equal(materialized.objectiveComplete, false);
    assert.equal(materialized.productionReleaseStatus.status, "incomplete");
    assert.equal(materialized.fullIngestionCoverageStatus.denominator.corePairs, 10);
    assert.equal(materialized.coverageReceipt.inventory.companies, 1);
    assert.equal(materialized.coverageReceipt.inventory.founders, 0);
    assert.equal(materialized.coverageReceipt.run.recentCoverageCutoff, STARTED_AT);
    assert.equal(
      materialized.coverageReceipt.recencyPolicy.cutoffAt,
      "2026-05-04T18:20:00.000Z"
    );
    assert.equal(campaign.provenance.inputArtifacts.length, 12);
  });

  it("fails closed when an exact checkpoint is absent and removes its temporary package", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    await rm(join(fixture.campaignDir, "checkpoint-public-test-shard-0-of-1.json"));
    const outputDir = join(fixture.root, "prepared-missing-checkpoint");

    await assert.rejects(
      prepareFixture(fixture, outputDir),
      /checkpoint-public-test-shard-0-of-1\.json/
    );
    await assert.rejects(access(outputDir));
  });

  it("copies only hash-pinned recent-window request journals declared by merged attempts", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const attemptKey = "x:company:company-acme:https://x.com/acme";
    const pairKey = "TEST:company:company-acme:x";
    const journalPath = "recent-window-journals/shard-0/x-acme.ndjson";
    const journalBody = `${JSON.stringify({
      schemaVersion: "recent-native-page-receipt.v1",
      sequence: 1,
      attemptKey,
      pairKey,
      requestedAt: STARTED_AT,
      completedAt: CHECKED_AT,
      requestUrl: "https://api.x.com/2/tweets/search/recent?query=from%3Aacme",
      status: "success",
      cursorIn: null,
      cursorOut: null,
      sourceExhausted: true,
      responseSha256: "a".repeat(64),
      coverageFrom: "2026-05-04T18:20:00.000Z",
      coverageThrough: STARTED_AT
    })}\n`;
    const journalSha256 = createHash("sha256").update(journalBody).digest("hex");
    await mkdir(join(fixture.campaignDir, "recent-window-journals/shard-0"), {
      recursive: true
    });
    await writeFile(join(fixture.campaignDir, journalPath), journalBody);
    const snapshot = publicSnapshot();
    snapshot.attempts[attemptKey].recentWindowCoverageCutoff = STARTED_AT;
    snapshot.attempts[attemptKey].recentWindowProof = {
      schemaVersion: "recent-native-window-proof.v1",
      status: "complete",
      coverageScope: "pair_all_native_targets",
      coveredFrom: "2026-05-04T18:20:00.000Z",
      coveredThrough: STARTED_AT,
      checkedAt: CHECKED_AT,
      sourceExhausted: true,
      nextCursor: null,
      truncated: false,
      limitReached: false,
      pageLimit: 2,
      pagesAttempted: 1,
      pagesFetched: 1,
      blockers: [],
      requestJournal: {
        path: journalPath,
        sha256: journalSha256,
        observedAt: CHECKED_AT
      }
    };
    await Promise.all([
      "public-test.json",
      "public-test-shard-0-of-1.json",
      "checkpoint-public-test-shard-0-of-1.json"
    ].map((file) => writeJson(join(fixture.campaignDir, file), snapshot)));

    const outputDir = join(fixture.root, "prepared-with-recent-window-journal");
    const result = await prepareFixture(fixture, outputDir);
    assert.equal(await readFile(join(outputDir, journalPath), "utf8"), journalBody);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const descriptor = manifest.artifacts.supporting.find((row) => row.path === journalPath);
    assert.equal(descriptor.sha256, journalSha256);

    await writeFile(join(fixture.campaignDir, journalPath), "{}\n");
    await assert.rejects(
      prepareFixture(fixture, join(fixture.root, "prepared-tampered-recent-window-journal")),
      /recent-window journal .* sha256 mismatch/
    );
  });

  it("rejects a merged snapshot older than an explicitly required shard attempt", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    await writeJson(
      join(fixture.campaignDir, "public-test-shard-0-of-1.json"),
      publicSnapshot({
        startedAt: "2026-08-02T18:29:30.000Z",
        checkedAt: "2026-08-02T18:30:00.000Z"
      })
    );

    await assert.rejects(
      prepareFixture(fixture, join(fixture.root, "prepared-stale-merged")),
      /Merged collector output is older than public TEST shard 0 attempt/
    );
  });

  it("includes a historical journal only after run_completed and validates the bridge", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const historyDir = join(fixture.root, "historical-complete");
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
          objectID: "historical-acme-1",
          title: "Acme launches its historical archive",
          url: "https://acme.example/history",
          created_at: "2026-04-01T12:00:00.000Z",
          author: "fixture"
        }],
        nbPages: 1
      }), { headers: { "content-type": "application/json" } })
    });

    const outputDir = join(fixture.root, "prepared-with-history");
    const result = await prepareFixture(fixture, outputDir, {
      historicalJournalPath: join(historyDir, "pages.ndjson")
    });
    assert.equal(result.historicalIncluded, true);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.artifacts.historicalBackfills.length, 1);
    assert.equal("completionProofs" in manifest.artifacts.historicalBackfills[0], false);

    const campaign = await loadIngestionCoverageCampaign(result.manifestPath);
    const materialized = await materializeIngestionCoverage(campaign.materializerInput);
    const pair = materialized.coverageReceipt.pairs.find((candidate) =>
      candidate.pairKey === "TEST:company:company-acme:hacker_news"
    );
    assert.equal(pair.evidence.historicalPostCount, 1);
    assert.equal(materialized.historicalCoverage.runs.length, 1);
  });

  it("packages and validates a completed historical-depth journal", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    fixture.catalogs[0].companies[0].accounts.push(
      account(
        "product_hunt",
        "https://www.producthunt.com/products/acme",
        "acme"
      )
    );
    const depthDir = join(fixture.root, "historical-depth-complete");
    let tick = 0;
    await runHistoricalDepthBackfill({
      outputDir: depthDir,
      catalogs: fixture.catalogs,
      platforms: ["product_hunt"],
      limits: { hostPaceMs: 0, redditPaceMs: 0, requestAttempts: 1 },
      now: () => new Date(Date.parse(STARTED_AT) + tick++ * 1_000)
    });

    const outputDir = join(fixture.root, "prepared-with-historical-depth");
    const result = await prepareFixture(fixture, outputDir, {
      historicalDepthJournalPath: join(depthDir, "pages.ndjson")
    });
    assert.equal(result.historicalDepthIncluded, true);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.artifacts.historicalDepthBackfills.length, 1);
    assert.equal(
      manifest.artifacts.historicalDepthBackfills[0].journal.path,
      "historical-depth/pages.ndjson"
    );
    const campaign = await loadIngestionCoverageCampaign(result.manifestPath);
    const materialized = await materializeIngestionCoverage(campaign.materializerInput);
    assert.equal(materialized.historicalDepthCoverage.runs.length, 1);
    assert.equal(
      materialized.historicalDepthCoverage.runs[0].coverageSummary
        .ownerPlatformPairsEvaluated,
      1
    );
  });

  it("packages only an explicitly named full pair-scope matrix and preserves surfaced counts", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const sourcePath = join(fixture.campaignDir, "pair-scopes.json");
    const pairScopes = fixtureStoredPairScopes();
    await writeJson(sourcePath, pairScopes);

    const unboundOutput = join(fixture.root, "prepared-with-unbound-pair-scopes");
    const unbound = await prepareFixture(fixture, unboundOutput);
    const unboundManifest = JSON.parse(await readFile(unbound.manifestPath, "utf8"));
    assert.equal(
      "pairScopes" in unboundManifest.artifacts,
      false,
      "the preparer must not discover pair scopes from the campaign directory"
    );

    const outputDir = join(fixture.root, "prepared-with-pair-scopes");
    const result = await prepareFixture(fixture, outputDir, {
      pairScopesPath: sourcePath
    });
    assert.equal(result.pairScopesIncluded, true);
    assert.equal(result.pairScopes, 13);
    assert.equal(result.coverageGeneratedAt, CHECKED_AT);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.artifacts.pairScopes.path, "coverage/pair-scopes.json");
    const packagedBytes = await readFile(
      join(outputDir, manifest.artifacts.pairScopes.path)
    );
    assert.equal(
      createHash("sha256").update(packagedBytes).digest("hex"),
      manifest.artifacts.pairScopes.sha256
    );

    const campaign = await loadIngestionCoverageCampaign(result.manifestPath);
    const materialized = await materializeIngestionCoverage(campaign.materializerInput);
    const xPair = materialized.coverageReceipt.pairs.find((pair) =>
      pair.pairKey === "TEST:company:company-acme:x"
    );
    assert.deepEqual(
      xPair.scope.receipts.storedUnpublished.surfacedCounts,
      pairScopes.find((row) => row.platform === "x")
        .scope.storedUnpublishedReceipt.surfacedCounts
    );
    assert.equal(
      xPair.scope.receipts.storedUnpublished.publicationPolicy,
      "proof_only_no_publication"
    );

    await writeFile(
      join(outputDir, manifest.artifacts.pairScopes.path),
      Buffer.concat([packagedBytes, Buffer.from("\n")])
    );
    await assert.rejects(
      loadIngestionCoverageCampaign(result.manifestPath),
      /pairScopes\.sha256 does not match/
    );

    await writeJson(sourcePath, pairScopes.slice(1));
    await assert.rejects(
      prepareFixture(fixture, join(fixture.root, "prepared-partial-pair-scopes"), {
        pairScopesPath: sourcePath
      }),
      /exact canonical matrix; received 12\/13 rows/
    );
  });

  it("rejects an unfinished historical journal instead of inferring success from its directory", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const journal = join(fixture.root, "unfinished.ndjson");
    await writeFile(journal, `${JSON.stringify({
      type: "run_initialized",
      sequence: 1,
      startedAt: STARTED_AT,
      recordedAt: STARTED_AT
    })}\n`);

    await assert.rejects(
      prepareFixture(fixture, join(fixture.root, "prepared-unfinished"), {
        historicalJournalPath: journal
      }),
      /Historical journal is not complete/
    );
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "prepare-ingestion-coverage-"));
  const campaignDir = join(root, "campaign");
  await Promise.all([
    mkdir(campaignDir, { recursive: true }),
    mkdir(join(root, "fixtures"), { recursive: true }),
    mkdir(join(root, "src/lib/social"), { recursive: true })
  ]);
  await Promise.all([
    writeJson(join(root, "fixtures/test-catalog.json"), { fixture: "canonical catalog bytes" }),
    writeJson(join(root, "src/lib/social/verified-social-overrides.json"), {})
  ]);
  const catalogs = fixtureCatalogs();
  const publicValue = publicSnapshot();
  const githubValue = githubSnapshot();
  await Promise.all([
    writeJson(join(campaignDir, "public-test.json"), publicValue),
    writeJson(join(campaignDir, "public-test-shard-0-of-1.json"), publicValue),
    writeJson(join(campaignDir, "checkpoint-public-test-shard-0-of-1.json"), publicValue),
    writeJson(join(campaignDir, "github-test.json"), githubValue),
    writeJson(join(campaignDir, "github-test-shard-0-of-1.json"), githubValue)
  ]);
  return { root, campaignDir, catalogs };
}

function fixtureCatalogs() {
  return [{
    slug: "TEST",
    sourcePath: "fixtures/test-catalog.json",
    githubSourcePath: "fixtures/test-catalog.json",
    generatedAt: "2026-08-02T18:00:00.000Z",
    companies: [{
      entityType: "company",
      sourceKey: "company-acme",
      name: "Acme",
      websiteUrl: "https://acme.example",
      reviewState: "verified",
      accounts: [
        account("x", "https://x.com/acme", "acme"),
        account("github", "https://github.com/acmeorg", "acmeorg")
      ],
      founders: []
    }]
  }];
}

function account(platform, url, handle) {
  return {
    sourceKey: `${platform}:${url}`,
    platform,
    url,
    handle,
    reviewState: "verified",
    verified: true
  };
}

function fixtureStoredPairScopes() {
  const platforms = [
    ...INGESTION_CORE_PLATFORMS,
    ...INGESTION_EXTENDED_ONLY_PLATFORMS
  ];
  return platforms.map((platform, index) => {
    const historicalEvidenceRows = platform === "x" ? 522 : 0;
    const githubEvidenceAttributions = platform === "github" ? 3 : 0;
    const githubBlockerReviews = platform === "github" ? 1 : 0;
    const evidenceAttributions = historicalEvidenceRows + githubEvidenceAttributions;
    const totalAttributedRows = evidenceAttributions + githubBlockerReviews;
    return {
      pairKey: `TEST:company:company-acme:${platform}`,
      batchSlug: "TEST",
      entityType: "company",
      entityId: "company-acme",
      platform,
      scope: {
        storedUnpublishedReceipt: {
          receiptId: `stored-unpublished-fixture-${index}`,
          status: "complete",
          checkedAt: CHECKED_AT,
          coveredThrough: CHECKED_AT,
          reason:
            "Both explicitly named stored-unpublished ledgers were traversed for this canonical pair.",
          surfacedCounts: {
            historicalEvidenceRows,
            githubEvidenceAttributions,
            githubBlockerReviews,
            evidenceAttributions,
            totalAttributedRows,
            explicitZero: totalAttributedRows === 0
          },
          sourceProofSha256: "c".repeat(64),
          publicationPolicy: "proof_only_no_publication",
          scoringEligible: false
        }
      }
    };
  });
}

function publicSnapshot({ startedAt = STARTED_AT, checkedAt = CHECKED_AT } = {}) {
  const attemptKey = "x:company:company-acme:https://x.com/acme";
  return {
    source: {
      label: "Public unauthenticated platform/page ingestion",
      batchSlug: "TEST",
      fetchedAt: checkedAt,
      recentCoverageCutoff: STARTED_AT
    },
    attempts: {
      [attemptKey]: {
        attemptKey,
        batchSlug: "TEST",
        entityType: "company",
        entityId: "company-acme",
        platform: "x",
        accountUrl: "https://x.com/acme",
        startedAt,
        checkedAt,
        status: "done",
        outcomeStatus: "completed",
        outcomeReason: "collector_evidence_collected",
        retryable: false
      }
    },
    evidence: [{
      id: "x-company-acme-42",
      batchSlug: "TEST",
      entityType: "company",
      entityId: "company-acme",
      attachedCompanyId: "company-acme",
      platform: "x",
      sourceUrl: "https://x.com/acme/status/42",
      accountUrl: "https://x.com/acme",
      platformPostId: "42",
      title: "Acme shipped a native update",
      text: "Acme shipped a native update with exact public evidence.",
      postedAt: "2026-08-02T18:00:00.000Z",
      last_checked_at: checkedAt,
      review_state: "verified",
      metrics: { likes: 12 }
    }],
    needsReview: [],
    failures: []
  };
}

function githubSnapshot() {
  const attemptKey = "github:company:company-acme:https://github.com/acmeorg";
  return {
    source: {
      label: "GitHub public API fixture",
      batchSlug: "TEST",
      sourcePath: "fixtures/test-catalog.json",
      fetchedAt: CHECKED_AT
    },
    attempts: {
      [attemptKey]: {
        attemptKey,
        batchSlug: "TEST",
        entityType: "company",
        entityId: "company-acme",
        platform: "github",
        accountUrl: "https://github.com/acmeorg",
        mappedAccountCount: 1,
        startedAt: STARTED_AT,
        checkedAt: CHECKED_AT,
        status: "done",
        outcomeStatus: "completed",
        outcomeReason: "collector_account_fetched",
        retryable: false
      }
    },
    accounts: [{
      entityType: "company",
      entityId: "company-acme",
      attachedCompanyId: "company-acme",
      githubUrl: "https://github.com/acmeorg",
      login: "acmeorg",
      fetched: true,
      checkedAt: CHECKED_AT,
      attemptKey,
      account: { login: "acmeorg", followers: 8, publicRepos: 1 },
      aggregate: { repoCount: 1, totalStars: 10 },
      repos: [{
        id: 123,
        fullName: "acmeorg/widget",
        htmlUrl: "https://github.com/acmeorg/widget",
        stars: 10,
        forks: 2,
        watchers: 10,
        openIssues: 0,
        pushedAt: "2026-08-02T18:00:00.000Z"
      }]
    }]
  };
}

function prepareFixture(fixture, outputDir, overrides = {}) {
  return prepareIngestionCoverageCampaign({
    root: fixture.root,
    campaignDir: fixture.campaignDir,
    outputDir,
    idempotencyKey: "fixture-run",
    campaignKey: "fixture-campaign",
    batchSlugs: ["TEST"],
    materializedAt: MATERIALIZED_AT,
    catalogs: fixture.catalogs,
    batchLayout: TEST_LAYOUT,
    ...overrides
  });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

function shardTable(source, name) {
  const match = source.match(new RegExp(`const ${name} = Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);`));
  assert.ok(match, `${name} must remain an explicit frozen runner table`);
  return Object.fromEntries([...match[1].matchAll(/([A-Z0-9]+):\s*(\d+)/g)].map((row) => [
    row[1],
    Number(row[2])
  ]));
}

function allDescriptors(artifacts) {
  return [
    artifacts.catalogs,
    artifacts.expectedCatalogManifest,
    artifacts.taskPlan,
    artifacts.runnerLog,
    ...artifacts.collectors,
    ...artifacts.supporting
  ];
}
