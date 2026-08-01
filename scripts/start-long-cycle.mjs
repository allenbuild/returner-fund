import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  acquireClaimTransition,
  processStartFingerprint
} from "./long-cycle-claim-lease.mjs";

const root = process.cwd();
const runDir = path.join(root, "outputs", "longrun");
const activePath = path.join(runDir, "active-run.json");
const claimPath = path.join(runDir, ".launcher-claim");
const explicitMinutesPresent = hasNumberArg("--minutes");
const configuredMinutes = numberArg("--minutes") ?? 300;
const explicitMinutes = numberArg("--minutes");
const requestedMinutes = positiveNumber(configuredMinutes) ?? 300;
const checkpointMinutes = positiveNumber(numberArg("--checkpoint-minutes")) ?? 5;
const once = process.argv.includes("--once");
const smoke = process.argv.includes("--smoke");
const requestedMode = smoke ? "smoke" : once ? "once" : "continuous";
const explicitMinimumSweepMinutesPresent = hasNumberArg("--minimum-sweep-minutes");
const explicitMinimumSweepMinutes = numberArg("--minimum-sweep-minutes");
const configuredMinimumSweepMinutes = numberArg("--minimum-sweep-minutes") ?? 45;
const requestedMinimumSweepMinutes = explicitMinimumSweepMinutes === null
  ? compatibleDefaultReserve(requestedMinutes)
  : positiveNumber(configuredMinimumSweepMinutes) ?? compatibleDefaultReserve(requestedMinutes);
const childAcknowledgementTimeoutMs = 45_000;
const terminalStatuses = new Set([
  "complete",
  "smoke_complete",
  "deadline_complete",
  "failed",
  "interrupted"
]);
const nonResumableStatuses = new Set([
  "complete",
  "smoke_complete",
  "deadline_complete",
  "interrupted"
]);

