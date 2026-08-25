import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS,
  AUTONOMOUS_RUNNER_WORKFLOW_HEADROOM_MS
} from "./autonomous-ingestion-budget.mjs";

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_MAX_ELAPSED_SECONDS = 345 * 60;
const DEFAULT_RETRY_DELAYS_SECONDS = Object.freeze([30, 120, 300, 600, 900]);
const MAX_ATTEMPTS_LIMIT = 20;
const MAX_ELAPSED_SECONDS_LIMIT = 350 * 60;
export const AUTONOMOUS_WORKFLOW_ATTEMPT_ALLOWANCE_MS =
  AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS + AUTONOMOUS_RUNNER_WORKFLOW_HEADROOM_MS;
// The controller starts the child process before the runner establishes its
// own clock. Preserve one minute for Node startup in addition to the runner's
// complete work-and-cleanup allowance.
export const AUTONOMOUS_WORKFLOW_ATTEMPT_STARTUP_HEADROOM_MS = 60_000;
export const AUTONOMOUS_WORKFLOW_MINIMUM_ATTEMPT_WINDOW_MS =
  AUTONOMOUS_WORKFLOW_ATTEMPT_ALLOWANCE_MS +
  AUTONOMOUS_WORKFLOW_ATTEMPT_STARTUP_HEADROOM_MS;
const DEFAULT_MIN_REMAINING_SECONDS = AUTONOMOUS_WORKFLOW_MINIMUM_ATTEMPT_WINDOW_MS / 1_000;
// The child reserves this same six-minute window for lease release, outcome
// emission, worktree removal, and its 165-second emergency cancellation path.
// Do not turn a graceful cleanup into SIGKILL earlier than that contract.
export const AUTONOMOUS_WORKFLOW_CHILD_TERMINATION_GRACE_MS =
  AUTONOMOUS_RUNNER_WORKFLOW_HEADROOM_MS;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;
const SUCCESS_RUNNER_STATUSES = new Set(["refreshed", "already_completed"]);
const PUBLICATION_MAY_HAVE_COMPLETED = new Set([
  "published",
  "no_changes",
  "already_completed"
]);
const SEMANTIC_TERMINAL_FAILURE = new RegExp(
  [
    "another ingestion coordinator owns",
    "runtime lock (?:expired|was taken)",
    "lease (?:token|ownership) mismatch",
    "lost (?:the )?(?:runtime )?(?:lock|lease)",
    "candidate (?:is )?(?:stale|superseded)",
    "queued-candidate-superseded"
  ].join("|"),
  "i"
);
const TRANSIENT_FAILURE = new RegExp(
  [
    "fetch failed",
    "failed to fetch",
    "network request failed",
    "load failed",
    "socket hang up",
    "connection reset",
    "temporar(?:y|ily)",
    "transient",
    "timed out",
    "timeout",
    "\\b(?:EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETDOWN|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|UND_ERR_[A-Z_]+)\\b",
    "\\b(?:HTTP(?: status)?[ :]*)?(?:429|502|503|504)\\b"
  ].join("|"),
  "i"
);

export const AUTONOMOUS_WORKFLOW_RETRY_DEFAULTS = Object.freeze({
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  maxElapsedSeconds: DEFAULT_MAX_ELAPSED_SECONDS,
  minRemainingSeconds: DEFAULT_MIN_REMAINING_SECONDS,
  retryDelaysSeconds: DEFAULT_RETRY_DELAYS_SECONDS
});

