import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_LATENESS_WINDOW_MINUTES,
  INGESTION_UTC_CRON_CANDIDATES,
  resolveIngestionSchedule,
  resolveManualReplay,
  resolveScheduledIngestion,
  writeGithubOutputs
} from "../scripts/lib/ingestion-schedule.mjs";

test("four UTC candidates resolve to exactly two stable Central slots every calendar day", () => {
  const acceptedByCentralDay = new Map();

  for (let utcDay = new Date("2025-12-31T00:00:00.000Z"); utcDay <= new Date("2027-01-02T00:00:00.000Z"); utcDay.setUTCDate(utcDay.getUTCDate() + 1)) {
    for (const cron of INGESTION_UTC_CRON_CANDIDATES) {
      const utcHour = Number(cron.split(" ")[1]);
      const now = new Date(Date.UTC(
        utcDay.getUTCFullYear(),
        utcDay.getUTCMonth(),
        utcDay.getUTCDate(),
        utcHour,
        20
      ));
      const decision = resolveScheduledIngestion({ schedule: cron, now });
      if (!decision.accepted) continue;

      const daySlots = acceptedByCentralDay.get(decision.centralDate) ?? [];
      daySlots.push(decision);
      acceptedByCentralDay.set(decision.centralDate, daySlots);
    }
  }

  for (let day = new Date("2026-01-01T12:00:00.000Z"); day <= new Date("2026-12-31T12:00:00.000Z"); day.setUTCDate(day.getUTCDate() + 1)) {
    const dayKey = day.toISOString().slice(0, 10);
    const decisions = acceptedByCentralDay.get(dayKey) ?? [];
    assert.deepEqual(decisions.map((decision) => decision.centralTime).sort(), ["06:00", "18:00"]);
    assert.equal(new Set(decisions.map((decision) => decision.slotKey)).size, 2);
  }
});

test("selects the correct UTC candidates on both sides of DST transitions", () => {
  const cases = [
    ["2026-03-07T12:10:00.000Z", "0 12 * * *", "central-2026-03-07-0600"],
    ["2026-03-07T00:10:00.000Z", "0 0 * * *", "central-2026-03-06-1800"],
    ["2026-03-08T11:10:00.000Z", "0 11 * * *", "central-2026-03-08-0600"],
    ["2026-03-08T23:10:00.000Z", "0 23 * * *", "central-2026-03-08-1800"],
    ["2026-11-01T12:10:00.000Z", "0 12 * * *", "central-2026-11-01-0600"],
    ["2026-11-02T00:10:00.000Z", "0 0 * * *", "central-2026-11-01-1800"]
  ];

  for (const [now, cron, slotKey] of cases) {
    const decision = resolveScheduledIngestion({ schedule: cron, now: new Date(now) });
    assert.equal(decision.accepted, true, `${now} through ${cron}`);
    assert.equal(decision.slotKey, slotKey);
  }
});

test("rejects inactive DST candidates and candidates outside the lateness window", () => {
  for (const cron of ["0 0 * * *", "0 12 * * *"]) {
    const utcHour = Number(cron.split(" ")[1]);
    const decision = resolveScheduledIngestion({
      schedule: cron,
      now: new Date(Date.UTC(2026, 6, 18, utcHour, 10))
    });
    assert.equal(decision.accepted, false);
    assert.equal(decision.reason, "inactive-dst-candidate");
  }

  const late = resolveScheduledIngestion({
    schedule: "0 11 * * *",
    now: new Date(`2026-07-18T${String(11 + Math.floor(DEFAULT_LATENESS_WINDOW_MINUTES / 60)).padStart(2, "0")}:31:00.000Z`)
  });
  assert.equal(late.accepted, false);
  assert.equal(late.reason, "outside-lateness-window");
  assert.equal(resolveScheduledIngestion({ schedule: "0 6 * * *" }).accepted, false);
});

test("anchors a delayed 23:00 candidate to the prior UTC day", () => {
  const decision = resolveScheduledIngestion({
    schedule: "0 23 * * *",
    now: new Date("2026-07-19T00:02:00.000Z")
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.scheduledAt, "2026-07-18T23:00:00.000Z");
  assert.equal(decision.slotKey, "central-2026-07-18-1800");
  assert.equal(decision.latenessMinutes, 62);
});

test("manual dispatch requires and preserves an explicit replay key", () => {
  assert.equal(resolveManualReplay(" central-2026-07-18-0600 ").slotKey, "central-2026-07-18-0600");
  assert.equal(resolveManualReplay("incident:retry_2").slotKey, "incident:retry_2");
  assert.throws(() => resolveManualReplay(""), /Manual replay key/);
  assert.throws(() => resolveManualReplay("has spaces"), /Manual replay key/);

  const decision = resolveIngestionSchedule({
    eventName: "workflow_dispatch",
    replayKey: "central-2026-07-18-1800"
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.trigger, "manual-replay");
});

test("writes scheduler decisions as GitHub step outputs", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-ingestion-schedule-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "github-output");
  const decision = resolveManualReplay("manual-replay-42");

  writeGithubOutputs(decision, outputPath);

  assert.equal(
    readFileSync(outputPath, "utf8"),
    [
      "should_run=true",
      "slot_key=manual-replay-42",
      "trigger=manual-replay",
      "reason=explicit-replay-key",
      "scheduled_at=",
      ""
    ].join("\n")
  );
});
