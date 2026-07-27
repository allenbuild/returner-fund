import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const repositoryRoot = process.cwd();
const sharedRepositoryRoot = path.dirname(
  execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: repositoryRoot, encoding: "utf8" }
  ).trim()
);
const dependencyRoot = path.join(sharedRepositoryRoot, "node_modules");
const runnerPath = path.join(repositoryRoot, "scripts", "run-long-cycle.mjs");
const launcherPath = path.join(repositoryRoot, "scripts", "start-long-cycle.mjs");
const claimLeasePath = path.join(repositoryRoot, "scripts", "long-cycle-claim-lease.mjs");
const terminalRunStatuses = new Set([
  "complete",
  "smoke_complete",
  "deadline_complete",
  "failed",
  "interrupted"
]);
const [runnerSource, launcherSource] = await Promise.all([
  readFile(runnerPath, "utf8"),
  readFile(launcherPath, "utf8")
]);
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("five-hour source sweep orchestrator", () => {
  it("uses the current Node runtime, exact default duration, all-batch autonomous collection, and process-tree deadlines", () => {
    assert.match(runnerSource, /requestedDurationMinutes[\s\S]*\?\? 300/);
    assert.match(launcherSource, /\?\? 300/);
    assert.match(runnerSource, /Math\.min\(\s*45,\s*Math\.max\(1 \/ 60_000, durationMinutes \/ 2\)/);
    assert.match(
      launcherSource,
      /`--minimum-sweep-minutes=\$\{minimumSweepMinutes\}`/
    );
    for (const status of ["deadline_complete", "failed", "interrupted"]) {
      assert.ok(
        launcherSource.includes(`"${status}"`),
        `${status} must be terminal rather than resumable`
      );
    }
    assert.match(runnerSource, /spawn\(process\.execPath/);
    assert.match(launcherSource, /spawn\(process\.execPath/);
    assert.doesNotMatch(runnerSource, /spawn\(["'](?:node|npm)["']/);
    assert.match(runnerSource, /run-autonomous-ingestion\.mjs/);
    assert.match(
      runnerSource,
      /autonomousRunnerPath,\s*"--skip-publish",\s*"--resume-snapshots",\s*`--campaign-key=\$\{runId\}`,\s*`--idempotency-key=\$\{idempotencyKey\}`/
    );
    for (const batch of ["S2026", "S26", "A16ZSR006"]) {
      assert.ok(runnerSource.includes(batch), `${batch} must be explicit in the orchestration contract`);
    }
    assert.match(runnerSource, /process\.kill\(-child\.pid, "SIGTERM"\)/);
    assert.match(runnerSource, /resumableCycleIndex/);
    assert.match(launcherSource, /canResume/);
    assert.match(runnerSource, /orchestrator_checkpoint/);
    assert.match(runnerSource, /lastHeartbeatAt/);
    assert.match(runnerSource, /process\.on\(signal/);
    assert.match(runnerSource, /clearEscalationTimer\(child\)/);
    assert.match(runnerSource, /start-long-cycle\.mjs/);
    assert.match(runnerSource, /LONG_RUN_ALLOW_DIRECT/);
  });

  it("uses a timezone-independent process-start fingerprint", () => {
    const helperUrl = pathToFileURL(claimLeasePath).href;
    const source = [
      `import { processStartFingerprint } from ${JSON.stringify(helperUrl)};`,
      "process.stdout.write(processStartFingerprint(process.ppid) ?? '');"
    ].join("\n");
    const fingerprintFor = (timezone) => execFileSync(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LC_ALL: "C",
          LANG: "C",
          TZ: timezone
        }
      }
    );
    const utc = fingerprintFor("UTC");
    assert.ok(utc);
    assert.equal(fingerprintFor("America/Los_Angeles"), utc);
  });

  it("smoke-plans every autonomous batch without network access", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "returner-long-cycle-"));
    temporaryRoots.push(root);
    await Promise.all([
      symlink(path.join(repositoryRoot, "scripts"), path.join(root, "scripts"), "dir"),
      symlink(path.join(repositoryRoot, "src"), path.join(root, "src"), "dir"),
      symlink(path.join(repositoryRoot, "public"), path.join(root, "public"), "dir"),
      symlink(dependencyRoot, path.join(root, "node_modules"), "dir")
    ]);
    const startedAt = new Date().toISOString();
    const result = spawnSync(
      process.execPath,
      [runnerPath, "--smoke", "--minutes=2", "--checkpoint-minutes=1"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            "--preserve-symlinks-main"
          ].filter(Boolean).join(" "),
          LONG_RUN_ALLOW_DIRECT: "1",
          LONG_RUN_ID: "contract-smoke",
          LONG_RUN_START_AT: startedAt
        }
      }
    );

    assert.equal(result.status, 0, result.stderr);
    const runLog = JSON.parse(
      await readFile(path.join(root, "outputs", "longrun", "contract-smoke.json"), "utf8")
    );
    const smokeEvent = runLog.eventLog.find((event) => event.type === "smoke_passed");
    assert.deepEqual(smokeEvent?.batches, ["S2026", "S26", "A16ZSR006"]);
    const finished = runLog.eventLog.find((event) => event.type === "run_finished");
    assert.equal(finished?.status, "smoke_complete");
    const active = JSON.parse(
      await readFile(path.join(root, "outputs", "longrun", "active-run.json"), "utf8")
    );
    assert.equal(active.status, "smoke_complete");
    assert.ok(active.lastHeartbeatAt);
  });

  it("does not spawn a sweep when less than the configured useful-time reserve remains", async () => {
    const root = await createStubRoot(`
      import { writeFile } from "node:fs/promises";
      await writeFile("unexpected-spawn", "spawned");
    `);
    const runId = "insufficient-time";
    const result = runFixture(root, {
      runId,
      startedAt: new Date(Date.now() - 50_000).toISOString(),
      args: ["--minutes=1", "--minimum-sweep-minutes=0.25"]
    });

    assert.equal(result.status, 0, result.stderr);
    const runLog = await readRunLog(root, runId);
    assert.equal(runLog.eventLog.some((event) => event.type === "sweep_started"), false);
    assert.equal(
      runLog.eventLog.filter((event) => event.type === "sweep_skipped_insufficient_time").length,
      1
    );
    assert.equal(await exists(path.join(root, "unexpected-spawn")), false);
    assertSingleFinishedEvent(runLog, "deadline_complete");
    const active = await readActiveRun(root);
    assert.equal(active.status, "deadline_complete");
  });

  it("lets an admitted sweep finish atomically across the horizon and starts no replacement", async () => {
    const root = await createStubRoot(`
      import { writeFile } from "node:fs/promises";
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      await writeFile("atomic-sweep-finished", "finished");
    `);
    const runId = "atomic-across-horizon";
    const result = runFixture(root, {
      runId,
      startedAt: new Date(Date.now() - 57_000).toISOString(),
      args: ["--minutes=1", "--minimum-sweep-minutes=0.001"]
    });

    assert.equal(result.status, 0, result.stderr);
    const runLog = await readRunLog(root, runId);
    assert.equal(await exists(path.join(root, "atomic-sweep-finished")), true);
    assert.equal(
      runLog.eventLog.filter((event) => event.type === "sweep_started").length,
      1
    );
    assert.equal(
      runLog.eventLog.filter((event) => event.type === "sweep_succeeded").length,
      1
    );
    assert.equal(
      runLog.eventLog.filter((event) => event.type === "sweep_skipped_insufficient_time").length,
      1
    );
    assert.equal(runLog.eventLog.some((event) => event.type === "sweep_deadline_reached"), false);
    assert.equal(runLog.eventLog.some((event) => event.type === "sweep_failed"), false);
    assert.equal(runLog.eventLog.some((event) => event.type === "run_failed"), false);
    assertSingleFinishedEvent(runLog, "deadline_complete");
  });

  it("returns nonzero and finalizes failed exactly once after a genuine child failure", async () => {
    const root = await createStubRoot(`
      process.stderr.write("fixture failure\\n");
      process.exitCode = 7;
    `);
    const runId = "genuine-failure";
    const result = runFixture(root, {
      runId,
      startedAt: new Date().toISOString(),
      args: ["--minutes=1", "--minimum-sweep-minutes=0.001"]
    });

    assert.notEqual(result.status, 0);
    const runLog = await readRunLog(root, runId);
    const failedSweep = runLog.eventLog.find((event) => event.type === "sweep_failed");
    assert.equal(failedSweep?.exitCode, 7);
    assert.equal(failedSweep?.terminationReason, "completed");
    assert.equal(runLog.eventLog.filter((event) => event.type === "run_failed").length, 1);
    assertSingleFinishedEvent(runLog, "failed");
    assert.equal(runLog.eventLog.some(
      (event) => event.type === "run_finished" && event.status === "complete"
    ), false);
    const active = await readActiveRun(root);
    assert.equal(active.status, "failed");
  });

  it("uses the configured duration in reserve-cutoff messages", async () => {
    const root = await createStubRoot("");
    const runId = "custom-duration";
    const result = runFixture(root, {
      runId,
      startedAt: new Date(Date.now() - (7 * 60_000) + 1_000).toISOString(),
      args: ["--minutes=7", "--minimum-sweep-minutes=1"]
    });

    assert.equal(result.status, 0, result.stderr);
    const runLog = await readRunLog(root, runId);
    const cutoff = runLog.eventLog.find(
      (event) => event.type === "sweep_skipped_insufficient_time"
    );
    assert.match(cutoff?.reason ?? "", /7-minute source-sweep window/);
    assert.doesNotMatch(cutoff?.reason ?? "", /300-minute/);
    assertSingleFinishedEvent(runLog, "deadline_complete");
  });

  it("finalizes an interrupted run exactly once", async () => {
    const root = await createStubRoot("setInterval(() => {}, 1_000);");
    const runId = "signal-interruption";
    const running = runFixtureAsync(root, {
      runId,
      startedAt: new Date().toISOString(),
      args: ["--minutes=1", "--minimum-sweep-minutes=0.001"]
    });

    await waitFor(async () => {
      if (!await exists(path.join(root, "outputs", "longrun", `${runId}.json`))) return false;
      const runLog = await readRunLog(root, runId);
      return runLog.eventLog.some((event) => event.type === "sweep_started");
    });
    running.child.kill("SIGTERM");
    const result = await running.completion;

    assert.equal(result.code, 143, result.stderr);
    const runLog = await readRunLog(root, runId);
    assert.equal(runLog.eventLog.some((event) => event.type === "run_failed"), false);
    assertSingleFinishedEvent(runLog, "interrupted");
    const active = await readActiveRun(root);
    assert.equal(active.status, "interrupted");
  });

  it("does not append another terminal event when the same run is invoked again", async () => {
    const root = await createStubRoot("");
    const runId = "already-finished";
    const fixture = {
      runId,
      startedAt: new Date().toISOString(),
      args: ["--once", "--minutes=1", "--minimum-sweep-minutes=0.001"]
    };

    const first = runFixture(root, fixture);
    assert.equal(first.status, 0, first.stderr);
    const second = runFixture(root, fixture);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /"status": "already_finished"/);

    const runLog = await readRunLog(root, runId);
    assert.equal(runLog.eventLog.filter((event) => event.type === "run_started").length, 1);
    assert.equal(runLog.eventLog.some((event) => event.type === "run_resumed"), false);
    assertSingleFinishedEvent(runLog, "complete");
  });

  it("derives a useful default reserve for a short run instead of silently doing no work", async () => {
    const root = await createStubRoot(`
      import { writeFile } from "node:fs/promises";
      await writeFile("short-run-spawned", "yes");
    `);
    const runId = "short-default-reserve";
    const result = runFixture(root, {
      runId,
      startedAt: new Date().toISOString(),
      args: ["--once", "--minutes=1"]
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(await exists(path.join(root, "short-run-spawned")), true);
    const runLog = await readRunLog(root, runId);
    assert.equal(runLog.minimumSweepMinutes, 0.5);
    assert.equal(runLog.eventLog.filter((event) => event.type === "sweep_started").length, 1);
    assertSingleFinishedEvent(runLog, "complete");
  });

  it("restores original timing and reserve metadata on a direct resume without overrides", async () => {
    const root = await createStubRoot(`
      import { writeFile } from "node:fs/promises";
      await writeFile("restored-start", process.env.LONG_RUN_START_AT ?? "");
    `);
    const runId = "direct-metadata-resume";
    const startedAt = new Date(Date.now() - 10_000).toISOString();
    const deadlineAt = new Date(new Date(startedAt).valueOf() + 7 * 60_000).toISOString();
    await seedRunLog(root, {
      runId,
      startedAt,
      deadlineAt,
      durationMinutes: 7,
      minimumSweepMinutes: 0.25,
      eventLog: [{ type: "run_started", at: startedAt }]
    });

    const result = runFixture(root, {
      runId,
      startedAt: null,
      args: ["--once"]
    });

    assert.equal(result.status, 0, result.stderr);
    const runLog = await readRunLog(root, runId);
    assert.equal(runLog.startedAt, startedAt);
    assert.equal(runLog.deadlineAt, deadlineAt);
    assert.equal(runLog.durationMinutes, 7);
    assert.equal(runLog.minimumSweepMinutes, 0.25);
    assert.equal(await readFile(path.join(root, "restored-start"), "utf8"), startedAt);
    const resumed = runLog.eventLog.find((event) => event.type === "run_resumed");
    assert.equal(resumed?.startedAt, startedAt);
    assert.equal(resumed?.durationMinutes, 7);
    assert.equal(resumed?.minimumSweepMinutes, 0.25);
    const active = await readActiveRun(root);
    assert.equal(active.startedAt, startedAt);
    assert.equal(active.deadlineAt, deadlineAt);
    assert.equal(active.durationMinutes, 7);
    assert.equal(active.minimumSweepMinutes, 0.25);
  });

  for (const persistedType of ["sweep_failed", "run_failed"]) {
    it(`terminalizes a persisted ${persistedType} without retrying collection`, async () => {
      const root = await createStubRoot(`
        import { writeFile } from "node:fs/promises";
        await writeFile("unexpected-retry", "spawned");
      `);
      const runId = `persisted-${persistedType}`;
      const startedAt = new Date().toISOString();
      const failureEvent = persistedType === "sweep_failed"
        ? {
            type: "sweep_failed",
            at: startedAt,
            cycleIndex: 0,
            attempt: 1,
            idempotencyKey: `${runId}-sweep-000`,
            exitCode: 7
          }
        : { type: "run_failed", at: startedAt, error: "persisted failure" };
      await seedRunLog(root, {
        runId,
        startedAt,
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
        durationMinutes: 2,
        minimumSweepMinutes: 0.001,
        eventLog: [
          { type: "run_started", at: startedAt },
          ...(persistedType === "sweep_failed"
            ? [{
                type: "sweep_started",
                at: startedAt,
                cycleIndex: 0,
                attempt: 1,
                idempotencyKey: `${runId}-sweep-000`
              }]
            : []),
          failureEvent
        ]
      });

      const first = runFixture(root, {
        runId,
        startedAt: null,
        args: ["--once"]
      });
      assert.notEqual(first.status, 0);
      assert.equal(await exists(path.join(root, "unexpected-retry")), false);
      const afterFirst = await readRunLog(root, runId);
      assert.equal(afterFirst.eventLog.filter((event) => event.type === "run_failed").length, 1);
      assert.equal(afterFirst.eventLog.filter((event) => event.type === "sweep_started").length,
        persistedType === "sweep_failed" ? 1 : 0);
      assertSingleFinishedEvent(afterFirst, "failed");
      assert.equal((await readActiveRun(root)).status, "failed");

      const second = runFixture(root, {
        runId,
        startedAt: null,
        args: ["--once"]
      });
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /"status": "already_finished"/);
      const afterSecond = await readRunLog(root, runId);
      assert.equal(afterSecond.eventLog.filter((event) => event.type === "run_failed").length, 1);
      assertSingleFinishedEvent(afterSecond, "failed");
    });
  }

  it("rejects a persisted reserve that is incompatible with the restored duration", async () => {
    const root = await createStubRoot(`
      import { writeFile } from "node:fs/promises";
      await writeFile("unexpected-retry", "spawned");
    `);
    const runId = "persisted-incompatible-reserve";
    const startedAt = new Date().toISOString();
    await seedRunLog(root, {
      runId,
      startedAt,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      durationMinutes: 1,
      minimumSweepMinutes: 45,
      eventLog: [{ type: "run_started", at: startedAt }]
    });

    const result = runFixture(root, {
      runId,
      startedAt: null,
      args: ["--once"]
    });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /effective minimum sweep reserve.*effective run duration/);
    assert.equal(await exists(path.join(root, "unexpected-retry")), false);
    const runLog = await readRunLog(root, runId);
    assert.equal(runLog.eventLog.some((event) => event.type === "run_resumed"), false);
    assert.equal(runLog.eventLog.some((event) => event.type === "run_finished"), false);
  });

  it("durable failure evidence wins over a signal received during startup", {
    skip: process.platform === "win32"
  }, async () => {
    const root = await createStubRoot("");
    const runId = "failure-precedes-signal";
    const runDir = path.join(root, "outputs", "longrun");
    await mkdir(runDir, { recursive: true });
    const fifo = path.join(runDir, `${runId}.json`);
    const ready = path.join(root, "failure-fifo-ready");
    const release = path.join(root, "failure-fifo-release");
    const payload = path.join(root, "failure-payload.json");
    const startedAt = new Date().toISOString();
    await writeFile(payload, JSON.stringify({
      runId,
      startedAt,
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      durationMinutes: 2,
      minimumSweepMinutes: 0.001,
      eventLog: [
        { type: "run_started", at: startedAt },
        { type: "run_failed", at: startedAt, error: "durable startup failure" }
      ]
    }));
    execFileSync("mkfifo", [fifo]);
    const running = runFixtureAsync(root, {
      runId,
      startedAt: null,
      args: ["--once"]
    });
    const writer = spawn("sh", [
      "-c",
      "exec 3>\"$FIFO\"; : >\"$READY\"; while [ ! -e \"$RELEASE\" ]; do sleep 0.01; done; cat \"$PAYLOAD\" >&3; exec 3>&-"
    ], {
      cwd: root,
      stdio: "ignore",
      env: { ...process.env, FIFO: fifo, READY: ready, RELEASE: release, PAYLOAD: payload }
    });
    const writerCompletion = new Promise((resolve, reject) => {
      writer.once("error", reject);
      writer.once("close", resolve);
    });

    await waitFor(() => exists(ready));
    running.child.kill("SIGTERM");
    await writeFile(release, "release");
    const result = await running.completion;
    await writerCompletion;

    assert.equal(result.code, 1, result.stderr);
    const runLog = await readRunLog(root, runId);
    assert.equal(runLog.eventLog.filter((event) => event.type === "run_failed").length, 1);
    assertSingleFinishedEvent(runLog, "failed");
    assert.equal((await readActiveRun(root)).status, "failed");
  });

  it("resumes an admitted unfinished sweep after its horizon and admits no replacement", async () => {
    const root = await createStubRoot(`
      import { appendFile } from "node:fs/promises";
      await appendFile("resume-invocations", process.argv.join(" ") + "\\n");
    `);
    const runId = "expired-admitted-resume";
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    const idempotencyKey = `${runId}-sweep-000`;
    await seedRunLog(root, {
      runId,
      startedAt,
      deadlineAt: new Date(new Date(startedAt).valueOf() + 60_000).toISOString(),
      durationMinutes: 1,
      minimumSweepMinutes: 0.001,
      eventLog: [
        { type: "run_started", at: startedAt },
        {
          type: "sweep_started",
          at: startedAt,
          cycleIndex: 0,
          attempt: 1,
          idempotencyKey
        }
      ]
    });

    const result = runFixture(root, {
      runId,
      startedAt: null,
      args: ["--minutes=1", "--minimum-sweep-minutes=0.001"]
    });
    assert.equal(result.status, 0, result.stderr);
    const runLog = await readRunLog(root, runId);
    assert.deepEqual(
      runLog.eventLog
        .filter((event) => event.type === "sweep_started")
        .map((event) => [event.cycleIndex, event.attempt, event.idempotencyKey]),
      [
        [0, 1, idempotencyKey],
        [0, 2, idempotencyKey]
      ]
    );
    assert.equal(runLog.eventLog.filter((event) => event.type === "sweep_succeeded").length, 1);
    assert.equal(runLog.eventLog.some(
      (event) => event.type === "sweep_started" && event.cycleIndex === 1
    ), false);
    assert.equal(
      runLog.eventLog.filter((event) => event.type === "sweep_skipped_insufficient_time").length,
      1
    );
    assert.match(await readFile(path.join(root, "resume-invocations"), "utf8"), new RegExp(idempotencyKey));
    assertSingleFinishedEvent(runLog, "deadline_complete");
  });

  it("survives repeated delivery of the same signal and finalizes once", async () => {
    const root = await createStubRoot(`
      import { writeFile } from "node:fs/promises";
      process.on("SIGTERM", async () => {
        await writeFile("child-saw-signal", "yes");
        setTimeout(() => process.exit(0), 250);
      });
      await writeFile("child-ready", "yes");
      setInterval(() => {}, 1_000);
    `);
    const runId = "repeated-signal";
    const running = runFixtureAsync(root, {
      runId,
      startedAt: new Date().toISOString(),
      args: ["--minutes=1", "--minimum-sweep-minutes=0.001"]
    });

    await waitFor(async () => {
      if (!await exists(path.join(root, "outputs", "longrun", `${runId}.json`))) return false;
      return (await readRunLog(root, runId)).eventLog.some(
        (event) => event.type === "sweep_started"
      ) && await exists(path.join(root, "child-ready"));
    });
    running.child.kill("SIGTERM");
    await waitFor(() => exists(path.join(root, "child-saw-signal")));
    running.child.kill("SIGTERM");
    const result = await running.completion;

    assert.equal(result.code, 143, result.stderr);
    const runLog = await readRunLog(root, runId);
    assert.equal(runLog.eventLog.some((event) => event.type === "run_failed"), false);
    assertSingleFinishedEvent(runLog, "interrupted");
  });

  it("handles a signal received while the first event-log read is still blocked", {
    skip: process.platform === "win32"
  }, async () => {
    const root = await createStubRoot("");
    const runId = "startup-signal";
    const runDir = path.join(root, "outputs", "longrun");
    await mkdir(runDir, { recursive: true });
    const fifo = path.join(runDir, `${runId}.json`);
    const ready = path.join(root, "fifo-ready");
    const release = path.join(root, "fifo-release");
    execFileSync("mkfifo", [fifo]);
    const running = runFixtureAsync(root, {
      runId,
      startedAt: new Date().toISOString(),
      args: ["--minutes=1", "--minimum-sweep-minutes=0.001"]
    });
    const writer = spawn("sh", [
      "-c",
      "exec 3>\"$FIFO\"; : >\"$READY\"; while [ ! -e \"$RELEASE\" ]; do sleep 0.01; done; printf '{}' >&3; exec 3>&-"
    ], {
      cwd: root,
      stdio: "ignore",
      env: { ...process.env, FIFO: fifo, READY: ready, RELEASE: release }
    });
    const writerCompletion = new Promise((resolve, reject) => {
      writer.once("error", reject);
      writer.once("close", resolve);
    });

    await waitFor(() => exists(ready));
    running.child.kill("SIGTERM");
    await writeFile(release, "release");
    const result = await running.completion;
    await writerCompletion;

    assert.equal(result.code, 143, result.stderr);
    const runLog = await readRunLog(root, runId);
    assert.equal(runLog.eventLog.some((event) => event.type === "sweep_started"), false);
    assert.equal(runLog.eventLog.some((event) => event.type === "run_failed"), false);
    assertSingleFinishedEvent(runLog, "interrupted");
    assert.equal((await readActiveRun(root)).status, "interrupted");
  });

  it("cancels the escalation timer after the child closes cleanly", {
    skip: process.platform === "win32"
  }, async () => {
    const root = await createStubRoot(`
      import { writeFile } from "node:fs/promises";
      process.on("SIGTERM", () => setTimeout(() => process.exit(0), 20));
      await writeFile("timer-child-ready", "yes");
      setInterval(() => {}, 1_000);
    `);
    const killLog = path.join(root, "unexpected-sigkill");
    const preloadPath = path.join(root, "observe-escalation.cjs");
    await writeFile(preloadPath, `
      const fs = require("node:fs");
      const originalKill = process.kill.bind(process);
      const originalSetTimeout = global.setTimeout;
      originalSetTimeout(() => {}, 400);
      process.kill = (pid, signal) => {
        if (signal === "SIGKILL") fs.appendFileSync(${JSON.stringify(killLog)}, String(pid) + "\\n");
        return originalKill(pid, signal);
      };
      global.setTimeout = (callback, delay, ...args) =>
        originalSetTimeout(callback, delay === 5_000 ? 75 : delay, ...args);
    `);
    const runId = "escalation-cleared";
    const running = runFixtureAsync(root, {
      runId,
      startedAt: new Date().toISOString(),
      args: ["--minutes=1", "--minimum-sweep-minutes=0.001"],
      env: {
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`]
          .filter(Boolean)
          .join(" ")
      }
    });

    await waitFor(() => exists(path.join(root, "timer-child-ready")));
    running.child.kill("SIGTERM");
    const result = await running.completion;

    assert.equal(result.code, 143, result.stderr);
    assert.equal(await exists(killLog), false);
    assertSingleFinishedEvent(await readRunLog(root, runId), "interrupted");
  });

  it("labels the bounded smoke timeout instead of calling it the full run horizon", async () => {
    const root = await createStubRoot("setInterval(() => {}, 1_000);");
    const preloadPath = path.join(root, "shorten-timeout.cjs");
    await writeFile(preloadPath, `
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (callback, delay, ...args) =>
        originalSetTimeout(callback, delay >= 100_000 ? 25 : delay, ...args);
    `);
    const runId = "smoke-timeout-label";
    const result = runFixture(root, {
      runId,
      startedAt: new Date().toISOString(),
      args: ["--smoke", "--minutes=10"],
      env: {
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`]
          .filter(Boolean)
          .join(" ")
      }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /120-second smoke-plan timeout/);
    assert.doesNotMatch(result.stderr, /10-minute source-sweep window elapsed/);
    const runLog = await readRunLog(root, runId);
    const failed = runLog.eventLog.find((event) => event.type === "run_failed");
    assert.match(failed?.error ?? "", /120-second smoke-plan timeout/);
    assertSingleFinishedEvent(runLog, "failed");
  });

  it("rejects invalid explicit duration, reserve, and start-time configuration", async () => {
    const root = await createStubRoot("");
    const cases = [
      {
        args: ["--minutes=0"],
        startedAt: new Date().toISOString(),
        pattern: /--minutes must be greater than zero/
      },
      {
        args: ["--minutes=1", "--minimum-sweep-minutes=0"],
        startedAt: new Date().toISOString(),
        pattern: /--minimum-sweep-minutes must be greater than zero/
      },
      {
        args: ["--minutes=1", "--minimum-sweep-minutes=1"],
        startedAt: new Date().toISOString(),
        pattern: /--minimum-sweep-minutes must be less than --minutes/
      },
      {
        args: ["--minutes=1"],
        startedAt: "not-a-time",
        pattern: /LONG_RUN_START_AT must be a valid timestamp/
      }
    ];

    for (const [index, fixture] of cases.entries()) {
      const result = runFixture(root, {
        runId: `invalid-config-${index}`,
        startedAt: fixture.startedAt,
        args: fixture.args
      });
      assert.equal(result.status, 64);
      assert.match(result.stderr, fixture.pattern);
    }
    const unsafeRunId = runFixture(root, {
      runId: "../escape",
      startedAt: new Date().toISOString(),
      args: ["--minutes=1"]
    });
    assert.equal(unsafeRunId.status, 64);
    assert.match(unsafeRunId.stderr, /LONG_RUN_ID contains unsupported characters/);
    const invalidDeadline = runFixture(root, {
      runId: "invalid-deadline",
      startedAt: new Date().toISOString(),
      args: ["--minutes=1"],
      env: { LONG_RUN_DEADLINE_AT: "not-a-deadline" }
    });
    assert.equal(invalidDeadline.status, 64);
    assert.match(invalidDeadline.stderr, /LONG_RUN_DEADLINE_AT must be a valid timestamp/);
  });

  it("serializes concurrent launchers so exactly one collector process is admitted", async () => {
    const root = await createLauncherRoot(`
      import { appendFile, writeFile } from "node:fs/promises";
      await appendFile("collector-invocations", "started\\n");
      await writeFile("collector-ready", "yes");
      setInterval(() => {}, 1_000);
    `);
    const args = ["--minutes=1", "--minimum-sweep-minutes=0.001"];
    const env = { LONG_RUN_ID: "concurrent-launch" };
    const first = runLauncherAsync(root, { args, env });
    const second = runLauncherAsync(root, { args, env });
    const [firstResult, secondResult] = await Promise.all([first.completion, second.completion]);

    assert.equal(firstResult.code, 0, firstResult.stderr);
    assert.equal(secondResult.code, 0, secondResult.stderr);
    const statuses = [firstResult, secondResult].map(
      (result) => JSON.parse(result.stdout).status
    );
    assert.equal(statuses.filter((status) => status === "started").length, 1);
    assert.equal(statuses.filter(
      (status) => status === "launch_in_progress" || status === "already_running"
    ).length, 1);
    await waitFor(() => exists(path.join(root, "collector-ready")));
    assert.equal(
      (await readFile(path.join(root, "collector-invocations"), "utf8"))
        .trim()
        .split("\n")
        .length,
      1
    );
    await interruptActiveRun(root);
  });

  it("routes concurrent public runner commands through the same exclusive launcher lease", async () => {
    const root = await createLauncherRoot(`
      import { appendFile, writeFile } from "node:fs/promises";
      await appendFile("collector-invocations", "started\\n");
      await writeFile("collector-ready", "yes");
      setInterval(() => {}, 1_000);
    `);
    const args = ["--minutes=1", "--minimum-sweep-minutes=0.001"];
    const env = { LONG_RUN_ID: "concurrent-public-runner" };
    const first = runPublicRunnerAsync(root, { args, env });
    const second = runPublicRunnerAsync(root, { args, env });
    const [firstResult, secondResult] = await Promise.all([first.completion, second.completion]);
    assert.equal(firstResult.code, 0, firstResult.stderr);
    assert.equal(secondResult.code, 0, secondResult.stderr);
    const statuses = [firstResult, secondResult].map(
      (result) => JSON.parse(result.stdout).status
    );
    assert.equal(statuses.filter((status) => status === "started").length, 1);
    assert.equal(statuses.filter(
      (status) => status === "launch_in_progress" || status === "already_running"
    ).length, 1);
    await waitFor(() => exists(path.join(root, "collector-ready")));
    assert.equal(
      (await readFile(path.join(root, "collector-invocations"), "utf8")).trim(),
      "started"
    );
    const smokeResult = await runPublicRunnerAsync(root, {
      args: ["--smoke", "--minutes=2", "--minimum-sweep-minutes=0.001"],
      env: { LONG_RUN_ID: "concurrent-public-smoke" }
    }).completion;
    assert.equal(smokeResult.code, 0, smokeResult.stderr);
    assert.equal(JSON.parse(smokeResult.stdout).status, "already_running");
    await interruptActiveRun(root);
  });

  it("never resumes a stale run through an incompatible smoke or once mode", async () => {
    const root = await createLauncherRoot(`
      if (process.argv.includes("--plan")) {
        process.stdout.write(JSON.stringify({
          batches: [
            { slug: "S2026" },
            { slug: "S26" },
            { slug: "A16ZSR006" }
          ],
          coverage: { expected: 1 }
        }));
      } else {
        process.stderr.write("unexpected collection execution\\n");
        process.exitCode = 9;
      }
    `);
    const staleRunId = "stale-continuous-before-smoke";
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const runDir = path.join(root, "outputs", "longrun");
    const eventLogPath = path.join(runDir, `${staleRunId}.json`);
    await seedRunLog(root, {
      runId: staleRunId,
      startedAt,
      deadlineAt,
      durationMinutes: 2,
      minimumSweepMinutes: 0.001,
      mode: "continuous",
      eventLog: [{ type: "run_started", at: startedAt, mode: "continuous" }]
    });
    await writeFile(path.join(runDir, "active-run.json"), JSON.stringify({
      runId: staleRunId,
      pid: null,
      status: "running",
      startedAt,
      deadlineAt,
      durationMinutes: 2,
      minimumSweepMinutes: 0.001,
      mode: "continuous",
      eventLogPath
    }));

    const result = await runLauncherAsync(root, {
      args: ["--smoke", "--minutes=2", "--minimum-sweep-minutes=0.001"],
      env: {}
    }).completion;
    assert.equal(result.code, 0, result.stderr);
    const launched = JSON.parse(result.stdout);
    assert.equal(launched.status, "started");
    assert.notEqual(launched.runId, staleRunId);
    await waitFor(async () => terminalRunStatuses.has((await readActiveRun(root)).status));
    const active = await readActiveRun(root);
    assert.equal(active.runId, launched.runId);
    assert.equal(active.mode, "smoke");
    assert.equal(active.status, "smoke_complete");
    const staleLog = await readRunLog(root, staleRunId);
    assert.equal(staleLog.eventLog.some((event) => event.type === "run_finished"), false);
    const smokeLog = await readRunLog(root, launched.runId);
    assert.equal(smokeLog.mode, "smoke");
    assertSingleFinishedEvent(smokeLog, "smoke_complete");
  });

  it("returns an older forced run's terminal result without spawning or replacing active state", async () => {
    const root = await createLauncherRoot(`
      import { writeFile } from "node:fs/promises";
      await writeFile("unexpected-collector-start", "yes");
    `);
    const runDir = path.join(root, "outputs", "longrun");
    const olderRunId = "older-forced-complete";
    const currentRunId = "current-terminal-run";
    const startedAt = new Date(Date.now() - 120_000).toISOString();
    const finishedAt = new Date(Date.now() - 60_000).toISOString();
    await seedRunLog(root, {
      runId: olderRunId,
      startedAt,
      deadlineAt: finishedAt,
      durationMinutes: 1,
      minimumSweepMinutes: 0.001,
      mode: "continuous",
      eventLog: [
        { type: "run_started", at: startedAt, mode: "continuous" },
        { type: "run_finished", at: finishedAt, status: "complete" }
      ]
    });
    await seedRunLog(root, {
      runId: currentRunId,
      startedAt,
      deadlineAt: finishedAt,
      durationMinutes: 1,
      minimumSweepMinutes: 0.001,
      mode: "continuous",
      eventLog: [
        { type: "run_started", at: startedAt, mode: "continuous" },
        { type: "run_finished", at: finishedAt, status: "complete" }
      ]
    });
    const currentActive = {
      runId: currentRunId,
      pid: null,
      status: "complete",
      startedAt,
      deadlineAt: finishedAt,
      durationMinutes: 1,
      minimumSweepMinutes: 0.001,
      mode: "continuous",
      eventLogPath: path.join(runDir, `${currentRunId}.json`)
    };
    await writeFile(
      path.join(runDir, "active-run.json"),
      JSON.stringify(currentActive)
    );

    const result = await runLauncherAsync(root, {
      args: ["--minutes=1", "--minimum-sweep-minutes=0.001"],
      env: { LONG_RUN_ID: olderRunId }
    }).completion;
    assert.equal(result.code, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.status, "already_finished");
    assert.equal(response.runId, olderRunId);
    assert.equal(response.finalStatus, "complete");
    assert.equal(
      await realpath(response.activePath),
      await realpath(path.join(runDir, "active-run.json"))
    );
    assert.equal(await exists(path.join(root, "unexpected-collector-start")), false);
    assert.deepEqual(await readActiveRun(root), currentActive);
  });

  it("does not let terminal active metadata supersede a live launcher claim", {
    skip: process.platform === "win32"
  }, async () => {
    const root = await createLauncherRoot(`
      import { writeFile } from "node:fs/promises";
      await writeFile("collector-ready", "yes");
      setInterval(() => {}, 1_000);
    `);
    const oldRunId = "terminal-before-live-launcher";
    const freshRunId = "fresh-after-terminal";
    const runDir = path.join(root, "outputs", "longrun");
    const claimDir = path.join(runDir, ".launcher-claim");
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const finishedAt = new Date().toISOString();
    await mkdir(claimDir, { recursive: true });
    await writeFile(path.join(claimDir, "owner.json"), JSON.stringify({
      version: 2,
      token: "released-terminal-token",
      ownerKind: "released",
      ownerPid: null,
      childPid: null,
      releasedAt: finishedAt
    }));
    await seedRunLog(root, {
      runId: oldRunId,
      startedAt,
      deadlineAt: finishedAt,
      durationMinutes: 1,
      minimumSweepMinutes: 0.001,
      eventLog: [
        { type: "run_started", at: startedAt },
        { type: "run_finished", at: finishedAt, status: "complete" }
      ]
    });
    await writeFile(path.join(runDir, "active-run.json"), JSON.stringify({
      runId: oldRunId,
      pid: null,
      status: "complete",
      startedAt,
      deadlineAt: finishedAt,
      durationMinutes: 1,
      minimumSweepMinutes: 0.001,
      eventLogPath: path.join(runDir, `${oldRunId}.json`)
    }));

    const barrierPath = path.join(root, "block-second-active-read.cjs");
    const barrierReady = path.join(root, "launcher-after-claim-ready");
    const barrierRelease = path.join(root, "launcher-after-claim-release");
    await writeFile(barrierPath, `
      const fs = require("node:fs");
      const moduleBuiltin = require("node:module");
      const path = require("node:path");
      const originalReadFile = fs.promises.readFile.bind(fs.promises);
      let activeReads = 0;
      fs.promises.readFile = async (filePath, ...args) => {
        if (path.basename(String(filePath)) === "active-run.json") {
          activeReads += 1;
          if (activeReads === 2) {
            fs.writeFileSync(${JSON.stringify(barrierReady)}, "ready");
            const waiter = new Int32Array(new SharedArrayBuffer(4));
            while (!fs.existsSync(${JSON.stringify(barrierRelease)})) {
              Atomics.wait(waiter, 0, 0, 10);
            }
          }
        }
        return originalReadFile(filePath, ...args);
      };
      moduleBuiltin.syncBuiltinESMExports();
    `);

    const args = ["--minutes=1", "--minimum-sweep-minutes=0.001"];
    const first = runLauncherAsync(root, {
      args,
      env: {
        LONG_RUN_ID: freshRunId,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          `--require=${barrierPath}`
        ].filter(Boolean).join(" ")
      }
    });
    try {
      await waitFor(() => exists(barrierReady));
      const secondResult = await runLauncherAsync(root, {
        args,
        env: { LONG_RUN_ID: freshRunId }
      }).completion;
      assert.equal(secondResult.code, 0, secondResult.stderr);
      const secondReport = JSON.parse(secondResult.stdout);
      assert.equal(secondReport.status, "launch_in_progress");
      assert.equal(secondReport.pid, first.child.pid);

      await writeFile(barrierRelease, "release");
      const firstResult = await first.completion;
      assert.equal(firstResult.code, 0, firstResult.stderr);
      assert.equal(JSON.parse(firstResult.stdout).status, "started");
      await waitFor(() => exists(path.join(root, "collector-ready")));
      await interruptActiveRun(root);
    } finally {
      await writeFile(barrierRelease, "release");
      if (isPidRunning(first.child.pid)) first.child.kill("SIGTERM");
    }
  });

  it("recovers a stale launcher claim without admitting duplicate collectors", async () => {
    const root = await createLauncherRoot(`
      import { appendFile, writeFile } from "node:fs/promises";
      await appendFile("collector-invocations", "started\\n");
      await writeFile("collector-ready", "yes");
      setInterval(() => {}, 1_000);
    `);
    const claimDir = path.join(root, "outputs", "longrun", ".launcher-claim");
    await mkdir(claimDir, { recursive: true });
    await writeFile(path.join(claimDir, "owner.json"), JSON.stringify({
      token: "stale-token",
      launcherPid: 999_999_999,
      createdAt: "2000-01-01T00:00:00.000Z"
    }));

    const result = await runLauncherAsync(root, {
      args: ["--minutes=1", "--minimum-sweep-minutes=0.001"],
      env: { LONG_RUN_ID: "stale-claim-recovery" }
    }).completion;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "started");
    await waitFor(() => exists(path.join(root, "collector-ready")));
    assert.equal(
      (await readFile(path.join(root, "collector-invocations"), "utf8")).trim(),
      "started"
    );
    await interruptActiveRun(root);
  });

  it("does not steal a dead launcher's claim while its registered child is alive", async () => {
    const root = await createLauncherRoot(`
      import { writeFile } from "node:fs/promises";
      await writeFile("unexpected-collector", "spawned");
    `);
    const pendingChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      stdio: "ignore"
    });
    const pendingExit = new Promise((resolve) => pendingChild.once("close", resolve));
    const runDir = path.join(root, "outputs", "longrun");
    const claimDir = path.join(runDir, ".launcher-claim");
    await mkdir(claimDir, { recursive: true });
    await writeFile(path.join(claimDir, "owner.json"), JSON.stringify({
      token: "pending-token",
      launcherPid: 999_999_999,
      childPid: pendingChild.pid,
      createdAt: new Date().toISOString()
    }));
    await writeFile(path.join(runDir, "active-run.json"), JSON.stringify({
      runId: "pending-child-run",
      pid: null,
      launcherPid: 999_999_999,
      launchToken: "pending-token",
      status: "launching"
    }));

    try {
      const result = await runLauncherAsync(root, {
        args: ["--minutes=1", "--minimum-sweep-minutes=0.001"],
        env: {}
      }).completion;
      assert.equal(result.code, 0, result.stderr);
      const reported = JSON.parse(result.stdout);
      assert.equal(reported.status, "already_running");
      assert.equal(reported.pid, pendingChild.pid);
      assert.equal(await exists(path.join(root, "unexpected-collector")), false);
    } finally {
      pendingChild.kill("SIGTERM");
      await pendingExit;
    }
  });

  it("atomically supersedes a killed launcher before child acknowledgement", {
    skip: process.platform === "win32"
  }, async () => {
    const root = await createLauncherRoot(`
      import { appendFile, writeFile } from "node:fs/promises";
      await appendFile("collector-invocations", "started\\n");
      await writeFile("collector-ready", "yes");
      setInterval(() => {}, 1_000);
    `);
    const barrierPath = path.join(root, "block-runner-before-ack.cjs");
    await writeFile(barrierPath, `
      const fs = require("node:fs");
      const path = require("node:path");
      if (
        path.basename(process.argv[1] || "") === "run-long-cycle.mjs"
        && process.env.LONG_RUN_LAUNCH_TOKEN
      ) {
        const token = process.env.LONG_RUN_LAUNCH_TOKEN;
        fs.writeFileSync(path.join(process.cwd(), "barrier-ready-" + token), String(process.pid));
        const waiter = new Int32Array(new SharedArrayBuffer(4));
        const releasePath = path.join(process.cwd(), "barrier-release-" + token);
        while (!fs.existsSync(releasePath)) Atomics.wait(waiter, 0, 0, 10);
      }
    `);
    const env = {
      LONG_RUN_ID: "kill-before-child-ack",
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        `--require=${barrierPath}`
      ].filter(Boolean).join(" ")
    };
    const args = ["--minutes=1", "--minimum-sweep-minutes=0.001"];
    const first = runLauncherAsync(root, { args, env });
    let firstToken;
    let firstRunnerPid;
    let secondToken;
    let secondRunnerPid;
    let second;

    try {
      await waitFor(async () => {
        if (!await exists(path.join(root, "outputs", "longrun", "active-run.json"))) {
          return false;
        }
        const active = await readActiveRun(root);
        if (!active.launchToken) return false;
        const readyPath = path.join(root, `barrier-ready-${active.launchToken}`);
        if (!await exists(readyPath)) return false;
        firstToken = active.launchToken;
        firstRunnerPid = Number(await readFile(readyPath, "utf8"));
        return Number.isInteger(firstRunnerPid) && firstRunnerPid > 0;
      });

      first.child.kill("SIGKILL");
      const firstResult = await first.completion;
      assert.equal(firstResult.signal, "SIGKILL");

      second = runLauncherAsync(root, { args, env });
      await waitFor(async () => {
        const active = await readActiveRun(root);
        if (!active.launchToken || active.launchToken === firstToken) return false;
        const readyPath = path.join(root, `barrier-ready-${active.launchToken}`);
        if (!await exists(readyPath)) return false;
        secondToken = active.launchToken;
        secondRunnerPid = Number(await readFile(readyPath, "utf8"));
        return Number.isInteger(secondRunnerPid) && secondRunnerPid > 0;
      });

      await writeFile(path.join(root, `barrier-release-${firstToken}`), "release");
      await waitFor(() => !isPidRunning(firstRunnerPid));
      assert.equal(await exists(path.join(root, "collector-invocations")), false);

      await writeFile(path.join(root, `barrier-release-${secondToken}`), "release");
      const secondResult = await second.completion;
      assert.equal(secondResult.code, 0, secondResult.stderr);
      assert.match(secondResult.stdout, /"status": "(?:resumed|started)"/);
      await waitFor(() => exists(path.join(root, "collector-ready")));
      assert.equal(
        (await readFile(path.join(root, "collector-invocations"), "utf8")).trim(),
        "started"
      );
      await interruptActiveRun(root);
    } finally {
      for (const token of [firstToken, secondToken].filter(Boolean)) {
        await writeFile(path.join(root, `barrier-release-${token}`), "release");
      }
      for (const pid of [firstRunnerPid, secondRunnerPid].filter(isPidRunning)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
      if (second && isPidRunning(second.child.pid)) second.child.kill("SIGTERM");
    }
  });

  it("preserves a valid explicit reserve instead of silently clamping it", async () => {
    const root = await createLauncherRoot(`
      import { writeFile } from "node:fs/promises";
      await writeFile("collector-ready", "yes");
      setInterval(() => {}, 1_000);
    `);
    const result = await runLauncherAsync(root, {
      args: ["--minutes=10", "--minimum-sweep-minutes=8"],
      env: { LONG_RUN_ID: "explicit-reserve" }
    }).completion;
    assert.equal(result.code, 0, result.stderr);
    const launched = JSON.parse(result.stdout);
    assert.equal(launched.minimumSweepMinutes, 8);
    assert.equal((await readActiveRun(root)).minimumSweepMinutes, 8);
    await interruptActiveRun(root);
  });

  it("refuses event-log paths and identities that do not belong to the active run", async () => {
    const pathRoot = await createLauncherRoot(`
      import { writeFile } from "node:fs/promises";
      await writeFile("unexpected-collector", "spawned");
    `);
    const outsidePath = path.join(pathRoot, "outside-audit.json");
    await writeFile(outsidePath, "sentinel");
    await mkdir(path.join(pathRoot, "outputs", "longrun"), { recursive: true });
    await writeFile(
      path.join(pathRoot, "outputs", "longrun", "active-run.json"),
      JSON.stringify({
        runId: "unsafe-audit-path",
        pid: null,
        status: "running",
        startedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        durationMinutes: 1,
        minimumSweepMinutes: 0.001,
        eventLogPath: outsidePath
      })
    );
    const pathResult = await runLauncherAsync(pathRoot, { args: [], env: {} }).completion;
    assert.equal(pathResult.code, 1);
    assert.match(pathResult.stderr, /eventLogPath must resolve/);
    assert.equal(await readFile(outsidePath, "utf8"), "sentinel");
    assert.equal(await exists(path.join(pathRoot, "unexpected-collector")), false);

    const identityRoot = await createLauncherRoot("");
    const activeRunId = "identity-owner";
    const activeLogPath = path.join(
      identityRoot,
      "outputs",
      "longrun",
      `${activeRunId}.json`
    );
    await seedRunLog(identityRoot, {
      runId: "different-run",
      startedAt: new Date().toISOString(),
      durationMinutes: 1,
      minimumSweepMinutes: 0.001,
      eventLog: []
    });
    await writeFile(activeLogPath, JSON.stringify({
      runId: "different-run",
      startedAt: new Date().toISOString(),
      durationMinutes: 1,
      minimumSweepMinutes: 0.001,
      eventLog: []
    }));
    await writeFile(
      path.join(identityRoot, "outputs", "longrun", "active-run.json"),
      JSON.stringify({
        runId: activeRunId,
        pid: null,
        status: "running",
        startedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        durationMinutes: 1,
        minimumSweepMinutes: 0.001,
        eventLogPath: activeLogPath
      })
    );
    const identityResult = await runLauncherAsync(identityRoot, {
      args: [],
      env: {}
    }).completion;
    assert.equal(identityResult.code, 1);
    assert.match(identityResult.stderr, /Event log identity mismatch/);
  });

  it("refuses persisted stdout and stderr paths outside the run directory", async () => {
    for (const stream of ["stdout", "stderr"]) {
      const root = await createLauncherRoot(`
        import { writeFile } from "node:fs/promises";
        await writeFile("unexpected-collector", "spawned");
      `);
      const runId = `unsafe-${stream}-path`;
      const runDir = path.join(root, "outputs", "longrun");
      const outsidePath = path.join(root, `${stream}-sentinel.log`);
      const startedAt = new Date().toISOString();
      await writeFile(outsidePath, "sentinel");
      await seedRunLog(root, {
        runId,
        startedAt,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        durationMinutes: 1,
        minimumSweepMinutes: 0.001,
        eventLog: [{ type: "run_started", at: startedAt }]
      });
      await writeFile(path.join(runDir, "active-run.json"), JSON.stringify({
        runId,
        pid: null,
        status: "running",
        startedAt,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        durationMinutes: 1,
        minimumSweepMinutes: 0.001,
        eventLogPath: path.join(runDir, `${runId}.json`),
        [`${stream}Path`]: outsidePath
      }));

      const result = await runLauncherAsync(root, { args: [], env: {} }).completion;
      assert.equal(result.code, 1);
      assert.match(result.stderr, new RegExp(`Active ${stream}Path must resolve`));
      assert.equal(await readFile(outsidePath, "utf8"), "sentinel");
      assert.equal(await exists(path.join(root, "unexpected-collector")), false);
    }
  });

  it("preserves an explicit durable deadline even when it differs from start plus duration", async () => {
    const root = await createLauncherRoot(`
      import { writeFile } from "node:fs/promises";
      await writeFile("collector-ready", "yes");
      setInterval(() => {}, 1_000);
    `);
    const runId = "durable-deadline-override";
    const runDir = path.join(root, "outputs", "longrun");
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const deadlineAt = new Date(Date.now() + 30_000).toISOString();
    const eventLogPath = path.join(runDir, `${runId}.json`);
    await seedRunLog(root, {
      runId,
      startedAt,
      deadlineAt,
      durationMinutes: 5,
      minimumSweepMinutes: 0.001,
      eventLog: [{ type: "run_started", at: startedAt }]
    });
    await writeFile(path.join(runDir, "active-run.json"), JSON.stringify({
      runId,
      pid: null,
      status: "running",
      startedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      durationMinutes: 10,
      minimumSweepMinutes: 5,
      eventLogPath
    }));

    const result = await runLauncherAsync(root, { args: [], env: {} }).completion;
    assert.equal(result.code, 0, result.stderr);
    const launched = JSON.parse(result.stdout);
    assert.equal(launched.status, "resumed");
    assert.equal(launched.startedAt, startedAt);
    assert.equal(launched.durationMinutes, 5);
    assert.equal(launched.deadlineAt, deadlineAt);
    await waitFor(() => exists(path.join(root, "collector-ready")));
    await waitFor(async () => (await readRunLog(root, runId)).deadlineAt === deadlineAt);
    assert.equal((await readActiveRun(root)).deadlineAt, deadlineAt);
    await interruptActiveRun(root);
  });

  it("launcher resumes only an already-admitted expired sweep without extending its horizon", async () => {
    const root = await createLauncherRoot(`
      import { appendFile } from "node:fs/promises";
      await appendFile("resume-invocations", process.argv.join(" ") + "\\n");
    `);
    const runId = "launcher-expired-admission";
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    const deadlineAt = new Date(new Date(startedAt).valueOf() + 60_000).toISOString();
    const idempotencyKey = `${runId}-sweep-000`;
    const eventLogPath = path.join(root, "outputs", "longrun", `${runId}.json`);
    await seedRunLog(root, {
      runId,
      startedAt,
      deadlineAt,
      durationMinutes: 1,
      minimumSweepMinutes: 0.001,
      eventLog: [
        { type: "run_started", at: startedAt },
        {
          type: "sweep_started",
          at: startedAt,
          cycleIndex: 0,
          attempt: 1,
          idempotencyKey
        }
      ]
    });
    await writeFile(path.join(root, "outputs", "longrun", "active-run.json"), JSON.stringify({
      runId,
      pid: null,
      status: "running",
      startedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      durationMinutes: 10,
      minimumSweepMinutes: 5,
      stdoutPath: path.join(root, "outputs", "longrun", `${runId}.stdout.log`),
      stderrPath: path.join(root, "outputs", "longrun", `${runId}.stderr.log`),
      eventLogPath
    }));

    const result = await runLauncherAsync(root, {
      args: ["--minutes=5", "--minimum-sweep-minutes=0.001"],
      env: {}
    }).completion;
    assert.equal(result.code, 0, result.stderr);
    const launched = JSON.parse(result.stdout);
    assert.equal(launched.status, "resumed");
    assert.equal(launched.startedAt, startedAt);
    assert.equal(launched.deadlineAt, deadlineAt);
    assert.equal(launched.durationMinutes, 1);
    assert.equal(launched.minimumSweepMinutes, 0.001);
    await waitFor(async () => {
      const log = await readRunLog(root, runId);
      return log.eventLog.some((event) => event.type === "run_finished");
    });
    const runLog = await readRunLog(root, runId);
    assert.equal(runLog.startedAt, startedAt);
    assert.equal(runLog.deadlineAt, deadlineAt);
    assert.deepEqual(
      runLog.eventLog
        .filter((event) => event.type === "sweep_started")
        .map((event) => [event.cycleIndex, event.attempt, event.idempotencyKey]),
      [[0, 1, idempotencyKey], [0, 2, idempotencyKey]]
    );
    assert.equal(runLog.eventLog.some(
      (event) => event.type === "sweep_started" && event.cycleIndex === 1
    ), false);
    assertSingleFinishedEvent(runLog, "deadline_complete");
    assert.equal((await readActiveRun(root)).deadlineAt, deadlineAt);
  });

  it("terminalizes a stale failed run and launches a fresh linked recovery run", async () => {
    const root = await createLauncherRoot(`
      import { writeFile } from "node:fs/promises";
      await writeFile("recovery-ready", "yes");
      setInterval(() => {}, 1_000);
    `);
    const failedRunId = "stale-failed-run";
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const eventLogPath = path.join(root, "outputs", "longrun", `${failedRunId}.json`);
    await seedRunLog(root, {
      runId: failedRunId,
      startedAt,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      durationMinutes: 2,
      minimumSweepMinutes: 0.001,
      eventLog: [
        { type: "run_started", at: startedAt },
        {
          type: "sweep_started",
          at: startedAt,
          cycleIndex: 0,
          attempt: 1,
          idempotencyKey: `${failedRunId}-sweep-000`
        },
        {
          type: "sweep_failed",
          at: startedAt,
          cycleIndex: 0,
          attempt: 1,
          exitCode: 7
        }
      ]
    });
    await writeFile(path.join(root, "outputs", "longrun", "active-run.json"), JSON.stringify({
      runId: failedRunId,
      pid: null,
      status: "running",
      startedAt,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      durationMinutes: 2,
      minimumSweepMinutes: 0.001,
      eventLogPath
    }));

    const result = await runLauncherAsync(root, {
      args: ["--minutes=5", "--minimum-sweep-minutes=0.001"],
      env: {}
    }).completion;
    assert.equal(result.code, 0, result.stderr);
    const launched = JSON.parse(result.stdout);
    assert.equal(launched.status, "started");
    assert.notEqual(launched.runId, failedRunId);
    assert.equal(launched.durationMinutes, 5);
    await waitFor(() => exists(path.join(root, "recovery-ready")));
    const active = await readActiveRun(root);
    assert.equal(active.runId, launched.runId);
    assert.equal(active.recoveryOfRunId, failedRunId);
    assert.equal(await realpath(active.recoveryOfEventLogPath), await realpath(eventLogPath));
    const failedLog = await readRunLog(root, failedRunId);
    assert.equal(failedLog.eventLog.filter((event) => event.type === "run_failed").length, 1);
    assertSingleFinishedEvent(failedLog, "failed");
    await interruptActiveRun(root);
  });

  it("does not treat a reused live PID as ownership of a nonterminal runner lease", async () => {
    const root = await createLauncherRoot(`
      import { writeFile } from "node:fs/promises";
      await writeFile("collector-ready", "yes");
      setInterval(() => {}, 1_000);
    `);
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      stdio: "ignore"
    });
    const unrelatedExit = new Promise((resolve) => unrelated.once("close", resolve));
    const runId = "reused-runner-pid";
    const runDir = path.join(root, "outputs", "longrun");
    const claimDir = path.join(runDir, ".launcher-claim");
    const transitionsDir = path.join(claimDir, ".transitions");
    const startedAt = new Date().toISOString();
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const staleFingerprint = "Mon Jan 1 00:00:00 2001 unrelated stale process";
    await mkdir(transitionsDir, { recursive: true });
    await writeFile(path.join(claimDir, "owner.json"), JSON.stringify({
      version: 2,
      token: "stale-runner-token",
      ownerKind: "runner",
      ownerPid: unrelated.pid,
      ownerFingerprint: staleFingerprint,
      childPid: unrelated.pid,
      runId
    }));
    await writeFile(path.join(transitionsDir, "ticket-stale-reused-pid.json"), JSON.stringify({
      ticketToken: "stale-reused-pid",
      actorToken: "stale-runner-token",
      role: "runner-acknowledgement",
      pid: unrelated.pid,
      processFingerprint: staleFingerprint,
      number: 1,
      createdAt: new Date().toISOString()
    }));
    await seedRunLog(root, {
      runId,
      startedAt,
      deadlineAt,
      durationMinutes: 1,
      minimumSweepMinutes: 0.001,
      eventLog: [{ type: "run_started", at: startedAt }]
    });
    await writeFile(path.join(runDir, "active-run.json"), JSON.stringify({
      runId,
      pid: unrelated.pid,
      leaseVersion: 2,
      processFingerprint: staleFingerprint,
      launchToken: "stale-runner-token",
      status: "running",
      startedAt,
      deadlineAt,
      durationMinutes: 1,
      minimumSweepMinutes: 0.001,
      eventLogPath: path.join(runDir, `${runId}.json`)
    }));

    try {
      const result = await runLauncherAsync(root, { args: [], env: {} }).completion;
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, "resumed");
      await waitFor(() => exists(path.join(root, "collector-ready")));
      const active = await readActiveRun(root);
      assert.notEqual(active.pid, unrelated.pid);
      await interruptActiveRun(root);
    } finally {
      unrelated.kill("SIGTERM");
      await unrelatedExit;
    }
  });

  it("never overwrites a fast child terminal state with stale running launcher state", async () => {
    const root = await createLauncherRoot(`
      process.stderr.write("fast failure\\n");
      process.exitCode = 9;
    `);
    const result = await runLauncherAsync(root, {
      args: ["--minutes=1", "--minimum-sweep-minutes=0.001"],
      env: { LONG_RUN_ID: "fast-terminal-child" }
    }).completion;
    assert.equal(result.code, 0, result.stderr);
    await waitFor(async () => terminalRunStatuses.has((await readActiveRun(root)).status));
    const active = await readActiveRun(root);
    assert.equal(active.runId, "fast-terminal-child");
    assert.equal(active.status, "failed");
    assert.equal(active.pid, null);
    assert.ok(Number.isInteger(active.terminalPid));
    const runLog = await readRunLog(root, "fast-terminal-child");
    assertSingleFinishedEvent(runLog, "failed");
    const claimOwner = JSON.parse(
      await readFile(path.join(root, "outputs", "longrun", ".launcher-claim", "owner.json"), "utf8")
    );
    assert.equal(claimOwner.ownerKind, "released");
    assert.equal(claimOwner.ownerPid, null);
    assert.equal(claimOwner.childPid, null);
  });
});

