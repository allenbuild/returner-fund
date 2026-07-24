import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

const repositoryRoot = process.cwd();
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
    assert.match(runnerSource, /spawn\(process\.execPath/);
    assert.match(launcherSource, /spawn\(process\.execPath/);
    assert.doesNotMatch(runnerSource, /spawn\(["'](?:node|npm)["']/);
    assert.match(runnerSource, /run-autonomous-ingestion\.mjs/);
    assert.match(
      runnerSource,
      /autonomousRunnerPath,\s*"--skip-publish",\s*`--idempotency-key=\$\{idempotencyKey\}`/
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
      symlink(path.join(repositoryRoot, "node_modules"), path.join(root, "node_modules"), "dir")
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
});
