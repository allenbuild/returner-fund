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

export function createAutonomousCollectionBudget({
  phaseMs,
  startedAt = Date.now(),
  now = Date.now
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
    timeoutMs(requestedMs, label = "collector command") {
      assertPositiveMilliseconds(requestedMs, "requestedMs");
      const remaining = remainingMs();
      if (remaining <= 0) {
        throw new AutonomousCollectionBudgetExceededError(label, {
          requestedMs,
          remainingMs: remaining,
          deadlineAt
        });
      }
      return Math.max(1, Math.min(requestedMs, remaining));
    },
    delayMs(requestedMs, label = "collector retry delay") {
      assertNonNegativeMilliseconds(requestedMs, "requestedMs");
      const remaining = remainingMs();
      if (requestedMs > remaining) {
        throw new AutonomousCollectionBudgetExceededError(label, {
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
