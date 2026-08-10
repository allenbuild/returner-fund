import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import { sanitizeRunnerFailureMessage } from "./lib/runner-failure-sanitizer.mjs";

export const DEFAULT_FINAL_VERIFICATION_LOG_BYTE_LIMIT = 1024 * 1024;
export const DEFAULT_FINAL_VERIFICATION_TAIL_CHARACTER_LIMIT = 1600;
export const DEFAULT_FINAL_VERIFICATION_CONSOLE_BYTE_LIMIT = 256 * 1024;
export const FINAL_VERIFICATION_MAX_NODE_HEAP_MB = 3072;
export const FINAL_VERIFICATION_DEFAULT_NODE_HEAP_MB = 1536;
export const FINAL_VERIFICATION_TEST_NODE_HEAP_MB = 1024;
export const FINAL_VERIFICATION_BUILD_NODE_HEAP_MB = 3072;
export const FINAL_VERIFICATION_REPORT_NODE_HEAP_MB = 1024;
export const FINAL_VERIFICATION_INGEST_NODE_HEAP_MB = 768;

const MIN_REDACTION_CARRY_CHARACTERS = 4096;
const MAX_REDACTION_CARRY_CHARACTERS = 1024 * 1024;
const CHILD_TERMINATION_GRACE_MS = 1500;
const CHILD_DRAIN_GRACE_MS = 1500;
const PROCESS_GROUP_POLL_INTERVAL_MS = 20;
const SIGNALS = ["SIGINT", "SIGTERM"];
const SENSITIVE_ENVIRONMENT_NAME = /(?:token|secret|pass(?:word|wd)?|cookie|credential|private[_-]?key|service[_-]?role|session|auth|api[_-]?key|extraheader)/i;

