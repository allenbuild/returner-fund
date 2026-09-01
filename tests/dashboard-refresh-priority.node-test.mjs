import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveDashboardRefreshPriority,
  writeDashboardRefreshPriorityOutputs
} from "../scripts/lib/dashboard-refresh-priority.mjs";

const NOW = new Date("2026-08-30T14:00:00.000Z");

test("current ingestion publication admits the dashboard refresh", () => {
  const decision = resolveDashboardRefreshPriority({
    publicationState: watermarkState(
      "2026-08-30T11:00:00.000Z",
      "2026-08-30T11:05:00.000Z"
    ),
    now: NOW
  });

  assert.deepEqual(decision, {
    shouldRun: true,
    reason: "ingestion-publication-current",
    ingestionSlotKey: "central-2026-08-30-0600",
    publicationWatermark: "2026-08-30T11:00:00.000Z",
    watermarkStatus: "current"
  });
});

test("stale ingestion publication defers the dashboard before it reaches the Mac queue", () => {
  const decision = resolveDashboardRefreshPriority({
    publicationState: watermarkState(
      "2026-08-29T23:00:00.000Z",
      "2026-08-29T23:05:00.000Z"
    ),
    now: NOW
  });

  assert.deepEqual(decision, {
    shouldRun: false,
    reason: "defer-for-stale-ingestion",
    ingestionSlotKey: "central-2026-08-30-0600",
    publicationWatermark: "2026-08-29T23:00:00.000Z",
    watermarkStatus: "behind"
  });
});

test("a dashboard admitted before a Central rollover is rejected after waiting in the publication lane", () => {
  const publicationState = watermarkState(
    "2026-08-29T23:00:00.000Z",
    "2026-08-29T23:05:00.000Z"
  );
  const admitted = resolveDashboardRefreshPriority({
    publicationState,
    now: new Date("2026-08-30T10:59:59.000Z")
  });
  const revalidated = resolveDashboardRefreshPriority({
    publicationState,
    now: new Date("2026-08-30T11:00:01.000Z")
  });

  assert.equal(admitted.shouldRun, true);
  assert.equal(admitted.ingestionSlotKey, "central-2026-08-29-1800");
  assert.equal(revalidated.shouldRun, false);
  assert.equal(revalidated.reason, "defer-for-stale-ingestion");
  assert.equal(revalidated.ingestionSlotKey, "central-2026-08-30-0600");
});

test("missing, invalid, and stale publication states all fail closed for ingestion priority", () => {
  const scenarios = [
    { publicationState: { status: "missing" }, expectedStatus: "missing" },
    { publicationState: { status: "invalid" }, expectedStatus: "invalid" },
    {
      publicationState: watermarkState(
        "2026-08-30T10:59:59.000Z",
        "2026-08-30T11:00:01.000Z"
      ),
      expectedStatus: "behind"
    }
  ];

  for (const { publicationState, expectedStatus } of scenarios) {
    const decision = resolveDashboardRefreshPriority({ publicationState, now: NOW });
    assert.equal(decision.shouldRun, false);
    assert.equal(decision.reason, "defer-for-stale-ingestion");
    assert.equal(decision.ingestionSlotKey, "central-2026-08-30-0600");
    assert.equal(decision.watermarkStatus, expectedStatus);
  }
});

test("workflow outputs expose an auditable admission decision", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "returner-dashboard-priority-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "github-output");
  const outputs = writeDashboardRefreshPriorityOutputs({
    shouldRun: false,
    reason: "defer-for-stale-ingestion",
    ingestionSlotKey: "central-2026-08-30-0600",
    publicationWatermark: null,
    watermarkStatus: "missing"
  }, outputPath);

  assert.deepEqual(outputs, {
    should_run: "false",
    reason: "defer-for-stale-ingestion",
    ingestion_slot_key: "central-2026-08-30-0600",
    publication_watermark: "",
    watermark_status: "missing"
  });
  assert.equal(
    await readFile(outputPath, "utf8"),
    "should_run=false\nreason=defer-for-stale-ingestion\ningestion_slot_key=central-2026-08-30-0600\npublication_watermark=\nwatermark_status=missing\n"
  );
});

function watermarkState(watermark, newestGeneratedAt) {
  return {
    status: "valid",
    watermark: new Date(watermark),
    newestGeneratedAt: new Date(newestGeneratedAt),
    graphGeneratedAt: {}
  };
}
