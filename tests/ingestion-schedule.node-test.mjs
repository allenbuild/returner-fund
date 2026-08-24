import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  INGESTION_UTC_CRON_CANDIDATES,
  latestEligibleCentralSlot,
  main as runScheduleController,
  readPublicationWatermark,
  resolveIngestionSchedule,
  resolveManualReplay,
  resolveScheduledIngestion,
  revalidateIngestionCandidate,
  validateCandidateForRevalidation,
  writeGithubOutputs
} from "../scripts/lib/ingestion-schedule.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every scheduled cron is only a wakeup for the same newest eligible Central slot", () => {
  const now = new Date("2026-08-22T12:10:00.000Z");
  const publicationState = watermarkState(
    "2026-08-21T23:10:00.000Z",
    "2026-08-21T23:11:00.000Z"
  );

  const decisions = INGESTION_UTC_CRON_CANDIDATES.map((schedule) =>
    resolveScheduledIngestion({ schedule, publicationState, now })
  );

  for (const decision of decisions) {
    assert.equal(decision.accepted, true);
    assert.equal(decision.reason, "retry-publication-watermark");
    assert.equal(decision.slotKey, "central-2026-08-22-0600");
    assert.equal(decision.scheduledAt, "2026-08-22T11:00:00.000Z");
    assert.equal(decision.watermarkStatus, "behind");
    assert.equal(decision.recoveryDebt, true);
  }
  assert.equal(resolveScheduledIngestion({ schedule: "0 6 * * *", publicationState, now }).accepted, false);
});

test("minimum genuine graph timestamp is the publication watermark", () => {
  const now = new Date("2026-08-22T12:10:00.000Z");
  const decision = resolveScheduledIngestion({
    schedule: INGESTION_UTC_CRON_CANDIDATES[0],
    publicationState: watermarkState(
      "2026-08-22T11:00:05.000Z",
      "2026-08-22T11:00:41.000Z"
    ),
    now
  });

  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, "publication-watermark-current");
  assert.equal(decision.publicationWatermark, "2026-08-22T11:00:05.000Z");
  assert.equal(decision.watermarkStatus, "current");
  assert.equal(decision.latestEligibleSlotKey, "central-2026-08-22-0600");
});

test("coverage disagreement is divergent while jointly stale graphs retry newest-first", () => {
  const now = new Date("2026-08-22T23:10:00.000Z");
  const divergent = resolveScheduledIngestion({
    schedule: INGESTION_UTC_CRON_CANDIDATES[1],
    publicationState: watermarkState(
      "2026-08-22T22:59:59.000Z",
      "2026-08-22T23:00:01.000Z"
    ),
    now
  });
  const stale = resolveScheduledIngestion({
    schedule: INGESTION_UTC_CRON_CANDIDATES[1],
    publicationState: watermarkState(
      "2026-08-14T00:00:00.000Z",
      "2026-08-20T23:00:00.000Z"
    ),
    now
  });

  assert.equal(divergent.accepted, true);
  assert.equal(divergent.watermarkStatus, "divergent");
  assert.equal(divergent.slotKey, "central-2026-08-22-1800");
  assert.equal(stale.accepted, true);
  assert.equal(stale.watermarkStatus, "behind");
  assert.equal(stale.slotKey, "central-2026-08-22-1800");
  assert.notEqual(stale.slotKey, "central-2026-08-14-1800");
});

test("missing and invalid graph watermarks fail closed into retry", () => {
  const now = new Date("2026-08-22T12:10:00.000Z");
  for (const status of ["missing", "invalid"]) {
    const decision = resolveScheduledIngestion({
      schedule: INGESTION_UTC_CRON_CANDIDATES[0],
      publicationState: {
        status,
        watermark: null,
        newestGeneratedAt: null,
        graphGeneratedAt: {}
      },
      now
    });
    assert.equal(decision.accepted, true);
    assert.equal(decision.reason, "retry-publication-watermark");
    assert.equal(decision.watermarkStatus, status);
    assert.equal(decision.slotKey, "central-2026-08-22-0600");
  }

  for (const publicationState of [
    watermarkState("2026-08-22T12:11:00.000Z", "2026-08-22T12:12:00.000Z"),
    {
      status: "valid",
      watermark: new Date("2026-08-22T11:02:00.000Z"),
      newestGeneratedAt: new Date("2026-08-22T11:01:00.000Z"),
      graphGeneratedAt: {}
    }
  ]) {
    const decision = resolveScheduledIngestion({
      schedule: INGESTION_UTC_CRON_CANDIDATES[0],
      publicationState,
      now
    });
    assert.equal(decision.accepted, true);
    assert.equal(decision.watermarkStatus, "invalid");
  }
});