export async function runFinalVerification({
  argv = process.argv.slice(2),
  env = process.env,
  commands: suppliedCommands,
  outputDir: suppliedOutputDir,
  latestPath: suppliedLatestPath,
  mirrorOutput = true,
  mirrorStreams = { stdout: process.stdout, stderr: process.stderr },
  installSignalHandlers = true,
  exitOnSignal = true
} = {}) {
  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, "-");
  const outputDir = suppliedOutputDir ?? path.join("outputs", "final-verification", runId);
  const latestPath = suppliedLatestPath ?? path.join("outputs", "final-verification-latest.json");
  const skipTargetedIngest = argv.includes("--skip-targeted-ingest");
  const commands = suppliedCommands ?? finalVerificationCommands({ skipTargetedIngest });
  const lifecycle = new FinalVerificationLifecycle();
  const removeSignalHandlers = installSignalHandlers
    ? installCancellationSignalHandlers(lifecycle)
    : () => {};
  const commandOptions = {
    outputDir,
    env,
    lifecycle,
    mirrorOutput,
    mirrorStreams,
    logByteLimit: positiveInteger(
      env.FINAL_VERIFICATION_LOG_BYTE_LIMIT,
      DEFAULT_FINAL_VERIFICATION_LOG_BYTE_LIMIT
    ),
    tailCharacterLimit: positiveInteger(
      env.FINAL_VERIFICATION_TAIL_CHARACTER_LIMIT,
      DEFAULT_FINAL_VERIFICATION_TAIL_CHARACTER_LIMIT
    ),
    consoleByteLimit: positiveInteger(
      env.FINAL_VERIFICATION_CONSOLE_BYTE_LIMIT,
      DEFAULT_FINAL_VERIFICATION_CONSOLE_BYTE_LIMIT
    )
  };
  const summary = {
    run_id: runId,
    started_at: startedAt.toISOString(),
    finished_at: null,
    elapsed_seconds: null,
    skipped_targeted_ingest: skipTargetedIngest,
    planned_command_count: commands.length,
    command_count: commands.length,
    pass_count: 0,
    fail_count: 0,
    required_fail_count: 0,
    canceled_at: null,
    canceled_signal: null,
    status: "running",
    commands: []
  };
  let fatalError = null;

  try {
    await mkdir(outputDir, { recursive: true });
    await writeSummary(latestPath, summary);

    for (const command of commands) {
      if (lifecycle.canceledSignal) break;
      summary.commands.push(await runCommand(command, commandOptions));
      updateSummaryCounts(summary);
      await writeSummary(latestPath, summary);
    }

    if (!lifecycle.canceledSignal) {
      finishSummary(summary, startedAt);
      await writeSummary(latestPath, summary);

      // `longrun:report` reads final-verification-latest.json, so refresh it once
      // after the verifier has written the terminal status. This keeps the report
      // from saying the final verification is still running.
      if (!lifecycle.canceledSignal) {
        const finalReportRefresh = await runCommand(
          check("longrun_final_report", "npm", ["run", "longrun:report"], true),
          commandOptions
        );
        const reportIndex = summary.commands.findIndex(
          (item) => item.label === "longrun_final_report"
        );
        if (reportIndex >= 0) {
          summary.commands[reportIndex] = finalReportRefresh;
        } else {
          summary.commands.push(finalReportRefresh);
        }
        updateSummaryCounts(summary);
        if (!lifecycle.canceledSignal) finishSummary(summary, startedAt);
      }
    }
  } catch (error) {
    fatalError = error;
  }

  if (!lifecycle.canceledSignal && !fatalError) {
    summary.command_count = summary.commands.length;
    updateSummaryCounts(summary);
    finishSummary(summary, startedAt);
    try {
      await writeSummary(latestPath, summary);
    } catch (error) {
      fatalError = error;
    }
  }

  if (lifecycle.canceledSignal) {
    await lifecycle.stopAndWait(lifecycle.canceledSignal);
    updateSummaryCounts(summary);
    summary.command_count = summary.commands.length;
    summary.canceled_at = new Date().toISOString();
    summary.canceled_signal = lifecycle.canceledSignal;
    finishSummary(summary, startedAt, "canceled");
    try {
      await writeSummary(latestPath, summary);
    } catch (error) {
      fatalError ??= error;
    }
  }

  removeSignalHandlers();

  if (lifecycle.canceledSignal && exitOnSignal) {
    exitWithSignalSemantics(lifecycle.canceledSignal);
  }

  if (fatalError) throw fatalError;

  console.log(
    JSON.stringify(
      {
        outputPath: latestPath,
        status: summary.status,
        passCount: summary.pass_count,
        failCount: summary.fail_count,
        requiredFailCount: summary.required_fail_count
      },
      null,
      2
    )
  );

  if (summary.required_fail_count > 0) process.exitCode = 1;
  return summary;
}

