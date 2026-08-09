import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeIngestionSourceDeltaHistory,
  physicalSourceKey,
  summarizeIngestionSourceDelta
} from "../scripts/lib/ingestion-source-delta.mjs";

const row = (platformPostId, overrides = {}) => ({
  batchSlug: "S2026",
  platform: "x",
  entityType: "company",
  entityId: "company-example",
  sourceUrl: `https://x.com/example/status/${platformPostId}`,
  platformPostId,
  postedAt: "2026-07-21T12:00:00.000Z",
  ...overrides
});

test("counts only previously unseen physical posts as new sources", () => {
  const receipt = summarizeIngestionSourceDelta({
    idempotencyKey: "central-2026-07-21-0600",
    beforeSnapshots: [{ evidence: [row("100")] }],
    afterSnapshots: [{ evidence: [
      row("100", { entityId: "founder-example" }),
      row("101", { platform: "twitter" })
    ] }],
    observedAt: "2026-07-21T13:00:00.000Z"
  });

  assert.equal(receipt.baselinePhysicalSources, 1);
  assert.equal(receipt.publishedPhysicalSources, 2);
  assert.equal(receipt.newPhysicalSources, 1);
  assert.equal(receipt.newPhysicalSourcesThisAttempt, 1);
  assert.equal(receipt.retainedPhysicalSources, 1);
  assert.equal(receipt.dailyNewPhysicalSources, 1);
  assert.equal(receipt.dailySourceHealth, "healthy");
  assert.deepEqual(receipt.insertedByBatchPlatform, { "S2026:x": 1 });
  assert.equal(physicalSourceKey(row("100")), "x:100");
});

test("does not mistake a refreshed timestamp or changed attribution for a new source", () => {
  const receipt = summarizeIngestionSourceDelta({
    idempotencyKey: "central-2026-07-21-0600",
    beforeSnapshots: [{ evidence: [row("100", { last_checked_at: "2026-07-20T00:00:00Z" })] }],
    afterSnapshots: [{ evidence: [row("100", {
      entityType: "founder",
      entityId: "founder-example",
      last_checked_at: "2026-07-21T00:00:00Z"
    })] }]
  });

  assert.equal(receipt.newPhysicalSources, 0);
  assert.equal(receipt.dailySourceHealth, "awaiting_second_slot");
});

