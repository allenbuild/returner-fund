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