export function finalVerificationCommands({ skipTargetedIngest = false } = {}) {
  return [
    check("typecheck", "npm", ["run", "typecheck"], true, 2048),
    check("tests", "npm", ["test"], true, FINAL_VERIFICATION_TEST_NODE_HEAP_MB),
    check("build", "npm", ["run", "build"], true, FINAL_VERIFICATION_BUILD_NODE_HEAP_MB),
    check("coverage_report", "npm", ["run", "debug:coverage"], true, FINAL_VERIFICATION_REPORT_NODE_HEAP_MB),
    check("workers_report", "npm", ["run", "debug:workers"], true, FINAL_VERIFICATION_REPORT_NODE_HEAP_MB),
    check("duplicates_report", "npm", ["run", "debug:duplicates"], true, FINAL_VERIFICATION_REPORT_NODE_HEAP_MB),
    check("instagram_doctor", "npm", ["run", "instagram:doctor"], true, FINAL_VERIFICATION_REPORT_NODE_HEAP_MB),
    !skipTargetedIngest &&
      check(
        "heyclicky_instagram_targeted_check",
        "node",
        [
          "scripts/fetch-public-traction.mjs",
          "--social=all",
          "--platform=instagram",
          "--company=HeyClicky",
          "--workers=2",
          "--delay-ms=1200",
          "--force",
          "--discover-missing-social"
        ],
        false,
        FINAL_VERIFICATION_INGEST_NODE_HEAP_MB
      ),
    !skipTargetedIngest &&
      check(
        "heyclicky_x_targeted_check",
        "node",
        [
          "scripts/fetch-public-traction.mjs",
          "--social=all",
          "--platform=x",
          "--company=HeyClicky",
          "--workers=2",
          "--delay-ms=1200",
          "--force",
          "--discover-missing-social"
        ],
        false,
        FINAL_VERIFICATION_INGEST_NODE_HEAP_MB
      ),
    check(
      "heyclicky_vs_insforge_scoring",
      "node",
      ["scripts/debug-scoring-report.mjs", "--company=HeyClicky", "--right=InsForge"],
      true,
      FINAL_VERIFICATION_REPORT_NODE_HEAP_MB
    ),
    check("scoring_experiments", "npm", ["run", "scoring:experiments"], true, FINAL_VERIFICATION_REPORT_NODE_HEAP_MB),
    check("anomaly_report", "npm", ["run", "debug:anomalies"], true, FINAL_VERIFICATION_REPORT_NODE_HEAP_MB),
    check("longrun_checkpoint", "npm", ["run", "longrun:checkpoint"], true, FINAL_VERIFICATION_REPORT_NODE_HEAP_MB),
    check("longrun_final_report", "npm", ["run", "longrun:report"], true, FINAL_VERIFICATION_REPORT_NODE_HEAP_MB)
  ].filter(Boolean);
}

