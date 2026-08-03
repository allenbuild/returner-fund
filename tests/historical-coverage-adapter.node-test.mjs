import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adaptAutonomousIngestionCoverage,
  normalizeAutonomousIngestionCatalogs
} from "../scripts/lib/ingestion-coverage-adapter.mjs";
import {
  INGESTION_CATALOG_MANIFEST_VERSION,
  buildIngestionCoverageReceipt
} from "../scripts/lib/ingestion-coverage-receipt.mjs";
import {
  HISTORICAL_BACKFILL_RUNNER_VERSION,
  HISTORICAL_BACKFILL_SCHEMA_VERSION
} from "../scripts/lib/historical-backfill.mjs";

const STARTED_AT = "2026-08-02T18:20:00.000Z";
const PAGE_RECORDED_AT = "2026-08-02T18:28:00.000Z";
const TARGET_RECORDED_AT = "2026-08-02T18:29:00.000Z";
const COMPLETED_AT = "2026-08-02T18:30:00.000Z";
const GENERATED_AT = "2026-08-02T18:31:00.000Z";
const HISTORICAL_ARTIFACT_HASH = "b".repeat(64);
const RUNNER_LOG_HASH = "d".repeat(64);
const TARGET_KEY = "TEST:company-acme:hacker_news";

function cutoffAt(generatedAt = GENERATED_AT) {
  return new Date(Date.parse(generatedAt) - 90 * 24 * 60 * 60 * 1_000).toISOString();
}

function liveCatalog() {
  return [{
    slug: "TEST",
    sourcePath: "fixtures/historical-coverage-catalog.json",
    generatedAt: STARTED_AT,
    companies: [{
      entityType: "company",
      sourceKey: "company-acme",
      name: "Acme",
      accounts: [],
      founders: []
    }]
  }];
}

function manifestFor(catalogs) {
  const normalized = normalizeAutonomousIngestionCatalogs(catalogs);
  return {
    version: INGESTION_CATALOG_MANIFEST_VERSION,
    batches: normalized.map((catalog) => ({
      batchSlug: catalog.batchSlug,
      sourcePath: catalog.sourcePath,
      sourceVersion: catalog.sourceVersion,
      sourceHash: catalog.sourceHash,
      companies: catalog.companies.length,
      founders: catalog.companies.reduce(
        (total, company) => total + company.founders.length,
        0
      ),
      entities: catalog.companies.reduce(
        (total, company) => total + 1 + company.founders.length,
        0
      )
    }))
  };
}

function runnerLogs() {
  return [
    {
      eventType: "run.started",
      createdAt: STARTED_AT,
      severity: "info",
      message: "Compatibility fixture run started.",
      payload: {}
    },
    {
      eventType: "collection.finished",
      createdAt: TARGET_RECORDED_AT,
      severity: "info",
      message: "Compatibility fixture collectors reached terminal states.",
      payload: { results: [] }
    },
    {
      eventType: "run.completed",
      createdAt: COMPLETED_AT,
      severity: "info",
      message: "Compatibility fixture run completed.",
      payload: {}
    }
  ];
}

function planTask(platform = "hacker_news") {
  return {
    batchSlug: "TEST",
    companySourceKey: "company-acme",
    entityType: "company",
    entitySourceKey: "company-acme",
    platform,
    account: null,
    checkpointKey: `run:TEST:company:company-acme:${platform}:historical`,
    status: "queued",
    terminalReason: null
  };
}

