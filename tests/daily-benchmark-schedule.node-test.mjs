import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DAILY_BENCHMARK_LATENESS_WINDOW_MINUTES,
  DAILY_BENCHMARK_UTC_CRON_CANDIDATES,
  resolveDailyBenchmarkSchedule,
  resolveScheduledDailyBenchmark,
  writeDailyBenchmarkGithubOutputs
} from "../scripts/lib/daily-benchmark-schedule.mjs";

test("DST-safe candidates resolve to exactly one Central-midnight update per day", () => {
  const acceptedByCentralDay = new Map();
  for (let utcDay = new Date("2025-12-31T00:00:00.000Z"); utcDay <= new Date("2027-01-02T00:00:00.000Z"); utcDay.setUTCDate(utcDay.getUTCDate() + 1)) {
    for (const cron of DAILY_BENCHMARK_UTC_CRON_CANDIDATES) {
      const utcHour = Number(cron.split(" ")[1]);
      const decision = resolveScheduledDailyBenchmark({
        schedule: cron,
        now: new Date(Date.UTC(
          utcDay.getUTCFullYear(),
          utcDay.getUTCMonth(),
          utcDay.getUTCDate(),
          utcHour,
          20
        ))
      });
      if (!decision.accepted) continue;
      const decisions = acceptedByCentralDay.get(decision.centralDate) ?? [];
      decisions.push(decision);
      acceptedByCentralDay.set(decision.centralDate, decisions);
    }
  }

  for (let day = new Date("2026-01-01T12:00:00.000Z"); day <= new Date("2026-12-31T12:00:00.000Z"); day.setUTCDate(day.getUTCDate() + 1)) {
    const decisions = acceptedByCentralDay.get(day.toISOString().slice(0, 10)) ?? [];
    assert.equal(decisions.length, 1);
    assert.ok([5, 6].includes(decisions[0].scheduledUtcHour));
  }
});

test("selects the correct UTC candidate on both sides of DST", () => {
  const cases = [
    ["2026-03-08T06:10:00.000Z", "0 6 * * *", "2026-03-08"],
    ["2026-03-09T05:10:00.000Z", "0 5 * * *", "2026-03-09"],
    ["2026-11-01T05:10:00.000Z", "0 5 * * *", "2026-11-01"],
    ["2026-11-02T06:10:00.000Z", "0 6 * * *", "2026-11-02"]
  ];
  for (const [now, schedule, centralDate] of cases) {
    const decision = resolveScheduledDailyBenchmark({ schedule, now: new Date(now) });
    assert.equal(decision.accepted, true, `${now} through ${schedule}`);
    assert.equal(decision.centralDate, centralDate);
  }
});

test("rejects inactive, unknown, and excessively late schedule candidates", () => {
  const inactive = resolveScheduledDailyBenchmark({
    schedule: "0 6 * * *",
    now: new Date("2026-07-18T06:10:00.000Z")
  });
  assert.equal(inactive.accepted, false);
  assert.equal(inactive.reason, "inactive-dst-candidate");
  assert.equal(resolveScheduledDailyBenchmark({ schedule: "0 7 * * *" }).reason, "unrecognized-cron");

  const late = resolveScheduledDailyBenchmark({
    schedule: "0 5 * * *",
    now: new Date(`2026-07-18T${String(5 + Math.floor(DAILY_BENCHMARK_LATENESS_WINDOW_MINUTES / 60)).padStart(2, "0")}:31:00.000Z`)
  });
  assert.equal(late.accepted, false);
  assert.equal(late.reason, "outside-lateness-window");
});

test("anchors a delayed candidate to its actual prior UTC occurrence", () => {
  const decision = resolveScheduledDailyBenchmark({
    schedule: "0 6 * * *",
    now: new Date("2026-11-03T06:45:00.000Z")
  });
  assert.equal(decision.scheduledAt, "2026-11-03T06:00:00.000Z");
  assert.equal(decision.scheduledUtcHour, 6);
  assert.equal(decision.centralDate, "2026-11-03");
});

test("manual dispatch always admits one main-branch benchmark publication", () => {
  const decision = resolveDailyBenchmarkSchedule({ eventName: "workflow_dispatch" });
  assert.equal(decision.accepted, true);
  assert.equal(decision.trigger, "manual-dispatch");
  assert.equal(decision.scheduledUtcHour, null);
});

test("writes complete GitHub outputs for the workflow resolver", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-benchmark-schedule-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "github-output");
  const decision = resolveScheduledDailyBenchmark({
    schedule: "0 5 * * *",
    now: new Date("2026-07-18T05:15:00.000Z")
  });
  writeDailyBenchmarkGithubOutputs(decision, outputPath);
  assert.equal(
    readFileSync(outputPath, "utf8"),
    [
      "should_run=true",
      "scheduled_utc_hour=5",
      "trigger=schedule",
      "reason=intended-central-midnight",
      "scheduled_at=2026-07-18T05:00:00.000Z",
      "central_date=2026-07-18",
      ""
    ].join("\n")
  );
});
