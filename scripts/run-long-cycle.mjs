import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const runDir = path.join(root, "outputs", "longrun");
const activePath = path.join(runDir, "active-run.json");
const startedAt = process.env.LONG_RUN_START_AT ?? new Date().toISOString();
const runId = process.env.LONG_RUN_ID ?? `source-sweep-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const durationMinutes = Math.max(1, numberArg("--minutes") ?? 300);
const checkpointMinutes = numberArg("--checkpoint-minutes") ?? 5;
const requestedMinimumSweepMinutes = Math.max(
  1 / 60_000,
  numberArg("--minimum-sweep-minutes") ?? 45
);
const smoke = hasArg("--smoke");
const once = hasArg("--once") || smoke;
const startedAtMs = validDateMs(startedAt) ?? Date.now();
const stopAtMs = startedAtMs + durationMinutes * 60_000;
const deadlineAt = new Date(stopAtMs).toISOString();
const checkpointEveryMs = Math.max(1, checkpointMinutes) * 60_000;
const eventLogPath = path.join(runDir, `${runId}.json`);
const autonomousRunnerPath = path.join("scripts", "run-autonomous-ingestion.mjs");
const resumeLog = await readJson(eventLogPath, null);
const persistedMinimumSweepMinutes = Number(resumeLog?.minimumSweepMinutes);
const minimumSweepMinutes = numberArg("--minimum-sweep-minutes") === null
  && Number.isFinite(persistedMinimumSweepMinutes)
  ? Math.max(1 / 60_000, persistedMinimumSweepMinutes)
  : requestedMinimumSweepMinutes;
const minimumSweepReserveMs = minimumSweepMinutes * 60_000;
const eventLog = resumeLog?.runId === runId && Array.isArray(resumeLog.eventLog)
  ? resumeLog.eventLog
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
let nextCheckpointAtMs = Date.now();
let activeChild = null;
let finishing = false;
let finalizePromise = null;
let eventWriteQueue = Promise.resolve();
let activeStateWriteQueue = Promise.resolve();
let interruptedSignal = null;

await mkdir(runDir, { recursive: true });
await recordEvent(eventLog.length ? "run_resumed" : "run_started", {
  runId,
  startedAt,
  deadlineAt,
  durationMinutes,
  checkpointMinutes,
  minimumSweepMinutes,
  scope: {
    batches: ["S2026", "S26", "A16ZSR006"],
    entities: ["companies", "founders"],
    platforms: "all supported autonomous platforms",
    priority: "lowest evidence coverage first"
  },
  smoke
});

const heartbeatTimer = setInterval(() => {
  void checkpointIfDue(false).catch((error) => {
    process.stderr.write(`Long-run heartbeat failed: ${errorMessage(error)}\n`);
  });
}, 30_000);
heartbeatTimer.unref?.();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (finishing || interruptedSignal) return;
    interruptedSignal = signal;
    if (activeChild) terminateChildTree(activeChild);
  });
}

try {
  if (smoke) {
    throwIfInterrupted();
    const smokeKey = `${runId}-smoke-plan`;
    const result = await runCommand([
      autonomousRunnerPath,
      "--plan",
      "--skip-publish",
      `--idempotency-key=${smokeKey}`
    ], Math.min(stopAtMs, Date.now() + 120_000));
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
    let cycleIndex = resumableCycleIndex(eventLog);
    let attempt = nextAttemptForCycle(eventLog, cycleIndex);
    let completionStatus = "complete";
    while (true) {
      throwIfInterrupted();
      const remainingMs = stopAtMs - Date.now();
      if (remainingMs <= minimumSweepReserveMs) {
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
      const idempotencyKey = `${runId}-sweep-${String(cycleIndex).padStart(3, "0")}`;
      await recordEvent("sweep_started", { cycleIndex, attempt, idempotencyKey });
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
      await checkpointIfDue(true);
      throwIfInterrupted();
      if (result.exitCode !== 0) {
        throw new Error(
          `Autonomous sweep ${cycleIndex} attempt ${attempt} failed with exit code ${result.exitCode}.`
        );
      }
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
  if (isInterruption(error)) {
    const signal = interruptedSignal ?? error.signal;
    await finalize("interrupted", { signal });
    process.exitCode = signalExitCode(signal);
  } else {
    const message = errorMessage(error);
    await recordEvent("run_failed", { error: message });
    await finalize("failed", { error: message });
    process.stderr.write(`Long-run failed: ${message}\n`);
    process.exitCode = 1;
  }
} finally {
  clearInterval(heartbeatTimer);
}

function runCommand(args, commandDeadlineMs = null) {
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
    const deadlineTimer = Number.isFinite(commandDeadlineMs)
      ? setTimeout(() => {
        deadlineReached = true;
        stderrTail = appendTail(
          stderrTail,
          `Stopped command because the ${formatMinutes(durationMinutes)}-minute source-sweep window elapsed.\n`
        );
        terminateChildTree(child);
      }, Math.max(0, commandDeadlineMs - Date.now()))
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
  const hardKill = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 5_000);
  hardKill.unref?.();
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
    await writeActiveState(status);
    console.log(JSON.stringify({
      runId,
      status,
      elapsedMinutes: elapsedMinutes(),
      eventLog: eventLogPath
    }, null, 2));
  })();
  return finalizePromise;
}

function recordEvent(type, payload) {
  eventLog.push({
    type,
    at: new Date().toISOString(),
    elapsedMinutes: elapsedMinutes(),
    ...payload
  });
  eventWriteQueue = eventWriteQueue.then(() => writeRunLog());
  return eventWriteQueue;
}

async function writeRunLog() {
  await writeJsonAtomic(eventLogPath, {
    runId,
    startedAt,
    deadlineAt,
    durationMinutes,
    minimumSweepMinutes,
    eventLog
  });
}

function writeActiveState(status) {
  activeStateWriteQueue = activeStateWriteQueue.then(async () => {
    const current = await readJson(activePath, {});
    await writeJsonAtomic(activePath, {
      ...current,
      runId,
      pid: process.pid,
      startedAt,
      deadlineAt,
      durationMinutes,
      minimumSweepMinutes,
      lastHeartbeatAt: new Date().toISOString(),
      currentSweep: currentSweep(eventLog),
      status
    });
  });
  return activeStateWriteQueue;
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

function resumableCycleIndex(events) {
  const started = events.filter((event) => event.type === "sweep_started");
  const succeeded = new Set(
    events.filter((event) => event.type === "sweep_succeeded").map((event) => event.cycleIndex)
  );
  const unfinished = [...started].reverse().find((event) => !succeeded.has(event.cycleIndex));
  if (unfinished) return unfinished.cycleIndex;
  return Math.max(0, ...succeeded) + 1;
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
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function validDateMs(value) {
  const parsed = new Date(value).valueOf();
  return Number.isFinite(parsed) ? parsed : null;
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
