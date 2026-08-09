export class AutonomousCollectionBudgetExceededError extends Error {
  constructor(label, { requestedMs, remainingMs, deadlineAt }) {
    super(
      `Autonomous collection phase exhausted before ${label}: ` +
      `requested ${requestedMs}ms with ${remainingMs}ms remaining ` +
      `(deadline ${new Date(deadlineAt).toISOString()}).`
    );
    this.name = "AutonomousCollectionBudgetExceededError";
    this.code = "AUTONOMOUS_COLLECTION_BUDGET_EXCEEDED";
    this.requestedMs = requestedMs;
    this.remainingMs = remainingMs;
    this.deadlineAt = deadlineAt;
  }
}

export class AutonomousRunnerBudgetExceededError extends Error {
  constructor(label, { requestedMs, remainingMs, deadlineAt }) {
    super(
      `Autonomous runner deadline exhausted before ${label}: ` +
      `requested ${requestedMs}ms with ${remainingMs}ms remaining ` +
      `(deadline ${new Date(deadlineAt).toISOString()}).`
    );
    this.name = "AutonomousRunnerBudgetExceededError";
    this.code = "AUTONOMOUS_RUNNER_BUDGET_EXCEEDED";
    this.requestedMs = requestedMs;
    this.remainingMs = remainingMs;
    this.deadlineAt = deadlineAt;
  }
}

const MINUTE_MS = 60_000;

// GitHub Actions grants the runner step 330 minutes. Stop starting or running
// subprocess work after 324 minutes so child termination, error receipts, and
// lease cleanup retain six minutes inside that outer step timeout.
export const AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS = 324 * MINUTE_MS;
export const AUTONOMOUS_RUNNER_WORKFLOW_HEADROOM_MS = 6 * MINUTE_MS;

export function createAutonomousRunnerBudget({
  phaseMs = AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS,
  startedAt = Date.now(),
  now = Date.now
} = {}) {
  return createWallClockBudget({
    phaseMs,
    startedAt,
    now,
    defaultTimeoutLabel: "runner command",
    defaultDelayLabel: "runner delay",
    BudgetExceededError: AutonomousRunnerBudgetExceededError
  });
}

export function createAutonomousCollectionBudget({
  phaseMs,
  startedAt = Date.now(),
  now = Date.now
}) {
  return createWallClockBudget({
    phaseMs,
    startedAt,
    now,
    defaultTimeoutLabel: "collector command",
    defaultDelayLabel: "collector retry delay",
    BudgetExceededError: AutonomousCollectionBudgetExceededError
  });
}

function createWallClockBudget({
  phaseMs,
  startedAt,
  now,
  defaultTimeoutLabel,
  defaultDelayLabel,
  BudgetExceededError
}) {
  assertPositiveMilliseconds(phaseMs, "phaseMs");
  assertFiniteTimestamp(startedAt, "startedAt");
  if (typeof now !== "function") throw new TypeError("now must be a function.");

  const deadlineAt = startedAt + phaseMs;
  const remainingMs = () => Math.max(0, Math.floor(deadlineAt - currentTime(now)));

  return Object.freeze({
    startedAt,
    deadlineAt,
    remainingMs,
    timeoutMs(requestedMs, label = defaultTimeoutLabel) {
      assertPositiveMilliseconds(requestedMs, "requestedMs");
      const remaining = remainingMs();
      if (remaining <= 0) {
        throw new BudgetExceededError(label, {
          requestedMs,
          remainingMs: remaining,
          deadlineAt
        });
      }
      return Math.max(1, Math.min(requestedMs, remaining));
    },
    delayMs(requestedMs, label = defaultDelayLabel) {
      assertNonNegativeMilliseconds(requestedMs, "requestedMs");
      const remaining = remainingMs();
      if (requestedMs > remaining) {
        throw new BudgetExceededError(label, {
          requestedMs,
          remainingMs: remaining,
          deadlineAt
        });
      }
      return requestedMs;
    }
  });
}

function currentTime(now) {
  const value = now();
  assertFiniteTimestamp(value, "now()");
  return value;
}

function assertPositiveMilliseconds(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite millisecond value.`);
  }
}

function assertNonNegativeMilliseconds(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite millisecond value.`);
  }
}

function assertFiniteTimestamp(value, label) {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite millisecond timestamp.`);
  }
}
