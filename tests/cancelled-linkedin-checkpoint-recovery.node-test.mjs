import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import {
  CANCELLED_S26_RUN001_INCIDENT,
  incidentPaths,
  parseCancelledS26Run001RecoveryArguments,
  recoverCancelledS26Run001LocalState
} from "../ops-oneoff/recover-cancelled-s26-linkedin-run001.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("cancelled S26 LinkedIn run001 local recovery", () => {
  it("defaults to a byte-preserving dry run", async () => {
    const fixture = await createIncidentFixture();
    const before = await snapshotFixture(fixture.paths);
    const result = await recoverCancelledS26Run001LocalState({
      incident: fixture.incident,
      paths: fixture.paths,
      now: () => fixture.nowMs,
      processExists: () => false
    });

    assert.equal(result.status, "dry_run");
    assert.equal(result.globalLeaseTouched, false);
    assert.deepEqual(await snapshotFixture(fixture.paths), before);
    await assert.rejects(access(fixture.paths.backupDirectory), { code: "ENOENT" });
    await assert.rejects(access(fixture.paths.controllerArchive), { code: "ENOENT" });
  });

  it("backs up and restores only the exact cancelled local incident delta", async () => {
    const fixture = await createIncidentFixture();
    const before = await snapshotFixture(fixture.paths);
    const result = await recoverCancelledS26Run001LocalState({
      apply: true,
      incident: fixture.incident,
      paths: fixture.paths,
      now: () => fixture.nowMs,
      processExists: () => false,
      recoveryPid: 43210
    });

    assert.equal(result.status, "local_state_recovered");
    assert.equal(result.globalLeaseTouched, false);
    assert.equal(await hashFile(fixture.paths.checkpoint), fixture.incident.hashes.restoredCheckpoint);
    assert.equal(await hashFile(fixture.paths.output), fixture.incident.hashes.output);
    assert.deepEqual(JSON.parse(await readFile(fixture.paths.checkpoint, "utf8")), fixture.baseline);
    assert.deepEqual(
      JSON.parse(await readFile(fixture.paths.controllerArchive, "utf8")),
      fixture.controller
    );
    await assert.rejects(access(fixture.paths.controllerState), { code: "ENOENT" });
    await assert.rejects(access(fixture.paths.collectorLock), { code: "ENOENT" });
    await assert.rejects(access(fixture.paths.driverLock), { code: "ENOENT" });

    const pacing = JSON.parse(await readFile(fixture.paths.pacingState, "utf8"));
    assert.equal(pacing.phase, "completed");
    assert.equal(pacing.pid, fixture.incident.collectorPid);
    assert.equal(pacing.attemptToken, fixture.pacing.attemptToken);
    assert.equal(pacing.lastTargetAttemptAt, fixture.incident.runTerminatedAt);
    assert.equal(pacing.lastTargetAttemptAtMs, Date.parse(fixture.incident.runTerminatedAt));

    const driver = JSON.parse(await readFile(fixture.paths.driverState, "utf8"));
    assert.equal(driver.pending, null);
    assert.deepEqual(driver.batches, fixture.driver.batches);
    assert.deepEqual(driver.completedRuns, fixture.driver.completedRuns);
    assert.deepEqual(driver.unrelatedSentinel, fixture.driver.unrelatedSentinel);

    const backupNames = [
      "checkpoint.before.json",
      "output.before.json",
      "controller-state.before.json",
      "driver-state.before.json",
      "driver-lock.before.json",
      "collector-lock.before.json",
      "pacing-state.before.json"
    ];
    for (const [index, name] of backupNames.entries()) {
      assert.deepEqual(
        await readFile(path.join(fixture.paths.backupDirectory, name)),
        before[index].bytes
      );
    }
    const receipt = JSON.parse(await readFile(fixture.paths.appliedReceipt, "utf8"));
    assert.equal(receipt.globalLeaseTouched, false);
    assert.deepEqual(
      receipt.removedFalseAttemptKeys,
      fixture.incident.falseTargets.map((target) => target.key)
    );
  });

  it("fails closed before mutation on hash, live-PID, cooldown, or guard drift", async () => {
    for (const mutation of ["hash", "pid", "cooldown", "collector-guard", "controller-guard", "driver-guard"]) {
      const fixture = await createIncidentFixture();
      if (mutation === "hash") await writeFile(fixture.paths.output, "{}\n");
      if (mutation === "collector-guard") await writeFile(fixture.paths.collectorAcquireGuard, "occupied\n");
      if (mutation === "controller-guard") await writeFile(fixture.paths.controllerAcquireGuard, "occupied\n");
      if (mutation === "driver-guard") await writeFile(fixture.paths.driverRecoveryGuard, "occupied\n");
      const processExists = mutation === "pid"
        ? (pid) => pid === fixture.incident.collectorPid
        : () => false;
      const now = mutation === "cooldown"
        ? () => Date.parse(fixture.incident.runTerminatedAt) + fixture.incident.minimumCooldownMs - 1
        : () => fixture.nowMs;

      await assert.rejects(
        recoverCancelledS26Run001LocalState({
          apply: true,
          incident: fixture.incident,
          paths: fixture.paths,
          now,
          processExists
        }),
        /hash mismatch|still alive|cooldown|requires this exact path to be absent/i,
        mutation
      );
      await assert.rejects(access(fixture.paths.backupDirectory), { code: "ENOENT" });
      assert.equal(
        JSON.parse(await readFile(fixture.paths.driverState, "utf8")).pending.runId,
        fixture.incident.runId
      );
    }
  });

  it("re-probes the sealed PIDs after all exclusion guards are held", async () => {
    const fixture = await createIncidentFixture();
    let probes = 0;
    await assert.rejects(
      recoverCancelledS26Run001LocalState({
        apply: true,
        incident: fixture.incident,
        paths: fixture.paths,
        now: () => fixture.nowMs,
        processExists: () => {
          probes += 1;
          return probes === 3;
        }
      }),
      /became live before recovery apply/
    );
    assert.equal(probes, 3);
    await assert.rejects(access(fixture.paths.backupDirectory), { code: "ENOENT" });
    await assert.rejects(access(fixture.paths.collectorAcquireGuard), { code: "ENOENT" });
    await assert.rejects(access(fixture.paths.controllerAcquireGuard), { code: "ENOENT" });
    await assert.rejects(access(fixture.paths.driverRecoveryGuard), { code: "ENOENT" });
  });

  it("rolls back byte-exactly after every local mutation boundary", async () => {
    const steps = [
      "checkpoint_restored",
      "controller_archived",
      "pacing_repaired",
      "collector_lock_removed",
      "driver_pending_cleared",
      "driver_lock_removed"
    ];
    for (const step of steps) {
      const fixture = await createIncidentFixture();
      const before = await snapshotFixture(fixture.paths);
      await assert.rejects(
        recoverCancelledS26Run001LocalState({
          apply: true,
          incident: fixture.incident,
          paths: fixture.paths,
          now: () => fixture.nowMs,
          processExists: () => false,
          testHooks: {
            afterMutation(completedStep) {
              if (completedStep === step) throw new Error(`injected after ${step}`);
            }
          }
        }),
        new RegExp(`injected after ${step}`)
      );
      assert.deepEqual(
        (await snapshotFixture(fixture.paths)).map((entry) => entry.bytes),
        before.map((entry) => entry.bytes),
        step
      );
      await assert.rejects(access(fixture.paths.backupDirectory), { code: "ENOENT" });
      await assert.rejects(access(fixture.paths.backupPreparingDirectory), { code: "ENOENT" });
      await assert.rejects(access(fixture.paths.controllerArchive), { code: "ENOENT" });
      await assert.rejects(access(fixture.paths.collectorAcquireGuard), { code: "ENOENT" });
      await assert.rejects(access(fixture.paths.controllerAcquireGuard), { code: "ENOENT" });
      await assert.rejects(access(fixture.paths.driverRecoveryGuard), { code: "ENOENT" });
    }
  });

  it("requires --apply plus every exact sealed confirmation", () => {
    assert.deepEqual(parseCancelledS26Run001RecoveryArguments([]), {
      help: false,
      apply: false
    });
    assert.throws(
      () => parseCancelledS26Run001RecoveryArguments(["--apply"]),
      /requires every sealed confirmation/
    );
    assert.throws(
      () => parseCancelledS26Run001RecoveryArguments([
        "--apply",
        `--run-id=${CANCELLED_S26_RUN001_INCIDENT.runId + 1}`
      ]),
      /does not match the sealed incident/
    );
    assert.deepEqual(
      parseCancelledS26Run001RecoveryArguments(productionApplyArguments()),
      { help: false, apply: true }
    );
  });

  it("has no Supabase, network, or child-process capability", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../ops-oneoff/recover-cancelled-s26-linkedin-run001.mjs", import.meta.url)),
      "utf8"
    );
    assert.doesNotMatch(source, /from\s+["']@supabase|createClient\s*\(|\.rpc\s*\(/);
    assert.doesNotMatch(source, /node:child_process|\bfetch\s*\(/);
  });

  it("blocks the foreground driver before and during stale-lock recovery", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../ops-oneoff/linkedin-checkpoint-backlog-drain.mjs", import.meta.url)),
      "utf8"
    );
    assert.match(source, /assertNoDriverRecovery\(recoveryLockPath\);\s*const release/);
    assert.match(source, /acquireExclusiveLock\(lockPath, recoveryLockPath = null\)/);
    assert.match(source, /if \(recoveryLockPath\) await assertNoDriverRecovery\(recoveryLockPath\);\s*await rm\(lockPath\)/);
  });
});

