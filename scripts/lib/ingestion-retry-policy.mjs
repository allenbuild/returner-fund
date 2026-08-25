const POSTGRES_INTEGER_MAX = 2_147_483_647;

// The durable task schema stores attempts as a PostgreSQL integer. Using its
// maximum value keeps transient work operationally unbounded without changing
// the schema or allowing an ordinary retry counter to overflow.
export const INGESTION_RETRY_ATTEMPT_CEILING = POSTGRES_INTEGER_MAX;

export function cappedExponentialBackoffMs(
  failureCount,
  {
    baseDelayMs = 1_000,
    maxDelayMs = 30_000,
    jitterRatio = 0.2,
    random = Math.random
  } = {}
) {
  if (!Number.isSafeInteger(failureCount) || failureCount < 1) {
    throw new RangeError("failureCount must be a positive safe integer.");
  }
  assertPositiveMilliseconds(baseDelayMs, "baseDelayMs");
  assertPositiveMilliseconds(maxDelayMs, "maxDelayMs");
  if (maxDelayMs < baseDelayMs) {
    throw new RangeError("maxDelayMs must be greater than or equal to baseDelayMs.");
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new RangeError("jitterRatio must be between zero and one.");
  }
  if (typeof random !== "function") throw new TypeError("random must be a function.");

  // Once the cap is reached, avoid growing an exponent that can eventually
  // overflow even though the final delay remains bounded.
  const exponent = Math.min(failureCount - 1, 52);
  const capped = Math.min(maxDelayMs, baseDelayMs * (2 ** exponent));
  if (jitterRatio === 0) return Math.round(capped);

  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new RangeError("random() must return a finite number between zero and one.");
  }
  const lower = capped * (1 - jitterRatio);
  const upper = capped * (1 + jitterRatio);
  return Math.max(1, Math.round(lower + ((upper - lower) * sample)));
}

export function retryDelayBeforeDeadlineMs({
  failureCount,
  deadlineAt,
  nowMs = Date.now(),
  reserveMs = 0,
  ...backoffOptions
}) {
  assertFiniteTimestamp(deadlineAt, "deadlineAt");
  assertFiniteTimestamp(nowMs, "nowMs");
  if (!Number.isFinite(reserveMs) || reserveMs < 0) {
    throw new RangeError("reserveMs must be a non-negative finite millisecond value.");
  }
  const availableMs = Math.floor(deadlineAt - nowMs - reserveMs);
  if (availableMs <= 0) return null;
  return Math.min(
    availableMs,
    cappedExponentialBackoffMs(failureCount, backoffOptions)
  );
}

function assertPositiveMilliseconds(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite millisecond value.`);
  }
}

function assertFiniteTimestamp(value, label) {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite millisecond timestamp.`);
  }
}