async function createStubRoot(stubSource) {
  const root = await mkdtemp(path.join(os.tmpdir(), "returner-long-cycle-stub-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(path.join(root, "scripts", "run-autonomous-ingestion.mjs"), stubSource, "utf8");
  return root;
}

async function createLauncherRoot(stubSource) {
  const root = await createStubRoot(stubSource);
  await Promise.all([
    symlink(runnerPath, path.join(root, "scripts", "run-long-cycle.mjs")),
    symlink(launcherPath, path.join(root, "scripts", "start-long-cycle.mjs"))
  ]);
  return root;
}

async function seedRunLog(root, value) {
  const runDir = path.join(root, "outputs", "longrun");
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, `${value.runId}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8"
  );
}

function runFixture(root, { runId, startedAt, args, env = {} }) {
  const fixtureEnv = {
    ...process.env,
    ...env,
    LONG_RUN_ID: runId,
    LONG_RUN_ALLOW_DIRECT: "1"
  };
  if (startedAt === null) {
    delete fixtureEnv.LONG_RUN_START_AT;
  } else {
    fixtureEnv.LONG_RUN_START_AT = startedAt;
  }
  return spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: fixtureEnv
  });
}

function runFixtureAsync(root, { runId, startedAt, args, env = {} }) {
  const fixtureEnv = {
    ...process.env,
    ...env,
    LONG_RUN_ID: runId,
    LONG_RUN_ALLOW_DIRECT: "1"
  };
  if (startedAt === null) {
    delete fixtureEnv.LONG_RUN_START_AT;
  } else {
    fixtureEnv.LONG_RUN_START_AT = startedAt;
  }
  const child = spawn(process.execPath, [runnerPath, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: fixtureEnv
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return {
    child,
    completion: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    })
  };
}

function runLauncherAsync(root, { args, env }) {
  const fixtureEnv = { ...process.env, ...env };
  if (!Object.hasOwn(env, "LONG_RUN_ID")) delete fixtureEnv.LONG_RUN_ID;
  if (!Object.hasOwn(env, "LONG_RUN_START_AT")) delete fixtureEnv.LONG_RUN_START_AT;
  if (!Object.hasOwn(env, "LONG_RUN_DEADLINE_AT")) delete fixtureEnv.LONG_RUN_DEADLINE_AT;
  const child = spawn(process.execPath, [launcherPath, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: fixtureEnv
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return {
    child,
    completion: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    })
  };
}

function runPublicRunnerAsync(root, { args, env }) {
  const fixtureEnv = { ...process.env, ...env };
  delete fixtureEnv.LONG_RUN_ALLOW_DIRECT;
  if (!Object.hasOwn(env, "LONG_RUN_ID")) delete fixtureEnv.LONG_RUN_ID;
  if (!Object.hasOwn(env, "LONG_RUN_START_AT")) delete fixtureEnv.LONG_RUN_START_AT;
  if (!Object.hasOwn(env, "LONG_RUN_DEADLINE_AT")) delete fixtureEnv.LONG_RUN_DEADLINE_AT;
  const child = spawn(process.execPath, [runnerPath, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: fixtureEnv
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return {
    child,
    completion: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    })
  };
}

async function interruptActiveRun(root) {
  const active = await readActiveRun(root);
  if (active?.pid && !terminalRunStatuses.has(active.status)) {
    try {
      process.kill(active.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  await waitFor(async () => terminalRunStatuses.has((await readActiveRun(root)).status));
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms.`);
}

async function readRunLog(root, runId) {
  return JSON.parse(
    await readFile(path.join(root, "outputs", "longrun", `${runId}.json`), "utf8")
  );
}

async function readActiveRun(root) {
  return JSON.parse(
    await readFile(path.join(root, "outputs", "longrun", "active-run.json"), "utf8")
  );
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertSingleFinishedEvent(runLog, expectedStatus) {
  const finished = runLog.eventLog.filter((event) => event.type === "run_finished");
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, expectedStatus);
}

function isPidRunning(pid) {
  const parsedPid = Number(pid);
  if (!Number.isInteger(parsedPid) || parsedPid <= 0) return false;
  try {
    process.kill(parsedPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