async function createIncidentFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cancelled-s26-run001-test-"));
  temporaryRoots.push(root);
  const replayRoot = path.join(root, "replay");
  const hostTempRoot = path.join(root, "temp");
  await mkdir(path.join(replayRoot, "checkpoint-collection-runs"), { recursive: true });
  await mkdir(hostTempRoot, { recursive: true });
  const runTerminatedAt = "2026-09-14T00:02:47.000Z";
  const falseTargets = CANCELLED_S26_RUN001_INCIDENT.falseTargets;
  const beforeAttempts = {
    "S26:linkedin:company-unrelated:https://www.linkedin.com/company/unrelated/": {
      status: "failed",
      checkedAt: "2026-09-13T22:00:00.000Z",
      error: "unrelated retained failure"
    }
  };
  const output = {
    evidence: [{ id: "unrelated-evidence", platform: "linkedin", batchSlug: "S26" }],
    failures: [{
      id: "unrelated-failure",
      platform: "linkedin",
      entityType: "company",
      entityId: "company-unrelated",
      companySlug: "unrelated",
      message: "unrelated retained failure"
    }],
    needsReview: [],
    attributionReconciliationLedger: []
  };
  const baseline = {
    attempts: beforeAttempts,
    evidence: output.evidence,
    failures: output.failures,
    needsReview: output.needsReview,
    attributionReconciliationLedger: output.attributionReconciliationLedger
  };
  const checkpoint = {
    attempts: {
      ...beforeAttempts,
      ...Object.fromEntries(falseTargets.map((target) => [target.key, {
        status: "done",
        checkedAt: "2026-09-13T23:47:19.916Z",
        count: 0
      }]))
    },
    evidence: output.evidence,
    failures: [
      ...output.failures,
      ...falseTargets.map((target) => ({
        id: `failure-${target.companySlug}`,
        platform: "linkedin",
        entityType: "company",
        entityId: target.entityId,
        companySlug: target.companySlug,
        message: "No attributable original LinkedIn posts were visible in browser mode."
      }))
    ],
    needsReview: [{ id: "partial-child-collision-review" }],
    attributionReconciliationLedger: []
  };
  const hashes = {
    currentCheckpoint: sha256(jsonBytes(checkpoint)),
    restoredCheckpoint: sha256(jsonBytes(baseline)),
    output: sha256(jsonBytes(output))
  };
  const incidentBase = {
    ...CANCELLED_S26_RUN001_INCIDENT,
    replayRoot,
    hostTempRoot,
    runTerminatedAt,
    minimumCooldownMs: 30_000,
    collectorPid: 60001,
    driverPid: 60002,
    falseTargets,
    hashes
  };
  const paths = incidentPaths(incidentBase);
  const controller = {
    schemaVersion: 1,
    kind: "s2026_linkedin_checkpoint_collection_state",
    status: "running",
    idempotencyKey: incidentBase.incidentKey,
    sourceSha: incidentBase.sourceSha,
    expectedCheckpointSha256: hashes.restoredCheckpoint,
    expectedRemaining: 672,
    beforeRemaining: 672,
    beforeCheckpointSha256: hashes.restoredCheckpoint,
    beforeOutputSha256: hashes.output,
    currentRemaining: 672,
    currentCheckpointSha256: hashes.restoredCheckpoint,
    currentOutputSha256: hashes.output,
    completedTargets: 0,
    chunksCompleted: 0,
    batteryChunks: 0,
    acChunks: 0,
    chunkReceipts: [],
    intent: {
      chunkNumber: 1,
      powerMode: "ac",
      beforeRemaining: 672,
      selectedKeys: incidentBase.selectedKeys,
      beforeAttempts,
      checkpointSha256Before: hashes.restoredCheckpoint,
      outputSha256Before: hashes.output
    }
  };
  const driver = {
    schemaVersion: 2,
    kind: "linkedin_checkpoint_backlog_foreground_drain",
    repository: "allenbuild/returner-fund",
    workflow: "autonomous-ingestion.yml",
    batches: { S26: { status: "pending" }, S2026: { status: "pending" } },
    completedRuns: [{ key: "older-unrelated-run" }],
    pending: {
      batchSlug: "S26",
      mode: "checkpoint",
      key: incidentBase.incidentKey,
      sourceSha: incidentBase.sourceSha,
      adopted: true,
      runId: incidentBase.runId
    },
    unrelatedSentinel: { preserve: true }
  };
  const driverLock = { pid: incidentBase.driverPid, startedAt: "2026-09-13T23:48:59.080Z" };
  const collectorLock = {
    pid: incidentBase.collectorPid,
    token: "sealed-collector-token",
    acquiredAt: "2026-09-13T23:47:20.421Z"
  };
  const pacing = {
    version: 1,
    phase: "in_progress",
    attemptToken: "sealed-pacing-token",
    pid: incidentBase.collectorPid,
    lastTargetAttemptAtMs: Date.parse("2026-09-13T23:59:31.611Z"),
    lastTargetAttemptAt: "2026-09-13T23:59:31.611Z"
  };
  const bytes = {
    checkpoint: jsonBytes(checkpoint),
    output: jsonBytes(output),
    controller: jsonBytes(controller),
    driver: jsonBytes(driver, true),
    driverLock: jsonBytes(driverLock, true),
    collectorLock: Buffer.from(JSON.stringify(collectorLock)),
    pacing: jsonBytes(pacing)
  };
  Object.assign(hashes, {
    controllerState: sha256(bytes.controller),
    driverState: sha256(bytes.driver),
    driverLock: sha256(bytes.driverLock),
    collectorLock: sha256(bytes.collectorLock),
    pacingState: sha256(bytes.pacing),
    repairedDriverState: sha256(jsonBytes({ ...driver, pending: null }, true)),
    repairedPacingState: sha256(jsonBytes({
      ...pacing,
      phase: "completed",
      lastTargetAttemptAtMs: Date.parse(runTerminatedAt),
      lastTargetAttemptAt: runTerminatedAt
    }))
  });
  const incident = Object.freeze({ ...incidentBase, hashes: Object.freeze({ ...hashes }) });
  await Promise.all([
    writeFile(paths.checkpoint, bytes.checkpoint),
    writeFile(paths.output, bytes.output),
    writeFile(paths.controllerState, bytes.controller, { mode: 0o600 }),
    writeFile(paths.driverState, bytes.driver, { mode: 0o600 }),
    writeFile(paths.driverLock, bytes.driverLock, { mode: 0o600 }),
    writeFile(paths.collectorLock, bytes.collectorLock, { mode: 0o600 }),
    writeFile(paths.pacingState, bytes.pacing, { mode: 0o600 })
  ]);
  return {
    incident,
    paths,
    baseline,
    controller,
    driver,
    pacing,
    nowMs: Date.parse(runTerminatedAt) + 60_000
  };
}