function historicalEvents({
  outcome = "collected",
  platform = "hacker_news",
  blocker = null,
  sourceExhausted = true,
  truncated = false,
  evidence = null
} = {}) {
  const targetKey = `TEST:company-acme:${platform}`;
  const common = {
    schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
    runnerVersion: HISTORICAL_BACKFILL_RUNNER_VERSION,
    provider: platform,
    platform,
    batchSlug: "TEST",
    entityType: "company",
    entityId: "company-acme",
    entityName: "Acme",
    officialDomain: "acme.example",
    windowStart: "2026-04-01T12:00:00.000Z",
    windowEnd: "2026-04-01T12:00:00.000Z",
    pagesAttempted: 2,
    pagesFetched: 2,
    requests: 2,
    itemsSeen: 1,
    accepted: outcome === "collected" ? 1 : 0,
    rejected: 0,
    duplicates: 0,
    earliest: "2026-04-01T12:00:00.000Z",
    latest: "2026-04-01T12:00:00.000Z",
    nextCursor: null,
    sourceExhausted,
    truncated,
    sourceLimit: platform === "hacker_news"
      ? { maxPages: 20, maxItems: 1_000, hitsPerPage: 50 }
      : { maxDepth: 3, maxUrls: 200, maxResponses: 40, maxItems: 2_000 },
    credentialRequired: false,
    blocker,
    blockers: blocker ? [blocker] : [],
    nextAction: blocker
      ? "Resolve the exact recorded blocker before resuming this bounded target."
      : "No further source-local pages are currently exposed.",
    coverageExtent: sourceExhausted
      ? "all_available_search_results"
      : "partial_search_results"
  };
  const pageReceipt = {
    ...common,
    receiptType: "page",
    page: 1,
    pageType: platform === "hacker_news" ? "search_by_date" : "html",
    requestUrl: platform === "hacker_news"
      ? "https://hn.algolia.com/api/v1/search_by_date?page=1"
      : "https://acme.example/archive",
    pageItemsSeen: outcome === "collected" ? 1 : 0,
    pageAccepted: outcome === "collected" ? 1 : 0,
    pageRejected: 0,
    pageDuplicates: 0
  };
  const targetReceipt = { ...common, receiptType: "target", outcome };
  return {
    pageEvent: {
      schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
      sequence: 7,
      recordedAt: PAGE_RECORDED_AT,
      type: "page_checkpoint",
      targetKey,
      receipt: pageReceipt,
      evidence: evidence ?? (outcome === "collected" ? [{
        schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
        collector: "historical-backfill",
        platform,
        batchSlug: "TEST",
        entityType: "company",
        entityId: "company-acme",
        entityName: "Acme",
        officialDomain: "acme.example",
        externalId: "hn:42",
        sourceUrl: "https://news.ycombinator.com/item?id=42",
        canonicalUrl: "https://acme.example/blog/launch",
        title: "Acme launch",
        text: "Acme published its launch history.",
        publishedAt: "2026-04-01T12:00:00.000Z",
        discoveredAt: PAGE_RECORDED_AT,
        discoveryMethod: "hn_algolia_search_by_date_exact_name_and_official_domain"
      }] : [])
    },
    targetEvent: {
      schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
      sequence: 8,
      recordedAt: TARGET_RECORDED_AT,
      type: "target_completed",
      targetKey,
      receipt: targetReceipt
    }
  };
}

function historicalScope(targetEvent, status = "partial") {
  const receipt = targetEvent.receipt;
  return {
    batchSlug: receipt.batchSlug,
    entityType: receipt.entityType,
    entityId: receipt.entityId,
    platform: receipt.platform,
    scope: {
      historicalBackfillReceipt: {
        receiptId: `historical-${targetEvent.sequence}-${receipt.platform}`,
        status,
        checkedAt: targetEvent.recordedAt,
        coveredThrough: cutoffAt(),
        technicalLimit:
          `The ${receipt.platform} target reached its recorded public source boundary under ${JSON.stringify(receipt.sourceLimit)}.`,
        reason:
          `The target recorded sourceExhausted=${receipt.sourceExhausted} and truncated=${receipt.truncated}; this source-local result does not prove other historical lanes.`,
        // These source-local flags are deliberately not authoritative receipt fields.
        sourceExhausted: receipt.sourceExhausted,
        truncated: receipt.truncated
      }
    }
  };
}

/*
 * Specification-only bridge for the compatibility tests. The historical runner
 * does not yet emit this adapter envelope, which is why the direct-rejection
 * test below is important.
 */
