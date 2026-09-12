import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseDashboardRefreshTrigger,
  resolveDashboardRefreshPriority,
  writeDashboardRefreshPriorityOutputs
} from "../scripts/lib/dashboard-refresh-priority.mjs";
import { latestEligibleCentralSlot } from "../scripts/lib/ingestion-schedule.mjs";

const NOW = new Date("2026-08-30T14:00:00.000Z");
const PUBLICATION_RUN = Object.freeze({ id: "34670958650", runAttempt: "1" });
const VALIDATION_RUN = Object.freeze({ id: "34673074196", runAttempt: "2" });

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

test("workflow completion admits only the publication or validation run bound by the current marker", () => {
  const publicationState = watermarkState(
    "2026-08-30T11:00:00.000Z",
    "2026-08-30T11:05:00.000Z"
  );

  for (const workflowRun of [PUBLICATION_RUN, VALIDATION_RUN]) {
    const decision = resolveDashboardRefreshPriority({
      publicationState,
      now: NOW,
      eventName: "workflow_run",
      workflowRun
    });
    assert.equal(decision.shouldRun, true);
    assert.equal(decision.reason, "ingestion-publication-current");
  }
});

test("unbound, missing, and malformed workflow completion identities are ignored", () => {
  const publicationState = watermarkState(
    "2026-08-30T11:00:00.000Z",
    "2026-08-30T11:05:00.000Z"
  );
  const scenarios = [
    { id: "999", runAttempt: PUBLICATION_RUN.runAttempt },
    { id: PUBLICATION_RUN.id, runAttempt: "2" },
    { id: VALIDATION_RUN.id, runAttempt: "1" },
    { id: PUBLICATION_RUN.id },
    { runAttempt: PUBLICATION_RUN.runAttempt },
    null,
    {},
    { id: "0", runAttempt: "1" },
    { id: "034670958650", runAttempt: "1" },
    { id: "not-a-run", runAttempt: "1" },
    { id: PUBLICATION_RUN.id, runAttempt: 1.5 },
    { id: Number.MAX_SAFE_INTEGER + 1, runAttempt: 1 }
  ];

  for (const workflowRun of scenarios) {
    const decision = resolveDashboardRefreshPriority({
      publicationState,
      now: NOW,
      eventName: "workflow_run",
      workflowRun
    });
    assert.equal(decision.shouldRun, false, JSON.stringify(workflowRun));
    assert.equal(decision.reason, "ignore-unbound-ingestion-completion");
    assert.equal(decision.ingestionSlotKey, "central-2026-08-30-0600");
  }
});

test("schedule and manual admission ignore workflow-run binding data", () => {
  const publicationState = watermarkState(
    "2026-08-30T11:00:00.000Z",
    "2026-08-30T11:05:00.000Z"
  );

  for (const eventName of ["schedule", "workflow_dispatch"]) {
    const decision = resolveDashboardRefreshPriority({
      publicationState,
      now: NOW,
      eventName,
      workflowRun: { id: "999", runAttempt: "999" }
    });
    assert.equal(decision.shouldRun, true);
    assert.equal(decision.reason, "ingestion-publication-current");
  }
});

test("a marker advance rejects an event that was admitted before entering the publication lane", () => {
  const oldPublicationState = watermarkState(
    "2026-08-30T11:00:00.000Z",
    "2026-08-30T11:05:00.000Z"
  );
  const advancedPublicationState = watermarkState(
    "2026-08-30T11:00:00.000Z",
    "2026-08-30T11:10:00.000Z",
    {
      publicationRun: { id: "34680000001", runAttempt: "1" },
      validationRun: { id: "34680000002", runAttempt: "1" }
    }
  );

  const admitted = resolveDashboardRefreshPriority({
    publicationState: oldPublicationState,
    now: NOW,
    eventName: "workflow_run",
    workflowRun: PUBLICATION_RUN
  });
  const revalidated = resolveDashboardRefreshPriority({
    publicationState: advancedPublicationState,
    now: NOW,
    eventName: "workflow_run",
    workflowRun: PUBLICATION_RUN
  });

  assert.equal(admitted.shouldRun, true);
  assert.equal(revalidated.shouldRun, false);
  assert.equal(revalidated.reason, "ignore-unbound-ingestion-completion");
});

test("workflow event parsing preserves the exact run id and attempt and fails closed", () => {
  assert.deepEqual(
    parseDashboardRefreshTrigger({
      eventName: "workflow_run",
      eventPayloadText: JSON.stringify({
        workflow_run: { id: 34670958650, run_attempt: 3 }
      })
    }),
    {
      eventName: "workflow_run",
      workflowRun: { id: 34670958650, runAttempt: 3 }
    }
  );

  for (const eventPayloadText of [
    "",
    "not-json",
    "null",
    "[]",
    "{}",
    '{"workflow_run":null}'
  ]) {
    assert.deepEqual(
      parseDashboardRefreshTrigger({ eventName: "workflow_run", eventPayloadText }),
      { eventName: "workflow_run", workflowRun: null }
    );
  }

  assert.deepEqual(
    parseDashboardRefreshTrigger({ eventName: "schedule", eventPayloadText: "not-json" }),
    { eventName: "schedule", workflowRun: null }
  );
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

function watermarkState(
  watermark,
  newestGeneratedAt,
  {
    publicationRun = PUBLICATION_RUN,
    validationRun = VALIDATION_RUN
  } = {}
) {
  const scheduledAt = new Date(watermark);
  const acceptedSlot = latestEligibleCentralSlot(
    new Date(scheduledAt.getTime() + 1_000)
  );
  return {
    status: "valid",
    watermark: scheduledAt,
    newestGeneratedAt: new Date(newestGeneratedAt),
    graphGeneratedAt: {},
    acceptance: {
      status: "valid",
      marker: {
        slotKey: acceptedSlot.slotKey,
        scheduledAt: acceptedSlot.scheduledAt.toISOString(),
        publicationRunId: publicationRun.id,
        publicationRunAttempt: publicationRun.runAttempt,
        validation: {
          workflowRunId: validationRun.id,
          workflowRunAttempt: validationRun.runAttempt
        }
      },
      error: null
    }
  };
}