test("reader validates both expected graph identities and timestamps using temp fixtures", async (t) => {
  const directory = temporaryDirectory(t, "returner-watermark-files-");
  const now = new Date("2026-08-22T12:10:00.000Z");
  writeGraphs(directory, {
    s26: "2026-08-22T11:00:05.000Z",
    s2026: "2026-08-22T11:00:41.000Z"
  });

  const valid = await readPublicationWatermark({ cwd: directory, now });
  assert.equal(valid.status, "valid");
  assert.equal(valid.watermark.toISOString(), "2026-08-22T11:00:05.000Z");
  assert.equal(valid.newestGeneratedAt.toISOString(), "2026-08-22T11:00:41.000Z");

  rmSync(path.join(directory, "public/graph/manifest.json"));
  assert.equal((await readPublicationWatermark({ cwd: directory, now })).status, "missing");
  writePublicationManifest(directory, {
    s26: "2026-08-22T11:00:05.000Z",
    s2026: "2026-08-22T11:00:41.000Z"
  });

  rmSync(path.join(directory, "public/graph/s2026.json"));
  assert.equal((await readPublicationWatermark({ cwd: directory, now })).status, "missing");

  writeGraph(directory, "s2026", "WRONG", "2026-08-22T11:00:41.000Z");
  assert.equal((await readPublicationWatermark({ cwd: directory, now })).status, "invalid");

  writeGraph(directory, "s2026", "S2026", "2026-02-30T00:00:00.000Z");
  assert.equal((await readPublicationWatermark({ cwd: directory, now })).status, "invalid");

  writeGraph(directory, "s2026", "S2026", "2026-08-22T12:10:01.000Z");
  assert.equal((await readPublicationWatermark({ cwd: directory, now })).status, "invalid");
});

test("complete publication manifest keeps recovery open when a non-base artifact is stale", async (t) => {
  const directory = temporaryDirectory(t, "returner-watermark-completeness-");
  const now = new Date("2026-08-22T12:10:00.000Z");
  writeGraphs(directory, {
    s26: "2026-08-22T11:02:00.000Z",
    s2026: "2026-08-22T11:01:00.000Z",
    overrides: { "a16zsr006.json": "2026-08-20T23:00:00.000Z" }
  });

  const state = await readPublicationWatermark({ cwd: directory, now });
  const decision = resolveScheduledIngestion({
    schedule: INGESTION_UTC_CRON_CANDIDATES.at(-1),
    publicationState: state,
    now
  });
  assert.equal(state.status, "valid");
  assert.equal(state.watermark.toISOString(), "2026-08-20T23:00:00.000Z");
  assert.equal(decision.accepted, true);
  assert.equal(decision.watermarkStatus, "divergent");
  assert.equal(decision.slotKey, "central-2026-08-22-0600");

  writeGraphs(directory, {
    s26: "2026-08-22T11:02:00.000Z",
    s2026: "2026-08-22T11:01:00.000Z",
    overrides: { "s26-score-benchmarks.json": "2026-08-20T23:30:00.000Z" }
  });
  const benchmarkState = await readPublicationWatermark({ cwd: directory, now });
  assert.equal(benchmarkState.watermark.toISOString(), "2026-08-20T23:30:00.000Z");
  assert.equal(resolveScheduledIngestion({
    schedule: INGESTION_UTC_CRON_CANDIDATES.at(-1),
    publicationState: benchmarkState,
    now
  }).accepted, true);
});