function translatedPublicEnvelope(pageEvent, targetEvent) {
  const receipt = targetEvent.receipt;
  const outcomeStatus = receipt.outcome === "collected"
    ? "completed"
    : receipt.outcome === "access_blocked"
      ? "failed"
      : receipt.outcome;
  const exactReason = receipt.outcome === "collected"
    ? `Historical runner collected accepted native rows and recorded sourceExhausted=${receipt.sourceExhausted}.`
    : receipt.outcome === "access_blocked"
      ? `Access denied by the historical source; exact blocker ${receipt.blocker}.`
      : `Historical runner recorded exact target outcome ${receipt.outcome}.`;
  return {
    kind: "public",
    artifact: {
      path: "historical/run-test/pages.ndjson",
      sha256: HISTORICAL_ARTIFACT_HASH,
      observedAt: targetEvent.recordedAt
    },
    snapshot: {
      source: { batchSlug: receipt.batchSlug, fetchedAt: targetEvent.recordedAt },
      attempts: {
        [targetEvent.targetKey]: {
          attemptKey: targetEvent.targetKey,
          batchSlug: receipt.batchSlug,
          entityType: receipt.entityType,
          entityId: receipt.entityId,
          platform: receipt.platform,
          accountUrl: null,
          status: "done",
          outcomeStatus,
          outcomeReason: exactReason,
          error: receipt.outcome === "access_blocked" ? exactReason : null,
          startedAt: pageEvent.recordedAt,
          checkedAt: targetEvent.recordedAt,
          retryable: false
        }
      },
      evidence: pageEvent.evidence.map((row) => ({
        ...row,
        nativeId: row.externalId,
        // Coverage canonicalization requires the native Hacker News item URL;
        // the runner's outbound official-site URL is not a native HN URL.
        canonicalUrl: row.platform === "hacker_news" ? row.sourceUrl : row.canonicalUrl,
        observedAt: pageEvent.recordedAt
      })),
      needsReview: [],
      failures: []
    }
  };
}

async function adapt({
  platform = "hacker_news",
  collectorArtifacts,
  pairScopes = []
}) {
  const catalogs = liveCatalog();
  return adaptAutonomousIngestionCoverage({
    runId: "historical-compatibility-run",
    idempotencyKey: "historical-compatibility-idempotency",
    campaignKey: "historical-compatibility-campaign",
    generatedAt: GENERATED_AT,
    catalogs,
    expectedCatalogManifest: manifestFor(catalogs),
    taskPlan: [planTask(platform)],
    collectorArtifacts,
    runnerLogs: runnerLogs(),
    runnerLogArtifact: {
      path: "historical/run-test/runner-events.ndjson",
      sha256: RUNNER_LOG_HASH,
      observedAt: GENERATED_AT
    },
    pairScopes
  });
}

function coveragePair(receipt, platform) {
  return receipt.pairs.find((candidate) =>
    candidate.pairKey === `TEST:company:company-acme:${platform}`
  );
}