export async function runCommand(command, {
  outputDir,
  env = process.env,
  mirrorOutput = true,
  mirrorStreams = { stdout: process.stdout, stderr: process.stderr },
  logByteLimit = DEFAULT_FINAL_VERIFICATION_LOG_BYTE_LIMIT,
  tailCharacterLimit = DEFAULT_FINAL_VERIFICATION_TAIL_CHARACTER_LIMIT,
  consoleByteLimit = DEFAULT_FINAL_VERIFICATION_CONSOLE_BYTE_LIMIT,
  lifecycle = null
} = {}) {
  if (!outputDir) throw new Error("runCommand requires an outputDir.");
  const started = new Date();
  const baseName = safeFileName(command.label);
  const stdoutPath = path.join(outputDir, `${baseName}.stdout.log`);
  const stderrPath = path.join(outputDir, `${baseName}.stderr.log`);
  const secrets = sensitiveEnvironmentValues(env);
  const commandDisplay = sanitizeForDiagnostics([command.cmd, ...command.args].join(" "), secrets, 4096);
  const safeLogByteLimit = positiveInteger(logByteLimit, DEFAULT_FINAL_VERIFICATION_LOG_BYTE_LIMIT);
  const safeTailCharacterLimit = positiveInteger(
    tailCharacterLimit,
    DEFAULT_FINAL_VERIFICATION_TAIL_CHARACTER_LIMIT
  );
  const safeConsoleByteLimit = positiveInteger(
    consoleByteLimit,
    DEFAULT_FINAL_VERIFICATION_CONSOLE_BYTE_LIMIT
  );

  if (lifecycle?.canceledSignal) {
    return commandResult({
      command,
      commandDisplay,
      started,
      exitCode: 1,
      stdoutPath: null,
      stderrPath: null,
      stdoutTail: "",
      stderrTail: "Canceled before launch.",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutConsoleTruncated: false,
      stderrConsoleTruncated: false,
      signal: lifecycle.canceledSignal,
      diagnosticError: "Canceled before launch."
    });
  }

  let captures;

  await mkdir(outputDir, { recursive: true });
  try {
    captures = await openOutputCaptures({
      stdoutPath,
      stderrPath,
      logByteLimit: safeLogByteLimit,
      tailCharacterLimit: safeTailCharacterLimit,
      consoleByteLimit: safeConsoleByteLimit,
      mirrorOutput
    });
  } catch (error) {
    const diagnostic = sanitizeForDiagnostics(error?.message ?? error, secrets, safeTailCharacterLimit);
    return commandResult({
      command,
      commandDisplay,
      started,
      exitCode: 1,
      stdoutPath: null,
      stderrPath: null,
      stdoutTail: "",
      stderrTail: diagnostic,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutConsoleTruncated: false,
      stderrConsoleTruncated: false,
      signal: null,
      diagnosticError: diagnostic
    });
  }

  let child;
  let childOutcome = null;
  let closePromise = null;
  let stdoutPromise = null;
  let stderrPromise = null;
  let processGroup = null;
  let lifecycleRegistration = null;
  let diagnosticError = "";

  try {
    if (lifecycle?.canceledSignal) throw new Error("Canceled before launch.");
    const childEnvironment = buildChildEnvironment(command, env);
    child = spawn(resolveExecutable(command.cmd), command.args, {
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnvironment
    });
    closePromise = waitForChild(child).then((outcome) => {
      childOutcome = outcome;
      return outcome;
    });
    processGroup = createProcessGroupGuard(child);
    lifecycleRegistration = lifecycle?.register((signal) => processGroup.stop(signal));
    stdoutPromise = consumeChildOutput(child.stdout, captures.stdout, {
      secrets,
      mirrorStream: mirrorOutput ? mirrorStreams.stdout : null
    });
    stderrPromise = consumeChildOutput(child.stderr, captures.stderr, {
      secrets,
      mirrorStream: mirrorOutput ? mirrorStreams.stderr : null
    });

    const outputFailure = Promise.all([stdoutPromise, stderrPromise]).then(
      () => new Promise(() => {}),
      (error) => ({ kind: "output-failure", error })
    );
    const firstOutcome = await Promise.race([
      closePromise.then((outcome) => ({ kind: "close", outcome })),
      outputFailure
    ]);
    if (firstOutcome.kind === "output-failure") throw firstOutcome.error;
    childOutcome = firstOutcome.outcome;
    if (childOutcome.spawnError) throw childOutcome.spawnError;
  } catch (error) {
    diagnosticError = sanitizeForDiagnostics(error?.message ?? error, secrets, safeTailCharacterLimit);
  } finally {
    if (processGroup) {
      try {
        await processGroup.stop(lifecycle?.canceledSignal ?? "SIGTERM");
      } catch (error) {
        diagnosticError = mergeDiagnostic(
          diagnosticError,
          error,
          secrets,
          safeTailCharacterLimit
        );
      }
    }

    const pending = [closePromise, stdoutPromise, stderrPromise].filter(Boolean);
    let drained = await settleAllWithin(pending, CHILD_DRAIN_GRACE_MS);
    if (!drained.settled) {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      drained = await settleAllWithin(pending, CHILD_DRAIN_GRACE_MS);
    }
    if (!drained.settled) {
      diagnosticError = mergeDiagnostic(
        diagnosticError,
        "Child process streams did not drain after process-group termination.",
        secrets,
        safeTailCharacterLimit
      );
    }
    for (const result of drained.results ?? []) {
      if (result.status === "rejected") {
        diagnosticError = mergeDiagnostic(
          diagnosticError,
          result.reason,
          secrets,
          safeTailCharacterLimit
        );
      }
    }
    if (diagnosticError) captures.stderr.appendDiagnostic(diagnosticError);
  }

  const closeErrors = await closeOutputCaptures(captures);
  if (closeErrors.length > 0) {
    const closeDiagnostic = sanitizeForDiagnostics(
      closeErrors.map((error) => error?.message ?? error).join("; "),
      secrets,
      safeTailCharacterLimit
    );
    diagnosticError = mergeTail(diagnosticError, closeDiagnostic, safeTailCharacterLimit);
    captures.stderr.appendDiagnostic(closeDiagnostic);
  }
  lifecycleRegistration?.complete();

  return commandResult({
    command,
    commandDisplay,
    started,
    exitCode: diagnosticError ? 1 : (childOutcome?.exitCode ?? 1),
    stdoutPath,
    stderrPath,
    stdoutTail: captures.stdout.tail(),
    stderrTail: captures.stderr.tail(),
    stdoutTruncated: captures.stdout.truncated,
    stderrTruncated: captures.stderr.truncated,
    stdoutConsoleTruncated: captures.stdout.consoleTruncated,
    stderrConsoleTruncated: captures.stderr.consoleTruncated,
    signal: childOutcome?.signal ?? null,
    diagnosticError
  });
}

