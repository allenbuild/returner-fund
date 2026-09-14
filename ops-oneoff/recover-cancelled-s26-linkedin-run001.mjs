import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INCIDENT_KEY = "incident-20260913-s26-linkedin-backlog-001";
const RUN_ID = 34790596070;
const SOURCE_SHA = "86b4b7a821b46dc342c31af5312699ff949ee9dd";
const REPLAY_ROOT = "/Users/allenxu/Library/Application Support/Returner Fund OpenCLI/returner-fund-autonomous-replay/authenticated-social-history-v1-0b7b68f8578289bc";
const HOST_TEMP_ROOT = "/var/folders/6h/z6whx9hd06d_23d6_25tf2l40000gn/T";
const RUN_TERMINATED_AT = "2026-09-14T00:02:47.000Z";
const MINIMUM_COOLDOWN_MS = 30_000;
const COLLECTOR_PID = 6822;
const DRIVER_PID = 10756;

const SELECTED_KEYS = Object.freeze([
  "S26:linkedin:company-agent-fm:https://www.linkedin.com/company/agent-fm-ai/",
  "S26:linkedin:company-akon-labs:https://www.linkedin.com/company/akon-labs/",
  "S26:linkedin:company-aktoria-robotics:https://www.linkedin.com/company/aktoria-robotics",
  "S26:linkedin:company-allia-health:https://www.linkedin.com/company/alliahealth/",
  "S26:linkedin:company-almanac:https://www.linkedin.com/company/usealmanac/"
]);

const FALSE_TARGETS = Object.freeze([
  Object.freeze({
    key: "S26:linkedin:company-agent-fm:https://www.linkedin.com/company/agent-fm-ai/",
    companySlug: "agent-fm",
    entityId: "company-agent-fm"
  }),
  Object.freeze({
    key: "S26:linkedin:company-akon-labs:https://www.linkedin.com/company/akon-labs/",
    companySlug: "akon-labs",
    entityId: "company-akon-labs"
  }),
  Object.freeze({
    key: "S26:linkedin:company-aktoria-robotics:https://www.linkedin.com/company/aktoria-robotics",
    companySlug: "aktoria-robotics",
    entityId: "company-aktoria-robotics"
  })
]);

const EXPECTED_HASHES = Object.freeze({
  currentCheckpoint: "34657f0efb82c2831579148c6a80528d0710b06fa37c1214a51f7906250dc163",
  restoredCheckpoint: "86743415af8ff33c34dc05c257105d748a243b88409bde49688b993effb20897",
  output: "6678bf7e4ae1c9e9b26620ed2af16a3fed6db321beb7e4eef51740f5ddc6218a",
  controllerState: "5ad92f580a5433ba12c02d03678a33bd084cb79dc84e4a2193635a69182c3819",
  driverState: "f868742e9b911b6755a5832d4a411f1934aa3c73d13cc085d9d630e629883734",
  driverLock: "2b4e848cab80fa64246bf16fb5893bb3ba5b1f6e2ae6d5847e422b1497f547d8",
  collectorLock: "9d8235ea4ae2882ec7e795f523d03a5a105020cfb59830f77d7acd4ce2f89f81",
  pacingState: "7071b234c4934215d2a8d60fe828343e0f07c6245cc7f3ee1c9a85ffd917f943",
  repairedDriverState: "2c2f9fb300641ef645b5af4cd171aedb51766fd06e006b3d20d7ec93bd03a9de",
  repairedPacingState: "6e8140106e65ce3add6470124669d4518692e4978e6c04f637c885b4d523b70c"
});

export const CANCELLED_S26_RUN001_INCIDENT = Object.freeze({
  incidentKey: INCIDENT_KEY,
  runId: RUN_ID,
  sourceSha: SOURCE_SHA,
  replayRoot: REPLAY_ROOT,
  hostTempRoot: HOST_TEMP_ROOT,
  runTerminatedAt: RUN_TERMINATED_AT,
  minimumCooldownMs: MINIMUM_COOLDOWN_MS,
  collectorPid: COLLECTOR_PID,
  driverPid: DRIVER_PID,
  selectedKeys: SELECTED_KEYS,
  falseTargets: FALSE_TARGETS,
  hashes: EXPECTED_HASHES
});

