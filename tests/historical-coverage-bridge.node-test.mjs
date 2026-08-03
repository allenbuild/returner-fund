import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  HISTORICAL_COMPLETION_PROOF_VERSION,
  adaptHistoricalBackfillCoverage
} from "../scripts/lib/historical-coverage-adapter.mjs";
import {
  adaptAutonomousIngestionCoverage,
  normalizeAutonomousIngestionCatalogs
} from "../scripts/lib/ingestion-coverage-adapter.mjs";
import {
  INGESTION_CATALOG_MANIFEST_VERSION,
  INGESTION_RECENCY_WINDOW_DAYS,
  buildIngestionCoverageReceipt
} from "../scripts/lib/ingestion-coverage-receipt.mjs";
import {
  HISTORICAL_BACKFILL_RUNNER_VERSION,
  HISTORICAL_BACKFILL_SCHEMA_VERSION,
  runHistoricalBackfill
} from "../scripts/lib/historical-backfill.mjs";

const STARTED_AT = "2026-08-02T18:20:00.000Z";
const PAGE_RECORDED_AT = "2026-08-02T18:25:00.000Z";
const TARGET_RECORDED_AT = "2026-08-02T18:26:00.000Z";
const COMPLETED_AT = "2026-08-02T18:27:00.000Z";
const GENERATED_AT = "2026-08-02T18:28:00.000Z";
const RUNNER_LOG_HASH = "d".repeat(64);

function cutoffAt(generatedAt = GENERATED_AT) {
  return new Date(
    Date.parse(generatedAt) - INGESTION_RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1_000
  ).toISOString();
}