class BoundedOutputCapture {
  constructor(fileHandle, {
    byteLimit,
    tailCharacterLimit,
    consoleByteLimit,
    mirrorOutput,
    streamLabel
  }) {
    this.fileHandle = fileHandle;
    this.byteLimit = byteLimit;
    this.tailCharacterLimit = tailCharacterLimit;
    this.consoleByteLimit = consoleByteLimit;
    this.mirrorOutput = mirrorOutput;
    this.streamLabel = streamLabel;
    this.bytesWritten = 0;
    this.consoleBytesWritten = 0;
    this.tailText = "";
    this.truncated = false;
    this.consoleTruncated = false;
    this.consoleTruncationNoticeWritten = false;
  }

  async write(value, mirrorStream) {
    const text = String(value ?? "");
    if (!text) return;
    this.tailText = mergeTail(this.tailText, text, this.tailCharacterLimit);
    const bytes = Buffer.from(text, "utf8");
    const remaining = Math.max(0, this.byteLimit - this.bytesWritten);
    if (remaining > 0) {
      const selected = bytes.subarray(0, remaining);
      await this.fileHandle.write(selected, 0, selected.length, null);
      this.bytesWritten += selected.length;
    }
    if (bytes.length > remaining) this.truncated = true;
    if (this.mirrorOutput && mirrorStream) {
      const consoleRemaining = Math.max(0, this.consoleByteLimit - this.consoleBytesWritten);
      if (consoleRemaining > 0) {
        const selected = bytes.subarray(0, consoleRemaining);
        await writeToInheritedStream(mirrorStream, selected);
        this.consoleBytesWritten += selected.length;
      }
      if (bytes.length > consoleRemaining) {
        this.consoleTruncated = true;
        if (!this.consoleTruncationNoticeWritten) {
          this.consoleTruncationNoticeWritten = true;
          await writeToInheritedStream(
            mirrorStream,
            `\n[final-verification ${this.streamLabel} output truncated after ${this.consoleByteLimit} bytes; remaining output drained]\n`
          );
        }
      }
    }
  }

  appendDiagnostic(value) {
    this.tailText = mergeTail(this.tailText, value, this.tailCharacterLimit);
  }

  tail() {
    return this.tailText.trim();
  }

  async close() {
    await this.fileHandle.close();
  }
}

class StreamingOutputRedactor {
  constructor(secrets) {
    this.secrets = secrets;
    this.decoder = new StringDecoder("utf8");
    const longestSecret = secrets.reduce((longest, secret) => Math.max(longest, secret.length), 0);
    const requiredCarry = Math.max(MIN_REDACTION_CARRY_CHARACTERS, longestSecret * 3 + 512);
    if (requiredCarry > MAX_REDACTION_CARRY_CHARACTERS) {
      throw new Error("Sensitive environment value exceeds the streaming redaction safety bound.");
    }
    this.carryLimit = requiredCarry;
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += this.decoder.write(chunk);
    if (this.buffer.length <= this.carryLimit * 2) return "";
    const sanitized = sanitizeForDiagnostics(
      this.buffer,
      this.secrets,
      Math.max(4096, this.buffer.length * 2)
    );
    const emitLength = Math.max(0, sanitized.length - this.carryLimit);
    const emitted = sanitized.slice(0, emitLength);
    this.buffer = sanitized.slice(emitLength);
    return emitted ? `${emitted}\n` : "";
  }