const REQUIRED_APPLY_CONFIRMATIONS = Object.freeze({
  "incident-key": INCIDENT_KEY,
  "run-id": String(RUN_ID),
  "source-sha": SOURCE_SHA,
  "replay-root": REPLAY_ROOT,
  "current-checkpoint-sha256": EXPECTED_HASHES.currentCheckpoint,
  "restored-checkpoint-sha256": EXPECTED_HASHES.restoredCheckpoint,
  "output-sha256": EXPECTED_HASHES.output,
  "controller-state-sha256": EXPECTED_HASHES.controllerState,
  "driver-state-sha256": EXPECTED_HASHES.driverState,
  "driver-lock-sha256": EXPECTED_HASHES.driverLock,
  "collector-lock-sha256": EXPECTED_HASHES.collectorLock,
  "pacing-state-sha256": EXPECTED_HASHES.pacingState,
  "repaired-driver-state-sha256": EXPECTED_HASHES.repairedDriverState,
  "repaired-pacing-state-sha256": EXPECTED_HASHES.repairedPacingState,
  "collector-pid": String(COLLECTOR_PID),
  "driver-pid": String(DRIVER_PID),
  "terminated-at": RUN_TERMINATED_AT,
  "minimum-cooldown-ms": String(MINIMUM_COOLDOWN_MS)
});