export function parseAutonomousWorkflowRetryConfig(environment = process.env) {
  const maxAttempts = parseBoundedInteger(
    environment.AUTONOMOUS_WORKFLOW_RETRY_MAX_ATTEMPTS,
    DEFAULT_MAX_ATTEMPTS,
    "AUTONOMOUS_WORKFLOW_RETRY_MAX_ATTEMPTS",
    { minimum: 1, maximum: MAX_ATTEMPTS_LIMIT }
  );
  const maxElapsedSeconds = parseBoundedInteger(
    environment.AUTONOMOUS_WORKFLOW_RETRY_MAX_ELAPSED_SECONDS,
    DEFAULT_MAX_ELAPSED_SECONDS,
    "AUTONOMOUS_WORKFLOW_RETRY_MAX_ELAPSED_SECONDS",
    {
      minimum: DEFAULT_MIN_REMAINING_SECONDS,
      maximum: MAX_ELAPSED_SECONDS_LIMIT
    }
  );
  const minRemainingSeconds = parseBoundedInteger(
    environment.AUTONOMOUS_WORKFLOW_RETRY_MIN_REMAINING_SECONDS,
    DEFAULT_MIN_REMAINING_SECONDS,
    "AUTONOMOUS_WORKFLOW_RETRY_MIN_REMAINING_SECONDS",
    {
      minimum: DEFAULT_MIN_REMAINING_SECONDS,
      maximum: maxElapsedSeconds
    }
  );
  const retryDelaysSeconds = parseRetryDelays(
    environment.AUTONOMOUS_WORKFLOW_RETRY_DELAYS_SECONDS
  );
  return Object.freeze({
    maxAttempts,
    maxElapsedSeconds,
    minRemainingSeconds,
    retryDelaysSeconds
  });
}

export function parseAutonomousWorkflowAttemptOutput(source) {
  if (typeof source !== "string" || source.length === 0) {
    return Object.freeze({ valid: false, reason: "missing-attempt-output", values: {} });
  }
  const values = Object.create(null);
  for (const line of source.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      return Object.freeze({ valid: false, reason: "malformed-attempt-output", values: {} });
    }
    const key = line.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(values, key)) {
      return Object.freeze({ valid: false, reason: "malformed-attempt-output", values: {} });
    }
    values[key] = line.slice(separator + 1);
  }
  if (!Object.hasOwn(values, "runner_status")) {
    return Object.freeze({ valid: false, reason: "missing-runner-status", values: {} });
  }
  return Object.freeze({ valid: true, reason: "parsed", values: Object.freeze(values) });
}

export function classifyAutonomousWorkflowAttempt({
  exitCode,
  signal = null,
  output = ""
} = {}) {
  const parsed = parseAutonomousWorkflowAttemptOutput(output);
  if (!parsed.valid) {
    return terminalDecision(parsed.reason, { parsed });
  }

  const runnerStatus = parsed.values.runner_status ?? "";
  const publicationStatus = parsed.values.publication_status ?? "";
  const publishedCommit = parsed.values.published_commit ?? "";
  const failureMessage = parsed.values.failure_message ?? "";
  const diagnostic = `${runnerStatus} ${publicationStatus} ${failureMessage}`;

  if (
    signal ||
    exitCode === 130 ||
    exitCode === 143 ||
    runnerStatus === "canceled"
  ) {
    return terminalDecision("runner-terminated", { parsed });
  }
  if (exitCode === 0 && SUCCESS_RUNNER_STATUSES.has(runnerStatus)) {
    return Object.freeze({
      completed: true,
      retryable: false,
      reason: "completed",
      parsed
    });
  }
  if (FULL_COMMIT_SHA.test(publishedCommit) || PUBLICATION_MAY_HAVE_COMPLETED.has(publicationStatus)) {
    return terminalDecision("publication-may-have-completed", { parsed });
  }
  if (exitCode === 0 || SUCCESS_RUNNER_STATUSES.has(runnerStatus)) {
    return terminalDecision("runner-exit-status-mismatch", { parsed });
  }
  if (SEMANTIC_TERMINAL_FAILURE.test(diagnostic)) {
    return terminalDecision("semantic-lock-or-candidate-failure", { parsed });
  }
  if (runnerStatus === "failed" && TRANSIENT_FAILURE.test(failureMessage)) {
    return Object.freeze({
      completed: false,
      retryable: true,
      reason: "transient-infrastructure-failure",
      parsed
    });
  }
  return terminalDecision("non-retryable-runner-failure", { parsed });
}