test("a reverted pair of graph artifacts reopens only the newest slot", async (t) => {
  const directory = temporaryDirectory(t, "returner-watermark-revert-");
  const now = new Date("2026-08-22T12:10:00.000Z");
  writeGraphs(directory, {
    s26: "2026-08-22T11:02:00.000Z",
    s2026: "2026-08-22T11:01:00.000Z"
  });
  let state = await readPublicationWatermark({ cwd: directory, now });
  assert.equal(resolveScheduledIngestion({ schedule: INGESTION_UTC_CRON_CANDIDATES[0], publicationState: state, now }).accepted, false);

  writeGraphs(directory, {
    s26: "2026-08-14T20:00:00.000Z",
    s2026: "2026-08-14T20:01:00.000Z"
  });
  state = await readPublicationWatermark({ cwd: directory, now });
  const reverted = resolveScheduledIngestion({
    schedule: INGESTION_UTC_CRON_CANDIDATES[0],
    publicationState: state,
    now
  });
  assert.equal(reverted.accepted, true);
  assert.equal(reverted.slotKey, "central-2026-08-22-0600");
  assert.equal(reverted.watermarkStatus, "behind");
});

test("git-ref watermark reads committed HEAD rather than mutable worktree files", async (t) => {
  const directory = temporaryDirectory(t, "returner-watermark-git-");
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Ingestion Schedule Test"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "ingestion-schedule@example.invalid"], { cwd: directory });
  writeGraphs(directory, {
    s26: "2026-08-20T22:00:00.000Z",
    s2026: "2026-08-20T22:00:30.000Z"
  });
  execFileSync("git", ["add", "public/graph/s26.json", "public/graph/s2026.json", "public/graph/manifest.json"], { cwd: directory });
  execFileSync("git", ["commit", "--quiet", "-m", "Fixture graph watermark"], { cwd: directory });

  writeGraphs(directory, {
    s26: "2026-08-22T11:01:00.000Z",
    s2026: "2026-08-22T11:02:00.000Z"
  });
  const committed = await readPublicationWatermark({
    cwd: directory,
    ref: "HEAD",
    now: new Date("2026-08-22T12:10:00.000Z")
  });
  assert.equal(committed.watermark.toISOString(), "2026-08-20T22:00:00.000Z");
});

test("serialized revalidation no-ops duplicate queued wakeups after main becomes current", () => {
  const candidate = scheduledCandidate();
  const decision = revalidateIngestionCandidate({
    candidate,
    eventName: "schedule",
    schedule: INGESTION_UTC_CRON_CANDIDATES[0],
    publicationState: watermarkState(
      "2026-08-22T11:01:00.000Z",
      "2026-08-22T11:02:00.000Z"
    ),
    now: new Date("2026-08-22T12:10:00.000Z")
  });

  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, "queued-publication-watermark-current");
  assert.equal(decision.watermarkStatus, "current");
});

test("serialized controller revalidation reads the fetched git ref and emits a queued no-op", async (t) => {
  const directory = temporaryDirectory(t, "returner-watermark-revalidation-");
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Ingestion Schedule Test"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "ingestion-schedule@example.invalid"], { cwd: directory });
  writeGraphs(directory, {
    s26: "2026-08-22T11:01:00.000Z",
    s2026: "2026-08-22T11:02:00.000Z"
  });
  execFileSync("git", ["add", "public/graph/s26.json", "public/graph/s2026.json", "public/graph/manifest.json"], { cwd: directory });
  execFileSync("git", ["commit", "--quiet", "-m", "Current graph watermark"], { cwd: directory });
  const outputPath = path.join(directory, "github-output");
  const candidate = scheduledCandidate();

  const decision = await runScheduleController({
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_EVENT_SCHEDULE: INGESTION_UTC_CRON_CANDIDATES[0],
    GITHUB_OUTPUT: outputPath,
    INGESTION_REVALIDATE_CANDIDATE: "true",
    INGESTION_PUBLICATION_REF: "HEAD",
    CANDIDATE_TRIGGER: candidate.trigger,
    CANDIDATE_SLOT_KEY: candidate.slotKey,
    CANDIDATE_SCHEDULED_AT: candidate.scheduledAt,
    CANDIDATE_REASON: candidate.reason,
    CANDIDATE_RECOVERY_DEBT: "true"
  }, {
    cwd: directory,
    now: new Date("2026-08-22T12:10:00.000Z")
  });

  assert.equal(decision.reason, "queued-publication-watermark-current");
  assert.match(readFileSync(outputPath, "utf8"), /^should_run=false$/m);
  assert.match(readFileSync(outputPath, "utf8"), /^watermark_status=current$/m);
});