export function parseCancelledS26Run001RecoveryArguments(argv) {
  const supplied = new Map();
  let apply = false;
  let help = false;
  for (const argument of argv) {
    if (argument === "--apply") {
      if (apply) throw new Error("--apply may be supplied only once.");
      apply = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    const match = argument.match(/^--([a-z0-9-]+)=(.*)$/);
    if (!match || !(match[1] in REQUIRED_APPLY_CONFIRMATIONS)) {
      throw new Error(`Unknown recovery argument: ${argument}`);
    }
    if (supplied.has(match[1])) throw new Error(`Duplicate recovery argument: --${match[1]}`);
    if (match[2] !== REQUIRED_APPLY_CONFIRMATIONS[match[1]]) {
      throw new Error(`Recovery confirmation --${match[1]} does not match the sealed incident.`);
    }
    supplied.set(match[1], match[2]);
  }
  if (help) return Object.freeze({ help: true, apply: false });
  if (apply) {
    const missing = Object.keys(REQUIRED_APPLY_CONFIRMATIONS).filter((key) => !supplied.has(key));
    if (missing.length > 0) {
      throw new Error(`--apply requires every sealed confirmation; missing: ${missing.join(", ")}`);
    }
  } else if (supplied.size > 0) {
    throw new Error("Sealed confirmation arguments are accepted only together with --apply.");
  }
  return Object.freeze({ help: false, apply });
}

export async function recoverCancelledS26Run001LocalState({
  apply = false,
  incident = CANCELLED_S26_RUN001_INCIDENT,
  paths = incidentPaths(incident),
  now = Date.now,
  processExists = defaultProcessExists,
  recoveryPid = process.pid,
  testHooks = null
} = {}) {
  validateIncidentContract(incident, paths);
  const current = await readAndValidateIncidentState({ incident, paths, now, processExists });
  const summary = Object.freeze({
    status: apply ? "local_state_recovered" : "dry_run",
    incidentKey: incident.incidentKey,
    runId: incident.runId,
    sourceSha: incident.sourceSha,
    checkpointSha256Before: incident.hashes.currentCheckpoint,
    checkpointSha256After: incident.hashes.restoredCheckpoint,
    outputSha256: incident.hashes.output,
    removedFalseAttempts: incident.falseTargets.length,
    controllerStateArchive: paths.controllerArchive,
    backupDirectory: paths.backupDirectory,
    collectionReady: false,
    durableGlobalLeaseStatus: "not_inspected",
    globalLeaseTouched: false
  });
  if (!apply) {
    await revalidateIncidentBytes(current, incident, paths);
    return summary;
  }

  const recoveryToken = randomUUID();
  const guardBytes = jsonBytes({
    pid: recoveryPid,
    startedAt: new Date(now()).toISOString(),
    incidentKey: incident.incidentKey,
    recoveryToken
  }, true);
  const guardPaths = [
    paths.driverRecoveryGuard,
    paths.collectorAcquireGuard,
    paths.controllerAcquireGuard
  ];
  const acquiredGuards = [];
  let mutationStarted = false;
  let backupCommitted = false;
  let releaseGuards = true;
  let operationError = null;
  try {
    for (const guardPath of guardPaths) {
      await writeExclusiveSynced(guardPath, guardBytes, 0o600);
      acquiredGuards.push(guardPath);
    }
    for (const guardPath of acquiredGuards) await assertOwnedGuard(guardPath, guardBytes);
    await revalidateIncidentBytes(current, incident, paths);
    if (processExists(incident.collectorPid) || processExists(incident.driverPid)) {
      throw new Error("A sealed incident PID became live before recovery apply.");
    }
    await assertMissing(paths.controllerLock);
    await assertMissing(paths.controllerArchive);
    await assertMissing(paths.backupDirectory);
    await assertMissing(paths.backupPreparingDirectory);

    await writeBackups(paths, current, incident);
    backupCommitted = true;
    mutationStarted = true;
    await atomicWrite(paths.checkpoint, current.restoredCheckpointBytes, current.modes.checkpoint);
    await testHooks?.afterMutation?.("checkpoint_restored");
    if (await hashFile(paths.checkpoint) !== incident.hashes.restoredCheckpoint) {
      throw new Error("Atomic checkpoint restoration did not produce the sealed pre-incident hash.");
    }

    if (await hashFile(paths.controllerState) !== incident.hashes.controllerState) {
      throw new Error("Controller state changed before archival.");
    }
    await link(paths.controllerState, paths.controllerArchive);
    await unlink(paths.controllerState);
    await testHooks?.afterMutation?.("controller_archived");

    await atomicWrite(paths.pacingState, current.repairedPacingBytes, current.modes.pacingState);
    await testHooks?.afterMutation?.("pacing_repaired");
    if (await hashFile(paths.collectorLock) !== incident.hashes.collectorLock) {
      throw new Error("Collector lock changed before exact dead-owner removal.");
    }
    await unlink(paths.collectorLock);
    await testHooks?.afterMutation?.("collector_lock_removed");

    await assertPreDriverRepairState({ incident, paths });
    await atomicWrite(paths.driverState, current.repairedDriverStateBytes, current.modes.driverState);
    await testHooks?.afterMutation?.("driver_pending_cleared");
    if (await hashFile(paths.driverLock) !== incident.hashes.driverLock) {
      throw new Error("Driver lock changed before exact dead-owner removal.");
    }
    await unlink(paths.driverLock);
    await testHooks?.afterMutation?.("driver_lock_removed");

    await assertAppliedLocalState({ incident, paths, current });

    await writeExclusiveSynced(
      paths.appliedReceipt,
      jsonBytes({
        schemaVersion: 1,
        kind: "cancelled_s26_linkedin_run001_local_recovery",
        appliedAt: new Date(now()).toISOString(),
        incidentKey: incident.incidentKey,
        runId: incident.runId,
        sourceSha: incident.sourceSha,
        checkpointSha256Before: incident.hashes.currentCheckpoint,
        checkpointSha256After: incident.hashes.restoredCheckpoint,
        outputSha256: incident.hashes.output,
        controllerStateArchive: path.basename(paths.controllerArchive),
        removedFalseAttemptKeys: incident.falseTargets.map((target) => target.key),
        removedCollectorPid: incident.collectorPid,
        clearedDriverPid: incident.driverPid,
        repairedPacingFrom: current.pacing.lastTargetAttemptAt,
        repairedPacingTo: incident.runTerminatedAt,
        globalLeaseTouched: false
      }, true),
      0o600
    );
    return summary;
  } catch (error) {
    let finalError = error;
    try {
      if (mutationStarted) await rollbackIncidentState({ incident, paths, current });
      await rm(paths.backupPreparingDirectory, { recursive: true, force: true });
      if (backupCommitted) await rm(paths.backupDirectory, { recursive: true, force: true });
    } catch (rollbackError) {
      releaseGuards = false;
      finalError = new AggregateError(
        [error, rollbackError],
        "Incident recovery failed and exact rollback was not proven; recovery guards were retained."
      );
    }
    operationError = finalError;
    throw finalError;
  } finally {
    if (releaseGuards) {
      try {
        const releaseOrder = [
          paths.collectorAcquireGuard,
          paths.controllerAcquireGuard,
          paths.driverRecoveryGuard
        ].filter((guardPath) => acquiredGuards.includes(guardPath));
        for (const guardPath of releaseOrder) {
          await removeOwnedRecoveryLock(guardPath, guardBytes);
        }
      } catch (cleanupError) {
        if (!operationError) throw cleanupError;
        operationError.recoveryGuardCleanupError = cleanupError;
      }
    }
  }
}

export function incidentPaths(incident = CANCELLED_S26_RUN001_INCIDENT) {
  const controllerDirectory = path.join(incident.replayRoot, "checkpoint-collection-runs");
  const backupDirectory = path.join(
    incident.replayRoot,
    `incident-recovery-${incident.incidentKey}-run-${incident.runId}`
  );
  return Object.freeze({
    replayRoot: incident.replayRoot,
    checkpoint: path.join(incident.replayRoot, "logged-in-checkpoint-s26.json"),
    output: path.join(incident.replayRoot, "logged-in-s26.json"),
    controllerState: path.join(controllerDirectory, `${incident.incidentKey}.json`),
    controllerArchive: path.join(
      controllerDirectory,
      `${incident.incidentKey}.cancelled-run-${incident.runId}.json`
    ),
    controllerLock: path.join(incident.replayRoot, "s2026-linkedin-checkpoint-controller.lock"),
    controllerAcquireGuard: path.join(
      incident.replayRoot,
      "s2026-linkedin-checkpoint-controller.lock.acquire"
    ),
    driverState: path.join(incident.replayRoot, "linkedin-checkpoint-backlog-drain-state.json"),
    driverLock: path.join(incident.replayRoot, "linkedin-checkpoint-backlog-drain-state.json.lock"),
    driverRecoveryGuard: path.join(
      incident.replayRoot,
      "linkedin-checkpoint-backlog-drain-state.json.recovery.lock"
    ),
    collectorLock: path.join(incident.hostTempRoot, "returner-fund-linkedin-account-collector.lock"),
    collectorAcquireGuard: path.join(
      incident.hostTempRoot,
      "returner-fund-linkedin-account-collector.lock.acquire"
    ),
    pacingState: path.join(incident.hostTempRoot, "returner-fund-linkedin-account-pacing.json"),
    backupDirectory,
    backupPreparingDirectory: `${backupDirectory}.preparing`,
    appliedReceipt: path.join(backupDirectory, "applied.json")
  });
}

async function readAndValidateIncidentState({ incident, paths, now, processExists }) {
  const [root, sealedRoot] = await Promise.all([
    realpath(paths.replayRoot),
    realpath(incident.replayRoot)
  ]);
  if (root !== sealedRoot || paths.replayRoot !== incident.replayRoot) {
    throw new Error("Recovery root is not the exact sealed incident root.");
  }
  const files = await Promise.all([
    readExactRegularFile(paths.checkpoint, incident.hashes.currentCheckpoint),
    readExactRegularFile(paths.output, incident.hashes.output),
    readExactRegularFile(paths.controllerState, incident.hashes.controllerState),
    readExactRegularFile(paths.driverState, incident.hashes.driverState),
    readExactRegularFile(paths.driverLock, incident.hashes.driverLock),
    readExactRegularFile(paths.collectorLock, incident.hashes.collectorLock),
    readExactRegularFile(paths.pacingState, incident.hashes.pacingState)
  ]);
  const [checkpointFile, outputFile, controllerFile, driverFile, driverLockFile, collectorLockFile, pacingFile] = files;
  const checkpoint = parseJson(checkpointFile.bytes, "checkpoint");
  const output = parseJson(outputFile.bytes, "output");
  const controller = parseJson(controllerFile.bytes, "controller state");
  const driver = parseJson(driverFile.bytes, "driver state");
  const driverLock = parseJson(driverLockFile.bytes, "driver lock");
  const collectorLock = parseJson(collectorLockFile.bytes, "collector lock");
  const pacing = parseJson(pacingFile.bytes, "pacing state");
  validateController(controller, incident);
  validateCheckpointDelta(checkpoint, output, controller, incident);
  validateDriver(driver, driverLock, incident);
  validateCollectorLockAndPacing(collectorLock, pacing, incident, now, processExists);
  await assertMissing(paths.collectorAcquireGuard);
  await assertMissing(paths.controllerLock);
  await assertMissing(paths.controllerAcquireGuard);
  await assertMissing(paths.controllerArchive);
  await assertMissing(paths.backupDirectory);
  await assertMissing(paths.backupPreparingDirectory);
  await assertMissing(paths.driverRecoveryGuard);

  const restoredCheckpoint = {
    ...checkpoint,
    attempts: structuredClone(controller.intent.beforeAttempts),
    evidence: structuredClone(output.evidence ?? []),
    failures: structuredClone(output.failures ?? []),
    needsReview: structuredClone(output.needsReview ?? []),
    attributionReconciliationLedger: structuredClone(
      output.attributionReconciliationLedger ?? []
    )
  };
  const restoredCheckpointBytes = jsonBytes(restoredCheckpoint);
  if (sha256(restoredCheckpointBytes) !== incident.hashes.restoredCheckpoint) {
    throw new Error("Reconstructed checkpoint does not match the sealed pre-incident hash.");
  }
  const repairedDriver = { ...driver, pending: null };
  const repairedPacing = {
    ...pacing,
    phase: "completed",
    lastTargetAttemptAtMs: Date.parse(incident.runTerminatedAt),
    lastTargetAttemptAt: incident.runTerminatedAt
  };
  const repairedDriverStateBytes = jsonBytes(repairedDriver, true);
  const repairedPacingBytes = jsonBytes(repairedPacing);
  if (sha256(repairedDriverStateBytes) !== incident.hashes.repairedDriverState) {
    throw new Error("Cleared driver state does not match the sealed recovery hash.");
  }
  if (sha256(repairedPacingBytes) !== incident.hashes.repairedPacingState) {
    throw new Error("Completed pacing state does not match the sealed recovery hash.");
  }
  return Object.freeze({
    files,
    checkpoint: checkpointFile,
    output: outputFile,
    controller: controllerFile,
    driver: driverFile,
    driverLock: driverLockFile,
    collectorLock: collectorLockFile,
    pacingFile,
    pacing,
    restoredCheckpointBytes,
    repairedDriverStateBytes,
    repairedPacingBytes,
    modes: {
      checkpoint: checkpointFile.mode,
      driverState: driverFile.mode,
      pacingState: pacingFile.mode
    }
  });
}

function validateController(controller, incident) {
  const intent = controller?.intent;
  if (
    controller?.schemaVersion !== 1 ||
    controller.kind !== "s2026_linkedin_checkpoint_collection_state" ||
    controller.status !== "running" ||
    controller.idempotencyKey !== incident.incidentKey ||
    controller.sourceSha !== incident.sourceSha ||
    controller.expectedCheckpointSha256 !== incident.hashes.restoredCheckpoint ||
    controller.beforeCheckpointSha256 !== incident.hashes.restoredCheckpoint ||
    controller.currentCheckpointSha256 !== incident.hashes.restoredCheckpoint ||
    controller.beforeOutputSha256 !== incident.hashes.output ||
    controller.currentOutputSha256 !== incident.hashes.output ||
    controller.expectedRemaining !== 672 ||
    controller.beforeRemaining !== 672 ||
    controller.currentRemaining !== 672 ||
    controller.completedTargets !== 0 ||
    controller.chunksCompleted !== 0 ||
    !intent ||
    intent.chunkNumber !== 1 ||
    intent.beforeRemaining !== 672 ||
    intent.checkpointSha256Before !== incident.hashes.restoredCheckpoint ||
    intent.outputSha256Before !== incident.hashes.output ||
    !sameStrings(intent.selectedKeys, incident.selectedKeys) ||
    !plainObject(intent.beforeAttempts)
  ) {
    throw new Error("Controller state is not the exact interrupted run001 intent.");
  }
}

function validateCheckpointDelta(checkpoint, output, controller, incident) {
  if (!plainObject(checkpoint?.attempts)) throw new Error("Checkpoint attempts are malformed.");
  const beforeKeys = Object.keys(controller.intent.beforeAttempts).sort();
  const currentKeys = Object.keys(checkpoint.attempts).sort();
  const expectedKeys = [...beforeKeys, ...incident.falseTargets.map((target) => target.key)].sort();
  if (!sameStrings(currentKeys, expectedKeys)) {
    throw new Error("Checkpoint attempts contain state outside the exact interrupted delta.");
  }
  for (const target of incident.falseTargets) {
    const attempt = checkpoint.attempts[target.key];
    if (attempt?.status !== "done" || attempt.count !== 0) {
      throw new Error(`False target ${target.key} is not the sealed done-zero attempt.`);
    }
  }
  const outputFailureIds = new Set((output.failures ?? []).map((row) => row?.id));
  const extraFailures = (checkpoint.failures ?? []).filter((row) => !outputFailureIds.has(row?.id));
  if (extraFailures.length !== incident.falseTargets.length) {
    throw new Error("Checkpoint failure delta is not limited to the three false zero rows.");
  }
  for (const target of incident.falseTargets) {
    const matches = extraFailures.filter((row) =>
      row?.platform === "linkedin" &&
      row?.entityType === "company" &&
      row?.entityId === target.entityId &&
      row?.companySlug === target.companySlug &&
      row?.message === "No attributable original LinkedIn posts were visible in browser mode."
    );
    if (matches.length !== 1) {
      throw new Error(`False failure delta for ${target.companySlug} is not exact.`);
    }
  }
  for (const field of ["evidence", "failures", "needsReview", "attributionReconciliationLedger"]) {
    if (!Array.isArray(checkpoint[field]) || !Array.isArray(output[field] ?? [])) {
      throw new Error(`Checkpoint/output ${field} is malformed.`);
    }
  }
}

function validateDriver(driver, driverLock, incident) {
  const pending = driver?.pending;
  if (
    driver?.schemaVersion !== 2 ||
    driver.kind !== "linkedin_checkpoint_backlog_foreground_drain" ||
    !plainObject(driver.batches) ||
    !Array.isArray(driver.completedRuns) ||
    pending?.batchSlug !== "S26" ||
    pending.mode !== "checkpoint" ||
    pending.key !== incident.incidentKey ||
    pending.sourceSha !== incident.sourceSha ||
    pending.runId !== incident.runId ||
    pending.adopted !== true ||
    driverLock?.pid !== incident.driverPid
  ) {
    throw new Error("Driver state/lock is not bound only to cancelled run001.");
  }
}

function validateCollectorLockAndPacing(collectorLock, pacing, incident, now, processExists) {
  const nowMs = now();
  const terminatedAtMs = Date.parse(incident.runTerminatedAt);
  if (
    collectorLock?.pid !== incident.collectorPid ||
    typeof collectorLock.token !== "string" ||
    !collectorLock.token ||
    pacing?.version !== 1 ||
    pacing.phase !== "in_progress" ||
    pacing.pid !== incident.collectorPid ||
    typeof pacing.attemptToken !== "string" ||
    !pacing.attemptToken ||
    !Number.isFinite(pacing.lastTargetAttemptAtMs) ||
    pacing.lastTargetAttemptAtMs > terminatedAtMs ||
    !Number.isFinite(nowMs) ||
    nowMs < terminatedAtMs + incident.minimumCooldownMs
  ) {
    throw new Error("Collector lock/pacing state or post-cancellation cooldown is not exact.");
  }
  if (processExists(incident.collectorPid) || processExists(incident.driverPid)) {
    throw new Error("A sealed incident PID is still alive; local recovery is refused.");
  }
}

async function writeBackups(paths, current, incident) {
  await mkdir(paths.backupPreparingDirectory, { mode: 0o700 });
  const labels = [
    "checkpoint.before.json",
    "output.before.json",
    "controller-state.before.json",
    "driver-state.before.json",
    "driver-lock.before.json",
    "collector-lock.before.json",
    "pacing-state.before.json"
  ];
  for (let index = 0; index < labels.length; index += 1) {
    await writeExclusiveSynced(
      path.join(paths.backupPreparingDirectory, labels[index]),
      current.files[index].bytes,
      0o600
    );
  }
  await writeExclusiveSynced(
    path.join(paths.backupPreparingDirectory, "manifest.json"),
    jsonBytes({
      schemaVersion: 1,
      kind: "cancelled_s26_linkedin_run001_local_recovery_backup",
      incidentKey: incident.incidentKey,
      runId: incident.runId,
      sourceSha: incident.sourceSha,
      hashes: incident.hashes,
      globalLeaseTouched: false
    }, true),
    0o600
  );
  await rename(paths.backupPreparingDirectory, paths.backupDirectory);
}

async function writeExclusiveSynced(filePath, bytes, mode) {
  const handle = await open(filePath, "wx", mode);
  let completed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    completed = true;
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (!completed) await unlink(filePath).catch(() => undefined);
    throw error;
  }
}

