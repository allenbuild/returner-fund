import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import {
  classifyAutonomousIngestionReceipt,
  recordAutonomousIngestionReceipt,
  selectPublishedAutonomousIngestionReceipt
} from "../scripts/lib/autonomous-ingestion-receipt-policy.mjs";

const PUBLISHED_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const healthyPublication = {
  runnerStatus: "refreshed",
  publicationStatus: "published",
  publishedCommit: PUBLISHED_COMMIT,
  collectionHealth: "complete",
  newPhysicalSources: 12,
  dailyNewPhysicalSources: 12,
  dailySourceHealth: "healthy"
};

describe("autonomous ingestion receipt policy", () => {
  it("selects only an exact, schema-valid, recognized published replay receipt", () => {
    const valid = {
      schemaVersion: 1,
      idempotencyKey: "central-2026-08-09-1800",
      collectionHealth: "degraded",
      newPhysicalSources: 7,
      dailyNewPhysicalSources: 11,
      dailySourceHealth: "healthy"
    };
    const selected = selectPublishedAutonomousIngestionReceipt({
      idempotencyKey: valid.idempotencyKey,
      publishedCommit: PUBLISHED_COMMIT,
      currentReceipt: { ...valid, idempotencyKey: "another-slot" },
      history: [
        valid,
        { ...valid, schemaVersion: 2 },
        { ...valid, collectionHealth: "unknown" }
      ]
    });

    assert.deepEqual(selected?.receipt, valid);
    assert.equal(selected?.classification.receiptStatus, "noop_degraded");
    assert.equal(selected?.classification.conclusion, "warning");
  });

  it("rejects mismatched, malformed, and incomplete commit-backed replay receipts", () => {
    const base = {
      schemaVersion: 1,
      idempotencyKey: "central-2026-08-09-0600",
      collectionHealth: "complete",
      newPhysicalSources: 1,
      dailyNewPhysicalSources: 1,
      dailySourceHealth: "healthy"
    };

    for (const receipt of [
      { ...base, idempotencyKey: "wrong-slot" },
      { ...base, schemaVersion: 2 },
      { ...base, newPhysicalSources: "" },
      { ...base, dailyNewPhysicalSources: "" },
      { ...base, newPhysicalSources: 0.5 },
      { ...base, newPhysicalSources: [1] },
      { ...base, dailyNewPhysicalSources: -1 },
      { ...base, dailyNewPhysicalSources: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, newPhysicalSources: 2, dailyNewPhysicalSources: 1 },
      { ...base, newPhysicalSources: 0, dailyNewPhysicalSources: 5, dailySourceHealth: "stale_day" },
      { ...base, newPhysicalSources: 0, dailyNewPhysicalSources: 5, dailySourceHealth: "awaiting_second_slot" },
      { ...base, newPhysicalSources: 0, dailyNewPhysicalSources: 0, dailySourceHealth: "healthy" },
      { ...base, dailySourceHealth: "unknown" }
    ]) {
      assert.equal(selectPublishedAutonomousIngestionReceipt({
        idempotencyKey: base.idempotencyKey,
        publishedCommit: PUBLISHED_COMMIT,
        history: [receipt]
      }), null);
    }
  });

  it("requires an exact full commit SHA for published, unchanged, and replay receipts", () => {
    for (const [runnerStatus, publicationStatus, expectedStatus] of [
      ["refreshed", "published", "published_missing_commit"],
      ["refreshed", "no_changes", "no_changes_missing_commit"],
      ["already_completed", "already_completed", "noop_missing_commit"]
    ]) {
      for (const publishedCommit of ["", "c5506de", "g".repeat(40), "a".repeat(39), "a".repeat(41)]) {
        const result = classifyAutonomousIngestionReceipt({
          ...healthyPublication,
          runnerStatus,
          publicationStatus,
          publishedCommit
        });
        assert.equal(result.receiptStatus, expectedStatus);
        assert.equal(result.conclusion, "failure");
        assert.match(result.message, /exact full 40-hex repository commit SHA/);
      }
    }
  });

  it("rejects an idempotent replay health receipt without repository commit proof", () => {
    const receipt = {
      schemaVersion: 1,
      idempotencyKey: "central-2026-08-09-1800",
      collectionHealth: "complete",
      newPhysicalSources: 2,
      dailyNewPhysicalSources: 2,
      dailySourceHealth: "healthy"
    };

    assert.equal(selectPublishedAutonomousIngestionReceipt({
      idempotencyKey: receipt.idempotencyKey,
      history: [receipt]
    }), null);
    assert.equal(selectPublishedAutonomousIngestionReceipt({
      idempotencyKey: receipt.idempotencyKey,
      publishedCommit: "c5506de",
      history: [receipt]
    }), null);
  });

  it("keeps a validated degraded publication successful with a visible warning", () => {
    assert.deepEqual(
      classifyAutonomousIngestionReceipt({
        ...healthyPublication,
        collectionHealth: "degraded"
      }),
      {
        receiptStatus: "published_degraded",
        conclusion: "warning",
        message: "Artifacts were validated and published with degraded collection coverage."
      }
    );
  });

  it("promotes provider outages and mapped collector defects to degraded warnings", () => {
    for (const coverageSignal of [
      { providerBlocked: 17 },
      { mappedProviderBlocked: 9 },
      { mappedScopeUnsupported: 4 },
      { mappedFailures: 2 }
    ]) {
      const result = classifyAutonomousIngestionReceipt({
        ...healthyPublication,
        collectionHealth: "complete",
        ...coverageSignal
      });
      assert.equal(result.receiptStatus, "published_degraded");
      assert.equal(result.conclusion, "warning");
    }
  });

  it("warns for a quiet morning slot while leaving the final daily slot pending", () => {
    const published = classifyAutonomousIngestionReceipt({
      ...healthyPublication,
      newPhysicalSources: 0,
      dailyNewPhysicalSources: 0,
      dailySourceHealth: "awaiting_second_slot"
    });
    const unchanged = classifyAutonomousIngestionReceipt({
      ...healthyPublication,
      publicationStatus: "no_changes",
      newPhysicalSources: 0,
      dailyNewPhysicalSources: 0,
      dailySourceHealth: "awaiting_second_slot"
    });

    assert.equal(published.receiptStatus, "published_no_new_sources");
    assert.equal(published.conclusion, "warning");
    assert.match(published.message, /final daily slot remains pending/);
    assert.equal(unchanged.receiptStatus, "no_changes");
    assert.equal(unchanged.conclusion, "warning");
    assert.match(unchanged.message, /final daily slot remains pending/);
  });

  it("keeps the verified final stale slot successful with a warning", () => {
    const result = classifyAutonomousIngestionReceipt({
      ...healthyPublication,
      newPhysicalSources: 0,
      dailyNewPhysicalSources: 0,
      dailySourceHealth: "stale_day"
    });

    assert.equal(result.receiptStatus, "published_stale_day");
    assert.equal(result.conclusion, "warning");
    assert.match(result.message, /Both Central ingestion slots/);
  });

  it("keeps verified stale no-change publications and idempotent replays successful", () => {
    const unchanged = classifyAutonomousIngestionReceipt({
      ...healthyPublication,
      publicationStatus: "no_changes",
      newPhysicalSources: 0,
      dailyNewPhysicalSources: 0,
      dailySourceHealth: "stale_day"
    });
    const replay = classifyAutonomousIngestionReceipt({
      ...healthyPublication,
      runnerStatus: "already_completed",
      publicationStatus: "already_completed",
      newPhysicalSources: 0,
      dailyNewPhysicalSources: 0,
      dailySourceHealth: "stale_day"
    });

    assert.equal(unchanged.receiptStatus, "no_changes_stale_day");
    assert.equal(unchanged.conclusion, "warning");
    assert.equal(replay.receiptStatus, "noop_stale_day");
    assert.equal(replay.conclusion, "warning");
  });

  it("fails unknown outcomes and incomplete health receipts", () => {
    assert.equal(classifyAutonomousIngestionReceipt({
      ...healthyPublication,
      runnerStatus: "crashed"
    }).conclusion, "failure");
    assert.equal(classifyAutonomousIngestionReceipt({
      ...healthyPublication,
      collectionHealth: "unknown"
    }).receiptStatus, "published_missing_receipt");
    assert.equal(classifyAutonomousIngestionReceipt({
      ...healthyPublication,
      dailySourceHealth: "unknown"
    }).conclusion, "failure");
    assert.equal(classifyAutonomousIngestionReceipt({
      ...healthyPublication,
      newPhysicalSources: ""
    }).receiptStatus, "published_missing_receipt");
    assert.equal(classifyAutonomousIngestionReceipt({
      ...healthyPublication,
      publicationStatus: "no_changes",
      newPhysicalSources: ""
    }).receiptStatus, "no_changes_missing_receipt");
    assert.equal(classifyAutonomousIngestionReceipt({
      ...healthyPublication,
      runnerStatus: "already_completed",
      publicationStatus: "already_completed",
      newPhysicalSources: ""
    }).receiptStatus, "noop_missing_receipt");
    assert.equal(classifyAutonomousIngestionReceipt({
      ...healthyPublication,
      dailyNewPhysicalSources: "",
      dailySourceHealth: "stale_day"
    }).receiptStatus, "published_missing_receipt");
  });

  it("requires exact count and daily-health invariants for every outcome", () => {
    const cases = [
      [{ newPhysicalSources: -1 }, /non-negative safe integers/],
      [{ newPhysicalSources: 1.5 }, /non-negative safe integers/],
      [{ dailyNewPhysicalSources: 1.5 }, /non-negative safe integers/],
      [{ newPhysicalSources: 4, dailyNewPhysicalSources: 3 }, /cannot be smaller/],
      [{ newPhysicalSources: 0, dailyNewPhysicalSources: 0, dailySourceHealth: "healthy" }, /requires a positive/],
      [{ newPhysicalSources: 0, dailyNewPhysicalSources: 2, dailySourceHealth: "stale_day" }, /requires a zero/],
      [{ newPhysicalSources: 0, dailyNewPhysicalSources: 2, dailySourceHealth: "awaiting_second_slot" }, /requires a zero/]
    ];
    for (const [overrides, message] of cases) {
      const result = classifyAutonomousIngestionReceipt({
        ...healthyPublication,
        ...overrides
      });
      assert.equal(result.conclusion, "failure");
      assert.match(result.message, message);
    }

    const healthySecondSlot = classifyAutonomousIngestionReceipt({
      ...healthyPublication,
      newPhysicalSources: 0,
      dailyNewPhysicalSources: 8
    });
    assert.equal(healthySecondSlot.conclusion, "warning");
    assert.equal(healthySecondSlot.receiptStatus, "published_no_new_sources");
  });

  it("writes auditable outputs and a summary without changing warning into failure", async () => {
    const writes = [];
    const result = await recordAutonomousIngestionReceipt({
      env: {
        RUNNER_STATUS: "refreshed",
        PUBLICATION_STATUS: "published",
        COLLECTION_HEALTH: "complete",
        COLLECTION_HEALTH_REASONS: "provider_blocked:412,mapped_provider_blocked:357,mapped_scope_unsupported:10",
        PROVIDER_BLOCKED: "412",
        PROVIDER_BLOCKED_BY_REASON: '{"provider_blocked:duckduckgo_html:public_search_circuit_open":55,"provider_blocked:jina_reader:linkedin_public_circuit_open":321,"provider_transport_or_access_blocked:instagram":36}',
        MAPPED_PROVIDER_BLOCKED: "357",
        MAPPED_PROVIDER_BLOCKED_BY_REASON: '{"provider_blocked:jina_reader:linkedin_public_circuit_open":321,"provider_transport_or_access_blocked:instagram":36}',
        MAPPED_SCOPE_UNSUPPORTED: "10",
        MAPPED_FAILURES: "1",
        NEW_PHYSICAL_SOURCES: "30",
        DAILY_NEW_PHYSICAL_SOURCES: "33",
        DAILY_SOURCE_HEALTH: "healthy",
        SLOT_KEY: "central-2026-07-25-1800",
        PUBLISHED_COMMIT,
        GITHUB_OUTPUT: "/fake/output",
        GITHUB_STEP_SUMMARY: "/fake/summary"
      },
      writeOutput: async (...args) => writes.push(["output", ...args]),
      writeSummary: async (...args) => writes.push(["summary", ...args])
    });

    assert.equal(result.conclusion, "warning");
    assert.equal(writes.length, 2);
    assert.match(writes[0][2], /receipt_status=published_degraded/);
    assert.match(writes[0][2], /receipt_conclusion=warning/);
    assert.match(writes[1][2], /New physical sources this slot: 30/);
    assert.match(writes[1][2], /New physical sources this Central day: 33/);
    assert.match(writes[1][2], /Collection health: degraded/);
    assert.match(writes[1][2], /Collection health reasons: provider_blocked:412,mapped_provider_blocked:357,mapped_scope_unsupported:10/);
    assert.match(writes[1][2], /Provider-blocked tasks \(all\): 412/);
    assert.match(writes[1][2], /Provider blocker reasons \(all\): \{"provider_blocked:duckduckgo_html:public_search_circuit_open":55/);
    assert.match(writes[1][2], /Provider-blocked mapped tasks: 357/);
    assert.match(writes[1][2], /Mapped scope unsupported: 10/);
    assert.match(writes[1][2], /Mapped hard failures: 1/);
    assert.match(writes[1][2], /Artifact validation: passed/);
  });

  it("emits a supported GitHub Actions notice annotation for healthy CLI outcomes", () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/lib/autonomous-ingestion-receipt-policy.mjs")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          RUNNER_STATUS: "refreshed",
          PUBLICATION_STATUS: "published",
          COLLECTION_HEALTH: "complete",
          NEW_PHYSICAL_SOURCES: "12",
          DAILY_NEW_PHYSICAL_SOURCES: "12",
          DAILY_SOURCE_HEALTH: "healthy",
          PUBLISHED_COMMIT,
          SLOT_KEY: "central-2026-07-26-0600",
          GITHUB_OUTPUT: "",
          GITHUB_STEP_SUMMARY: ""
        }
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^::notice title=Autonomous ingestion completed::published /);
    assert.doesNotMatch(result.stdout, /::success /);
  });
});