test("newest-slot rollover preempts an older queued candidate", () => {
  const decision = revalidateIngestionCandidate({
    candidate: scheduledCandidate(),
    eventName: "schedule",
    schedule: INGESTION_UTC_CRON_CANDIDATES[0],
    publicationState: watermarkState(
      "2026-08-21T23:00:00.000Z",
      "2026-08-21T23:01:00.000Z"
    ),
    now: new Date("2026-08-22T23:10:00.000Z")
  });

  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, "queued-candidate-superseded");
  assert.equal(decision.candidateSlotKey, "central-2026-08-22-0600");
  assert.equal(decision.latestEligibleSlotKey, "central-2026-08-22-1800");
});

test("same newest queued slot proceeds when current main remains stale", () => {
  const decision = revalidateIngestionCandidate({
    candidate: scheduledCandidate(),
    eventName: "schedule",
    schedule: INGESTION_UTC_CRON_CANDIDATES.at(-1),
    publicationState: watermarkState(
      "2026-08-21T23:00:00.000Z",
      "2026-08-21T23:01:00.000Z"
    ),
    now: new Date("2026-08-22T12:10:00.000Z")
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.reason, "revalidated-publication-watermark");
  assert.equal(decision.slotKey, "central-2026-08-22-0600");
});

test("latest eligible slot remains exact across spring and fall DST", () => {
  const cases = [
    ["2026-03-08T11:05:00.000Z", "central-2026-03-08-0600", "2026-03-08T11:00:00.000Z"],
    ["2026-03-08T23:05:00.000Z", "central-2026-03-08-1800", "2026-03-08T23:00:00.000Z"],
    ["2026-11-01T12:05:00.000Z", "central-2026-11-01-0600", "2026-11-01T12:00:00.000Z"],
    ["2026-11-02T00:05:00.000Z", "central-2026-11-01-1800", "2026-11-02T00:00:00.000Z"]
  ];

  for (const [now, slotKey, scheduledAt] of cases) {
    const latest = latestEligibleCentralSlot(new Date(now));
    assert.equal(latest.slotKey, slotKey);
    assert.equal(latest.scheduledAt.toISOString(), scheduledAt);
  }
});

test("manual replay keys remain explicit, strict, and independent of watermark scheduling", () => {
  const manual = resolveIngestionSchedule({
    eventName: "workflow_dispatch",
    replayKey: "central-2099-01-01-0600"
  });
  assert.equal(manual.accepted, true);
  assert.equal(manual.trigger, "manual-replay");
  assert.equal(manual.reason, "explicit-replay-key");
  assert.equal(manual.recoveryDebt, false);
  assert.equal(manual.watermarkStatus, "manual");

  const revalidated = revalidateIngestionCandidate({
    candidate: {
      trigger: "manual-replay",
      slotKey: manual.slotKey,
      scheduledAt: null,
      reason: manual.reason,
      recoveryDebt: false
    },
    eventName: "workflow_dispatch"
  });
  assert.equal(revalidated.accepted, true);
  assert.equal(revalidated.reason, "revalidated-manual-replay");
  assert.throws(() => resolveManualReplay(""), /Manual replay key/);
  assert.throws(() => resolveManualReplay("has spaces"), /Manual replay key/);
});

test("queued candidate provenance is strict and cannot claim ordinary schedule semantics", () => {
  assert.throws(
    () => validateCandidateForRevalidation({
      ...scheduledCandidate(),
      reason: "intended-central-slot"
    }, { eventName: "schedule" }),
    /publication-watermark resolver/
  );
  assert.throws(
    () => validateCandidateForRevalidation({
      trigger: "manual-replay",
      slotKey: "manual-key",
      scheduledAt: "2026-08-22T11:00:00.000Z",
      reason: "explicit-replay-key",
      recoveryDebt: false
    }, { eventName: "workflow_dispatch" }),
    /contradictory/
  );
  assert.throws(
    () => revalidateIngestionCandidate({
      candidate: scheduledCandidate(),
      eventName: "schedule",
      schedule: "0 6 * * *",
      publicationState: watermarkState(
        "2026-08-22T11:01:00.000Z",
        "2026-08-22T11:02:00.000Z"
      ),
      now: new Date("2026-08-22T12:10:00.000Z")
    }),
    /failed closed: unrecognized-cron/
  );
});

test("scheduler no longer scans complete commit history", () => {
  const source = readFileSync(
    path.join(repositoryRoot, "scripts/lib/ingestion-schedule.mjs"),
    "utf8"
  );
  assert.doesNotMatch(source, /git\s+log|--full-history|execFileSync|maxBuffer/);
  assert.match(source, /git", \["cat-file", "blob"/);
});

test("writes watermark diagnostics as GitHub step outputs", (t) => {
  const directory = temporaryDirectory(t, "returner-ingestion-output-");
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
      "publication_watermark=",
      "watermark_status=manual",
      "latest_slot_key=",
      ""
    ].join("\n")
  );
});