  flush() {
    this.buffer += this.decoder.end();
    const emitted = sanitizeForDiagnostics(
      this.buffer,
      this.secrets,
      Math.max(4096, this.buffer.length * 2)
    );
    this.buffer = "";
    return emitted ? `${emitted}\n` : "";
  }
}

async function consumeChildOutput(stream, capture, { secrets, mirrorStream }) {
  const redactor = new StreamingOutputRedactor(secrets);
  for await (const chunk of stream) {
    await capture.write(redactor.push(chunk), mirrorStream);
  }
  await capture.write(redactor.flush(), mirrorStream);
}

async function openOutputCaptures({
  stdoutPath,
  stderrPath,
  logByteLimit,
  tailCharacterLimit,
  consoleByteLimit,
  mirrorOutput
}) {
  const stdoutHandle = await open(stdoutPath, "w", 0o600);
  let stderrHandle = null;
  try {
    await stdoutHandle.chmod(0o600);
    stderrHandle = await open(stderrPath, "w", 0o600);
    await stderrHandle.chmod(0o600);
    return {
      stdout: new BoundedOutputCapture(stdoutHandle, {
        byteLimit: logByteLimit,
        tailCharacterLimit,
        consoleByteLimit,
        streamLabel: "stdout",
        mirrorOutput
      }),
      stderr: new BoundedOutputCapture(stderrHandle, {
        byteLimit: logByteLimit,
        tailCharacterLimit,
        consoleByteLimit,
        streamLabel: "stderr",
        mirrorOutput
      })
    };
  } catch (error) {
    await stderrHandle?.close().catch(() => {});
    await stdoutHandle.close().catch(() => {});
    throw error;
  }
}

async function closeOutputCaptures(captures) {
  const settled = await Promise.allSettled([captures.stdout.close(), captures.stderr.close()]);
  return settled.filter((result) => result.status === "rejected").map((result) => result.reason);
}

function waitForChild(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    child.once("error", (error) => {
      finish({ exitCode: 1, signal: null, spawnError: error });
    });
    child.once("exit", (exitCode, signal) => {
      finish({ exitCode: exitCode ?? 1, signal: signal ?? null, spawnError: null });
    });
  });
}

function createProcessGroupGuard(child) {
  let stopPromise = null;
  return {
    stop(signal = "SIGTERM") {
      stopPromise ??= terminateAndVerifyProcessGroup(child, signal);
      return stopPromise;
    }
  };
}

async function terminateAndVerifyProcessGroup(child, initialSignal) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(child.pid);
    if (processExists(child.pid)) {
      throw new Error(`Child process tree ${child.pid} remained alive after taskkill.`);
    }
    return;
  }

  const processGroupId = child.pid;
  signalProcessGroup(processGroupId, initialSignal);
  if (await waitForProcessGroupExit(processGroupId, CHILD_TERMINATION_GRACE_MS)) return;

  signalProcessGroup(processGroupId, "SIGKILL");
  if (await waitForProcessGroupExit(processGroupId, CHILD_TERMINATION_GRACE_MS)) return;
  throw new Error(
    `Process group ${processGroupId} remained alive after SIGKILL; descendant cleanup is unproven.`
  );
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await delay(PROCESS_GROUP_POLL_INTERVAL_MS);
  }
  return true;
}

async function terminateWindowsProcessTree(processId) {
  const killer = spawn("taskkill", ["/PID", String(processId), "/T", "/F"], {
    shell: false,
    stdio: "ignore",
    windowsHide: true
  });
  const outcome = await waitForChild(killer);
  if (outcome.spawnError) throw outcome.spawnError;
  if (outcome.exitCode !== 0 && processExists(processId)) {
    throw new Error(`taskkill failed for child process tree ${processId}.`);
  }
}

