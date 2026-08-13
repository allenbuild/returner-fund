import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  HISTORICAL_DEPTH_COMPLETION_PROOF_VERSION,
  adaptHistoricalDepthCoverage
} from "../scripts/lib/historical-depth-coverage-adapter.mjs";
import {
  runHistoricalDepthBackfill
} from "../scripts/lib/historical-depth-backfill.mjs";
import {
  INGESTION_RECENCY_WINDOW_DAYS
} from "../scripts/lib/ingestion-coverage-receipt.mjs";

const STARTED_AT = "2026-08-02T18:20:00.000Z";
const GENERATED_AT = "2026-08-02T18:30:00.000Z";

function catalogsWithOneMapping() {
  return [{
    slug: "TEST",
    sourcePath: "fixtures/test.json",
    generatedAt: "2026-08-02T18:00:00.000Z",
    companies: [{
      sourceKey: "company-acme",
      entityType: "company",
      name: "Acme",
      websiteUrl: "https://acme.example",
      accounts: [{
        platform: "product_hunt",
        url: "https://www.producthunt.com/products/acme",
        verified: true
      }],
      founders: [{
        sourceKey: "founder-alice",
        entityType: "founder",
        name: "Alice",
        accounts: []
      }]
    }]
  }];
}

async function runFixture(t, options) {
  const outputDir = await mkdtemp(join(tmpdir(), "historical-depth-bridge-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  let tick = 0;
  await runHistoricalDepthBackfill({
    outputDir,
    limits: { hostPaceMs: 0, redditPaceMs: 0, requestAttempts: 1 },
    now: () => new Date(Date.parse(STARTED_AT) + tick++ * 1_000),
    ...options
  });
  const journal = await readFile(join(outputDir, "pages.ndjson"));
  const events = journal.toString("utf8").trimEnd().split("\n").map(JSON.parse);
  return {
    journal,
    events,
    artifact: {
      path: "historical-depth/pages.ndjson",
      sha256: createHash("sha256").update(journal).digest("hex"),
      observedAt: events.at(-1).recordedAt
    }
  };
}

describe("historical-depth coverage bridge", () => {
  it("emits every owner/platform pair and keeps all unmapped pairs explicitly queued", async (t) => {
    const catalogs = catalogsWithOneMapping();
    const fixture = await runFixture(t, {
      catalogs,
      platforms: ["youtube", "product_hunt", "reddit"]
    });
    const result = await adaptHistoricalDepthCoverage({
      ...fixture,
      catalogs,
      generatedAt: GENERATED_AT
    });

    assert.equal(result.coverageSummary.companiesEvaluated, 1);
    assert.equal(result.coverageSummary.foundersEvaluated, 1);
    assert.equal(result.coverageSummary.ownerPlatformPairsEvaluated, 6);
    assert.equal(result.coverageSummary.mappedOwnerPlatformPairs, 1);
    assert.equal(result.coverageSummary.unmappedOwnerPlatformPairs, 5);
    assert.equal(result.coverageSummary.pairStatusCounts.requires_credentials, 1);
    assert.equal(result.coverageSummary.pairStatusCounts.queued_unmapped, 5);
    assert.equal(result.pairCoverage.length, 6);
    assert.equal(result.targetCoverage.length, 6);
    assert.equal(
      Object.keys(result.collectorArtifacts[0].snapshot.attempts).length,
      6
    );
    assert.ok(result.pairCoverage.filter((row) => row.mappingStatus === "unmapped")
      .every((row) => row.translatedOutcomeStatus === "needs_review"));
    assert.ok(Object.values(result.collectorArtifacts[0].snapshot.attempts)
      .every((attempt) => attempt.outcomeStatus !== "verified_no_account"));
    assert.equal(result.pairScopes.length, 0);
  });

  it("rejects bytes that do not match the hash-pinned journal", async (t) => {
    const catalogs = catalogsWithOneMapping();
    const fixture = await runFixture(t, { catalogs, platforms: ["product_hunt"] });
    await assert.rejects(
      adaptHistoricalDepthCoverage({
        ...fixture,
        artifact: { ...fixture.artifact, sha256: "a".repeat(64) },
        catalogs,
        generatedAt: GENERATED_AT
      }),
      /journal sha256 mismatch/
    );
  });

  it("keeps public YouTube partial history queued and refuses a forged completion proof", async (t) => {
    const catalogs = [{
      slug: "TEST",
      sourcePath: "fixtures/test.json",
      generatedAt: "2026-08-02T18:00:00.000Z",
      companies: [{
        sourceKey: "company-acme",
        entityType: "company",
        name: "Acme",
        websiteUrl: "https://acme.example",
        accounts: [{
          platform: "youtube",
          url: "https://www.youtube.com/channel/UCfixture123",
          verified: true
        }],
        founders: []
      }]
    }];
    const fixture = await runFixture(t, {
      catalogs,
      platforms: ["youtube"],
      fetch: async (url) => {
        if (String(url).includes("feeds/videos.xml")) {
          return new Response(`<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><yt:channelId>UCfixture123</yt:channelId><entry><yt:videoId>video123</yt:videoId><title>Launch</title><published>2026-07-01T12:00:00.000Z</published></entry></feed>`);
        }
        return new Response(`<meta itemprop="channelId" content="UCfixture123"><script>{"videoId":"video123"}</script>`);
      }
    });
    const base = await adaptHistoricalDepthCoverage({
      ...fixture,
      catalogs,
      generatedAt: GENERATED_AT
    });
    assert.equal(base.accountTargetCoverage[0].scopeStatus, "requires_credentials");
    assert.equal(base.accountTargetCoverage[0].accepted, 1);
    assert.equal(base.pairScopes.length, 0);

    const target = base.accountTargetCoverage[0];
    const runCompleted = fixture.events.find((event) => event.type === "run_completed");
    await assert.rejects(
      adaptHistoricalDepthCoverage({
        ...fixture,
        catalogs,
        generatedAt: GENERATED_AT,
        completionProofs: [{
          proofVersion: HISTORICAL_DEPTH_COMPLETION_PROOF_VERSION,
          targetKey: target.targetKey,
          status: "complete",
          artifactSha256: fixture.artifact.sha256,
          terminalSequence: fixture.events.find((event) =>
            event.type === "target_completed"
          ).sequence,
          runCompletedSequence: runCompleted.sequence,
          checkedAt: target.checkedAt,
          coveredThrough: recencyCutoff(),
          coverageExtent: target.coverageExtent,
          technicalLimit: "Public YouTube history remains non-exhaustive.",
          reason: "This deliberately invalid proof must fail closed."
        }]
      }),
      /(?:not eligible for historical completion proof|cannot be historical-complete)/
    );
  });

  it("accepts exact API exhaustion proof and binds the source limits into pair scope", async (t) => {
    const catalogs = [{
      slug: "TEST",
      sourcePath: "fixtures/test.json",
      generatedAt: "2026-08-02T18:00:00.000Z",
      companies: [{
        sourceKey: "company-acme",
        entityType: "company",
        name: "Acme",
        websiteUrl: "https://acme.example",
        accounts: [{
          platform: "youtube",
          url: "https://www.youtube.com/channel/UCfixture123",
          verified: true
        }],
        founders: []
      }]
    }];
    const fixture = await runFixture(t, {
      catalogs,
      platforms: ["youtube"],
      credentials: { youtubeApiKey: "fixture-key" },
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
                title: "Historical launch"
              }
            }],
            pageInfo: { totalResults: 1 }
          });
        }
        return new Response(`<meta itemprop="channelId" content="UCfixture123">`);
      }
    });
    const terminal = fixture.events.find((event) => event.type === "target_completed");
    const completed = fixture.events.find((event) => event.type === "run_completed");
    const targetKey = terminal.targetKey;
    const result = await adaptHistoricalDepthCoverage({
      ...fixture,
      catalogs,
      generatedAt: GENERATED_AT,
      completionProofs: [{
        proofVersion: HISTORICAL_DEPTH_COMPLETION_PROOF_VERSION,
        targetKey,
        status: "complete",
        artifactSha256: fixture.artifact.sha256,
        terminalSequence: terminal.sequence,
        runCompletedSequence: completed.sequence,
        checkedAt: terminal.recordedAt,
        coveredThrough: recencyCutoff(),
        coverageExtent: "all_items_exposed_by_official_uploads_playlist_api",
        technicalLimit: "Official uploads-playlist API exhausted under the recorded page and item caps.",
        reason: "The exact verified channel uploads playlist ended without a continuation token."
      }]
    });

    assert.equal(result.accountTargetCoverage[0].scopeStatus, "complete");
    assert.equal(result.coverageSummary.pairStatusCounts.complete, 1);
    assert.equal(result.pairScopes.length, 1);
    assert.match(
      result.pairScopes[0].scope.historicalBackfillReceipt.technicalLimit,
      /preserved endpoint limits sha256=/
    );
    assert.equal(result.collectorArtifacts[0].snapshot.evidence.length, 1);
  });

  it("accepts one bounded failed request after the last committed page without inventing evidence", async (t) => {
    const catalogs = [{
      slug: "TEST",
      sourcePath: "fixtures/test.json",
      generatedAt: "2026-08-02T18:00:00.000Z",
      companies: [{
        sourceKey: "company-antihero",
        entityType: "company",
        name: "Antihero",
        websiteUrl: "https://antihero.example",
        accounts: [{
          platform: "youtube",
          url: "https://www.youtube.com/channel/UCI4K_fIB0WDwyWYwgHx51dA",
          verified: true
        }],
        founders: []
      }]
    }];
    const fixture = await runFixture(t, {
      catalogs,
      platforms: ["youtube"],
      fetch: async (url) => {
        if (String(url).includes("feeds/videos.xml")) {
          return new Response(`<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><yt:channelId>DifferentChannel</yt:channelId></feed>`);
        }
        return new Response(
          `<meta itemprop="channelId" content="UCI4K_fIB0WDwyWYwgHx51dA">` +
          `<script>{"videoId":"relativeOnly123"}</script>`
        );
      }
    });
    const page = fixture.events.find((event) => event.type === "page_checkpoint");
    const terminal = fixture.events.find((event) => event.type === "target_completed");
    assert.equal(page.receipt.pagesAttempted, 1);
    assert.equal(page.receipt.requests, 1);
    assert.equal(terminal.receipt.pagesAttempted, 2);
    assert.equal(terminal.receipt.pagesFetched, 1);
    assert.equal(terminal.receipt.requests, 2);
    assert.equal(terminal.receipt.accepted, page.receipt.accepted);

    const result = await adaptHistoricalDepthCoverage({
      ...fixture,
      catalogs,
      generatedAt: GENERATED_AT
    });
    assert.equal(result.accountTargetCoverage[0].scopeStatus, "failed");
    assert.equal(result.accountTargetCoverage[0].accepted, 0);
    assert.match(
      result.accountTargetCoverage[0].blocker,
      /youtube_feed_channel_mismatch/
    );
    assert.equal(result.collectorArtifacts[0].snapshot.evidence.length, 0);
    assert.ok(Object.values(result.collectorArtifacts[0].snapshot.attempts)
      .every((attempt) => attempt.outcomeStatus !== "verified_no_account"));
  });
});

function recencyCutoff() {
  return new Date(
    Date.parse(GENERATED_AT) - INGESTION_RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1_000
  ).toISOString();
}