export async function runAutonomousWorkflowRetries({
  runnerArguments,
  environment = process.env,
  now = Date.now,
  runnerPath = defaultRunnerPath()
} = {}) {
  if (!Array.isArray(runnerArguments)) {
    throw new TypeError("runnerArguments must be an array.");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function.");
  const githubOutput = cleanString(environment.GITHUB_OUTPUT);
  if (!githubOutput) {
    throw new Error("GITHUB_OUTPUT is required for retry-safe autonomous ingestion.");
  }
  const config = parseAutonomousWorkflowRetryConfig(environment);
  const startedAt = now();
  const deadlineAt = startedAt + (config.maxElapsedSeconds * 1_000);
  const temporaryRoot = await mkdtemp(
    path.join(cleanString(environment.RUNNER_TEMP) ?? tmpdir(), "autonomous-ingestion-retry-")
  );
  const resolvedRunnerPath = path.resolve(runnerPath);
  const retryAbortController = new AbortController();
  let activeChild = null;
  let activeChildTerminationTimer = null;
  let terminationSignal = null;
  let lastAttempt = null;

  const forwardSignal = (signal) => {
    terminationSignal = signal;
    retryAbortController.abort(new Error(`Retry controller received ${signal}.`));
    if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
      activeChild.kill(signal);
      activeChildTerminationTimer = setTimeout(() => {
        if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
          activeChild.kill("SIGKILL");
        }
      }, AUTONOMOUS_WORKFLOW_CHILD_TERMINATION_GRACE_MS);
      activeChildTerminationTimer.unref?.();
    }
  };
  const sigintHandler = () => forwardSignal("SIGINT");
  const sigtermHandler = () => forwardSignal("SIGTERM");
  process.once("SIGINT", sigintHandler);
  process.once("SIGTERM", sigtermHandler);

  try {
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      if (terminationSignal) break;
      const remainingBeforeAttemptMs = deadlineAt - now();
      if (remainingBeforeAttemptMs < config.minRemainingSeconds * 1_000) {
        break;
      }

      const attemptOutputPath = path.join(temporaryRoot, `attempt-${attempt}.output`);
      console.log(
        `Starting autonomous ingestion workflow attempt ${attempt}/${config.maxAttempts} ` +
        `(controller deadline ${new Date(deadlineAt).toISOString()}).`
      );
      const attemptDeadlineAt = Math.min(
        deadlineAt,
        now() + AUTONOMOUS_WORKFLOW_MINIMUM_ATTEMPT_WINDOW_MS
      );
      const execution = await executeAutonomousWorkflowAttempt({
        runnerPath: resolvedRunnerPath,
        runnerArguments,
        attemptOutputPath,
        environment,
        deadlineAt: attemptDeadlineAt,
        now,
        onChild: (child) => {
          activeChild = child;
        }
      });
      activeChild = null;
      if (activeChildTerminationTimer) {
        clearTimeout(activeChildTerminationTimer);
        activeChildTerminationTimer = null;
      }
      const output = await readAttemptOutput(attemptOutputPath);
      const decision = execution.deadlineExpired
        ? terminalDecision("workflow-retry-deadline-expired", {
            parsed: parseAutonomousWorkflowAttemptOutput(output)
          })
        : classifyAutonomousWorkflowAttempt({
            exitCode: execution.exitCode,
            signal: execution.signal,
            output
          });
      lastAttempt = Object.freeze({ attempt, output, execution, decision });

      if (decision.completed) {
        await appendFinalOutcome(githubOutput, lastAttempt, "completed");
        return 0;
      }
      if (terminationSignal || !decision.retryable || attempt === config.maxAttempts) break;

      const retryDelaySeconds = config.retryDelaysSeconds[
        Math.min(attempt - 1, config.retryDelaysSeconds.length - 1)
      ];
      const remainingAfterDelayMs = deadlineAt - now() - (retryDelaySeconds * 1_000);
      if (remainingAfterDelayMs < config.minRemainingSeconds * 1_000) break;
      console.warn(
        `::warning title=Autonomous ingestion retry::${githubCommandText(
          `Attempt ${attempt}/${config.maxAttempts} ended with an explicit transient failure; ` +
          `retrying the same idempotency key in ${retryDelaySeconds}s. ${attemptDiagnostic(decision)}`
        )}`
      );
      try {
        await delay(retryDelaySeconds * 1_000, undefined, {
          signal: retryAbortController.signal
        });
      } catch (error) {
        if (error?.name !== "AbortError") throw error;
        break;
      }
    }

    const disposition = terminationSignal
      ? "controller-terminated"
      : lastAttempt?.decision.retryable
        ? "retry-budget-exhausted"
        : lastAttempt?.decision.reason ?? "attempt-not-started";
    await appendFinalOutcome(githubOutput, lastAttempt, disposition);
    if (terminationSignal === "SIGINT") return 130;
    if (terminationSignal === "SIGTERM") return 143;
    return nonZeroExitCode(lastAttempt?.execution.exitCode);
  } finally {
    if (activeChildTerminationTimer) clearTimeout(activeChildTerminationTimer);
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigtermHandler);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function executeAutonomousWorkflowAttempt({
  runnerPath,
  runnerArguments,
  attemptOutputPath,
  environment,
  deadlineAt,
  now,
  onChild,
  terminationGraceMs = AUTONOMOUS_WORKFLOW_CHILD_TERMINATION_GRACE_MS
}) {
  if (!Number.isFinite(terminationGraceMs) || terminationGraceMs < 1) {
    throw new RangeError("terminationGraceMs must be a positive finite millisecond value.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath, ...runnerArguments], {
      cwd: process.cwd(),
      env: {
        ...environment,
        GITHUB_OUTPUT: attemptOutputPath
      },
      stdio: "inherit"
    });
    onChild(child);
    let deadlineExpired = false;
    let killTimer = null;
    const deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), terminationGraceMs);
      killTimer.unref?.();
    }, Math.max(1, deadlineAt - now()));
    deadlineTimer.unref?.();

    child.once("error", (error) => {
      clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode, signal, deadlineExpired });
    });
  });
}

