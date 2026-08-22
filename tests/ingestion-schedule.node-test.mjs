import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_LATENESS_WINDOW_MINUTES,
  INGESTION_PRIMARY_UTC_CRON_CANDIDATES,
  INGESTION_RECOVERY_CRON,
  INGESTION_RECOVERY_ROLLOUT_SCHEDULED_AT,
  INGESTION_RECOVERY_ROLLOUT_SLOT_KEY,
  INGESTION_UTC_CRON_CANDIDATES,
  enumerateExpectedCentralSlotsThrough,
  parsePublishedCentralSlotKeysFromGitLog,
  readPublishedCentralSlotKeysFromGitHistory,
  resolveIngestionSchedule,
  resolveManualReplay,
  resolveRecoveryIngestion,
  resolveScheduledIngestion,
  writeGithubOutputs
} from "../scripts/lib/ingestion-schedule.mjs";

test("four UTC candidates resolve to exactly two stable Central slots every calendar day", () => {
  const acceptedByCentralDay = new Map();

  for (let utcDay = new Date("2025-12-31T00:00:00.000Z"); utcDay <= new Date("2027-01-02T00:00:00.000Z"); utcDay.setUTCDate(utcDay.getUTCDate() + 1)) {
    for (const cron of INGESTION_PRIMARY_UTC_CRON_CANDIDATES) {
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

test("recovery starts at the fixed rollout epoch and preserves debt across slot rollover", () => {
  assert.deepEqual(INGESTION_UTC_CRON_CANDIDATES, [
    ...INGESTION_PRIMARY_UTC_CRON_CANDIDATES,
    INGESTION_RECOVERY_CRON
  ]);
  assert.equal(INGESTION_RECOVERY_ROLLOUT_SLOT_KEY, "central-2026-08-22-0600");
  assert.equal(INGESTION_RECOVERY_ROLLOUT_SCHEDULED_AT, "2026-08-22T11:00:00.000Z");

  const decision = resolveScheduledIngestion({
    schedule: INGESTION_RECOVERY_CRON,
    now: new Date("2026-08-23T11:05:00.000Z"),
    publishedSlotKeys: [INGESTION_RECOVERY_ROLLOUT_SLOT_KEY]
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.reason, "retry-missing-publication");
  assert.equal(decision.slotKey, "central-2026-08-22-1800");
  assert.equal(decision.scheduledAt, "2026-08-22T23:00:00.000Z");
  assert.equal(decision.recoveryDebt, true);
});

test("multiple recovery debts are selected oldest-first", () => {
  const decision = resolveRecoveryIngestion({
    now: new Date("2026-08-24T00:05:00.000Z"),
    publishedSlotKeys: [INGESTION_RECOVERY_ROLLOUT_SLOT_KEY]
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.slotKey, "central-2026-08-22-1800");
  assert.equal(decision.recoveryDebt, true);
});

test("a newer published slot never masks older recovery debt", () => {
  const decision = resolveRecoveryIngestion({
    now: new Date("2026-08-23T12:00:00.000Z"),
    publishedSlotKeys: [
      INGESTION_RECOVERY_ROLLOUT_SLOT_KEY,
      "central-2026-08-23-0600"
    ]
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.slotKey, "central-2026-08-22-1800");
  assert.equal(decision.scheduledAt, "2026-08-22T23:00:00.000Z");
});

test("resolver-authorized recovery debt remains eligible after eleven hours", () => {
  const decision = resolveRecoveryIngestion({
    now: new Date("2026-08-23T12:30:00.000Z"),
    publishedSlotKeys: []
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.slotKey, INGESTION_RECOVERY_ROLLOUT_SLOT_KEY);
  assert.ok(decision.latenessMinutes > DEFAULT_LATENESS_WINDOW_MINUTES);
  assert.equal(decision.recoveryDebt, true);
});

test("recovery becomes a no-op when every expected slot is published", () => {
  const now = new Date("2026-08-24T00:05:00.000Z");
  const publishedSlotKeys = enumerateExpectedCentralSlotsThrough(now)
    .map(({ slotKey }) => slotKey);
  const decision = resolveRecoveryIngestion({ now, publishedSlotKeys });

  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, "all-expected-slots-published");
  assert.equal(decision.recoveryDebt, false);
});

test("expected Central slots remain exact across fall and spring DST transitions", () => {
  const fall = enumerateExpectedCentralSlotsThrough(new Date("2026-11-02T00:05:00.000Z"))
    .filter(({ centralDate }) => centralDate >= "2026-10-31")
    .map(({ slotKey, scheduledAt }) => [slotKey, scheduledAt.toISOString()]);
  assert.deepEqual(fall, [
    ["central-2026-10-31-0600", "2026-10-31T11:00:00.000Z"],
    ["central-2026-10-31-1800", "2026-10-31T23:00:00.000Z"],
    ["central-2026-11-01-0600", "2026-11-01T12:00:00.000Z"],
    ["central-2026-11-01-1800", "2026-11-02T00:00:00.000Z"]
  ]);

  const spring = enumerateExpectedCentralSlotsThrough(new Date("2027-03-14T23:05:00.000Z"))
    .filter(({ centralDate }) => centralDate >= "2027-03-13")
    .map(({ slotKey, scheduledAt }) => [slotKey, scheduledAt.toISOString()]);
  assert.deepEqual(spring, [
    ["central-2027-03-13-0600", "2027-03-13T12:00:00.000Z"],
    ["central-2027-03-13-1800", "2027-03-14T00:00:00.000Z"],
    ["central-2027-03-14-0600", "2027-03-14T11:00:00.000Z"],
    ["central-2027-03-14-1800", "2027-03-14T23:00:00.000Z"]
  ]);
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
  assert.equal(decision.recoveryDebt, false);
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
      "recovery_debt=false",
      ""
    ].join("\n")
  );
});

test("parses only canonical immutable publication commits from git history", () => {
  const canonical = publicationLogRecord({
    commit: "a".repeat(40),
    slotKey: "central-2026-08-22-0600"
  });
  const wrongSubject = publicationLogRecord({
    commit: "b".repeat(40),
    slotKey: "central-2026-08-22-1800",
    subject: "Merge publication output"
  });
  const duplicateTrailer = publicationLogRecord({
    commit: "c".repeat(40),
    slotKey: "central-2026-08-23-0600",
    extraTrailers: ["Returner-Slot-Key: central-2026-08-23-0600"]
  });
  const malformedReceipt = publicationLogRecord({
    commit: "d".repeat(40),
    slotKey: "central-2026-08-23-1800",
    receiptHash: "not-a-sha256"
  });

  assert.deepEqual(
    [...parsePublishedCentralSlotKeysFromGitLog(
      canonical + wrongSubject + duplicateTrailer + malformedReceipt
    )],
    ["central-2026-08-22-0600"]
  );
});

test("reads the verified published slot set from complete git history, not HEAD state", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-ingestion-history-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Ingestion Schedule Test"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "ingestion-schedule@example.invalid"], { cwd: directory });

  const markerPath = path.join(directory, "marker.txt");
  for (const [index, slotKey] of [
    "central-2026-08-22-0600",
    "central-2026-08-22-1800"
  ].entries()) {
    writeFileSync(markerPath, `${slotKey}\n`);
    execFileSync("git", ["add", "marker.txt"], { cwd: directory });
    execFileSync("git", ["commit", "--quiet", "-m", publicationMessage(slotKey, index)], {
      cwd: directory
    });
  }
  writeFileSync(markerPath, "ordinary head\n");
  execFileSync("git", ["add", "marker.txt"], { cwd: directory });
  execFileSync("git", ["commit", "--quiet", "-m", "Ordinary head commit"], { cwd: directory });

  assert.deepEqual(
    [...readPublishedCentralSlotKeysFromGitHistory({ cwd: directory })].sort(),
    ["central-2026-08-22-0600", "central-2026-08-22-1800"]
  );
});

test("does not expose inactive DST candidate schedule metadata to the workflow", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-ingestion-inactive-schedule-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "github-output");
  const decision = resolveScheduledIngestion({
    schedule: "0 12 * * *",
    now: new Date("2026-07-18T12:10:00.000Z")
  });

  assert.equal(decision.accepted, false);
  assert.equal(decision.scheduledAt, "2026-07-18T12:00:00.000Z");
  writeGithubOutputs(decision, outputPath);

  assert.equal(
    readFileSync(outputPath, "utf8"),
    [
      "should_run=false",
      "slot_key=",
      "trigger=schedule",
      "reason=inactive-dst-candidate",
      "scheduled_at=",
      "recovery_debt=false",
      ""
    ].join("\n")
  );
});

function publicationLogRecord({
  commit,
  slotKey,
  subject = `Publish autonomous ingestion ${slotKey}`,
  sourceSha = "e".repeat(40),
  runId = "123",
  runAttempt = "1",
  receiptHash = "f".repeat(64),
  extraTrailers = []
}) {
  const message = [
    subject,
    "",
    `Returner-Slot-Key: ${slotKey}`,
    `Returner-Source-SHA: ${sourceSha}`,
    `Returner-Run-ID: ${runId}`,
    `Returner-Run-Attempt: ${runAttempt}`,
    `Returner-Receipt-SHA256: ${receiptHash}`,
    ...extraTrailers,
    ""
  ].join("\n");
  return `${commit}\0${subject}\0${message}\0\n`;
}

function publicationMessage(slotKey, index) {
  return publicationLogRecord({
    commit: "0".repeat(40),
    slotKey,
    sourceSha: String(index + 1).repeat(40),
    runId: String(index + 1),
    receiptHash: String(index + 2).repeat(64)
  }).split("\0")[2];
}