const configurationError = launcherConfigurationError();
if (configurationError) {
  process.stderr.write(`Long-run launch refused: ${configurationError}\n`);
  process.exitCode = 2;
} else {
  await mkdir(runDir, { recursive: true });

  const launchToken = randomUUID();
  const claim = await acquireLauncherClaim(launchToken);
  if (!claim.acquired) {
    console.log(JSON.stringify({
      status: claim.status,
      pid: claim.pid ?? null,
      runId: claim.runId ?? null,
      activePath,
      claimPath
    }, null, 2));
  } else {
    try {
      await launchWithClaim(launchToken);
    } catch (error) {
      process.stderr.write(`Long-run launch failed: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    } finally {
      await releaseLauncherClaim(launchToken).catch((error) => {
        process.stderr.write(`Could not release long-run launcher claim: ${errorMessage(error)}\n`);
        process.exitCode = 1;
      });
    }
  }
}

async function launchWithClaim(token) {
  const forcedRunId = process.env.LONG_RUN_ID ?? null;
  await recoverTerminalRunLogsFromStdout();
  let existing = await reconcileActiveFromLatestRunLog(
    await readJson(activePath, null)
  );
  if (existing?.runId && !isSafeRunId(existing.runId)) {
    throw new Error(`Active run has unsafe runId ${JSON.stringify(existing.runId)}.`);
  }
  let existingEventLogPath = existing?.runId ? resolveEventLogPath(existing) : null;
  let existingRunLog = existingEventLogPath
    ? await readJson(existingEventLogPath, null)
    : null;
  if (existingEventLogPath && existsSync(existingEventLogPath)) {
    if (!existingRunLog || existingRunLog.runId !== existing.runId) {
      throw new Error(
        `Event log identity mismatch for active run ${JSON.stringify(existing.runId)}.`
      );
    }
  }
  let finishedEvent = latestEvent(existingRunLog?.eventLog, "run_finished");
  let persistedFailureEvent =
    latestEvent(existingRunLog?.eventLog, "run_failed")
    ?? latestEvent(existingRunLog?.eventLog, "sweep_failed");

  if (
    existing?.pid
    && !finishedEvent
    && !terminalStatuses.has(existing?.status)
    && isLeaseProcessRunning(
      existing.pid,
      existing?.processFingerprint,
      existing?.leaseVersion
    )
  ) {
    console.log(JSON.stringify({
      status: finishedEvent || terminalStatuses.has(existing.status)
        ? "run_finishing"
        : "already_running",
      pid: existing.pid,
      runId: existing.runId,
      activePath
    }, null, 2));
    return;
  }

  if (forcedRunId && forcedRunId !== existing?.runId) {
    const forcedEventLogPath = resolveEventLogPath({ runId: forcedRunId });
    const forcedRunLog = await readJson(forcedEventLogPath, null);
    if (forcedRunLog && forcedRunLog.runId !== forcedRunId) {
      throw new Error(
        `Event log identity mismatch for forced run ${JSON.stringify(forcedRunId)}.`
      );
    }
    existingRunLog = forcedRunLog;
    existingEventLogPath = forcedEventLogPath;
    existing = forcedRunLog
      ? {
          runId: forcedRunId,
          startedAt: forcedRunLog.startedAt,
          deadlineAt: forcedRunLog.deadlineAt,
          durationMinutes: forcedRunLog.durationMinutes,
          minimumSweepMinutes: forcedRunLog.minimumSweepMinutes,
          eventLogPath: forcedEventLogPath,
          status: latestEvent(forcedRunLog.eventLog, "run_finished")?.status ?? "stale"
        }
      : null;
    finishedEvent = latestEvent(forcedRunLog?.eventLog, "run_finished");
    persistedFailureEvent =
      latestEvent(forcedRunLog?.eventLog, "run_failed")
      ?? latestEvent(forcedRunLog?.eventLog, "sweep_failed");
    if (finishedEvent) {
      console.log(JSON.stringify({
        status: "already_finished",
        runId: forcedRunId,
        finalStatus: finishedEvent.status,
        activePath
      }, null, 2));
      return;
    }
  }

  if (
    !finishedEvent
    && existing?.runId
    && (persistedFailureEvent || existing.status === "failed")
  ) {
    const repairedAt = new Date().toISOString();
    const repairedEvents = Array.isArray(existingRunLog?.eventLog)
      ? [...existingRunLog.eventLog]
      : [];
    const failureMessage = persistedFailureMessage(persistedFailureEvent, existing);
    if (!latestEvent(repairedEvents, "run_failed")) {
      repairedEvents.push({
        type: "run_failed",
        at: repairedAt,
        elapsedMinutes: elapsedSince(existingRunLog?.startedAt ?? existing.startedAt),
        error: failureMessage,
        repairedByLauncher: true
      });
    }
    repairedEvents.push({
      type: "run_finished",
      at: repairedAt,
      elapsedMinutes: elapsedSince(existingRunLog?.startedAt ?? existing.startedAt),
      status: "failed",
      error: failureMessage,
      repairedByLauncher: true
    });
    existingRunLog = {
      ...(existingRunLog ?? {}),
      runId: existing.runId,
      startedAt: existingRunLog?.startedAt ?? existing.startedAt,
      deadlineAt: existingRunLog?.deadlineAt ?? existing.deadlineAt,
      durationMinutes: existingRunLog?.durationMinutes ?? existing.durationMinutes,
      minimumSweepMinutes:
        existingRunLog?.minimumSweepMinutes ?? existing.minimumSweepMinutes,
      eventLog: repairedEvents
    };
    await writeJsonAtomic(existingEventLogPath, existingRunLog);
    finishedEvent = latestEvent(repairedEvents, "run_finished");
    persistedFailureEvent =
      latestEvent(repairedEvents, "run_failed")
      ?? latestEvent(repairedEvents, "sweep_failed");
  }

  if (finishedEvent && existing) {
    existing = {
      ...existing,
      terminalPid: existing.pid ?? existing.terminalPid ?? null,
      pid: null,
      status: finishedEvent.status,
      reconciledAt: new Date().toISOString()
    };
    await writeJsonAtomic(activePath, existing);
  }

  if (finishedEvent && forcedRunId && forcedRunId === existing?.runId) {
    console.log(JSON.stringify({
      status: "already_finished",
      runId: existing.runId,
      finalStatus: finishedEvent.status,
      activePath
    }, null, 2));
    return;
  }

  const durableResumeMetadata = existingRunLog?.runId === existing?.runId
    ? existingRunLog
    : existing;
  const durableStartedAtMs = validDateMs(durableResumeMetadata?.startedAt);
  const durableDeadlineMs = validDateMs(durableResumeMetadata?.deadlineAt);
  const persistedFailure =
    existing?.status === "failed"
    || Boolean(persistedFailureEvent);
  const persistedMode = persistedRunMode(durableResumeMetadata, existing);
  const canResume = Boolean(
    existing?.runId
    && Number.isFinite(durableStartedAtMs)
    && !finishedEvent
    && !persistedFailure
    && !nonResumableStatuses.has(existing?.status)
    && persistedMode === requestedMode
  );
  const recoveryFromFailure = Boolean(
    persistedFailure
    ||
    finishedEvent?.status === "failed"
    || (terminalStatuses.has(existing?.status) && existing?.status === "failed")
  );
  const persistedDurationMinutes =
    positiveNumber(durableResumeMetadata?.durationMinutes)
    ?? positiveNumber(existing?.durationMinutes);
  const baseDurationMinutes = canResume
    ? persistedDurationMinutes ?? requestedMinutes
    : recoveryFromFailure && !explicitMinutesPresent
      ? persistedDurationMinutes ?? requestedMinutes
      : requestedMinutes;
  if (
    explicitMinimumSweepMinutesPresent
    && explicitMinimumSweepMinutes >= baseDurationMinutes
  ) {
    throw new Error(
      "--minimum-sweep-minutes must be less than the effective resumed run duration."
    );
  }
  const persistedMinimumSweepMinutes =
    positiveNumber(durableResumeMetadata?.minimumSweepMinutes)
    ?? positiveNumber(existing?.minimumSweepMinutes);
  const baseMinimumSweepMinutes = explicitMinimumSweepMinutes !== null
    ? requestedMinimumSweepMinutes
    : persistedMinimumSweepMinutes ?? compatibleDefaultReserve(baseDurationMinutes);
  if (baseMinimumSweepMinutes >= baseDurationMinutes) {
    throw new Error(
      "The effective --minimum-sweep-minutes must be less than the effective run duration."
    );
  }
  const startedAt = canResume
    ? durableResumeMetadata.startedAt
    : recoveryFromFailure
      ? new Date().toISOString()
      : process.env.LONG_RUN_START_AT ?? new Date().toISOString();
  const startedAtMs = validDateMs(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    throw new Error(`Cannot launch long run with invalid start time ${JSON.stringify(startedAt)}.`);
  }
  const durationMinutes = baseDurationMinutes;
  const minimumSweepMinutes = baseMinimumSweepMinutes;
  const deadlineAt = canResume && Number.isFinite(durableDeadlineMs)
    ? durableResumeMetadata.deadlineAt
    : new Date(startedAtMs + durationMinutes * 60_000).toISOString();
  const runId = canResume
    ? existing.runId
    : forcedRunId && forcedRunId !== existing?.runId
      ? forcedRunId
      : `source-sweep-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const stdoutPath = resolveRunOutputPath(
    canResume ? existing?.stdoutPath : null,
    runId,
    "stdout"
  );
  const stderrPath = resolveRunOutputPath(
    canResume ? existing?.stderrPath : null,
    runId,
    "stderr"
  );
  const args = [
    path.join("scripts", "run-long-cycle.mjs"),
    `--minutes=${durationMinutes}`,
    `--checkpoint-minutes=${checkpointMinutes}`,
    `--minimum-sweep-minutes=${minimumSweepMinutes}`,
    ...(smoke ? ["--smoke"] : once ? ["--once"] : [])
  ];
  const provisionalStatus = canResume ? "resuming" : "launching";
  const provisional = {
    ...(canResume ? existing : {}),
    runId,
    pid: null,
    leaseVersion: 2,
    processFingerprint: null,
    launcherPid: process.pid,
    launchToken: token,
    startedAt,
    deadlineAt,
    durationMinutes,
    minimumSweepMinutes,
    mode: requestedMode,
    launchedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    command: [process.execPath, ...args].join(" "),
    stdoutPath,
    stderrPath,
    statusPath: path.join(root, "docs", "LONG_RUN_STATUS.md"),
    eventLogPath: path.join(runDir, `${runId}.json`),
    status: provisionalStatus,
    ...(recoveryFromFailure
      ? {
          recoveryOfRunId: existing?.runId ?? null,
          recoveryOfEventLogPath: existing ? resolveEventLogPath(existing) : null
        }
      : {})
  };

  const stdoutFd = openSync(stdoutPath, "a");
  const stderrFd = openSync(stderrPath, "a");
  let child;
  await ensureAdmissionRunLog(provisional);
  await writeJsonAtomic(activePath, provisional);
  try {
    child = spawn(process.execPath, args, {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: {
        ...process.env,
        LONG_RUN_START_AT: startedAt,
        LONG_RUN_DEADLINE_AT: deadlineAt,
        LONG_RUN_ID: runId,
        LONG_RUN_LAUNCH_TOKEN: token
      }
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }

  const childExit = observeChildExit(child);
  child.unref();
  let acknowledged;
  try {
    acknowledged = await waitForChildAcknowledgement({
      child,
      childExit,
      runId,
      token
    });
  } catch (error) {
    await stopDetachedChild(child, childExit);
    await publishLaunchFailure({
      childPid: child.pid,
      error,
      runId,
      token
    });
    throw error;
  }

  console.log(JSON.stringify({
    status: canResume ? "resumed" : "started",
    runId,
    pid: acknowledged.pid,
    startedAt,
    deadlineAt,
    durationMinutes,
    minimumSweepMinutes,
    launchedAt: provisional.launchedAt,
    stdoutPath,
    stderrPath,
    activeStatus: acknowledged.status,
    activePath
  }, null, 2));
}

async function acquireLauncherClaim(token) {
  if (await installLauncherClaim(token)) return { acquired: true };

  while (true) {
    if (!existsSync(claimPath) && await installLauncherClaim(token)) {
      return { acquired: true };
    }
    const transition = await acquireClaimTransition(claimPath, {
      actorToken: token,
      role: "launcher-takeover"
    });
    try {
      const [owner, active] = await Promise.all([
        readJson(path.join(claimPath, "owner.json"), null),
        readJson(activePath, null)
      ]);
      const ownerKind = owner?.ownerKind ?? (owner?.childPid ? "runner" : "launcher");
      const ownerPid = owner?.ownerPid
        ?? (ownerKind === "runner" ? owner?.childPid : owner?.launcherPid);
      const ownerIsRunning = ownerPid && isLeaseProcessRunning(
        ownerPid,
        owner?.ownerFingerprint,
        owner?.version
      );
      if (ownerKind === "launcher" && ownerIsRunning) {
        return {
          acquired: false,
          status: "launch_in_progress",
          pid: ownerPid,
          runId: active?.runId ?? null
        };
      }
      const durableFinishedEvent = await finishedEventForActive(active);
      if (terminalStatuses.has(active?.status) || durableFinishedEvent) {
        await writeJsonAtomic(
          path.join(claimPath, "owner.json"),
          launcherClaimOwner(token, owner?.token ?? null)
        );
        return { acquired: true };
      }
      if (ownerIsRunning) {
        return {
          acquired: false,
          status: ownerKind === "runner" ? "already_running" : "launch_in_progress",
          pid: ownerPid,
          runId: active?.runId ?? null
        };
      }
      if (
        active?.pid
        && isLeaseProcessRunning(
          active.pid,
          active?.processFingerprint,
          active?.leaseVersion ?? owner?.version
        )
      ) {
        await writeJsonAtomic(path.join(claimPath, "owner.json"), {
          version: 2,
          token: active.launchToken ?? owner?.token ?? null,
          ownerKind: "runner",
          ownerPid: active.pid,
          ownerFingerprint: active.processFingerprint ?? null,
          childPid: active.pid,
          runId: active.runId ?? null,
          recoveredAt: new Date().toISOString()
        });
        return {
          acquired: false,
          status: "already_running",
          pid: active.pid,
          runId: active.runId ?? null
        };
      }

      await writeJsonAtomic(
        path.join(claimPath, "owner.json"),
        launcherClaimOwner(token, owner?.token ?? null)
      );
      return { acquired: true };
    } finally {
      await transition.release();
    }
  }
}

async function installLauncherClaim(token) {
  const candidatePath = `${claimPath}.candidate-${token}`;
  await rm(candidatePath, { recursive: true, force: true });
  await mkdir(candidatePath);
  await writeJsonAtomic(
    path.join(candidatePath, "owner.json"),
    launcherClaimOwner(token, null)
  );
  try {
    await rename(candidatePath, claimPath);
    return true;
  } catch (error) {
    await rm(candidatePath, { recursive: true, force: true });
    if (
      existsSync(claimPath)
      && ["EEXIST", "ENOTEMPTY", "EACCES", "EPERM"].includes(error?.code)
    ) {
      return false;
    }
    throw error;
  }
}

function launcherClaimOwner(token, supersededToken) {
  return {
    version: 2,
    token,
    ownerKind: "launcher",
    ownerPid: process.pid,
    ownerFingerprint: processStartFingerprint(),
    launcherPid: process.pid,
    childPid: null,
    createdAt: new Date().toISOString(),
    ...(supersededToken ? { supersededToken } : {})
  };
}

async function releaseLauncherClaim(token) {
  if (!existsSync(claimPath)) return false;
  const transition = await acquireClaimTransition(claimPath, {
    actorToken: token,
    role: "launcher-release"
  });
  try {
    const [owner, active] = await Promise.all([
      readJson(path.join(claimPath, "owner.json"), null),
      readJson(activePath, null)
    ]);
    if (owner?.token !== token) return false;

    const childPid = owner?.childPid ?? (
      active?.launchToken === token ? active?.pid : null
    );
    if (childPid && isProcessRunning(childPid)) return false;

    await writeJsonAtomic(path.join(claimPath, "owner.json"), {
      ...owner,
      ownerKind: "released",
      ownerPid: null,
      ownerFingerprint: null,
      launcherPid: null,
      childPid: null,
      releasedAt: new Date().toISOString()
    });
    return true;
  } finally {
    await transition.release();
  }
}

async function waitForChildAcknowledgement({ child, childExit, runId, token }) {
  const timeoutAt = Date.now() + childAcknowledgementTimeoutMs;
  let exitResult = null;
  void childExit.then((result) => {
    exitResult = result;
  });
  while (Date.now() < timeoutAt) {
    const active = await readJson(activePath, null);
    if (
      active?.runId === runId
      && active?.launchToken === token
      && Number(active?.pid) === Number(child.pid)
    ) {
      return active;
    }
    if (exitResult) {
      throw new Error(
        `Long-run child exited before acknowledging launch`
        + ` (code=${exitResult.code ?? "null"}, signal=${exitResult.signal ?? "none"}).`
      );
    }
    await delay(50);
  }
  throw new Error(
    `Long-run child ${child.pid ?? "unknown"} did not acknowledge launch within `
    + `${childAcknowledgementTimeoutMs}ms.`
  );
}

function observeChildExit(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", (error) => {
      finish({ code: 1, signal: null, error: errorMessage(error) });
    });
    child.once("exit", (code, signal) => {
      finish({ code, signal, error: null });
    });
  });
}

async function stopDetachedChild(child, childExit) {
  if (!child?.pid || !isProcessRunning(child.pid)) return;
  signalChildTree(child, "SIGTERM");
  const exited = await Promise.race([
    childExit.then(() => true),
    delay(5_000).then(() => false)
  ]);
  if (!exited && isProcessRunning(child.pid)) {
    signalChildTree(child, "SIGKILL");
    await Promise.race([childExit, delay(1_000)]);
  }
}

function signalChildTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.once("error", () => child.kill(signal));
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function publishLaunchFailure({ childPid, error, runId, token }) {
  const active = await readJson(activePath, null);
  if (
    active?.runId !== runId
    || active?.launchToken !== token
    || terminalStatuses.has(active?.status)
  ) {
    return;
  }
  const failedAt = new Date().toISOString();
  const eventLogPath = resolveEventLogPath(active);
  const runLog = await readJson(eventLogPath, null);
  if (!runLog || runLog.runId !== runId) {
    throw new Error(`Cannot finalize launch failure without the admitted run log for ${runId}.`);
  }
  const events = Array.isArray(runLog.eventLog) ? [...runLog.eventLog] : [];
  const message = errorMessage(error);
  if (!latestEvent(events, "run_failed")) {
    events.push({
      type: "run_failed",
      at: failedAt,
      elapsedMinutes: elapsedSince(runLog.startedAt ?? active.startedAt),
      error: message,
      failedBeforeAcknowledgement: true
    });
  }
  if (!latestEvent(events, "run_finished")) {
    events.push({
      type: "run_finished",
      at: failedAt,
      elapsedMinutes: elapsedSince(runLog.startedAt ?? active.startedAt),
      status: "failed",
      error: message,
      failedBeforeAcknowledgement: true
    });
  }
  await writeJsonAtomic(eventLogPath, {
    ...runLog,
    eventLog: events
  });
  await writeJsonAtomic(activePath, {
    ...active,
    pid: null,
    failedChildPid: childPid ?? null,
    launchFailedAt: failedAt,
    launchError: message,
    status: "failed"
  });
}

async function ensureAdmissionRunLog(provisional) {
  const eventLogPath = resolveEventLogPath(provisional);
  const existing = await readJson(eventLogPath, null);
  if (existing) {
    if (existing.runId !== provisional.runId) {
      throw new Error(
        `Event log identity mismatch for admitted run ${JSON.stringify(provisional.runId)}.`
      );
    }
    return;
  }
  await writeJsonAtomic(eventLogPath, {
    runId: provisional.runId,
    startedAt: provisional.startedAt,
    deadlineAt: provisional.deadlineAt,
    durationMinutes: provisional.durationMinutes,
    minimumSweepMinutes: provisional.minimumSweepMinutes,
    mode: provisional.mode,
    eventLog: [{
      type: "run_admitted",
      at: provisional.launchedAt,
      elapsedMinutes: elapsedSince(provisional.startedAt),
      launcherPid: process.pid,
      launchToken: provisional.launchToken
    }]
  });
}

async function reconcileActiveFromLatestRunLog(active) {
  const latest = await latestRunLog();
  if (!latest) return active;
  const activeStartedAt = validDateMs(active?.startedAt);
  const latestStartedAt = validDateMs(latest.runLog.startedAt);
  if (
    active?.runId === latest.runLog.runId
    || !Number.isFinite(latestStartedAt)
    || (Number.isFinite(activeStartedAt) && latestStartedAt <= activeStartedAt)
  ) {
    return active;
  }
  const finished = latestEvent(latest.runLog.eventLog, "run_finished");
  const reconciled = {
    runId: latest.runLog.runId,
    pid: null,
    terminalPid: null,
    processFingerprint: null,
    startedAt: latest.runLog.startedAt,
    deadlineAt: latest.runLog.deadlineAt,
    durationMinutes: latest.runLog.durationMinutes,
    minimumSweepMinutes: latest.runLog.minimumSweepMinutes,
    mode: persistedRunMode(latest.runLog),
    launchedAt: latest.runLog.eventLog?.[0]?.at ?? latest.runLog.startedAt,
    lastHeartbeatAt: latest.runLog.eventLog?.at(-1)?.at ?? latest.runLog.startedAt,
    eventLogPath: latest.path,
    status: finished?.status ?? "stale",
    reconciledAt: new Date().toISOString(),
    reconciledFromEventLog: true
  };
  await writeJsonAtomic(activePath, reconciled);
  return reconciled;
}

async function latestRunLog() {
  let entries;
  try {
    entries = await readdir(runDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = await Promise.all(
    entries
      .filter((entry) =>
        entry.isFile()
        && /^source-sweep-[A-Za-z0-9._-]+\.json$/u.test(entry.name)
      )
      .map(async (entry) => {
        const filePath = path.join(runDir, entry.name);
        const [details, runLog] = await Promise.all([
          stat(filePath),
          readJson(filePath, null)
        ]);
        return runLog?.runId && Array.isArray(runLog.eventLog)
          ? { path: filePath, stat: details, runLog }
          : null;
      })
  );
  return candidates
    .filter(Boolean)
    .sort((left, right) => {
      const startedDelta =
        (validDateMs(right.runLog.startedAt) ?? 0)
        - (validDateMs(left.runLog.startedAt) ?? 0);
      return startedDelta || right.stat.mtimeMs - left.stat.mtimeMs;
    })[0] ?? null;
}

async function recoverTerminalRunLogsFromStdout() {
  let entries;
  try {
    entries = await readdir(runDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      !entry.isFile()
      || !/^source-sweep-[A-Za-z0-9._-]+\.stdout\.log$/u.test(entry.name)
    ) {
      continue;
    }
    const stdoutPath = path.join(runDir, entry.name);
    const runId = entry.name.slice(0, -".stdout.log".length);
    const eventLogPath = path.join(runDir, `${runId}.json`);
    if (existsSync(eventLogPath)) continue;
    const [stdout, details] = await Promise.all([
      readFile(stdoutPath, "utf8"),
      stat(stdoutPath)
    ]);
    const terminal = parseTerminalRunSummary(stdout);
    if (
      terminal?.runId !== runId
      || !terminalStatuses.has(terminal.status)
    ) {
      continue;
    }
    const elapsed = positiveNumber(terminal.elapsedMinutes) ?? requestedMinutes;
    const finishedAt = details.mtime.toISOString();
    const startedAt = new Date(
      Math.max(0, details.mtimeMs - elapsed * 60_000)
    ).toISOString();
    await writeJsonAtomic(eventLogPath, {
      runId,
      startedAt,
      deadlineAt: finishedAt,
      durationMinutes: elapsed,
      minimumSweepMinutes: compatibleDefaultReserve(elapsed),
      mode: "continuous",
      recoveredFromStdout: true,
      eventLog: [
        {
          type: "run_recovered_from_stdout",
          at: finishedAt,
          elapsedMinutes: elapsed,
          stdoutPath
        },
        {
          type: "run_finished",
          at: finishedAt,
          elapsedMinutes: elapsed,
          status: terminal.status,
          recoveredFromStdout: true
        }
      ]
    });
  }
}

function parseTerminalRunSummary(stdout) {
  const tail = String(stdout).slice(-64_000).trim();
  for (
    let index = tail.lastIndexOf("\n{");
    index >= -1;
    index = index > 0 ? tail.lastIndexOf("\n{", index - 1) : -2
  ) {
    const candidate = tail.slice(index + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (
        isSafeRunId(parsed?.runId)
        && terminalStatuses.has(parsed?.status)
        && Number.isFinite(Number(parsed?.elapsedMinutes))
      ) {
        return parsed;
      }
    } catch {
      // Continue to the previous JSON object in the captured tail.
    }
    if (index === -1) break;
  }
  return null;
}

function latestEvent(events, type) {
  if (!Array.isArray(events)) return null;
  return [...events].reverse().find((event) => event?.type === type) ?? null;
}

async function finishedEventForActive(active) {
  if (!active?.runId) return null;
  const eventLog = await readJson(resolveEventLogPath(active), null);
  if (eventLog && eventLog.runId !== active.runId) {
    throw new Error(
      `Event log identity mismatch for active run ${JSON.stringify(active.runId)}.`
    );
  }
  return latestEvent(eventLog?.eventLog, "run_finished");
}

function isLeaseProcessRunning(pid, expectedFingerprint, leaseVersion) {
  if (!isProcessRunning(pid)) return false;
  if (Number(leaseVersion) < 2 || !expectedFingerprint) return true;
  const currentFingerprint = processStartFingerprint(pid);
  if (!currentFingerprint) return true;
  return currentFingerprint === expectedFingerprint;
}

function resolveEventLogPath(active) {
  if (!isSafeRunId(active?.runId)) {
    throw new Error(`Cannot resolve event log for unsafe runId ${JSON.stringify(active?.runId)}.`);
  }
  const expectedPath = path.join(runDir, `${active.runId}.json`);
  if (active?.eventLogPath) {
    const configuredPath = path.isAbsolute(active.eventLogPath)
      ? active.eventLogPath
      : path.resolve(root, active.eventLogPath);
    if (canonicalFilePath(configuredPath) !== canonicalFilePath(expectedPath)) {
      throw new Error(
        `Active eventLogPath must resolve to ${expectedPath}; received ${configuredPath}.`
      );
    }
  }
  return expectedPath;
}

function canonicalFilePath(filePath) {
  const resolved = path.resolve(filePath);
  if (existsSync(resolved)) return realpathSync(resolved);
  const parent = path.dirname(resolved);
  return path.join(existsSync(parent) ? realpathSync(parent) : parent, path.basename(resolved));
}

function resolveRunOutputPath(configuredPath, runId, stream) {
  if (!["stdout", "stderr"].includes(stream)) {
    throw new Error(`Unsupported long-run output stream ${JSON.stringify(stream)}.`);
  }
  if (!isSafeRunId(runId)) {
    throw new Error(`Cannot resolve output path for unsafe runId ${JSON.stringify(runId)}.`);
  }
  const expectedPath = path.join(runDir, `${runId}.${stream}.log`);
  if (configuredPath) {
    const resolvedConfiguredPath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(root, configuredPath);
    if (canonicalFilePath(resolvedConfiguredPath) !== canonicalFilePath(expectedPath)) {
      throw new Error(
        `Active ${stream}Path must resolve to ${expectedPath}; received ${resolvedConfiguredPath}.`
      );
    }
  }
  if (existsSync(expectedPath)) {
    const canonicalRunDir = realpathSync(runDir);
    const canonicalOutputPath = realpathSync(expectedPath);
    if (path.dirname(canonicalOutputPath) !== canonicalRunDir) {
      throw new Error(
        `Long-run ${stream} output must remain inside ${canonicalRunDir};`
        + ` received ${canonicalOutputPath}.`
      );
    }
  }
  return expectedPath;
}

function compatibleDefaultReserve(durationMinutes) {
  return Math.max(1 / 60_000, Math.min(45, durationMinutes / 2));
}

function launcherConfigurationError() {
  if (process.env.LONG_RUN_ID && !isSafeRunId(process.env.LONG_RUN_ID)) {
    return "LONG_RUN_ID contains unsupported characters.";
  }
  if (
    process.env.LONG_RUN_START_AT !== undefined
    && validDateMs(process.env.LONG_RUN_START_AT) === null
  ) {
    return "LONG_RUN_START_AT must be a valid timestamp.";
  }
  if (explicitMinutesPresent && !positiveNumber(explicitMinutes)) {
    return "--minutes must be a finite number greater than zero.";
  }
  if (
    explicitMinimumSweepMinutesPresent
    && (
      !positiveNumber(explicitMinimumSweepMinutes)
      || explicitMinimumSweepMinutes >= requestedMinutes
    )
  ) {
    return "--minimum-sweep-minutes must be greater than zero and less than --minutes.";
  }
  return null;
}

function persistedFailureMessage(event, active) {
  if (event?.type === "run_failed") {
    return event.error ?? active?.launchError ?? "The persisted run failed.";
  }
  if (event?.type === "sweep_failed") {
    const cycle = event.cycleIndex ?? "unknown";
    const attempt = event.attempt ?? "unknown";
    return `Autonomous sweep ${cycle} attempt ${attempt} failed.`;
  }
  return active?.launchError ?? "The persisted run failed.";
}

function persistedRunMode(...metadataCandidates) {
  for (const metadata of metadataCandidates) {
    if (["continuous", "once", "smoke"].includes(metadata?.mode)) {
      return metadata.mode;
    }
  }
  for (const metadata of metadataCandidates) {
    const events = Array.isArray(metadata?.eventLog) ? metadata.eventLog : [];
    const lifecycleEvent = events.find(
      (event) => event?.type === "run_started" || event?.type === "run_resumed"
    );
    if (["continuous", "once", "smoke"].includes(lifecycleEvent?.mode)) {
      return lifecycleEvent.mode;
    }
    if (lifecycleEvent?.smoke === true) return "smoke";
  }
  for (const metadata of metadataCandidates) {
    const command = typeof metadata?.command === "string" ? metadata.command : "";
    if (/(?:^|\s)--smoke(?:\s|$)/u.test(command)) return "smoke";
    if (/(?:^|\s)--once(?:\s|$)/u.test(command)) return "once";
  }
  return "continuous";
}

function elapsedSince(value) {
  const startedAtMs = validDateMs(value);
  return Number.isFinite(startedAtMs)
    ? Math.max(0, (Date.now() - startedAtMs) / 60_000)
    : 0;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isSafeRunId(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)
    && value !== "."
    && value !== "..";
}

function hasNumberArg(name) {
  return process.argv.some((arg) => arg.startsWith(`${name}=`));
}

function numberArg(name) {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function validDateMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(value).valueOf();
  return Number.isFinite(parsed) ? parsed : null;
}

function isProcessRunning(pid) {
  const parsedPid = Number(pid);
  if (!Number.isInteger(parsedPid) || parsedPid <= 0) return false;
  try {
    process.kill(parsedPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

async function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporaryPath, filePath);
}