async function readAttemptOutput(attemptOutputPath) {
  try {
    return await readFile(attemptOutputPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function appendFinalOutcome(githubOutput, attempt, disposition) {
  const attempts = attempt?.attempt ?? 0;
  let output = attempt?.output ?? "";
  if (!parseAutonomousWorkflowAttemptOutput(output).valid) {
    output = [
      "runner_status=failed",
      "publication_status=",
      "failure_message=Autonomous ingestion attempt ended without a valid isolated runner outcome.",
      "published_commit="
    ].join("\n");
  }
  const suffix = [
    `workflow_retry_attempts=${attempts}`,
    `workflow_retry_disposition=${disposition}`
  ].join("\n");
  await appendFile(githubOutput, `${output.replace(/\n*$/, "")}\n${suffix}\n`, "utf8");
}

function attemptDiagnostic(decision) {
  const failureMessage = decision.parsed?.values?.failure_message ?? "";
  return failureMessage.slice(0, 500) || decision.reason;
}

function terminalDecision(reason, { parsed }) {
  return Object.freeze({
    completed: false,
    retryable: false,
    reason,
    parsed
  });
}

function nonZeroExitCode(value) {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function parseRetryDelays(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_RETRY_DELAYS_SECONDS;
  }
  const delays = String(value).split(",").map((entry) => {
    if (!/^(?:0|[1-9][0-9]*)$/.test(entry.trim())) {
      throw new Error("AUTONOMOUS_WORKFLOW_RETRY_DELAYS_SECONDS must be comma-separated integers.");
    }
    const seconds = Number(entry.trim());
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3_600) {
      throw new Error("AUTONOMOUS_WORKFLOW_RETRY_DELAYS_SECONDS values must be between 1 and 3600.");
    }
    return seconds;
  });
  if (delays.length < 1 || delays.length > MAX_ATTEMPTS_LIMIT - 1) {
    throw new Error("AUTONOMOUS_WORKFLOW_RETRY_DELAYS_SECONDS has an invalid number of delays.");
  }
  return Object.freeze(delays);
}

function parseBoundedInteger(value, fallback, label, { minimum, maximum }) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(value))) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function githubCommandText(value) {
  return String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function cleanString(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned || null;
}

function defaultRunnerPath() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "run-autonomous-ingestion.mjs"
  );
}

async function main() {
  const separator = process.argv.indexOf("--");
  if (separator === -1) {
    throw new Error("Usage: node scripts/lib/autonomous-ingestion-workflow-retry.mjs -- [runner arguments]");
  }
  return runAutonomousWorkflowRetries({
    runnerArguments: process.argv.slice(separator + 1)
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`Autonomous ingestion retry controller failed: ${githubCommandText(error?.message ?? error)}`);
    process.exitCode = 1;
  }
}
