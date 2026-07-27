import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

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
    assert.match(runnerSource, /numberArg\("--minutes"\) \?\? 300/);
    assert.match(launcherSource, /numberArg\("--minutes"\) \?\? 300/);
    assert.match(runnerSource, /numberArg\("--minimum-sweep-minutes"\) \?\? 45/);
    assert.match(launcherSource, /numberArg\("--minimum-sweep-minutes"\) \?\? 45/);
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
      startedAt: new Date(Date.now() - 59_000).toISOString(),
      args: ["--minutes=1", "--minimum-sweep-minutes=1"]
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
});

async function createStubRoot(stubSource) {
  const root = await mkdtemp(path.join(os.tmpdir(), "returner-long-cycle-stub-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(path.join(root, "scripts", "run-autonomous-ingestion.mjs"), stubSource, "utf8");
  return root;
}

function runFixture(root, { runId, startedAt, args }) {
  return spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      LONG_RUN_ID: runId,
      LONG_RUN_START_AT: startedAt
    }
  });
}

function runFixtureAsync(root, { runId, startedAt, args }) {
  const child = spawn(process.execPath, [runnerPath, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      LONG_RUN_ID: runId,
      LONG_RUN_START_AT: startedAt
    }
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