function watermarkState(first, second) {
  const instants = [new Date(first), new Date(second)].sort((left, right) => left - right);
  return {
    status: "valid",
    watermark: instants[0],
    newestGeneratedAt: instants[1],
    graphGeneratedAt: {
      "public/graph/s26.json": first,
      "public/graph/s2026.json": second
    }
  };
}

function scheduledCandidate() {
  return {
    trigger: "schedule",
    slotKey: "central-2026-08-22-0600",
    scheduledAt: "2026-08-22T11:00:00.000Z",
    reason: "retry-publication-watermark",
    recoveryDebt: true
  };
}

function temporaryDirectory(t, prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeGraphs(root, { s26, s2026, overrides = {} }) {
  writeGraph(root, "s26", "S26", s26);
  writeGraph(root, "s2026", "S2026", s2026);
  writePublicationManifest(root, { s26, s2026, overrides });
}

function writePublicationManifest(root, { s26, s2026, overrides = {} }) {
  const graphFilenames = [
    "s2026.json", "s2026-yc-partners.json", "s2026-insiders.json",
    "s26.json", "s26-yc-partners.json", "s26-insiders.json",
    "a16zsr006.json", "a16zsr006-yc-partners.json", "a16zsr006-insiders.json"
  ];
  const benchmarkFilenames = [
    "s2026-score-benchmarks.json", "s26-score-benchmarks.json",
    "a16zsr006-score-benchmarks.json"
  ];
  const fallback = [s26, s2026].sort()[0];
  const entry = (filename) => ({
    filename,
    sha256: "a".repeat(64),
    byteSize: 1,
    generatedAt: overrides[filename] ?? fallback
  });
  const graphDirectory = path.join(root, "public/graph");
  mkdirSync(graphDirectory, { recursive: true });
  writeFileSync(path.join(graphDirectory, "manifest.json"), `${JSON.stringify({
    schemaVersion: 2,
    publishedAt: [s26, s2026].sort().at(-1),
    ingestionRunId: "fixture-run",
    graphArtifacts: graphFilenames.map(entry),
    benchmarkArtifacts: benchmarkFilenames.map(entry),
    contentHash: "b".repeat(64)
  })}\n`);
}

function writeGraph(root, fileSlug, batchSlug, generatedAt) {
  const graphDirectory = path.join(root, "public/graph");
  mkdirSync(graphDirectory, { recursive: true });
  writeFileSync(
    path.join(graphDirectory, `${fileSlug}.json`),
    `${JSON.stringify({ batch: { slug: batchSlug }, generatedAt })}\n`
  );
}