describe("historical backfill coverage compatibility", () => {
  it("rejects raw historical artifacts instead of silently reclassifying their receipts", async () => {
    const { pageEvent, targetEvent } = historicalEvents();
    await assert.rejects(
      adapt({
        collectorArtifacts: [{
          kind: "historical",
          artifact: {
            path: "historical/run-test/pages.ndjson",
            sha256: HISTORICAL_ARTIFACT_HASH,
            observedAt: TARGET_RECORDED_AT
          },
          snapshot: { pageEvent, targetEvent }
        }]
      }),
      /Collector kind must be public, github, or targeted; received historical/
    );
  });

  it("normalizes an explicit page/target translation with exact journal timing and provenance", async () => {
    const { pageEvent, targetEvent } = historicalEvents();
    assert.equal(targetEvent.targetKey, TARGET_KEY);
    const normalized = await adapt({
      collectorArtifacts: [translatedPublicEnvelope(pageEvent, targetEvent)],
      pairScopes: [historicalScope(targetEvent)]
    });

    assert.equal(normalized.outcomes.length, 1);
    assert.equal(normalized.outcomes[0].status, "completed");
    assert.equal(normalized.outcomes[0].startedAt, pageEvent.recordedAt);
    assert.equal(normalized.outcomes[0].checkedAt, targetEvent.recordedAt);
    assert.equal(normalized.evidence.length, 1);
    assert.equal(normalized.evidence[0].nativeId, "hn:42");
    assert.equal(normalized.evidence[0].observedAt, pageEvent.recordedAt);
    assert.deepEqual(
      normalized.provenance.collectorArtifacts.map((artifact) => ({
        path: artifact.path,
        sha256: artifact.sha256,
        observedAt: artifact.observedAt,
        attempts: artifact.attempts,
        evidence: artifact.evidence
      })),
      [{
        path: "historical/run-test/pages.ndjson",
        sha256: HISTORICAL_ARTIFACT_HASH,
        observedAt: targetEvent.recordedAt,
        attempts: 1,
        evidence: 1
      }]
    );

    const receipt = buildIngestionCoverageReceipt(normalized);
    const pair = coveragePair(receipt, "hacker_news");
    assert.equal(pair.terminal.status, "collected");
    assert.equal(pair.evidence.postCount, 1);
    assert.equal(pair.evidence.oldestPublishedAt, "2026-04-01T12:00:00.000Z");
    assert.equal(pair.scope.historicalBackfillComplete, false);
    assert.equal(pair.scope.receipts.historicalBackfill.status, "partial");
    assert.equal("sourceExhausted" in pair.scope.receipts.historicalBackfill, false);
    assert.equal("truncated" in pair.scope.receipts.historicalBackfill, false);
  });

  it("preserves an exact historical blocker as blocked coverage without claiming absence", async () => {
    const blocker = "robots_txt_disallowed:3_candidate_urls";
    const { pageEvent, targetEvent } = historicalEvents({
      outcome: "access_blocked",
      platform: "web",
      blocker,
      sourceExhausted: false,
      evidence: []
    });
    const normalized = await adapt({
      platform: "web",
      collectorArtifacts: [translatedPublicEnvelope(pageEvent, targetEvent)],
      pairScopes: [historicalScope(targetEvent, "failed")]
    });

    assert.equal(normalized.outcomes[0].status, "failed");
    assert.equal(normalized.outcomes[0].reasonCode, "access_denied");
    assert.match(normalized.outcomes[0].reason, new RegExp(blocker));
    assert.equal(normalized.outcomes[0].startedAt, pageEvent.recordedAt);
    assert.equal(normalized.outcomes[0].checkedAt, targetEvent.recordedAt);

    const receipt = buildIngestionCoverageReceipt(normalized);
    const pair = coveragePair(receipt, "web");
    assert.equal(pair.terminal.status, "blocked");
    assert.equal(pair.terminal.reasonCode, "access_denied");
    assert.match(pair.terminal.reason, new RegExp(blocker));
    assert.equal(pair.terminal.absenceVerification, null);
    assert.equal(pair.scope.historicalBackfillComplete, false);
  });

  it("rejects verified_no_history until the coverage taxonomy gains a distinct exact status", async () => {
    const { pageEvent, targetEvent } = historicalEvents({
      outcome: "verified_no_history",
      evidence: []
    });
    await assert.rejects(
      adapt({
        collectorArtifacts: [translatedPublicEnvelope(pageEvent, targetEvent)],
        pairScopes: [historicalScope(targetEvent)]
      }),
      /Unknown collector outcome status verified_no_history/
    );
  });

  it("requires the versioned cutoff even when a source-local target says exhausted", async () => {
    const { pageEvent, targetEvent } = historicalEvents();
    const scope = historicalScope(targetEvent, "complete");
    scope.scope.historicalBackfillReceipt.coveredThrough = "2026-01-01T00:00:00.000Z";
    const normalized = await adapt({
      collectorArtifacts: [translatedPublicEnvelope(pageEvent, targetEvent)],
      pairScopes: [scope]
    });
    assert.throws(
      () => buildIngestionCoverageReceipt(normalized),
      /historical backfill must reach the versioned recency cutoff/
    );
  });
});
