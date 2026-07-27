import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  acquireClaimTransition,
  processStartFingerprint
} from "./long-cycle-claim-lease.mjs";

const root = process.cwd();
const runDir = path.join(root, "outputs", "longrun");
const activePath = path.join(runDir, "active-run.json");
const claimPath = path.join(runDir, ".launcher-claim");
const runId = process.env.LONG_RUN_ID ?? `source-sweep-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const eventLogPath = path.join(runDir, `${runId}.json`);
const requestedStartedAt = process.env.LONG_RUN_START_AT ?? null;
const requestedDeadlineAt = process.env.LONG_RUN_DEADLINE_AT ?? null;
const requestedDurationRaw = argValue("--minutes");
const requestedDurationMinutes = requestedDurationRaw === null ? null : Number(requestedDurationRaw);
const requestedMinimumSweepRaw = argValue("--minimum-sweep-minutes");
const requestedMinimumSweepMinutes = requestedMinimumSweepRaw === null
  ? null
  : Number(requestedMinimumSweepRaw);
const checkpointMinutes = numberArg("--checkpoint-minutes") ?? 5;
const smoke = hasArg("--smoke");
const onceRequested = hasArg("--once");
const once = onceRequested || smoke;
const runMode = smoke ? "smoke" : onceRequested ? "once" : "continuous";
const directLeaseBypass = process.env.LONG_RUN_ALLOW_DIRECT === "1";
const checkpointEveryMs = Math.max(1, checkpointMinutes) * 60_000;
const autonomousRunnerPath = path.join("scripts", "run-autonomous-ingestion.mjs");
const launchToken = process.env.LONG_RUN_LAUNCH_TOKEN ?? null;
let nextCheckpointAtMs = Date.now();
let activeChild = null;
let finishing = false;
let finalizePromise = null;
let eventWriteQueue = Promise.resolve();
let activeStateWriteQueue = Promise.resolve();
let interruptedSignal = null;
const escalationTimers = new Map();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!interruptedSignal) interruptedSignal = signal;
    if (activeChild) terminateChildTree(activeChild);
  });
}

if (!isSafeRunId(runId)) {
  failConfiguration(`LONG_RUN_ID contains unsupported characters: ${JSON.stringify(runId)}.`);
}
if (requestedStartedAt !== null && validDateMs(requestedStartedAt) === null) {
  failConfiguration(`LONG_RUN_START_AT must be a valid timestamp; received ${requestedStartedAt}.`);
}
if (requestedDeadlineAt !== null && validDateMs(requestedDeadlineAt) === null) {
  failConfiguration(
    `LONG_RUN_DEADLINE_AT must be a valid timestamp; received ${requestedDeadlineAt}.`
  );
}
if (
  requestedDurationRaw !== null
  && (!Number.isFinite(requestedDurationMinutes) || requestedDurationMinutes <= 0)
) {
  failConfiguration(`--minutes must be greater than zero; received ${requestedDurationRaw}.`);
}
if (
  requestedMinimumSweepRaw !== null
  && (!Number.isFinite(requestedMinimumSweepMinutes) || requestedMinimumSweepMinutes <= 0)
) {
  failConfiguration(
    `--minimum-sweep-minutes must be greater than zero; received ${requestedMinimumSweepRaw}.`
  );
}
if (!launchToken && !directLeaseBypass) {
  const routed = spawnSync(
    process.execPath,
    [path.join("scripts", "start-long-cycle.mjs"), ...process.argv.slice(2)],
    {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    }
  );
  if (routed.error) {
    process.stderr.write(`Could not route direct long run through launcher: ${routed.error.message}\n`);
  }
  process.exit(routed.status ?? 1);
}

await mkdir(runDir, { recursive: true });
if (launchToken && !await claimLaunchState()) {
  process.stderr.write(`Refusing stale launcher token for ${runId}.\n`);
  process.exit(75);
}

const resumeLog = await readJson(eventLogPath, null);
const matchingResumeLog = resumeLog?.runId === runId ? resumeLog : null;
const resumeMode = persistedRunMode(matchingResumeLog);
if (
  resumeMode
  &&
  Array.isArray(matchingResumeLog?.eventLog)
  && matchingResumeLog.eventLog.length > 0
  && resumeMode !== runMode
) {
  failConfiguration(
    `Persisted run mode ${JSON.stringify(resumeMode)} does not match requested mode `
    + `${JSON.stringify(runMode)}.`
  );
}
const startedAt = requestedStartedAt
  ?? validIsoDate(matchingResumeLog?.startedAt)
  ?? new Date().toISOString();
const durationMinutes = requestedDurationMinutes
  ?? finitePositive(matchingResumeLog?.durationMinutes)
  ?? 300;
if (
  requestedMinimumSweepMinutes !== null
  && requestedMinimumSweepMinutes >= durationMinutes
) {
  failConfiguration(
    `--minimum-sweep-minutes must be less than --minutes (${formatMinutes(durationMinutes)}); received ${requestedMinimumSweepRaw}.`
  );
}
const persistedMinimumSweepMinutes = Number(matchingResumeLog?.minimumSweepMinutes);
const defaultMinimumSweepMinutes = Math.min(
  45,
  Math.max(1 / 60_000, durationMinutes / 2)
);
const minimumSweepMinutes = Math.max(
  1 / 60_000,
  requestedMinimumSweepMinutes
    ?? (Number.isFinite(persistedMinimumSweepMinutes) && persistedMinimumSweepMinutes > 0
      ? persistedMinimumSweepMinutes
      : null)
    ?? defaultMinimumSweepMinutes
);
if (minimumSweepMinutes >= durationMinutes) {
  failConfiguration(
    `The effective minimum sweep reserve (${formatMinutes(minimumSweepMinutes)}) must be less than the effective run duration (${formatMinutes(durationMinutes)}).`
  );
}
const startedAtMs = validDateMs(startedAt) ?? Date.now();
const deadlineAt = requestedDeadlineAt
  ?? validIsoDate(matchingResumeLog?.deadlineAt)
  ?? new Date(startedAtMs + durationMinutes * 60_000).toISOString();
const stopAtMs = validDateMs(deadlineAt);
const minimumSweepReserveMs = minimumSweepMinutes * 60_000;
const eventLog = matchingResumeLog && Array.isArray(matchingResumeLog.eventLog)
  ? matchingResumeLog.eventLog
  : [];
const priorFinishedEvent = [...eventLog].reverse().find((event) => event.type === "run_finished");
if (priorFinishedEvent) {
  console.log(JSON.stringify({
    runId,
    status: "already_finished",
    finalStatus: priorFinishedEvent.status,
    eventLog: eventLogPath
  }, null, 2));
  process.exit(0);
}
const persistedFailure = [...eventLog].reverse().find(
  (event) => event.type === "run_failed" || event.type === "sweep_failed"
);

await recordEvent(eventLog.length ? "run_resumed" : "run_started", {
  runId,
  startedAt,
  deadlineAt,
  durationMinutes,
  checkpointMinutes,
  minimumSweepMinutes,
  mode: runMode,
  scope: {
    batches: ["S2026", "S26", "A16ZSR006"],
    entities: ["companies", "founders"],
    platforms: "all supported autonomous platforms",
    priority: "lowest evidence coverage first"
  },
  smoke
});
await writeActiveState(eventLog.length > 1 ? "resuming" : "running");

const heartbeatTimer = setInterval(() => {
  void checkpointIfDue(false).catch((error) => {
    process.stderr.write(`Long-run heartbeat failed: ${errorMessage(error)}\n`);
  });
}, 30_000);
heartbeatTimer.unref?.();

try {
  if (persistedFailure) {
    const message = persistedFailure.type === "run_failed"
      ? persistedFailure.error ?? "The persisted run had already failed."
      : `Autonomous sweep ${persistedFailure.cycleIndex} attempt ${persistedFailure.attempt} had already failed.`;
    const error = new Error(message);
    error.name = "PersistedLongRunFailureError";
    throw error;
  }
  throwIfInterrupted();
  if (smoke) {
    const smokeKey = `${runId}-smoke-plan`;
    const smokeCapMs = Date.now() + 120_000;
    const smokeDeadlineMs = Math.min(stopAtMs, smokeCapMs);
    const smokeTimeoutMessage = smokeDeadlineMs === smokeCapMs
      ? "Stopped smoke plan because its 120-second smoke-plan timeout elapsed.\n"
      : `Stopped smoke plan because the ${formatMinutes(durationMinutes)}-minute source-sweep window elapsed.\n`;
    const result = await runCommand([
      autonomousRunnerPath,
      "--plan",
      "--skip-publish",
      `--idempotency-key=${smokeKey}`
    ], {
      deadlineMs: smokeDeadlineMs,
      deadlineMessage: smokeTimeoutMessage
    });
    throwIfInterrupted();
    if (result.exitCode !== 0) {
      throw new Error(`Autonomous all-batch plan smoke failed: ${result.stderrTail}`);
    }
    assertAllBatchPlan(result.stdoutTail);
    await recordEvent("smoke_passed", {
      idempotencyKey: smokeKey,
      batches: ["S2026", "S26", "A16ZSR006"]
    });
  } else {
    let admittedSweep = unfinishedAdmittedSweep(eventLog);
    let cycleIndex = admittedSweep?.cycleIndex ?? resumableCycleIndex(eventLog);
    let attempt = nextAttemptForCycle(eventLog, cycleIndex);
    let completionStatus = "complete";
    while (true) {
      throwIfInterrupted();
      const remainingMs = stopAtMs - Date.now();
      const resumingAdmittedSweep = admittedSweep?.cycleIndex === cycleIndex;
      if (!resumingAdmittedSweep && remainingMs <= minimumSweepReserveMs) {
        completionStatus = "deadline_complete";
        await recordEvent("sweep_skipped_insufficient_time", {
          cycleIndex,
          attempt,
          reason: `Not starting another sweep because the ${formatMinutes(durationMinutes)}-minute source-sweep window does not have the configured useful-time reserve remaining.`,
          remainingMilliseconds: Math.max(0, remainingMs),
          minimumSweepReserveMilliseconds: minimumSweepReserveMs,
          minimumSweepMinutes,
          deadlineAt
        });
        break;
      }
      const idempotencyKey = admittedSweep?.idempotencyKey
        ?? `${runId}-sweep-${String(cycleIndex).padStart(3, "0")}`;
      await recordEvent("sweep_started", {
        cycleIndex,
        attempt,
        idempotencyKey,
        resumedAdmission: resumingAdmittedSweep
      });
      throwIfInterrupted();
      const result = await runCommand([
        autonomousRunnerPath,
        "--skip-publish",
        "--resume-snapshots",
        `--campaign-key=${runId}`,
        `--idempotency-key=${idempotencyKey}`
      ]);
      throwIfInterrupted();
      const eventType = result.exitCode === 0 ? "sweep_succeeded" : "sweep_failed";
      await recordEvent(eventType, {
        cycleIndex,
        attempt,
        idempotencyKey,
        exitCode: result.exitCode,
        terminationReason: result.terminationReason,
        stdoutTail: result.stdoutTail,
        stderrTail: result.stderrTail
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `Autonomous sweep ${cycleIndex} attempt ${attempt} failed with exit code ${result.exitCode}.`
        );
      }
      await checkpointIfDue(true);
      throwIfInterrupted();
      admittedSweep = null;
      cycleIndex += 1;
      attempt = 1;
      if (once) break;
    }
    throwIfInterrupted();
    await finalize(completionStatus);
  }
  if (smoke) {
    throwIfInterrupted();
    await finalize("smoke_complete");
  }
} catch (error) {
  const durableFailure = latestFailureEvent(eventLog);
  if (durableFailure) {
    const message = durableFailureMessage(durableFailure, error);
    if (!eventLog.some((event) => event.type === "run_failed")) {
      await recordEvent("run_failed", { error: message });
    }
    await finalize("failed", { error: message });
    process.stderr.write(`Long-run failed: ${message}\n`);
    process.exitCode = 1;
  } else if (isInterruption(error)) {
    const signal = interruptedSignal ?? error.signal;
    await finalize("interrupted", { signal });
    process.exitCode = signalExitCode(signal);
  } else {
    const message = errorMessage(error);
    if (!eventLog.some((event) => event.type === "run_failed")) {
      await recordEvent("run_failed", { error: message });
    }
    await finalize("failed", { error: message });
    process.stderr.write(`Long-run failed: ${message}\n`);
    process.exitCode = 1;
  }
} finally {
  clearInterval(heartbeatTimer);
}

function runCommand(args, {
  deadlineMs = null,
  deadlineMessage = `Stopped command because the ${formatMinutes(durationMinutes)}-minute source-sweep window elapsed.\n`
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LONG_RUN_START_AT: startedAt,
        LONG_RUN_ID: runId
      }
    });
    activeChild = child;
    let stdoutTail = "";
    let stderrTail = "";
    let deadlineReached = false;
    let settled = false;
    const deadlineTimer = Number.isFinite(deadlineMs)
      ? setTimeout(() => {
        deadlineReached = true;
        stderrTail = appendTail(stderrTail, deadlineMessage);
        terminateChildTree(child);
      }, Math.max(0, deadlineMs - Date.now()))
      : null;
    child.stdout.on("data", (chunk) => {
      const value = chunk.toString();
      stdoutTail = appendTail(stdoutTail, value);
      process.stdout.write(value);
    });
    child.stderr.on("data", (chunk) => {
      const value = chunk.toString();
      stderrTail = appendTail(stderrTail, value);
      process.stderr.write(value);
    });
    const finish = (exitCode, terminationReason = deadlineReached ? "deadline" : "completed") => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      clearEscalationTimer(child);
      if (activeChild === child) activeChild = null;
      resolve({
        exitCode: deadlineReached ? 124 : exitCode ?? 1,
        terminationReason: deadlineReached ? "deadline" : terminationReason,
        stdoutTail,
        stderrTail
      });
    };
    child.once("close", (exitCode) => finish(exitCode));
    child.once("error", (error) => {
      stderrTail = appendTail(stderrTail, `${error.message}\n`);
      finish(1, "spawn_error");
    });
  });
}

function terminateChildTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.once("error", () => child.kill("SIGTERM"));
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  if (escalationTimers.has(child)) return;
  const hardKill = setTimeout(() => {
    escalationTimers.delete(child);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 5_000);
  escalationTimers.set(child, hardKill);
  hardKill.unref?.();
}

function clearEscalationTimer(child) {
  const timer = escalationTimers.get(child);
  if (!timer) return;
  clearTimeout(timer);
  escalationTimers.delete(child);
}

async function checkpointIfDue(force) {
  if (finishing) return;
  if (!force && Date.now() < nextCheckpointAtMs) {
    await writeActiveState("running");
    return;
  }
  nextCheckpointAtMs = Date.now() + checkpointEveryMs;
  await recordEvent("orchestrator_checkpoint", {
    elapsedMinutes: elapsedMinutes(),
    remainingMinutes: Math.max(0, Math.ceil((stopAtMs - Date.now()) / 60_000))
  });
  if (finishing) return;
  await writeActiveState("running");
}

function finalize(status, details = {}) {
  if (finalizePromise) return finalizePromise;
  finishing = true;
  finalizePromise = (async () => {
    await recordEvent("run_finished", {
      status,
      elapsedMinutes: elapsedMinutes(),
      ...details
    });
    await releaseRunLease(status);
    console.log(JSON.stringify({
      runId,
      status,
      elapsedMinutes: elapsedMinutes(),
      eventLog: eventLogPath
    }, null, 2));
  })();
  return finalizePromise;
}

async function releaseRunLease(status) {
  await activeStateWriteQueue;
  if (!launchToken) {
    const current = await readJson(activePath, {});
    await writeJsonAtomic(activePath, {
      ...current,
      runId,
      pid: null,
      terminalPid: process.pid,
      processFingerprint: null,
      startedAt,
      deadlineAt,
      durationMinutes,
      minimumSweepMinutes,
      mode: runMode,
      lastHeartbeatAt: new Date().toISOString(),
      currentSweep: currentSweep(eventLog),
      status
    });
    return;
  }

  const transition = await acquireClaimTransition(claimPath, {
    actorToken: launchToken,
    role: "runner-release"
  });
  try {
    const [owner, current] = await Promise.all([
      readJson(path.join(claimPath, "owner.json"), null),
      readJson(activePath, null)
    ]);
    assertCurrentLaunchOwnership(current);
    const finishedAt = new Date().toISOString();
    await writeJsonAtomic(activePath, {
      ...current,
      runId,
      pid: null,
      terminalPid: process.pid,
      processFingerprint: null,
      startedAt,
      deadlineAt,
      durationMinutes,
      minimumSweepMinutes,
      mode: runMode,
      lastHeartbeatAt: finishedAt,
      currentSweep: currentSweep(eventLog),
      status
    });
    if (owner?.token === launchToken) {
      await writeJsonAtomic(path.join(claimPath, "owner.json"), {
        ...owner,
        ownerKind: "released",
        ownerPid: null,
        ownerFingerprint: null,
        childPid: null,
        terminalStatus: status,
        releasedAt: finishedAt
      });
    }
  } finally {
    await transition.release();
  }
}

async function recordEvent(type, payload) {
  await assertLaunchOwnership();
  eventLog.push({
    type,
    at: new Date().toISOString(),
    elapsedMinutes: elapsedMinutes(),
    ...payload
  });
  eventWriteQueue = eventWriteQueue.then(() => writeRunLog());
  await eventWriteQueue;
}

async function writeRunLog() {
  await writeJsonAtomic(eventLogPath, {
    runId,
    startedAt,
    deadlineAt,
    durationMinutes,
    minimumSweepMinutes,
    mode: runMode,
    eventLog
  });
}

async function claimLaunchState() {
  const transition = await acquireClaimTransition(claimPath, {
    actorToken: launchToken,
    role: "runner-acknowledgement"
  });
  try {
    const [owner, current] = await Promise.all([
      readJson(path.join(claimPath, "owner.json"), null),
      readJson(activePath, null)
    ]);
    if (
      owner?.token !== launchToken
      || current?.runId !== runId
      || current?.launchToken !== launchToken
      || !["launching", "resuming"].includes(current?.status)
    ) {
      return false;
    }
    const acknowledgedAt = new Date().toISOString();
    const fingerprint = processStartFingerprint();
    await writeJsonAtomic(path.join(claimPath, "owner.json"), {
      ...owner,
      version: 2,
      ownerKind: "runner",
      ownerPid: process.pid,
      ownerFingerprint: fingerprint,
      childPid: process.pid,
      runId,
      acknowledgedAt
    });
    await writeJsonAtomic(activePath, {
      ...current,
      pid: process.pid,
      leaseVersion: 2,
      processFingerprint: fingerprint,
      lastHeartbeatAt: acknowledgedAt,
      status: current.status === "resuming" ? "resuming" : "running"
    });
    return true;
  } finally {
    await transition.release();
  }
}

function writeActiveState(status) {
  activeStateWriteQueue = activeStateWriteQueue.then(async () => {
    if (finishing && !terminalRunStatus(status)) return;
    const current = await readJson(activePath, {});
    assertCurrentLaunchOwnership(current);
    await writeJsonAtomic(activePath, {
      ...current,
      runId,
      pid: process.pid,
      startedAt,
      deadlineAt,
      durationMinutes,
      minimumSweepMinutes,
      mode: runMode,
      lastHeartbeatAt: new Date().toISOString(),
      currentSweep: currentSweep(eventLog),
      status
    });
  });
  return activeStateWriteQueue;
}

function terminalRunStatus(status) {
  return [
    "complete",
    "smoke_complete",
    "deadline_complete",
    "failed",
    "interrupted"
  ].includes(status);
}

async function assertLaunchOwnership() {
  if (!launchToken) return;
  assertCurrentLaunchOwnership(await readJson(activePath, null));
}

function assertCurrentLaunchOwnership(current) {
  if (!launchToken) return;
  if (
    current?.runId !== runId
    || current?.launchToken !== launchToken
    || Number(current?.pid) !== process.pid
  ) {
    const error = new Error(`Launcher ownership for ${runId} was superseded.`);
    error.name = "StaleLongRunLaunchError";
    throw error;
  }
}

function assertAllBatchPlan(output) {
  const plan = JSON.parse(output);
  const batches = new Set((plan.batches ?? []).map((batch) => batch.slug));
  for (const expected of ["S2026", "S26", "A16ZSR006"]) {
    if (!batches.has(expected)) throw new Error(`Autonomous smoke plan omitted ${expected}.`);
  }
  if (Number(plan.coverage?.expected ?? 0) <= 0) {
    throw new Error("Autonomous smoke plan did not contain mapped collector tasks.");
  }
}

function persistedRunMode(metadata) {
  if (["continuous", "once", "smoke"].includes(metadata?.mode)) {
    return metadata.mode;
  }
  const events = Array.isArray(metadata?.eventLog) ? metadata.eventLog : [];
  const lifecycleEvent = events.find(
    (event) => event?.type === "run_started" || event?.type === "run_resumed"
  );
  if (["continuous", "once", "smoke"].includes(lifecycleEvent?.mode)) {
    return lifecycleEvent.mode;
  }
  return lifecycleEvent?.smoke === true ? "smoke" : null;
}

function resumableCycleIndex(events) {
  const started = events.filter((event) => event.type === "sweep_started");
  const succeeded = new Set(
    events.filter((event) => event.type === "sweep_succeeded").map((event) => event.cycleIndex)
  );
  const unfinished = [...started].reverse().find((event) => !succeeded.has(event.cycleIndex));
  if (unfinished) return unfinished.cycleIndex;
  return succeeded.size ? Math.max(...succeeded) + 1 : 0;
}

function unfinishedAdmittedSweep(events) {
  const terminalCycles = new Set(
    events
      .filter((event) => event.type === "sweep_succeeded" || event.type === "sweep_failed")
      .map((event) => event.cycleIndex)
  );
  return [...events]
    .reverse()
    .find((event) => event.type === "sweep_started" && !terminalCycles.has(event.cycleIndex))
    ?? null;
}

function latestFailureEvent(events) {
  return [...events]
    .reverse()
    .find((event) => event.type === "run_failed" || event.type === "sweep_failed")
    ?? null;
}

function durableFailureMessage(event, fallbackError) {
  if (event?.type === "run_failed") {
    return event.error ?? errorMessage(fallbackError);
  }
  if (event?.type === "sweep_failed") {
    return `Autonomous sweep ${event.cycleIndex ?? "unknown"} attempt ${event.attempt ?? "unknown"} failed with exit code ${event.exitCode ?? "unknown"}.`;
  }
  return errorMessage(fallbackError);
}

function nextAttemptForCycle(events, cycleIndex) {
  return events.filter(
    (event) => event.type === "sweep_started" && event.cycleIndex === cycleIndex
  ).length + 1;
}

function currentSweep(events) {
  return [...events].reverse().find((event) => event.type === "sweep_started") ?? null;
}

function appendTail(current, value, max = 16_000) {
  const next = `${current}${value}`;
  return next.length > max ? next.slice(-max) : next;
}

function elapsedMinutes() {
  return Math.max(0, Math.floor((Date.now() - startedAtMs) / 60_000));
}

function throwIfInterrupted() {
  if (!interruptedSignal) return;
  const error = new Error(`Long-run interrupted by ${interruptedSignal}.`);
  error.name = "LongRunInterruptedError";
  error.signal = interruptedSignal;
  throw error;
}

function isInterruption(error) {
  return error?.name === "LongRunInterruptedError" || Boolean(interruptedSignal);
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
}

function formatMinutes(value) {
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(3)));
}

function numberArg(name) {
  const raw = argValue(name);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function argValue(name) {
  return process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function validDateMs(value) {
  const parsed = new Date(value).valueOf();
  return Number.isFinite(parsed) ? parsed : null;
}

function validIsoDate(value) {
  return validDateMs(value) === null ? null : value;
}

function finitePositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isSafeRunId(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)
    && value !== "."
    && value !== "..";
}

function failConfiguration(message) {
  process.stderr.write(`Long-run configuration error: ${message}\n`);
  process.exit(64);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function readJson(filePath, fallback) {
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