test("marks terminal-but-ineffective mapped collection and missing credentials as degraded", () => {
  const receipt = summarizeIngestionSourceDelta({
    idempotencyKey: "central-2026-07-22-0600",
    beforeSnapshots: [{ evidence: [row("100")] }],
    afterSnapshots: [{ evidence: [row("100")] }],
    collectionCoverage: {
      mappedExpected: 1837,
      mappedSucceeded: 90,
      mappedNeedsReview: 503,
      mappedBlockedOrEmpty: 1243,
      providerBlocked: 412,
      providerBlockedByReason: {
        "provider_blocked:duckduckgo_html:public_search_circuit_open": 55,
        "provider_blocked:jina_reader:linkedin_public_circuit_open": 321,
        "provider_transport_or_access_blocked:instagram": 36
      },
      mappedProviderBlocked: 357,
      mappedProviderBlockedByReason: {
        "provider_blocked:jina_reader:linkedin_public_circuit_open": 321,
        "provider_transport_or_access_blocked:instagram": 36
      },
      mappedScopeUnsupported: 10,
      mappedFailed: 1,
      mappedNonTerminal: 0
    },
    credentialGaps: ["EXA_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "X_RECENT_SEARCH_ERRORS:3"]
  });

  assert.equal(receipt.collectionHealth, "degraded");
  assert.equal(receipt.mappedSuccessRate, 0.049);
  assert.deepEqual(receipt.collectionHealthReasons, [
    "missing_credential:EXA_API_KEY",
    "missing_credential:SUPABASE_SERVICE_ROLE_KEY",
    "connector_failure:X_RECENT_SEARCH_ERRORS:3",
    "mapped_failures:1",
    "provider_blocked:412",
    "mapped_provider_blocked:357",
    "mapped_scope_unsupported:10",
    "mapped_success_rate_below_10_percent:0.0490"
  ]);
  assert.equal(receipt.providerBlocked, 412);
  assert.deepEqual(receipt.providerBlockedByReason, {
    "provider_blocked:duckduckgo_html:public_search_circuit_open": 55,
    "provider_blocked:jina_reader:linkedin_public_circuit_open": 321,
    "provider_transport_or_access_blocked:instagram": 36
  });
  assert.equal(receipt.mappedProviderBlocked, 357);
  assert.deepEqual(receipt.mappedProviderBlockedByReason, {
    "provider_blocked:jina_reader:linkedin_public_circuit_open": 321,
    "provider_transport_or_access_blocked:instagram": 36
  });
  assert.equal(receipt.mappedScopeUnsupported, 10);
});

test("marks URL-less provider outages degraded without changing mapped efficacy", () => {
  const receipt = summarizeIngestionSourceDelta({
    idempotencyKey: "central-2026-07-22-0600",
    beforeSnapshots: [{ evidence: [row("100")] }],
    afterSnapshots: [{ evidence: [row("100"), row("101")] }],
    collectionCoverage: {
      mappedExpected: 100,
      mappedSucceeded: 50,
      mappedNeedsReview: 25,
      mappedBlockedOrEmpty: 25,
      providerBlocked: 17,
      providerBlockedByReason: {
        "provider_blocked:duckduckgo_html:public_search_circuit_open": 17
      },
      mappedProviderBlocked: 0,
      mappedProviderBlockedByReason: {},
      mappedScopeUnsupported: 0,
      mappedFailed: 0,
      mappedNonTerminal: 0
    }
  });

  assert.equal(receipt.collectionHealth, "degraded");
  assert.deepEqual(receipt.collectionHealthReasons, ["provider_blocked:17"]);
  assert.equal(receipt.providerBlocked, 17);
  assert.deepEqual(receipt.providerBlockedByReason, {
    "provider_blocked:duckduckgo_html:public_search_circuit_open": 17
  });
  assert.equal(receipt.mappedProviderBlocked, 0);
  assert.equal(receipt.mappedSuccessRate, 0.5);
});

test("accepts healthy mapped efficacy when credentials and terminal outcomes are sound", () => {
  const receipt = summarizeIngestionSourceDelta({
    idempotencyKey: "central-2026-07-22-0600",
    beforeSnapshots: [{ evidence: [row("100")] }],
    afterSnapshots: [{ evidence: [row("100"), row("101")] }],
    collectionCoverage: {
      mappedExpected: 100,
      mappedSucceeded: 30,
      mappedNeedsReview: 20,
      mappedBlockedOrEmpty: 50,
      mappedFailed: 0,
      mappedNonTerminal: 0
    },
    credentialGaps: []
  });

  assert.equal(receipt.collectionHealth, "complete");
  assert.deepEqual(receipt.collectionHealthReasons, []);
});

test("final daily slot becomes stale only when both slots found no new sources", () => {
  const stale = summarizeIngestionSourceDelta({
    idempotencyKey: "central-2026-07-21-1800",
    beforeSnapshots: [{ evidence: [row("100")] }],
    afterSnapshots: [{ evidence: [row("100")] }],
    previousHistory: [{
      idempotencyKey: "central-2026-07-21-0600",
      centralDay: "2026-07-21",
      newPhysicalSources: 0
    }]
  });
  assert.equal(stale.dailyNewPhysicalSources, 0);
  assert.equal(stale.dailySourceHealth, "stale_day");

  const healthy = summarizeIngestionSourceDelta({
    idempotencyKey: "central-2026-07-21-1800",
    beforeSnapshots: [{ evidence: [row("100")] }],
    afterSnapshots: [{ evidence: [row("100")] }],
    previousHistory: [{
      idempotencyKey: "central-2026-07-21-0600",
      centralDay: "2026-07-21",
      newPhysicalSources: 3
    }]
  });
  assert.equal(healthy.dailyNewPhysicalSources, 3);
  assert.equal(healthy.dailySourceHealth, "healthy");
});

test("history is idempotent by slot key", () => {
  const history = mergeIngestionSourceDeltaHistory([
    { idempotencyKey: "central-2026-07-21-0600", observedAt: "2026-07-21T12:00:00Z", newPhysicalSources: 1 }
  ], {
    idempotencyKey: "central-2026-07-21-0600",
    observedAt: "2026-07-21T12:10:00Z",
    newPhysicalSources: 2
  });
  assert.equal(history.length, 1);
  assert.equal(history[0].newPhysicalSources, 2);
});

test("same-slot file-backed replay preserves earlier new-source credit", () => {
  const receipt = summarizeIngestionSourceDelta({
    idempotencyKey: "central-2026-07-21-0600",
    beforeSnapshots: [{ evidence: [row("100")] }],
    afterSnapshots: [{ evidence: [row("100")] }],
    previousHistory: [{
      idempotencyKey: "central-2026-07-21-0600",
      centralDay: "2026-07-21",
      newPhysicalSources: 4,
      insertedByBatchPlatform: { "S2026:x": 4 },
      insertedSourceSamples: [row("96")],
      newestNewSourcePostedAt: "2026-07-21T11:00:00Z"
    }]
  });

  assert.equal(receipt.newPhysicalSourcesThisAttempt, 0);
  assert.equal(receipt.newPhysicalSources, 4);
  assert.equal(receipt.dailyNewPhysicalSources, 4);
  assert.equal(receipt.dailySourceHealth, "healthy");
  assert.deepEqual(receipt.insertedByBatchPlatform, { "S2026:x": 4 });
});

test("same-slot file-backed replay adds newly discovered sources without erasing prior credit", () => {
  const receipt = summarizeIngestionSourceDelta({
    idempotencyKey: "central-2026-07-21-0600",
    beforeSnapshots: [{ evidence: [row("100")] }],
    afterSnapshots: [{ evidence: [row("100"), row("101")] }],
    previousHistory: [{
      idempotencyKey: "central-2026-07-21-0600",
      centralDay: "2026-07-21",
      newPhysicalSources: 4,
      insertedByBatchPlatform: { "S2026:x": 4 },
      insertedSourceSamples: [row("96")],
      newestNewSourcePostedAt: "2026-07-21T11:00:00Z"
    }]
  });

  assert.equal(receipt.newPhysicalSourcesThisAttempt, 1);
  assert.equal(receipt.newPhysicalSources, 5);
  assert.equal(receipt.dailyNewPhysicalSources, 5);
  assert.equal(receipt.dailySourceHealth, "healthy");
  assert.deepEqual(receipt.insertedByBatchPlatform, { "S2026:x": 5 });
});

test("tracks GitHub repositories and preserves case-sensitive native IDs", () => {
  const receipt = summarizeIngestionSourceDelta({
    idempotencyKey: "central-2026-07-21-0600",
    beforeSnapshots: [{ evidence: [row("AbC123", {
      platform: "youtube",
      sourceUrl: "https://youtube.com/watch?v=AbC123"
    })] }],
    afterSnapshots: [{ evidence: [
      row("AbC123", { platform: "youtube", sourceUrl: "https://youtube.com/watch?v=AbC123" }),
      row("abc123", { platform: "youtube", sourceUrl: "https://youtube.com/watch?v=abc123" }),
      {
        batchSlug: "S26",
        platform: "github",
        entityType: "company",
        entityId: "company-example",
        sourceUrl: "https://github.com/Owner/NewRepo",
        platformPostId: "Owner/NewRepo",
        postedAt: "2026-07-21T10:00:00Z"
      }
    ] }]
  });

  assert.equal(receipt.newPhysicalSources, 2);
  assert.deepEqual(receipt.insertedByBatchPlatform, {
    "S2026:youtube": 1,
    "S26:github": 1
  });
  assert.notEqual(
    physicalSourceKey(row("AbC123", { platform: "youtube", sourceUrl: "https://youtube.com/watch?v=AbC123" })),
    physicalSourceKey(row("abc123", { platform: "youtube", sourceUrl: "https://youtube.com/watch?v=abc123" }))
  );
  assert.equal(
    physicalSourceKey({ platform: "github", sourceUrl: "https://github.com/Owner/NewRepo", platformPostId: "Owner/NewRepo" }),
    physicalSourceKey({ platform: "github", sourceUrl: "https://github.com/owner/newrepo", platformPostId: "owner/newrepo" })
  );
});

test("uses stable GitHub repository IDs across owner and repository renames", () => {
  const before = {
    batchSlug: "S2026",
    platform: "github",
    entityType: "company",
    entityId: "company-interfaze",
    sourceUrl: "https://github.com/JigsawStack/deep-research",
    platformPostId: "JigsawStack/deep-research",
    platformObjectId: "1035391429",
    postedAt: "2026-07-21T10:00:00Z"
  };
  const after = {
    ...before,
    sourceUrl: "https://github.com/InterfazeAI/deep-research",
    platformPostId: "InterfazeAI/deep-research"
  };

  const receipt = summarizeIngestionSourceDelta({
    idempotencyKey: "central-2026-07-26-1800",
    beforeSnapshots: [{ evidence: [before] }],
    afterSnapshots: [{ evidence: [after] }]
  });

  assert.equal(physicalSourceKey(before), "github:object:1035391429");
  assert.equal(physicalSourceKey(after), "github:object:1035391429");
  assert.equal(receipt.newPhysicalSources, 0);
  assert.equal(receipt.retainedPhysicalSources, 1);
  assert.equal(receipt.removedPhysicalSources, 0);
});

test("collapses an ID-less promoted GitHub row into its existing raw repository", () => {
  const rawRepository = {
    batchSlug: "S2026",
    platform: "github",
    entityType: "company",
    entityId: "company-interfaze",
    sourceUrl: "https://github.com/InterfazeAI/deep-research",
    platformPostId: "InterfazeAI/deep-research",
    platformObjectId: "1035391429",
    postedAt: "2026-07-21T10:00:00Z"
  };
  const promotedEvidence = {
    ...rawRepository,
    platformObjectId: null
  };

  const receipt = summarizeIngestionSourceDelta({
    idempotencyKey: "central-2026-07-26-1800",
    beforeSnapshots: [{ evidence: [rawRepository] }],
    afterSnapshots: [{ evidence: [rawRepository, promotedEvidence] }]
  });

  assert.equal(receipt.baselinePhysicalSources, 1);
  assert.equal(receipt.publishedPhysicalSources, 1);
  assert.equal(receipt.newPhysicalSources, 0);
  assert.equal(receipt.retainedPhysicalSources, 1);
  assert.equal(receipt.removedPhysicalSources, 0);
});

test("discovers GitHub object aliases from either side of the publication diff", () => {
  const idlessEvidence = {
    batchSlug: "S2026",
    platform: "github",
    entityType: "company",
    entityId: "company-interfaze",
    sourceUrl: "https://github.com/InterfazeAI/deep-research",
    platformPostId: null,
    postedAt: "2026-07-21T10:00:00Z"
  };
  const rawRepository = {
    ...idlessEvidence,
    platformPostId: "InterfazeAI/deep-research",
    platformObjectId: "1035391429"
  };

  const receipt = summarizeIngestionSourceDelta({
    idempotencyKey: "central-2026-07-26-1800",
    beforeSnapshots: [{ evidence: [idlessEvidence] }],
    afterSnapshots: [{ evidence: [rawRepository] }]
  });

  assert.equal(receipt.baselinePhysicalSources, 1);
  assert.equal(receipt.publishedPhysicalSources, 1);
  assert.equal(receipt.newPhysicalSources, 0);
  assert.equal(receipt.retainedPhysicalSources, 1);
  assert.equal(receipt.removedPhysicalSources, 0);
});