async function settleAllWithin(promises, timeoutMs) {
  if (promises.length === 0) return { settled: true, results: [] };
  let timeout;
  const timeoutResult = Symbol("timeout");
  const result = await Promise.race([
    Promise.allSettled(promises),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(timeoutResult), timeoutMs);
      timeout.unref?.();
    })
  ]);
  clearTimeout(timeout);
  return result === timeoutResult
    ? { settled: false, results: null }
    : { settled: true, results: result };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class FinalVerificationLifecycle {
  constructor() {
    this.canceledSignal = null;
    this.active = new Set();
  }

  register(stop) {
    const completion = deferred();
    const entry = {
      completed: false,
      done: completion.promise,
      stopPromise: null,
      requestStop: (signal) => {
        entry.stopPromise ??= Promise.resolve().then(() => stop(signal));
        entry.stopPromise.catch(() => {});
        return entry.stopPromise;
      },
      complete: () => {
        if (entry.completed) return;
        entry.completed = true;
        this.active.delete(entry);
        completion.resolve();
      }
    };
    this.active.add(entry);
    if (this.canceledSignal) entry.requestStop(this.canceledSignal);
    return entry;
  }

  cancel(signal) {
    this.canceledSignal ??= signal;
    for (const entry of this.active) entry.requestStop(this.canceledSignal);
  }

  async stopAndWait(signal) {
    this.cancel(signal);
    while (this.active.size > 0) {
      const active = [...this.active];
      await Promise.allSettled(active.flatMap((entry) => [
        entry.requestStop(this.canceledSignal),
        entry.done
      ]));
    }
  }
}

function installCancellationSignalHandlers(lifecycle) {
  const handlers = new Map();
  for (const signal of SIGNALS) {
    const handler = () => lifecycle.cancel(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
}

function exitWithSignalSemantics(signal) {
  try {
    process.kill(process.pid, signal);
  } catch {
    process.exit(128 + signalExitNumber(signal));
  }
}

function signalExitNumber(signal) {
  return signal === "SIGINT" ? 2 : 15;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function sensitiveEnvironmentValues(env) {
  return [...new Set(
    Object.entries(env ?? {})
      .filter(([name, value]) => SENSITIVE_ENVIRONMENT_NAME.test(name) && String(value ?? "").length >= 8)
      .map(([, value]) => String(value))
  )].sort((left, right) => right.length - left.length);
}

function sanitizeForDiagnostics(value, secrets, maxLength) {
  return sanitizeRunnerFailureMessage(value, { secrets, maxLength });
}

function commandResult({
  command,
  commandDisplay,
  started,
  exitCode,
  stdoutPath,
  stderrPath,
  stdoutTail,
  stderrTail,
  stdoutTruncated,
  stderrTruncated,
  stdoutConsoleTruncated,
  stderrConsoleTruncated,
  signal,
  diagnosticError
}) {
  const finished = new Date();
  return {
    label: command.label,
    command: commandDisplay,
    required: command.required,
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    elapsed_seconds: Math.round((finished.valueOf() - started.valueOf()) / 1000),
    exit_code: exitCode,
    signal,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_truncated: stdoutTruncated,
    stderr_truncated: stderrTruncated,
    stdout_console_truncated: stdoutConsoleTruncated,
    stderr_console_truncated: stderrConsoleTruncated,
    stdout_tail: stdoutTail,
    stderr_tail: stderrTail,
    diagnostic_error: diagnosticError || null
  };
}

function check(label, cmd, args, required, nodeHeapCapMb = FINAL_VERIFICATION_DEFAULT_NODE_HEAP_MB) {
  return { label, cmd, args, required, nodeHeapCapMb };
}

export function buildChildEnvironment(command, env = process.env) {
  const childEnvironment = { ...env };
  if (!isNodeLikeExecutable(command?.cmd)) {
    delete childEnvironment.NODE_OPTIONS;
    return childEnvironment;
  }

  const requestedCap = positiveInteger(
    command?.nodeHeapCapMb,
    FINAL_VERIFICATION_DEFAULT_NODE_HEAP_MB
  );
  const commandCap = Math.min(requestedCap, FINAL_VERIFICATION_MAX_NODE_HEAP_MB);
  childEnvironment.NODE_OPTIONS = normalizeNodeOptions(
    env?.NODE_OPTIONS,
    commandCap
  );
  return childEnvironment;
}

export function normalizeNodeOptions(rawOptions, requestedCapMb) {
  const commandCap = Math.min(
    positiveInteger(requestedCapMb, FINAL_VERIFICATION_DEFAULT_NODE_HEAP_MB),
    FINAL_VERIFICATION_MAX_NODE_HEAP_MB
  );
  const tokens = tokenizeNodeOptions(rawOptions);
  const preserved = [];
  let callerCap = Number.POSITIVE_INFINITY;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const match = token.match(/^--max(?:-|_)old(?:-|_)space(?:-|_)size(?:=(.*))?$/i);
    if (!match) {
      preserved.push(token);
      continue;
    }

    let rawValue = match[1];
    if (rawValue === undefined && index + 1 < tokens.length) rawValue = tokens[++index];
    const parsed = Number.parseInt(String(rawValue ?? ""), 10);
    if (Number.isInteger(parsed) && parsed > 0) callerCap = Math.min(callerCap, parsed);
  }

  const effectiveCap = Math.max(
    1,
    Math.min(commandCap, Number.isFinite(callerCap) ? callerCap : commandCap)
  );
  preserved.push(`--max-old-space-size=${effectiveCap}`);
  return preserved.map(quoteNodeOptionToken).join(" ");
}

function isNodeLikeExecutable(command) {
  if (!command) return false;
  const executable = path.basename(resolveExecutable(command)).toLowerCase();
  return new Set(["node", "node.exe", "npm", "npm.cmd", "npx", "npx.cmd"]).has(executable);
}

function tokenizeNodeOptions(rawOptions) {
  const source = String(rawOptions ?? "");
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;

  for (const character of source) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += character;
    }
  }
  if (escaped) token += "\\";
  if (token) tokens.push(token);
  return tokens;
}