async function removeOwnedRecoveryLock(lockPath, expectedBytes) {
  try {
    if (await hashFile(lockPath) === sha256(expectedBytes)) await unlink(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function assertOwnedGuard(lockPath, expectedBytes) {
  if (await hashFile(lockPath) !== sha256(expectedBytes)) {
    throw new Error(`Recovery guard ownership changed: ${lockPath}`);
  }
}

async function revalidateIncidentBytes(current, incident, paths, { driverLock = true } = {}) {
  const checks = [
    [paths.checkpoint, incident.hashes.currentCheckpoint],
    [paths.output, incident.hashes.output],
    [paths.controllerState, incident.hashes.controllerState],
    [paths.driverState, incident.hashes.driverState],
    [paths.collectorLock, incident.hashes.collectorLock],
    [paths.pacingState, incident.hashes.pacingState]
  ];
  if (driverLock) checks.push([paths.driverLock, incident.hashes.driverLock]);
  for (const [filePath, expectedHash] of checks) {
    if (await hashFile(filePath) !== expectedHash) {
      throw new Error(`Incident file changed during recovery validation: ${filePath}`);
    }
  }
  return current;
}

async function assertAppliedLocalState({ incident, paths, current }) {
  if (
    await hashFile(paths.checkpoint) !== incident.hashes.restoredCheckpoint ||
    await hashFile(paths.output) !== incident.hashes.output ||
    await hashFile(paths.controllerArchive) !== incident.hashes.controllerState ||
    await hashFile(paths.driverState) !== incident.hashes.repairedDriverState ||
    await hashFile(paths.pacingState) !== incident.hashes.repairedPacingState
  ) {
    throw new Error("Applied incident recovery did not satisfy every sealed output hash.");
  }
  await assertMissing(paths.controllerState);
  await assertMissing(paths.collectorLock);
  await assertMissing(paths.driverLock);
  const driver = parseJson(await readFile(paths.driverState), "repaired driver state");
  const expectedDriver = { ...parseJson(current.driver.bytes, "original driver state"), pending: null };
  if (JSON.stringify(driver) !== JSON.stringify(expectedDriver)) {
    throw new Error("Applied driver state changed fields other than the matching pending run.");
  }
}

async function assertPreDriverRepairState({ incident, paths }) {
  if (
    await hashFile(paths.checkpoint) !== incident.hashes.restoredCheckpoint ||
    await hashFile(paths.output) !== incident.hashes.output ||
    await hashFile(paths.controllerArchive) !== incident.hashes.controllerState ||
    await hashFile(paths.pacingState) !== incident.hashes.repairedPacingState ||
    await hashFile(paths.driverState) !== incident.hashes.driverState ||
    await hashFile(paths.driverLock) !== incident.hashes.driverLock
  ) {
    throw new Error("Local recovery preconditions changed before the final driver repair.");
  }
  await assertMissing(paths.controllerState);
  await assertMissing(paths.collectorLock);
}

async function rollbackIncidentState({ incident, paths, current }) {
  await atomicWrite(paths.checkpoint, current.checkpoint.bytes, current.modes.checkpoint);
  await atomicWrite(paths.pacingState, current.pacingFile.bytes, current.modes.pacingState);
  await atomicWrite(paths.driverState, current.driver.bytes, current.modes.driverState);
  await restoreExactFile(paths.collectorLock, current.collectorLock.bytes, current.collectorLock.mode);
  await restoreExactFile(paths.driverLock, current.driverLock.bytes, current.driverLock.mode);
  const controllerStateHash = await hashFileOrNull(paths.controllerState);
  const controllerArchiveHash = await hashFileOrNull(paths.controllerArchive);
  if (controllerStateHash === incident.hashes.controllerState) {
    if (controllerArchiveHash === incident.hashes.controllerState) {
      await unlink(paths.controllerArchive);
    } else if (controllerArchiveHash !== null) {
      throw new Error("Controller archive changed while rolling back incident recovery.");
    }
  } else if (controllerStateHash === null && controllerArchiveHash === incident.hashes.controllerState) {
    await link(paths.controllerArchive, paths.controllerState);
    await unlink(paths.controllerArchive);
  } else {
    throw new Error("Controller state changed while rolling back incident recovery.");
  }
  await assertOriginalLocalState({ incident, paths });
}

async function restoreExactFile(filePath, bytes, mode) {
  try {
    const existingHash = await hashFile(filePath);
    if (existingHash !== sha256(bytes)) {
      throw new Error(`Recovery rollback refused to overwrite changed file: ${filePath}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await atomicWrite(filePath, bytes, mode);
  }
}

async function assertOriginalLocalState({ incident, paths }) {
  const checks = [
    [paths.checkpoint, incident.hashes.currentCheckpoint],
    [paths.output, incident.hashes.output],
    [paths.controllerState, incident.hashes.controllerState],
    [paths.driverState, incident.hashes.driverState],
    [paths.driverLock, incident.hashes.driverLock],
    [paths.collectorLock, incident.hashes.collectorLock],
    [paths.pacingState, incident.hashes.pacingState]
  ];
  for (const [filePath, expectedHash] of checks) {
    if (await hashFile(filePath) !== expectedHash) {
      throw new Error(`Exact incident rollback was not proven: ${filePath}`);
    }
  }
  await assertMissing(paths.controllerArchive);
}

async function readExactRegularFile(filePath, expectedHash) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Incident path is not a regular non-symlink file: ${filePath}`);
  }
  const bytes = await readFile(filePath);
  if (sha256(bytes) !== expectedHash) throw new Error(`Incident hash mismatch: ${filePath}`);
  return Object.freeze({ bytes, mode: stat.mode & 0o777 });
}

async function atomicWrite(filePath, bytes, mode) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", mode);
  let completed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, filePath);
    completed = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!completed) await unlink(temporaryPath).catch(() => undefined);
  }
}