function liveCatalog() {
  return [{
    slug: "TEST",
    sourcePath: "fixtures/historical-bridge-catalog.json",
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

function adapterRunnerLogs() {
  return [
    {
      eventType: "run.started",
      createdAt: STARTED_AT,
      severity: "info",
      message: "Historical coverage bridge fixture started.",
      payload: {}
    },
    {
      eventType: "collection.finished",
      createdAt: TARGET_RECORDED_AT,
      severity: "info",
      message: "Historical coverage bridge fixture collected.",
      payload: { results: [] }
    },
    {
      eventType: "run.completed",
      createdAt: COMPLETED_AT,
      severity: "info",
      message: "Historical coverage bridge fixture completed.",
      payload: {}
    }
  ];
}

async function normalizeBridgeOutput(bridge) {
  const catalogs = liveCatalog();
  return adaptAutonomousIngestionCoverage({
    runId: "historical-bridge-run",
    idempotencyKey: "historical-bridge-idempotency",
    campaignKey: "historical-bridge-campaign",
    generatedAt: GENERATED_AT,
    catalogs,
    expectedCatalogManifest: manifestFor(catalogs),
    taskPlan: bridge.taskPlan,
    collectorArtifacts: bridge.collectorArtifacts,
    pairScopes: bridge.pairScopes,
    runnerLogs: adapterRunnerLogs(),
    runnerLogArtifact: {
      path: "historical-bridge-runner.ndjson",
      sha256: RUNNER_LOG_HASH,
      observedAt: COMPLETED_AT
    }
  });
}

function fixtureJournal({
  entityId = "company-acme",
  entityName = "Acme",
  platform = "hacker_news",
  outcome = "collected",
  evidence = null,
  sourceExhausted = true,
  truncated = false,
  blocker = null,
  blockers = blocker ? [blocker] : [],
  credentialRequired = false,
  coverageExtent = null,
  includeRunCompleted = true,
  sequenceOffset = 0
} = {}) {
  const targetKey = `TEST:${entityId}:${platform}`;
  const rows = evidence ?? (outcome === "collected" ? [historicalHnEvidence({
    entityId,
    entityName
  })] : []);
  const extent = coverageExtent ?? (
    sourceExhausted
      ? platform === "hacker_news"
        ? "all_available_search_results"
        : platform === "rss"
          ? "all_discovered_official_feed_entries_within_endpoint_policy"
          : "all_discovered_official_web_history_within_endpoint_policy"
      : truncated
        ? "bounded_official_site_history"
        : "robots_policy_blocked"
  );
  const config = {
    schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
    runnerVersion: HISTORICAL_BACKFILL_RUNNER_VERSION,
    batches: ["TEST"],
    platforms: [platform],
    targetKeys: [targetKey],
    limits: {
      globalConcurrency: 8,
      hostConcurrency: 1,
      siteMaxResponses: 40
    }
  };
  const earliest = rows[0]?.publishedAt ?? null;
  const common = {
    schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
    runnerVersion: HISTORICAL_BACKFILL_RUNNER_VERSION,
    provider: platform,
    platform,
    batchSlug: "TEST",
    entityType: "company",
    entityId,
    entityName,
    officialDomain: "acme.example",
    windowStart: earliest,
    windowEnd: earliest,
    pagesAttempted: 1,
    pagesFetched: 1,
    requests: 1,
    itemsSeen: rows.length,
    accepted: rows.length,
    rejected: 0,
    duplicates: 0,
    earliest,
    latest: earliest,
    nextCursor: null,
    sourceExhausted,
    truncated,
    sourceLimit: platform === "hacker_news"
      ? { maxPages: 20, maxItems: 1_000, hitsPerPage: 50 }
      : { maxDepth: 3, maxUrls: 200, maxResponses: 40, maxItems: 2_000 },
    credentialRequired,
    blocker,
    blockers,
    nextAction: blocker
      ? "Resolve the exact recorded historical blocker before resuming."
      : "No additional source-local pages are currently exposed.",
    coverageExtent: extent
  };
  const initialized = {
    schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
    sequence: 1 + sequenceOffset,
    recordedAt: STARTED_AT,
    type: "run_initialized",
    config,
    configFingerprint: sha256(stableJson(config)),
    startedAt: STARTED_AT
  };
  const page = {
    schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
    sequence: 2 + sequenceOffset,
    recordedAt: PAGE_RECORDED_AT,
    type: "page_checkpoint",
    targetKey,
    receipt: {
      ...common,
      receiptType: "page",
      page: platform === "hacker_news" ? 0 : "https://acme.example/archive",
      pageType: platform === "hacker_news" ? "search_by_date" : "html",
      requestUrl: platform === "hacker_news"
        ? "https://hn.algolia.com/api/v1/search_by_date?page=0"
        : "https://acme.example/archive",
      pageItemsSeen: rows.length,
      pageAccepted: rows.length,
      pageRejected: 0,
      pageDuplicates: 0
    },
    evidence: rows,
    progress: { targetKey, accepted: rows.length }
  };
  const target = {
    schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
    sequence: 3 + sequenceOffset,
    recordedAt: TARGET_RECORDED_AT,
    type: "target_completed",
    targetKey,
    receipt: { ...common, receiptType: "target", outcome }
  };
  const completed = {
    schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
    sequence: 4 + sequenceOffset,
    recordedAt: COMPLETED_AT,
    type: "run_completed",
    summary: {
      status: "completed",
      targetPlatformPairs: 1,
      completedTargetPlatformPairs: 1
    }
  };
  const events = includeRunCompleted
    ? [initialized, page, target, completed]
    : [initialized, page, target];
  const journal = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  return {
    targetKey,
    events,
    journal,
    artifact: {
      path: "historical/run-1/pages.ndjson",
      sha256: sha256(journal),
      observedAt: includeRunCompleted ? COMPLETED_AT : TARGET_RECORDED_AT
    }
  };
}

function historicalHnEvidence(overrides = {}) {
  return {
    schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
    collector: "historical-backfill",
    platform: "hacker_news",
    batchSlug: "TEST",
    entityType: "company",
    entityId: "company-acme",
    entityName: "Acme",
    officialDomain: "acme.example",
    externalId: "hn:42",
    sourceUrl: "https://news.ycombinator.com/item?id=42",
    canonicalUrl: "https://acme.example/blog/launch",
    title: "Acme launch 🚀",
    text: "Acme published its launch history.",
    publishedAt: "2026-04-01T12:00:00.000Z",
    discoveredAt: PAGE_RECORDED_AT,
    discoveryMethod: "hn_algolia_search_by_date_exact_name_and_official_domain",
    ...overrides
  };
}

function completionProof(fixture, overrides = {}) {
  return {
    proofVersion: HISTORICAL_COMPLETION_PROOF_VERSION,
    targetKey: fixture.targetKey,
    status: "complete",
    artifactSha256: fixture.artifact.sha256,
    terminalSequence: 3,
    runCompletedSequence: 4,
    checkedAt: TARGET_RECORDED_AT,
    coveredThrough: cutoffAt(),
    technicalLimit:
      "Native public pagination was exhausted at the oldest result exposed by this source policy.",
    reason:
      "The proof-bound journal contains every reconciled page and the exact terminal target receipt.",
    ...overrides
  };
}

function coveragePair(receipt, platform) {
  return receipt.pairs.find((candidate) =>
    candidate.pairKey === `TEST:company:company-acme:${platform}`
  );
}

async function* splitUtf8(value) {
  const bytes = Buffer.from(value, "utf8");
  const sizes = [1, 7, 3, 29, 2, 61, 5, 127];
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const end = Math.min(bytes.length, offset + sizes[index % sizes.length]);
    yield bytes.subarray(offset, end);
    offset = end;
    index += 1;
    await Promise.resolve();
  }
}

describe("historical coverage production bridge", () => {
  it("bridges the real runner journal shape using only mocked public responses", async (context) => {
    const outputDir = await mkdtemp(join(tmpdir(), "historical-coverage-bridge-"));
    context.after(async () => rm(outputDir, { recursive: true, force: true }));
    let tick = 0;
    const now = () => new Date(Date.parse(STARTED_AT) + tick++ * 1_000);
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
      limits: { hostPaceMs: 0, requestAttempts: 1 },
      now,
      fetch: async () => new Response(JSON.stringify({
        hits: [{
          objectID: "42",
          title: "Acme launch",
          url: "https://acme.example/blog/launch",
          created_at: "2026-04-01T12:00:00.000Z",
          author: "fixture-author"
        }],
        nbPages: 1
      }), { headers: { "content-type": "application/json" } })
    });
    const bytes = await readFile(join(outputDir, "pages.ndjson"));
    const events = bytes.toString("utf8").trimEnd().split("\n").map(JSON.parse);
    const observedAt = events.at(-1).recordedAt;
    const generatedAt = new Date(Date.parse(observedAt) + 60_000).toISOString();
    const bridge = await adaptHistoricalBackfillCoverage({
      journal: [bytes.subarray(0, 17), bytes.subarray(17)],
      artifact: {
        path: join(outputDir, "pages.ndjson"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        observedAt
      },
      generatedAt
    });
    assert.equal(bridge.provenance.journal.events, events.length);
    assert.equal(bridge.targetCoverage[0].outcome, "collected");
    assert.equal(bridge.targetCoverage[0].scopeStatus, "partial");
    assert.equal(bridge.pairScopes.length, 0);
    assert.equal(
      bridge.collectorArtifacts[0].snapshot.evidence[0].canonicalUrl,
      "https://news.ycombinator.com/item?id=42"
    );
  });

  it("streams deterministically and preserves journal timing, provenance, native HN URL, and outbound URL", async () => {
    const fixture = fixtureJournal();
    const direct = await adaptHistoricalBackfillCoverage({
      journal: fixture.journal,
      artifact: fixture.artifact,
      generatedAt: GENERATED_AT
    });
    const streamed = await adaptHistoricalBackfillCoverage({
      journal: splitUtf8(fixture.journal),
      artifact: fixture.artifact,
      generatedAt: GENERATED_AT
    });
    assert.deepEqual(streamed, direct);

    assert.equal(direct.taskPlan.length, 1);
    assert.equal(direct.collectorArtifacts.length, 1);
    assert.equal(direct.pairScopes.length, 0, "source exhaustion alone must not emit completion");
    assert.equal(direct.targetCoverage[0].scopeStatus, "partial");
    assert.equal(direct.targetCoverage[0].recencyCutoffAt, null);
    const attempt = direct.collectorArtifacts[0].snapshot.attempts[fixture.targetKey];
    assert.equal(attempt.startedAt, PAGE_RECORDED_AT);
    assert.equal(attempt.checkedAt, TARGET_RECORDED_AT);
    assert.equal(attempt.outcomeStatus, "completed");
    const evidence = direct.collectorArtifacts[0].snapshot.evidence[0];
    assert.equal(evidence.nativeId, "hn:42");
    assert.equal(evidence.canonicalUrl, "https://news.ycombinator.com/item?id=42");
    assert.equal(evidence.observedAt, PAGE_RECORDED_AT);
    assert.equal(evidence.historicalOutboundUrl, "https://acme.example/blog/launch");
    assert.deepEqual(direct.outboundLinks, [{
      targetKey: fixture.targetKey,
      platform: "hacker_news",
      nativeId: "hn:42",
      nativeUrl: "https://news.ycombinator.com/item?id=42",
      outboundUrl: "https://acme.example/blog/launch",
      publishedAt: "2026-04-01T12:00:00.000Z",
      observedAt: PAGE_RECORDED_AT,
      pageSequence: 2
    }]);
    assert.deepEqual(direct.provenance.sourceArtifact, {
      kind: "historical",
      ...fixture.artifact
    });

    const normalized = await normalizeBridgeOutput(direct);
    assert.equal(normalized.outcomes[0].startedAt, PAGE_RECORDED_AT);
    assert.equal(normalized.outcomes[0].checkedAt, TARGET_RECORDED_AT);
    assert.equal(normalized.provenance.collectorArtifacts[0].path, fixture.artifact.path);
    assert.equal(normalized.provenance.collectorArtifacts[0].sha256, fixture.artifact.sha256);
    assert.equal(normalized.provenance.collectorArtifacts[0].observedAt, COMPLETED_AT);
    const receipt = buildIngestionCoverageReceipt(normalized);
    const pair = coveragePair(receipt, "hacker_news");
    assert.equal(pair.terminal.status, "collected");
    assert.equal(pair.scope.historicalBackfillComplete, false);
    assert.equal(pair.evidence.postCount, 1);
  });

  it("emits a complete historical scope only for an exact artifact-bound completion proof", async () => {
    const fixture = fixtureJournal();
    const bridge = await adaptHistoricalBackfillCoverage({
      journal: fixture.journal,
      artifact: fixture.artifact,
      generatedAt: GENERATED_AT,
      completionProofs: [completionProof(fixture)]
    });
    assert.equal(bridge.pairScopes.length, 1);
    const historicalReceipt = bridge.pairScopes[0].scope.historicalBackfillReceipt;
    assert.match(historicalReceipt.receiptId, /^historical-[a-f0-9]{40}$/);
    assert.deepEqual({ ...historicalReceipt, receiptId: undefined }, {
      receiptId: undefined,
      status: "complete",
      checkedAt: TARGET_RECORDED_AT,
      coveredThrough: cutoffAt(),
      technicalLimit:
        "Native public pagination was exhausted at the oldest result exposed by this source policy.",
      reason:
        "The proof-bound journal contains every reconciled page and the exact terminal target receipt."
    });
    assert.equal(bridge.targetCoverage[0].scopeStatus, "complete");
    assert.equal(bridge.targetCoverage[0].recencyCutoffAt, cutoffAt());

    const normalized = await normalizeBridgeOutput(bridge);
    const receipt = buildIngestionCoverageReceipt(normalized);
    assert.equal(
      coveragePair(receipt, "hacker_news").scope.historicalBackfillComplete,
      true
    );

    await assert.rejects(
      adaptHistoricalBackfillCoverage({
        journal: fixture.journal,
        artifact: fixture.artifact,
        generatedAt: GENERATED_AT,
        completionProofs: [completionProof(fixture, {
          coveredThrough: "2026-01-01T00:00:00.000Z"
        })]
      }),
      /must use the exact recency cutoff/
    );
    await assert.rejects(
      adaptHistoricalBackfillCoverage({
        journal: fixture.journal,
        artifact: fixture.artifact,
        generatedAt: GENERATED_AT,
        completionProofs: [completionProof(fixture, {
          artifactSha256: "a".repeat(64)
        })]
      }),
      /bound to a different artifact hash/
    );
  });

  it("preserves verified_no_history without ever claiming verified_no_account", async () => {
    const noHistoryMarker = "no_historical_pages_found_within_verified_official_sources";
    const fixture = fixtureJournal({
      outcome: "verified_no_history",
      evidence: [],
      blocker: noHistoryMarker,
      blockers: [noHistoryMarker]
    });
    const bridge = await adaptHistoricalBackfillCoverage({
      journal: fixture.journal,
      artifact: fixture.artifact,
      generatedAt: GENERATED_AT,
      completionProofs: [completionProof(fixture)]
    });
    assert.equal(bridge.targetCoverage[0].outcome, "verified_no_history");
    assert.equal(bridge.targetCoverage[0].scopeStatus, "complete");
    const attempt = bridge.collectorArtifacts[0].snapshot.attempts[fixture.targetKey];
    assert.equal(attempt.outcomeStatus, "needs_review");
    assert.match(attempt.outcomeReason, /does not prove that no native account exists/);

    const normalized = await normalizeBridgeOutput(bridge);
    const receipt = buildIngestionCoverageReceipt(normalized);
    const pair = coveragePair(receipt, "hacker_news");
    assert.equal(pair.terminal.status, "queued");
    assert.equal(pair.terminal.reasonCode, "manual_review_required");
    assert.equal(pair.terminal.absenceVerification, null);
    assert.equal(pair.scope.historicalBackfillComplete, true);
  });

  it("maps a recognized exact historical blocker to blocked coverage and retains the blocker text", async () => {
    const blocker = "robots_txt_disallowed:3_candidate_urls";
    const fixture = fixtureJournal({
      platform: "web",
      outcome: "access_blocked",
      evidence: [],
      sourceExhausted: false,
      blocker,
      blockers: [blocker],
      coverageExtent: "robots_policy_blocked"
    });
    const bridge = await adaptHistoricalBackfillCoverage({
      journal: fixture.journal,
      artifact: fixture.artifact,
      generatedAt: GENERATED_AT
    });
    assert.equal(bridge.targetCoverage[0].scopeStatus, "failed");
    assert.equal(bridge.targetCoverage[0].blocker, blocker);
    assert.equal(bridge.pairScopes.length, 0);
    const attempt = bridge.collectorArtifacts[0].snapshot.attempts[fixture.targetKey];
    assert.equal(attempt.outcomeStatus, "failed");
    assert.match(attempt.error, new RegExp(blocker));

    const normalized = await normalizeBridgeOutput(bridge);
    assert.equal(normalized.outcomes[0].reasonCode, "access_denied");
    const receipt = buildIngestionCoverageReceipt(normalized);
    const pair = coveragePair(receipt, "web");
    assert.equal(pair.terminal.status, "blocked");
    assert.equal(pair.terminal.reasonCode, "access_denied");
    assert.match(pair.terminal.reason, new RegExp(blocker));
  });

  it("rejects undated evidence without inventing a publication time or a complete scope", async () => {
    const fixture = fixtureJournal({
      evidence: [historicalHnEvidence({ publishedAt: null })]
    });
    const bridge = await adaptHistoricalBackfillCoverage({
      journal: fixture.journal,
      artifact: fixture.artifact,
      generatedAt: GENERATED_AT
    });
    assert.equal(bridge.collectorArtifacts[0].snapshot.evidence.length, 0);
    assert.equal(bridge.rejectedEvidence.length, 1);
    assert.equal(bridge.rejectedEvidence[0].reasonCode, "missing_published_at");
    assert.equal(bridge.targetCoverage[0].emittedEvidence, 0);
    assert.equal(bridge.targetCoverage[0].rejectedEvidence, 1);
    assert.equal(bridge.targetCoverage[0].scopeStatus, "partial");
    assert.equal(bridge.targetCoverage[0].recencyCutoffAt, null);
    assert.equal(bridge.pairScopes.length, 0);
    const attempt = bridge.collectorArtifacts[0].snapshot.attempts[fixture.targetKey];
    assert.equal(attempt.outcomeStatus, "needs_review");
    assert.match(attempt.outcomeReason, /could not satisfy native ID, URL, or timestamp integrity/);

    await assert.rejects(
      adaptHistoricalBackfillCoverage({
        journal: fixture.journal,
        artifact: fixture.artifact,
        generatedAt: GENERATED_AT,
        completionProofs: [completionProof(fixture)]
      }),
      /rejected evidence and cannot be historical-complete/
    );
  });

  it("uses an attribution-neutral physical digest for the same native HN item", async () => {
    const acme = fixtureJournal();
    const beta = fixtureJournal({
      entityId: "company-beta",
      entityName: "Beta",
      evidence: [historicalHnEvidence({
        entityId: "company-beta",
        entityName: "Beta"
      })]
    });
    const [acmeBridge, betaBridge] = await Promise.all([
      adaptHistoricalBackfillCoverage({
        journal: acme.journal,
        artifact: acme.artifact,
        generatedAt: GENERATED_AT
      }),
      adaptHistoricalBackfillCoverage({
        journal: beta.journal,
        artifact: beta.artifact,
        generatedAt: GENERATED_AT
      })
    ]);
    const acmeEvidence = acmeBridge.collectorArtifacts[0].snapshot.evidence[0];
    const betaEvidence = betaBridge.collectorArtifacts[0].snapshot.evidence[0];
    assert.match(acmeEvidence.digest, /^[a-f0-9]{64}$/);
    assert.equal(betaEvidence.digest, acmeEvidence.digest);
  });

  it("rejects proof for truncated history and journals with broken hash, sequence, tail, or bounds", async () => {
    const truncated = fixtureJournal({
      outcome: "access_blocked",
      sourceExhausted: false,
      truncated: true,
      blocker: "official_site_source_limit_reached",
      blockers: ["official_site_source_limit_reached"],
      coverageExtent: "bounded_official_site_history"
    });
    await assert.rejects(
      adaptHistoricalBackfillCoverage({
        journal: truncated.journal,
        artifact: truncated.artifact,
        generatedAt: GENERATED_AT,
        completionProofs: [completionProof(truncated)]
      }),
      /blocked\/manual target cannot be historical-complete/
    );

    const fixture = fixtureJournal();
    await assert.rejects(
      adaptHistoricalBackfillCoverage({
        journal: fixture.journal,
        artifact: { ...fixture.artifact, sha256: "a".repeat(64) },
        generatedAt: GENERATED_AT
      }),
      /sha256 mismatch/
    );
    const noNewline = fixture.journal.replace(/\n$/, "");
    await assert.rejects(
      adaptHistoricalBackfillCoverage({
        journal: noNewline,
        artifact: { ...fixture.artifact, sha256: sha256(noNewline) },
        generatedAt: GENERATED_AT
      }),
      /must end with a newline/
    );

    const brokenSequenceEvents = structuredClone(fixture.events);
    brokenSequenceEvents[1].sequence = 9;
    const brokenSequence = `${brokenSequenceEvents.map(JSON.stringify).join("\n")}\n`;
    await assert.rejects(
      adaptHistoricalBackfillCoverage({
        journal: brokenSequence,
        artifact: { ...fixture.artifact, sha256: sha256(brokenSequence) },
        generatedAt: GENERATED_AT
      }),
      /sequence must be contiguous/
    );

    await assert.rejects(
      adaptHistoricalBackfillCoverage({
        journal: fixture.journal,
        artifact: fixture.artifact,
        generatedAt: GENERATED_AT,
        limits: { maxLineBytes: 64 }
      }),
      /exceeds maxLineBytes/
    );
    await assert.rejects(
      adaptHistoricalBackfillCoverage({
        journal: fixture.journal,
        artifact: fixture.artifact,
        generatedAt: GENERATED_AT,
        limits: { maxEvents: 3 }
      }),
      /exceeds maxEvents=3/
    );
  });
});

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