async function snapshotFixture(paths) {
  return Promise.all([
    paths.checkpoint,
    paths.output,
    paths.controllerState,
    paths.driverState,
    paths.driverLock,
    paths.collectorLock,
    paths.pacingState
  ].map(async (filePath) => {
    const [bytes, stat] = await Promise.all([readFile(filePath), lstat(filePath)]);
    return {
      filePath,
      bytes,
      inode: stat.ino,
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs
    };
  }));
}

function productionApplyArguments() {
  const incident = CANCELLED_S26_RUN001_INCIDENT;
  return [
    "--apply",
    `--incident-key=${incident.incidentKey}`,
    `--run-id=${incident.runId}`,
    `--source-sha=${incident.sourceSha}`,
    `--replay-root=${incident.replayRoot}`,
    `--current-checkpoint-sha256=${incident.hashes.currentCheckpoint}`,
    `--restored-checkpoint-sha256=${incident.hashes.restoredCheckpoint}`,
    `--output-sha256=${incident.hashes.output}`,
    `--controller-state-sha256=${incident.hashes.controllerState}`,
    `--driver-state-sha256=${incident.hashes.driverState}`,
    `--driver-lock-sha256=${incident.hashes.driverLock}`,
    `--collector-lock-sha256=${incident.hashes.collectorLock}`,
    `--pacing-state-sha256=${incident.hashes.pacingState}`,
    `--repaired-driver-state-sha256=${incident.hashes.repairedDriverState}`,
    `--repaired-pacing-state-sha256=${incident.hashes.repairedPacingState}`,
    `--collector-pid=${incident.collectorPid}`,
    `--driver-pid=${incident.driverPid}`,
    `--terminated-at=${incident.runTerminatedAt}`,
    `--minimum-cooldown-ms=${incident.minimumCooldownMs}`
  ];
}

async function hashFile(filePath) {
  return sha256(await readFile(filePath));
}

function jsonBytes(value, pretty = false) {
  return Buffer.from(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