async function assertMissing(filePath) {
  try {
    await access(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Recovery requires this exact path to be absent: ${filePath}`);
}

function validateIncidentContract(incident, paths) {
  if (
    !plainObject(incident) ||
    !plainObject(incident.hashes) ||
    !Array.isArray(incident.selectedKeys) ||
    incident.selectedKeys.length !== 5 ||
    !Array.isArray(incident.falseTargets) ||
    incident.falseTargets.length !== 3 ||
    !path.isAbsolute(incident.replayRoot) ||
    !path.isAbsolute(incident.hostTempRoot) ||
    paths.replayRoot !== incident.replayRoot ||
    !Number.isSafeInteger(incident.collectorPid) ||
    !Number.isSafeInteger(incident.driverPid) ||
    !Number.isSafeInteger(incident.minimumCooldownMs) ||
    incident.minimumCooldownMs < 30_000
  ) {
    throw new Error("Sealed incident recovery contract is malformed.");
  }
  const expectedPaths = incidentPaths(incident);
  for (const [key, expectedPath] of Object.entries(expectedPaths)) {
    if (paths[key] !== expectedPath) {
      throw new Error(`Recovery path ${key} is not bound to the sealed incident root.`);
    }
  }
  for (const value of Object.values(incident.hashes)) {
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Sealed incident hash is malformed.");
  }
}

function incidentUsage() {
  const confirmations = Object.entries(REQUIRED_APPLY_CONFIRMATIONS)
    .map(([key, value]) => `  --${key}=${value}`)
    .join(" \\\n");
  return [
    "Usage:",
    "  node ops-oneoff/recover-cancelled-s26-linkedin-run001.mjs",
    "  node ops-oneoff/recover-cancelled-s26-linkedin-run001.mjs --apply \\",
    confirmations,
    "",
    "No arguments performs a read-only dry run. --apply requires every sealed confirmation.",
    "This command changes only exact local incident files and never reads or writes Supabase."
  ].join("\n");
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Incident ${label} is not valid JSON.`);
  }
}

function jsonBytes(value, pretty = false) {
  return Buffer.from(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashFile(filePath) {
  return sha256(await readFile(filePath));
}

async function hashFileOrNull(filePath) {
  try {
    return await hashFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameStrings(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defaultProcessExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function main() {
  const options = parseCancelledS26Run001RecoveryArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${incidentUsage()}\n`);
    return;
  }
  const result = await recoverCancelledS26Run001LocalState({ apply: options.apply });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Cancelled S26 run001 local recovery failed closed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