function quoteNodeOptionToken(token) {
  return /\s/.test(token) ? JSON.stringify(token) : token;
}

function resolveExecutable(command) {
  return process.platform === "win32" && (command === "npm" || command === "npx")
    ? `${command}.cmd`
    : command;
}

function mergeTail(existing, addition, maxCharacters) {
  const combined = `${existing ?? ""}${addition ?? ""}`;
  return combined.length > maxCharacters ? combined.slice(-maxCharacters) : combined;
}

function mergeDiagnostic(existing, error, secrets, maxCharacters) {
  const sanitized = sanitizeForDiagnostics(error?.message ?? error, secrets, maxCharacters);
  return mergeTail(existing, `${existing ? "\n" : ""}${sanitized}`, maxCharacters);
}

function writeToInheritedStream(stream, value) {
  if (!stream?.writable || stream.destroyed || stream.writableEnded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    try {
      stream.write(value, (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function updateSummaryCounts(summary) {
  summary.pass_count = summary.commands.filter((item) => item.exit_code === 0).length;
  summary.fail_count = summary.commands.filter((item) => item.exit_code !== 0).length;
  summary.required_fail_count = summary.commands.filter(
    (item) => item.required && item.exit_code !== 0
  ).length;
}

function finishSummary(summary, startedAt, forcedStatus = null) {
  summary.finished_at = new Date().toISOString();
  summary.elapsed_seconds = Math.round(
    (new Date(summary.finished_at).valueOf() - startedAt.valueOf()) / 1000
  );
  summary.status = forcedStatus ?? (summary.required_fail_count === 0 ? "pass" : "fail");
}

export async function writeSummary(latestPath, summary) {
  const parentDirectory = path.dirname(latestPath);
  const temporaryPath = path.join(
    parentDirectory,
    `.${path.basename(latestPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle = null;
  await mkdir(parentDirectory, { recursive: true });
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(summary, null, 2));
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, latestPath);
    await chmod(latestPath, 0o600);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function safeFileName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function positiveInteger(raw, fallback) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await runFinalVerification();
